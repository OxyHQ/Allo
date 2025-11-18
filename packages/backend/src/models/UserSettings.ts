import mongoose, { Schema, Document } from 'mongoose';

export type ThemeMode = 'light' | 'dark' | 'system';

export interface AppearanceSettings {
  themeMode: ThemeMode;
  primaryColor?: string;
}

export interface PrivacySettings {
  profileVisibility: 'public' | 'private' | 'followers_only';
  showContactInfo?: boolean;
  allowTags?: boolean;
  allowallos?: boolean;
  showOnlineStatus?: boolean;
  hideLikeCounts?: boolean;
  hideShareCounts?: boolean;
  hideReplyCounts?: boolean;
  hideSaveCounts?: boolean;
  hiddenWords?: string[];
  restrictedUsers?: string[]; // Users who can see limited content
}

export interface SecuritySettings {
  cloudSyncEnabled?: boolean; // Enable cloud backup/sync (default: false for device-first)
  encryptionEnabled?: boolean; // Signal Protocol encryption (default: true)
  peerToPeerEnabled?: boolean; // Enable P2P messaging when possible (default: true)
}

export interface ProfileCustomization {
  coverPhotoEnabled?: boolean;
  minimalistMode?: boolean;
  displayName?: string; // Custom display name (overrides Oxy profile name)
  coverImage?: string; // Custom cover image (alternative to profileHeaderImage)
}

export interface IUserSettings extends Document {
  oxyUserId: string;
  appearance: AppearanceSettings;
  profileHeaderImage?: string;
  privacy?: PrivacySettings;
  profileCustomization?: ProfileCustomization;
  security?: SecuritySettings;
  createdAt: Date;
  updatedAt: Date;
}

const AppearanceSchema = new Schema<AppearanceSettings>({
  themeMode: { type: String, enum: ['light', 'dark', 'system'], default: 'system' },
  primaryColor: { type: String, default: undefined },
}, { _id: false });

const PrivacySchema = new Schema<PrivacySettings>({
  profileVisibility: { type: String, enum: ['public', 'private', 'followers_only'], default: 'public' },
  showContactInfo: { type: Boolean, default: true },
  allowTags: { type: Boolean, default: true },
  allowallos: { type: Boolean, default: true },
  showOnlineStatus: { type: Boolean, default: true },
  hideLikeCounts: { type: Boolean, default: false },
  hideShareCounts: { type: Boolean, default: false },
  hideReplyCounts: { type: Boolean, default: false },
  hideSaveCounts: { type: Boolean, default: false },
  hiddenWords: [{ type: String }],
  restrictedUsers: [{ type: String }],
}, { _id: false });

const ProfileCustomizationSchema = new Schema<ProfileCustomization>({
  coverPhotoEnabled: { type: Boolean, default: true },
  minimalistMode: { type: Boolean, default: false },
  displayName: { type: String },
  coverImage: { type: String },
}, { _id: false });

const SecuritySchema = new Schema({
  cloudSyncEnabled: { type: Boolean, default: false }, // Device-first by default
  encryptionEnabled: { type: Boolean, default: true }, // Encryption always enabled
  peerToPeerEnabled: { type: Boolean, default: true }, // P2P enabled by default
}, { _id: false });

const UserSettingsSchema = new Schema<IUserSettings>({
  oxyUserId: { type: String, required: true, index: true, unique: true },
  appearance: { type: AppearanceSchema, default: () => ({ themeMode: 'system' }) },
  profileHeaderImage: { type: String },
  privacy: { type: PrivacySchema, default: () => ({ profileVisibility: 'public' }) },
  profileCustomization: { type: ProfileCustomizationSchema },
  security: { type: SecuritySchema, default: () => ({ cloudSyncEnabled: false, encryptionEnabled: true, peerToPeerEnabled: true }) },
}, { timestamps: true, versionKey: false });

export const UserSettings = mongoose.model<IUserSettings>('UserSettings', UserSettingsSchema);

export default UserSettings;

