import { Platform } from "react-native";

// Do not statically import 'expo-notifications' to avoid bundling it on web.
// Use a cached dynamic import so the package is only loaded on native platforms.
let notificationsModule: typeof import('expo-notifications') | null = null;
async function getNotifications(): Promise<typeof import('expo-notifications') | null> {
  if (Platform.OS === 'web') return null;
  if (!notificationsModule) {
    notificationsModule = await import('expo-notifications');
  }
  return notificationsModule;
}

export async function requestNotificationPermissions() {
  const Notifications = await getNotifications();
  if (!Notifications) return false;
  const { status } = await Notifications.requestPermissionsAsync();
  return status === "granted";
}

export async function hasNotificationPermission(): Promise<boolean> {
  const Notifications = await getNotifications();
  if (!Notifications) return false;
  try {
    const { status } = await Notifications.getPermissionsAsync();
    return status === 'granted';
  } catch (e) {
    console.warn('Failed to get notification permissions status:', e);
    return false;
  }
}

export async function createNotification(
  title: string,
  body: string,
  data: Record<string, unknown> = {}
) {
  const Notifications = await getNotifications();
  if (!Notifications) return;
  await Notifications.scheduleNotificationAsync({
    content: {
      title,
      body,
      data,
    },
    trigger: null, // Shows notification immediately
  });
}

export async function setupNotifications() {
  const Notifications = await getNotifications();
  if (!Notifications) return;
  // Android channel setup for high-importance notifications
  if (Platform.OS === 'android') {
    try {
      await Notifications.setNotificationChannelAsync('default', {
        name: 'Default',
        importance: Notifications.AndroidImportance.MAX,
        vibrationPattern: [0, 250, 250, 250],
        lightColor: '#FF231F7C',
        lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
        showBadge: true,
      });
    } catch (e) {
      console.warn('Failed to set Android notification channel:', e);
    }
  }
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
      shouldShowBanner: true,
      shouldShowList: true,
    }),
  });
}

export type DevicePushToken = { token: string; type: 'fcm' | 'apns' | 'unknown' } | null;

export async function getDevicePushToken(): Promise<DevicePushToken> {
  const Notifications = await getNotifications();
  if (!Notifications) return null;
  try {
    // On Android managed builds with FCM configured, this returns the FCM token.
    // expo's DevicePushToken is `{ type: 'ios' | 'android'; data: string }`; we
    // re-map the platform to the FCM/APNS scheme our backend expects.
    const devicePushToken = await Notifications.getDevicePushTokenAsync();
    const pushType: 'fcm' | 'apns' = Platform.OS === 'ios' ? 'apns' : 'fcm';
    if (typeof devicePushToken?.data === 'string') {
      return { token: devicePushToken.data, type: pushType };
    }
    // Fallback shape on some SDK versions that expose `{ token }` instead.
    const fallbackTok = devicePushToken as unknown as { token?: string } | undefined;
    if (fallbackTok?.token) {
      return { token: fallbackTok.token, type: pushType };
    }
  } catch (e) {
    console.warn('Failed to get device push token:', e);
  }
  return null;
}
