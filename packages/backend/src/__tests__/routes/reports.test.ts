import express from "express";
import mongoose from "mongoose";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `POST /api/reports` — the edge where an MXID becomes an Oxy id (§6.2).
 *
 * `createReport` is mocked because none of the properties below are about storage.
 * They are about the two decisions the ROUTE makes and nothing else makes: whether
 * this is a self-report, and what identifier it hands over.
 *
 * The self-report check is the reason this file exists. It has always compared
 * `reportedId` to the authenticated reporter, and that was sound while a
 * `reportedId` could only be an Oxy user id. A client in a Matrix room holds an
 * MXID, so the moment the route accepts one the comparison is against a different
 * spelling of the same person — it passes, intake translates the MXID straight back
 * to the reporter's own Oxy id, and a self-report is queued for a jury. It needs no
 * attacker: it is what happens when the reporting sheet is opened on your own
 * membership event.
 */

vi.mock("../../services/moderation/ReportIntakeService", async () => {
  const actual = await vi.importActual<
    typeof import("../../services/moderation/ReportIntakeService")
  >("../../services/moderation/ReportIntakeService");
  return { ...actual, createReport: vi.fn() };
});

import { resetBridgesConfigForTests } from "../../config/bridges";
import { ReportCategory, ReportedType } from "../../models/Report";
import reportsRouter from "../../routes/reports";
import { createReport } from "../../services/moderation/ReportIntakeService";

const SERVER_NAME = "allo.you";
const REPORTER = "507f1f77bcf86cd799439011";
const OTHER_USER = "507f1f77bcf86cd799439022";

/** An app assembled the way `server.ts` assembles it, minus Oxy. */
function appWithAuth(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const userId = req.get("x-test-user") ?? REPORTER;
    Reflect.set(req, "userId", userId);
    Reflect.set(req, "user", { id: userId });
    next();
  });
  app.use("/api/reports", reportsRouter);
  return app;
}

function post(reportedId: string, reportedType: ReportedType = ReportedType.USER) {
  return request(appWithAuth())
    .post("/api/reports")
    .send({ reportedType, reportedId, categories: [ReportCategory.HARASSMENT] });
}

describe("POST /api/reports", () => {
  beforeEach(() => {
    /**
     * `restoreAllMocks` does not reset a `vi.fn()` created by a module factory, so
     * call counts would carry across tests and "called once" would pass on the
     * strength of an earlier test's request.
     */
    vi.clearAllMocks();
    process.env.ALLO_MATRIX_SERVER_NAME = SERVER_NAME;
    resetBridgesConfigForTests();
    vi.mocked(createReport).mockResolvedValue({
      report: {
        _id: new mongoose.Types.ObjectId(),
        createdAt: new Date("2026-08-02T10:00:00.000Z"),
      },
    } as unknown as Awaited<ReturnType<typeof createReport>>);
  });

  afterEach(() => {
    delete process.env.ALLO_MATRIX_SERVER_NAME;
    resetBridgesConfigForTests();
    vi.restoreAllMocks();
  });

  describe("a reporter cannot report themselves", () => {
    it("refuses their own Oxy id", async () => {
      const response = await post(REPORTER);

      expect(response.status).toBe(400);
      expect(createReport).not.toHaveBeenCalled();
    });

    it("refuses their own MXID", async () => {
      /**
       * The bypass. Compared against the raw field this passes, because
       * `@507f…:allo.you` is not the string `507f…` — and intake then resolves it
       * back to the reporter, storing a report whose subject and reporter are one
       * principal and queueing it for review. §7.3's dedup key would be perfectly
       * well-formed, which is what makes it invisible afterwards.
       */
      const response = await post(`@${REPORTER}:${SERVER_NAME}`);

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty("message", "You cannot report yourself");
      expect(createReport).not.toHaveBeenCalled();
    });

    it("still accepts a report about somebody else's MXID", async () => {
      /**
       * The direction that would make the fix a regression. Over-matching here
       * would silently disable reporting from inside rooms, which is where reports
       * actually come from.
       */
      const response = await post(`@${OTHER_USER}:${SERVER_NAME}`);

      expect(response.status).toBe(201);
      expect(createReport).toHaveBeenCalledTimes(1);
    });

    it("does not refuse a bridge ghost that shares the reporter's localpart", async () => {
      /**
       * `@whatsapp_<reporter id>` is a different subject from `<reporter id>`, and
       * a check that resolved it to the reporter would refuse a legitimate report
       * about a bridged identity. The resolver answers `not-an-oxy-account`, so the
       * self-report branch is not even reached.
       */
      const response = await post(`@whatsapp_${REPORTER}:${SERVER_NAME}`);

      expect(response.status).toBe(201);
    });
  });

  describe("what is handed to intake", () => {
    it("passes the identifier through as given", async () => {
      /**
       * The route resolves in order to answer its OWN question and then hands over
       * the raw field. Intake resolves again and that resolution decides the stored
       * row — one authority for what `reportedId` means, rather than a route that
       * canonicalises and a service that assumes somebody did.
       */
      await post(`@${OTHER_USER}:${SERVER_NAME}`);

      expect(createReport).toHaveBeenCalledWith(
        expect.objectContaining({
          reporter: REPORTER,
          reportedId: `@${OTHER_USER}:${SERVER_NAME}`,
          reportedType: ReportedType.USER,
        }),
      );
    });

    it("accepts a subject with no Oxy account rather than refusing it", async () => {
      /**
       * §6.3 keeps these reports. Refusing would be the same mistake as refusing a
       * reported message — and a 400 would additionally tell any client which
       * identifiers this deployment considers real, which is a membership oracle
       * for the homeserver.
       */
      const response = await post("@someone:elsewhere.example");

      expect(response.status).toBe(201);
      expect(createReport).toHaveBeenCalledTimes(1);
    });

    it("answers identically whether or not the report will ever leave", async () => {
      /**
       * The response body must not distinguish a deliverable report from a
       * local-only one. A reporter who could tell them apart would learn which
       * reports can be made to disappear.
       */
      const deliverable = await post(OTHER_USER);
      const localOnly = await post("$eventid123:allo.you");

      expect(localOnly.status).toBe(deliverable.status);
      expect(Object.keys(localOnly.body)).toEqual(Object.keys(deliverable.body));
      expect(localOnly.body.message).toBe(deliverable.body.message);
    });
  });
});
