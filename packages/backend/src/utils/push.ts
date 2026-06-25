import admin from 'firebase-admin';
import PushToken from '../models/PushToken';
import { oxy } from '../../server';
import { logger } from './logger';

let firebaseInitialized = false;

function initFirebase() {
  if (firebaseInitialized) return;
  const credsB64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
  const projectId = process.env.FIREBASE_PROJECT_ID;
  if (!credsB64 || !projectId) {
    logger.warn('Push disabled: missing FIREBASE_SERVICE_ACCOUNT_BASE64 or FIREBASE_PROJECT_ID');
    return;
  }
  try {
    const json = Buffer.from(credsB64, 'base64').toString('utf-8');
    const serviceAccount = JSON.parse(json) as admin.ServiceAccount;
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId,
    });
    firebaseInitialized = true;
    logger.info('Firebase Admin initialized for FCM');
  } catch (e) {
    logger.error('Failed to initialize Firebase Admin', e);
  }
}

export type PushPayload = {
  title: string;
  body: string;
  data?: Record<string, string>;
};

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
            const errorWithInfo = r.error as (admin.FirebaseError & { errorInfo?: { code?: string } }) | undefined;
            const code = errorWithInfo?.errorInfo?.code || errorWithInfo?.code;
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
      logger.info('Disabled invalid push tokens:', toDisable.length);
    }
  } catch (e) {
    logger.error('Failed to send push', e);
  }
}

/** Input accepted by {@link formatPushForNotification}. */
export interface PushNotificationInput {
  type?: string;
  actorId?: string;
  entityId?: string;
  entityType?: string;
  _id?: string;
}

export async function formatPushForNotification(n: PushNotificationInput): Promise<PushPayload> {
  // Best-effort: hydrate actor for title/body. Render the API's canonical
  // name.displayName directly.
  let actorName = 'Someone';
  try {
    if (n.actorId && n.actorId !== 'system') {
      const actor = await oxy.getUserById(n.actorId);
      actorName = actor?.name?.displayName || actor?.username || actorName;
    } else if (n.actorId === 'system') {
      actorName = 'System';
    }
  } catch (e) {
    logger.warn('formatPushForNotification: failed to hydrate actor', e);
  }
  const map: Record<string, { title: string; body: string }> = {
    message: { title: 'New message', body: `${actorName} sent you a message` },
    welcome: { title: 'Welcome to Allo', body: 'Thanks for joining!' },
  };
  const f = map[n.type ?? ''] || { title: 'Notification', body: 'You have a new notification' };
  const data: Record<string, string> = {
    type: String(n.type || ''),
    entityId: String(n.entityId || ''),
    entityType: String(n.entityType || ''),
    actorId: String(n.actorId || ''),
    notificationId: String(n._id || ''),
  };
  return { title: f.title, body: f.body, data };
}
