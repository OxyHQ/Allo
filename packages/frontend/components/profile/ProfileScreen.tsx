import { toast } from '@oxy.so/bloom/toast';
import { useQuery } from '@tanstack/react-query';
import { useMessagingSupervision } from '@/lib/allo/MessagingSupervision';
import { ConversationAccessState } from '@/lib/allo/ConversationAccessState';
import { useCreateConversation } from '@/hooks/useCreateConversation';
import { RiMessage2Line } from '@oxy.so/bloom/icons/RiMessage2Line';
import { RiUserSearchLine } from '@oxy.so/bloom/icons/RiUserSearchLine';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { Text } from '@oxy.so/bloom/typography';
import { useOxy } from '@oxy.so/services/ui/client';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { StyleSheet } from 'react-native';

import { ProfileIdentity } from '@/components/profile/ProfileIdentity';
import { useProfileData } from '@/hooks/useProfileData';

import {
  Button as LButton,
  Card as LCard,
  ChatEmptyState as LChatEmptyState,
  Embed,
  Header,
  Icon,
  IconCircle as LIconCircle,
  ScrollView,
  Text as LText,
  VStack,
  toElement,
} from '@oxy.so/bloom-language';
import { screen } from '@oxy.so/bloom-language/router';

/**
 * A PERSON, in a messenger: who they are and a button to talk to them. No
 * posts, no counts, no tabs.
 *
 * Takes the handle as a PROP rather than reading the route: on a wide window
 * the chat layout picks the pane's contents from the pathname, and only one of
 * the two places this renders has route params.
 */
export function ProfileScreen({ handle }: { handle: string }) {
  return useMessagingSupervision() ? (
    <SupervisedProfile handle={handle} />
  ) : (
    <OrdinaryProfile handle={handle} />
  );
}

const SupervisedProfile = screen(function SupervisedProfile({ handle }: { handle: string }) {
  const { t } = useTranslation();
  const { oxyServices, user, activeSessionId } = useOxy();
  const router = useRouter();
  const create = useCreateConversation();
  const query = useQuery({
    queryKey: ['supervised-person', user?.id, activeSessionId, handle],
    staleTime: 0,
    refetchOnMount: 'always',
    queryFn: async () => {
      const response = await oxyServices.safety.people({ query: handle });
      return (
        response.items.find((person) => person.username?.toLowerCase() === handle.toLowerCase()) ??
        null
      );
    },
  });
  const person = query.isFetchedAfterMount && !query.isError ? query.data : undefined;
  return ScrollView(
    Embed(
      query.isError ? (
        <ConversationAccessState
          state="unavailable"
          onRetry={() => {
            void query.refetch();
          }}
        />
      ) : !query.isFetchedAfterMount ? (
        <ConversationAccessState state="checking" />
      ) : !person ? (
        <ConversationAccessState state="blocked" />
      ) : (
        <>
          <ProfileIdentity
            displayName={person.displayName ?? person.username ?? ''}
            handle={person.username ?? ''}
          />
          {person.accountId !== user?.id
            ? toElement(
                LButton(LText(t('profile.message'))).onPress(() => {
                  void create({ participantIds: [person.accountId], name: undefined })
                    .then((id) => router.push(`/c/${id}`))
                    .catch(() => toast.error(t('chat.new.failed')));
                }),
              )
            : null}
        </>
      ),
    ),
  )
    .keyboardTaps('handled')
    .contentView((v) => v.padding('horizontal', 'lg').padding('bottom', '3xl').spacing('lg'))
    .screenScroll('content')
    .header(Header(t('supervision.conversation')).inPage());
});

const OrdinaryProfile = screen(function OrdinaryProfile({ handle }: { handle: string }) {
  const { t } = useTranslation();
  const router = useRouter();
  const { user: viewer } = useOxy();
  const { data: profile, loading, notFound } = useProfileData(handle);

  // By id, not handle: a handle can change under a URL typed a moment earlier.
  const isViewer = profile !== null && viewer?.id === profile.id;

  return ScrollView(
    Embed(
      loading ? (
        toElement(
          VStack(
            Embed(<Skeleton.Circle size={96} />),
            Embed(<Skeleton.Text style={styles.skeletonName} />),
            Embed(<Skeleton.Text style={styles.skeletonHandle} />),
          )
            .padding('top', 'sm')
            .align('center')
            .spacing('md')
            .accessibilityState({ busy: true }),
        )
      ) : profile === null ? (
        toElement(
          LChatEmptyState({
            title: notFound ? t('profile.notFound') : t('profile.loadFailed'),
            description: notFound ? t('profile.notFoundSubtitle', { handle }) : undefined,
            illustration: LIconCircle(RiUserSearchLine),
          }),
        )
      ) : (
        <>
          <ProfileIdentity
            displayName={profile.design.displayName || profile.username}
            handle={profile.username || handle}
            avatar={profile.avatar}
            verified={profile.verified}
          />
          {isViewer
            ? null
            : toElement(
                LButton(Icon(RiMessage2Line), LText(t('profile.message')))
                  .size('lg')
                  .onPress(() => router.push(`/c/${profile.id}`))
                  .frame({ minWidth: '200' })
                  .alignSelf('center'),
              )}
          {profile.bio
            ? toElement(
                LCard(
                  LText(t('profile.about')).foreground('muted').font('body').weight('semibold'),
                  Embed(
                    <Text variant="body-regular" selectable>
                      {profile.bio}
                    </Text>,
                  ),
                )
                  .radius('lg')
                  .style('outline')
                  .padding('all', 'lg')
                  .spacing('6'),
              )
            : null}
        </>
      ),
    ),
  )
    .keyboardTaps('handled')
    .contentView((v) => v.padding('horizontal', 'lg').padding('bottom', '3xl').spacing('lg'))
    .screenScroll('content')
    .header(Header(profile?.design.displayName || `@${handle}`).inPage());
});

const styles = StyleSheet.create({
  skeletonName: { width: 180, lineHeight: 26 },
  skeletonHandle: { width: 120, lineHeight: 20 },
});

export default ProfileScreen;
