import {
  buildMessageEvent,
  buildEditEvent,
  buildDeleteEvent,
  buildSendResultEvent,
  buildSessionStatusEvent,
  toIsoTimestamp,
  maskPhoneHint,
  toBridgeExternalSelf,
  type NormalizableMessage,
} from "../telegram/normalize";

/**
 * Pure normalization: fake gramjs-derived primitives -> exact BridgeEvent shapes
 * that Allo's `validateEventShape` accepts.
 */
describe("normalize — inbound message -> BridgeEvent", () => {
  const base: NormalizableMessage = {
    id: 555,
    externalChatId: "tg-chat-1",
    externalSenderId: "tg-user-9",
    text: "hello world",
    dateSeconds: 1_700_000_000,
    senderDisplayName: "Alice",
    senderUsername: "alice",
  };

  it("produces a well-formed `message` event", () => {
    const event = buildMessageEvent("owner-1", base);
    expect(event).not.toBeNull();
    expect(event).toMatchObject({
      v: 1,
      type: "message",
      network: "telegram",
      ownerUserId: "owner-1",
      externalChatId: "tg-chat-1",
      externalSenderId: "tg-user-9",
      externalMessageId: "555",
      text: "hello world",
      senderDisplayName: "Alice",
      senderUsername: "alice",
    });
    expect(event?.timestamp).toBe(new Date(1_700_000_000 * 1000).toISOString());
  });

  it("carries media and drops empty text when media-only", () => {
    const event = buildMessageEvent("owner-1", {
      ...base,
      text: "",
      media: [{ url: "/uploads/x.jpg", type: "image" }],
    });
    expect(event?.text).toBeUndefined();
    expect(event?.media).toHaveLength(1);
    expect(event?.media?.[0]).toMatchObject({ url: "/uploads/x.jpg", type: "image" });
  });

  it("returns null when there is neither text nor media (Allo would reject it)", () => {
    const event = buildMessageEvent("owner-1", { ...base, text: "", media: [] });
    expect(event).toBeNull();
  });

  it("omits sender enrichment fields when absent", () => {
    const event = buildMessageEvent("owner-1", {
      id: 1,
      externalChatId: "c",
      externalSenderId: "s",
      text: "hi",
    });
    expect(event?.senderDisplayName).toBeUndefined();
    expect(event?.senderUsername).toBeUndefined();
    expect(event?.timestamp).toBeUndefined();
  });
});

describe("normalize — edit / delete / send_result / session_status", () => {
  it("builds an `edit` event with externalMessageId", () => {
    const event = buildEditEvent("owner-1", {
      id: 77,
      externalChatId: "c",
      externalSenderId: "s",
      text: "edited",
      dateSeconds: 1_700_000_500,
    });
    expect(event).toMatchObject({
      v: 1,
      type: "edit",
      network: "telegram",
      ownerUserId: "owner-1",
      externalChatId: "c",
      externalMessageId: "77",
      text: "edited",
    });
  });

  it("builds a `delete` event for a single message id", () => {
    const event = buildDeleteEvent("owner-1", "chat-x", 909);
    expect(event).toMatchObject({
      v: 1,
      type: "delete",
      network: "telegram",
      ownerUserId: "owner-1",
      externalChatId: "chat-x",
      externalMessageId: "909",
    });
  });

  it("builds a `send_result` (sent) event with the external message id", () => {
    const event = buildSendResultEvent({
      ownerUserId: "owner-1",
      externalChatId: "chat-x",
      messageId: "allo-msg-1",
      status: "sent",
      externalMessageId: "tg-42",
    });
    expect(event).toMatchObject({
      v: 1,
      type: "send_result",
      network: "telegram",
      ownerUserId: "owner-1",
      externalChatId: "chat-x",
      messageId: "allo-msg-1",
      status: "sent",
      externalMessageId: "tg-42",
    });
  });

  it("builds a `send_result` (failed) event carrying an error", () => {
    const event = buildSendResultEvent({
      ownerUserId: "owner-1",
      externalChatId: "chat-x",
      messageId: "allo-msg-2",
      status: "failed",
      error: "no_active_session",
    });
    expect(event.status).toBe("failed");
    expect(event.error).toBe("no_active_session");
  });

  it("builds a `session_status` event with empty externalChatId sentinel", () => {
    const event = buildSessionStatusEvent("owner-1", "active");
    expect(event).toMatchObject({
      v: 1,
      type: "session_status",
      network: "telegram",
      ownerUserId: "owner-1",
      externalChatId: "",
      sessionStatus: "active",
    });
  });

  it("carries externalSelf on an `active` session_status when provided", () => {
    const event = buildSessionStatusEvent("owner-1", "active", {
      externalId: "1000",
      username: "me",
      displayName: "Me",
      phoneHint: "+34•••••22",
    });
    expect(event.externalSelf).toEqual({
      externalId: "1000",
      username: "me",
      displayName: "Me",
      phoneHint: "+34•••••22",
    });
  });

  it("omits externalSelf for non-active statuses (revoked/expired/error)", () => {
    expect(buildSessionStatusEvent("owner-1", "revoked").externalSelf).toBeUndefined();
    expect(buildSessionStatusEvent("owner-1", "expired").externalSelf).toBeUndefined();
    expect(buildSessionStatusEvent("owner-1", "error").externalSelf).toBeUndefined();
  });
});

describe("normalize — maskPhoneHint", () => {
  it("keeps a leading + and the last two digits, masking the middle", () => {
    // "+34600111122" => "+" plus 11 digits; last 2 kept, 9 bulleted.
    expect(maskPhoneHint("+34600111122")).toBe("+•••••••••22");
  });

  it("masks a number without a leading +", () => {
    // "600111122" => 9 digits; last 2 kept, 7 bulleted.
    expect(maskPhoneHint("600111122")).toBe("•••••••22");
  });

  it("reveals only the last digit for very short numbers", () => {
    expect(maskPhoneHint("12")).toBe("•••2");
    expect(maskPhoneHint("+1")).toBe("+•••1");
  });

  it("returns undefined for empty/whitespace input", () => {
    expect(maskPhoneHint(undefined)).toBeUndefined();
    expect(maskPhoneHint("")).toBeUndefined();
    expect(maskPhoneHint("   ")).toBeUndefined();
  });

  it("never leaks the full middle of the number", () => {
    const hint = maskPhoneHint("+34600111122");
    expect(hint).not.toContain("600111");
  });
});

describe("normalize — toBridgeExternalSelf", () => {
  it("maps stored ExternalSelf to the wire shape and masks the phone", () => {
    const wire = toBridgeExternalSelf({
      id: "1000",
      username: "me",
      firstName: "Me",
      phone: "+34600111122",
    });
    expect(wire).toEqual({
      externalId: "1000",
      username: "me",
      displayName: "Me",
      phoneHint: "+•••••••••22",
    });
    // The raw phone is NEVER on the wire.
    expect(JSON.stringify(wire)).not.toContain("600111122");
  });

  it("handles a minimal ExternalSelf (id only)", () => {
    const wire = toBridgeExternalSelf({ id: "5" });
    expect(wire).toEqual({
      externalId: "5",
      username: undefined,
      displayName: undefined,
      phoneHint: undefined,
    });
  });
});

describe("normalize — toIsoTimestamp", () => {
  it("converts unix seconds to ISO", () => {
    expect(toIsoTimestamp(1_700_000_000)).toBe(new Date(1_700_000_000_000).toISOString());
  });
  it("returns undefined for non-finite input", () => {
    expect(toIsoTimestamp(undefined)).toBeUndefined();
    expect(toIsoTimestamp(Number.NaN)).toBeUndefined();
  });
});
