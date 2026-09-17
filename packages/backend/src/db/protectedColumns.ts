/**
 * Columns that must never leave the process in a response.
 *
 * `db.select().from(table)` returns EVERY column, so the first naive rewrite of
 * a query is the first time protected material can be serialized into an HTTP
 * response nobody audited.
 *
 * Read through `publicColumns(table, PROTECTED_COLUMNS)` from `@oxy.so/db/assert`.
 * The exclusion is at the TYPE level: the row type has no such property, so a
 * serializer touching one fails `tsc` rather than shipping it — **provided this
 * stays `as const` and is never re-annotated with the registry type**, which
 * would widen the literals away and silently delete the compile-time half.
 *
 * Opting in is explicit and greppable: a path that legitimately needs one names
 * it. There is deliberately no helper for that — it must read differently from
 * an ordinary select.
 *
 * A new table that stores ciphertext, a credential or a third party's case
 * material registers its columns here in the same change that creates it.
 */
export const PROTECTED_COLUMNS = {
  /**
   * Inbound and outbound moderation payloads, stored whole and opaque. They
   * carry a third party's case material and are for this service's own workers.
   */
  moderation_events: ["payload"],
  moderation_outbox: ["payloadDecision"],
  /**
   * Messaging platform material. Ciphertext, MLS public material meant for
   * exactly one claimer, and a third party's push credential. Each has ONE
   * legitimate reader, named at the opt-in: `GET /v1/blobs/:id` for the bytes,
   * `GET …/events` and `GET /v1/sync` for the payload, the claim for a key
   * package, the delivery worker for the token.
   */
  key_packages: ["data"],
  conversation_events: ["payload"],
  blob_bytes: ["data"],
  client_instances: ["pushToken"],
} as const;
