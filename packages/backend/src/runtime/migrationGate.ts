/**
 * The boot-time migration gate, made aware of Allo's two-phase deploy.
 *
 * `deploy-aws.yml` applies migrations in two one-shots: `--phase=pre` BEFORE
 * the rollout and `--phase=post` AFTER it. So while the new image is rolling
 * out, every `post`-phase migration it ships is, by contract, still pending —
 * and a boot check that demands the whole journal be applied refuses to start
 * exactly the release that carries one. Measured on 2026-09-17: the first
 * platform release shipped `0005_retire_legacy_messaging` (post), the `pre`
 * one-shot applied `0004`, every new task then died with
 * `MigrationsNotCurrentError: … 0005_retire_legacy_messaging`, ECS rolled the
 * service back, and the `post` one-shot never ran — a deploy that cannot
 * complete by construction.
 *
 * The rule here: a pending `pre` migration is the failure the gate exists for
 * (the one-shot did not run, or ran against the wrong database) and refuses
 * the boot; a pending `post` migration is the expected mid-rollout state and
 * is allowed through with a warning. A pending migration whose phase cannot
 * be read is refused: an image shipped without its migration files must never
 * read as "nothing to wait for".
 */
import {
  MigrationsNotCurrentError,
  assertPostgresMigrationsCurrent,
  readJournal,
  readMigrationPhases,
  type DeployPhase,
  type JournalEntry,
} from "@oxy.so/db/migrate";
import type postgres from "postgres";

export interface PendingMigrationVerdict {
  /** Pending migrations the boot may proceed without: `post`-phase ones. */
  readonly tolerated: readonly string[];
  /** Pending migrations that refuse the boot, each with the reason. */
  readonly refused: readonly { tag: string; reason: string }[];
}

/** Pure: which pending migrations block a boot and which are expected mid-rollout. */
export function classifyPendingMigrations(
  pending: readonly JournalEntry[],
  phases: ReadonlyMap<string, DeployPhase>,
  problems: readonly string[] = [],
): PendingMigrationVerdict {
  const tolerated: string[] = [];
  const refused: { tag: string; reason: string }[] = [];
  for (const entry of pending) {
    const phase = phases.get(entry.tag);
    if (phase === "post") {
      tolerated.push(entry.tag);
    } else if (phase === "pre") {
      refused.push({ tag: entry.tag, reason: "a pre-phase migration is applied before the rollout and is missing" });
    } else {
      const problem = problems.find((line) => line.includes(entry.tag)) ?? "its phase marker could not be read";
      refused.push({ tag: entry.tag, reason: problem });
    }
  }
  return { tolerated, refused };
}

export class PreMigrationsPendingError extends Error {
  constructor(readonly refused: readonly { tag: string; reason: string }[]) {
    super(
      "Postgres schema is not current: " +
        refused.map((r) => `${r.tag} (${r.reason})`).join("; ") +
        ". Apply the pre-phase migrations with the deployment one-shot before this task can serve traffic.",
    );
    this.name = "PreMigrationsPendingError";
  }
}

/**
 * Boot gate: refuse when a `pre` migration is pending, tolerate pending `post`
 * ones (the deploy applies them after the rollout) and say so in the log.
 */
export async function assertPreMigrationsCurrent(
  client: postgres.Sql,
  migrationsFolder: string,
  log: { warn(message: string, meta?: Record<string, unknown>): void },
): Promise<void> {
  const journal = readJournal(migrationsFolder);
  try {
    await assertPostgresMigrationsCurrent(client, journal);
  } catch (error) {
    if (!(error instanceof MigrationsNotCurrentError)) throw error;
    const { phases, problems } = readMigrationPhases(
      error.pending.map((entry) => entry.tag),
      migrationsFolder,
    );
    const verdict = classifyPendingMigrations(error.pending, phases, problems);
    if (verdict.refused.length > 0) throw new PreMigrationsPendingError(verdict.refused);
    log.warn("post-phase migrations pending; the deploy applies them after this rollout", {
      count: verdict.tolerated.length,
      tags: verdict.tolerated.join(","),
    });
  }
}
