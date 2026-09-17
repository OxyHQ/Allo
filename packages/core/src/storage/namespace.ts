/**
 * Every key the SDK writes is `allo/<appId>/<accountId>/<instanceId>/<kind>/<id>`,
 * so two accounts on one device never see each other's rows and `reset()`
 * can wipe one instance by prefix. The one key outside the instance segment
 * is the instance record itself, `allo/<appId>/<accountId>/self`, because it
 * is what tells us the instance id.
 */
export class Namespace {
  constructor(
    readonly appId: string,
    readonly accountId: string,
  ) {}

  get accountPrefix(): string {
    return `allo/${this.appId}/${this.accountId}/`;
  }

  get selfKey(): string {
    return `${this.accountPrefix}self`;
  }

  forInstance(instanceId: string): InstanceNamespace {
    return new InstanceNamespace(this, instanceId);
  }
}

export type RecordKind =
  | "conversation"
  | "groupState"
  | "pendingCommit"
  | "event"
  | "outbox"
  | "cursor"
  | "keyPackage"
  | "mediaKey"
  | "queued";

export class InstanceNamespace {
  constructor(
    readonly root: Namespace,
    readonly instanceId: string,
  ) {}

  get prefix(): string {
    return `${this.root.accountPrefix}${this.instanceId}/`;
  }

  kindPrefix(kind: RecordKind): string {
    return `${this.prefix}${kind}/`;
  }

  key(kind: RecordKind, ...parts: string[]): string {
    return `${this.kindPrefix(kind)}${parts.join("/")}`;
  }
}

/** Server seqs are dense integers; zero-padding keeps prefix listings in seq order. */
export function seqKey(seq: number): string {
  return String(seq).padStart(12, "0");
}
