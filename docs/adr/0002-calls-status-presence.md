# ADR 0002: calls, status updates and presence

Date: 2026-09-19. Status: accepted, being built.

Supersedes nothing. Extends `0001-clean-break-platform.md`, and is bound by
`docs/platform/threat-model.md`: anything here that the server can see is
listed there in the same change that builds it.

## Context

Phase 2 of the app shipped calls, status updates and presence as **frontend
only** — real screens over `packages/frontend/lib/phase2/`, each saying in its
own words that nothing is connected. That was honest, and it is not a product.
This ADR decides what the platform behind them is.

The three are not one feature. They share only that each is a way of reaching
somebody outside the ordered, durable, per-conversation event stream that
`@allo/core` already has, and each therefore needs the server to know something
it does not know today. What that something is — and what it is not — is the
whole decision.

The designs below follow what WhatsApp, Signal, Apple and Cisco publish about
their own systems, because the failure modes here are well explored and none of
them are worth rediscovering. Where we depart, the departure is stated.

## Decision 1: a call is keyed by MLS and rung by the server

**Media keys come from the group, not from the network.** A call's SRTP master
secret is derived with the MLS exporter (RFC 9420 §8.5) from the conversation's
current epoch, with the call id in the exporter context so two calls in one
epoch do not share a key. The caller puts the derivation's parameters, not the
key, in an encrypted `call` message; every member device derives the same bytes
and the server derives nothing. This is WhatsApp's shape (the caller fixes the
key, the key travels inside the E2EE channel, DTLS is not in the trust path)
expressed in the primitive we already have.

The exporter is a pure read of `keySchedule.exporterSecret`. It advances no
ratchet and writes no state, so it is the first crypto call in the SDK that
runs outside `ctx.mutex` — invariant 3 in `crypto.md` is amended in the same
change to say "every **advance**", so that this is a stated exception rather
than an apparent violation.

**A group-epoch key is a group-wide key**, and in a group conversation that
means a member who is not on the call can still derive it. For a DM — every
1:1 call — the group is exactly the two accounts' devices, so the property is
the one we want. For a group call it is not, and that is one of the reasons
group calling is staged separately below.

**The server runs the state machine, and we say so.** It holds a `calls` row
(conversation, initiator, mode, state, timestamps, end reason) and a
`call_participants` row per rung device. It needs them to fork the ring across
a callee's devices, to enforce first-to-answer-wins, to cancel the losing
devices, and to expire a ring nobody answered. WhatsApp's whitepaper says the
same thing about its own server in almost the same words. This is call metadata
in a database, it is subpoenable, and `threat-model.md` §5 gains a line for it.

**The call log is not that table.** What the user sees is an E2EE record synced
between their own devices, Signal's six fields — conversation, call id, time,
kind, direction, outcome. "Missed" is derived from "incoming and not accepted",
not stored. The server's rows are operational and are swept; the log is the
user's and lives in their timeline.

**Ringing.** One VoIP push per device, never a cancel push: Apple terminates an
app that fails to report a VoIP push to CallKit, so a cancel that arrives as a
second push has nowhere to go. Cancellation travels over the socket, with a
plain "missed call" alert push as the after-the-fact fallback. On Android the
ring is a high-priority data message into a `phoneCall` foreground service, not
a microphone one, because Android 14 forbids starting a microphone service from
the background.

**Who may cause a ring.** Only a joined member of the conversation, and never a
blocked account. A ring is the loudest thing this system can do to a device
and it is the one primitive worth rate-limiting hard.

**Two media paths, and the person chooses between them.**

A 1:1 call goes peer to peer over ICE with DTLS-SRTP, which is the best
latency and costs the server nothing, and falls back to a relay for the
fifteen per cent or so of calls a NAT will not let through. Peer to peer means
each side learns the other's IP address — true of every calling app, and the
thing WhatsApp eventually shipped a switch for.

So Allo ships the switch: **"Hide my IP address in calls"**. With it on, the
client offers no host and no server-reflexive candidate, so every packet goes
through the relay and the other side sees only the relay's address. Two rules
follow, and both are the server's to enforce because a client cannot:

- **Either side asking is enough.** A connection cannot be half relayed, so if
  one participant hides, the call is relayed for both — and the other side is
  told the call is relayed, not who asked for it.
- **A group call is always relayed**, because it goes through the SFU. The
  question does not arise there, and the setting says so rather than implying
  it is doing something in a group.

**Group calls go through the SFU now.** Oxy already runs LiveKit; a mesh would
have been less to build and would have capped the feature at four people.
RFC 9605's warning stands and shapes the design rather than deferring it: a
single shared frame key gives NO per-sender authentication — any participant
can emit media attributed to any other — so the group key is derived per
sender, rotated when the membership changes, and the rotation is what a joiner
and a leaver both trigger.

## Decision 2: a status update is sealed per device, not posted to a group

A status update goes to an **audience**, which is not a group and must not
become one. The decisive reason is in RFC 9420 itself: every member of an MLS
group holds the full ratchet tree, so "my contacts except Ana" implemented as a
group would publish the audience — and Ana's exclusion — to everyone in it.

So: the poster encrypts the update once under a random per-status key, uploads
the ciphertext as an ordinary blob, and seals that key to each recipient
**instance** with HPKE against the transfer key the instance already publishes.
One body, one key, `N` sealed copies of 32 bytes. This is the shape of Signal's
sealed-sender fan-out and of WhatsApp's "the first status to a given set of
devices", expressed in the primitive Allo already uses to hand an archive key
to a new device.

The transfer key's documented purpose widens from "receives an archive key" to
"receives a key sealed to this device", and the two uses stay cryptographically
separate by their HPKE `info` string. `crypto.md` §12 says so in the same
change.

**Audience modes are Signal's three**: only these people, everyone except
these people, everyone. "Everyone" means every account this account has a
conversation with, minus blocks, resolved on the device at post time — the
server is never asked who your contacts are.

**The server learns the audience.** It must: it delivers to the devices in it.
Both WhatsApp and Signal accept the same leak. `threat-model.md` §5 gains it.

**Expiry is 24 hours and the client enforces it.** The server drops the row and
the blob on the same deadline, which is what the existing expiry sweep is for,
but the honest statement is that a decrypted status already on a device is that
device's, and the screen says so rather than implying a remote delete.

**View receipts are their own setting**, not a rider on read receipts, and they
are coalesced and jittered for the reason in decision 3.

## Decision 3: presence is a subscription, and it is reciprocal

Signal and iMessage expose no online indicator at all, and the published abuse
of the ones that do is severe — an online dot polled once a second reconstructs
sleep schedules, and correlating two accounts' dots infers who is talking to
whom. Allo already emits `presence` on the socket to every account that shares
any conversation with you, ignores `privacy_show_online_status` entirely, and
has no test.

We keep presence, and we make it cost something to abuse:

- **Reciprocal.** An account that does not publish its own presence does not
  receive anybody else's. This is WhatsApp's rule and it cannot be retrofitted
  later without taking a feature away from people who already have it.
- **A viewport subscription, not a graph broadcast.** A client says which
  accounts it is showing; the server answers for those and pushes changes for
  those. The current "fan out to every co-member of every conversation" is
  what does not scale and what feeds the scraper.
- **Derived from a TTL, not from a disconnect.** Online is a Redis key with a
  heartbeat behind it; offline is that key expiring. A disconnect event lies
  during a network flap and during every ECS rollout.
- **Blocked accounts see nothing and are seen by nothing.**
- **Last seen is coarse.** Minute granularity, and never for an account that
  publishes no presence.

**Receipts are hardened in the same change**, because they are the same oracle
with a better resolution: `delivered` is emitted on a jittered, coalesced
schedule rather than immediately, a receipt naming an event this device never
saw is discarded instead of acknowledged, and receipts are refused for accounts
that are not members of the conversation.

## Decision 4: a control message an old client meets is ignored, not broken

Today an `AppMessage` with an unrecognised `t` is decoded as a failure and
drawn in the timeline as an undecryptable bubble. Every kind this ADR adds
would therefore litter the conversations of every device that has not updated
yet.

So before any new kind ships, the envelope grows an ignorable-control
convention: a message whose `t` is unknown **and** whose shape marks it as
control is recorded and projected as nothing at all. This lands first, on its
own, so that the clients in the field learn to ignore before there is anything
to ignore.

## Consequences

- The server gains three metadata surfaces it did not have: call sessions,
  status audiences, presence. Each is written into `threat-model.md` §5 in the
  change that builds it, and none of them is a key.
- `privacy_show_online_status` and the `blocks` table stop being written and
  never read. Presence, status and calls all consult them, and the privacy
  screens stop saying "nothing acts on this yet" for the settings that now act.
- The frontend's `lib/phase2/` stores are replaced by SDK-backed hooks in the
  order the platform lands, and each file's "what a transport must supply"
  header is deleted with the store it describes.
- TURN and the native call UI are the two places this design needs something
  the repository cannot provide: a relay with a bill attached, and a dev build
  carrying CallKit and Telecom. Both were decided with the owner before the
  calls change started: the relay rides on the LiveKit box Oxy already
  operates, and the ring is CallKit and Android Telecom in a development
  build, with the Play Console declaration that implies.
- `privacy_relay_calls` joins `privacy_show_online_status` and
  `privacy_status_view_receipts` as a setting the platform actually acts on.

## What this ADR does not decide

Federation of any of the three. Status replies. Call recording, which is
deliberately not a feature. Calls between an Allo account and a phone number,
which is not a thing this platform has.
