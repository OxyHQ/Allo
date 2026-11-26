import { RiCompass3Line } from '@oxy.so/bloom/icons/RiCompass3Line';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import {
  Button as LButton,
  HStack,
  IconCircle as LIconCircle,
  Text,
  VStack,
} from '@oxy.so/bloom-language';
import { ChatEmptyState as LChatEmptyState } from '@oxy.so/bloom-language/chat';
import { screen } from '@oxy.so/bloom-language/router';

/** A path that names nothing: say so, and offer the way back and the way home. */
export default screen(function NotFoundScreen() {
  const router = useRouter();
  const { t } = useTranslation();

  return VStack(
    LChatEmptyState({
      title: t('notFound.title'),
      description: t('notFound.description'),
      illustration: LIconCircle(RiCompass3Line),
      action: HStack(
        router.canGoBack()
          ? LButton(Text(t('notFound.goBack')))
              .onPress(() => router.back())
              .tint('neutral')
              .style('outline')
          : null,
        LButton(Text(t('notFound.goHome'))).onPress(() => router.replace('/')),
      )
        .wrap()
        .justify('center')
        .spacing('sm'),
    }),
  )
    .justify('center')
    .grow()
    .header(false)
    .screenScroll('none');
});
