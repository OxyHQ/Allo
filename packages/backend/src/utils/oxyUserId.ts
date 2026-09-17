/**
 * The grammar of an Oxy account id: a 24-character lowercase hexadecimal
 * ObjectId, which is what Oxy issues and the only id shape Allo has ever held
 * for a person.
 *
 * The single place the shape is written down, so the directory boundary
 * (`routes/directory.ts`) and moderation (`services/moderation/subjectIdentity.ts`)
 * cannot come to different conclusions about the same string. Note this is
 * Oxy's id format, not this database's: Allo's own row ids are `text` in two
 * shapes (AGENTS.md), and nothing here says anything about those.
 */
const OXY_USER_ID_PATTERN = /^[0-9a-f]{24}$/;

/** Whether a string is an Oxy account id. */
export function isOxyUserId(candidate: string): boolean {
  return OXY_USER_ID_PATTERN.test(candidate);
}
