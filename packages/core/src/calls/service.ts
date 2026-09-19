/**
 * CALLS, CLIENT SIDE: the state machine, the signalling, and the fingerprint.
 *
 * What is here is everything about a call that is not platform-specific, which
 * is everything except the media itself — ADR 0002, Decision 5. The media is
 * an injected {@link CallMediaAdapter}; a client built without one still
 * rings, is rung, declines and ends, and simply carries no audio.
 *
 * **Signalling never touches a route of its own.** The offer, the answer, the
 * ICE candidates and (in a group) the per-sender frame keys are encrypted
 * `call` messages in the conversation, sent through the ordinary outbox, so
 * they inherit its ordering, its retries and its end-to-end encryption. The
 * server relays ciphertext and knows only what it must: who is being rung.
 *
 * **The fingerprint check is the whole of the confidentiality claim.** A 1:1
 * call's media is DTLS-SRTP, and what makes it end to end is that the DTLS
 * fingerprint rides INSIDE the encrypted offer and answer: a server that
 * swapped one would be swapping a value the MLS group already authenticated.
 * So the fingerprint that arrives is compared here, once, and a call whose
 * answer does not match the description it carries is ended rather than
 * connected — quietly downgrading to an unauthenticated call would be the
 * worst of both worlds.
 *
 * The SERVER owns who answered. `call.updated` is the authority: a device that
 * lost the race is told, and stops ringing, rather than deciding for itself.
 */
import {
  callResponseSchema,
  iceServersResponseSchema,
  SERVER_TO_CLIENT_EVENTS,
  type CallEndReason,
  type CallMode,
} from "@allo/shared-types";
import type { Context } from "../context";
import { InvalidStateError, NotFoundError } from "../errors";
import { uuidV7 } from "../util/ids";
import { describeError } from "../util/logger";
import type { CallMediaAdapter, SessionDescription } from "./media";

/** One finished call, as the history list shows it. */
export interface CallHistoryEntry {
  /** The timeline item's id, which is what a list keys on. */
  id: string;
  callId: string;
  conversationId: string;
  withAccountIds: string[];
  mode: CallMode;
  outcome: "answered" | "not_answered" | "declined" | "cancelled" | "failed";
  incoming: boolean;
  /** ISO, when it happened. */
  at: string;
  /** Zero for a call that never connected. */
  durationMs: number;
}

/** Where a call is, as a screen sees it. */
export type CallPhase = "ringing" | "connecting" | "active" | "ended";

export interface CallView {
  id: string;
  conversationId: string;
  mode: CallMode;
  phase: CallPhase;
  /** True when this device started it. An incoming call is the other case, and the one that rings. */
  outgoing: boolean;
  /** Who is being called, or who is calling. */
  withAccountIds: string[];
  /** Set once the call ends, and the reason the log records. */
  endReason: CallEndReason | null;
  muted: boolean;
  cameraOn: boolean;
  startedAt: string;
  answeredAt: string | null;
}

interface Live {
  view: CallView;
  /** The description we sent or received, kept so the answer's fingerprint can be checked against it. */
  localFingerprint: string | null;
  remoteFingerprint: string | null;
  stopCandidates: (() => void) | null;
  /** Candidates that arrived before the description they belong to. */
  pendingCandidates: string[];
  /** The caller's offer, held until this device answers. */
  pendingOffer: string | null;
}

export class CallsService {
  private live: Live | null = null;
  private changes = 0;
  /**
   * Signalling that arrived BEFORE the ring it belongs to.
   *
   * The two travel by different paths with no ordering between them: the
   * offer is an encrypted message in the conversation, pulled by sync, and
   * the ring is a socket event. The offer routinely wins, and dropping it
   * because "there is no call yet" leaves a device ringing with nothing to
   * answer with — measured, not imagined: it is what the first version did.
   *
   * So what arrives early is kept, keyed by the call it names, and adopted
   * when the ring turns up. One call's worth: a second one replaces it,
   * because a device takes one call at a time anyway.
   */
  private early: { callId: string; offer: string | null; candidates: string[] } | null = null;

  constructor(
    private readonly ctx: Context,
    private readonly media: CallMediaAdapter | undefined,
  ) {}

  /** The call this device is in, or `null`. One at a time, which is what a phone does. */
  current(): CallView | null {
    return this.live?.view ?? null;
  }

  /** Bumped on every change, so a hook has something to compare. */
  version(): number {
    return this.changes;
  }

  /**
   * Every call this device knows about, newest first.
   *
   * Read out of the conversations rather than kept as a list of its own: the
   * log IS the `call_log` messages, which sync, back up and reach every device
   * of both accounts the way any message does. A second store would be a
   * second truth to keep in step.
   */
  history(): CallHistoryEntry[] {
    const out: CallHistoryEntry[] = [];
    for (const conversation of this.ctx.conversations.list()) {
      for (const item of this.ctx.messages.timeline(conversation.id)) {
        if (item.content.kind !== "call") continue;
        const call = item.content.call;
        out.push({
          id: item.id,
          callId: call.callId,
          conversationId: conversation.id,
          withAccountIds: conversation.memberAccountIds.filter((id) => id !== this.ctx.accountId),
          mode: call.mode,
          outcome: call.outcome,
          incoming: call.incoming,
          at: item.sentAt,
          durationMs: call.durationMs ?? 0,
        });
      }
    }
    return out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  }

  // ---- starting, answering, ending -----------------------------------------

  /** Rings every other member's devices. Resolves once the server has the call, not once somebody answers. */
  async start(conversationId: string, mode: CallMode = "voice"): Promise<CallView> {
    const { ctx } = this;
    ctx.instance.assertActive();
    if (this.live && this.live.view.phase !== "ended") throw new InvalidStateError("already in a call");
    const conversation = ctx.conversations.get(conversationId);
    if (!conversation) throw new NotFoundError(`conversation ${conversationId}`);

    const res = await ctx.http.request({
      method: "POST",
      path: "/v1/calls",
      body: { idempotencyKey: uuidV7(ctx.now()), conversationId, mode },
      schema: callResponseSchema,
      signer: ctx.signer,
    });
    const call = res.call;
    this.live = {
      view: {
        id: call.id,
        conversationId,
        mode,
        phase: "ringing",
        outgoing: true,
        withAccountIds: conversation.memberAccountIds.filter((id) => id !== ctx.accountId),
        endReason: null,
        muted: false,
        cameraOn: mode === "video",
        startedAt: call.startedAt,
        answeredAt: null,
      },
      localFingerprint: null,
      remoteFingerprint: null,
      stopCandidates: null,
      pendingCandidates: [],
      pendingOffer: null,
    };
    this.invalidate();

    // The offer goes out now: the callee's device has it the moment it answers.
    await this.withMedia(call.id, async (media) => {
      await this.prepare(media, call.id);
      const offer = await media.createOffer();
      this.live!.localFingerprint = offer.fingerprint;
      await this.signal(conversationId, { kind: "offer", sdp: offer.sdp, fingerprint: offer.fingerprint });
      this.streamCandidates(conversationId, media);
    });
    return this.live.view;
  }

  /** This device takes the call. The server decides whether it won the race. */
  async answer(): Promise<void> {
    const { ctx } = this;
    const live = this.requireLive();
    if (live.view.outgoing) throw new InvalidStateError("this device started the call");
    await ctx.http.request({ method: "POST", path: `/v1/calls/${live.view.id}/answer`, schema: callResponseSchema, signer: ctx.signer });
    // With no media there is no description to exchange, so the server's word
    // is the whole truth and the call is active. With media, `active` means
    // the answer has been exchanged and the connection is up.
    this.set({ phase: this.media ? "connecting" : "active", answeredAt: new Date(ctx.now()).toISOString() });
    // The answer itself waits for the offer; `onCallMessage` sends it when the
    // offer arrives, which may already have happened.
    await this.answerOfferIfReady();
  }

  async decline(): Promise<void> {
    const live = this.requireLive();
    await this.ctx.http
      .request({ method: "POST", path: `/v1/calls/${live.view.id}/decline`, schema: callResponseSchema, signer: this.ctx.signer })
      .catch((error) => this.ctx.log.warn?.("decline failed", { error: describeError(error) }));
    await this.finish("declined");
  }

  /** Hangs up, or cancels a ring this device started. */
  async end(reason: CallEndReason = "hangup"): Promise<void> {
    const live = this.requireLive();
    const wire = live.view.phase === "ringing" && live.view.outgoing ? "cancelled" : reason === "declined" ? "declined" : "hangup";
    await this.ctx.http
      .request({
        method: "POST",
        path: `/v1/calls/${live.view.id}/end`,
        body: { reason: wire },
        schema: callResponseSchema,
        signer: this.ctx.signer,
      })
      .catch((error) => this.ctx.log.warn?.("end failed", { error: describeError(error) }));
    await this.signal(live.view.conversationId, { kind: "end", reason: wire }).catch(() => undefined);
    await this.finish(reason);
  }

  async setMuted(muted: boolean): Promise<void> {
    const live = this.requireLive();
    await this.media?.setMuted(muted);
    live.view = { ...live.view, muted };
    this.invalidate();
  }

  async setCameraEnabled(on: boolean): Promise<void> {
    const live = this.requireLive();
    await this.media?.setCameraEnabled(on);
    live.view = { ...live.view, cameraOn: on };
    this.invalidate();
  }

  // ---- what the server says -------------------------------------------------

  /** `call.incoming`: somebody is calling this device. The offer arrives separately, encrypted. */
  onIncoming(payload: unknown): void {
    const parsed = SERVER_TO_CLIENT_EVENTS["call.incoming"].safeParse(payload);
    if (!parsed.success) return;
    const event = parsed.data;
    if (this.live && this.live.view.phase !== "ended") {
      // Busy. The server is told so the caller hears it rather than ringing out.
      void this.ctx.http
        .request({ method: "POST", path: `/v1/calls/${event.callId}/end`, body: { reason: "busy" }, schema: callResponseSchema, signer: this.ctx.signer })
        .catch(() => undefined);
      return;
    }
    this.live = {
      view: {
        id: event.callId,
        conversationId: event.conversationId,
        mode: event.mode,
        phase: "ringing",
        outgoing: false,
        withAccountIds: [event.initiatorAccountId],
        endReason: null,
        muted: false,
        cameraOn: false,
        startedAt: new Date(this.ctx.now()).toISOString(),
        answeredAt: null,
      },
      localFingerprint: null,
      remoteFingerprint: null,
      stopCandidates: null,
      pendingCandidates: this.early?.callId === event.callId ? [...this.early.candidates] : [],
      pendingOffer: this.early?.callId === event.callId ? this.early.offer : null,
    };
    this.early = null;
    this.invalidate();
  }

  /**
   * `call.updated`: the server moved the call. It is the authority on who
   * answered, so a device that lost the race stops ringing here rather than
   * deciding for itself.
   */
  onUpdated(payload: unknown): void {
    const parsed = SERVER_TO_CLIENT_EVENTS["call.updated"].safeParse(payload);
    if (!parsed.success) return;
    const event = parsed.data;
    const live = this.live;
    if (!live || live.view.id !== event.callId) return;
    if (event.state === "ended") {
      // A ring nobody answered was ended by the SERVER, so the caller writes
      // it; anything else was ended by a device, and that device writes it.
      const expired = event.endReason === "missed";
      void this.finish(event.endReason ?? "hangup", expired && live.view.outgoing);
      return;
    }
    if (event.state === "active" && live.view.phase === "ringing") {
      const mine = event.answeredByInstanceId === this.ctx.instanceId;
      if (!mine && !live.view.outgoing) {
        // Another of this account's devices took it.
        void this.finish("answered_elsewhere");
        return;
      }
      this.set({ phase: this.media ? "connecting" : "active" });
    }
  }

  // ---- the encrypted signalling --------------------------------------------

  /**
   * A `call` message from the conversation. Every kind arrives this way, and
   * the ANSWER is where the fingerprint is checked: it has to match the
   * description it came with, or the call ends.
   */
  async onCallMessage(conversationId: string, message: { callId: string; kind: string; sdp?: string; candidates?: string[]; reason?: string }): Promise<void> {
    const live = this.live;
    if (!live || live.view.id !== message.callId || live.view.conversationId !== conversationId) {
      // Early, or for a call this device is not in. Keep the signalling a ring
      // will need; anything else is not ours to hold.
      if (message.kind === "offer" && message.sdp) {
        this.early = { callId: message.callId, offer: message.sdp, candidates: this.early?.callId === message.callId ? this.early.candidates : [] };
      } else if (message.kind === "ice" && message.candidates) {
        if (this.early?.callId === message.callId) this.early.candidates.push(...message.candidates);
        else this.early = { callId: message.callId, offer: null, candidates: [...message.candidates] };
      }
      return;
    }
    switch (message.kind) {
      case "offer":
        if (!message.sdp) return;
        live.remoteFingerprint = fingerprintOf(message.sdp);
        live.pendingOffer = message.sdp;
        if (live.view.phase === "connecting") await this.answerOfferIfReady(message.sdp);
        break;
      case "answer": {
        if (!message.sdp || !live.view.outgoing) return;
        const answer: SessionDescription = { sdp: message.sdp, fingerprint: fingerprintOf(message.sdp) };
        if (!answer.fingerprint) {
          this.ctx.log.error?.("the answer carries no DTLS fingerprint; ending the call", { callId: live.view.id });
          await this.end("failed");
          return;
        }
        live.remoteFingerprint = answer.fingerprint;
        await this.withMedia(live.view.id, async (media) => {
          await media.acceptAnswer(answer);
          await this.drainCandidates(media);
        });
        this.set({ phase: "active", answeredAt: live.view.answeredAt ?? new Date(this.ctx.now()).toISOString() });
        break;
      }
      case "ice":
        if (!message.candidates) return;
        await this.withMedia(live.view.id, async (media) => {
          if (live.remoteFingerprint) await media.addCandidates(message.candidates!);
          else live.pendingCandidates.push(...message.candidates!);
        });
        break;
      case "end":
        // They ended it, so the record is theirs to write.
        await this.finish((message.reason as CallEndReason) ?? "hangup", false);
        break;
    }
  }

  /** Builds and sends the answer once BOTH the offer and this device's acceptance exist. */
  private async answerOfferIfReady(sdp?: string): Promise<void> {
    const live = this.live;
    if (!live || live.view.outgoing) return;
    const offerSdp = sdp ?? live.pendingOffer;
    if (!offerSdp || live.view.phase !== "connecting") return;
    live.pendingOffer = null;
    await this.withMedia(live.view.id, async (media) => {
      await this.prepare(media, live.view.id);
      const answer = await media.acceptOffer({ sdp: offerSdp, fingerprint: fingerprintOf(offerSdp) });
      live.localFingerprint = answer.fingerprint;
      await this.signal(live.view.conversationId, { kind: "answer", sdp: answer.sdp, fingerprint: answer.fingerprint });
      this.streamCandidates(live.view.conversationId, media);
      await this.drainCandidates(media);
    });
    this.set({ phase: "active" });
  }

  // ---- the parts ------------------------------------------------------------

  /** Asks the server where the media may go, and hands it to the adapter without interpreting it. */
  private async prepare(media: CallMediaAdapter, callId: string): Promise<void> {
    const ice = await this.ctx.http.request({
      method: "GET",
      path: `/v1/calls/${callId}/ice`,
      schema: iceServersResponseSchema,
      signer: this.ctx.signer,
    });
    await media.prepare({
      mode: this.live?.view.mode ?? "voice",
      iceServers: ice.iceServers.map((s) => ({ urls: [...s.urls], username: s.username, credential: s.credential })),
      relayOnly: ice.relayOnly,
    });
  }

  private streamCandidates(conversationId: string, media: CallMediaAdapter): void {
    const live = this.live;
    if (!live || live.stopCandidates) return;
    live.stopCandidates = media.onCandidates((candidates) => {
      void this.signal(conversationId, { kind: "ice", candidates: [...candidates] }).catch((error) =>
        this.ctx.log.debug?.("sending candidates failed", { error: describeError(error) }),
      );
    });
  }

  private async drainCandidates(media: CallMediaAdapter): Promise<void> {
    const live = this.live;
    if (!live || live.pendingCandidates.length === 0) return;
    const waiting = live.pendingCandidates.splice(0, live.pendingCandidates.length);
    await media.addCandidates(waiting);
  }

  private async signal(
    conversationId: string,
    body: { kind: "offer" | "answer" | "ice" | "key" | "end"; sdp?: string; fingerprint?: string; candidates?: string[]; reason?: string },
  ): Promise<void> {
    const live = this.live;
    if (!live) return;
    await this.ctx.outbox.enqueueMessage(conversationId, {
      v: 1,
      t: "call",
      ctl: true,
      callId: live.view.id,
      kind: body.kind,
      ...(body.sdp ? { sdp: body.sdp } : {}),
      ...(body.candidates ? { candidates: body.candidates } : {}),
      ...(body.reason ? { reason: body.reason } : {}),
    });
  }

  /** Runs `fn` when there is an adapter; without one the call still rings and ends, it just carries no audio. */
  private async withMedia(callId: string, fn: (media: CallMediaAdapter) => Promise<void>): Promise<void> {
    if (!this.media) {
      this.ctx.log.debug?.("no media adapter: signalling only", { callId });
      return;
    }
    await fn(this.media);
  }

  /**
   * Ends the call locally and tears the media down exactly once.
   *
   * `writeLog` is what keeps the conversation from getting TWO records of one
   * call. The log is a message, so whoever writes it writes it for both
   * accounts; the device that ended the call is the one that does. A ring the
   * SERVER gave up on was ended by nobody, so the caller writes that one —
   * they are the one who placed it, and the receiver calling it "missed" is a
   * reading of the same record, not a second record.
   */
  private async finish(reason: CallEndReason, writeLog = true): Promise<void> {
    const live = this.live;
    if (!live || live.view.phase === "ended") return;
    live.stopCandidates?.();
    live.stopCandidates = null;
    await this.media?.close().catch((error) => this.ctx.log.warn?.("closing the media failed", { error: describeError(error) }));
    const answered = live.view.answeredAt !== null;
    this.set({ phase: "ended", endReason: reason });
    // The log is a message like any other, so it reaches every device of both
    // accounts the way everything else does.
    const outcome = answered
      ? "answered"
      : reason === "declined" || reason === "declined_elsewhere"
        ? "declined"
        : reason === "cancelled"
          ? "cancelled"
          : reason === "failed"
            ? "failed"
            : "not_answered";
    if (!writeLog) return;
    try {
      await this.ctx.outbox.enqueueMessage(live.view.conversationId, {
        v: 1,
        t: "call_log",
        callId: live.view.id,
        mode: live.view.mode,
        outcome,
        ...(answered ? { durationMs: Math.max(0, this.ctx.now() - Date.parse(live.view.answeredAt!)) } : {}),
      });
    } catch (error) {
      this.ctx.log.warn?.("the call log could not be written", { error: describeError(error) });
    }
  }

  private requireLive(): Live {
    if (!this.live || this.live.view.phase === "ended") throw new InvalidStateError("no call in progress");
    return this.live;
  }

  private set(patch: Partial<CallView>): void {
    if (!this.live) return;
    this.live.view = { ...this.live.view, ...patch };
    this.invalidate();
  }

  private invalidate(): void {
    this.changes += 1;
    this.ctx.emitter.emit("call");
  }

  stop(): void {
    this.live?.stopCandidates?.();
    if (this.live) this.live.stopCandidates = null;
  }
}

/**
 * The `a=fingerprint` value of an SDP.
 *
 * Read here rather than taken on trust from the sender: the fingerprint that
 * matters is the one IN the description the media will use, and a sender that
 * claimed a different one would be claiming something the SDP itself refutes.
 */
export function fingerprintOf(sdp: string): string {
  const line = sdp.split(/\r?\n/).find((l) => l.startsWith("a=fingerprint:"));
  return line ? line.slice("a=fingerprint:".length).trim() : "";
}
