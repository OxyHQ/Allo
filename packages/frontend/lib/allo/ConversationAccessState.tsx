import { RiShieldLine } from '@oxy.so/bloom/icons/RiShieldLine';
import { useOxy } from '@oxy.so/services/ui/client';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator } from 'react-native';

import { Button, Embed, IconCircle, Text, VStack, toElement } from '@oxy.so/bloom-language';
import { ChatEmptyState } from '@oxy.so/bloom-language/chat';

export function ConversationAccessState({
  state,
  onRetry,
}: {
  state: 'checking' | 'blocked' | 'unavailable' | 'unsupported' | 'session-unverified';
  onRetry?: () => void;
}) {
  const { t } = useTranslation(undefined, { useSuspense: false });
  const { showBottomSheet } = useOxy();
  const unverified = state === 'session-unverified';
  const view = VStack(
    ChatEmptyState({
      title: t(unverified ? 'session.unverified.title' : `supervision.${state}.title`),
      description: t(unverified ? 'session.unverified.body' : `supervision.${state}.body`),
      illustration: state === 'checking' ? Embed(<ActivityIndicator />) : IconCircle(RiShieldLine),
    }),
    state === 'unavailable' && onRetry
      ? Button(Text(t('error.boundary.retry'))).onPress(onRetry)
      : null,
    state === 'blocked'
      ? Button(Text(t('supervision.review'))).onPress(() =>
          showBottomSheet?.({ screen: 'Supervision' }),
        )
      : null,
  )
    .padding('all', '2xl')
    .align('center')
    .justify('center')
    .spacing('xl')
    .grow()
    .accessibilityState({ busy: state === 'checking' });
  // An unverified session is announced as it appears; the other states are read when reached.
  return toElement(unverified ? view.role('alert').liveRegion('polite') : view);
}
