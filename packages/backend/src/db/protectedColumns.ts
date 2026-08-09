/**
 * Columns that must never leave the process in a response.
 *
 * Mongoose's `select: false` — and `routes/devices.ts`'s `.select("-preKeys")` —
 * do not survive the port: `db.select().from(table)` returns EVERY column, so
 * the first naive rewrite of a query is the first time key material can be
 * serialized into an HTTP response nobody audited.
 *
 * Read through `publicColumns(table, PROTECTED_COLUMNS)` from `@oxyhq/db/assert`.
 * The exclusion is at the TYPE level: the row type has no such property, so a
 * serializer touching one fails `tsc` rather than shipping it — **provided this
 * stays `as const` and is never re-annotated with the registry type**, which
 * would widen the literals away and silently delete the compile-time half.
 *
 * Opting in is explicit and greppable: a path that legitimately needs one names
 * it. There is deliberately no helper for that — it must read differently from
 * an ordinary select.
 */
export const PROTECTED_COLUMNS = {
  /**
   * Signal PUBLIC key material. Not a secret in the cryptographic sense — the
   * protocol publishes it — but the device list is a per-user fan-out and
   * `routes/devices.ts` already excluded pre-keys from it, because handing every
   * caller every device's whole key bundle is a fingerprinting surface and a way
   * to exhaust a device's one-time pre-keys without ever starting a session.
   */
  devices: ["identityKeyPublic", "signedPreKeyPublic", "signedPreKeySignature"],
  device_pre_keys: ["publicKey"],
  /**
   * Ciphertext, not plaintext — but it is the message, and this service is the
   * one place it exists at rest. Nothing outside a conversation's own
   * participants has any business receiving it, so a projection that reaches it
   * has to say so.
   */
  messages: ["ciphertext", "encryptedMedia", "text", "media"],
  /**
   * A bridge's own login process handle and step ids. Possession lets a caller
   * drive somebody else's half-finished linking flow.
   */
  bridge_link_sessions: ["remoteLoginProcessId", "currentStepId"],
  /**
   * The egress identity. `sessionSeed` selects which exit a provider gives out,
   * and the exit IP ties a user to a network location.
   */
  bridge_proxy_leases: ["sessionSeed", "lastExitIp"],
  bridge_proxy_lease_rotations: ["fromSeed", "toSeed"],
  /**
   * Inbound and outbound moderation payloads, stored whole and opaque. They
   * carry a third party's case material and are for this service's own workers.
   */
  moderation_events: ["payload"],
  moderation_outbox: ["payloadDecision"],
} as const;
