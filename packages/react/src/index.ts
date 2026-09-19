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
export { useCall, useCallActions, useCallHistory, type CallActions } from "./hooks/useCall";
export { usePresence, type Presence } from "./hooks/usePresence";
export { useStatuses, type Statuses } from "./hooks/useStatuses";
export { useSyncState } from "./hooks/useSyncState";
export { useAlloErrors } from "./hooks/useAlloErrors";
export { useHistoryTransfer, type HistoryTransfer } from "./hooks/useHistoryTransfer";
export { useBackup, type Backup } from "./hooks/useBackup";
export { MediaCache, DEFAULT_MEDIA_CACHE_SIZE, mediaKey } from "./mediaCache";

// View-model types, re-exported so a screen imports one package.
export type {
  AlloClient,
  AlloClientOptions,
  BackupStatus,
  ConversationView,
  HistoryOfferView,
  HistoryPhase,
  HistoryProgress,
  InstanceState,
  InstanceView,
  LoadOlderResult,
  MediaRef,
  MediaView,
  PendingEnrollmentView,
  PresenceView,
  StatusAudience,
  StatusDraft,
  StatusView,
  StatusViewerView,
  SendOptions,
  SendState,
  SubscriptionTopic,
  SyncState,
  TimelineContent,
  TimelineItemView,
  UploadMediaMeta,
} from "@allo/core";
export { AlloError, RecoveryPhraseError, UntrustedInstanceError, type AlloErrorCodeName } from "@allo/core";
