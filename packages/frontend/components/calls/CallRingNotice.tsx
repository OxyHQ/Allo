import { Admonition } from '@oxy.so/bloom/admonition';
import { useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform } from 'react-native';

import { callPushStore } from '@/lib/allo/nativeCalls';

/**
 * The one thing the calls screens owe a reader about ringing: drawn only on a
 * phone that CANNOT ring while Allo is closed (no push token — a build without
 * Firebase, a phone without Google Play services). A phone that can ring, and
 * the web, where a call reaches the open tabs as everyone expects, draw nothing.
 */
export function CallRingNotice() {
  const { t } = useTranslation();
  const state = useSyncExternalStore(callPushStore.subscribe, callPushStore.get, callPushStore.get);
  if (Platform.OS === 'web' || state !== 'unavailable') return null;
  return <Admonition type="info">{t('calls.cannotRingClosed')}</Admonition>;
}
