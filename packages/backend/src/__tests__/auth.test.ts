import request from "supertest";
import express from "express";
import { buildApp } from "./testApp";
import conversationsRoutes from "../routes/conversations";
import messagesRoutes from "../routes/messages";
import { requireAuth, AuthRequest } from "../middleware/auth";

function makeAuthedApp() {
  return buildApp({
    withAuth: true,
    mount: [
      { path: "/api/conversations", router: conversationsRoutes },
      { path: "/api/messages", router: messagesRoutes },
    ],
  });
}

describe("authenticated routes without a token", () => {
  it("GET /api/conversations returns 401", async () => {
    const res = await request(makeAuthedApp()).get("/api/conversations");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Unauthorized");
  });

  it("POST /api/messages returns 401", async () => {
    const res = await request(makeAuthedApp())
      .post("/api/messages")
      .send({ conversationId: "x", senderDeviceId: 1, text: "hi" });
    expect(res.status).toBe(401);
  });

  it("rejects malformed Authorization headers", async () => {
    const res = await request(makeAuthedApp())
      .get("/api/conversations")
      .set("Authorization", "Basic abc123");
    expect(res.status).toBe(401);
  });
});

describe("authenticated routes with a token", () => {
  it("GET /api/conversations returns 200 and the user's data", async () => {
    const res = await request(makeAuthedApp())
      .get("/api/conversations")
      .set("Authorization", "Bearer test:u1");

    expect(res.status).toBe(200);
    expect(res.body.data.conversations).toEqual([]);
  });
});

describe("requireAuth middleware", () => {
  function appWithRequireAuth() {
    const app = express();
    app.get("/protected", requireAuth, (req: AuthRequest, res) => {
      res.json({ userId: req.user?.id });
    });
    return app;
  }

  it("returns 401 when req.user is missing", async () => {
    const res = await request(appWithRequireAuth()).get("/protected");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      error: "Unauthorized",
      message: "Authentication required",
    });
  });
});
