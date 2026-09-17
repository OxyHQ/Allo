/**
 * The signed HTTP client. Every call carries the Oxy bearer; instance-signed
 * calls add the three `X-Allo-*` headers over the exact bytes handed to
 * `fetch`. Answers are parsed through the shared-types schema the caller
 * names; a non-2xx becomes {@link TransportError}, a 409 `epoch_conflict`
 * becomes {@link EpochConflictError}.
 */
import {
  EMPTY_BODY_SHA256_HEX,
  INSTANCE_HEADER,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  epochConflictDetailsSchema,
  errorResponseSchema,
} from "@allo/shared-types";
import type { z } from "zod";
import { EpochConflictError, InstanceNotActiveError, TransportError } from "../errors";
import { sha256Hex, utf8Encode } from "../util/bytes";
import type { SigningKeyPair } from "../crypto/signing";
import { signRequest } from "../crypto/signing";

export interface Signer {
  instanceId: string;
  key: SigningKeyPair;
}

export interface HttpClientOptions {
  baseUrl: string;
  fetch: typeof fetch;
  getAccessToken(): Promise<string | null>;
  now(): number;
  /** Called on a 403 `instance_revoked` so the instance manager can flip state. */
  onInstanceRevoked?: () => void;
}

export interface RequestOptions<T> {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  /** JSON body, or raw bytes with `rawContentType`. */
  body?: unknown;
  rawBody?: Uint8Array;
  headers?: Record<string, string>;
  schema?: z.ZodType<T>;
  /** Sign with this instance. Omit for Oxy-only routes. */
  signer?: Signer;
  /** Expect bytes rather than JSON. */
  binary?: boolean;
  /** Passed to `fetch`; an abort is rethrown as-is (an `AbortError`), not as a `TransportError`. */
  signal?: AbortSignal;
}

export class HttpClient {
  constructor(private readonly options: HttpClientOptions) {}

  async request<T = void>(req: RequestOptions<T>): Promise<T> {
    const token = await this.options.getAccessToken();
    if (!token) throw new TransportError(401, "unauthorized", "no Oxy session");
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: "application/json", ...(req.headers ?? {}) };
    let body: Uint8Array | string | undefined;
    let bodySha = EMPTY_BODY_SHA256_HEX;
    if (req.rawBody !== undefined) {
      body = req.rawBody;
      headers["content-type"] = headers["content-type"] ?? "application/octet-stream";
      headers["content-length"] = String(req.rawBody.byteLength);
      bodySha = sha256Hex(req.rawBody);
    } else if (req.body !== undefined) {
      const text = JSON.stringify(req.body);
      body = text;
      headers["content-type"] = "application/json";
      bodySha = sha256Hex(utf8Encode(text));
    }
    if (req.signer) {
      const timestampMs = Math.floor(this.options.now());
      headers[INSTANCE_HEADER] = req.signer.instanceId;
      headers[TIMESTAMP_HEADER] = String(timestampMs);
      headers[SIGNATURE_HEADER] = signRequest(req.signer.key, { method: req.method, pathWithQuery: req.path, timestampMs, bodySha256Hex: bodySha });
    }
    let response: Response;
    try {
      response = await this.options.fetch(this.options.baseUrl + req.path, { method: req.method, headers, body: body as BodyInit | undefined, signal: req.signal });
    } catch (cause) {
      if (req.signal?.aborted || (cause instanceof Error && cause.name === "AbortError")) throw cause;
      throw new TransportError(0, "network", "request failed to reach the server", undefined, { cause });
    }
    if (!response.ok) throw await this.toError(response);
    if (response.status === 204 || req.schema === undefined) {
      if (req.binary) return new Uint8Array(await response.arrayBuffer()) as unknown as T;
      return undefined as unknown as T;
    }
    let json: unknown;
    try {
      json = await response.json();
    } catch (cause) {
      throw new TransportError(response.status, "internal", "answer was not JSON", undefined, { cause });
    }
    const parsed = req.schema.safeParse(json);
    if (!parsed.success) {
      const where = parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      throw new TransportError(response.status, "internal", `answer did not match its schema (${where})`, parsed.error.issues);
    }
    return parsed.data;
  }

  private async toError(response: Response): Promise<Error> {
    let code = "internal";
    let message = `http ${response.status}`;
    let details: unknown;
    try {
      const parsed = errorResponseSchema.safeParse(await response.json());
      if (parsed.success) {
        code = parsed.data.error.code;
        message = parsed.data.error.message;
        details = parsed.data.error.details;
      }
    } catch {
      /* body was not JSON */
    }
    if (response.status === 409 && code === "epoch_conflict") {
      const d = epochConflictDetailsSchema.safeParse(details);
      return new EpochConflictError(d.success ? d.data.currentEpoch : undefined);
    }
    if (response.status === 403 && code === "instance_revoked") {
      this.options.onInstanceRevoked?.();
      return new InstanceNotActiveError("revoked");
    }
    if (response.status === 403 && code === "instance_not_active") return new InstanceNotActiveError("pending");
    return new TransportError(response.status, code, message, details);
  }
}
