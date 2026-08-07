import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, sep } from 'path';

/**
 * NOBODY IS SHOWN AS AN IDENTIFIER.
 *
 * The owner opened a conversation and read `@<hex>:allo.you` where a person's
 * name belongs. It was not one mistake: the conversation header, the room list,
 * the member list, the message-info sheet and the ephemeral refusal each reached
 * for an id independently, because each one had a name that might be absent and
 * an id that never is. On Allo's homeserver the name is ALWAYS absent — Matrix
 * Authentication Service publishes no `displayname` — so every one of those
 * fallbacks was not a fallback but the normal path.
 *
 * **This is the test that stops it coming back**, and it is a source scan rather
 * than a render test on purpose. There is no render test in this repo — there is
 * no `@testing-library/react-native` and no `react-test-renderer` — so a test
 * that covered these surfaces by drawing them would have to bring in a rendering
 * stack, mock the Oxy provider, the Matrix runtime, React Query, i18n and the
 * theme for each one, and would still only cover the surfaces somebody
 * remembered to write a case for. The regression is the *shape* of the
 * expression, it is identical in all five places, and a scan sees every file
 * whether or not anybody thought about it. Same shape and same reasoning as
 * `__tests__/routes/navigationTargets.test.ts` and
 * `__tests__/appearanceEndpoint.test.ts`.
 *
 * What it cannot see: an id that reaches the screen through a variable named
 * something else, or through a helper. Those are covered where they are built
 * instead — `lib/chat/people.ts` is the only place that builds a name for
 * somebody in a conversation, and `__tests__/chat/people.test.ts` asserts that
 * what comes out of it is never an id, in every one of its states.
 */

const FRONTEND = join(__dirname, '..', '..');

/** Where a person can be drawn. */
const SOURCE_DIRS = ['app', 'components', 'hooks', 'lib', 'stores', 'utils'];

const SOURCE_EXTENSIONS = ['.ts', '.tsx'];

/** The fields of the port's view models that hold an identifier and not a name. */
const IDENTIFIER_FIELDS = String.raw`userId|senderId|roomId`;

/**
 * A name falling back to an identifier: `member.displayName ?? member.userId`.
 *
 * Both spellings of the fallback, because `??` and `||` differ in exactly one
 * way that does not matter here — an empty display name is not a name either.
 */
const NAME_FALLS_BACK_TO_ID = new RegExp(
  String.raw`\b(?:displayName|name|title|label|senderName|contactName|roomName)\s*` +
    String.raw`(?:\?\?|\|\|)\s*[A-Za-z0-9_.?[\]'"]*\b(?:${IDENTIFIER_FIELDS})\b`,
);

/**
 * The two components that put a string on screen in this app.
 *
 * Everything a user reads is inside one of them or is handed to something else
 * as a prop, which is the other rule below. Naming them rather than scanning
 * every element is what keeps this precise: `key={item.userId}` is correct and
 * necessary, and a rule that could not tell it from `{item.userId}` would be
 * turned off within a month.
 */
const TEXT_ELEMENT_BODY = /<(Text|ThemedText)\b[^>]*>([\s\S]*?)<\/\1>/g;

/**
 * The props that are read out loud, whatever draws them.
 *
 * `title` is a screen header, `label` is an avatar's initial or a field's
 * caption, `placeholder` is what a user reads in an empty box, and
 * `accessibilityLabel` is the one a screen reader speaks — an identifier there
 * is worse than on screen, not better.
 */
const READ_ALOUD_PROP = new RegExp(
  String.raw`\b(?:title|label|placeholder|accessibilityLabel|children)=\{[^}]*\b(?:${IDENTIFIER_FIELDS})\b`,
  'g',
);

const ID_IN_INTERPOLATION = new RegExp(
  String.raw`\{[^}]*\b(?:${IDENTIFIER_FIELDS})\b[^}]*\}`,
);

/**
 * The port's room-title fields, which are an identifier as often as not.
 *
 * `AlloRoomSummary.displayName` and `AlloRoomDetails.name` are documented as
 * "the name from room state, **or one computed from the members**", and both
 * SDKs compute that one by naming a member with no `displayname` after their
 * user id. On Allo's homeserver that is everybody, so the second case is the
 * ordinary one: a one-to-one conversation is titled with an MXID and an unnamed
 * group with several.
 *
 * They are therefore not strings a screen may draw. `conversationTitleFrom` is
 * what turns one into a title, and `isOwnRoomName` is what decides whether it is
 * a name the user typed — anything else is the bug, wearing a field name a scan
 * for `userId` would never notice.
 */
const COMPUTED_ROOM_TITLE = /\b(?:details|summary|room)\.(?:displayName|name)\b/;

/** The two functions allowed to read one. */
const TITLE_RESOLVERS = /\b(?:conversationTitleFrom|isOwnRoomName)\s*\(/;

/**
 * Any prop whose value is an expression, so its contents can be examined.
 *
 * `key` is excluded and is the only exclusion. React never draws a key: it is
 * the identity of a list row, and for a room-title field it is precisely how a
 * component is reset when the homeserver's name for the room changes — which is
 * what `RoomNameSection` uses it for, instead of an Effect watching a prop.
 */
const JSX_EXPRESSION_PROP = /\b(?!key=)[A-Za-z][A-Za-z0-9]*=\{[^}]*\}/g;

/**
 * Files allowed to put a name beside an identifier, each for a reason that is
 * not about drawing.
 *
 * Kept as a list rather than as an inline comment so that adding to it is a
 * visible change to this test, which is where the argument for the exception
 * belongs.
 */
const NOT_DRAWN: Readonly<Record<string, string>> = {
  // A sort key. The member list is ordered by the name a row is drawn with, and
  // a member with no name has to sort somewhere stable; nothing here reaches a
  // view. Documented at the function itself.
  'lib/matrix/roomMembers.ts': 'orders members; the value is a sort key, never drawn',
};

/**
 * Everything on the Matrix path resolves a person through `lib/chat/people.ts`
 * and through nothing else.
 *
 * The five Oxy calls the frontend makes about people are moving behind
 * `api.allo.you`. One module reaching for them is a move; a call site per screen
 * is twenty. This is the half of that rule a scan can hold: the Matrix path is
 * new code and has exactly one, so there is a line to defend. The Express path
 * has fifteen and predates the seam — migrating it is its own change.
 */
const OXY_PERSON_CALLS =
  /\b(?:getUsersByIds|getUserById|getProfileByUsername|searchProfiles|getFileDownloadUrl)\s*\(/;

/** The files that are the Matrix chat path. */
const MATRIX_PATH = [
  `lib${sep}matrix${sep}`,
  `lib${sep}chat${sep}matrix`,
  `lib${sep}chat${sep}room`,
  `lib${sep}chat${sep}timeline`,
  `lib${sep}chat${sep}invitations`,
  `lib${sep}chat${sep}ephemeral`,
  `hooks${sep}useMatrix`,
  `hooks${sep}useChatPeople`,
  `components${sep}matrix${sep}`,
  `app${sep}(chat)${sep}room${sep}`,
];

/** The one module allowed to ask Oxy who somebody in a conversation is. */
const THE_SEAM = `lib${sep}chat${sep}people.ts`;

function walk(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules') continue;
      found.push(...walk(full));
      continue;
    }
    if (SOURCE_EXTENSIONS.some((extension) => entry.endsWith(extension))) found.push(full);
  }
  return found;
}

/**
 * The source with its comments removed.
 *
 * Every one of these rules is stated in prose somewhere near the code that used
 * to break it — "it used to be `member.displayName ?? member.userId`" — and a
 * scan that read comments would fail on its own explanation.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function sourceFiles(): { readonly path: string; readonly source: string }[] {
  return SOURCE_DIRS.flatMap((directory) => walk(join(FRONTEND, directory))).map((path) => ({
    path: relative(FRONTEND, path),
    source: withoutComments(readFileSync(path, 'utf8')),
  }));
}

describe('no Matrix user id can reach the screen', () => {
  it('has source to scan', () => {
    // A scan that walked nothing would pass every rule below in silence, which
    // is the way this kind of test dies.
    expect(sourceFiles().length).toBeGreaterThan(200);
  });

  it('never falls back from a name to an identifier', () => {
    const offenders = sourceFiles()
      .filter(({ path }) => NOT_DRAWN[path.split(sep).join('/')] === undefined)
      .filter(({ source }) => NAME_FALLS_BACK_TO_ID.test(source))
      .map(({ path }) => path);

    // `member.displayName ?? member.userId` is not a fallback on Allo's
    // homeserver. It is the only path, because nobody there has a Matrix display
    // name. What to draw for somebody who cannot be named is
    // `chat.person.unknown`, and `lib/chat/people.ts` is what decides it.
    expect(offenders).toEqual([]);
  });

  it('never draws an identifier as the contents of a text element', () => {
    const offenders: string[] = [];
    for (const { path, source } of sourceFiles()) {
      if (!path.endsWith('.tsx')) continue;
      for (const match of source.matchAll(TEXT_ELEMENT_BODY)) {
        if (ID_IN_INTERPOLATION.test(match[2])) {
          offenders.push(`${path}: ${match[2].trim().slice(0, 120)}`);
        }
      }
    }

    // `<Text>ID: {message.senderId}</Text>` and
    // `<ThemedText>{member.userId}</ThemedText>` were both on screen. An
    // identifier is not something a reader can do anything with; a handle is,
    // and a name is what they came for.
    expect(offenders).toEqual([]);
  });

  it('never hands an identifier to a prop that is read out loud', () => {
    const offenders: string[] = [];
    for (const { path, source } of sourceFiles()) {
      if (!path.endsWith('.tsx')) continue;
      for (const match of source.matchAll(READ_ALOUD_PROP)) {
        offenders.push(`${path}: ${match[0]}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("never draws a room's computed title without resolving the people in it", () => {
    const offenders: string[] = [];
    for (const { path, source } of sourceFiles()) {
      if (!path.endsWith('.tsx')) continue;
      for (const [region] of [
        ...[...source.matchAll(TEXT_ELEMENT_BODY)].map((match) => [match[2]]),
        ...[...source.matchAll(JSX_EXPRESSION_PROP)].map((match) => [match[0]]),
      ]) {
        if (COMPUTED_ROOM_TITLE.test(region) && !TITLE_RESOLVERS.test(region)) {
          offenders.push(`${path}: ${region.trim().slice(0, 120)}`);
        }
      }
    }

    // `title={details.name}` is `@<hex>:allo.you` for every one-to-one
    // conversation on Allo's homeserver, and no scan for a field called
    // `userId` would ever see it. This is the rule that does.
    expect(offenders).toEqual([]);
  });

  it('resolves a person through one module on the Matrix path', () => {
    const offenders = sourceFiles()
      .filter(({ path }) => path !== THE_SEAM)
      .filter(({ path }) => MATRIX_PATH.some((prefix) => path.startsWith(prefix)))
      .filter(({ source }) => OXY_PERSON_CALLS.test(source))
      .map(({ path }) => path);

    expect(offenders).toEqual([]);
  });
});
