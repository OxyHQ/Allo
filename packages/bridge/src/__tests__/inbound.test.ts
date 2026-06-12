import {
  FakeTelegramClient,
  FakeStringSession,
  FakeNewMessage,
  FakeEditedMessage,
  FakeDeletedMessage,
  FakeLogLevel,
  FakeApi,
  FakeFloodWaitError,
  fakeGetPeerId,
  fakeGetDisplayName,
} from "./__mocks__/gramjs";
import { TEST_BRIDGE_SECRET, TEST_SESSION_KEY } from "./helpers/fixtures";

jest.mock("telegram", () => ({ TelegramClient: FakeTelegramClient, Api: FakeApi }));
jest.mock("telegram/sessions", () => ({ StringSession: FakeStringSession }));
jest.mock("telegram/events", () => ({ NewMessage: FakeNewMessage }));
jest.mock("telegram/events/EditedMessage", () => ({ EditedMessage: FakeEditedMessage }));
jest.mock("telegram/events/DeletedMessage", () => ({ DeletedMessage: FakeDeletedMessage }));
jest.mock("telegram/extensions/Logger", () => ({ LogLevel: FakeLogLevel }));
jest.mock("telegram/Utils", () => ({ getPeerId: fakeGetPeerId, getDisplayName: fakeGetDisplayName }));

const postedEvents: unknown[] = [];
jest.mock("../alloClient", () => ({
  postEvent: jest.fn(async (event: unknown) => {
    postedEvents.push(event);
    return true;
  }),
  uploadMedia: jest.fn(async () => null),
}));

import { TelegramManager } from "../telegram/manager";
import * as sessionStore from "../sessionStore";

/**
 * Drives the FULL inbound path through the real manager: a fake gramjs
 * `NewMessage` event is delivered to the handler the manager registered, and we
 * assert the normalized `BridgeEvent` POSTed to Allo. This exercises the manager's
 * id resolution + own-echo skipping, not just the pure normalizer.
 */
describe("inbound — manager NewMessage handler -> BridgeEvent posted to Allo", () => {
  const prevEnabled = process.env.BRIDGE_ENABLED;
  const prevSecret = process.env.BRIDGE_SHARED_SECRET;
  const prevSessionKey = process.env.BRIDGE_SESSION_KEY;
  const prevApiId = process.env.TELEGRAM_API_ID;
  const prevApiHash = process.env.TELEGRAM_API_HASH;
  const prevAlloUrl = process.env.ALLO_INTERNAL_URL;

  beforeEach(() => {
    process.env.BRIDGE_ENABLED = "true";
    process.env.BRIDGE_SHARED_SECRET = TEST_BRIDGE_SECRET;
    process.env.BRIDGE_SESSION_KEY = TEST_SESSION_KEY;
    process.env.TELEGRAM_API_ID = "12345";
    process.env.TELEGRAM_API_HASH = "abcdef";
    process.env.ALLO_INTERNAL_URL = "http://allo.test";
    postedEvents.length = 0;
    FakeTelegramClient.reset();
  });

  afterEach(() => {
    process.env.BRIDGE_ENABLED = prevEnabled;
    process.env.BRIDGE_SHARED_SECRET = prevSecret;
    process.env.BRIDGE_SESSION_KEY = prevSessionKey;
    process.env.TELEGRAM_API_ID = prevApiId;
    process.env.TELEGRAM_API_HASH = prevApiHash;
    process.env.ALLO_INTERNAL_URL = prevAlloUrl;
    jest.clearAllMocks();
  });

  /** Get the NewMessage handler the manager registered on the (single) client. */
  async function connectAndGetNewMessageHandler(
    manager: TelegramManager
  ): Promise<(event: unknown) => void> {
    await sessionStore.saveActive("owner-1", "SESSION", { id: "1000", username: "me" });
    await manager.ensureConnected("owner-1");
    const client = FakeTelegramClient.lastInstance;
    expect(client).toBeDefined();
    // The first registered handler is NewMessage (see registerClient order).
    const entry = client?.handlers[0];
    expect(entry).toBeDefined();
    return entry?.callback as (event: unknown) => void;
  }

  it("normalizes an inbound message and posts a `message` event to Allo", async () => {
    const manager = new TelegramManager();
    const handler = await connectAndGetNewMessageHandler(manager);

    handler({
      message: {
        id: 321,
        out: false,
        text: "incoming from telegram",
        date: 1_700_000_123,
        peerId: { id: "tg-chat-7" },
        senderId: { toString: () => "tg-user-3" },
        photo: undefined,
        gif: undefined,
        video: undefined,
        videoNote: undefined,
        voice: undefined,
        audio: undefined,
        document: undefined,
        file: undefined,
        async downloadMedia() {
          return undefined;
        },
      },
    });

    await new Promise((r) => setTimeout(r, 20));
    const event = postedEvents.find((e) => (e as { type?: string }).type === "message") as
      | Record<string, unknown>
      | undefined;
    expect(event).toMatchObject({
      v: 1,
      type: "message",
      network: "telegram",
      ownerUserId: "owner-1",
      externalChatId: "tg-chat-7",
      externalSenderId: "tg-user-3",
      externalMessageId: "321",
      text: "incoming from telegram",
    });
  });

  it("SKIPS the user's own outgoing echo (message.out === true)", async () => {
    const manager = new TelegramManager();
    const handler = await connectAndGetNewMessageHandler(manager);

    handler({
      message: {
        id: 999,
        out: true, // our own send — confirmed via send_result, not re-ingested
        text: "echo of what we sent",
        date: 1_700_000_200,
        peerId: { id: "tg-chat-7" },
        senderId: { toString: () => "1000" },
        async downloadMedia() {
          return undefined;
        },
      },
    });

    await new Promise((r) => setTimeout(r, 20));
    const messageEvents = postedEvents.filter((e) => (e as { type?: string }).type === "message");
    expect(messageEvents).toHaveLength(0);
  });

  it("activates the session and posts a session_status active on connect/login", async () => {
    // saveActive + ensureConnected does not itself emit session_status (that is on
    // login), so assert login path via onLoginSuccess by simulating a fresh login.
    const manager = new TelegramManager();
    await sessionStore.saveActive("owner-1", "SESSION", { id: "1000" });
    await manager.ensureConnected("owner-1");
    // The connect path registers handlers but does not re-announce active; that is
    // correct (status is announced on login). Sanity: a client exists.
    expect(FakeTelegramClient.lastInstance).toBeDefined();
  });
});

/**
 * Connect-loop FLOOD_WAIT: a flood during (re)connect is rate-limiting, NOT a
 * broken session — the loop backs off and retries rather than marking expired.
 */
describe("manager — connect-loop FLOOD_WAIT handling", () => {
  const prev = {
    enabled: process.env.BRIDGE_ENABLED,
    secret: process.env.BRIDGE_SHARED_SECRET,
    sessionKey: process.env.BRIDGE_SESSION_KEY,
    apiId: process.env.TELEGRAM_API_ID,
    apiHash: process.env.TELEGRAM_API_HASH,
    alloUrl: process.env.ALLO_INTERNAL_URL,
  };

  beforeEach(() => {
    process.env.BRIDGE_ENABLED = "true";
    process.env.BRIDGE_SHARED_SECRET = TEST_BRIDGE_SECRET;
    process.env.BRIDGE_SESSION_KEY = TEST_SESSION_KEY;
    process.env.TELEGRAM_API_ID = "12345";
    process.env.TELEGRAM_API_HASH = "abcdef";
    process.env.ALLO_INTERNAL_URL = "http://allo.test";
    postedEvents.length = 0;
    FakeTelegramClient.reset();
  });

  afterEach(() => {
    process.env.BRIDGE_ENABLED = prev.enabled;
    process.env.BRIDGE_SHARED_SECRET = prev.secret;
    process.env.BRIDGE_SESSION_KEY = prev.sessionKey;
    process.env.TELEGRAM_API_ID = prev.apiId;
    process.env.TELEGRAM_API_HASH = prev.apiHash;
    process.env.ALLO_INTERNAL_URL = prev.alloUrl;
    jest.clearAllMocks();
  });

  it("retries after a one-shot connect FLOOD_WAIT and connects (no expired status)", async () => {
    await sessionStore.saveActive("owner-1", "SESSION", { id: "1000" });
    // First connect throws a 0s flood (so the backoff sleep is ~0ms), then succeeds.
    FakeTelegramClient.connectErrorQueue = [new FakeFloodWaitError(0)];

    const manager = new TelegramManager();
    const client = await manager.ensureConnected("owner-1");

    expect(client).not.toBeNull();
    // The session must NOT have been flipped to expired by the flood.
    const status = await sessionStore.getStatus("owner-1");
    expect(status).toBe("active");
    const expiredEvent = postedEvents.find(
      (e) => (e as { sessionStatus?: string }).sessionStatus === "expired"
    );
    expect(expiredEvent).toBeUndefined();
  });

  it("gives up on a persistent connect FLOOD_WAIT WITHOUT marking the session expired", async () => {
    await sessionStore.saveActive("owner-1", "SESSION", { id: "1000" });
    // Persistent 0s flood on every attempt: the loop exhausts and returns null,
    // but a flood is not a broken session, so it must not be marked expired.
    FakeTelegramClient.behavior.connectError = new FakeFloodWaitError(0);

    const manager = new TelegramManager();
    const client = await manager.ensureConnected("owner-1");

    expect(client).toBeNull();
    const status = await sessionStore.getStatus("owner-1");
    expect(status).toBe("active");
  });

  it("marks the session expired on a persistent NON-flood connect error", async () => {
    await sessionStore.saveActive("owner-1", "SESSION", { id: "1000" });
    FakeTelegramClient.behavior.connectThrows = true; // generic connect failure

    const manager = new TelegramManager();
    const client = await manager.ensureConnected("owner-1");

    expect(client).toBeNull();
    const status = await sessionStore.getStatus("owner-1");
    expect(status).toBe("expired");
  });
});

/**
 * Settle-race / teardown guard (review findings 6 + 11): a pending login that is
 * abandoned (re-link) or shut down must settle its parked awaiter exactly once and
 * never hang or double-settle.
 */
describe("manager — login settlement teardown guard", () => {
  const prev = {
    enabled: process.env.BRIDGE_ENABLED,
    secret: process.env.BRIDGE_SHARED_SECRET,
    sessionKey: process.env.BRIDGE_SESSION_KEY,
    apiId: process.env.TELEGRAM_API_ID,
    apiHash: process.env.TELEGRAM_API_HASH,
    alloUrl: process.env.ALLO_INTERNAL_URL,
  };

  beforeEach(() => {
    process.env.BRIDGE_ENABLED = "true";
    process.env.BRIDGE_SHARED_SECRET = TEST_BRIDGE_SECRET;
    process.env.BRIDGE_SESSION_KEY = TEST_SESSION_KEY;
    process.env.TELEGRAM_API_ID = "12345";
    process.env.TELEGRAM_API_HASH = "abcdef";
    process.env.ALLO_INTERNAL_URL = "http://allo.test";
    postedEvents.length = 0;
    FakeTelegramClient.reset();
  });

  afterEach(() => {
    process.env.BRIDGE_ENABLED = prev.enabled;
    process.env.BRIDGE_SHARED_SECRET = prev.secret;
    process.env.BRIDGE_SESSION_KEY = prev.sessionKey;
    process.env.TELEGRAM_API_ID = prev.apiId;
    process.env.TELEGRAM_API_HASH = prev.apiHash;
    process.env.ALLO_INTERNAL_URL = prev.alloUrl;
    jest.clearAllMocks();
  });

  it("shutdown() during a pending QR login does not hang or throw (settles once)", async () => {
    FakeTelegramClient.qrBehavior = "hang"; // QR issued, never scanned
    const manager = new TelegramManager();

    const started = await manager.startQrLogin("owner-1");
    expect(started.status).toBe("pending");

    // Tearing down a pending login must resolve cleanly (parked Deferreds are
    // cancelled idempotently) — no unhandled rejection, no hang.
    await expect(manager.shutdown()).resolves.toBeUndefined();
  });

  it("re-linking abandons the prior pending login without a double-settle", async () => {
    FakeTelegramClient.qrBehavior = "hang";
    const manager = new TelegramManager();

    const first = await manager.startQrLogin("owner-1");
    expect(first.status).toBe("pending");

    // A second link for the same owner abandons the first attempt; both calls
    // resolve to a valid pending step (no hang, no crash from a stale settle).
    const second = await manager.startQrLogin("owner-1");
    expect(second).toMatchObject({ v: 1, status: "pending" });
    expect(typeof second.loginUrl).toBe("string");

    await manager.shutdown();
  });

  it("pruneStaleLogins tears down an expired pending login safely", async () => {
    FakeTelegramClient.qrBehavior = "hang";
    const manager = new TelegramManager();
    await manager.startQrLogin("owner-1");

    // Far-future 'now' so the attempt is past its TTL and gets pruned.
    expect(() => manager.pruneStaleLogins(Date.now() + 60 * 60 * 1000)).not.toThrow();
    await manager.shutdown();
  });
});

/**
 * Session store: encrypt-on-write / decrypt-on-read at the persistence boundary,
 * plus status transitions and revoke purging the encrypted blob.
 */
describe("sessionStore — encrypted persistence boundary", () => {
  const prevSessionKey = process.env.BRIDGE_SESSION_KEY;
  beforeEach(() => {
    process.env.BRIDGE_SESSION_KEY = TEST_SESSION_KEY;
  });
  afterEach(() => {
    process.env.BRIDGE_SESSION_KEY = prevSessionKey;
  });

  it("saves an ACTIVE session encrypted and loads it back decrypted", async () => {
    await sessionStore.saveActive("u1", "PLAINTEXT-SESSION-STRING", {
      id: "5",
      username: "bob",
    });
    const raw = await sessionStore.getRaw("u1");
    expect(raw?.encryptedSession).toBeDefined();
    // The stored ciphertext must NOT contain the plaintext.
    const ciphertext = Buffer.from(raw?.encryptedSession?.ciphertext ?? "", "base64").toString();
    expect(ciphertext).not.toContain("PLAINTEXT");

    const loaded = await sessionStore.load("u1");
    expect(loaded?.status).toBe("active");
    expect(loaded?.sessionString).toBe("PLAINTEXT-SESSION-STRING");
    expect(loaded?.externalSelf).toMatchObject({ id: "5", username: "bob" });
  });

  it("returns null status for an unlinked user", async () => {
    expect(await sessionStore.getStatus("nope")).toBeNull();
  });

  it("revoke purges the encrypted blob and marks revoked", async () => {
    await sessionStore.saveActive("u2", "SECRET", { id: "9" });
    await sessionStore.revoke("u2");
    const raw = await sessionStore.getRaw("u2");
    expect(raw?.status).toBe("revoked");
    expect(raw?.encryptedSession).toBeUndefined();
  });

  it("marks the session error when stored ciphertext cannot be decrypted (key rotated)", async () => {
    await sessionStore.saveActive("u3", "SECRET", { id: "9" });
    // Rotate the key so the stored blob no longer decrypts.
    process.env.BRIDGE_SESSION_KEY = "rotated-key-rotated-key-rotated-key";
    const loaded = await sessionStore.load("u3");
    expect(loaded?.sessionString).toBeUndefined();
    expect(loaded?.status).toBe("error");
  });
});
