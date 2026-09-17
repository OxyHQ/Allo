/**
 * `@allo/react`: React bindings for `@allo/core`. Plain React only: no React
 * Native, no DOM, so Expo consumes it on web and native alike.
 */
export { AlloProvider, useAlloClient, type AlloProviderProps } from "./AlloProvider";
export { useInstanceState, useOwnInstances, usePendingEnrollments, type InstanceStateView, type OwnInstances, type PendingEnrollments } from "./hooks/useInstance";
export {
  useConversations,
  useConversation,
  useUnreadCount,
  useTotalUnread,
  useConversationActions,
  type ConversationActions,
} from "./hooks/useConversations";
export { useTimeline, DEFAULT_TIMELINE_PAGE_SIZE, type Timeline, type TimelineOptions } from "./hooks/useTimeline";
export { useMediaFile, type MediaFile, type MediaFileStatus } from "./hooks/useMediaFile";
export { useSyncState } from "./hooks/useSyncState";
export { useAlloErrors } from "./hooks/useAlloErrors";
export { MediaCache, DEFAULT_MEDIA_CACHE_SIZE, mediaKey } from "./mediaCache";

// View-model types, re-exported so a screen imports one package.
export type {
  AlloClient,
  AlloClientOptions,
  ConversationView,
  InstanceState,
  InstanceView,
  LoadOlderResult,
  MediaRef,
  MediaView,
  PendingEnrollmentView,
  SendOptions,
  SendState,
  SubscriptionTopic,
  SyncState,
  TimelineContent,
  TimelineItemView,
  UploadMediaMeta,
} from "@allo/core";
export { AlloError, type AlloErrorCodeName } from "@allo/core";
