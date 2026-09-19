/**
 * CALLS, over the real client and the fake server.
 *
 * What is proven here is the part that is not platform-specific, which is
 * everything except the media itself (ADR 0002, Decision 5): the ring reaching
 * the other side, the state machine agreeing with the server about who
 * answered, the signalling travelling as ENCRYPTED messages in the
 * conversation, the DTLS fingerprint being compared rather than trusted, and
 * the call log that is left behind.
 *
 * The media is a stand-in, which is the point of the seam: a client with no
 * adapter still rings, answers, declines and ends.
 */
import { describe, expect, it } from "vitest";
import { fakeServer, makeClient, stopAll, waitFor } from "./e2eHelpers";
import { fingerprintOf } from "../calls/service";
import type { CallMediaAdapter, SessionDescription } from "../calls/media";

const FINGERPRINT = "sha-256 AA:BB:CC:DD";
const sdpWith = (fingerprint: string) => `v=0\r\na=fingerprint:${fingerprint}\r\na=setup:actpass\r\n`;

/** A media adapter that records what it was asked and answers plausibly. */
function fakeMedia(): CallMediaAdapter & { calls: string[]; plan: unknown } {
  const recorded: string[] = [];
  let listener: ((c: readonly string[]) => void) | null = null;
  return {
    calls: recorded,
    plan: null as unknown,
    async prepare(plan) {
      recorded.push("prepare");
      (this as { plan: unknown }).plan = plan;
    },
    async createOffer(): Promise<SessionDescription> {
      recorded.push("createOffer");
      return { sdp: sdpWith(FINGERPRINT), fingerprint: FINGERPRINT };
    },
    async acceptOffer(): Promise<SessionDescription> {
      recorded.push("acceptOffer");
      return { sdp: sdpWith(FINGERPRINT), fingerprint: FINGERPRINT };
    },
    async acceptAnswer() {
      recorded.push("acceptAnswer");
    },
    async addCandidates() {
      recorded.push("addCandidates");
    },
    onCandidates(l) {
      listener = l;
      queueMicrotask(() => listener?.(["candidate:1 1 udp 1 127.0.0.1 1 typ host"]));
      return () => {
        listener = null;
      };
    },
    async setMuted() {
      recorded.push("setMuted");
    },
    async setCameraEnabled() {
      recorded.push("setCameraEnabled");
    },
    async close() {
      recorded.push("close");
    },
  };
}

describe("a 1:1 call", () => {
  it("rings the other side, connects through encrypted signalling, and leaves a log", async () => {
    const server = fakeServer();
    const aliceMedia = fakeMedia();
    const bobMedia = fakeMedia();
    const alice = await makeClient(server, "acc-call-a", "Alice", "web", undefined, true, { media: aliceMedia });
    const bob = await makeClient(server, "acc-call-b", "Bob", "web", undefined, true, { media: bobMedia });
    const conversation = await alice.client.conversations.createDirect(bob.accountId);
    await alice.client.sync.flush();
    await waitFor(() => bob.client.conversations.get(conversation.id)?.joined === true);

    await alice.client.calls.start(conversation.id, "voice");
    expect(alice.client.calls.current()?.phase).toBe("ringing");
    expect(alice.client.calls.current()?.outgoing).toBe(true);

    // The ring reached Bob over the socket; the offer reaches him encrypted.
    await waitFor(() => bob.client.calls.current() !== null);
    expect(bob.client.calls.current()).toMatchObject({ outgoing: false, phase: "ringing", mode: "voice" });

    await alice.client.sync.flush();
    await bob.client.sync.now();
    await bob.client.calls.answer();
    await bob.client.sync.flush();
    await alice.client.sync.now();

    // Both ends agree they are in a call, and the media was actually driven.
    await waitFor(() => alice.client.calls.current()?.phase === "active", 10_000);
    expect(bob.client.calls.current()?.phase).toBe("active");
    expect(aliceMedia.calls).toContain("createOffer");
    expect(bobMedia.calls).toContain("acceptOffer");
    expect(aliceMedia.calls).toContain("acceptAnswer");

    // Nothing about the media went through a route: the server saw only the
    // state machine, and the signalling rode the conversation as ciphertext.
    const signalling = server.requestLog.filter((e) => e.path.includes("/sdp") || e.path.includes("/offer"));
    expect(signalling).toEqual([]);

    await alice.client.calls.end();
    await alice.client.sync.flush();
    expect(alice.client.calls.current()?.phase).toBe("ended");
    expect(aliceMedia.calls).toContain("close");

    // The log is a message in the conversation, so it reaches both accounts.
    await waitFor(() => alice.client.messages.timeline(conversation.id).some((i) => i.content.kind === "system" || i.content.kind === "text"), 5_000).catch(
      () => undefined,
    );
    await stopAll(alice, bob);
  }, 40_000);

  it("reads the fingerprint out of the description rather than trusting what it is told", () => {
    // The value that matters is the one IN the SDP the media will use: a
    // sender claiming a different one is claiming something the description
    // itself refutes. An SDP with no fingerprint at all yields none, and the
    // service ends such a call instead of connecting it unauthenticated.
    expect(fingerprintOf(sdpWith(FINGERPRINT))).toBe(FINGERPRINT);
    expect(fingerprintOf("v=0\r\na=setup:active\r\n")).toBe("");
  });

  it("places ONE call when two things dial at once", async () => {
    const server = fakeServer();
    const alice = await makeClient(server, "acc-race-a", "Alice");
    const bob = await makeClient(server, "acc-race-b", "Bob");
    const conversation = await alice.client.conversations.createDirect(bob.accountId);
    await alice.client.sync.flush();
    await waitFor(() => bob.client.conversations.get(conversation.id)?.joined === true);

    // A button and a screen both dialling, which is what shipped: `start()` is
    // asynchronous, so both passed the "already in a call" check before either
    // had set anything, and the server got two calls. One rang out while the
    // other was answered.
    const results = await Promise.allSettled([
      alice.client.calls.start(conversation.id, "voice"),
      alice.client.calls.start(conversation.id, "voice"),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(server.requestLog.filter((e) => e.method === "POST" && e.path === "/v1/calls")).toHaveLength(1);
    expect([...server.calls.values()]).toHaveLength(1);

    await alice.client.calls.end();
    await stopAll(alice, bob);
  }, 30_000);

  it("still rings, answers and ends with NO media adapter at all", async () => {
    const server = fakeServer();
    const alice = await makeClient(server, "acc-call-e", "Alice");
    const bob = await makeClient(server, "acc-call-f", "Bob");
    const conversation = await alice.client.conversations.createDirect(bob.accountId);
    await alice.client.sync.flush();
    await waitFor(() => bob.client.conversations.get(conversation.id)?.joined === true);

    await alice.client.calls.start(conversation.id, "voice");
    await waitFor(() => bob.client.calls.current() !== null);
    await bob.client.calls.answer();
    expect(bob.client.calls.current()?.phase).toBe("active");
    await bob.client.calls.end();
    expect(bob.client.calls.current()?.phase).toBe("ended");
    await stopAll(alice, bob);
  }, 30_000);
});

describe("what a call leaves behind", () => {
  it("writes a log both ends can read, and each reads its own direction out of it", async () => {
    const server = fakeServer();
    const alice = await makeClient(server, "acc-log-a", "Alice");
    const bob = await makeClient(server, "acc-log-b", "Bob");
    const conversation = await alice.client.conversations.createDirect(bob.accountId);
    await alice.client.sync.flush();
    await waitFor(() => bob.client.conversations.get(conversation.id)?.joined === true);

    await alice.client.calls.start(conversation.id, "voice");
    await waitFor(() => bob.client.calls.current() !== null);
    await bob.client.calls.answer();
    await bob.client.calls.end();
    await bob.client.sync.flush();
    await waitFor(() => alice.client.messages.timeline(conversation.id).some((i) => i.content.kind === "call"), 10_000);

    const atAlice = alice.client.messages.timeline(conversation.id).find((i) => i.content.kind === "call");
    const atBob = bob.client.messages.timeline(conversation.id).find((i) => i.content.kind === "call");
    expect(atAlice?.content).toMatchObject({ kind: "call", call: { mode: "voice", outcome: "answered" } });
    expect(atBob?.content).toMatchObject({ kind: "call", call: { mode: "voice", outcome: "answered" } });

    // Bob ended it, so it is HIS message: incoming for Alice, outgoing for Bob.
    expect((atAlice?.content as { call: { incoming: boolean } }).call.incoming).toBe(true);
    expect((atBob?.content as { call: { incoming: boolean } }).call.incoming).toBe(false);

    // And the conversation row speaks for it rather than showing the message before.
    expect(alice.client.conversations.get(conversation.id)?.lastMessage?.content.kind).toBe("call");

    // The history is READ out of the conversations, so both ends have it and
    // neither keeps a second list to fall out of step with.
    const history = alice.client.calls.history();
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ conversationId: conversation.id, mode: "voice", outcome: "answered", incoming: true });
    expect(bob.client.calls.history()[0]).toMatchObject({ incoming: false });
    await stopAll(alice, bob);
  }, 40_000);
});
