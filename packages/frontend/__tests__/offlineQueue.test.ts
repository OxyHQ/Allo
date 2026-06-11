/**
 * Offline queue manager tests: enqueue/dequeue, AsyncStorage persistence and
 * retry behaviour. The HTTP layer and connection store are mocked so the queue
 * logic is exercised in isolation.
 */

const mockPost = jest.fn();
const mockDel = jest.fn();
const mockPut = jest.fn();

jest.mock("@/utils/api", () => ({
  __esModule: true,
  api: {
    post: (...args: unknown[]) => mockPost(...args),
    delete: (...args: unknown[]) => mockDel(...args),
    put: (...args: unknown[]) => mockPut(...args),
  },
}));

const mockConnectionState = {
  isConnected: true,
  status: "online" as "online" | "offline",
};

jest.mock("@/lib/network/connectionStatus", () => ({
  useConnectionStatusStore: {
    getState: () => mockConnectionState,
    subscribe: jest.fn(() => jest.fn()),
  },
}));

jest.mock("@/lib/api/retryLogic", () => ({
  retryWithBackoff: (fn: () => Promise<unknown>) => fn(),
}));

// Imported AFTER mocks so the manager pulls in the mocked dependencies.
import AsyncStorage from "@react-native-async-storage/async-storage";
import { offlineQueueManager } from "@/lib/offlineQueue/queueManager";

const QUEUE_STORAGE_KEY = "@allo/offline_queue";

beforeEach(async () => {
  mockPost.mockReset();
  mockDel.mockReset();
  mockPut.mockReset();
  mockConnectionState.isConnected = true;
  mockConnectionState.status = "online";
  await AsyncStorage.clear();
  await offlineQueueManager.clear();
});

describe("offline queue", () => {
  it("enqueues an operation and persists it to AsyncStorage", async () => {
    mockConnectionState.isConnected = false;
    await offlineQueueManager.add({
      type: "send_message",
      conversationId: "c1",
      data: { text: "hi" },
    });

    const all = offlineQueueManager.getAll();
    expect(all).toHaveLength(1);
    expect(all[0].status).toBe("pending");
    expect(all[0].attempts).toBe(0);

    const stored = await AsyncStorage.getItem(QUEUE_STORAGE_KEY);
    expect(stored).toBeTruthy();
    expect(JSON.parse(stored as string)).toHaveLength(1);
  });

  it("removes an operation by id and persists the empty queue", async () => {
    mockConnectionState.isConnected = false;
    const id = await offlineQueueManager.add({
      type: "delete_message",
      conversationId: "c1",
      data: { messageId: "m1" },
    });
    expect(offlineQueueManager.getAll()).toHaveLength(1);

    await offlineQueueManager.remove(id);
    expect(offlineQueueManager.getAll()).toHaveLength(0);

    const stored = await AsyncStorage.getItem(QUEUE_STORAGE_KEY);
    expect(JSON.parse(stored as string)).toEqual([]);
  });

  it("filters queued operations by conversation", async () => {
    mockConnectionState.isConnected = false;
    await offlineQueueManager.add({
      type: "send_message",
      conversationId: "c1",
      data: {},
    });
    await offlineQueueManager.add({
      type: "send_message",
      conversationId: "c2",
      data: {},
    });

    expect(offlineQueueManager.getByConversation("c1")).toHaveLength(1);
    expect(offlineQueueManager.getByConversation("c2")).toHaveLength(1);
    expect(offlineQueueManager.getByConversation("c3")).toHaveLength(0);
  });

  it("processes and removes operations when online and the request succeeds", async () => {
    mockPost.mockResolvedValue({ data: { ok: true } });

    // Stay offline while adding so the auto-process triggered inside add()
    // doesn't drain the queue before we explicitly invoke processQueue().
    mockConnectionState.isConnected = false;
    await offlineQueueManager.add({
      type: "send_message",
      conversationId: "c1",
      data: { text: "hi" },
    });

    mockConnectionState.isConnected = true;
    await offlineQueueManager.processQueue();

    expect(mockPost).toHaveBeenCalledWith("/messages", { text: "hi" });
    expect(offlineQueueManager.getAll()).toHaveLength(0);
  });

  it("retries and marks an operation failed after MAX_ATTEMPTS", async () => {
    mockPost.mockRejectedValue(new Error("network down"));

    mockConnectionState.isConnected = false;
    const id = await offlineQueueManager.add({
      type: "send_message",
      conversationId: "c1",
      data: { text: "hi" },
    });

    mockConnectionState.isConnected = true;
    // Each processQueue pass increments attempts by 1; run until exhausted.
    for (let i = 0; i < 5; i++) {
      await offlineQueueManager.processQueue();
    }

    const op = offlineQueueManager.getById(id);
    expect(op).toBeDefined();
    expect(op?.attempts).toBe(5);
    expect(op?.status).toBe("failed");
    expect(op?.error).toBe("network down");
  });

  it("does not process while offline", async () => {
    mockConnectionState.isConnected = false;
    mockPost.mockResolvedValue({ data: {} });

    await offlineQueueManager.add({
      type: "send_message",
      conversationId: "c1",
      data: {},
    });
    await offlineQueueManager.processQueue();

    expect(mockPost).not.toHaveBeenCalled();
    expect(offlineQueueManager.getAll()).toHaveLength(1);
  });

  it("routes operation types to the correct API call", async () => {
    mockDel.mockResolvedValue({ data: {} });

    mockConnectionState.isConnected = false;
    await offlineQueueManager.add({
      type: "remove_reaction",
      conversationId: "c1",
      data: { messageId: "m1", emoji: "👍" },
    });

    mockConnectionState.isConnected = true;
    await offlineQueueManager.processQueue();

    expect(mockDel).toHaveBeenCalledWith("/messages/m1/reactions/👍");
  });
});
