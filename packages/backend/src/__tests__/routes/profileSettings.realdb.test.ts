/**
 * `/api/profile/*` end to end, against a REAL Postgres server.
 *
 * The risk this port carries is not that a query is wrong — `db/social.realdb`
 * already proves the repositories against a real server. It is that the SHAPE on
 * the wire changed. `user_settings` is stored flat and has always been served
 * nested, so the projection is new code sitting between a client and its data,
 * and a field it forgets is invisible: the request still returns 200, the JSON
 * still parses, and a setting silently reads as its default forever.
 *
 * So these cases assert the emitted document field by field, and drive the real
 * router rather than the projection function — the projection being right is
 * worth nothing if a handler does not call it.
 *
 * The one thing deliberately NOT asserted is `_id`. Mongo emitted one; nothing
 * in this repository reads it (`stores/appearanceStore.ts`, `lib/privacy/api.ts`
 * and `lib/security/cloudSync.ts` all key on `oxyUserId`), so the port emits the
 * row's real `id` and does not invent an alias.
 */

import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { connectPostgres, closePostgres, getDb } from "../../db";
import * as schema from "../../db/schema";
import { setUpTestDatabase, type TestDatabaseHandle } from "../../db/testDatabase";
import profileSettingsRouter from "../../routes/profileSettings";

const USER = "oxy-user-settings-owner";

let handle: TestDatabaseHandle;

/** An app assembled the way `server.ts` assembles it, minus Oxy. */
function appWithAuth(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const userId = req.get("x-test-user") ?? USER;
    Reflect.set(req, "userId", userId);
    Reflect.set(req, "user", { id: userId });
    next();
  });
  app.use("/api/profile", profileSettingsRouter);
  return app;
}

/** Unique per call so cases cannot collide inside the one shared database. */
let counter = 0;
function id(prefix: string): string {
  counter += 1;
  return `${prefix}-${String(counter).padStart(4, "0")}`;
}

beforeAll(async () => {
  handle = await setUpTestDatabase();
  connectPostgres(handle.databaseUrl);
}, 180_000);

afterAll(async () => {
  await closePostgres();
  await handle?.drop();
});

describe("GET /api/profile/settings/me", () => {
  it("creates a row of pure defaults and serves it in the nested shape clients read", async () => {
    const user = id("fresh-user");
    const response = await request(appWithAuth())
      .get("/api/profile/settings/me")
      .set("x-test-user", user);

    expect(response.status).toBe(200);
    const doc = response.body.data;

    // Every group, named individually. A `toMatchObject` on one of them would
    // pass while the other three were missing entirely, which is the failure
    // this file exists to catch.
    expect(doc.oxyUserId).toBe(user);
    expect(typeof doc.id).toBe("string");
    expect(doc.appearance).toEqual({ themeMode: "system" });
    expect(doc.privacy).toEqual({
      profileVisibility: "public",
      showContactInfo: true,
      allowTags: true,
      allowallos: true,
      showOnlineStatus: true,
      hideLikeCounts: false,
      hideShareCounts: false,
      hideReplyCounts: false,
      hideSaveCounts: false,
      hiddenWords: [],
      restrictedUsers: [],
    });
    expect(doc.profileCustomization).toEqual({
      coverPhotoEnabled: true,
      minimalistMode: false,
    });
    // Device-first, and the asymmetry is the product decision: cloud sync is
    // opt-IN while encryption and P2P are opt-OUT. A projection that read the
    // wrong column would most likely show all three the same way.
    expect(doc.security).toEqual({
      cloudSyncEnabled: false,
      encryptionEnabled: true,
      peerToPeerEnabled: true,
    });
    expect(typeof doc.createdAt).toBe("string");
    expect(typeof doc.updatedAt).toBe("string");
  });

  it("omits an unset optional rather than emitting null", async () => {
    const user = id("omitting-user");
    const response = await request(appWithAuth())
      .get("/api/profile/settings/me")
      .set("x-test-user", user);

    // `toEqual` treats an absent key and an explicit `undefined` alike, so the
    // assertion has to be about the KEY. It matters: the settings screen spreads
    // `profileCustomization` straight back into its next PUT, where an explicit
    // `null` means "clear this" and an absent key means "leave it alone".
    expect(Object.keys(response.body.data)).not.toContain("profileHeaderImage");
    expect(Object.keys(response.body.data.appearance)).not.toContain("primaryColor");
    expect(Object.keys(response.body.data.profileCustomization)).not.toContain("coverImage");
  });

  it("is idempotent — a second read does not create a second row", async () => {
    const user = id("repeat-user");
    const app = appWithAuth();

    const first = await request(app).get("/api/profile/settings/me").set("x-test-user", user);
    const second = await request(app).get("/api/profile/settings/me").set("x-test-user", user);

    expect(second.body.data.id).toBe(first.body.data.id);
    const rows = await getDb()
      .select()
      .from(schema.userSettings)
      .where(eq(schema.userSettings.oxyUserId, user));
    expect(rows).toHaveLength(1);
  });
});

describe("PUT /api/profile/settings", () => {
  it("patches only the columns named, across all four groups", async () => {
    const user = id("patch-user");
    const app = appWithAuth();

    const response = await request(app)
      .put("/api/profile/settings")
      .set("x-test-user", user)
      .send({
        appearance: { themeMode: "dark", primaryColor: "  #ff0000  " },
        profileHeaderImage: "file-header-1",
        profileCustomization: { minimalistMode: true, displayName: "Ada" },
        privacy: { profileVisibility: "private", hiddenWords: ["spoiler"] },
        security: { cloudSyncEnabled: true },
      });

    expect(response.status).toBe(200);
    const doc = response.body.data;
    expect(doc.appearance).toEqual({ themeMode: "dark", primaryColor: "#ff0000" });
    expect(doc.profileHeaderImage).toBe("file-header-1");
    expect(doc.profileCustomization).toEqual({
      coverPhotoEnabled: true,
      minimalistMode: true,
      displayName: "Ada",
    });
    expect(doc.privacy.profileVisibility).toBe("private");
    expect(doc.privacy.hiddenWords).toEqual(["spoiler"]);
    // Untouched neighbours in a group that WAS written keep their values.
    expect(doc.privacy.showOnlineStatus).toBe(true);
    expect(doc.security).toEqual({
      cloudSyncEnabled: true,
      encryptionEnabled: true,
      peerToPeerEnabled: true,
    });
  });

  /**
   * The one deliberate divergence from Mongo, pinned so it cannot regress by
   * accident in either direction.
   *
   * `$set: { appearance: … }` replaced the whole sub-document, so a request
   * carrying only `primaryColor` reset `themeMode` to its default — and
   * `stores/appearanceStore.ts` sends exactly that, one field at a time. Columns
   * are patched individually now.
   */
  it("leaves themeMode alone when only primaryColor is sent", async () => {
    const user = id("appearance-user");
    const app = appWithAuth();

    await request(app)
      .put("/api/profile/settings")
      .set("x-test-user", user)
      .send({ appearance: { themeMode: "dark" } });

    const response = await request(app)
      .put("/api/profile/settings")
      .set("x-test-user", user)
      .send({ appearance: { primaryColor: "#00ff00" } });

    expect(response.body.data.appearance).toEqual({
      themeMode: "dark",
      primaryColor: "#00ff00",
    });
  });

  it("clears a nullable field on null, and on a string that is blank after trimming", async () => {
    const user = id("clearing-user");
    const app = appWithAuth();

    await request(app)
      .put("/api/profile/settings")
      .set("x-test-user", user)
      .send({ profileCustomization: { displayName: "Ada", coverImage: "file-cover-1" } });

    const cleared = await request(app)
      .put("/api/profile/settings")
      .set("x-test-user", user)
      .send({ profileCustomization: { displayName: null, coverImage: "   " } });

    const keys = Object.keys(cleared.body.data.profileCustomization);
    expect(keys).not.toContain("displayName");
    expect(keys).not.toContain("coverImage");
  });

  it("drops an unrecognised key and a wrongly-typed value instead of failing the save", async () => {
    const user = id("lenient-user");
    const app = appWithAuth();

    const response = await request(app)
      .put("/api/profile/settings")
      .set("x-test-user", user)
      .send({
        privacy: { profileVisibility: "not-a-visibility", showOnlineStatus: "yes" },
        appearance: { themeMode: "neon" },
        somethingFromANewerClient: { enabled: true },
        profileCustomization: { minimalistMode: true },
      });

    expect(response.status).toBe(200);
    // The recognised field still landed — the request was not refused wholesale.
    expect(response.body.data.profileCustomization.minimalistMode).toBe(true);
    // The rest fell back to stored values rather than reaching a CHECK.
    expect(response.body.data.privacy.profileVisibility).toBe("public");
    expect(response.body.data.privacy.showOnlineStatus).toBe(true);
    expect(response.body.data.appearance.themeMode).toBe("system");
  });

  it("answers an unrecognised body with the current settings, as the upsert did", async () => {
    const user = id("empty-patch-user");
    const app = appWithAuth();

    const response = await request(app)
      .put("/api/profile/settings")
      .set("x-test-user", user)
      .send({});

    expect(response.status).toBe(200);
    expect(response.body.data.oxyUserId).toBe(user);
  });
});

describe("blocks and restricts", () => {
  it("tells creating a block from re-asserting one", async () => {
    const user = id("blocker");
    const target = id("blocked");
    const app = appWithAuth();

    const created = await request(app)
      .post("/api/profile/blocks")
      .set("x-test-user", user)
      .send({ blockedId: target });
    expect(created.status).toBe(201);

    // The second call converges on `blocks_user_id_blocked_id_key` instead of
    // raising a duplicate-key error for a `catch` to reinterpret.
    const repeated = await request(app)
      .post("/api/profile/blocks")
      .set("x-test-user", user)
      .send({ blockedId: target });
    expect(repeated.status).toBe(200);
    expect(repeated.body.message).toBe("User already blocked");

    const listed = await request(app).get("/api/profile/blocks").set("x-test-user", user);
    expect(listed.body.data.blockedUsers).toEqual([target]);
  });

  it("404s an unblock with nothing to remove, and 200s the one that removes a row", async () => {
    const user = id("unblocker");
    const target = id("unblocked");
    const app = appWithAuth();

    const missing = await request(app)
      .delete(`/api/profile/blocks/${target}`)
      .set("x-test-user", user);
    expect(missing.status).toBe(404);

    await request(app).post("/api/profile/blocks").set("x-test-user", user).send({ blockedId: target });
    const removed = await request(app)
      .delete(`/api/profile/blocks/${target}`)
      .set("x-test-user", user);
    expect(removed.status).toBe(200);
  });

  it("refuses to block or restrict yourself", async () => {
    const app = appWithAuth();
    const user = id("self");

    const block = await request(app)
      .post("/api/profile/blocks")
      .set("x-test-user", user)
      .send({ blockedId: user });
    expect(block.status).toBe(400);

    const restrict = await request(app)
      .post("/api/profile/restricts")
      .set("x-test-user", user)
      .send({ restrictedId: user });
    expect(restrict.status).toBe(400);
  });

  it("keeps restricts separate from privacy.restrictedUsers", async () => {
    const user = id("restricter");
    const target = id("restricted");
    const app = appWithAuth();

    await request(app)
      .post("/api/profile/restricts")
      .set("x-test-user", user)
      .send({ restrictedId: target });

    const listed = await request(app).get("/api/profile/restricts").set("x-test-user", user);
    expect(listed.body.data.restrictedUsers).toEqual([target]);

    // Two different facts that Mongo also carried side by side. Reconciling them
    // would be a behaviour change, so the settings column stays untouched.
    const settings = await request(app).get("/api/profile/settings/me").set("x-test-user", user);
    expect(settings.body.data.privacy.restrictedUsers).toEqual([]);
  });
});

describe("DELETE /api/profile/settings/behavior", () => {
  it("distinguishes deleting a row from having nothing to delete", async () => {
    const user = id("behaviour-user");
    const app = appWithAuth();

    const nothing = await request(app)
      .delete("/api/profile/settings/behavior")
      .set("x-test-user", user);
    expect(nothing.status).toBe(200);
    expect(nothing.body.message).toBe("No personalization data to reset");

    await getDb().insert(schema.userBehaviors).values({ id: id("behaviour"), oxyUserId: user });

    const reset = await request(app)
      .delete("/api/profile/settings/behavior")
      .set("x-test-user", user);
    expect(reset.body.message).toBe("Personalization data reset successfully");
  });
});
