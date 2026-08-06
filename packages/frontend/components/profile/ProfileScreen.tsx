import React, { useCallback, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';

import { Button } from '@oxyhq/bloom/button';
import { Skeleton } from '@oxyhq/bloom';
import { toast } from '@oxyhq/bloom/toast';
import { useOxy } from '@oxyhq/services';

import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { Header } from '@/components/layout/Header';
import { HeaderIconButton } from '@/components/layout/HeaderIconButton';
import { ProfileIdentity } from '@/components/profile/ProfileIdentity';
import { EmptyState } from '@/components/shared/EmptyState';
import { ThemedText } from '@/components/ThemedText';
import { ThemedView } from '@/components/ThemedView';
import { useAvatarShape } from '@/hooks/useAvatarShape';
import { useCreateConversation } from '@/hooks/useCreateConversation';
import { useProfileData } from '@/hooks/useProfileData';
import { useTheme } from '@/hooks/useTheme';
import { getErrorMessage } from '@/utils/errors';
import { logger } from '@/utils/logger';

/**
 * A PERSON, in a messenger.
 *
 * Allo is not a social feed and this is not Mention's profile: there are no
 * posts to page through, no follower counts and no tabs. What a reader wants from
 * `/@alice` here is to check they have the right Alice and then talk to her, so
 * the screen is her picture, her name, her handle, whatever she wrote about
 * herself, and one button.
 *
 * The identity block is `ProfileIdentity`, the same component the conversation
 * details pane draws, so the two cannot drift.
 *
 * Takes the handle as a PROP rather than reading the route. On a wide window
 * `app/(chat)/_layout.tsx` chooses each pane's contents from the pathname instead
 * of letting the navigator do it, so this is rendered in two places and only one
 * of them has route params — the same reason the conversation view is handed its
 * id.
 */
export function ProfileScreen({ handle }: { handle: string }) {
  const { t } = useTranslation();
  const theme = useTheme();
  const router = useRouter();
  const { user: viewer, oxyServices } = useOxy();
  const createConversation = useCreateConversation();

  const { data: profile, loading, notFound } = useProfileData(handle);
  const avatarShape = useAvatarShape(profile?.id);
  const [isOpening, setIsOpening] = useState(false);

  /**
   * Reading your own profile.
   *
   * Compared by id and not by handle: a handle can be changed, and the URL that
   * was typed a moment before the change would otherwise offer you a
   * conversation with yourself.
   */
  const isViewer = profile !== null && viewer?.id === profile.id;

  const avatarUrl = useMemo(() => {
    const avatar = profile?.design.avatar;
    if (!avatar) return undefined;
    if (avatar.startsWith('http') || avatar.startsWith('file://')) return avatar;
    return oxyServices.getFileDownloadUrl(avatar, 'thumb');
  }, [profile?.design.avatar, oxyServices]);

  const openConversation = useCallback(async () => {
    if (profile === null || isOpening) return;
    setIsOpening(true);
    try {
      const conversationId = await createConversation({
        participantIds: [profile.id],
        name: undefined,
      });
      router.push(`/c/${conversationId}`);
    } catch (error: unknown) {
      logger.error('[Profile] Could not open a conversation:', error);
      toast.error(getErrorMessage(error) || t('Failed to create conversation'));
    } finally {
      setIsOpening(false);
    }
  }, [createConversation, isOpening, profile, router, t]);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        content: {
          paddingHorizontal: 16,
          paddingTop: 24,
          paddingBottom: 32,
        },
        loading: {
          alignItems: 'center',
          paddingTop: 24,
          gap: 12,
        },
        section: {
          marginBottom: 24,
        },
        sectionTitle: {
          fontSize: 16,
          fontWeight: '600',
          color: theme.colors.text,
          marginBottom: 8,
        },
        bio: {
          fontSize: 15,
          lineHeight: 22,
          color: theme.colors.text,
        },
        actions: {
          gap: 12,
        },
      }),
    [theme],
  );

  const header = (
    <Header
      options={{
        title: profile?.design.displayName || `@${handle}`,
        leftComponents: [
          <HeaderIconButton key="back" onPress={() => router.back()}>
            <BackArrowIcon size={20} color={theme.colors.text} />
          </HeaderIconButton>,
        ],
      }}
      hideBottomBorder
      disableSticky
    />
  );

  if (loading) {
    return (
      <ThemedView className="flex-1">
        {header}
        <View style={styles.loading}>
          <Skeleton.Circle size={100} />
          <Skeleton.Pill size={20} style={{ width: 180 }} />
          <Skeleton.Pill size={14} style={{ width: 120 }} />
        </View>
      </ThemedView>
    );
  }

  if (profile === null) {
    return (
      <ThemedView className="flex-1">
        {header}
        <EmptyState
          lottieSource={require('@/assets/lottie/welcome.json')}
          title={notFound ? t('profile.notFound') : t('profile.loadFailed')}
          subtitle={notFound ? t('profile.notFoundSubtitle', { handle }) : undefined}
        />
      </ThemedView>
    );
  }

  return (
    <ThemedView className="flex-1">
      {header}
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <ProfileIdentity
          displayName={profile.design.displayName || profile.username}
          handle={profile.username || handle}
          avatarUrl={avatarUrl}
          avatarShape={avatarShape}
          verified={profile.verified}
        />

        {profile.bio ? (
          <View style={styles.section}>
            <ThemedText style={styles.sectionTitle}>{t('profile.about')}</ThemedText>
            <ThemedText style={styles.bio}>{profile.bio}</ThemedText>
          </View>
        ) : null}

        {isViewer ? null : (
          <View style={styles.actions}>
            <Button
              variant="primary"
              loading={isOpening}
              onPress={() => {
                void openConversation();
              }}
            >
              {t('profile.message')}
            </Button>
          </View>
        )}
      </ScrollView>
    </ThemedView>
  );
}

export default ProfileScreen;
