# Services

Domain services for the Allo backend.

- `moderation/` — report intake, evidence snapshots and the CrowdSource outbox.
- `oxy/` — the people directory's projection of Oxy profiles.
- `push/` — FCM and APNs senders behind one `sendPush(devices, notification)`.

The messaging platform's services are documented in `docs/platform/`.

## User id convention

- **Database columns** use `oxy_user_id` / `account_id` for an Oxy account.
- **Function parameters/variables** use `userId` and always contain an Oxy user id
  (`req.user?.id`), since authentication is handled by Oxy.
