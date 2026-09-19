/**
 * `@allo/core`: the headless Allo messaging SDK. No React, no Expo, no
 * Node-only API; one code path for Node, browsers and Hermes.
 */
export { createAlloClient, type AlloClient } from "./client";
export * from "./types";
export {
  AlloError,
  DecryptError,
  EpochConflictError,
  FutureEpochError,
  InstanceNotActiveError,
  InvalidStateError,
  NotFoundError,
  NotImplementedError,
  RecoveryPhraseError,
  StorageError,
  TransportError,
  UntrustedInstanceError,
  type AlloErrorCodeName,
} from "./errors";
export { CryptoEngine, CIPHERSUITE_ID, keyPackageRefFromWire, identityString, parseIdentity, type GroupState, type Identity, type KeyPackageBundle, type LeafInfo } from "./crypto/engine";
export { nobleCryptoProvider } from "./crypto/nobleCryptoProvider";
export { generateSigningKey, signRequest, signEnrollmentApproval, verifyInstanceChain, verifyEd25519, type SigningKeyPair, type ChainVerdict } from "./crypto/signing";
export { AtRestCipher, storageKeyName } from "./crypto/atRest";
export { generateTransferKey, transferKeyFromSecret, transferKeyName, sealTo, openWith, type TransferKeyPair } from "./crypto/transfer";
export { encryptArchive, decryptArchive, generateArchiveKey } from "./crypto/archive";
export {
  generateRecoveryPhrase,
  validateRecoveryPhrase,
  normalizeRecoveryPhrase,
  canonicalRecoveryPhrase,
  deriveBackupKey,
  backupKeyCheck,
  backupKeyMatches,
  backupKeyName,
  RECOVERY_PHRASE_WORDS,
} from "./crypto/backupKey";
export { backupDue, BACKUP_AUTO_REFRESH_EVENTS, BACKUP_AUTO_REFRESH_AGE_MS } from "./backup/service";
export { PRESENCE_UNKNOWN } from "./presence/service";
export { challengeFingerprint, instanceKeyName } from "./instance/manager";
export { project as projectTimeline } from "./messages/projection";
export type { Logger } from "./util/logger";
export { base64Encode, base64Decode } from "./util/bytes";
export {
  encodeAppMessage,
  decodeAppMessage,
  decodeAppMessageOrIgnore,
  appMessageSchema,
  PRESENCE_HEARTBEAT_MS,
  AppMessageDecodeError,
  type AppMessage,
  type AppMessageKind,
  type EventRef,
  type MediaKind,
  type Archive,
  type ArchiveManifest,
  type HistoryOffer,
  type AccountBackup,
} from "@allo/shared-types";

import * as testingModule from "./testing/index";
/** In-memory adapters and the fake v1 server, for tests of this package and its consumers. */
export const testing = testingModule;
