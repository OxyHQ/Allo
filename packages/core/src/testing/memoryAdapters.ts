/**
 * In-memory implementations of the host adapters, for tests. `MemoryStorage`
 * exposes its raw bytes so a test can prove what never reaches disk.
 */
import type { OxySessionAdapter, SecretStore, StorageAdapter, StorageOp } from "../types";
import { concatBytes } from "../util/bytes";

export class MemoryStorage implements StorageAdapter {
  readonly map = new Map<string, Uint8Array>();
  writes = 0;

  async get(key: string): Promise<Uint8Array | undefined> {
    const v = this.map.get(key);
    return v ? new Uint8Array(v) : undefined;
  }
  async set(key: string, value: Uint8Array): Promise<void> {
    this.writes++;
    this.map.set(key, new Uint8Array(value));
  }
  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }
  async list(prefix: string): Promise<string[]> {
    return [...this.map.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
  async batch(ops: StorageOp[]): Promise<void> {
    for (const op of ops) {
      if (op.type === "set") {
        this.writes++;
        this.map.set(op.key, new Uint8Array(op.value));
      } else this.map.delete(op.key);
    }
  }
  /** Every stored byte, concatenated, for "this must never be on disk" assertions. */
  dump(): Uint8Array {
    return concatBytes(...this.map.values());
  }
  clone(): MemoryStorage {
    const s = new MemoryStorage();
    for (const [k, v] of this.map) s.map.set(k, new Uint8Array(v));
    return s;
  }
}

export class MemorySecrets implements SecretStore {
  readonly map = new Map<string, Uint8Array>();
  async get(name: string): Promise<Uint8Array | undefined> {
    const v = this.map.get(name);
    return v ? new Uint8Array(v) : undefined;
  }
  async set(name: string, value: Uint8Array): Promise<void> {
    this.map.set(name, new Uint8Array(value));
  }
  async delete(name: string): Promise<void> {
    this.map.delete(name);
  }
  dump(): Uint8Array {
    return concatBytes(...this.map.values());
  }
}

export class FakeSession implements OxySessionAdapter {
  private listeners = new Set<() => void>();
  constructor(
    private accountId: string | null,
    private token: string | null,
  ) {}
  static for(accountId: string): FakeSession {
    return new FakeSession(accountId, FakeSession.tokenFor(accountId));
  }
  static tokenFor(accountId: string): string {
    return `fake-token:${accountId}`;
  }
  static accountFromToken(token: string): string | null {
    return token.startsWith("fake-token:") ? token.slice("fake-token:".length) : null;
  }
  async getAccessToken(): Promise<string | null> {
    return this.token;
  }
  getAccountId(): string | null {
    return this.accountId;
  }
  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  signOut(): void {
    this.accountId = null;
    this.token = null;
    for (const l of this.listeners) l();
  }
}
