/**
 * Multi-device per-device-envelope fan-out tests (Fase 1A, frontend).
 *
 * These exercise the store-level orchestration — device-list resolution,
 * envelope fan-out, the 409 stale-device-list retry, dedup-before-decrypt and
 * own-other-device realtime handling — with the crypto/wire/session layers and
 * the network layer mocked. The real Signal layer is covered by signal.test.ts.
 */

import { ENCRYPTION_VERSION_ENVELOPES } from "@allo/shared-types";

// --- Mocks for native / heavy modules pulled in transitively by the stores ---

jest.mock("expo-constants", () => ({
  __esModule: true,
  default: { deviceName: "Test Device", expoConfig: { name: "Allo" } },
}));

// Network layer. Defined inside the factory (jest hoists jest.mock above
// top-level consts), then captured via requireMock for per-test assertions.
jest.mock("@/utils/api", () => ({
  api: {
    get: jest.fn(),
    post: jest.fn(),
    put: jest.fn(),
    delete: jest.fn(),
    patch: jest.fn(),
  },
  setApiDeviceId: jest.fn(),
}));

// Signal crypto layer — deterministic, side-effect free stand-ins.
jest.mock("@/lib/signalProtocol", () => ({
  __esModule: true,
  initializeDeviceKeys: jest.fn(),
  getDeviceKeys: jest.fn(),
  encryptForPeer: jest.fn(),
  decryptFromPeer: jest.fn(),
  remainingOneTimePreKeys: jest.fn(async () => 100),
  generateAndStoreNewPreKeys: jest.fn(async () => []),
  PREKEY_LOW_THRESHOLD: 20,
  LegacyMessageError: class LegacyMessageError extends Error {},
}));

// Session store — controls which targets are treated as "already have a session".
jest.mock("@/lib/signal/sessionStore", () => ({
  loadSession: jest.fn(),
  saveSession: jest.fn(),
  deleteSession: jest.fn(),
  clearSessionMemoryCache: jest.fn(),
}));

// Offline storage — local persistence is a no-op; getMessagesLocally is driven
// per-test.
jest.mock("@/lib/offlineStorage", () => ({
  storeMessagesLocally: jest.fn(async () => undefined),
  getMessagesLocally: jest.fn(async () => []),
  addMessageLocally: jest.fn(async () => undefined),
  updateMessageLocally: jest.fn(async () => undefined),
  removeMessageLocally: jest.fn(async () => undefined),
  addToSyncQueue: jest.fn(async () => undefined),
}));

// P2P transport — never intercepts in these tests (forces the relay path).
jest.mock("@/lib/p2pMessaging", () => ({
  p2pManager: { sendMessage: jest.fn(() => false) },
}));

// Toast layer pulls in react-native-screens (native); stub it out.
jest.mock("@/lib/sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn(), loading: jest.fn(), dismiss: jest.fn() },
}));

// eslint-disable-next-line import/first
import { useDeviceKeysStore } from "@/stores/deviceKeysStore";
// eslint-disable-next-line import/first
import { useMessagesStore } from "@/stores/messagesStore";
// eslint-disable-next-line import/first
import { useConversationsStore } from "@/stores/conversationsStore";
// eslint-disable-next-line import/first
import { getMessagesLocally } from "@/lib/offlineStorage";
// eslint-disable-next-line import/first
import { buildIncomingMessage } from "@/hooks/useRealtimeMessaging";
// eslint-disable-next-line import/first
import { api as mockApi, setApiDeviceId } from "@/utils/api";
// eslint-disable-next-line import/first
import { encryptForPeer, decryptFromPeer } from "@/lib/signalProtocol";
// eslint-disable-next-line import/first
import { loadSession } from "@/lib/signal/sessionStore";

const mockEncryptForPeer = encryptForPeer as jest.Mock;
const mockDecryptFromPeer = decryptFromPeer as jest.Mock;
const mockLoadSession = loadSession as jest.Mock;
const mockSetApiDeviceId = setApiDeviceId as jest.Mock;
// `mockApi` methods are jest.fn() from the factory above.
const apiGet = mockApi.get as jest.Mock;
const apiPost = mockApi.post as jest.Mock;
const mockGetMessagesLocally = getMessagesLocally as jest.Mock;

const OWN_USER = "userSelf";
const OWN_DEVICE = 1000;

function seedDeviceKeys(): void {
  useDeviceKeysStore.setState({
    deviceKeys: {
      deviceId: OWN_DEVICE,
      identityKeyPublic: "ikpub",
      identityKeyPrivate: "ikpriv",
      signedPreKey: { keyId: 1, publicKey: "spk", privateKey: "spkpriv", signature: "sig" },
      preKeys: [{ keyId: 1, publicKey: "pk", privateKey: "pkpriv" }],
      registrationId: 42,
    },
    isInitialized: true,
    isLoading: false,
    error: null,
  });
}

/** Build a `/devices/user/:id` style response (wrapped like the backend). */
function devicesResponse(deviceIds: number[]) {
  return {
    data: {
      data: {
        devices: deviceIds.map((deviceId) => ({ deviceId, identityKeyPublic: `ik-${deviceId}` })),
        inactiveDevices: [],
      },
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  useDeviceKeysStore.getState().invalidateDeviceCache();
  seedDeviceKeys();
  // Default: no pre-existing sessions, so every target needs a batch bundle.
  mockLoadSession.mockResolvedValue(null);
  // Default batch prekey endpoint returns a bundle for every requested target.
  apiPost.mockImplementation(async (endpoint: string, body: unknown) => {
    if (endpoint === "/devices/prekeys/batch") {
      const targets = (body as { targets: { userId: string; deviceId: number }[] }).targets;
      return {
        data: {
          data: {
            bundles: targets.map((t) => ({
              userId: t.userId,
              deviceId: t.deviceId,
              identityKeyPublic: `ik-${t.deviceId}`,
              signedPreKey: { keyId: 1, publicKey: "spk", signature: "sig" },
              registrationId: 1,
              preKey: { keyId: 2, publicKey: "opk" },
            })),
            missing: [],
          },
        },
      };
    }
    return { data: { data: {} } };
  });
  // Encrypt produces a deterministic ciphertext per target.
  mockEncryptForPeer.mockImplementation(
    async (peer: { userId: string; deviceId: number }) => `ct-${peer.userId}-${peer.deviceId}`
  );
});

describe("encryptForConversation", () => {
  it("fans out one envelope per device of every participant, excluding own current device", async () => {
    // 3 users × 2 devices each. Self has devices [1000 (current), 1001].
    apiGet.mockImplementation(async (endpoint: string) => {
      if (endpoint === `/devices/user/${OWN_USER}`) return devicesResponse([OWN_DEVICE, 1001]);
      if (endpoint === "/devices/user/userB") return devicesResponse([2000, 2001]);
      if (endpoint === "/devices/user/userC") return devicesResponse([3000, 3001]);
      throw new Error(`unexpected GET ${endpoint}`);
    });

    const { envelopes, failures } = await useDeviceKeysStore
      .getState()
      .encryptForConversation("hello", [OWN_USER, "userB", "userC"], OWN_USER);

    // 6 total devices minus our own current device (1000) = 5 envelopes.
    expect(envelopes).toHaveLength(5);
    expect(failures).toHaveLength(0);

    const targets = envelopes.map((e) => `${e.recipientUserId}:${e.recipientDeviceId}`).sort();
    expect(targets).toEqual(
      ["userB:2000", "userB:2001", "userC:3000", "userC:3001", `${OWN_USER}:1001`].sort()
    );
    // Our own current device must never receive an envelope.
    expect(targets).not.toContain(`${OWN_USER}:${OWN_DEVICE}`);
  });

  it("skips a single failed device but still returns the other envelopes", async () => {
    apiGet.mockImplementation(async (endpoint: string) => {
      if (endpoint === `/devices/user/${OWN_USER}`) return devicesResponse([OWN_DEVICE]);
      if (endpoint === "/devices/user/userB") return devicesResponse([2000, 2001]);
      throw new Error(`unexpected GET ${endpoint}`);
    });
    // Device 2001 fails to encrypt; 2000 succeeds.
    mockEncryptForPeer.mockImplementation(async (peer: { userId: string; deviceId: number }) => {
      if (peer.deviceId === 2001) throw new Error("encrypt failed");
      return `ct-${peer.userId}-${peer.deviceId}`;
    });

    const { envelopes, failures } = await useDeviceKeysStore
      .getState()
      .encryptForConversation("hi", [OWN_USER, "userB"], OWN_USER);

    expect(envelopes).toHaveLength(1);
    expect(envelopes[0].recipientDeviceId).toBe(2000);
    expect(failures).toEqual([{ userId: "userB", deviceId: 2001 }]);
  });

  it("throws when a recipient user ends up with zero envelopes", async () => {
    apiGet.mockImplementation(async (endpoint: string) => {
      if (endpoint === `/devices/user/${OWN_USER}`) return devicesResponse([OWN_DEVICE]);
      if (endpoint === "/devices/user/userB") return devicesResponse([2000]);
      throw new Error(`unexpected GET ${endpoint}`);
    });
    // The recipient's only device fails to encrypt → fatal.
    mockEncryptForPeer.mockRejectedValue(new Error("encrypt failed"));

    await expect(
      useDeviceKeysStore.getState().encryptForConversation("hi", [OWN_USER, "userB"], OWN_USER)
    ).rejects.toThrow(/Failed to encrypt message for recipient userB/);
  });

  it("tolerates a failure on our own OTHER device (sent-message sync only)", async () => {
    apiGet.mockImplementation(async (endpoint: string) => {
      if (endpoint === `/devices/user/${OWN_USER}`) return devicesResponse([OWN_DEVICE, 1001]);
      if (endpoint === "/devices/user/userB") return devicesResponse([2000]);
      throw new Error(`unexpected GET ${endpoint}`);
    });
    // Our own other device (1001) fails, recipient (2000) succeeds.
    mockEncryptForPeer.mockImplementation(async (peer: { deviceId: number }) => {
      if (peer.deviceId === 1001) throw new Error("own device offline");
      return `ct-${peer.deviceId}`;
    });

    const { envelopes, failures } = await useDeviceKeysStore
      .getState()
      .encryptForConversation("hi", [OWN_USER, "userB"], OWN_USER);

    expect(envelopes.map((e) => e.recipientDeviceId)).toEqual([2000]);
    expect(failures).toEqual([{ userId: OWN_USER, deviceId: 1001 }]);
  });

  it("only batch-fetches bundles for targets without an existing session", async () => {
    apiGet.mockImplementation(async (endpoint: string) => {
      if (endpoint === `/devices/user/${OWN_USER}`) return devicesResponse([OWN_DEVICE]);
      if (endpoint === "/devices/user/userB") return devicesResponse([2000, 2001]);
      throw new Error(`unexpected GET ${endpoint}`);
    });
    // 2000 already has a session; 2001 does not.
    mockLoadSession.mockImplementation(async (addr: { deviceId: number }) =>
      addr.deviceId === 2000 ? ({} as object) : null
    );

    await useDeviceKeysStore
      .getState()
      .encryptForConversation("hi", [OWN_USER, "userB"], OWN_USER);

    const batchCalls = apiPost.mock.calls.filter((c) => c[0] === "/devices/prekeys/batch");
    expect(batchCalls).toHaveLength(1);
    const requestedTargets = (batchCalls[0][1] as { targets: { deviceId: number }[] }).targets;
    expect(requestedTargets.map((t) => t.deviceId)).toEqual([2001]);
  });
});

describe("device list cache", () => {
  it("serves repeat lookups from the TTL cache (single network fetch)", async () => {
    apiGet.mockImplementation(async () => devicesResponse([2000]));

    await useDeviceKeysStore.getState().getDevicesForUsers(["userB"]);
    await useDeviceKeysStore.getState().getDevicesForUsers(["userB"]);

    const getCalls = apiGet.mock.calls.filter((c) => c[0] === "/devices/user/userB");
    expect(getCalls).toHaveLength(1);
  });

  it("re-fetches after invalidation", async () => {
    apiGet.mockImplementation(async () => devicesResponse([2000]));

    await useDeviceKeysStore.getState().getDevicesForUsers(["userB"]);
    useDeviceKeysStore.getState().invalidateDeviceCache(["userB"]);
    await useDeviceKeysStore.getState().getDevicesForUsers(["userB"]);

    const getCalls = apiGet.mock.calls.filter((c) => c[0] === "/devices/user/userB");
    expect(getCalls).toHaveLength(2);
  });
});

/** A 409 stale_device_list error shaped like an axios error. */
function staleDeviceListError(missing: { userId: string; deviceId: number }[]): Error {
  const err = new Error("Request failed with status code 409") as Error & {
    response: { status: number; data: { error: string; missingDevices: unknown[]; unknownDevices: unknown[] } };
  };
  err.response = {
    status: 409,
    data: { error: "stale_device_list", missingDevices: missing, unknownDevices: [] },
  };
  return err;
}

/** Seed a group conversation so the P2P fast-path is always bypassed. */
function seedGroupConversation(conversationId: string, participantIds: string[]): void {
  useConversationsStore.setState({
    conversationsById: {
      [conversationId]: {
        id: conversationId,
        type: "group",
        name: "Group",
        lastMessage: "",
        timestamp: new Date().toISOString(),
        unreadCount: 0,
        participants: participantIds.map((id) => ({ id })),
      },
    },
  });
}

describe("sendMessage — 409 stale_device_list retry", () => {
  beforeEach(() => {
    useMessagesStore.getState().reset();
    mockGetMessagesLocally.mockResolvedValue([]);
    seedGroupConversation("conv1", [OWN_USER, "userB"]);
  });

  it("invalidates the cache, re-encrypts and retries exactly once with a different payload", async () => {
    // First device fetch: userB has ONE device (2000). After the 409 forces a
    // cache refresh, userB now has TWO devices (2000, 2001) — so the retry's
    // envelope set must differ.
    let userBFetchCount = 0;
    apiGet.mockImplementation(async (endpoint: string) => {
      if (endpoint === `/devices/user/${OWN_USER}`) return devicesResponse([OWN_DEVICE]);
      if (endpoint === "/devices/user/userB") {
        userBFetchCount += 1;
        return userBFetchCount === 1 ? devicesResponse([2000]) : devicesResponse([2000, 2001]);
      }
      throw new Error(`unexpected GET ${endpoint}`);
    });

    const messagePosts: unknown[] = [];
    apiPost.mockImplementation(async (endpoint: string, body: unknown) => {
      if (endpoint === "/devices/prekeys/batch") {
        const targets = (body as { targets: { userId: string; deviceId: number }[] }).targets;
        return {
          data: {
            data: {
              bundles: targets.map((t) => ({
                userId: t.userId,
                deviceId: t.deviceId,
                identityKeyPublic: `ik-${t.deviceId}`,
                signedPreKey: { keyId: 1, publicKey: "spk", signature: "sig" },
                registrationId: 1,
                preKey: null,
              })),
              missing: [],
            },
          },
        };
      }
      if (endpoint === "/messages") {
        messagePosts.push(body);
        if (messagePosts.length === 1) {
          throw staleDeviceListError([{ userId: "userB", deviceId: 2001 }]);
        }
        return { data: { data: { _id: "server-msg-1" } } };
      }
      throw new Error(`unexpected POST ${endpoint}`);
    });

    const result = await useMessagesStore
      .getState()
      .sendMessage("conv1", "hello group", OWN_USER, "userB");

    expect(result).not.toBeNull();

    // Exactly two POST /messages attempts (one failure + one retry).
    expect(messagePosts).toHaveLength(2);

    const first = messagePosts[0] as { envelopes: { recipientDeviceId: number }[]; encryptionVersion: number };
    const second = messagePosts[1] as { envelopes: { recipientDeviceId: number }[] };

    expect(first.encryptionVersion).toBe(ENCRYPTION_VERSION_ENVELOPES);
    // First attempt only knew about device 2000; retry includes 2000 + 2001.
    expect(first.envelopes.map((e) => e.recipientDeviceId).sort()).toEqual([2000]);
    expect(second.envelopes.map((e) => e.recipientDeviceId).sort()).toEqual([2000, 2001]);

    // The recipient device list was refetched after invalidation.
    expect(userBFetchCount).toBe(2);
  });

  it("does not retry more than once (a second 409 propagates as a send failure)", async () => {
    apiGet.mockImplementation(async (endpoint: string) => {
      if (endpoint === `/devices/user/${OWN_USER}`) return devicesResponse([OWN_DEVICE]);
      if (endpoint === "/devices/user/userB") return devicesResponse([2000]);
      throw new Error(`unexpected GET ${endpoint}`);
    });

    let messagePostCount = 0;
    apiPost.mockImplementation(async (endpoint: string, body: unknown) => {
      if (endpoint === "/devices/prekeys/batch") {
        const targets = (body as { targets: { userId: string; deviceId: number }[] }).targets;
        return {
          data: { data: { bundles: targets.map((t) => ({ userId: t.userId, deviceId: t.deviceId, identityKeyPublic: "ik", signedPreKey: { keyId: 1, publicKey: "spk", signature: "sig" }, registrationId: 1, preKey: null })), missing: [] } },
        };
      }
      if (endpoint === "/messages") {
        messagePostCount += 1;
        throw staleDeviceListError([{ userId: "userB", deviceId: 2000 }]);
      }
      throw new Error(`unexpected POST ${endpoint}`);
    });

    const result = await useMessagesStore
      .getState()
      .sendMessage("conv1", "hello", OWN_USER, "userB");

    // The send is queued (not thrown) but the server was only hit twice.
    expect(result).not.toBeNull();
    expect(messagePostCount).toBe(2);
  });
});

describe("fetchMessages — dedup before decrypt", () => {
  beforeEach(() => {
    useMessagesStore.getState().reset();
    seedGroupConversation("conv2", [OWN_USER, "userB"]);
    mockDecryptFromPeer.mockImplementation(async (_peer: unknown, ciphertext: string) =>
      `decrypted:${ciphertext}`
    );
  });

  it("decrypts only NEW server messages and preserves the local decrypted copy", async () => {
    // Local store already holds m1 decrypted (isEncrypted:false) and m2 still
    // encrypted. Server returns m1 (encrypted), m2 (encrypted) and a new m3.
    mockGetMessagesLocally.mockResolvedValue([
      {
        id: "m1",
        text: "decrypted:ct1",
        senderId: "userB",
        senderDeviceId: 2000,
        timestamp: new Date("2026-01-01T00:00:00Z"),
        isSent: false,
        conversationId: "conv2",
        isEncrypted: false,
        ciphertext: "ct1",
      },
    ]);

    apiGet.mockImplementation(async (endpoint: string) => {
      if (endpoint === "/messages") {
        return {
          data: {
            messages: [
              {
                _id: "m1",
                senderId: "userB",
                senderDeviceId: 2000,
                conversationId: "conv2",
                ciphertext: "ct1",
                encryptionVersion: ENCRYPTION_VERSION_ENVELOPES,
                createdAt: "2026-01-01T00:00:00Z",
              },
              {
                _id: "m3",
                senderId: "userB",
                senderDeviceId: 2000,
                conversationId: "conv2",
                ciphertext: "ct3",
                encryptionVersion: ENCRYPTION_VERSION_ENVELOPES,
                createdAt: "2026-01-01T00:02:00Z",
              },
            ],
          },
        };
      }
      throw new Error(`unexpected GET ${endpoint}`);
    });

    await useMessagesStore.getState().fetchMessages("conv2", OWN_USER);

    const messages = useMessagesStore.getState().messagesByConversation["conv2"];
    const byId = new Map(messages.map((m) => [m.id, m]));

    // m1 already decrypted locally: it must NOT be decrypted again (ct1 untouched).
    expect(mockDecryptFromPeer).not.toHaveBeenCalledWith(expect.anything(), "ct1");
    expect(byId.get("m1")?.text).toBe("decrypted:ct1");

    // m3 is new: decrypted exactly once.
    expect(mockDecryptFromPeer).toHaveBeenCalledWith(expect.anything(), "ct3");
    expect(byId.get("m3")?.text).toBe("decrypted:ct3");
  });

  it("renders the placeholder for a v3 message with a missing envelope (never decrypts)", async () => {
    mockGetMessagesLocally.mockResolvedValue([]);
    apiGet.mockImplementation(async (endpoint: string) => {
      if (endpoint === "/messages") {
        return {
          data: {
            messages: [
              {
                _id: "m9",
                senderId: "userB",
                senderDeviceId: 2000,
                conversationId: "conv2",
                ciphertext: null,
                envelopeMissing: true,
                encryptionVersion: ENCRYPTION_VERSION_ENVELOPES,
                createdAt: "2026-01-01T00:00:00Z",
              },
            ],
          },
        };
      }
      throw new Error(`unexpected GET ${endpoint}`);
    });

    await useMessagesStore.getState().fetchMessages("conv2", OWN_USER);

    const messages = useMessagesStore.getState().messagesByConversation["conv2"];
    expect(messages).toHaveLength(1);
    expect(messages[0].isEncrypted).toBe(false);
    // No decryption attempt for a missing envelope.
    expect(mockDecryptFromPeer).not.toHaveBeenCalled();
    // Localized placeholder (i18n key value).
    expect(messages[0].text.length).toBeGreaterThan(0);
    expect(messages[0].text).not.toContain("ct");
  });
});

describe("realtime newMessage — own-other-device sync", () => {
  it("decrypts a message from our OTHER device and inserts it as isSent", async () => {
    const decrypt = jest.fn(async (ciphertext: string) => `plain:${ciphertext}`);

    const result = await buildIncomingMessage(
      {
        _id: "sync-1",
        conversationId: "conv1",
        senderId: OWN_USER,
        senderDeviceId: 1001, // our OTHER device (current is OWN_DEVICE=1000)
        ciphertext: "ct-own-other",
        createdAt: "2026-01-01T00:00:00Z",
      },
      OWN_USER,
      OWN_DEVICE,
      decrypt
    );

    expect(result.skip).toBe(false);
    expect(result.decryptionSucceeded).toBe(true);
    expect(result.message?.isSent).toBe(true);
    expect(result.message?.text).toBe("plain:ct-own-other");
    expect(result.message?.isEncrypted).toBe(false);
    expect(decrypt).toHaveBeenCalledWith("ct-own-other", OWN_USER, 1001);
  });

  it("skips a message authored by THIS device (already added locally)", async () => {
    const decrypt = jest.fn();
    const result = await buildIncomingMessage(
      {
        _id: "self-1",
        conversationId: "conv1",
        senderId: OWN_USER,
        senderDeviceId: OWN_DEVICE, // this exact device
        ciphertext: "ct",
        createdAt: "2026-01-01T00:00:00Z",
      },
      OWN_USER,
      OWN_DEVICE,
      decrypt
    );

    expect(result.skip).toBe(true);
    expect(result.message).toBeNull();
    expect(decrypt).not.toHaveBeenCalled();
  });

  it("decrypts a message from another user and inserts it as not-sent", async () => {
    const decrypt = jest.fn(async (ciphertext: string) => `plain:${ciphertext}`);
    const result = await buildIncomingMessage(
      {
        _id: "peer-1",
        conversationId: "conv1",
        senderId: "userB",
        senderDeviceId: 2000,
        ciphertext: "ct-peer",
        createdAt: "2026-01-01T00:00:00Z",
      },
      OWN_USER,
      OWN_DEVICE,
      decrypt
    );

    expect(result.skip).toBe(false);
    expect(result.message?.isSent).toBe(false);
    expect(result.message?.text).toBe("plain:ct-peer");
  });
});

describe("device id wiring", () => {
  it("registers this device's id for the X-Device-Id header on initialize", async () => {
    const signal = jest.requireMock("@/lib/signalProtocol") as {
      initializeDeviceKeys: jest.Mock;
    };
    signal.initializeDeviceKeys.mockResolvedValue({
      deviceId: OWN_DEVICE,
      identityKeyPublic: "ikpub",
      identityKeyPrivate: "ikpriv",
      signedPreKey: { keyId: 1, publicKey: "spk", privateKey: "spkpriv", signature: "sig" },
      preKeys: [],
      registrationId: 42,
    });
    apiPost.mockResolvedValue({ data: { data: {} } });

    await useDeviceKeysStore.getState().initialize();

    expect(mockSetApiDeviceId).toHaveBeenCalledWith(OWN_DEVICE);
  });

  it("clears the device id on reset", () => {
    useDeviceKeysStore.getState().reset();
    expect(mockSetApiDeviceId).toHaveBeenCalledWith(null);
  });
});
