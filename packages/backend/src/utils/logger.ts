/**
 * The process logger, and the sanitiser every line passes through.
 *
 * The sanitiser is a port of Mention's `sanitizeLogValue`: an operational log
 * is the one place an identifier, a token or an address outlives the request
 * that carried it, so nothing of that shape is written. Keys that name such a
 * thing (`…Id`, `token`, `email`, `url`, `signature`, …) are redacted whole;
 * strings are scrubbed of bearer tokens, JWTs, emails, URLs with credentials,
 * IP addresses, 24-hex ids, uuids of ANY version (this service mints v7, and a
 * `[1-5]` version class would pass every one of them) and `oxy-…` handles.
 *
 * What survives, by name: `requestId`, `route`, `status`, `durationMs`, counts
 * and kinds — the fields a request line is made of.
 *
 * Bounded in depth, key count, array length and string length, so a logged
 * error cannot itself become a denial of service.
 */

import { isIP } from "node:net";

const REDACTED = "[REDACTED]";
const CIRCULAR = "[Circular]";
const TRUNCATED = "[Truncated]";
const FUNCTION = "[Function]";
const ACCESSOR = "[Accessor]";
const INVALID_DATE = "[Invalid Date]";
const MAX_LOG_DEPTH = 5;
const MAX_LOG_KEYS = 50;
const MAX_LOG_ARRAY_ITEMS = 20;
const MAX_LOG_STRING_LENGTH = 2_000;

const PRESERVED_KEYS = new Set([
  "requestid",
  "route",
  "routetemplate",
  "method",
  "duration",
  "durationms",
  "result",
  "status",
  "statuscode",
  "type",
  "kind",
  "count",
  "total",
  "claimed",
  "processed",
  "failed",
  "deleted",
  "attempts",
  "intervalms",
  "phase",
  "platform",
  "rejection",
  "deadlettered",
]);

const SENSITIVE_EXACT_KEYS = new Set([
  "authorization",
  "body",
  "challenge",
  "clientip",
  "connectionstring",
  "content",
  "cookie",
  "credential",
  "credentials",
  "data",
  "database",
  "databasename",
  "dbname",
  "email",
  "handle",
  "host",
  "hostname",
  "ip",
  "ipaddress",
  "params",
  "password",
  "path",
  "pathname",
  "payload",
  "privatekey",
  "query",
  "redisurl",
  "remoteaddress",
  "secret",
  "session",
  "signature",
  "set-cookie",
  "text",
  "token",
  "username",
]);

function normalizeKey(key: string): string {
  return key.replace(/[-_.]/g, "").toLowerCase();
}

function isSensitiveKey(key: string): boolean {
  const normalized = normalizeKey(key);
  if (PRESERVED_KEYS.has(normalized)) return false;
  if (SENSITIVE_EXACT_KEYS.has(normalized)) return true;
  return (
    normalized.endsWith("id") ||
    normalized.endsWith("ids") ||
    normalized.endsWith("uri") ||
    normalized.endsWith("uris") ||
    normalized.endsWith("url") ||
    normalized.endsWith("urls") ||
    normalized.endsWith("ipaddress") ||
    normalized.endsWith("handle") ||
    normalized.endsWith("username") ||
    normalized.endsWith("email") ||
    normalized.endsWith("password") ||
    normalized.endsWith("secret") ||
    normalized.endsWith("token") ||
    normalized.endsWith("credential") ||
    normalized.endsWith("credentials") ||
    normalized.endsWith("privatekey") ||
    normalized.endsWith("publickey") ||
    normalized.endsWith("apikey") ||
    normalized.endsWith("accesskey") ||
    normalized.endsWith("sessionid") ||
    normalized.endsWith("signature") ||
    normalized.endsWith("cursor")
  );
}

function sanitizeLogString(value: string, preserveBareIdentifier = false): string {
  const sanitized = value
    .replace(/\b(?:https?|wss?|redis|rediss|postgres(?:ql)?):\/\/[^\s"'<>]+/gi, (match) => {
      let candidateEnd = match.length;
      while (candidateEnd > 0 && "),.;!?".includes(match[candidateEnd - 1] ?? "")) {
        candidateEnd -= 1;
      }
      const candidate = match.slice(0, candidateEnd);
      const trailing = match.slice(candidateEnd);
      try {
        const parsed = new URL(candidate);
        if (
          parsed.protocol.startsWith("redis") ||
          parsed.protocol.startsWith("postgres") ||
          parsed.username ||
          parsed.password
        ) {
          return `${REDACTED}${trailing}`;
        }
        const host =
          /^(?:\d{1,3}\.){3}\d{1,3}$/.test(parsed.hostname) || parsed.hostname.includes(":")
            ? REDACTED
            : parsed.host;
        return `${parsed.protocol}//${host}/[REDACTED]${trailing}`;
      } catch {
        return `${REDACTED}${trailing}`;
      }
    })
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`)
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, REDACTED)
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, REDACTED)
    .replace(/(^|[\s(])@[A-Z0-9_][A-Z0-9_.-]*/gi, `$1${REDACTED}`)
    .replace(/\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g, REDACTED)
    .replace(/(?<![A-Z0-9:])\[?[A-F0-9:]{2,}\]?(?![A-Z0-9:])/gi, (candidate) => {
      const unwrapped = candidate.replace(/^\[/, "").replace(/\]$/, "");
      return isIP(unwrapped) === 6 ? REDACTED : candidate;
    })
    .replace(
      /\b((?:user|account|instance|conversation|event|blob|report|oxy)[A-Za-z]*(?:Id|Ids)|handle|username|email|token|signature)\s*[=:]\s*[^\s,;)\]]+/gi,
      `$1=${REDACTED}`,
    );
  const identifiersRedacted = preserveBareIdentifier
    ? sanitized
    : sanitized
        .replace(/\b[a-f0-9]{24}\b/gi, REDACTED)
        // Any uuid VERSION: every id this service mints is a v7.
        .replace(
          /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi,
          REDACTED,
        )
        .replace(/\boxy[-_:][A-Za-z0-9][A-Za-z0-9._:-]{2,}\b/gi, REDACTED);
  if (identifiersRedacted.length <= MAX_LOG_STRING_LENGTH) {
    return identifiersRedacted;
  }
  return `${identifiersRedacted.slice(0, MAX_LOG_STRING_LENGTH)}…${TRUNCATED}`;
}

function sanitizeError(error: Error, depth: number, seen: WeakSet<object>): Record<string, unknown> {
  const descriptors = Object.getOwnPropertyDescriptors(error);
  const dataValue = (key: string): unknown => {
    const descriptor = descriptors[key];
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  };
  const name = dataValue("name");
  const message = dataValue("message");
  const stack = dataValue("stack");
  const safe: Record<string, unknown> = {
    name: sanitizeLogString(typeof name === "string" ? name : "Error"),
    message: sanitizeLogString(typeof message === "string" ? message : ""),
  };
  if (typeof stack === "string" && stack) {
    safe.stack = sanitizeLogString(stack);
  }
  const code = dataValue("code");
  if (typeof code === "string" || typeof code === "number") {
    safe.code = typeof code === "string" ? sanitizeLogString(code) : code;
  }
  const cause = dataValue("cause");
  if (cause !== undefined && depth < MAX_LOG_DEPTH) {
    safe.cause = sanitizeLogValueInternal(cause, depth + 1, seen);
  }
  return safe;
}

function sanitizeLogValueInternal(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value === "string") return sanitizeLogString(value);
  if (value === null || typeof value === "number" || typeof value === "boolean" || typeof value === "undefined") {
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "symbol") return sanitizeLogString(String(value));
  if (typeof value === "function") return FUNCTION;
  if (depth >= MAX_LOG_DEPTH) return TRUNCATED;
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return CIRCULAR;
  seen.add(value);

  if (value instanceof Error) {
    return sanitizeError(value, depth, seen);
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? INVALID_DATE : value.toISOString();
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return `[Bytes ${value.byteLength}]`;
  }
  if (Array.isArray(value)) {
    const safe = value
      .slice(0, MAX_LOG_ARRAY_ITEMS)
      .map((item) => sanitizeLogValueInternal(item, depth + 1, seen));
    if (value.length > MAX_LOG_ARRAY_ITEMS) safe.push(TRUNCATED);
    return safe;
  }

  const output: Record<string, unknown> = {};
  const entries = Object.entries(Object.getOwnPropertyDescriptors(value)).filter(
    ([, descriptor]) => descriptor.enumerable,
  );
  for (const [key, nested] of entries.slice(0, MAX_LOG_KEYS)) {
    const normalized = normalizeKey(key);
    if (isSensitiveKey(key)) {
      output[key] = REDACTED;
    } else if (!("value" in nested)) {
      output[key] = ACCESSOR;
    } else if (normalized === "requestid" && typeof nested.value === "string") {
      output[key] = sanitizeLogString(nested.value, true);
    } else {
      output[key] = sanitizeLogValueInternal(nested.value, depth + 1, seen);
    }
  }
  if (entries.length > MAX_LOG_KEYS) output[TRUNCATED] = true;
  return output;
}

/** Everything the logger writes goes through this; exported for the global handlers and tests. */
export function sanitizeLogValue(value: unknown): unknown {
  try {
    return sanitizeLogValueInternal(value, 0, new WeakSet<object>());
  } catch {
    return "[Unserializable]";
  }
}

interface LoggerFunction {
  (message: string, ...args: unknown[]): void;
}

interface Logger {
  info: LoggerFunction;
  warn: LoggerFunction;
  error: LoggerFunction;
  debug: LoggerFunction;
}

function safeArgs(args: unknown[]): unknown[] {
  return args.map((arg) => sanitizeLogValue(arg));
}

export const logger: Logger = {
  info: (message: string, ...args: unknown[]) => {
    console.info(`[INFO] ${sanitizeLogString(message)}`, ...safeArgs(args));
  },
  error: (message: string, error?: unknown) => {
    console.error(`[ERROR] ${sanitizeLogString(message)}`, error === undefined ? "" : sanitizeLogValue(error));
  },
  warn: (message: string, ...args: unknown[]) => {
    console.warn(`[WARN] ${sanitizeLogString(message)}`, ...safeArgs(args));
  },
  debug: (message: string, ...args: unknown[]) => {
    if (process.env.NODE_ENV !== "production") {
      console.debug(`[DEBUG] ${sanitizeLogString(message)}`, ...safeArgs(args));
    }
  },
};
