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
  StorageError,
  TransportError,
  type AlloErrorCodeName,
} from "./errors";
export { CryptoEngine, CIPHERSUITE_ID, keyPackageRefFromWire, identityString, parseIdentity, type GroupState, type Identity, type KeyPackageBundle, type LeafInfo } from "./crypto/engine";
export { nobleCryptoProvider } from "./crypto/nobleCryptoProvider";
export { generateSigningKey, signRequest, signEnrollmentApproval, verifyInstanceChain, verifyEd25519, type SigningKeyPair, type ChainVerdict } from "./crypto/signing";
export { AtRestCipher, storageKeyName } from "./crypto/atRest";
export { challengeFingerprint, instanceKeyName } from "./instance/manager";
export { project as projectTimeline } from "./messages/projection";
export type { Logger } from "./util/logger";
export { base64Encode, base64Decode } from "./util/bytes";
export {
  encodeAppMessage,
  decodeAppMessage,
  appMessageSchema,
  AppMessageDecodeError,
  type AppMessage,
  type AppMessageKind,
  type EventRef,
  type MediaKind,
} from "@allo/shared-types";

import * as testingModule from "./testing/index";
/** In-memory adapters and the fake v1 server, for tests of this package and its consumers. */
export const testing = testingModule;
