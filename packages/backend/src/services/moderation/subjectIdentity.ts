/**
 * What a reported identifier names, and whether CrowdSource can judge it.
 *
 * `Report.reportedId` is an OXY account id, and this module is the edge that
 * decides whether an incoming identifier is one. It answers a single question —
 * "is this an Oxy account, and if not, what is it?" — and it is a TOTAL
 * function, so there is no identifier for which the answer is silence.
 *
 * ## Silence is the failure being removed
 *
 * Handing an identifier that names no account to `oxyClient.getUserById`
 * produces a 404, which `userSubject` correctly turns into `null`, which
 * `ModerationDeliveryWorker` correctly reads as "the account no longer exists" —
 * and the report closes with a sentence that was never true of a subject that
 * never had an account. So a subject that cannot be reviewed is DECIDED here and
 * written down: `reason` lands verbatim in `Report.localStatusReason`, next to
 * the reason a reported message never leaves.
 *
 * ## The two shapes a client can hand over
 *
 * An Oxy account id, which is what every report surface in the app holds
 * (`DirectoryUser.id`), and an `@handle`. A handle is a name the account
 * currently displays, not its identity: it can be changed and reassigned, so a
 * report filed under one would be filed against whoever holds that name at
 * delivery time. Intake therefore does not resolve handles. A report about one
 * is stored, with the reason recorded, and the client is expected to resolve a
 * handle to an id through `GET /api/directory/profiles/username/:username`
 * before reporting — which is what the app's profile screen already has.
 */

/**
 * The longest identifier Allo will take a report about.
 *
 * An Oxy account id is 24 bytes and a handle is bounded at 64 by the directory,
 * so nothing legitimate comes close to 255. The bound exists because an
 * unresolvable identifier is deliberately STORED rather than refused, so
 * untrusted bytes reach the database by design and the only question is how
 * many. What an unbounded one costs is not a rejected insert:
 *
 * 1. **A stuck outbox slot, permanently.** A `user` report with a megabyte
 *    identifier still gets a delivery event, and `oxyClient.getUserById` puts that
 *    identifier in a URL path. What comes back is not a 404 — it is a request-line
 *    or header-size failure, or a transport error, and `isOxyUserNotFound` does not
 *    recognise it. The provider rethrows, the outbox reads that as an OUTAGE, and
 *    the event is retried forever instead of closing.
 * 2. **Unbounded attacker-controlled rows in an indexed field.** `reported_id` is
 *    indexed twice, and any authenticated user can write it.
 * 3. It would otherwise ride out as `subject.externalId` and `author.oxyUserId` in
 *    a CrowdSource envelope, which is somebody else's parser.
 *
 * Bytes, not characters: the limits that eventually bite are byte limits, and a
 * 255-character identifier of astral-plane codepoints is a kilobyte.
 */
export const MAX_REPORTED_IDENTIFIER_BYTES = 255;

/**
 * Control characters and whitespace, neither of which appears in any identifier
 * Allo can legitimately receive.
 *
 * An Oxy account id is hexadecimal and a handle is letters, digits, dot,
 * underscore and hyphen. So this rejects nothing real, and it refuses the shapes
 * that make an identifier act like something other than an identifier: a
 * newline in a value that reaches a log line and a URL path, a `\0` that
 * truncates in a C-backed layer, a bidi override that makes an operator read one
 * account name while the row holds another.
 *
 * The value has already been trimmed by the time it gets here, so leading and
 * trailing spaces are forgiven and interior ones are not.
 */
const FORBIDDEN_IDENTIFIER_CHARACTERS =
  /[\s\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069\uFEFF]/u;

/**
 * The reason a reported identifier is unusable, or `undefined` when it is fine.
 *
 * Returns a reason rather than throwing, because its two callers owe their users
 * different things: `POST /api/reports` owes a 400 with a message, and
 * `createReport` owes a `TypeError` to whatever called it without a route. One
 * definition of the rule, two shapes of refusal — the alternative is a route that
 * catches a `TypeError` and guesses which of several causes produced it.
 *
 * Both borders check, and that is deliberate rather than redundant. `createReport`
 * is exported and the route is only its first caller; a guard that lives at one
 * caller is a guard that holds until the second one arrives.
 */
export function reportedIdentifierProblem(identifier: string): string | undefined {
  const bytes = Buffer.byteLength(identifier, "utf8");
  if (bytes > MAX_REPORTED_IDENTIFIER_BYTES) {
    return `reportedId must be at most ${MAX_REPORTED_IDENTIFIER_BYTES} bytes, received ${bytes}`;
  }
  if (FORBIDDEN_IDENTIFIER_CHARACTERS.test(identifier)) {
    return "reportedId must not contain whitespace or control characters";
  }
  return undefined;
}

/**
 * A reported identifier, resolved.
 *
 * Binary on purpose. Everything downstream needs one bit — can CrowdSource judge
 * this subject — and a richer enum would invite a `switch` inside the pipeline,
 * which is the coupling this edge exists to remove. The detail that survives is
 * prose, because its only consumer is a human reading a report row months later.
 */
export type ModerationSubjectIdentity =
  | {
      readonly kind: "oxy-account";
      /** The Oxy account id, trimmed. */
      readonly reportedId: string;
    }
  | {
      readonly kind: "not-an-oxy-account";
      /**
       * The identifier as it was given. There is no Oxy id to canonicalise it to,
       * and inventing one would be the silent failure this module exists to remove.
       */
      readonly reportedId: string;
      /**
       * Why CrowdSource cannot judge this subject, in a sentence an operator can
       * read without re-deriving anything. Stored verbatim in
       * `Report.localStatusReason`, which the schema bounds; a test pins that
       * every reason below fits, because the repository truncates an overflowing
       * reason and a truncated sentence is one that stops making sense halfway.
       */
      readonly reason: string;
    };

/** The sigil a handle arrives with. Nothing else Allo accepts begins with it. */
const HANDLE_SIGIL = "@";

/**
 * The half of every reason that is the same fact: CrowdSource judges Oxy accounts.
 *
 * Shared so the sentence a reporter's row carries cannot drift into several
 * slightly different claims about what CrowdSource does.
 */
const NOT_REVIEWABLE =
  "CrowdSource reviews Oxy accounts only, so this report is recorded locally and is not sent for community review.";

const HANDLE_REASON = `The reported identifier is an Oxy handle rather than an account id, and a handle can be renamed or reassigned, so Allo does not resolve one at intake. ${NOT_REVIEWABLE}`;

function notAnOxyAccount(reportedId: string, reason: string): ModerationSubjectIdentity {
  return { kind: "not-an-oxy-account", reportedId, reason };
}

/**
 * Resolve a reported identifier to the Oxy account it names, or to the reason it
 * names none.
 *
 * An identifier with no sigil is an Oxy account id and is returned trimmed —
 * which is every report the app files. Emptiness is NOT checked here:
 * `ReportIntakeService.createReport` refuses a blank identifier at the point the
 * query is built, and duplicating it here would put two answers in the system
 * for one question.
 */
export function resolveModerationSubject(reportedId: string): ModerationSubjectIdentity {
  const identifier = reportedId.trim();

  if (identifier.startsWith(HANDLE_SIGIL)) {
    return notAnOxyAccount(identifier, HANDLE_REASON);
  }

  return { kind: "oxy-account", reportedId: identifier };
}

/**
 * Every reason this module can produce, for the test that pins them against the
 * schema's limit.
 *
 * Exported rather than re-derived by the test: a reason added here and forgotten
 * there would be one unbounded string that only fails in production, inside a
 * transaction, on the report that carries it.
 */
export function moderationSubjectReasons(): string[] {
  return [HANDLE_REASON];
}
