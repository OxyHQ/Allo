/**
 * History transfer between instances and encrypted backup are Phase 3.
 * A new instance sees a conversation from the epoch it joined; nothing
 * before it is decryptable, by design (`docs/platform/roadmap.md`).
 */
import { NotImplementedError } from "../errors";

const DOCS = "docs/platform/roadmap.md (Phase 3: history transfer and backup)";

export class HistoryService {
  /** Ask another of the account's instances to share history for this device. Phase 3. */
  async requestFrom(instanceId: string): Promise<never> {
    void instanceId;
    throw new NotImplementedError("history transfer", DOCS);
  }

  /** Enable encrypted history backup for the account. Phase 3. */
  async enableBackup(): Promise<never> {
    throw new NotImplementedError("history backup", DOCS);
  }
}
