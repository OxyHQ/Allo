/**
 * Key package stock: upload, atomic claim, exhaustion, the low-water nudge.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { claimKeyPackagesResponseSchema, uploadKeyPackagesResponseSchema } from "@allo/shared-types";
import * as schema from "../../db/schema";
import { KEY_PACKAGE_LOW_WATER_MARK } from "../../services/platform/keyPackageService";
import { accountId, createPlatformHarness, expectParses, keyPackageUpload, TestInstance, type PlatformHarness } from "./harness";

let h: PlatformHarness;

beforeAll(async () => {
  h = await createPlatformHarness();
}, 180_000);

afterAll(async () => {
  await h?.drop();
});

beforeEach(() => {
  h.realtime.reset();
});

describe("PUT /v1/key-packages", () => {
  it("stores the packages and answers the available count", async () => {
    const me = await TestInstance.register(h.app, accountId());
    const response = await me.signed("put", "/v1/key-packages", { keyPackages: [keyPackageUpload(), keyPackageUpload()] });
    expect(response.status).toBe(200);
    expect(expectParses(uploadKeyPackagesResponseSchema, response.body)).toEqual({ available: 2 });
    const again = await me.signed("put", "/v1/key-packages", { keyPackages: [keyPackageUpload()] });
    expect(again.body).toEqual({ available: 3 });
  });

  it("tolerates a retry of its own refs and refuses a ref held by another instance", async () => {
    const me = await TestInstance.register(h.app, accountId());
    const other = await TestInstance.register(h.app, accountId());
    const upload = keyPackageUpload();
    await me.signed("put", "/v1/key-packages", { keyPackages: [upload] }).expect(200);
    const retry = await me.signed("put", "/v1/key-packages", { keyPackages: [upload] });
    expect(retry.status).toBe(200);
    expect(retry.body.available).toBe(1);

    const stolen = await other.signed("put", "/v1/key-packages", { keyPackages: [upload] });
    expect(stolen.status).toBe(409);
    expect(stolen.body.error.code).toBe("idempotency_conflict");
  });

  it("validates the bounds", async () => {
    const me = await TestInstance.register(h.app, accountId());
    const empty = await me.signed("put", "/v1/key-packages", { keyPackages: [] });
    expect(empty.status).toBe(400);
    const bad = await me.signed("put", "/v1/key-packages", { keyPackages: [{ ...keyPackageUpload(), ciphersuite: 0 }] });
    expect(bad.status).toBe(400);
  });
});

describe("POST /v1/key-packages/claim", () => {
  it("consumes exactly one package per instance, reports exhaustion in `missing`, and never hands one out twice", async () => {
    const claimer = await TestInstance.register(h.app, accountId());
    const target = await TestInstance.register(h.app, accountId());
    const empty = await TestInstance.register(h.app, accountId());
    await target.stockKeyPackages(2);

    const first = await claimer.signed("post", "/v1/key-packages/claim", { instanceIds: [target.id, empty.id] });
    expect(first.status).toBe(200);
    const parsed = expectParses(claimKeyPackagesResponseSchema, first.body);
    expect(parsed.keyPackages.map((k) => k.instanceId)).toEqual([target.id]);
    expect(parsed.missing).toEqual([empty.id]);

    const second = await claimer.signed("post", "/v1/key-packages/claim", { instanceIds: [target.id] });
    expect(second.body.keyPackages[0].ref).not.toBe(parsed.keyPackages[0].ref);

    const third = await claimer.signed("post", "/v1/key-packages/claim", { instanceIds: [target.id] });
    expect(third.body).toEqual({ keyPackages: [], missing: [target.id] });

    const consumed = await h.db
      .select()
      .from(schema.keyPackages)
      .where(eq(schema.keyPackages.instanceId, target.id));
    expect(consumed.every((row) => row.consumedAt !== null && row.consumedByInstanceId === claimer.id)).toBe(true);
  });

  it("nudges the instance whose stock fell below the low-water mark, and only then", async () => {
    const claimer = await TestInstance.register(h.app, accountId());
    const rich = await TestInstance.register(h.app, accountId());
    await rich.stockKeyPackages(KEY_PACKAGE_LOW_WATER_MARK + 1);

    await claimer.signed("post", "/v1/key-packages/claim", { instanceIds: [rich.id] }).expect(200);
    expect(h.realtime.low).toEqual([]);

    await claimer.signed("post", "/v1/key-packages/claim", { instanceIds: [rich.id] }).expect(200);
    expect(h.realtime.low).toEqual([{ instanceId: rich.id, available: KEY_PACKAGE_LOW_WATER_MARK - 1 }]);
  });

  it("does not hand out a revoked or pending instance's packages", async () => {
    const claimer = await TestInstance.register(h.app, accountId());
    const account = accountId();
    const active = await TestInstance.register(h.app, account);
    await active.stockKeyPackages(1);
    await active.signed("post", `/v1/instances/${active.id}/revoke`).expect(200);
    const response = await claimer.signed("post", "/v1/key-packages/claim", { instanceIds: [active.id] });
    expect(response.body).toEqual({ keyPackages: [], missing: [active.id] });
    const [still] = await h.db
      .select()
      .from(schema.keyPackages)
      .where(and(eq(schema.keyPackages.instanceId, active.id), isNull(schema.keyPackages.consumedAt)));
    expect(still).toBeDefined();
  });

  /**
   * The discriminating case for `SKIP LOCKED` (CONVENTIONS.md): a claimer
   * holding a lock on the only package must not make a second claimer WAIT —
   * it must see nothing and answer `missing`. A plain `FOR UPDATE` would
   * block here until the first transaction ends, and a test that only races
   * two claimers cannot tell the two apart.
   */
  it("skips a package another transaction is claiming rather than waiting on it", async () => {
    const claimer = await TestInstance.register(h.app, accountId());
    const target = await TestInstance.register(h.app, accountId());
    await target.stockKeyPackages(1);

    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let lockTaken: () => void = () => undefined;
    const locked = new Promise<void>((resolve) => {
      lockTaken = resolve;
    });
    const holder = h.db.transaction(async (tx) => {
      await tx
        .select({ id: schema.keyPackages.id })
        .from(schema.keyPackages)
        .where(eq(schema.keyPackages.instanceId, target.id))
        .for("update");
      lockTaken();
      await held;
    });
    await locked;

    const startedAt = Date.now();
    const response = await claimer.signed("post", "/v1/key-packages/claim", { instanceIds: [target.id] });
    const elapsed = Date.now() - startedAt;
    release();
    await holder;

    expect(response.body).toEqual({ keyPackages: [], missing: [target.id] });
    // Did not block on the holder (which was released only after the answer).
    expect(elapsed).toBeLessThan(5_000);
  });
});
