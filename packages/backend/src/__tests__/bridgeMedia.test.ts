import fs from "fs";
import path from "path";
import express from "express";
import request from "supertest";
import { captureRawBody } from "../middleware/bridgeAuth";
import internalBridgeRouter from "../routes/internalBridge";
import { BRIDGE_TIMESTAMP_HEADER, BRIDGE_SIGNATURE_HEADER } from "../config/bridge";
import { UPLOAD_DIR } from "../config/uploads";
import { installMockMessaging, type MockMessaging } from "./helpers/mockSocket";
import { TEST_BRIDGE_SECRET, signMedia } from "./helpers/bridgeFixtures";

/**
 * Mirror the REAL server mount: the scoped raw-body json parser runs first (a
 * no-op for multipart), then the router applies `bridgeMediaAuth` PER ROUTE for
 * `/media`. This is the wiring that Finding 1 fixed — previously a blanket
 * `bridgeAuth` 400'd every upload because multipart never populates rawBody.
 */
function buildBridgeApp() {
  const app = express();
  app.use("/internal/bridge", express.json({ verify: captureRawBody }), internalBridgeRouter);
  return app;
}

/** Remove a file the upload route may have written, by its stored name. */
function cleanupStored(name: string | undefined): void {
  if (!name) return;
  const onDisk = path.join(UPLOAD_DIR, name);
  if (fs.existsSync(onDisk)) fs.unlinkSync(onDisk);
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

describe("POST /internal/bridge/media (bridgeMediaAuth + upload)", () => {
  let mock: MockMessaging;
  const prevEnabled = process.env.BRIDGE_ENABLED;
  const prevSecret = process.env.BRIDGE_SHARED_SECRET;
  const prevUrl = process.env.BRIDGE_SERVICE_URL;

  beforeEach(() => {
    process.env.BRIDGE_ENABLED = "true";
    process.env.BRIDGE_SHARED_SECRET = TEST_BRIDGE_SECRET;
    process.env.BRIDGE_SERVICE_URL = "http://bridge.test";
    mock = installMockMessaging();
  });

  afterEach(() => {
    mock.restore();
    jest.restoreAllMocks();
    process.env.BRIDGE_ENABLED = prevEnabled;
    process.env.BRIDGE_SHARED_SECRET = prevSecret;
    process.env.BRIDGE_SERVICE_URL = prevUrl;
  });

  it("rejects a bad signature with 401 (and writes nothing)", async () => {
    const before = await listUploads();
    const ts = String(Date.now());
    const res = await request(buildBridgeApp())
      .post("/internal/bridge/media")
      .set(BRIDGE_TIMESTAMP_HEADER, ts)
      .set(BRIDGE_SIGNATURE_HEADER, "deadbeef")
      .attach("file", PNG_MAGIC, { filename: "photo.png", contentType: "image/png" });

    expect(res.status).toBe(401);
    // Auth runs BEFORE multer, so no new file should have been written.
    expect(await listUploads()).toEqual(before);
  });

  it("rejects missing auth headers with 401", async () => {
    const res = await request(buildBridgeApp())
      .post("/internal/bridge/media")
      .attach("file", PNG_MAGIC, { filename: "photo.png", contentType: "image/png" });
    expect(res.status).toBe(401);
  });

  it("accepts a valid signature + allowlisted image, storing a MIME-derived name", async () => {
    const ts = String(Date.now());
    const res = await request(buildBridgeApp())
      .post("/internal/bridge/media")
      .set(BRIDGE_TIMESTAMP_HEADER, ts)
      .set(BRIDGE_SIGNATURE_HEADER, signMedia(ts))
      // Hostile path + misleading client extension: stored name must be sanitized
      // and re-derived from the validated MIME.
      .attach("file", PNG_MAGIC, { filename: "../../etc/photo.jpeg", contentType: "image/png" });

    expect(res.status).toBe(201);
    const storedName: string = res.body.data.id;
    expect(storedName.endsWith(".png")).toBe(true); // from MIME, not the .jpeg name
    expect(storedName).not.toContain("/");
    expect(storedName).not.toContain("..");
    expect(res.body.data.url).toBe(`/uploads/${storedName}`);

    cleanupStored(storedName);
  });

  it("still rejects a dangerous .html upload with 400 even with a valid signature", async () => {
    const before = await listUploads();
    const ts = String(Date.now());
    const res = await request(buildBridgeApp())
      .post("/internal/bridge/media")
      .set(BRIDGE_TIMESTAMP_HEADER, ts)
      .set(BRIDGE_SIGNATURE_HEADER, signMedia(ts))
      .attach("file", Buffer.from("<script>alert(1)</script>"), {
        filename: "evil.html",
        contentType: "text/html",
      });

    expect(res.status).toBe(400);
    expect(await listUploads()).toEqual(before);
  });

  it("still rejects an image/svg+xml upload with 400 even with a valid signature", async () => {
    const before = await listUploads();
    const ts = String(Date.now());
    const res = await request(buildBridgeApp())
      .post("/internal/bridge/media")
      .set(BRIDGE_TIMESTAMP_HEADER, ts)
      .set(BRIDGE_SIGNATURE_HEADER, signMedia(ts))
      .attach("file", Buffer.from("<svg onload=alert(1)></svg>"), {
        filename: "x.svg",
        contentType: "image/svg+xml",
      });

    expect(res.status).toBe(400);
    expect(await listUploads()).toEqual(before);
  });

  it("returns 500 'Bridge not configured' for /media when the secret is too short", async () => {
    process.env.BRIDGE_SHARED_SECRET = "x".repeat(8);
    const ts = String(Date.now());
    const res = await request(buildBridgeApp())
      .post("/internal/bridge/media")
      .set(BRIDGE_TIMESTAMP_HEADER, ts)
      .set(BRIDGE_SIGNATURE_HEADER, signMedia(ts, undefined, "POST", "x".repeat(8)))
      .attach("file", PNG_MAGIC, { filename: "photo.png", contentType: "image/png" });
    expect(res.status).toBe(500);
    expect(res.body.message).toBe("Bridge not configured");
  });
});

async function listUploads(): Promise<string[]> {
  try {
    return fs.existsSync(UPLOAD_DIR) ? fs.readdirSync(UPLOAD_DIR).sort() : [];
  } catch {
    return [];
  }
}
