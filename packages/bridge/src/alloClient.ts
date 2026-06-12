import type { BridgeEvent, BridgeMediaRef } from "@allo/shared-types";
import {
  ALLO_EVENTS_PATH,
  ALLO_MEDIA_PATH,
  ALLO_REQUEST_METHOD,
  ALLO_REQUEST_TIMEOUT_MS,
  BRIDGE_SIGNATURE_HEADER,
  BRIDGE_TIMESTAMP_HEADER,
  getAlloInternalUrl,
} from "./config";
import { signOutboundJson, signOutboundMedia } from "./signing";
import { logger } from "./logger";

/**
 * The OUTBOUND half of the connector (connector -> Allo). Posts normalized
 * `BridgeEvent`s to Allo's internal `/internal/bridge/events`, and re-hosts
 * external media via `/internal/bridge/media`. Both are HMAC-signed exactly as
 * Allo's `bridgeAuth`/`bridgeMediaAuth` expect:
 *  - events: body-bearing JSON signing over the stable `ALLO_EVENTS_PATH`,
 *  - media: header-only signing over the stable `ALLO_MEDIA_PATH` (no body).
 *
 * Never logs event/media contents — only ids and outcomes.
 */

const SUCCESS_STATUS_MIN = 200;
const SUCCESS_STATUS_MAX = 300;

function isOk(status: number): boolean {
  return status >= SUCCESS_STATUS_MIN && status < SUCCESS_STATUS_MAX;
}

/** `fetch` with a hard timeout via AbortController (a hung Allo must not block us). */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Shape returned by Allo's `POST /internal/bridge/media` on success. */
interface MediaUploadResponse {
  data?: {
    id?: string;
    url?: string;
    fileName?: string;
    mimeType?: string;
    size?: number;
  };
}

/**
 * POST a signed `BridgeEvent` to Allo's `/internal/bridge/events`. Returns true
 * on a 2xx. Throws only on a programming error (missing secret); transport
 * failures resolve to false so callers can decide whether to retry/log.
 */
export async function postEvent(event: BridgeEvent): Promise<boolean> {
  const baseUrl = getAlloInternalUrl();
  if (!baseUrl) {
    logger.error("Cannot post event: ALLO_INTERNAL_URL is not configured");
    return false;
  }
  const rawBody = JSON.stringify(event);
  let signed: { timestamp: string; signature: string };
  try {
    signed = signOutboundJson(ALLO_REQUEST_METHOD, ALLO_EVENTS_PATH, rawBody);
  } catch (error) {
    logger.error("Cannot post event: signing failed (secret unset/too short)", error);
    return false;
  }
  try {
    const response = await fetchWithTimeout(
      `${baseUrl}${ALLO_EVENTS_PATH}`,
      {
        method: ALLO_REQUEST_METHOD,
        headers: {
          "Content-Type": "application/json",
          [BRIDGE_TIMESTAMP_HEADER]: signed.timestamp,
          [BRIDGE_SIGNATURE_HEADER]: signed.signature,
        },
        body: rawBody,
      },
      ALLO_REQUEST_TIMEOUT_MS
    );
    if (!isOk(response.status)) {
      logger.warn(`Allo rejected event '${event.type}' with status ${response.status}`);
      return false;
    }
    return true;
  } catch (error) {
    logger.error(`Failed to post event '${event.type}' to Allo`, error);
    return false;
  }
}

/**
 * Re-host a downloaded media buffer on Allo's domain via `/internal/bridge/media`
 * (header-only signed multipart). Returns a `BridgeMediaRef` pointing at the
 * Allo-hosted URL, or null on failure (the caller then omits the media). Uses the
 * Web `FormData`/`Blob` available in the Node runtime (undici).
 */
export async function uploadMedia(params: {
  buffer: Buffer;
  fileName: string;
  mimeType: string;
  type: BridgeMediaRef["type"];
  width?: number;
  height?: number;
  duration?: number;
}): Promise<BridgeMediaRef | null> {
  const baseUrl = getAlloInternalUrl();
  if (!baseUrl) {
    logger.error("Cannot upload media: ALLO_INTERNAL_URL is not configured");
    return null;
  }
  let signed: { timestamp: string; signature: string };
  try {
    signed = signOutboundMedia(ALLO_REQUEST_METHOD, ALLO_MEDIA_PATH);
  } catch (error) {
    logger.error("Cannot upload media: signing failed (secret unset/too short)", error);
    return null;
  }

  const form = new FormData();
  const blob = new Blob([new Uint8Array(params.buffer)], { type: params.mimeType });
  form.append("file", blob, params.fileName);

  try {
    const response = await fetchWithTimeout(
      `${baseUrl}${ALLO_MEDIA_PATH}`,
      {
        method: ALLO_REQUEST_METHOD,
        headers: {
          // Content-Type is set by fetch from the FormData boundary; do NOT set
          // it manually or the multipart boundary would be wrong.
          [BRIDGE_TIMESTAMP_HEADER]: signed.timestamp,
          [BRIDGE_SIGNATURE_HEADER]: signed.signature,
        },
        body: form,
      },
      ALLO_REQUEST_TIMEOUT_MS
    );
    if (!isOk(response.status)) {
      logger.warn(`Allo media upload failed with status ${response.status}`);
      return null;
    }
    const json = (await response.json()) as MediaUploadResponse;
    const url = json.data?.url;
    if (!url) {
      logger.warn("Allo media upload returned no url");
      return null;
    }
    return {
      id: json.data?.id,
      url,
      type: params.type,
      fileName: json.data?.fileName ?? params.fileName,
      mimeType: json.data?.mimeType ?? params.mimeType,
      fileSize: json.data?.size,
      width: params.width,
      height: params.height,
      duration: params.duration,
    };
  } catch (error) {
    logger.error("Failed to upload media to Allo", error);
    return null;
  }
}
