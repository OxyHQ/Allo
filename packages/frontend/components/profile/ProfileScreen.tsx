import { toast } from '@oxy.so/bloom/toast';
import { useQuery } from '@tanstack/react-query';
import { useMessagingSupervision } from '@/lib/allo/MessagingSupervision';
import { ConversationAccessState } from '@/lib/allo/ConversationAccessState';
import { useCreateConversation } from '@/hooks/useCreateConversation';
import { Button } from '@oxy.so/bloom/button';
import { Card } from '@oxy.so/bloom/card';
import { ChatEmptyState } from '@oxy.so/bloom/chat-screen';
import { IconCircle } from '@oxy.so/bloom/icon-circle';
import { RiMessage2Line } from '@oxy.so/bloom/icons/RiMessage2Line';
import { RiUserSearchLine } from '@oxy.so/bloom/icons/RiUserSearchLine';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { useTheme } from '@oxy.so/bloom/theme';
import { Text } from '@oxy.so/bloom/typography';
import { useOxy } from '@oxy.so/services/ui/client';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import { ProfileIdentity } from '@/components/profile/ProfileIdentity';
import { Page } from '@/components/shell/Page';
import { useProfileData } from '@/hooks/useProfileData';

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

function SupervisedProfile({ handle }: { handle: string }) {
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
  return (
    <Page title={t('supervision.conversation')}>
      {query.isError ? (
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
          {person.accountId !== user?.id ? (
            <Button
              onPress={() => {
                void create({ participantIds: [person.accountId], name: undefined })
                  .then((id) => router.push(`/c/${id}`))
                  .catch(() => toast.error(t('chat.new.failed')));
              }}
            >
              {t('profile.message')}
            </Button>
          ) : null}
        </>
      )}
    </Page>
  );
}

function OrdinaryProfile({ handle }: { handle: string }) {
  const { t } = useTranslation();
  const theme = useTheme();
  const router = useRouter();
  const { user: viewer } = useOxy();
  const { data: profile, loading, notFound } = useProfileData(handle);

  // By id, not handle: a handle can change under a URL typed a moment earlier.
  const isViewer = profile !== null && viewer?.id === profile.id;

  return (
    <Page title={profile?.design.displayName || `@${handle}`}>
      {loading ? (
        <View style={styles.skeleton} accessibilityState={{ busy: true }}>
          <Skeleton.Circle size={96} />
          <Skeleton.Text style={styles.skeletonName} />
          <Skeleton.Text style={styles.skeletonHandle} />
        </View>
      ) : profile === null ? (
        <ChatEmptyState
          illustration={<IconCircle icon={RiUserSearchLine} />}
          title={notFound ? t('profile.notFound') : t('profile.loadFailed')}
          description={notFound ? t('profile.notFoundSubtitle', { handle }) : undefined}
        />
      ) : (
        <>
          <ProfileIdentity
            displayName={profile.design.displayName || profile.username}
            handle={profile.username || handle}
            avatar={profile.avatar}
            verified={profile.verified}
          />
          {isViewer ? null : (
            <Button
              size="lg"
              leadingIcon={RiMessage2Line}
              onPress={() => router.push(`/c/${profile.id}`)}
              style={styles.message}
            >
              {t('profile.message')}
            </Button>
          )}
          {profile.bio ? (
            <Card radius="radius-16" style={styles.about} appearance="outline">
              <Text variant="body-semibold" style={{ color: theme.colors.textSecondary }}>
                {t('profile.about')}
              </Text>
              <Text variant="body-regular" selectable>
                {profile.bio}
              </Text>
            </Card>
          ) : null}
        </>
      )}
    </Page>
  );
}

const styles = StyleSheet.create({
  skeleton: { alignItems: 'center', gap: 12, paddingTop: 8 },
  skeletonName: { width: 180, lineHeight: 26 },
  skeletonHandle: { width: 120, lineHeight: 20 },
  message: { alignSelf: 'center', minWidth: 200 },
  about: { padding: 16, gap: 6 },
});

export default ProfileScreen;
