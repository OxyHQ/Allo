<!-- Moved verbatim from AGENTS.md; the rules below are unchanged and binding. -->

# The Allo platform

The chat transport was replaced, not extended. The decision and the design are
in `docs/adr/0001-clean-break-platform.md` and `docs/platform/`. The app runs on
it: `@allo/core` (headless SDK: instances, MLS end-to-end encryption, sync,
outbox, media) and `@allo/react` (provider and hooks) are workspace packages
under `packages/`, and the legacy REST/Socket.IO chat path is deleted from the
frontend. `utils/api.ts` survives ONLY for profile settings, the directory and
reports.

**`lib/allo/` is the only place the frontend constructs the client.** Screens
use `@allo/react` hooks and the pure projections in `lib/chat/model.ts`
(`ConversationView` → Bloom's `ChatSummary`, `TimelineItemView` → Bloom's
`MessageListItem`, names and times already strings), fed by
`hooks/useChatContext.ts`. The seam holds every platform adapter:
`storage.native.ts` (expo-sqlite, one `kv` table, `batch` in a transaction) and
`storage.web.ts` (IndexedDB), `secrets.native.ts` (expo-secure-store,
`WHEN_UNLOCKED_THIS_DEVICE_ONLY`) and `secrets.web.ts`, `session.ts` (the
`OxyServices` instance from `useOxy()`), `people.ts` (the ONE place the chat path
asks Oxy about a person; coalesced `users.getMany`, filling `usersStore`),
`push.ts`, `useMediaUri.ts`, and `AlloRoot.tsx`, which owns the lifecycle: one
client per signed-in account, `stop()` on an account switch, `reset()` (wipe and
best-effort self-revoke) on sign-out. **Nothing on the chat path may fall back
to AsyncStorage**; `__tests__/allo/noLegacyChatPath.test.ts` is a TypeScript-AST
census that enforces it, plus no `socket.io-client`, no legacy endpoint, and
`@allo/core` value imports only inside `lib/allo/`.

**A session that is not there is not a sign-out.** Oxy clears the bearer on an
unrecoverable 401 and reports a locally signed-out session while KEEPING the
stored one, because it expects to restore it. `AlloRoot` therefore only ever
`stop()`s a client when the account goes away; it never resets one. Leaving
this device is a deliberate act and goes through `lib/allo/signOut.ts`, which
runs `reset()` while the token is still alive — the only moment the revoke can
be authenticated — and reports whether it landed. Getting this backwards is
what turned a page reload into a permanent "approve this device": the revoke
could not land (its credential was the bearer that had just gone), so the
server kept an ACTIVE instance whose signing key had just been deleted, and
the next start enrolled a stranger that the ghost alone could have approved.
`__tests__/allo/sessionGap.test.tsx` holds that line, and
`__tests__/allo/reload.test.ts` runs the whole journey over the real web
adapters.

**Enrollment is a gate, not a setting.** `EnrollmentGate` renders the app only
for an `active` instance. A second device sits on a "approve this device" screen
until an active device approves it from Settings → Devices
(`app/(chat)/settings/devices.tsx`: `useOwnInstances` + `usePendingEnrollments`,
approve with the challenge so a swapped one is refused, reject, revoke). A
revoked device gets "start over" (`reset()` then `start()`). Both sides show the
same challenge fingerprint for an out-of-band comparison: the pending device
reads its own from `instance.enrollment?.fingerprint` (present only while it is
pending), the approver from `usePendingEnrollments()`.

**And the pending screen has a second way out, because there need not be
anybody to approve.** A device whose signing key is gone leaves an instance the
account still calls active that nothing can sign for; when it is the last one,
waiting is forever. "Use this device instead" is `client.reclaimAccount()`:
revoke every active instance with the Oxy session (`DELETE /v1/instances/:id`,
the one instance route a session alone may call), wipe, and register into the
now-empty account, which the bootstrap rule makes active. It is destructive,
it sits behind a confirmation that says the other devices are signed out and
their messages are gone, and the trade it makes — a stolen Oxy token can take
the account over going forward, though it can read nothing from before and
cannot do it quietly — is written down in `docs/platform/threat-model.md` §4.

**A lost STORAGE key is survivable and a lost SIGNING key is not.** They are
separate secrets. Without the storage key every row of the namespace is
ciphertext nobody will ever read again, so `start()` drops them and carries on;
the signing key survives, the registration meets `idempotency_conflict`, and
the device ADOPTS the instance it already has — still active, nobody asked to
approve anything. Without the signing key there is nothing to adopt.
`src/__tests__/recovery.test.ts` in `@allo/core` runs both.

**The web secret store is the platform's documented weak point.** A browser has
no Keychain; the storage key, the signing key, the transfer key and, once
backup is on, the backup key sit in IndexedDB (`allo-secrets`) where any script
on the origin can read them. Never move them to `localStorage` or a cookie; see
the header of `lib/allo/secrets.web.ts`.

**History reaches a new device by transfer or by backup, never by copying
state.** Both are `@allo/core` (`client.history`, `client.backup`; `docs/platform/crypto.md`
sections 12 to 16) reached through `useHistoryTransfer` and `useBackup` in
`@allo/react`. The transfer is automatic: the device that added a newly
approved device to the account's groups offers its history once, and the new
device accepts on its own only from a verified same-account donor. The app's
part is a banner in the conversation list while `progress.phase !== 'idle'`
("Receiving history from <device name>", the device from `fromInstanceId`);
it makes no decision about trust. Settings has "Backup and recovery"
(`app/(chat)/settings/backup.tsx`): enabling shows the twelve words ONCE behind
an explicit "I wrote them down" confirmation, and **the app never persists the
phrase anywhere**, not in state, storage, logs or the clipboard on its own;
the SDK keeps only the derived key. The screen also offers "refresh now" and a
confirmed "disable". A "Restore from recovery phrase" screen (12-word input)
is offered to a fresh instance whose account has a remote backup
(`status.remote.exists` after `refreshStatus()`) before the empty conversation
list. **Restore only works on an active instance**: `client.backup.restore`
refuses otherwise, so the pending-approval screen may say a backup exists and
that approval comes first, and nothing more. A wrong phrase is refused before
any download (`RecoveryPhraseError`); a backup not signed by an instance of
this account is refused (`UntrustedInstanceError`). Losing every device and
the phrase loses history, and the screens say so rather than implying the
server can help. The screens and the banner are specified with the Phase 3
change and built alongside it; `navigationTargets` covers the new routes.

**Chatting with somebody who has not installed Allo works, and the app says
what is happening rather than refusing.** Any Oxy user is a valid participant:
`createDirect`/`createGroup` no longer reject an account with no instance, so
`useCreateConversation` and the screens behind it (`new.tsx`, the profile
"message" button) have no "not found" case to catch and show only real
failures. The SDK lists such people in `ConversationView.unreachableMemberAccountIds`
and, while NOBODY else in the conversation can read, holds each own message
`pending` with `holdReason: 'no_reachable_member'`. The words are one pure
function, `unreachableCopy` in `lib/chat/model.ts`, and three places draw them:
a note banner above the composer in `ConversationScreen` ("<Name> hasn't set up
Allo yet. Your messages will be delivered when they join."; a group counts
them), the held message's clock, whose accessible name `transcriptItems` sets to
"Waiting for <Name> to join" (only on a held own message), and the list row,
whose preview `chatSummary` replaces with "Waiting for <Name>". The composer is never disabled for this, the name comes through the
people layer and an id never reaches the screen ("this person" while the
lookup is out), and nothing here polls: the person's first device joins by
itself the moment it is active (next paragraph), and the server's nudge wakes
the elector only for a conversation it cannot join by itself.
`__tests__/allo/unreachableBanner.test.tsx` runs that data path over a real
`@allo/core` client and the fake server, both ends, with the real English copy.

**A device joins a conversation by itself; nobody has to be online.** Every
commit's author uploads the new epoch's MLS GroupInfo with it, and a device
that is a member with no leaf (a new account's first device, a newly approved
second device, a device whose group state was lost) joins by an external
commit built from it, admitted by every member against the account's approval
chain and never on the server's word (`docs/platform/crypto.md` section 5).
The elector that used to add it is now the fallback for a conversation whose
last commit predates the stored GroupInfo. The screen reads it off
`ConversationView.joinState`, through one pure function, `joinNotice` in
`lib/chat/model.ts`, drawn as the composer's notice in `ConversationScreen`:
`joining` is "Joining the conversation…" with a spinner in the notice icon's
slot (`Composer`'s `noticeBusy`), `waiting_for_member` is "This device is still
being added to the conversation." plus "Another device in the conversation has
to be online." and no spinner, `joined` is nothing. Never key that notice on
`joined` alone again: the two `false` states mean opposite things to the
person reading them. `__tests__/allo/joinNotice.test.tsx` runs both over a
real client and the fake server — a second device joining with the first and
the other member switched off, the GET on `group-info` held behind a gate so
"joining" is on screen for certain before the join lands; and
`server.keepGroupInfo = false` for the waiting text and the elector clearing it.

**A conversation this device refused a commit in is closed, and stays closed.**
When the server lets in a joiner this device cannot verify (an instance outside
the account's approval chain), the SDK refuses the commit, the group moves on
without this device, and `ConversationView.integrity` becomes
`'refused_commit'` for good. `composerNotice` in `lib/chat/model.ts` puts that
ahead of the join state: the composer is replaced by "This conversation cannot
continue securely: a device that could not be verified was added." with the
error icon (`Composer`'s `noticeError`), and there is deliberately no retry,
dismiss or "trust anyway" — every way out is accepting the device it could not
verify. An echo the outbox has given up on (`holdReason: 'epoch_stalled'`) gets
the clock label "Waiting for the conversation to catch up" through
`transcriptItems`' `stalledLabel`. The third case of `joinNotice.test.tsx`
drives it with a real forged joiner: a second client for Bob whose pending
instance the fake server is made to list as an unapproved active root.
