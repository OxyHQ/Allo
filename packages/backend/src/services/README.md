# Services

Business logic layer for the Allo backend. Routes handle HTTP concerns; services handle domain logic so it can be reused from routes, jobs, and websocket handlers.

## ConversationService

Conversation business logic (`ConversationService.ts`):

- **Participant enrichment** — Batch-fetches Oxy user profiles to enrich conversation participants
- **Conversation CRUD** — Create, fetch, update, and delete conversations with authorization checks
- **Pagination** — Paginated conversation listing for a user

### Usage

```typescript
import { ConversationService } from './services/ConversationService';

const conversations = await ConversationService.getConversations(userId, { limit, offset });
```

## User ID Convention

- **Database fields**: `oxyUserId`
- **Function parameters/variables**: `userId` or `currentUserId` (these contain Oxy user IDs from `req.user?.id`)
- `req.user?.id` is always an Oxy user ID, as authentication is handled by Oxy.
