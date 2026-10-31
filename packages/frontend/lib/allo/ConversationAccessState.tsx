import { Button } from '@oxy.so/bloom/button';
import { ChatEmptyState } from '@oxy.so/bloom/chat-screen';
import { IconCircle } from '@oxy.so/bloom/icon-circle';
import { RiShieldLine } from '@oxy.so/bloom/icons/RiShieldLine';
import { useOxy } from '@oxy.so/services/ui/client';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

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
      <ChatEmptyState
        illustration={
          state === 'checking' ? <ActivityIndicator /> : <IconCircle icon={RiShieldLine} />
        }
        title={t(
          state === 'session-unverified'
            ? 'session.unverified.title'
            : `supervision.${state}.title`,
        )}
        description={t(
          state === 'session-unverified' ? 'session.unverified.body' : `supervision.${state}.body`,
        )}
      />
      {state === 'unavailable' && onRetry ? (
        <Button onPress={onRetry}>{t('error.boundary.retry')}</Button>
      ) : null}
      {state === 'blocked' ? (
        <Button onPress={() => showBottomSheet?.({ screen: 'Supervision' })}>
          {t('supervision.review')}
        </Button>
      ) : null}
    </View>
  );
}
const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 20 },
});
