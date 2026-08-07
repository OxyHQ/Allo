import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SearchProfilesResponse, User } from "@oxyhq/core";

import { createDirectoryRoutes } from "../../routes/directory";
import {
  createOxyDirectoryService,
  toDirectoryUser,
  type OxyDirectoryClient,
} from "../../services/oxy/OxyDirectoryService";

/**
 * `GET /api/directory/*` — the five Oxy lookups, moved behind this backend.
 *
 * The Oxy SDK is replaced by a fake that satisfies {@link OxyDirectoryClient}
 * structurally, so these tests cover what this router is responsible for: what
 * it lets in, what it lets OUT, and what it does with an upstream that says no.
 * They deliberately do not cover whether Oxy answers correctly, which is not
 * this codebase's claim to make.
 */

const OXY_USER_ID = "507f1f77bcf86cd799439011";
const OTHER_USER_ID = "507f191e810c19729de860ea";
const AVATAR_ID = "65f0c1a2b3c4d5e6f7a8b9c0";
const CLOUD_ORIGIN = "https://cloud.oxy.so";

/**
 * An Oxy user as the API really returns one — contact details included.
 *
 * They are here so that the projection test has something real to fail on. An
 * Oxy `User` carries `email`, `phone`, `address` and `birthday`, and this
 * backend asks Oxy AS ITSELF, so anything it forwards it forwards to every
 * signed-in user.
 */
function oxyUser(overrides: Partial<User> = {}): User {
  return {
    id: OXY_USER_ID,
    publicKey: "a-public-key",
    username: "nate",
    email: "nate@example.com",
    phone: "+34600000000",
    address: "1 Somewhere Street",
    birthday: "1990-01-01",
    avatar: AVATAR_ID,
    bio: "encrypted messaging",
    name: { displayName: "Nate Isern", first: "Nate", last: "Isern" },
    ...overrides,
  } as User;
}

interface FakeClient extends OxyDirectoryClient {
  readonly calls: string[];
}

let failure: unknown;
let searchResult: SearchProfilesResponse;
let byIdsResult: User[];

function fakeClient(): FakeClient {
  const calls: string[] = [];
  const refuseIfAsked = (): void => {
    if (failure !== undefined) throw failure;
  };

  return {
    calls,
    getProfileByUsername: vi.fn(async (username: string) => {
      calls.push(`getProfileByUsername:${username}`);
      refuseIfAsked();
      return oxyUser({ username });
    }),
    getUserById: vi.fn(async (userId: string) => {
      calls.push(`getUserById:${userId}`);
      refuseIfAsked();
      return oxyUser({ id: userId });
    }),
    getUsersByIds: vi.fn(async (ids: string[]) => {
      calls.push(`getUsersByIds:${ids.join(",")}`);
      refuseIfAsked();
      return byIdsResult;
    }),
    searchProfiles: vi.fn(async (query: string, pagination?: { limit?: number; offset?: number }) => {
      calls.push(`searchProfiles:${query}:${pagination?.limit}:${pagination?.offset}`);
      refuseIfAsked();
      return searchResult;
    }),
    getFileDownloadUrl: (fileId: string, variant?: string) =>
      `${CLOUD_ORIGIN}/${fileId}${variant === undefined ? "" : `?variant=${variant}`}`,
  };
}

let client: FakeClient;

function directoryApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use("/api/directory", createDirectoryRoutes({ service: createOxyDirectoryService(client) }));
  return app;
}

beforeEach(() => {
  failure = undefined;
  client = fakeClient();
  byIdsResult = [oxyUser(), oxyUser({ id: OTHER_USER_ID, username: "lady" })];
  searchResult = {
    data: [oxyUser()],
    pagination: { total: 1, limit: 20, offset: 0, hasMore: false },
  };
});

describe("what leaves the directory", () => {
  it("never forwards an email, a phone, an address or a birthday", async () => {
    /**
     * The single most important assertion in this file. Every underlying Oxy
     * route is public, so this backend cannot claim the API filtered anything
     * for it — the projection is the whole of the protection.
     */
    const response = await request(directoryApp()).get(
      `/api/directory/profiles/username/nate`,
    );

    expect(response.status).toBe(200);
    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain("nate@example.com");
    expect(serialized).not.toContain("+34600000000");
    expect(serialized).not.toContain("Somewhere Street");
    expect(serialized).not.toContain("1990-01-01");
  });

  it("emits exactly the fields the directory contract names", async () => {
    const response = await request(directoryApp()).get("/api/directory/profiles/username/nate");

    expect(Object.keys(response.body.data).sort()).toEqual([
      "avatar",
      "avatarUrl",
      "bio",
      "displayName",
      "firstName",
      "id",
      "lastName",
      "username",
    ]);
  });

  it("resolves the avatar id into a CDN url so the app does not have to", async () => {
    const response = await request(directoryApp()).get("/api/directory/profiles/username/nate");

    expect(response.body.data.avatar).toBe(AVATAR_ID);
    expect(response.body.data.avatarUrl).toBe(`${CLOUD_ORIGIN}/${AVATAR_ID}?variant=thumb`);
  });

  it("omits both avatar fields for an account with no avatar", async () => {
    const projected = toDirectoryUser(oxyUser({ avatar: null }), client);

    expect(projected).not.toHaveProperty("avatar");
    expect(projected).not.toHaveProperty("avatarUrl");
  });

  it("falls back to the handle when Oxy resolves no display name", async () => {
    const projected = toDirectoryUser(
      oxyUser({ name: { displayName: "", first: "", last: "" } }),
      client,
    );

    expect(projected.displayName).toBe("nate");
  });

  it("does not recompose a display name from the parts", async () => {
    /**
     * `utils/oxyUserDisplay.ts` settled this for the conversation participants:
     * the canonical string is Oxy's, and a second answer here would name the
     * same person differently on the two screens they appear on.
     */
    const projected = toDirectoryUser(
      oxyUser({ username: "", name: { displayName: "", first: "Nate", last: "Isern" } }),
      client,
    );

    expect(projected.displayName).toBe("Unknown");
  });
});

describe("a profile by handle", () => {
  it("answers with the account", async () => {
    const response = await request(directoryApp()).get("/api/directory/profiles/username/nate");

    expect(response.status).toBe(200);
    expect(response.body.data.username).toBe("nate");
  });

  it("refuses a handle carrying the sigil", async () => {
    const response = await request(directoryApp()).get("/api/directory/profiles/username/@nate");

    expect(response.status).toBe(400);
    expect(client.calls).toEqual([]);
  });

  it("refuses a handle longer than any Oxy handle", async () => {
    const response = await request(directoryApp()).get(
      `/api/directory/profiles/username/${"a".repeat(65)}`,
    );

    expect(response.status).toBe(400);
    expect(client.calls).toEqual([]);
  });

  it("answers 404 when Oxy says there is no such account", async () => {
    failure = { status: 404, message: "not found" };

    const response = await request(directoryApp()).get("/api/directory/profiles/username/nobody");

    expect(response.status).toBe(404);
  });

  it("answers 502 rather than 500 when Oxy fails", async () => {
    /**
     * The request was fine and this codebase is not at fault; a 500 would send
     * whoever is on call looking here.
     */
    failure = new Error("upstream exploded");

    const response = await request(directoryApp()).get("/api/directory/profiles/username/nate");

    expect(response.status).toBe(502);
  });
});

describe("an account by id", () => {
  it("answers with the account", async () => {
    const response = await request(directoryApp()).get(`/api/directory/users/${OXY_USER_ID}`);

    expect(response.status).toBe(200);
    expect(response.body.data.id).toBe(OXY_USER_ID);
  });

  it("refuses anything that is not an Oxy account id", async () => {
    /**
     * Oxy's own route also accepts a public key, which Allo has never had. The
     * shape is checked with `isOxyUserId` — the SAME function the Matrix
     * authentication boundary uses — so the two cannot come to different
     * conclusions about the same string.
     */
    for (const candidate of ["nate", "oxy_dk_abcdef", OXY_USER_ID.toUpperCase(), "507f1f77"]) {
      const response = await request(directoryApp()).get(`/api/directory/users/${candidate}`);
      expect(response.status).toBe(400);
    }
    expect(client.calls).toEqual([]);
  });
});

describe("several accounts at once", () => {
  it("answers with each account it could resolve", async () => {
    const response = await request(directoryApp())
      .post("/api/directory/users/by-ids")
      .send({ ids: [OXY_USER_ID, OTHER_USER_ID] });

    expect(response.status).toBe(200);
    expect(response.body.data.users.map((user: { id: string }) => user.id)).toEqual([
      OXY_USER_ID,
      OTHER_USER_ID,
    ]);
  });

  it("answers with fewer than asked for rather than padding the gaps", async () => {
    byIdsResult = [oxyUser()];

    const response = await request(directoryApp())
      .post("/api/directory/users/by-ids")
      .send({ ids: [OXY_USER_ID, OTHER_USER_ID] });

    expect(response.status).toBe(200);
    expect(response.body.data.users).toHaveLength(1);
  });

  it("is not shadowed by the by-id route", async () => {
    /**
     * `/users/by-ids` and `/users/:userId` share a prefix, and declaring them
     * the other way round would capture `by-ids` as an id. It would be refused
     * as a malformed id rather than mis-served, but the 400 would name the
     * wrong problem.
     */
    const response = await request(directoryApp())
      .post("/api/directory/users/by-ids")
      .send({ ids: [OXY_USER_ID] });

    expect(response.status).toBe(200);
  });

  it("refuses an empty list", async () => {
    const response = await request(directoryApp())
      .post("/api/directory/users/by-ids")
      .send({ ids: [] });

    expect(response.status).toBe(400);
    expect(client.calls).toEqual([]);
  });

  it("refuses more ids than one upstream call can carry", async () => {
    const ids = Array.from({ length: 101 }, () => OXY_USER_ID);

    const response = await request(directoryApp())
      .post("/api/directory/users/by-ids")
      .send({ ids });

    expect(response.status).toBe(400);
    expect(client.calls).toEqual([]);
  });

  it("refuses the whole request when one id is malformed", async () => {
    const response = await request(directoryApp())
      .post("/api/directory/users/by-ids")
      .send({ ids: [OXY_USER_ID, "nate"] });

    expect(response.status).toBe(400);
    expect(client.calls).toEqual([]);
  });

  it("refuses a body that is not a list of ids", async () => {
    for (const body of [{}, { ids: "not-a-list" }, { ids: [{ $ne: null }] }]) {
      const response = await request(directoryApp())
        .post("/api/directory/users/by-ids")
        .send(body);
      expect(response.status).toBe(400);
    }
    expect(client.calls).toEqual([]);
  });
});

describe("searching for people", () => {
  it("answers with the page and how much more there is", async () => {
    searchResult = {
      data: [oxyUser()],
      pagination: { total: 42, limit: 20, offset: 0, hasMore: true },
    };

    const response = await request(directoryApp()).get(
      "/api/directory/profiles/search?query=nate",
    );

    expect(response.status).toBe(200);
    expect(response.body.data.total).toBe(42);
    expect(response.body.data.hasMore).toBe(true);
    expect(response.body.data.users).toHaveLength(1);
  });

  it("defaults the page size rather than letting the caller omit it upstream", async () => {
    await request(directoryApp()).get("/api/directory/profiles/search?query=nate");

    expect(client.calls).toEqual(["searchProfiles:nate:20:0"]);
  });

  it("refuses an empty query", async () => {
    const response = await request(directoryApp()).get("/api/directory/profiles/search?query=");

    expect(response.status).toBe(400);
    expect(client.calls).toEqual([]);
  });

  it("refuses a missing query", async () => {
    const response = await request(directoryApp()).get("/api/directory/profiles/search");

    expect(response.status).toBe(400);
  });

  it("refuses a page larger than the ceiling", async () => {
    const response = await request(directoryApp()).get(
      "/api/directory/profiles/search?query=nate&limit=5000",
    );

    expect(response.status).toBe(400);
    expect(client.calls).toEqual([]);
  });

  it("refuses a negative offset", async () => {
    const response = await request(directoryApp()).get(
      "/api/directory/profiles/search?query=nate&offset=-1",
    );

    expect(response.status).toBe(400);
  });
});

describe("an avatar's address", () => {
  it("answers with the CDN url for an asset id", async () => {
    const response = await request(directoryApp()).get(
      `/api/directory/assets/${AVATAR_ID}/url`,
    );

    expect(response.status).toBe(200);
    expect(response.body.data.url).toBe(`${CLOUD_ORIGIN}/${AVATAR_ID}?variant=thumb`);
  });

  it("honours a requested variant", async () => {
    const response = await request(directoryApp()).get(
      `/api/directory/assets/${AVATAR_ID}/url?variant=full`,
    );

    expect(response.body.data.url).toBe(`${CLOUD_ORIGIN}/${AVATAR_ID}?variant=full`);
  });

  it("refuses an asset id containing path characters", async () => {
    /**
     * Not because a traversal would work — the SDK percent-encodes the id — but
     * because an endpoint that mints a URL for any string a caller invents is
     * a URL generator wearing Allo's name.
     */
    const response = await request(directoryApp()).get(
      "/api/directory/assets/..%2F..%2Fetc%2Fpasswd/url",
    );

    expect(response.status).toBe(400);
  });

  it("refuses an absolute URL where an asset id belongs", async () => {
    const response = await request(directoryApp()).get(
      `/api/directory/assets/${encodeURIComponent("https://evil.example/x")}/url`,
    );

    expect(response.status).toBe(400);
  });

  it("refuses a variant that is not a variant name", async () => {
    const response = await request(directoryApp()).get(
      `/api/directory/assets/${AVATAR_ID}/url?variant=${encodeURIComponent("../../secret")}`,
    );

    expect(response.status).toBe(400);
  });
});
