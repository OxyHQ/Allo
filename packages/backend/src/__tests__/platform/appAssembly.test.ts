/**
 * Properties of the ASSEMBLY, not of any function: readiness before and after
 * migrations, the error envelope, and the raw blob route sitting ahead of the
 * JSON parser so an oversized upload is refused before a byte is buffered.
 *
 * No database: `createApp` is pure, and every dependency here is a fake.
 */

import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { errorResponseSchema } from "@allo/shared-types";
import { createApp, type CreateAppDependencies } from "../../app";
import { markMigrationsComplete, markRuntimeReady, markRuntimeShuttingDown, resetRuntimeHealthState } from "../../runtime/health";
import { requireOxySession } from "../../middleware/oxySession";
import { AlloHttpError } from "../../utils/httpErrors";
import { logger } from "../../utils/logger";
import { fakeOxyAuth, USER_HEADER } from "./harness";

const pass: express.RequestHandler = (_req, _res, next) => next();

function appWith(overrides: Partial<CreateAppDependencies> = {}, postgres = true) {
  let parsedJson = 0;
  const instanceAuth: express.RequestHandler = (req, _res, next) => {
    Reflect.set(req, "instance", { id: "inst-00000001", accountId: req.get(USER_HEADER), appId: "allo", status: "active" });
    next();
  };
  const app = createApp({
    auth: fakeOxyAuth,
    instanceAuth,
    rateLimit: pass,
    cors: pass,
    webhooks: express.Router(),
    api: { profile: express.Router(), reports: express.Router(), directory: express.Router() },
    checkPostgres: async () => postgres,
    blobMaxBytes: 1024,
    ...overrides,
  });
  // A probe mounted AFTER everything: reached only if the JSON parser ran and
  // the request fell through every earlier handler.
  app.use((req, _res, next) => {
    if (req.body !== undefined) parsedJson += 1;
    next();
  });
  return { app, parsedJson: () => parsedJson };
}

beforeEach(() => {
  resetRuntimeHealthState();
});

afterEach(() => {
  resetRuntimeHealthState();
});

describe("health", () => {
  it("/health/live is always 200; /health/ready and /api/health are 503 before migrations complete and 200 after", async () => {
    const { app } = appWith();
    expect((await request(app).get("/health/live")).status).toBe(200);
    let ready = await request(app).get("/health/ready");
    expect(ready.status).toBe(503);
    expect(ready.body.dependencies.migrations).toBe("pending");

    expect(() => markRuntimeReady()).toThrow(/migrations/);
    markMigrationsComplete();
    ready = await request(app).get("/health/ready");
    expect(ready.status).toBe(503);
    expect(ready.body.phase).toBe("starting");

    markRuntimeReady();
    ready = await request(app).get("/health/ready");
    expect(ready.status).toBe(200);
    expect(ready.headers["cache-control"]).toBe("no-store");
    expect((await request(app).get("/api/health")).status).toBe(200);

    markRuntimeShuttingDown();
    expect((await request(app).get("/health/ready")).status).toBe(503);
    expect((await request(app).get("/health/live")).status).toBe(200);
  });

  it("readiness needs Postgres to answer select 1", async () => {
    const { app } = appWith({}, false);
    markMigrationsComplete();
    markRuntimeReady();
    const ready = await request(app).get("/health/ready");
    expect(ready.status).toBe(503);
    expect(ready.body.dependencies.postgres).toBe("unavailable");
  });
});

describe("the blob route sits ahead of the JSON parser", () => {
  it("refuses a 30 MB octet-stream with 413 payload_too_large without parsing or buffering it", async () => {
    const { app, parsedJson } = appWith();
    const response = await request(app)
      .post("/v1/blobs")
      .set(USER_HEADER, "acct-00000001")
      .set("content-type", "application/octet-stream")
      // body-parser compares Content-Length with the limit before reading,
      // answers 413 at once and drains the rest; nothing is buffered.
      .send(Buffer.alloc(30 * 1024 * 1024));
    expect(response.status).toBe(413);
    expect(expectError(response.body).code).toBe("payload_too_large");
    expect(parsedJson()).toBe(0);
  });

  it("a JSON body over the JSON limit is also payload_too_large, and a broken one validation_failed", async () => {
    const { app } = appWith();
    const big = await request(app)
      .post("/v1/instances")
      .set(USER_HEADER, "acct-00000001")
      .set("content-type", "application/json")
      .send(`{"pad":"${"x".repeat(5 * 1024 * 1024)}"}`);
    expect(big.status).toBe(413);
    const broken = await request(app)
      .post("/v1/instances")
      .set(USER_HEADER, "acct-00000001")
      .set("content-type", "application/json")
      .send("{not json");
    expect(broken.status).toBe(400);
    expect(expectError(broken.body).code).toBe("validation_failed");
  });
});

describe("the error envelope", () => {
  it("maps AlloHttpError to its status, an unknown route to not_found, and a bug to 500 internal with no message leak", async () => {
    const boom = express.Router();
    boom.get("/boom", () => {
      throw new Error("secret internals: token=abc");
    });
    boom.get("/teapot", (_req, _res, next) => next(new AlloHttpError("rate_limited", "slow down")));
    const { app } = appWith({ api: { profile: boom, reports: express.Router(), directory: express.Router() } });

    const crashed = await request(app).get("/api/profile/boom").set(USER_HEADER, "acct-00000001");
    expect(crashed.status).toBe(500);
    expect(expectError(crashed.body)).toEqual({ code: "internal", message: "Internal error" });
    expect(JSON.stringify(crashed.body)).not.toContain("secret");

    vi.mocked(logger.info).mockClear();
    const limited = await request(app).get("/api/profile/teapot").set(USER_HEADER, "acct-00000001");
    expect(limited.status).toBe(429);
    expect(expectError(limited.body).code).toBe("rate_limited");
    // The request line names the MOUNTED template even on the error path, where
    // every router has unwound (and restored `req.baseUrl`) before the handler
    // answers; it never names the URL.
    const line = vi.mocked(logger.info).mock.calls.find(([message]) => message === "HTTP request completed");
    expect(line?.[1]).toMatchObject({ method: "GET", route: "/api/profile/teapot", status: 429 });
    expect(JSON.stringify(line?.[1])).not.toContain("acct-00000001");

    const missing = await request(app).get("/v1/nowhere").set(USER_HEADER, "acct-00000001");
    expect(missing.status).toBe(404);
    expect(expectError(missing.body).code).toBe("not_found");

    const noSession = await request(app).get("/v1/instances");
    expect(noSession.status).toBe(401);
  });

  it("answers a missing or bad Oxy session on /v1 with the contract's unauthorized envelope", async () => {
    // The production chain: optional auth (here: attaches a user only when the
    // header is present, like a valid bearer) then `requireOxySession`.
    const optional: express.RequestHandler = (req, _res, next) => {
      const userId = req.get(USER_HEADER);
      if (userId) Reflect.set(req, "userId", userId);
      next();
    };
    const { app } = appWith({ v1Auth: [optional, requireOxySession] });
    const anonymous = await request(app).get("/v1/instances");
    expect(anonymous.status).toBe(401);
    expect(expectError(anonymous.body)).toEqual({ code: "unauthorized", message: "An Oxy session is required" });
    const blob = await request(app).post("/v1/blobs").set("content-type", "application/octet-stream").send(Buffer.alloc(4));
    expect(blob.status).toBe(401);
    expect(expectError(blob.body).code).toBe("unauthorized");
    // With a session the guard admits the request: it reaches the router and
    // falls through to the JSON 404 (this suite has no database to answer with).
    const admitted = await request(app).get("/v1/nowhere").set(USER_HEADER, "acct-00000001");
    expect(admitted.status).toBe(404);
    expect(expectError(admitted.body).code).toBe("not_found");
  });

  it("sets no-store on API answers and echoes a request id", async () => {
    const { app } = appWith();
    const response = await request(app).get("/v1/instances").set(USER_HEADER, "acct-00000001").set("x-request-id", "req-12345678");
    expect(response.headers["cache-control"]).toContain("no-store");
    expect(response.headers["x-request-id"]).toBe("req-12345678");
    const minted = await request(app).get("/v1/instances").set(USER_HEADER, "acct-00000001").set("x-request-id", "bad id!");
    expect(minted.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });
});

function expectError(body: unknown) {
  return errorResponseSchema.parse(body).error;
}
