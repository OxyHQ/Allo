/**
 * Reading an Oxy client error without depending on its class.
 *
 * `@oxy.so/core` surfaces failures in more than one shape — an `Error` with a
 * `status`, a plain object with a `code` — and the callers here only need one
 * bit out of any of them: was the person not found, or did something else go
 * wrong. Kept separate from the callers so the directory route and the
 * moderation subject provider agree on what a 404 looks like.
 */

interface OxyUserErrorShape {
  status?: unknown;
  code?: unknown;
}

export function getErrorStatus(error: unknown): number | undefined {
  if (!isRecord(error)) {
    return undefined;
  }

  return typeof error.status === "number" ? error.status : undefined;
}

export function getErrorCode(error: unknown): string | undefined {
  if (!isRecord(error)) {
    return undefined;
  }

  return typeof error.code === "string" ? error.code : undefined;
}

export function getErrorMessage(error: unknown): string | undefined {
  if (error instanceof Error) {
    return error.message;
  }

  if (!isRecord(error)) {
    return undefined;
  }

  return typeof error.message === "string" ? error.message : undefined;
}

export function isOxyUserNotFound(error: unknown): boolean {
  const shapedError: OxyUserErrorShape = isRecord(error) ? error : {};
  return shapedError.status === 404 || shapedError.code === "ERR_BAD_REQUEST";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
