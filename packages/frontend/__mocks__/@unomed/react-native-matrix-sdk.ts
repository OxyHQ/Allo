/**
 * Jest stand-in for the Matrix SDK binding.
 *
 * The real package cannot be loaded in Jest at all: its entry point calls
 * `installer.installRustCrate()` at module scope, which needs the TurboModule and
 * the Rust library that only exist inside a running app. Everything Allo's own
 * code takes from it at runtime, though, is data — the tag enums of uniffi's
 * tagged unions, and the constructors that build them — so a stub can supply it.
 *
 * What keeps this stub honest is that it does not supply the *types*: a test that
 * writes `new MsgLikeKind.Message({ content })` is typechecked against the real
 * `.d.ts`, so a fixture that does not match the binding's shape fails to compile
 * even though it runs against this file. The one thing that is asserted here and
 * not checked by the compiler is the string values of the tag enums, and those
 * are the Rust variant names: uniffi generates them from the same identifier the
 * TypeScript member is named after, so a rename shows up as a type error in
 * `lib/matrix/native/translate.ts` rather than passing silently.
 */

interface SdkVariant {
  readonly tag: string;
  readonly inner: Record<string, unknown>;
}

type SdkVariantConstructor = new (inner?: Record<string, unknown>) => SdkVariant;

function variant(tag: string): SdkVariantConstructor {
  return class {
    readonly tag = tag;
    readonly inner: Record<string, unknown>;

    constructor(inner: Record<string, unknown> = {}) {
      this.inner = inner;
    }
  };
}

// --- Numeric enums -------------------------------------------------------

export enum EncryptionState {
  Encrypted = 0,
  NotEncrypted = 1,
  Unknown = 2,
}

export enum Membership {
  Invited = 0,
  Joined = 1,
  Left = 2,
  Knocked = 3,
  Banned = 4,
}

export enum SyncServiceState {
  Idle = 0,
  Running = 1,
  Terminated = 2,
  Error = 3,
  Offline = 4,
}

export enum SlidingSyncVersion {
  None = 0,
  Native = 1,
}

export enum RecoveryState {
  Unknown = 0,
  Enabled = 1,
  Disabled = 2,
  Incomplete = 3,
}

// --- Tag enums -----------------------------------------------------------

export enum TimelineItemContent_Tags {
  MsgLike = 'MsgLike',
  CallInvite = 'CallInvite',
  RtcNotification = 'RtcNotification',
  RoomMembership = 'RoomMembership',
  ProfileChange = 'ProfileChange',
  State = 'State',
  FailedToParseMessageLike = 'FailedToParseMessageLike',
  FailedToParseState = 'FailedToParseState',
}

export enum MsgLikeKind_Tags {
  Message = 'Message',
  Sticker = 'Sticker',
  Poll = 'Poll',
  Redacted = 'Redacted',
  UnableToDecrypt = 'UnableToDecrypt',
  Other = 'Other',
}

export enum MessageType_Tags {
  Emote = 'Emote',
  Image = 'Image',
  Audio = 'Audio',
  Video = 'Video',
  File = 'File',
  Gallery = 'Gallery',
  Notice = 'Notice',
  Text = 'Text',
  Location = 'Location',
  Other = 'Other',
}

export enum EventOrTransactionId_Tags {
  EventId = 'EventId',
  TransactionId = 'TransactionId',
}

export enum UploadSource_Tags {
  File = 'File',
  Data = 'Data',
}

export enum EventSendState_Tags {
  NotSentYet = 'NotSentYet',
  SendingFailed = 'SendingFailed',
  Sent = 'Sent',
}

export enum ProfileDetails_Tags {
  Unavailable = 'Unavailable',
  Pending = 'Pending',
  Ready = 'Ready',
  Error = 'Error',
}

export enum EnableRecoveryProgress_Tags {
  Starting = 'Starting',
  CreatingBackup = 'CreatingBackup',
  CreatingRecoveryKey = 'CreatingRecoveryKey',
  BackingUp = 'BackingUp',
  RoomKeyUploadError = 'RoomKeyUploadError',
  Done = 'Done',
}

// --- Variant constructors, for building fixtures -------------------------

export const TimelineItemContent = {
  MsgLike: variant(TimelineItemContent_Tags.MsgLike),
  CallInvite: variant(TimelineItemContent_Tags.CallInvite),
  RtcNotification: variant(TimelineItemContent_Tags.RtcNotification),
  RoomMembership: variant(TimelineItemContent_Tags.RoomMembership),
  ProfileChange: variant(TimelineItemContent_Tags.ProfileChange),
  State: variant(TimelineItemContent_Tags.State),
  FailedToParseMessageLike: variant(TimelineItemContent_Tags.FailedToParseMessageLike),
  FailedToParseState: variant(TimelineItemContent_Tags.FailedToParseState),
};

export const MsgLikeKind = {
  Message: variant(MsgLikeKind_Tags.Message),
  Sticker: variant(MsgLikeKind_Tags.Sticker),
  Poll: variant(MsgLikeKind_Tags.Poll),
  Redacted: variant(MsgLikeKind_Tags.Redacted),
  UnableToDecrypt: variant(MsgLikeKind_Tags.UnableToDecrypt),
  Other: variant(MsgLikeKind_Tags.Other),
};

export const MessageType = {
  Emote: variant(MessageType_Tags.Emote),
  Image: variant(MessageType_Tags.Image),
  Audio: variant(MessageType_Tags.Audio),
  Video: variant(MessageType_Tags.Video),
  File: variant(MessageType_Tags.File),
  Gallery: variant(MessageType_Tags.Gallery),
  Notice: variant(MessageType_Tags.Notice),
  Text: variant(MessageType_Tags.Text),
  Location: variant(MessageType_Tags.Location),
  Other: variant(MessageType_Tags.Other),
};

export const EventOrTransactionId = {
  EventId: variant(EventOrTransactionId_Tags.EventId),
  TransactionId: variant(EventOrTransactionId_Tags.TransactionId),
};

export const UploadSource = {
  File: variant(UploadSource_Tags.File),
  Data: variant(UploadSource_Tags.Data),
};

export const EventSendState = {
  NotSentYet: variant(EventSendState_Tags.NotSentYet),
  SendingFailed: variant(EventSendState_Tags.SendingFailed),
  Sent: variant(EventSendState_Tags.Sent),
};

export const ProfileDetails = {
  Unavailable: variant(ProfileDetails_Tags.Unavailable),
  Pending: variant(ProfileDetails_Tags.Pending),
  Ready: variant(ProfileDetails_Tags.Ready),
  Error: variant(ProfileDetails_Tags.Error),
};

export const EnableRecoveryProgress = {
  Starting: variant(EnableRecoveryProgress_Tags.Starting),
  CreatingBackup: variant(EnableRecoveryProgress_Tags.CreatingBackup),
  CreatingRecoveryKey: variant(EnableRecoveryProgress_Tags.CreatingRecoveryKey),
  BackingUp: variant(EnableRecoveryProgress_Tags.BackingUp),
  RoomKeyUploadError: variant(EnableRecoveryProgress_Tags.RoomKeyUploadError),
  Done: variant(EnableRecoveryProgress_Tags.Done),
};

export const QueueWedgeError = {
  InsecureDevices: variant('InsecureDevices'),
  IdentityViolations: variant('IdentityViolations'),
  CrossVerificationRequired: variant('CrossVerificationRequired'),
  MissingMediaContent: variant('MissingMediaContent'),
  InvalidMimeType: variant('InvalidMimeType'),
  GenericApiError: variant('GenericApiError'),
};

export const MessageLikeEventType = {
  Reaction: variant('Reaction'),
  RoomEncrypted: variant('RoomEncrypted'),
  RoomMessage: variant('RoomMessage'),
  RoomRedaction: variant('RoomRedaction'),
  Sticker: variant('Sticker'),
  Other: variant('Other'),
};

export const EncryptedMessage = {
  OlmV1Curve25519AesSha2: variant('OlmV1Curve25519AesSha2'),
  MegolmV1AesSha2: variant('MegolmV1AesSha2'),
  Unknown: variant('Unknown'),
};
