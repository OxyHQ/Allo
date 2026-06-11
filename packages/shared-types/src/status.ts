/**
 * Status (WhatsApp-style Stories) shared types.
 *
 * A "status" is a piece of ephemeral content (image, video or styled text)
 * authored by a user that expires automatically 24 hours after creation.
 *
 * Privacy is modelled the same way as WhatsApp:
 *   - `all-contacts`: every contact can view the status (the default).
 *   - `except`:       every contact can view it except the listed `userIds`.
 *   - `only`:         only the listed `userIds` can view it.
 */

export type StatusType = 'image' | 'video' | 'text';

export type StatusAudienceType = 'all-contacts' | 'except' | 'only';

export interface StatusAudience {
  type: StatusAudienceType;
  /** User IDs to include (`only`) or exclude (`except`). Empty for `all-contacts`. */
  userIds: string[];
}

export interface StatusViewer {
  userId: string;
  viewedAt: string; // ISO date
}

export interface Status {
  id: string;
  userId: string;
  type: StatusType;

  /** Present when `type` is `image` or `video`. */
  mediaUrl?: string;
  mediaThumbnailUrl?: string;

  /** Present when `type` is `text`; can also be used as a caption for media. */
  text?: string;
  caption?: string;
  backgroundColor?: string;
  fontFamily?: string;

  audience: StatusAudience;
  viewers: StatusViewer[];

  createdAt: string; // ISO date
  expiresAt: string; // ISO date (createdAt + 24h)
}

/**
 * Optional enrichment for the author of a status group (Oxy user data).
 */
export interface StatusAuthor {
  userId: string;
  name?: { first?: string; last?: string } | string;
  username?: string;
  avatar?: string;
}

/**
 * A "group" is the bundle of all live (non-expired) statuses authored by a
 * single user, in chronological order. `hasUnviewed` is computed for the
 * requesting viewer.
 */
export interface StatusGroup {
  userId: string;
  author?: StatusAuthor;
  statuses: Status[];
  lastCreatedAt: string;
  hasUnviewed: boolean;
}

/**
 * Payload for `POST /api/status`. Either `mediaUrl` (for `image`/`video`) or
 * `text` (for `text`) must be present.
 */
export interface CreateStatusInput {
  type: StatusType;
  mediaUrl?: string;
  mediaThumbnailUrl?: string;
  text?: string;
  caption?: string;
  backgroundColor?: string;
  fontFamily?: string;
  audience?: StatusAudience;
}

export interface StatusFeedResponse {
  groups: StatusGroup[];
  myStatus: Status[];
}

/**
 * Wire-shape of the realtime events emitted on the `/messaging` namespace.
 */
export interface StatusCreatedEvent {
  status: Status;
  author?: StatusAuthor;
}

export interface StatusViewedEvent {
  statusId: string;
  ownerId: string;
  viewerId: string;
  viewedAt: string;
}

export interface StatusDeletedEvent {
  statusId: string;
  ownerId: string;
}
