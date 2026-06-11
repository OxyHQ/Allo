import admin from 'firebase-admin';
import PushToken from '../models/PushToken';
import Message from '../models/Message';
import UserSettings from '../models/UserSettings';
import { isEncrypted } from './signalProtocol';
import { oxy } from '../../server';

let firebaseInitialized = false;

function initFirebase() {
  if (firebaseInitialized) return;
  const credsB64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
  const projectId = process.env.FIREBASE_PROJECT_ID;
  if (!credsB64 || !projectId) {
    console.warn('Push disabled: missing FIREBASE_SERVICE_ACCOUNT_BASE64 or FIREBASE_PROJECT_ID');
    return;
  }
  try {
    const json = Buffer.from(credsB64, 'base64').toString('utf-8');
    const serviceAccount = JSON.parse(json);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId,
    } as any);
    firebaseInitialized = true;
    console.log('Firebase Admin initialized for FCM');
  } catch (e) {
    console.error('Failed to initialize Firebase Admin:', e);
  }
}

export type PushPayload = {
  title: string;
  body: string;
  data?: Record<string, string>;
};

// Helper to safely create a concise single-line preview
function buildPreview(text: string, limit: number = 200): string {
  const trimmed = (text || '').replace(/\s+/g, ' ').trim();
  if (!trimmed) return '';
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export async function sendPushToUser(userId: string, payload: PushPayload) {
  initFirebase();
  if (!firebaseInitialized) return;
  try {
    const tokens = await PushToken.find({ userId, enabled: true }).lean();
    if (!tokens.length) return;
    const fcmTokens = tokens.filter(t => t.type === 'fcm').map(t => t.token);
    if (!fcmTokens.length) return;

    const tokenChunks = chunk(fcmTokens, 500); // FCM limit per multicast
    const toDisable: string[] = [];
    for (const tkChunk of tokenChunks) {
      const message: admin.messaging.MulticastMessage = {
        tokens: tkChunk,
        notification: {
          title: payload.title,
          body: payload.body,
        },
        data: payload.data || {},
        android: {
          priority: 'high',
          notification: { channelId: 'default' },
        },
        apns: {
          payload: { aps: { sound: 'default' } },
        },
      };
      const resp = await admin.messaging().sendEachForMulticast(message);
      // Cleanup invalid tokens in this chunk
      if (resp.responses) {
        resp.responses.forEach((r, idx) => {
          if (!r.success) {
            const code = (r.error as any)?.errorInfo?.code || r.error?.code;
            if (code && (code.includes('registration-token-not-registered') || code.includes('invalid-argument'))) {
              const bad = tkChunk[idx];
              if (bad) toDisable.push(bad);
            }
          }
        });
      }
    }
    if (toDisable.length) {
      await PushToken.updateMany({ token: { $in: toDisable } }, { enabled: false });
      console.log('Disabled invalid push tokens:', toDisable.length);
    }
  } catch (e) {
    console.error('Failed to send push:', e);
  }
}

export async function formatPushForNotification(n: any) {
  // Best-effort: hydrate actor for title/body
  let actorName = 'Someone';
  try {
    if (n.actorId && n.actorId !== 'system') {
      const actor = await oxy.getUserById(n.actorId);
      actorName = actor?.name?.full || actor?.username || actorName;
    } else if (n.actorId === 'system') {
      actorName = 'System';
    }
  } catch {}
  const map: Record<string, { title: string; body: string }> = {
    message: { title: 'New message', body: `${actorName} sent you a message` },
    welcome: { title: 'Welcome to Allo', body: 'Thanks for joining!' },
  };
  let f = map[n.type] || { title: 'Notification', body: 'You have a new notification' };
  let preview: string | undefined;
  // For message notifications, try to include a short preview in the push body.
  // Respects the recipient's privacy setting (notifications.showMessagePreview).
  // Since the app is E2E encrypted the server cannot read message content:
  // a preview is only possible for legacy plaintext messages; encrypted
  // messages keep the generic "sent you a message" body.
  try {
    if (n.type === 'message' && n.entityType === 'message' && n.entityId) {
      // Check recipient's privacy preference (default: show preview)
      let showPreview = true;
      try {
        if (n.recipientId) {
          const settings = await UserSettings.findOne(
            { oxyUserId: n.recipientId },
            { 'notifications.showMessagePreview': 1 }
          ).lean();
          if (settings?.notifications?.showMessagePreview === false) {
            showPreview = false;
          }
        }
      } catch {}

      if (!showPreview) {
        // Maximum privacy: hide sender identity too
        f = { title: 'Allo', body: 'New message' };
      } else {
        const message: any = await Message.findById(n.entityId, {
          ciphertext: 1,
          encryptedMedia: 1,
          text: 1,
          media: 1,
        }).lean();
        if (message && !isEncrypted(message)) {
          // Legacy plaintext message: include a short text preview
          const text: string = message?.text || '';
          preview = buildPreview(text, 200);
          if (preview) {
            f = { title: 'New message', body: `${actorName}: ${preview}` };
          } else if (message?.media?.length) {
            f = { title: 'New message', body: `${actorName} sent ${message.media.length} media file(s)` };
          }
        }
        // Encrypted message: keep the default `${actorName} sent you a message`
      }
    }
  } catch {}
  const data: Record<string, string> = {
    type: String(n.type || ''),
    entityId: String((n as any).entityId || ''),
    entityType: String(n.entityType || ''),
    actorId: String(n.actorId || ''),
    notificationId: String(n._id || ''),
  };
  if (preview) data.preview = preview;
  return { title: f.title, body: f.body, data };
}
