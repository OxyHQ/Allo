import { OXY_API_URL, OXY_CLOUD_URL } from "@oxy.so/core";
import { OxyServer } from "@oxy.so/core/server";

/**
 * Allo's one Oxy client: the backend half (`OxyServer`), so the service-token
 * lane, the Express and Socket.IO middlewares and the public lookups all run
 * on the same instance. `configureOxyServiceAuth` hands it the key pair when a
 * local checkout has one; in ECS it attests the task role (oxy ADR 0026).
 * `OXY_API_URL` points a local checkout at a local Oxy.
 */
export const oxy = new OxyServer({
  baseURL: process.env.OXY_API_URL || OXY_API_URL,
  cloudURL: OXY_CLOUD_URL,
});
