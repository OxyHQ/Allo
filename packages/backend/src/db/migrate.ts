/**
 * The ONLY thing that applies migrations for this service.
 *
 * Run as `npm run db:migrate -- --target-database=<name> --phase=pre|post|all`.
 * Never `drizzle-kit migrate`: that is a devDependency and cannot be reached
 * from the production image, so a deploy relying on it would have no migrator
 * at all.
 *
 * ## Phases
 *
 * Every generated `.sql` carries exactly one `-- oxy:deploy-phase=pre`
 * (additive) or `-- oxy:deploy-phase=post` (drops, renames, narrows) marker.
 * There is no default: the migrator refuses a file that does not say which side
 * of a rollout it belongs to, because guessing wrong takes production down in
 * the direction that is hardest to reverse.
 *
 * `--phase=all` is for a from-zero genesis run ONLY. On a live database it would
 * apply a destructive migration before the image that tolerates it is running.
 *
 * ## `--target-database` is required
 *
 * `@oxyhq/db` makes the guard optional so a service can adopt the runner without
 * rewriting every invocation. This service adopts it from day one, so there is
 * no legacy invocation to protect: a `DATABASE_URL` pointing somewhere
 * unexpected fails loudly instead of migrating another tenant's database on the
 * shared instance.
 */

import { join } from "node:path";
import {
  MIGRATION_RUNS,
  type MigrationRun,
  readTargetDatabase,
  runMigrations,
} from "@oxyhq/db/migrate";

const PACKAGE_ROOT = join(__dirname, "..", "..");

/** `--dry-run` reports what WOULD be applied and writes nothing, not even the ledger. */
function isDryRun(argv: readonly string[]): boolean {
  return argv.includes("--dry-run");
}

/**
 * Read `--phase=<pre|post|all>`, with NO default.
 *
 * An unrecognised value throws rather than falling back: silently running `all`
 * for someone who typed `--phase=pre-deploy` is precisely the
 * drop-applied-too-early outage the phases exist to prevent.
 */
function readPhase(argv: readonly string[]): MigrationRun {
  const prefix = "--phase=";
  const flag = argv.find((arg) => arg.startsWith(prefix));
  if (!flag) {
    throw new Error(`--phase is required. Use one of: ${MIGRATION_RUNS.join(", ")}.`);
  }

  const value = flag.slice(prefix.length).trim();
  if (!(MIGRATION_RUNS as readonly string[]).includes(value)) {
    throw new Error(
      `Unrecognised --phase=${JSON.stringify(value)}. Use one of: ${MIGRATION_RUNS.join(", ")}.`,
    );
  }
  return value as MigrationRun;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  // Parsed before DATABASE_URL is read and before anything opens a socket, so an
  // operator who forgot a flag learns it instantly rather than after a connect.
  const run = readPhase(argv);
  const expectedDatabase = readTargetDatabase(argv);

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to run migrations");
  }

  await runMigrations({
    databaseUrl,
    migrationsFolder: join(PACKAGE_ROOT, "drizzle"),
    /**
     * None. This schema uses no PostGIS, no pgvector and no pg_trgm — and an
     * extension is a PRIVILEGED operation the owning role cannot perform, so a
     * `CREATE EXTENSION IF NOT EXISTS` "safety net" here would be a silent no-op
     * where it is already installed and a hard failure where it is not.
     */
    extensions: [],
    run,
    expectedDatabase,
    dryRun: isDryRun(argv),
    logger: {
      info: (message) => console.info(message),
      debug: (message) => console.debug(message),
    },
  });
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
