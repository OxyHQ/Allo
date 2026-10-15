import { pgTable, text, boolean, uniqueIndex } from 'drizzle-orm/pg-core';
import { conversations } from './conversations';
/** Only resource references, account ids and operation state; never housing or message content. */
export const managedTeams = pgTable(
  'managed_teams',
  {
    id: text()
      .primaryKey()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    sourceReference: text().notNull(),
    readCapabilityHash: text().notNull(),
    operationId: text().notNull(),
    frozen: boolean().notNull().default(true),
    targetAccountIds: text().array().notNull(),
  },
  (t) => [uniqueIndex('managed_teams_capability_key').on(t.readCapabilityHash)],
);
