/**
 * `AlloStore`: the encrypted, namespaced façade every module persists
 * through. A value goes in as JSON (or raw bytes for group state), is
 * encrypted by {@link AtRestCipher} with its own key path as AAD, and only
 * then reaches the host's `StorageAdapter`. Related writes go through one
 * {@link StoreBatch} so a delivery, its state change and the cursor land
 * together or not at all.
 */
import type { z } from "zod";
import { StorageError } from "../errors";
import type { StorageAdapter, StorageOp } from "../types";
import { utf8Decode, utf8Encode } from "../util/bytes";
import type { AtRestCipher } from "../crypto/atRest";
import { InstanceNamespace, Namespace, type RecordKind } from "./namespace";
import { instanceRecordSchema, type InstanceRecord } from "./records";

export class StoreBatch {
  private readonly ops: StorageOp[] = [];
  constructor(
    private readonly cipher: AtRestCipher,
    private readonly ns: InstanceNamespace,
  ) {}

  putJson(kind: RecordKind, id: string, value: unknown): this {
    const key = this.ns.key(kind, id);
    this.ops.push({ type: "set", key, value: this.cipher.encrypt(key, utf8Encode(JSON.stringify(value))) });
    return this;
  }

  putBytes(kind: RecordKind, id: string, value: Uint8Array): this {
    const key = this.ns.key(kind, id);
    this.ops.push({ type: "set", key, value: this.cipher.encrypt(key, value) });
    return this;
  }

  delete(kind: RecordKind, id: string): this {
    this.ops.push({ type: "delete", key: this.ns.key(kind, id) });
    return this;
  }

  get size(): number {
    return this.ops.length;
  }

  take(): StorageOp[] {
    return this.ops.splice(0);
  }
}

export class InstanceStore {
  constructor(
    private readonly storage: StorageAdapter,
    private readonly cipher: AtRestCipher,
    readonly ns: InstanceNamespace,
  ) {}

  get instanceId(): string {
    return this.ns.instanceId;
  }

  batch(): StoreBatch {
    return new StoreBatch(this.cipher, this.ns);
  }

  async commit(batch: StoreBatch): Promise<void> {
    const ops = batch.take();
    if (ops.length === 0) return;
    try {
      await this.storage.batch(ops);
    } catch (cause) {
      throw new StorageError("batch write failed", { cause });
    }
  }

  async getJson<T>(kind: RecordKind, id: string, schema: z.ZodType<T>): Promise<T | undefined> {
    const bytes = await this.getBytes(kind, id);
    if (bytes === undefined) return undefined;
    return this.parse(schema, bytes, this.ns.key(kind, id));
  }

  async putJson(kind: RecordKind, id: string, value: unknown): Promise<void> {
    await this.commit(this.batch().putJson(kind, id, value));
  }

  async getBytes(kind: RecordKind, id: string): Promise<Uint8Array | undefined> {
    const key = this.ns.key(kind, id);
    const stored = await this.storage.get(key);
    if (stored === undefined) return undefined;
    return this.cipher.decrypt(key, stored);
  }

  async putBytes(kind: RecordKind, id: string, value: Uint8Array): Promise<void> {
    await this.commit(this.batch().putBytes(kind, id, value));
  }

  async delete(kind: RecordKind, id: string): Promise<void> {
    await this.commit(this.batch().delete(kind, id));
  }

  /** Every record of a kind, in key order (ids are sortable by construction). */
  async listJson<T>(kind: RecordKind, schema: z.ZodType<T>, idPrefix = ""): Promise<Array<{ id: string; value: T }>> {
    const prefix = this.ns.kindPrefix(kind) + idPrefix;
    const keys = (await this.storage.list(prefix)).sort();
    const out: Array<{ id: string; value: T }> = [];
    for (const key of keys) {
      const stored = await this.storage.get(key);
      if (stored === undefined) continue;
      out.push({ id: key.slice(this.ns.kindPrefix(kind).length), value: this.parse(schema, this.cipher.decrypt(key, stored), key) });
    }
    return out;
  }

  async listIds(kind: RecordKind, idPrefix = ""): Promise<string[]> {
    const keys = await this.storage.list(this.ns.kindPrefix(kind) + idPrefix);
    return keys.map((k) => k.slice(this.ns.kindPrefix(kind).length)).sort();
  }

  /** Deletes everything under this instance. */
  async wipe(): Promise<void> {
    const keys = await this.storage.list(this.ns.prefix);
    if (keys.length) await this.storage.batch(keys.map((key) => ({ type: "delete", key }) as const));
  }

  private parse<T>(schema: z.ZodType<T>, bytes: Uint8Array, key: string): T {
    let json: unknown;
    try {
      json = JSON.parse(utf8Decode(bytes));
    } catch (cause) {
      throw new StorageError(`record is not JSON: ${key}`, { cause });
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw new StorageError(`record does not match its schema: ${key}`, { cause: parsed.error });
    return parsed.data;
  }
}

export class AlloStore {
  constructor(
    private readonly storage: StorageAdapter,
    private readonly cipher: AtRestCipher,
    readonly ns: Namespace,
  ) {}

  async getSelf(): Promise<InstanceRecord | undefined> {
    const stored = await this.storage.get(this.ns.selfKey);
    if (stored === undefined) return undefined;
    const json: unknown = JSON.parse(utf8Decode(this.cipher.decrypt(this.ns.selfKey, stored)));
    const parsed = instanceRecordSchema.safeParse(json);
    if (!parsed.success) throw new StorageError("instance record does not match its schema", { cause: parsed.error });
    return parsed.data;
  }

  async setSelf(record: InstanceRecord): Promise<void> {
    await this.storage.set(this.ns.selfKey, this.cipher.encrypt(this.ns.selfKey, utf8Encode(JSON.stringify(record))));
  }

  forInstance(instanceId: string): InstanceStore {
    return new InstanceStore(this.storage, this.cipher, this.ns.forInstance(instanceId));
  }

  /** Wipes the whole account namespace: the instance record and every instance under it. */
  async wipeAccount(): Promise<void> {
    const keys = await this.storage.list(this.ns.accountPrefix);
    if (keys.length) await this.storage.batch(keys.map((key) => ({ type: "delete", key }) as const));
  }
}
