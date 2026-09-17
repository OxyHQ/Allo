/**
 * `CryptoEngine`: the MLS engine behind everything else, wrapping ts-mls so
 * the library can be swapped without touching sync, outbox or conversations.
 *
 * ts-mls is functional (every call returns a new state and mutates nothing),
 * which is what makes the four invariants the spike found cheap to own here
 * or in the callers:
 *  1. EPOCH GATING: {@link CryptoEngine.processIncoming} compares the decoded
 *     message's epoch with the state's before the library sees it. A future
 *     epoch throws {@link FutureEpochError} with the state untouched, so the
 *     caller queues the message; without the check the library fails with an
 *     AEAD error indistinguishable from corruption.
 *  2. PENDING COMMIT: `addMembers` / `removeMembers` return `next` and leave
 *     the input state alone. The caller persists the pre-commit state, keeps
 *     `next` aside, and swaps it in only when the server accepted the commit.
 *  3. WELCOME AFTER ACK: a Welcome is only ever handed out from an accepted
 *     commit (the outbox sends it in the same request as the commit).
 *  4. ONE LIVE COPY: callers hold exactly one state per group; the engine
 *     never caches one.
 *
 * Every private key inside a state is serialised in the clear by
 * `serializeGroup`; the store encrypts it at rest.
 */
import {
  acceptAll,
  createApplicationMessage,
  createCommit,
  createGroup,
  decodeGroupState,
  decodeMlsMessage,
  defaultCapabilities,
  defaultKeyPackageEqualityConfig,
  defaultKeyRetentionConfig,
  defaultLifetime,
  defaultLifetimeConfig,
  emptyPskIndex,
  encodeGroupState,
  encodeMlsMessage,
  generateKeyPackageWithKey,
  getCiphersuiteFromName,
  getCiphersuiteImpl,
  joinGroup,
  processMessage,
  type CiphersuiteImpl,
  type ClientConfig,
  type ClientState,
  type Credential,
  type CryptoProvider,
  type KeyPackage,
  type MLSMessage,
  type PrivateKeyPackage,
  type Proposal,
} from "ts-mls";
import { DecryptError, FutureEpochError, InvalidStateError } from "../errors";
import { concatBytes, sha256Bytes, utf8Decode, utf8Encode, varLenData } from "../util/bytes";
import { NOBLE_SUITE_NAME, nobleCryptoProvider } from "./nobleCryptoProvider";
import type { SigningKeyPair } from "./signing";

export const CIPHERSUITE_ID = 1;
export const DEFAULT_PAD_UNTIL_LENGTH = 256;

export type GroupState = ClientState;

export interface Identity {
  accountId: string;
  instanceId: string;
  credential: Credential;
  signingKey: SigningKeyPair;
}

export interface KeyPackageBundle {
  /** The KeyPackageRef (RFC 9420 §5.2): what the server indexes and what a Welcome addresses. */
  ref: Uint8Array;
  /** The wire form (`MLSMessage` with `mls_key_package`), what gets uploaded. */
  publicWire: Uint8Array;
  keyPackage: KeyPackage;
  privatePackage: PrivateKeyPackage;
}

export interface LeafInfo {
  leafIndex: number;
  accountId: string;
  instanceId: string;
  signaturePublicKey: Uint8Array;
}

export interface PeekResult {
  kind: "private" | "public" | "welcome" | "key_package" | "group_info";
  epoch: number | null;
  contentType: "application" | "proposal" | "commit" | null;
}

export type ProcessKind = "application" | "commit" | "proposal";

export interface ProcessResult {
  next: GroupState;
  kind: ProcessKind;
  plaintext?: Uint8Array;
  epoch: number;
  /** True when this commit removed our own leaf. `next` cannot send or decrypt further. */
  removedSelf: boolean;
}

export function identityString(accountId: string, instanceId: string): string {
  return `${accountId}:${instanceId}`;
}

export function parseIdentity(identity: Uint8Array): { accountId: string; instanceId: string } | null {
  let text: string;
  try {
    text = utf8Decode(identity);
  } catch {
    return null;
  }
  const i = text.indexOf(":");
  if (i <= 0 || i === text.length - 1) return null;
  const accountId = text.slice(0, i);
  const instanceId = text.slice(i + 1);
  if (instanceId.includes(":")) return null;
  return { accountId, instanceId };
}

const KEY_PACKAGE_REF_LABEL = utf8Encode("MLS 1.0 KeyPackage Reference");

/** RefHash("MLS 1.0 KeyPackage Reference", KeyPackage) — the same bytes ts-mls computes and a Welcome carries. */
export function keyPackageRefFromWire(publicWire: Uint8Array): Uint8Array {
  // MLSMessage = version u16 || wireformat u16 || KeyPackage
  const keyPackageBytes = publicWire.subarray(4);
  return sha256Bytes(concatBytes(varLenData(KEY_PACKAGE_REF_LABEL), varLenData(keyPackageBytes)));
}

export class CryptoEngine {
  private constructor(
    readonly impl: CiphersuiteImpl,
    readonly clientConfig: ClientConfig,
  ) {}

  static async create(provider: CryptoProvider = nobleCryptoProvider, options?: { padUntilLength?: number }): Promise<CryptoEngine> {
    const impl = await getCiphersuiteImpl(getCiphersuiteFromName(NOBLE_SUITE_NAME), provider);
    const clientConfig: ClientConfig = {
      keyRetentionConfig: defaultKeyRetentionConfig,
      lifetimeConfig: defaultLifetimeConfig,
      keyPackageEqualityConfig: defaultKeyPackageEqualityConfig,
      paddingConfig: { kind: "padUntilLength", padUntilLength: options?.padUntilLength ?? DEFAULT_PAD_UNTIL_LENGTH },
      authService: {
        async validateCredential(credential) {
          // A leaf must at least name an account and an instance. Binding the
          // leaf's signature key to the instance the server enrolled is left
          // to the callers, which hold the listings.
          return credential.credentialType === "basic" && parseIdentity(credential.identity) !== null;
        },
      },
    };
    return new CryptoEngine(impl, clientConfig);
  }

  createIdentity(input: { accountId: string; instanceId: string; signingKey: SigningKeyPair }): Identity {
    return {
      accountId: input.accountId,
      instanceId: input.instanceId,
      signingKey: input.signingKey,
      credential: { credentialType: "basic", identity: utf8Encode(identityString(input.accountId, input.instanceId)) },
    };
  }

  /** Key packages reuse the instance's long-lived signing key so every leaf of an instance is signed by the key the server enrolled. */
  async generateKeyPackages(identity: Identity, count: number): Promise<KeyPackageBundle[]> {
    const out: KeyPackageBundle[] = [];
    for (let i = 0; i < count; i++) {
      const kp = await generateKeyPackageWithKey(
        identity.credential,
        defaultCapabilities(),
        defaultLifetime,
        [],
        { signKey: identity.signingKey.secretKey, publicKey: identity.signingKey.publicKey },
        this.impl,
      );
      const publicWire = encodeMlsMessage({ wireformat: "mls_key_package", version: "mls10", keyPackage: kp.publicPackage });
      out.push({ ref: keyPackageRefFromWire(publicWire), publicWire, keyPackage: kp.publicPackage, privatePackage: kp.privatePackage });
    }
    return out;
  }

  async createGroup(identity: Identity, groupId: Uint8Array): Promise<GroupState> {
    const [own] = await this.generateKeyPackages(identity, 1);
    return createGroup(groupId, own.keyPackage, own.privatePackage, [], this.impl, this.clientConfig);
  }

  decodeKeyPackage(publicWire: Uint8Array): KeyPackage {
    const m = this.unwire(publicWire);
    if (m.wireformat !== "mls_key_package") throw new InvalidStateError("expected an mls_key_package");
    return m.keyPackage;
  }

  /**
   * One commit carrying any mix of Add and Remove proposals. Returns the
   * wire commit, the Welcome for the added leaves (when any), and `next`,
   * the state AFTER the commit, which the caller keeps aside until the
   * server accepts it (invariant 2).
   */
  async commit(
    state: GroupState,
    changes: { addKeyPackages?: Uint8Array[]; removeLeafIndexes?: number[] },
  ): Promise<{ commit: Uint8Array; welcome: Uint8Array | undefined; next: GroupState; added: Array<{ accountId: string; instanceId: string }> }> {
    this.assertActive(state);
    const proposals: Proposal[] = [];
    const added: Array<{ accountId: string; instanceId: string }> = [];
    for (const wire of changes.addKeyPackages ?? []) {
      const keyPackage = this.decodeKeyPackage(wire);
      const cred = keyPackage.leafNode.credential;
      const id = cred.credentialType === "basic" ? parseIdentity(cred.identity) : null;
      if (!id) throw new InvalidStateError("key package credential is not an Allo identity");
      proposals.push({ proposalType: "add", add: { keyPackage } });
      added.push(id);
    }
    for (const removed of changes.removeLeafIndexes ?? []) proposals.push({ proposalType: "remove", remove: { removed } });
    const res = await createCommit({ state, cipherSuite: this.impl }, { extraProposals: proposals, ratchetTreeExtension: true });
    return {
      commit: encodeMlsMessage(res.commit),
      welcome: res.welcome ? encodeMlsMessage({ wireformat: "mls_welcome", version: "mls10", welcome: res.welcome }) : undefined,
      next: res.newState,
      added,
    };
  }

  addMembers(state: GroupState, keyPackagesWire: Uint8Array[]): ReturnType<CryptoEngine["commit"]> {
    return this.commit(state, { addKeyPackages: keyPackagesWire });
  }

  async removeMembers(state: GroupState, leafIndexes: number[]): Promise<{ commit: Uint8Array; next: GroupState }> {
    const r = await this.commit(state, { removeLeafIndexes: leafIndexes });
    return { commit: r.commit, next: r.next };
  }

  /** The KeyPackageRefs a Welcome is addressed to. */
  welcomeRefs(welcomeWire: Uint8Array): Uint8Array[] {
    const m = this.unwire(welcomeWire);
    if (m.wireformat !== "mls_welcome") throw new InvalidStateError("expected an mls_welcome");
    return m.welcome.secrets.map((s) => s.newMember);
  }

  async joinFromWelcome(welcomeWire: Uint8Array, bundle: KeyPackageBundle): Promise<GroupState> {
    const m = this.unwire(welcomeWire);
    if (m.wireformat !== "mls_welcome") throw new InvalidStateError("expected an mls_welcome");
    try {
      return await joinGroup(m.welcome, bundle.keyPackage, bundle.privatePackage, emptyPskIndex, this.impl, undefined, undefined, this.clientConfig);
    } catch (cause) {
      throw new DecryptError("welcome could not be joined", { cause });
    }
  }

  peek(message: Uint8Array): PeekResult {
    const m = this.unwire(message);
    switch (m.wireformat) {
      case "mls_private_message":
        return { kind: "private", epoch: Number(m.privateMessage.epoch), contentType: m.privateMessage.contentType };
      case "mls_public_message":
        return { kind: "public", epoch: Number(m.publicMessage.content.epoch), contentType: m.publicMessage.content.contentType };
      case "mls_welcome":
        return { kind: "welcome", epoch: null, contentType: null };
      case "mls_key_package":
        return { kind: "key_package", epoch: null, contentType: null };
      case "mls_group_info":
        return { kind: "group_info", epoch: null, contentType: null };
    }
  }

  /**
   * Processes one handshake or application message. Throws
   * {@link FutureEpochError} (state untouched) when the message is from an
   * epoch this state has not reached, {@link DecryptError} on anything the
   * library refuses.
   */
  async processIncoming(state: GroupState, message: Uint8Array): Promise<ProcessResult> {
    const m = this.unwire(message);
    if (m.wireformat !== "mls_private_message" && m.wireformat !== "mls_public_message") {
      throw new DecryptError(`cannot process a ${m.wireformat} as a group message`);
    }
    const epoch = m.wireformat === "mls_private_message" ? Number(m.privateMessage.epoch) : Number(m.publicMessage.content.epoch);
    const contentType = m.wireformat === "mls_private_message" ? m.privateMessage.contentType : m.publicMessage.content.contentType;
    const stateEpoch = this.epochOf(state);
    if (epoch > stateEpoch) throw new FutureEpochError(epoch, stateEpoch);
    if (contentType !== "application" && epoch < stateEpoch) {
      throw new DecryptError(`stale ${contentType} from epoch ${epoch} at state epoch ${stateEpoch}`);
    }
    if (state.groupActiveState.kind !== "active") throw new DecryptError("this leaf is no longer in the group");
    let result;
    try {
      result = await processMessage(m, state, emptyPskIndex, acceptAll, this.impl);
    } catch (cause) {
      throw new DecryptError(`mls ${contentType} rejected`, { cause });
    }
    if (result.kind === "applicationMessage") {
      return { next: result.newState, kind: "application", plaintext: result.message, epoch, removedSelf: false };
    }
    return {
      next: result.newState,
      kind: contentType === "commit" ? "commit" : "proposal",
      epoch,
      removedSelf: result.newState.groupActiveState.kind === "removedFromGroup",
    };
  }

  async encryptApplication(state: GroupState, plaintext: Uint8Array): Promise<{ ciphertext: Uint8Array; next: GroupState }> {
    this.assertActive(state);
    const res = await createApplicationMessage(state, plaintext, this.impl);
    return {
      ciphertext: encodeMlsMessage({ wireformat: "mls_private_message", version: "mls10", privateMessage: res.privateMessage }),
      next: res.newState,
    };
  }

  serializeGroup(state: GroupState): Uint8Array {
    return encodeGroupState(state);
  }

  deserializeGroup(bytes: Uint8Array): GroupState {
    const r = decodeGroupState(bytes, 0);
    if (!r) throw new InvalidStateError("group state bytes did not decode");
    return { ...r[0], clientConfig: this.clientConfig };
  }

  membersOf(state: GroupState): LeafInfo[] {
    const out: LeafInfo[] = [];
    state.ratchetTree.forEach((node, i) => {
      if (i % 2 !== 0 || !node || node.nodeType !== "leaf") return;
      const cred = node.leaf.credential;
      const id = cred.credentialType === "basic" ? parseIdentity(cred.identity) : null;
      if (!id) return;
      out.push({ leafIndex: i / 2, accountId: id.accountId, instanceId: id.instanceId, signaturePublicKey: node.leaf.signaturePublicKey });
    });
    return out;
  }

  epochOf(state: GroupState): number {
    return Number(state.groupContext.epoch);
  }

  groupIdOf(state: GroupState): Uint8Array {
    return state.groupContext.groupId;
  }

  isActive(state: GroupState): boolean {
    return state.groupActiveState.kind === "active";
  }

  private assertActive(state: GroupState): void {
    if (!this.isActive(state)) throw new InvalidStateError("this leaf is no longer in the group");
  }

  private unwire(bytes: Uint8Array): MLSMessage {
    let r: [MLSMessage, number] | undefined;
    try {
      r = decodeMlsMessage(bytes, 0);
    } catch (cause) {
      throw new DecryptError("not an MLS message", { cause });
    }
    if (!r) throw new DecryptError("not an MLS message");
    return r[0];
  }
}
