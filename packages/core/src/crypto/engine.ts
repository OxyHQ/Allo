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
 * External joins (RFC 9420 §12.4.3.2, `spikes/mls/RESULTS-external-join.md`):
 *  5. EVERY COMMIT PUBLISHES: {@link CryptoEngine.commit} and
 *     {@link CryptoEngine.joinExternal} hand back the GroupInfo of the epoch
 *     they create (`external_pub` + `ratchet_tree`, wired as `mls_group_info`)
 *     so the caller uploads it in the same request as the commit, and a device
 *     that is a member with no leaf can join from it with nobody else online.
 *  6. ADMISSION BEFORE PROCESSING: a commit from a `new_member_commit` sender
 *     is validated by {@link CryptoEngine.processIncoming} BEFORE the library
 *     sees it, because the library's callback shows neither the joiner's leaf
 *     nor its credential (spike §6 point 3) and because it does not enforce
 *     signature-key uniqueness for the committer's own leaf (spike §7 gap 2).
 *     The joiner's credential must name an instance of the account's verified
 *     chain carrying that signing key, and neither the key nor the instance id
 *     may already be active in the tree unless the same commit removes that
 *     leaf (a resync). A refused commit throws {@link JoinRefusedError} with the
 *     state untouched.
 *  7. A RESYNC THAT REMOVES US: the library hard-codes `selfRemoved: false`
 *     for external commits (spike §7 gap 1), so a state whose leaf a resync
 *     replaced dies with an `InternalError` instead of `removedFromGroup`;
 *     `processIncoming` reports `removedSelf` for it.
 *
 * Every private key inside a state is serialised in the clear by
 * `serializeGroup`; the store encrypts it at rest.
 */
import {
  acceptAll,
  createApplicationMessage,
  createCommit,
  createGroup,
  createGroupInfoWithExternalPubAndRatchetTree,
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
  joinGroupExternal,
  processMessage,
  type CiphersuiteImpl,
  type ClientConfig,
  type ClientState,
  type Credential,
  type CryptoProvider,
  type GroupInfo,
  type KeyPackage,
  type MLSMessage,
  type PrivateKeyPackage,
  type Proposal,
  type PublicMessage,
  type RatchetTree,
} from "ts-mls";
import { DecryptError, FutureEpochError, InvalidStateError, JoinRefusedError } from "../errors";
import { base64Decode, bytesEqual, concatBytes, sha256Bytes, utf8Decode, utf8Encode, varLenData } from "../util/bytes";
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

/** The leaf an external commit adds, read off the wire before the library processes it. */
export interface ExternalJoiner {
  accountId: string;
  instanceId: string;
  signaturePublicKey: Uint8Array;
  /** Leaf indexes the same commit removes: a resync removes the joiner's former leaf, nothing else is allowed. */
  removedLeafIndexes: number[];
}

/**
 * What {@link CryptoEngine.processIncoming} asks before admitting an external
 * joiner: the account's chain-verified active instances, with the Ed25519 key
 * the server enrolled for each (base64). The callers hold the listings; the
 * engine holds the rule.
 */
export interface JoinerAdmission {
  trustedInstancesOf(accountId: string): Promise<Array<{ id: string; signingPublicKey: string }>>;
}

export interface CommitResult {
  commit: Uint8Array;
  welcome: Uint8Array | undefined;
  /** The state AFTER the commit; the caller keeps it aside until the server accepts (invariant 2). */
  next: GroupState;
  added: Array<{ accountId: string; instanceId: string }>;
  /** The GroupInfo of the epoch `next` is at, wired as `mls_group_info`: uploaded with the commit (invariant 5). */
  groupInfo: Uint8Array;
}

export interface ExternalJoinResult {
  /** The external commit on the wire (`mls_public_message`, sender `new_member_commit`). */
  commit: Uint8Array;
  /** The joiner's state at `epoch + 1`, adopted only once the server accepted the commit. */
  next: GroupState;
  /** The epoch the GroupInfo described: the commit is posted AT it and creates `epoch + 1`. */
  epoch: number;
  /** The GroupInfo of `epoch + 1`, signed by the joiner's new leaf (spike 3f). */
  groupInfo: Uint8Array;
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
  async commit(state: GroupState, changes: { addKeyPackages?: Uint8Array[]; removeLeafIndexes?: number[] }): Promise<CommitResult> {
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
      groupInfo: await this.publishGroupInfo(res.newState),
    };
  }

  addMembers(state: GroupState, keyPackagesWire: Uint8Array[]): Promise<CommitResult> {
    return this.commit(state, { addKeyPackages: keyPackagesWire });
  }

  async removeMembers(state: GroupState, leafIndexes: number[]): Promise<{ commit: Uint8Array; next: GroupState; groupInfo: Uint8Array }> {
    const r = await this.commit(state, { removeLeafIndexes: leafIndexes });
    return { commit: r.commit, next: r.next, groupInfo: r.groupInfo };
  }

  // ---- external join ---------------------------------------------------------

  /**
   * The GroupInfo of the state's current epoch with `external_pub` and the
   * ratchet tree, signed by this leaf, wired as `mls_group_info`. What the
   * server stores and what {@link joinExternal} consumes. It carries no
   * secret (spike 1e); membership is what it discloses, so the server gates
   * the read by a member row.
   */
  async publishGroupInfo(state: GroupState): Promise<Uint8Array> {
    this.assertActive(state);
    const groupInfo = await createGroupInfoWithExternalPubAndRatchetTree(state, [], this.impl);
    return encodeMlsMessage({ wireformat: "mls_group_info", version: "mls10", groupInfo });
  }

  decodeGroupInfo(wire: Uint8Array): GroupInfo {
    const m = this.unwire(wire);
    if (m.wireformat !== "mls_group_info") throw new InvalidStateError("expected an mls_group_info");
    return m.groupInfo;
  }

  /**
   * Joins the group described by a stored GroupInfo with a fresh key package
   * signed by the identity's long-lived key (RFC 9420 §12.4.3.2). Nothing is
   * adopted here: `next` becomes live only once the server accepted `commit`
   * (a stale GroupInfo costs one `epoch_conflict` round trip, spike 3d).
   *
   * `resync` is for a device that lost its group state but kept its signing
   * key: the commit removes the former leaf carrying that key and adds the new
   * one, so membership is unchanged (spike 4e). It is refused when the tree
   * holds no such leaf; a plain join is refused when it does, because every
   * member would refuse the commit (invariant 6) after the server accepted
   * it, which is a fork. The library exports no tree decoder, so the tree is
   * read off a probe join: the plain join IS the probe, a resync costs one more.
   */
  async joinExternal(identity: Identity, groupInfoWire: Uint8Array, options: { resync: boolean }): Promise<ExternalJoinResult> {
    const groupInfo = this.decodeGroupInfo(groupInfoWire);
    const [own] = await this.generateKeyPackages(identity, 1);
    const join = async (resync: boolean) => {
      try {
        return await joinGroupExternal(groupInfo, own.keyPackage, own.privatePackage, resync, this.impl, undefined, this.clientConfig);
      } catch (cause) {
        throw new DecryptError("the GroupInfo could not be joined", { cause });
      }
    };
    let res = await join(false);
    const mine = res.newState.privatePath.leafIndex;
    const former = leavesOf(res.newState.ratchetTree).filter(
      (l) => l.leafIndex !== mine && (l.instanceId === identity.instanceId || bytesEqual(l.signaturePublicKey, identity.signingKey.publicKey)),
    );
    if (options.resync) {
      if (former.length === 0) throw new InvalidStateError("resync: the tree holds no leaf of this instance");
      res = await join(true);
    } else if (former.length > 0) {
      throw new InvalidStateError("this instance already holds a leaf in the tree; resync instead");
    }
    return {
      commit: encodeMlsMessage({ wireformat: "mls_public_message", version: "mls10", publicMessage: res.publicMessage }),
      next: res.newState,
      epoch: Number(groupInfo.groupContext.epoch),
      groupInfo: await this.publishGroupInfo(res.newState),
    };
  }

  /**
   * The joiner of an external commit, or `null` for any other message. Reads
   * `path.leafNode` of a `new_member_commit` commit, which is public on the
   * wire. Throws {@link JoinRefusedError} for an external commit whose leaf
   * cannot be read: no path, or a credential that is not an Allo identity.
   */
  externalJoinerOf(message: Uint8Array): ExternalJoiner | null {
    const m = this.unwire(message);
    if (m.wireformat !== "mls_public_message") return null;
    return this.joinerOf(m.publicMessage);
  }

  private joinerOf(pm: PublicMessage): ExternalJoiner | null {
    const { content } = pm;
    if (content.contentType !== "commit" || content.sender.senderType !== "new_member_commit") return null;
    const path = content.commit.path;
    if (!path) throw new JoinRefusedError("an external commit carries no path");
    const cred = path.leafNode.credential;
    const id = cred.credentialType === "basic" ? parseIdentity(cred.identity) : null;
    if (!id) throw new JoinRefusedError("the joiner's credential is not an Allo identity");
    const removedLeafIndexes: number[] = [];
    for (const p of content.commit.proposals) {
      if (p.proposalOrRefType !== "proposal") throw new JoinRefusedError("an external commit carries proposals by value only");
      if (p.proposal.proposalType === "remove") removedLeafIndexes.push(p.proposal.remove.removed);
    }
    return { accountId: id.accountId, instanceId: id.instanceId, signaturePublicKey: path.leafNode.signaturePublicKey, removedLeafIndexes };
  }

  /**
   * Invariant 6. Throws {@link JoinRefusedError}; the state is never touched.
   * Exposed so a caller can judge a joiner without processing.
   */
  async admitJoiner(state: GroupState, joiner: ExternalJoiner, admission: JoinerAdmission | undefined): Promise<void> {
    if (!admission) throw new JoinRefusedError("no admission policy for an external joiner");
    const members = this.membersOf(state);
    // Every leaf the commit removes must be the joiner's own former one (a resync), by instance id or by key.
    for (const idx of joiner.removedLeafIndexes) {
      const leaf = members.find((m) => m.leafIndex === idx);
      if (!leaf || (leaf.instanceId !== joiner.instanceId && !bytesEqual(leaf.signaturePublicKey, joiner.signaturePublicKey))) {
        throw new JoinRefusedError(`an external commit may only remove the joiner's own former leaf (leaf ${idx})`);
      }
    }
    const removed = new Set(joiner.removedLeafIndexes);
    for (const m of members) {
      if (removed.has(m.leafIndex)) continue;
      if (m.instanceId === joiner.instanceId) throw new JoinRefusedError(`instance ${joiner.instanceId} already holds an active leaf`);
      if (bytesEqual(m.signaturePublicKey, joiner.signaturePublicKey)) throw new JoinRefusedError("the joiner's signing key is already active in the tree");
    }
    const trusted = await admission.trustedInstancesOf(joiner.accountId);
    const enrolled = trusted.find((t) => t.id === joiner.instanceId);
    if (!enrolled) throw new JoinRefusedError(`instance ${joiner.instanceId} is not in the verified chain of ${joiner.accountId}`);
    if (!bytesEqual(base64Decode(enrolled.signingPublicKey), joiner.signaturePublicKey)) {
      throw new JoinRefusedError(`the joiner's signing key is not the one enrolled for instance ${joiner.instanceId}`);
    }
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
   * library refuses, {@link JoinRefusedError} (a `DecryptError`) for an
   * external commit whose joiner `admission` does not admit — or for any
   * external commit when no `admission` is given (invariant 6).
   */
  async processIncoming(state: GroupState, message: Uint8Array, admission?: JoinerAdmission): Promise<ProcessResult> {
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
    const joiner = m.wireformat === "mls_public_message" ? this.joinerOf(m.publicMessage) : null;
    if (joiner) await this.admitJoiner(state, joiner, admission);
    const replacesUs = joiner !== null && joiner.removedLeafIndexes.includes(state.privatePath.leafIndex);
    let result;
    try {
      result = await processMessage(m, state, emptyPskIndex, acceptAll, this.impl);
    } catch (cause) {
      // Invariant 7: a resync by another copy of this instance removed our leaf; the library cannot
      // follow the new epoch (no private key on the update path) and reports that as an InternalError
      // rather than as a removal. We are out either way.
      if (replacesUs) return { next: { ...state, groupActiveState: { kind: "removedFromGroup" } }, kind: "commit", epoch, removedSelf: true };
      throw new DecryptError(`mls ${contentType} rejected`, { cause });
    }
    if (replacesUs) return { next: { ...result.newState, groupActiveState: { kind: "removedFromGroup" } }, kind: "commit", epoch, removedSelf: true };
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
    return leavesOf(state.ratchetTree);
  }

  /** This leaf's index in the tree. */
  ownLeafIndex(state: GroupState): number {
    return state.privatePath.leafIndex;
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

function leavesOf(tree: RatchetTree): LeafInfo[] {
  const out: LeafInfo[] = [];
  tree.forEach((node, i) => {
    if (i % 2 !== 0 || !node || node.nodeType !== "leaf") return;
    const cred = node.leaf.credential;
    const id = cred.credentialType === "basic" ? parseIdentity(cred.identity) : null;
    if (!id) return;
    out.push({ leafIndex: i / 2, accountId: id.accountId, instanceId: id.instanceId, signaturePublicKey: node.leaf.signaturePublicKey });
  });
  return out;
}
