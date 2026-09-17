import { describe, expect, it } from "vitest";
import * as api from "../index";

/**
 * The barrel is the package. A module that is written but not re-exported is
 * invisible to both consumers, so every module's marker symbol must surface
 * here — and the list is long enough that an empty barrel cannot pass.
 */
describe("index re-exports every module", () => {
  it("surfaces one marker per module", () => {
    const markers = [
      "idSchema", // common
      "clientInstanceSchema", // instances
      "signedRequestMessage", // requestSigning
      "uploadKeyPackagesRequestSchema", // keyPackages
      "createConversationRequestSchema", // conversations
      "submitEventRequestSchema", // events
      "encodeCursor", // sync
      "uploadBlobResponseSchema", // blobs
      "decodeAppMessage", // appMessage
      "decodeArchive", // archive
      "createHistoryOfferRequestSchema", // historyOffers
      "putBackupRequestSchema", // backups
    ] as const;
    for (const m of markers) expect(api[m], m).toBeDefined();
    expect(Object.keys(api).length).toBeGreaterThan(100);
  });
  it("keeps the directory contract types compiling", () => {
    const user: api.DirectoryUser = { id: "507f1f77bcf86cd799439011", username: "nate", displayName: "Nate", firstName: "", lastName: "" };
    const list: api.DirectorySearchResponse = { users: [user], total: 1, hasMore: false };
    const asset: api.DirectoryAssetUrlResponse = { url: "https://cdn.example/x" };
    const err: api.ApiErrorResponse = { error: "not_found", message: "no" };
    const ok: api.ApiSuccessResponse<number> = { data: 1 };
    const page: api.PaginationOptions = { limit: 10 };
    expect([list, asset, err, ok, page].length).toBe(5);
  });
});
