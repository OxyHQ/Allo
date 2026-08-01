# Services

Domain services for the Allo messaging backend.

Only moderation lives here (`moderation/`). Conversation and message handling is
implemented directly in `src/routes/`, which reads and writes its Mongoose models
inline — there is no service layer in front of them, and no partial one either.

## User id convention

- **Database fields** use `oxyUserId` (e.g. `Conversation.participants[].userId`,
  `UserBehavior.oxyUserId`).
- **Function parameters/variables** use `userId` and always contain an Oxy user id
  (`req.user?.id`), since authentication is handled by Oxy.
