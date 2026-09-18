/**
 * The errors the SDK throws. Every one carries a stable `code` so a caller
 * can branch without parsing messages, and none carries plaintext.
 */
export type AlloErrorCodeName =
  | "epoch_conflict"
  | "instance_not_active"
  | "instance_revoked"
  | "not_implemented"
  | "decrypt_failed"
  | "future_epoch"
  | "transport"
  | "storage"
  | "invalid_state"
  | "not_found"
  | "untrusted_instance"
  | "invalid_recovery_phrase";

export class AlloError extends Error {
  override readonly name: string = "AlloError";
  readonly code: AlloErrorCodeName;
  constructor(code: AlloErrorCodeName, message: string, options?: { cause?: unknown }) {
    super(message);
    this.code = code;
    if (options?.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
  }
}

/** The server is at a newer epoch than the one this event was encrypted at. Re-sync, re-encrypt, retry. */
export class EpochConflictError extends AlloError {
  override readonly name = "EpochConflictError";
  readonly currentEpoch: number | undefined;
  constructor(currentEpoch?: number) {
    super("epoch_conflict", "the conversation moved to a newer epoch");
    this.currentEpoch = currentEpoch;
  }
}

/** A call that needs an active instance was made while this one is pending, revoked or unregistered. */
export class InstanceNotActiveError extends AlloError {
  override readonly name = "InstanceNotActiveError";
  constructor(state: string) {
    super("instance_not_active", `this instance is ${state}`);
  }
}

/** A documented API that a later phase implements. */
export class NotImplementedError extends AlloError {
  override readonly name = "NotImplementedError";
  constructor(feature: string, docs: string) {
    super("not_implemented", `${feature} is not implemented yet; see ${docs}`);
  }
}

export class DecryptError extends AlloError {
  override readonly name = "DecryptError";
  constructor(reason: string, options?: { cause?: unknown }) {
    super("decrypt_failed", reason, options);
  }
}

/** A message from an epoch this group state has not reached. The caller queues it until the commit arrives. */
export class FutureEpochError extends AlloError {
  override readonly name = "FutureEpochError";
  readonly messageEpoch: number;
  readonly stateEpoch: number;
  constructor(messageEpoch: number, stateEpoch: number) {
    super("future_epoch", `message is at epoch ${messageEpoch}, state at ${stateEpoch}`);
    this.messageEpoch = messageEpoch;
    this.stateEpoch = stateEpoch;
  }
}

/** A non-2xx answer or a network failure. `status` is 0 when no answer came back. */
export class TransportError extends AlloError {
  override readonly name = "TransportError";
  readonly status: number;
  /** The server's `error.code` when it sent one; `network` when nothing came back. */
  readonly serverCode: string;
  readonly details: unknown;
  constructor(status: number, serverCode: string, message: string, details?: unknown, options?: { cause?: unknown }) {
    super("transport", message, options);
    this.status = status;
    this.serverCode = serverCode;
    this.details = details;
  }
  get isNetwork(): boolean {
    return this.status === 0;
  }
  get isRetryable(): boolean {
    return this.status === 0 || this.status >= 500 || this.status === 429;
  }
}

export class StorageError extends AlloError {
  override readonly name = "StorageError";
  constructor(message: string, options?: { cause?: unknown }) {
    super("storage", message, options);
  }
}

export class InvalidStateError extends AlloError {
  override readonly name = "InvalidStateError";
  constructor(message: string) {
    super("invalid_state", message);
  }
}

export class NotFoundError extends AlloError {
  override readonly name = "NotFoundError";
  constructor(what: string) {
    super("not_found", `${what} not found`);
  }
}

/**
 * An instance that does not pass the approval chain, or is not an active
 * instance of THIS account, offered something only a trusted same-account
 * instance may: history. Nothing from it is opened, downloaded or imported.
 */
export class UntrustedInstanceError extends AlloError {
  override readonly name = "UntrustedInstanceError";
  readonly instanceId: string;
  constructor(instanceId: string, reason: string) {
    super("untrusted_instance", `instance ${instanceId} is not trusted: ${reason}`);
    this.instanceId = instanceId;
  }
}

/** A recovery phrase that is not a valid BIP39 phrase, or that does not unlock the account's backup. Never carries the phrase. */
export class RecoveryPhraseError extends AlloError {
  override readonly name = "RecoveryPhraseError";
  constructor(message: string) {
    super("invalid_recovery_phrase", message);
  }
}
