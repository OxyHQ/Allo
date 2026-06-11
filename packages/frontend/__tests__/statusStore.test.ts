/**
 * Status store unit tests.
 *
 * `stores/statusStore` is pure Zustand + Immer and runs on plain Node; its only
 * dependency is the REST client (`@/utils/api`), which is mocked so these are
 * focused state-transition tests with no network. We exercise:
 *   - fetchFeed (success normalization, loading/refreshing flags, error path)
 *   - createStatus (appends to myStatus)
 *   - markViewed (optimistic viewedByMe flip, best-effort on failure)
 *   - deleteStatus (removes from myStatus and groups, prunes empty groups)
 *   - getViewers (envelope unwrap)
 *   - realtime apply* handlers (created / viewed / deleted, audience-agnostic)
 */

jest.mock("@/utils/api", () => ({
  __esModule: true,
  api: {
    get: jest.fn(),
    post: jest.fn(),
    delete: jest.fn(),
  },
}));

// eslint-disable-next-line import/first
import { useStatusStore, Status, StatusGroup } from "@/stores/statusStore";
// eslint-disable-next-line import/first
import { api } from "@/utils/api";

const mockApi = api as jest.Mocked<typeof api>;

const SELF = "self";
const AUTHOR = "author-1";

function makeStatus(overrides: Partial<Status> = {}): Status {
  return {
    id: overrides.id ?? "s1",
    userId: overrides.userId ?? AUTHOR,
    type: overrides.type ?? "text",
    text: overrides.text ?? "hello",
    audience: overrides.audience ?? { type: "all-contacts", userIds: [] },
    viewers: overrides.viewers ?? [],
    viewedByMe: overrides.viewedByMe,
    createdAt: overrides.createdAt ?? "2026-06-11T10:00:00.000Z",
    expiresAt: overrides.expiresAt ?? "2026-06-12T10:00:00.000Z",
    ...overrides,
  };
}

function makeGroup(userId: string, statuses: Status[]): StatusGroup {
  const last = statuses[statuses.length - 1];
  return {
    userId,
    author: { id: userId, userId },
    statuses,
    lastCreatedAt: last?.createdAt ?? "2026-06-11T10:00:00.000Z",
    hasUnviewed: statuses.some((s) => !s.viewedByMe),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  useStatusStore.getState().reset();
});

describe("statusStore.fetchFeed", () => {
  it("normalizes the wrapped `{ data: { groups, myStatus } }` envelope", async () => {
    const group = makeGroup(AUTHOR, [makeStatus({ id: "g1" })]);
    const mine = makeStatus({ id: "m1", userId: SELF });
    mockApi.get.mockResolvedValueOnce({
      data: { data: { groups: [group], myStatus: [mine] } },
    } as never);

    await useStatusStore.getState().fetchFeed();

    const state = useStatusStore.getState();
    expect(state.groups).toHaveLength(1);
    expect(state.groups[0].userId).toBe(AUTHOR);
    expect(state.myStatus).toHaveLength(1);
    expect(state.myStatus[0].id).toBe("m1");
    expect(state.loading).toBe(false);
    expect(state.refreshing).toBe(false);
    expect(state.hasFetchedOnce).toBe(true);
    expect(state.error).toBeNull();
  });

  it("accepts an already-unwrapped body", async () => {
    mockApi.get.mockResolvedValueOnce({
      data: { groups: [], myStatus: [makeStatus({ id: "m1", userId: SELF })] },
    } as never);

    await useStatusStore.getState().fetchFeed();
    expect(useStatusStore.getState().myStatus).toHaveLength(1);
  });

  it("sets the error and still marks hasFetchedOnce when the request fails", async () => {
    mockApi.get.mockRejectedValueOnce(new Error("network down"));

    await useStatusStore.getState().fetchFeed();

    const state = useStatusStore.getState();
    expect(state.error).toBe("network down");
    expect(state.loading).toBe(false);
    expect(state.hasFetchedOnce).toBe(true);
  });

  it("uses the refreshing flag (not loading) when refresh: true", async () => {
    let resolve!: (v: unknown) => void;
    mockApi.get.mockReturnValueOnce(
      new Promise((r) => {
        resolve = r;
      }) as never
    );

    const promise = useStatusStore.getState().fetchFeed({ refresh: true });
    expect(useStatusStore.getState().refreshing).toBe(true);
    expect(useStatusStore.getState().loading).toBe(false);

    resolve({ data: { data: { groups: [], myStatus: [] } } });
    await promise;
    expect(useStatusStore.getState().refreshing).toBe(false);
  });
});

describe("statusStore.createStatus", () => {
  it("appends the created status to myStatus", async () => {
    const created = makeStatus({ id: "new1", userId: SELF, text: "fresh" });
    mockApi.post.mockResolvedValueOnce({ data: { data: created } } as never);

    const result = await useStatusStore
      .getState()
      .createStatus({ type: "text", text: "fresh" });

    expect(result.id).toBe("new1");
    expect(useStatusStore.getState().myStatus).toHaveLength(1);
    expect(useStatusStore.getState().myStatus[0].text).toBe("fresh");
    expect(mockApi.post).toHaveBeenCalledWith("/status", {
      type: "text",
      text: "fresh",
    });
  });
});

describe("statusStore.markViewed", () => {
  it("optimistically flips viewedByMe and recomputes hasUnviewed", async () => {
    const status = makeStatus({ id: "v1", viewedByMe: false });
    useStatusStore.setState({ groups: [makeGroup(AUTHOR, [status])] });
    mockApi.post.mockResolvedValueOnce({ data: {} } as never);

    await useStatusStore.getState().markViewed("v1");

    const group = useStatusStore.getState().groups[0];
    expect(group.statuses[0].viewedByMe).toBe(true);
    expect(group.hasUnviewed).toBe(false);
    expect(mockApi.post).toHaveBeenCalledWith("/status/v1/view");
  });

  it("does not throw and leaves state untouched when the request fails", async () => {
    const status = makeStatus({ id: "v1", viewedByMe: false });
    useStatusStore.setState({ groups: [makeGroup(AUTHOR, [status])] });
    mockApi.post.mockRejectedValueOnce(new Error("boom"));

    await expect(useStatusStore.getState().markViewed("v1")).resolves.toBeUndefined();
    // The failed call must not optimistically flip the flag.
    expect(useStatusStore.getState().groups[0].statuses[0].viewedByMe).toBe(false);
  });
});

describe("statusStore.deleteStatus", () => {
  it("removes the status from myStatus and prunes an emptied group", async () => {
    useStatusStore.setState({
      myStatus: [makeStatus({ id: "m1", userId: SELF })],
      groups: [makeGroup(AUTHOR, [makeStatus({ id: "g1" })])],
    });
    mockApi.delete.mockResolvedValueOnce({ data: {} } as never);

    await useStatusStore.getState().deleteStatus("m1");
    expect(useStatusStore.getState().myStatus).toHaveLength(0);

    await useStatusStore.getState().deleteStatus("g1");
    expect(useStatusStore.getState().groups).toHaveLength(0);
    expect(mockApi.delete).toHaveBeenCalledWith("/status/g1");
  });

  it("keeps a group with remaining statuses after deleting one", async () => {
    useStatusStore.setState({
      groups: [
        makeGroup(AUTHOR, [
          makeStatus({ id: "g1", createdAt: "2026-06-11T10:00:00.000Z" }),
          makeStatus({ id: "g2", createdAt: "2026-06-11T11:00:00.000Z" }),
        ]),
      ],
    });
    mockApi.delete.mockResolvedValueOnce({ data: {} } as never);

    await useStatusStore.getState().deleteStatus("g1");
    const groups = useStatusStore.getState().groups;
    expect(groups).toHaveLength(1);
    expect(groups[0].statuses).toHaveLength(1);
    expect(groups[0].statuses[0].id).toBe("g2");
  });
});

describe("statusStore.getViewers", () => {
  it("unwraps the viewers envelope", async () => {
    mockApi.get.mockResolvedValueOnce({
      data: { data: { viewers: [{ userId: "u9", viewedAt: "2026-06-11T10:00:00.000Z" }] } },
    } as never);

    const viewers = await useStatusStore.getState().getViewers("s1");
    expect(viewers).toHaveLength(1);
    expect(viewers[0].userId).toBe("u9");
  });

  it("returns an empty array when there are no viewers", async () => {
    mockApi.get.mockResolvedValueOnce({ data: { data: { viewers: [] } } } as never);
    const viewers = await useStatusStore.getState().getViewers("s1");
    expect(viewers).toEqual([]);
  });
});

describe("statusStore realtime handlers", () => {
  it("applyStatusCreated routes the owner's own status into myStatus", () => {
    useStatusStore
      .getState()
      .applyStatusCreated(makeStatus({ id: "own1", userId: SELF }), undefined, SELF);
    expect(useStatusStore.getState().myStatus).toHaveLength(1);
    expect(useStatusStore.getState().groups).toHaveLength(0);
  });

  it("applyStatusCreated creates a new group for another author", () => {
    useStatusStore
      .getState()
      .applyStatusCreated(
        makeStatus({ id: "a1", userId: AUTHOR }),
        { id: AUTHOR, userId: AUTHOR },
        SELF
      );
    const groups = useStatusStore.getState().groups;
    expect(groups).toHaveLength(1);
    expect(groups[0].userId).toBe(AUTHOR);
    expect(groups[0].hasUnviewed).toBe(true);
  });

  it("applyStatusCreated appends to an existing group and dedups by id", () => {
    useStatusStore.setState({
      groups: [makeGroup(AUTHOR, [makeStatus({ id: "a1" })])],
    });
    const apply = useStatusStore.getState().applyStatusCreated;
    apply(makeStatus({ id: "a2", userId: AUTHOR }), undefined, SELF);
    apply(makeStatus({ id: "a2", userId: AUTHOR }), undefined, SELF); // duplicate

    expect(useStatusStore.getState().groups[0].statuses).toHaveLength(2);
  });

  it("applyStatusViewed appends a viewer to the owner's own status", () => {
    useStatusStore.setState({
      myStatus: [makeStatus({ id: "own1", userId: SELF })],
    });
    useStatusStore
      .getState()
      .applyStatusViewed("own1", "viewer-1", "2026-06-11T10:30:00.000Z");

    const viewers = useStatusStore.getState().myStatus[0].viewers;
    expect(viewers).toHaveLength(1);
    expect(viewers[0].userId).toBe("viewer-1");
  });

  it("applyStatusViewed is idempotent for the same viewer", () => {
    useStatusStore.setState({
      myStatus: [makeStatus({ id: "own1", userId: SELF })],
    });
    const apply = useStatusStore.getState().applyStatusViewed;
    apply("own1", "viewer-1", "2026-06-11T10:30:00.000Z");
    apply("own1", "viewer-1", "2026-06-11T10:31:00.000Z");

    expect(useStatusStore.getState().myStatus[0].viewers).toHaveLength(1);
  });

  it("applyStatusDeleted removes the status from groups and prunes empties", () => {
    useStatusStore.setState({
      groups: [makeGroup(AUTHOR, [makeStatus({ id: "a1" })])],
    });
    useStatusStore.getState().applyStatusDeleted("a1", AUTHOR);
    expect(useStatusStore.getState().groups).toHaveLength(0);
  });
});
