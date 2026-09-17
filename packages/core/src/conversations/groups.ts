/**
 * One live MLS state per conversation. Every module that changes a state
 * does so through {@link GroupRegistry.set}, which writes the new bytes into
 * the caller's batch, so the persisted state and the in-memory one never
 * disagree for longer than one batch commit.
 */
import type { CryptoEngine, GroupState } from "../crypto/engine";
import type { InstanceStore, StoreBatch } from "../storage/store";

export class GroupRegistry {
  private readonly states = new Map<string, GroupState>();

  constructor(
    private readonly engine: CryptoEngine,
    private readonly store: InstanceStore,
  ) {}

  async load(): Promise<void> {
    for (const id of await this.store.listIds("groupState")) {
      const bytes = await this.store.getBytes("groupState", id);
      if (bytes) this.states.set(id, this.engine.deserializeGroup(bytes));
    }
  }

  get(conversationId: string): GroupState | undefined {
    return this.states.get(conversationId);
  }

  has(conversationId: string): boolean {
    return this.states.has(conversationId);
  }

  ids(): string[] {
    return [...this.states.keys()];
  }

  /** Stages the new state in `batch`; call {@link commitInMemory} once the batch is committed. */
  stage(batch: StoreBatch, conversationId: string, state: GroupState): void {
    batch.putBytes("groupState", conversationId, this.engine.serializeGroup(state));
  }

  commitInMemory(conversationId: string, state: GroupState): void {
    this.states.set(conversationId, state);
  }

  /** Stage + set in one go for callers that commit right after. */
  set(batch: StoreBatch, conversationId: string, state: GroupState): void {
    this.stage(batch, conversationId, state);
    this.commitInMemory(conversationId, state);
  }

  drop(batch: StoreBatch, conversationId: string): void {
    batch.delete("groupState", conversationId);
    this.states.delete(conversationId);
  }
}
