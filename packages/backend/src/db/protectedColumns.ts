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
  /**
   * The conversation's GroupInfo: public MLS material, but whoever holds it can
   * attempt an external join, so it is served by `GET …/group-info` to a
   * joined member (`groupInfoRepository.ts` names the opt-in) and by no
   * listing.
   */
  conversation_group_info: ["data"],
  /**
   * Archive key material. `sealed_key` is the archive key sealed to ONE
   * recipient's transfer key and is for that recipient alone; `key_check` is
   * an HMAC under the backup key, which a wrong-phrase guesser could grind
   * against offline. Both are returned by exactly the routes that hand them to
   * their owner (`historyRepository.ts` names the opt-in) and by no listing.
   */
  history_offers: ["sealedKey"],
  account_backups: ["keyCheck"],
  /**
   * A status update's body, and the per-status key sealed to ONE recipient
   * device. The body is AES-256-GCM under a key the server never holds; the
   * sealed key opens only with that device's transfer private key. Both are
   * returned by the two routes that hand them to the device they belong to
   * (`statusRepository.ts` names the opt-in) and by no listing of anybody
   * else's.
   */
  statuses: ["payload", "nonce"],
  status_keys: ["sealedKey"],
} as const;
