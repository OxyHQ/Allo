# Services

Domain services for the Allo messaging backend. Controllers/routes stay thin and
delegate persistence and DTO shaping here.

## ConversationService

Static service for conversation lifecycle and read/enrichment. All methods take
Oxy user ids (`req.user?.id`) and return `ConversationDto` shapes from
`@allo/shared-types`.

- `getUserConversations(userId, ...)` — list a user's conversations.
- `getConversationById(conversationId, userId)` — fetch one, scoped to a participant.
- `createConversation(data)` — create a direct or group conversation.
- `updateConversation(conversationId, userId, updates)` — update metadata (name, theme, …).
- `archiveConversation(conversationId, userId)` — archive for the requesting user.
- `markAsRead(conversationId, userId)` — clear the user's unread count.

Participant enrichment (resolving Oxy profiles for each `participants[].userId`)
is handled internally.

## User id convention

- **Database fields** use `oxyUserId` (e.g. `Conversation.participants[].userId`,
  `UserBehavior.oxyUserId`).
- **Function parameters/variables** use `userId` and always contain an Oxy user id
  (`req.user?.id`), since authentication is handled by Oxy.
