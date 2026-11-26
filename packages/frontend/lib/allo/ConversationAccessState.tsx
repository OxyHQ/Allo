import { RiShieldLine } from '@oxy.so/bloom/icons/RiShieldLine';
import { useOxy } from '@oxy.so/services/ui/client';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import {
  Button as LButton,
  ChatEmptyState as LChatEmptyState,
  Embed,
  IconCircle as LIconCircle,
  Text,
  toElement,
} from '@oxy.so/bloom-language';

export function ConversationAccessState({
  state,
  onRetry,
}: {
  state: 'checking' | 'blocked' | 'unavailable' | 'unsupported' | 'session-unverified';
  onRetry?: () => void;
}) {
  const { t } = useTranslation(undefined, { useSuspense: false });
  const { showBottomSheet } = useOxy();
  return (
    <View
      style={styles.root}
      accessibilityState={{ busy: state === 'checking' }}
      accessibilityRole={state === 'session-unverified' ? 'alert' : undefined}
      accessibilityLiveRegion={state === 'session-unverified' ? 'polite' : undefined}
    >
      {toElement(
        LChatEmptyState({
          title: t(
            state === 'session-unverified'
              ? 'session.unverified.title'
              : `supervision.${state}.title`,
          ),
          description: t(
            state === 'session-unverified'
              ? 'session.unverified.body'
              : `supervision.${state}.body`,
          ),
          illustration: Embed(
            state === 'checking' ? <ActivityIndicator /> : toElement(LIconCircle(RiShieldLine)),
          ),
        }),
      )}
      {state === 'unavailable' && onRetry
        ? toElement(LButton(Text(t('error.boundary.retry'))).onPress(onRetry))
        : null}
      {state === 'blocked'
        ? toElement(
            LButton(Text(t('supervision.review'))).onPress(() =>
              showBottomSheet?.({ screen: 'Supervision' }),
            ),
          )
        : null}
    </View>
  );
}
const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 20 },
});
