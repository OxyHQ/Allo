/**
 * Interop bridge (F3.1 frontend) tests.
 *
 * Cover the store/logic seam of the bridge UI with the crypto, network and native
 * layers mocked:
 *  - capability resolution (native all-true vs Telegram's conservative matrix)
 *  - conversationsStore mapping of `network` + `externalParticipants` (incl.
 *    bridged-direct display identity)
 *  - messagesStore bridged branch (plaintext POST, NO Signal encryption / NO
 *    envelopes / NO P2P)
 *  - AttachmentMenu capability gating (extractable filter logic)
 */

import { NETWORK_CAPABILITIES } from "@allo/shared-types";

// --- Mocks for native / heavy modules pulled in transitively by the stores ---

jest.mock("expo-constants", () => ({
  __esModule: true,
  default: { deviceName: "Test Device", expoConfig: { name: "Allo" } },
}));

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

// Signal crypto layer — must NEVER be invoked on the bridged path.
jest.mock("@/lib/signalProtocol", () => ({
  __esModule: true,
  initializeDeviceKeys: jest.fn(),
  getDeviceKeys: jest.fn(),
  encryptForPeer: jest.fn(),
  decryptFromPeer: jest.fn(),
  remainingOneTimePreKeys: jest.fn(async () => 100),
  generateAndStoreNewPreKeys: jest.fn(async () => []),
  wipeAllSignalState: jest.fn(async () => undefined),
  PREKEY_LOW_THRESHOLD: 20,
  LegacyMessageError: class LegacyMessageError extends Error {},
}));

jest.mock("@/lib/signal/sessionStore", () => ({
  loadSession: jest.fn(),
  saveSession: jest.fn(),
  deleteSession: jest.fn(),
  clearSessionMemoryCache: jest.fn(),
}));

jest.mock("@/lib/offlineStorage", () => ({
  storeMessagesLocally: jest.fn(async () => undefined),
  getMessagesLocally: jest.fn(async () => []),
  addMessageLocally: jest.fn(async () => undefined),
  updateMessageLocally: jest.fn(async () => undefined),
  removeMessageLocally: jest.fn(async () => undefined),
  addToSyncQueue: jest.fn(async () => undefined),
  getConversationsLocally: jest.fn(async () => []),
  storeConversationsLocally: jest.fn(async () => undefined),
}));

// P2P transport — must NEVER intercept on the bridged path.
jest.mock("@/lib/p2pMessaging", () => ({
  p2pManager: { sendMessage: jest.fn(() => false) },
}));

jest.mock("@/lib/sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn(), loading: jest.fn(), dismiss: jest.fn() },
}));

// eslint-disable-next-line import/first
import {
  getConversationCapabilities,
  conversationNetwork,
  isBridgedConversation,
} from "@/hooks/useConversationCapabilities";
// eslint-disable-next-line import/first
import { useConversationsStore, mapApiConversation } from "@/stores/conversationsStore";
// eslint-disable-next-line import/first
import { useMessagesStore } from "@/stores/messagesStore";
// eslint-disable-next-line import/first
import { useDeviceKeysStore } from "@/stores/deviceKeysStore";
// eslint-disable-next-line import/first
import { api as mockApi } from "@/utils/api";
// eslint-disable-next-line import/first
import { encryptForPeer } from "@/lib/signalProtocol";
// eslint-disable-next-line import/first
import { p2pManager } from "@/lib/p2pMessaging";
// eslint-disable-next-line import/first
import type { Conversation } from "@/app/(chat)/index";
// eslint-disable-next-line import/first
import {
  startLink,
  submitLinkCode,
  submitLinkPassword,
  getLinkStatus,
} from "@/lib/bridge/api";
// eslint-disable-next-line import/first
import {
  nextStepFromResult,
  shouldContinuePolling,
  MAX_STATUS_POLLS,
} from "@/hooks/useBridgeLinkFlow";

const apiGet = mockApi.get as jest.Mock;
const apiPost = mockApi.post as jest.Mock;
const mockEncryptForPeer = encryptForPeer as jest.Mock;
const mockP2PSend = p2pManager.sendMessage as jest.Mock;

const OWN_USER = "userSelf";
const OWN_DEVICE = 1000;

/** Build a minimal conversation object for the store. */
function makeConversation(overrides: Partial<Conversation>): Conversation {
  return {
    id: "conv1",
    type: "direct",
    name: "Chat",
    lastMessage: "",
    timestamp: new Date().toISOString(),
    unreadCount: 0,
    ...overrides,
  };
}

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

beforeEach(() => {
  jest.clearAllMocks();
  seedDeviceKeys();
});

describe("useConversationCapabilities — capability resolution", () => {
  it("native Allo conversation resolves to the all-supported matrix", () => {
    const caps = getConversationCapabilities(makeConversation({ network: "allo" }));
    expect(caps).toEqual(NETWORK_CAPABILITIES.allo);
    // Every native capability is supported.
    expect(caps.e2e).toBe(true);
    expect(caps.calls).toBe(true);
    expect(caps.polls).toBe(true);
    expect(caps.reactions).toBe(true);
  });

  it("a missing network is treated as native Allo (zero behaviour change)", () => {
    const caps = getConversationCapabilities(makeConversation({ network: undefined }));
    expect(caps).toEqual(NETWORK_CAPABILITIES.allo);
    expect(conversationNetwork(makeConversation({ network: undefined }))).toBe("allo");
    expect(isBridgedConversation(makeConversation({ network: undefined }))).toBe(false);
  });

  it("null conversation resolves to native Allo capabilities", () => {
    expect(getConversationCapabilities(null)).toEqual(NETWORK_CAPABILITIES.allo);
    expect(conversationNetwork(undefined)).toBe("allo");
    expect(isBridgedConversation(null)).toBe(false);
  });

  it("Telegram conversation resolves to Telegram's conservative matrix", () => {
    const conv = makeConversation({ network: "telegram" });
    const caps = getConversationCapabilities(conv);
    expect(caps).toEqual(NETWORK_CAPABILITIES.telegram);
    // Telegram: no E2E, no calls, no polls; reactions/edits/typing allowed.
    expect(caps.e2e).toBe(false);
    expect(caps.calls).toBe(false);
    expect(caps.polls).toBe(false);
    expect(caps.reactions).toBe(true);
    expect(caps.edits).toBe(true);
    expect(caps.typing).toBe(true);
    expect(isBridgedConversation(conv)).toBe(true);
    expect(conversationNetwork(conv)).toBe("telegram");
  });
});

describe("conversationsStore — network + externalParticipants mapping", () => {
  beforeEach(() => {
    useConversationsStore.getState().reset();
  });

  it("maps `network` from the API and defaults to 'allo' when absent", async () => {
    apiGet.mockResolvedValueOnce({
      data: {
        conversations: [
          {
            _id: "native1",
            type: "direct",
            participants: [{ userId: "userB", name: { first: "Bob" } }],
          },
          {
            _id: "tg1",
            type: "direct",
            network: "telegram",
            participants: [{ userId: OWN_USER, name: { first: "Me" } }],
            externalParticipants: [
              { network: "telegram", externalId: "tg:42", displayName: "Telegram Tom" },
            ],
          },
        ],
      },
    });

    await useConversationsStore.getState().fetchConversations();

    const byId = useConversationsStore.getState().conversationsById;
    expect(byId.native1.network).toBe("allo");
    expect(byId.native1.externalParticipants).toBeUndefined();
    expect(byId.tg1.network).toBe("telegram");
    expect(byId.tg1.externalParticipants).toEqual([
      { network: "telegram", externalId: "tg:42", displayName: "Telegram Tom", username: undefined, avatar: undefined },
    ]);
  });

  it("derives a bridged DIRECT conversation's name/avatar from externalParticipants[0]", async () => {
    apiGet.mockResolvedValueOnce({
      data: {
        conversations: [
          {
            _id: "tg2",
            type: "direct",
            name: "Direct Chat",
            network: "telegram",
            participants: [{ userId: OWN_USER, name: { first: "Me" } }],
            externalParticipants: [
              {
                network: "telegram",
                externalId: "tg:99",
                displayName: "Alice External",
                avatar: "https://x/avatar.png",
              },
            ],
          },
        ],
      },
    });

    await useConversationsStore.getState().fetchConversations();

    const conv = useConversationsStore.getState().conversationsById.tg2;
    expect(conv.name).toBe("Alice External");
    expect(conv.avatar).toBe("https://x/avatar.png");
  });

  it("drops external participants with an invalid network / missing external id", () => {
    const mapped = mapApiConversation({
      _id: "tg3",
      type: "direct",
      network: "telegram",
      externalParticipants: [
        { network: "telegram", externalId: "tg:1", displayName: "Valid" },
        { network: "not-a-network", externalId: "x" },
        { network: "telegram", externalId: "" },
      ],
    });
    expect(mapped.externalParticipants).toHaveLength(1);
    expect(mapped.externalParticipants?.[0].externalId).toBe("tg:1");
  });

  it("mapApiConversation falls back to 'allo' for an unknown/absent network", () => {
    expect(mapApiConversation({ _id: "x", type: "direct" }).network).toBe("allo");
    expect(
      mapApiConversation({ _id: "y", type: "direct", network: "bogus" }).network
    ).toBe("allo");
  });
});

describe("messagesStore — bridged branch (plaintext, no encryption)", () => {
  beforeEach(() => {
    useMessagesStore.getState().reset();
    useConversationsStore.getState().reset();
  });

  function seedBridgedConversation(conversationId: string): void {
    useConversationsStore.setState({
      conversationsById: {
        [conversationId]: makeConversation({
          id: conversationId,
          type: "direct",
          network: "telegram",
          externalParticipants: [{ network: "telegram", externalId: "tg:55" }],
        }),
      },
    });
  }

  it("sends a bridged text message as PLAINTEXT — no encryption, no envelopes, no P2P", async () => {
    seedBridgedConversation("tgconv");
    apiPost.mockResolvedValue({ data: { data: { _id: "srv-1" } } });

    const result = await useMessagesStore
      .getState()
      .sendMessage("tgconv", "hola telegram", OWN_USER, "", 16);

    expect(result).not.toBeNull();

    // Exactly one POST /messages, plaintext shape.
    const messagePosts = apiPost.mock.calls.filter((c) => c[0] === "/messages");
    expect(messagePosts).toHaveLength(1);
    const body = messagePosts[0][1] as Record<string, unknown>;
    expect(body.text).toBe("hola telegram");
    expect(body.messageType).toBe("text");
    expect(body.conversationId).toBe("tgconv");
    expect(body.senderDeviceId).toBe(OWN_DEVICE);
    // No encryption metadata whatsoever.
    expect(body.encryptionVersion).toBeUndefined();
    expect(body.envelopes).toBeUndefined();
    expect(body.ciphertext).toBeUndefined();

    // Crypto + P2P were never touched.
    expect(mockEncryptForPeer).not.toHaveBeenCalled();
    expect(mockP2PSend).not.toHaveBeenCalled();
    // No device-list / prekey fetches were made for the bridged send.
    expect(apiPost.mock.calls.some((c) => c[0] === "/devices/prekeys/batch")).toBe(false);
    expect(apiGet).not.toHaveBeenCalled();
  });

  it("optimistically stores the bridged message as plaintext and marks it sent", async () => {
    seedBridgedConversation("tgconv2");
    apiPost.mockResolvedValue({ data: { data: { _id: "srv-2" } } });

    await useMessagesStore.getState().sendMessage("tgconv2", "hi", OWN_USER, "");

    const messages = useMessagesStore.getState().messagesByConversation.tgconv2;
    expect(messages).toHaveLength(1);
    expect(messages[0].text).toBe("hi");
    expect(messages[0].isEncrypted).toBe(false);
    expect(messages[0].encryptionVersion).toBeUndefined();
    expect(messages[0].readStatus).toBe("sent");
  });

  it("sends a bridged attachment as plaintext metadata — no envelopes", async () => {
    seedBridgedConversation("tgconv3");
    apiPost.mockResolvedValue({ data: { data: { _id: "srv-3" } } });

    const result = await useMessagesStore.getState().sendBridgedAttachmentMessage(
      "tgconv3",
      { attachmentType: "location", location: { latitude: 1, longitude: 2 } },
      OWN_USER
    );

    expect(result).not.toBeNull();
    const body = apiPost.mock.calls.find((c) => c[0] === "/messages")?.[1] as Record<string, unknown>;
    expect(body.attachmentType).toBe("location");
    expect(body.location).toEqual({ latitude: 1, longitude: 2 });
    expect(body.messageType).toBe("location");
    expect(body.senderDeviceId).toBe(OWN_DEVICE);
    expect(body.envelopes).toBeUndefined();
    expect(body.encryptionVersion).toBeUndefined();
    expect(mockEncryptForPeer).not.toHaveBeenCalled();
  });

  it("a NATIVE conversation does NOT take the bridged branch (still encrypts)", async () => {
    // Native group conversation: the encrypted path resolves participant devices.
    useConversationsStore.setState({
      conversationsById: {
        nativeConv: makeConversation({
          id: "nativeConv",
          type: "group",
          network: "allo",
          participants: [{ id: OWN_USER }, { id: "userB" }],
        }),
      },
    });
    // Recipient has a device, so the encrypted path is taken and hits device APIs.
    apiGet.mockImplementation(async (endpoint: string) => {
      if (endpoint === `/devices/user/${OWN_USER}`) {
        return { data: { data: { devices: [{ deviceId: OWN_DEVICE }], inactiveDevices: [] } } };
      }
      if (endpoint === "/devices/user/userB") {
        return { data: { data: { devices: [{ deviceId: 2000 }], inactiveDevices: [] } } };
      }
      throw new Error(`unexpected GET ${endpoint}`);
    });

    await useMessagesStore.getState().sendMessage("nativeConv", "secret", OWN_USER, "userB");

    // The native path consulted the device list (proof it did NOT take the
    // bridged plaintext short-circuit).
    expect(apiGet).toHaveBeenCalledWith(`/devices/user/${OWN_USER}`);
  });
});

describe("AttachmentMenu — capability gating logic", () => {
  // The menu hides any option whose `requiresCapability` is unsupported. We test
  // the same predicate the component applies, so the gating contract is locked.
  const OPTIONS: { id: string; requiresCapability?: keyof typeof NETWORK_CAPABILITIES.allo }[] = [
    { id: "photo" },
    { id: "gif", requiresCapability: "gifs" },
    { id: "document" },
    { id: "location", requiresCapability: "location" },
    { id: "camera" },
    { id: "contact" },
    { id: "poll", requiresCapability: "polls" },
  ];

  function visibleIds(caps: typeof NETWORK_CAPABILITIES.allo | undefined): string[] {
    if (!caps) return OPTIONS.map((o) => o.id);
    return OPTIONS.filter((o) => !o.requiresCapability || caps[o.requiresCapability]).map(
      (o) => o.id
    );
  }

  it("shows every entry for native Allo (all capabilities true)", () => {
    expect(visibleIds(NETWORK_CAPABILITIES.allo)).toEqual([
      "photo",
      "gif",
      "document",
      "location",
      "camera",
      "contact",
      "poll",
    ]);
  });

  it("hides polls for Telegram but keeps GIFs and location", () => {
    const visible = visibleIds(NETWORK_CAPABILITIES.telegram);
    expect(visible).not.toContain("poll");
    expect(visible).toContain("gif");
    expect(visible).toContain("location");
    expect(visible).toContain("photo");
    expect(visible).toContain("document");
  });

  it("shows every entry when no capabilities are provided (native default)", () => {
    expect(visibleIds(undefined)).toHaveLength(OPTIONS.length);
  });
});

describe("bridge link API — canonical BridgeLinkStepResult contract", () => {
  beforeEach(() => {
    apiPost.mockResolvedValue({ data: { data: { v: 1, status: "pending" } } });
    apiGet.mockResolvedValue({ data: { data: { status: "active" } } });
  });

  it("startLink (QR) sends NO body", async () => {
    await startLink("telegram");
    const call = apiPost.mock.calls.find((c) => c[0] === "/bridge/accounts/telegram/link");
    expect(call).toBeDefined();
    // QR flow: second arg (body) is undefined.
    expect(call?.[1]).toBeUndefined();
  });

  it("startLink (phone) sends { phoneNumber } in the body verbatim", async () => {
    await startLink("telegram", "+34600123456");
    const call = apiPost.mock.calls.find((c) => c[0] === "/bridge/accounts/telegram/link");
    expect(call?.[1]).toEqual({ phoneNumber: "+34600123456" });
  });

  it("submitLinkCode / submitLinkPassword POST to the right paths with the canonical body", async () => {
    await submitLinkCode("telegram", "12345");
    await submitLinkPassword("telegram", "s3cret");
    expect(apiPost).toHaveBeenCalledWith("/bridge/accounts/telegram/link/code", { code: "12345" });
    expect(apiPost).toHaveBeenCalledWith("/bridge/accounts/telegram/link/password", {
      password: "s3cret",
    });
  });

  it("returns the canonical { v, status, loginUrl } result and reads `loginUrl` (not qrUrl)", async () => {
    apiPost.mockResolvedValueOnce({
      data: { data: { v: 1, status: "pending", loginUrl: "tg://login?token=abc" } },
    });
    const result = await startLink("telegram");
    expect(result.status).toBe("pending");
    expect(result.loginUrl).toBe("tg://login?token=abc");
  });

  it("falls back to an error step when the connector returns an empty body", async () => {
    apiPost.mockResolvedValueOnce({ data: { data: null } });
    const result = await startLink("telegram");
    expect(result).toEqual({ v: 1, status: "error" });
  });

  it("getLinkStatus reads the persisted LinkedAccountStatus, 404 → null (no throw)", async () => {
    apiGet.mockResolvedValueOnce({ data: { data: { status: "active" } } });
    await expect(getLinkStatus("telegram")).resolves.toBe("active");

    apiGet.mockRejectedValueOnce({ response: { status: 404 } });
    await expect(getLinkStatus("telegram")).resolves.toBeNull();
  });
});

describe("bridge link flow — status→step mapping (canonical enum)", () => {
  it("maps needs_code → phone_code", () => {
    expect(nextStepFromResult("phone", { v: 1, status: "needs_code" })).toBe("phone_code");
  });

  it("maps needs_password → phone_password", () => {
    expect(nextStepFromResult("phone", { v: 1, status: "needs_password" })).toBe("phone_password");
  });

  it("maps active → completed", () => {
    expect(nextStepFromResult("qr", { v: 1, status: "active" })).toBe("completed");
    expect(nextStepFromResult("phone", { v: 1, status: "active" })).toBe("completed");
  });

  it("maps pending → qr_pending on the QR path", () => {
    expect(nextStepFromResult("qr", { v: 1, status: "pending" })).toBe("qr_pending");
  });

  it("maps error → qr_failed on the QR path (retryable)", () => {
    expect(nextStepFromResult("qr", { v: 1, status: "error" })).toBe("qr_failed");
  });
});

describe("bridge link flow — QR status polling stops on terminal states", () => {
  it("keeps polling on non-terminal statuses under the cap", () => {
    expect(shouldContinuePolling("pending_login", 0)).toBe(true);
    expect(shouldContinuePolling(null, 5)).toBe(true);
  });

  it("stops on success (active)", () => {
    expect(shouldContinuePolling("active", 0)).toBe(false);
  });

  it("stops on every terminal failure status", () => {
    expect(shouldContinuePolling("expired", 0)).toBe(false);
    expect(shouldContinuePolling("revoked", 0)).toBe(false);
    expect(shouldContinuePolling("error", 0)).toBe(false);
  });

  it("stops once the max-attempts cap is reached", () => {
    expect(shouldContinuePolling("pending_login", MAX_STATUS_POLLS - 1)).toBe(true);
    expect(shouldContinuePolling("pending_login", MAX_STATUS_POLLS)).toBe(false);
    expect(shouldContinuePolling(null, MAX_STATUS_POLLS + 1)).toBe(false);
  });
});
