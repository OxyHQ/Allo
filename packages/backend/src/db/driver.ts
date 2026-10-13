/**
 * Which Postgres client the backend drives its connections through.
 *
 * `DATABASE_DRIVER` selects it, and it is OPT-IN: unset (or empty) means
 * `postgres-js`, the client this service has always run on. `bun-sql` selects
 * Bun's built-in `Bun.SQL` through `@oxy.so/db`'s `driver: 'bun-sql'`. The one
 * variable governs the runtime pool (`connectPostgres`), the migrator
 * (`db:migrate`, which the deploy's one-shots run on the service's own task
 * definition and therefore read the same value) and the test harness.
 *
 * Any other value is refused rather than read as the default: an operator who
 * sets `DATABASE_DRIVER=bunsql` believes the flag is on, and a task that
 * quietly kept postgres.js would make every measurement taken afterwards a
 * measurement of the wrong client.
 */

import { DATABASE_DRIVERS, DEFAULT_DATABASE_DRIVER, type DatabaseDriver } from '@oxy.so/db';

export const DATABASE_DRIVER_ENV = 'DATABASE_DRIVER';

export function readDatabaseDriver(
  env: Readonly<Record<string, string | undefined>> = process.env,
): DatabaseDriver {
  const raw = env[DATABASE_DRIVER_ENV]?.trim();
  if (!raw) return DEFAULT_DATABASE_DRIVER;
  const known = DATABASE_DRIVERS.find((driver) => driver === raw);
  if (!known) {
    throw new Error(
      `${DATABASE_DRIVER_ENV}=${JSON.stringify(raw)} is not a database driver. ` +
        `Use one of: ${DATABASE_DRIVERS.join(', ')} (unset means ${DEFAULT_DATABASE_DRIVER}).`,
    );
  }
  return known;
}
