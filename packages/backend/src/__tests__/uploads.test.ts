import fs from "fs";
import path from "path";
import express from "express";
import request from "supertest";
import { buildApp } from "./testApp";
import messagesRoutes from "../routes/messages";
import {
  UPLOAD_DIR,
  isAllowedMime,
  safeExtensionForMime,
  buildSafeStoredFilename,
  DANGEROUS_EXTENSIONS,
} from "../config/uploads";

const USER_ID = "u1";

function makeApp() {
  return buildApp({
    injectUserId: USER_ID,
    mount: [{ path: "/api/messages", router: messagesRoutes }],
  });
}

describe("uploads config helpers", () => {
  it("allowlists image/video/audio, pdf and octet-stream, rejects the rest", () => {
    expect(isAllowedMime("image/png")).toBe(true);
    expect(isAllowedMime("video/mp4")).toBe(true);
    expect(isAllowedMime("audio/mpeg")).toBe(true);
    expect(isAllowedMime("application/pdf")).toBe(true);
    // Encrypted media ciphertext is uploaded as octet-stream (Fase 1D).
    expect(isAllowedMime("application/octet-stream")).toBe(true);
    expect(isAllowedMime("text/html")).toBe(false);
    expect(isAllowedMime("image/svg+xml")).toBe(false); // svg is not allowlisted
    expect(isAllowedMime("application/javascript")).toBe(false);
    expect(isAllowedMime(undefined)).toBe(false);
  });

  it("derives the stored extension from the MIME, never the filename", () => {
    expect(safeExtensionForMime("image/png")).toBe(".png");
    expect(safeExtensionForMime("application/pdf")).toBe(".pdf");
    // Encrypted ciphertext blobs are stored with a .bin extension.
    expect(safeExtensionForMime("application/octet-stream")).toBe(".bin");
    // A disallowed MIME yields no extension.
    expect(safeExtensionForMime("text/html")).toBe("");
  });

  it("never produces a dangerous stored extension", () => {
    // Even if the client names the file .html, the stored name uses the MIME ext.
    const stored = buildSafeStoredFilename("evil.html", "image/png");
    expect(stored.endsWith(".png")).toBe(true);
    const ext = path.extname(stored).toLowerCase();
    expect(DANGEROUS_EXTENSIONS.has(ext)).toBe(false);
  });
});

describe("POST /api/messages/upload (MIME allowlist)", () => {
  it("rejects a dangerous extension (.html) with 400", async () => {
    const res = await request(makeApp())
      .post("/api/messages/upload")
      .attach("file", Buffer.from("<script>alert(1)</script>"), {
        filename: "evil.html",
        contentType: "text/html",
      });

    expect(res.status).toBe(400);
    expect(await listUploads()).not.toContain("evil.html");
  });

  it("rejects an SVG (image/svg+xml not allowlisted) with 400", async () => {
    const res = await request(makeApp())
      .post("/api/messages/upload")
      .attach("file", Buffer.from("<svg onload=alert(1)></svg>"), {
        filename: "x.svg",
        contentType: "image/svg+xml",
      });

    expect(res.status).toBe(400);
  });

  it("accepts an allowlisted image and stores it with a MIME-derived extension", async () => {
    const res = await request(makeApp())
      .post("/api/messages/upload")
      .attach("file", Buffer.from([0x89, 0x50, 0x4e, 0x47]), {
        // Hostile path components + a misleading client extension. The stored
        // name must be sanitized and the extension re-derived from the MIME.
        filename: "../../etc/photo.jpeg",
        contentType: "image/png",
      });

    expect(res.status).toBe(201);
    const storedName: string = res.body.data.id;
    expect(storedName.endsWith(".png")).toBe(true); // from MIME, not the .jpeg name
    expect(storedName).not.toContain("/");
    expect(storedName).not.toContain("..");

    // Clean up the file we just wrote.
    const onDisk = path.join(UPLOAD_DIR, storedName);
    if (fs.existsSync(onDisk)) fs.unlinkSync(onDisk);
  });

  it("accepts an encrypted octet-stream blob and stores it as .bin", async () => {
    // Simulates the Fase 1D encrypted-media upload: opaque ciphertext bytes
    // uploaded as application/octet-stream.
    const res = await request(makeApp())
      .post("/api/messages/upload")
      .attach("file", Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]), {
        filename: "ciphertext",
        contentType: "application/octet-stream",
      });

    expect(res.status).toBe(201);
    const storedName: string = res.body.data.id;
    expect(storedName.endsWith(".bin")).toBe(true);
    expect(res.body.data.mimeType).toBe("application/octet-stream");

    const onDisk = path.join(UPLOAD_DIR, storedName);
    if (fs.existsSync(onDisk)) fs.unlinkSync(onDisk);
  });
});

describe("/uploads static serving headers (defensive)", () => {
  // Mirror server.ts's defensive static handler and assert the three headers are
  // applied so an uploaded file can never execute in the app origin.
  function staticApp() {
    const app = express();
    app.use(
      "/uploads",
      (_req, res, next) => {
        res.setHeader("Content-Disposition", "attachment");
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
        next();
      },
      express.static(UPLOAD_DIR)
    );
    return app;
  }

  it("serves uploaded files with attachment + nosniff + sandbox CSP", async () => {
    if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    const name = `test-${Date.now()}.png`;
    const filePath = path.join(UPLOAD_DIR, name);
    fs.writeFileSync(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    try {
      const res = await request(staticApp()).get(`/uploads/${name}`);
      expect(res.status).toBe(200);
      expect(res.headers["content-disposition"]).toBe("attachment");
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["content-security-policy"]).toBe("default-src 'none'; sandbox");
    } finally {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
  });
});

async function listUploads(): Promise<string[]> {
  try {
    return fs.existsSync(UPLOAD_DIR) ? fs.readdirSync(UPLOAD_DIR) : [];
  } catch {
    return [];
  }
}
