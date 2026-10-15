# Relay connectivity and network recovery

Allo receives ICE servers from its signed, call-membership-authorized endpoint.
The backend mints coturn REST HMAC credentials, with a one-hour issuance lifetime;
ended calls cannot mint more. `TURN_REQUIRED=true` requires a 64-hex secret and a
TLS/TCP 443 endpoint and refuses incomplete configuration at boot. The dedicated
relay is provisioned in oxy-infra's live `terraform-uswest2` stack; its runbook is
`docs/runbooks/55-allo-turn.md`. `ALLO_TURN_ENABLED=true` is the deployment opt-in
only after that relay has passed external checks. The app reads SSM parameters;
it never writes the shared LiveKit credentials or holds a relay certificate key.

The P2P adapter and the encrypted LiveKit adapter both receive these ICE servers.
Relay-only calls keep `iceTransportPolicy: relay`, including after recovery.
TURN TLS uses the platform's normal hostname/chain validation, with no application
certificate bypass. Local development may remain STUN-only; such a configuration
cannot promise connectivity on restrictive networks or for relay-only calls.

Credential expiry rejects a new allocation using an old credential. It does not
tear down an already authenticated coturn allocation or its ordinary refreshes;
that behavior is exercised against the pinned real server. Allo does not interrupt
a healthy call with a timer-driven ICE restart.

When media reports a network disconnection, the SDK reads new ICE credentials
through the authorized call endpoint. P2P updates the existing peer connection's
configuration and preserves capture. Only the original caller creates an ICE
restart offer; a callee-only network change requests it with an encrypted `restart`
control message. Repeated/simultaneous requests are coalesced until the answer.
Restart requests/offers/answers are restricted to the server's active peer
instance, carry SDP fingerprints, and use the ordinary MLS encrypted outbox.
Old-call callbacks cannot signal or close a replacement call. There is no new
plaintext signaling endpoint.

For groups, the SDK obtains a fresh authorized SFU ticket before recapturing,
closes the previous room, prepares the new connection and publishes a fresh
sender encryption key through MLS before joining. Key generations increase even
when the clock has not advanced. Received peer keys still require live joined
membership, and MLS membership changes end the call. Rejoining uses public
LiveKit disconnect/connect APIs. It does not mutate private engine internals.
A failed or revoked grant ends recovery without falling back to plaintext or to
an old ticket. Recovery requests have a 20-second deadline; transport failure
also releases media locally if the network cannot report the end to the server.
Successful recovery still depends on the new network reaching signaling and a
relay; this is not a promise to survive an offline network indefinitely.

## Verification

- Backend: real Postgres call/ICE suite, required configuration and boot tests.
- SDK: callee-only loss, simultaneous loss without glare, no P2P recapture, group
  sender-key renewal, and refusal of revoked SFU authority before recapture.
- Browser: real Chromium media and ICE restart; real encrypted LiveKit disconnect
  and rejoin; authenticated sender keys remain required for receiving video.
- Relay: pinned coturn with real UDP/TCP/TLS echo traffic; trusted local TLS and
  hostname mismatch; bad/expired credentials; allocation refresh after expiry;
  production denial of loopback/private/metadata peers.
- Combined: the infra relay fixture can run the Allo browser harness with
  `--allo-worktree /absolute/path/to/Allo`. It proves relay-only TCP video, waits
  for the initial REST credential to expire, refreshes credentials, creates new
  relay candidates/ICE usernames, and retains both capture streams while video
  continues. Its certificate/private-peer relaxation is local test data only.

The AWS relay, public DNS/certificate, mobile carrier/corporate firewall paths and
physical Android/iOS network switching still require deployment/device validation.
No live infrastructure was applied and no production call is claimed by these tests.
