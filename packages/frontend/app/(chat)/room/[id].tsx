import React, { useCallback, useMemo, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, FlatList, StyleSheet, TouchableOpacity, View } from 'react-native';
import { useLocalSearchParams, useRouter, type Href } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Ionicons } from '@expo/vector-icons';
import { TextFieldInput } from '@oxyhq/bloom';
import { toast } from '@oxyhq/bloom/toast';

import Avatar from '@/components/Avatar';
import { Header } from '@/components/layout/Header';
import { MatrixSignInGate } from '@/components/matrix/MatrixSignInGate';
import { ThemedText } from '@/components/ThemedText';
import { ThemedView } from '@/components/ThemedView';
import { useMatrixRuntime } from '@/hooks/useMatrixRuntime';
import { useTheme } from '@/hooks/useTheme';
import { CHAT_BACKEND } from '@/lib/chat/backend';
import { roomAdminSource, type RoomAdminSnapshot } from '@/lib/chat/roomAdmin';
import type { AlloRoomMember } from '@/lib/matrix/types';
import { confirmDialog } from '@/utils/alerts';
import { getErrorMessage } from '@/utils/errors';
import { logger } from '@/utils/logger';

/**
 * Administering a conversation: who is in it, adding somebody, its name, and
 * the way out.
 *
 * **Matrix only, and a route of its own rather than a branch in
 * `ContactDetails`.** Everything on this screen is read from a room's state and
 * its power levels; the Express backend has none of that, its participants come
 * from a Mongo document, and the two would share a title and nothing else. The
 * same reasoning as `MatrixConversationRoute` in `c/[id].tsx`: a component
 * boundary, not a conditional inside one body.
 *
 * A conversation reached here on the Express backend renders nothing but the
 * header, which is what a route that cannot exist should do — see
 * {@link RoomAdminScreen}.
 */

/** How long a group's name may be. The same cap the New Chat screen applies. */
const GROUP_NAME_MAX_LENGTH = 64;

export default function RoomAdminRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t } = useTranslation();

  if (CHAT_BACKEND !== 'matrix' || !id) {
    // Not reachable from the app's own navigation, which only offers this route
    // on the Matrix backend. A typed URL is the way here, and an honest empty
    // screen beats a spinner over a room that can never load.
    return (
      <ThemedView style={{ flex: 1 }}>
        <Header options={{ title: t('Conversation'), showBackButton: true }} />
      </ThemedView>
    );
  }
  return (
    <ThemedView style={{ flex: 1 }}>
      <Header options={{ title: t('Conversation details'), showBackButton: true }} />
      <MatrixSignInGate>
        <RoomAdminScreen roomId={id} />
      </MatrixSignInGate>
    </ThemedView>
  );
}

function RoomAdminScreen({ roomId }: { readonly roomId: string }) {
  const { t } = useTranslation();
  const theme = useTheme();
  const router = useRouter();
  const runtime = useMatrixRuntime();

  // The source is per room and keyed by it, so a different room is a different
  // store rather than the same one holding somebody else's members.
  const source = useMemo(() => roomAdminSource(roomId), [roomId]);
  const snapshot = useSyncExternalStore(source.subscribe, source.getSnapshot, emptySnapshot);
  const [isLeaving, setIsLeaving] = useState(false);

  const styles = useStyles();
  const details = snapshot.details;
  const rights = details?.rights;

  const leave = useCallback(async () => {
    if (isLeaving) {
      return;
    }
    const confirmed = await confirmDialog({
      title: t('Leave this conversation?'),
      message: t(
        'You will stop receiving its messages, and you can only come back if somebody invites you again.',
      ),
      okText: t('Leave'),
      cancelText: t('Cancel'),
      destructive: true,
    });
    if (!confirmed) {
      return;
    }
    setIsLeaving(true);
    try {
      await source.leave();
      // The room is gone from this account, so the conversation behind this
      // screen is a room it can no longer read.
      router.replace('/');
    } catch (error: unknown) {
      logger.error('[chat] a conversation could not be left', error);
      toast.error(getErrorMessage(error) || t('Allo could not leave this conversation'));
      setIsLeaving(false);
    }
  }, [isLeaving, router, source, t]);

  if (details === undefined) {
    return (
      <View style={styles.centred}>
        {snapshot.error === undefined ? (
          <ActivityIndicator color={theme.colors.primary} />
        ) : (
          <>
            <ThemedText style={styles.errorTitle}>
              {t('Allo could not read this conversation')}
            </ThemedText>
            <ThemedText style={styles.errorDetail}>{snapshot.error}</ThemedText>
            <TouchableOpacity
              accessibilityRole="button"
              style={styles.primaryButton}
              onPress={() => {
                void source.refresh();
              }}
            >
              <ThemedText style={styles.primaryButtonLabel}>{t('Try again')}</ThemedText>
            </TouchableOpacity>
          </>
        )}
      </View>
    );
  }

  return (
    <FlatList
      data={details.members}
      keyExtractor={(member) => member.userId}
      renderItem={({ item }) => (
        <MemberRow member={item} isViewer={item.userId === runtime.userId} />
      )}
      ListHeaderComponent={
        <View>
          {/* Keyed by the name the homeserver has, so that a rename made
              elsewhere replaces what is in the field instead of being fought
              over by a `useState` that was initialised once. */}
          <RoomNameSection
            key={details.name ?? ''}
            name={details.name}
            isDirect={details.isDirect}
            canRename={rights?.canRename === true}
            onRename={source.rename}
          />
          <View style={styles.sectionHeader}>
            <ThemedText style={styles.sectionTitle}>
              {t('People in this conversation ({{count}})', {
                count: details.members.length,
              })}
            </ThemedText>
            {snapshot.isLoading && <ActivityIndicator color={theme.colors.textSecondary} />}
          </View>
          {!details.isDirect && (
            <AddPeopleRow
              canInvite={rights?.canInvite === true}
              onPress={() => {
                router.push(`/new?invite=${encodeURIComponent(roomId)}` as Href);
              }}
            />
          )}
        </View>
      }
      ListFooterComponent={
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityState={{ disabled: isLeaving }}
          style={styles.leaveButton}
          disabled={isLeaving}
          onPress={() => {
            void leave();
          }}
        >
          {isLeaving ? (
            <ActivityIndicator color={theme.colors.error} />
          ) : (
            <ThemedText style={styles.leaveLabel}>{t('Leave conversation')}</ThemedText>
          )}
        </TouchableOpacity>
      }
    />
  );
}

/**
 * The room's name, and the field that changes it.
 *
 * Its own component so that the editor's state can be reset by a `key` when the
 * homeserver's name changes, rather than by an Effect watching a prop.
 */
function RoomNameSection({
  name,
  isDirect,
  canRename,
  onRename,
}: {
  readonly name: string | undefined;
  readonly isDirect: boolean;
  readonly canRename: boolean;
  readonly onRename: (name: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const styles = useStyles();
  const [draft, setDraft] = useState(name ?? '');
  const [isSaving, setIsSaving] = useState(false);

  const trimmed = draft.trim();
  // Derived during render rather than mirrored into state: whether the button
  // does anything is a fact about what is in the field right now.
  const hasChange = trimmed !== '' && trimmed !== (name ?? '');

  const save = useCallback(async () => {
    setIsSaving(true);
    try {
      await onRename(trimmed);
      toast.success(t('Conversation renamed'));
    } catch (error: unknown) {
      logger.error('[chat] a conversation could not be renamed', error);
      toast.error(getErrorMessage(error) || t('Allo could not rename this conversation'));
    } finally {
      setIsSaving(false);
    }
  }, [onRename, t, trimmed]);

  if (isDirect) {
    // A one-to-one conversation is named after the other person by every client
    // that draws it. A field here would offer a title that only this account
    // would ever see the point of.
    return (
      <View style={styles.section}>
        <ThemedText style={styles.roomName}>{name ?? ''}</ThemedText>
      </View>
    );
  }

  return (
    <View style={styles.section}>
      <TextFieldInput
        label={t('Group name')}
        placeholder={t('Group name')}
        value={draft}
        onChangeText={setDraft}
        editable={canRename && !isSaving}
        maxLength={GROUP_NAME_MAX_LENGTH}
        returnKeyType="done"
      />
      {canRename ? (
        hasChange && (
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityState={{ disabled: isSaving }}
            style={styles.primaryButton}
            disabled={isSaving}
            onPress={() => {
              void save();
            }}
          >
            {isSaving ? (
              <ActivityIndicator color={theme.colors.background} />
            ) : (
              <ThemedText style={styles.primaryButtonLabel}>{t('Save name')}</ThemedText>
            )}
          </TouchableOpacity>
        )
      ) : (
        <ThemedText style={styles.reason}>
          {t('Only people with permission in this conversation can rename it.')}
        </ThemedText>
      )}
    </View>
  );
}

/** The way to add somebody, and the reason it is not available. */
function AddPeopleRow({
  canInvite,
  onPress,
}: {
  readonly canInvite: boolean;
  readonly onPress: () => void;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const styles = useStyles();

  return (
    <View>
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityState={{ disabled: !canInvite }}
        style={[styles.row, !canInvite && styles.rowDisabled]}
        disabled={!canInvite}
        onPress={onPress}
      >
        <View style={styles.addIcon}>
          <Ionicons name="person-add" size={20} color={theme.colors.primary} />
        </View>
        <ThemedText style={styles.rowLabel}>{t('Add people')}</ThemedText>
      </TouchableOpacity>
      {!canInvite && (
        <ThemedText style={styles.reason}>
          {t('Only people with permission in this conversation can invite others.')}
        </ThemedText>
      )}
    </View>
  );
}

function MemberRow({
  member,
  isViewer,
}: {
  readonly member: AlloRoomMember;
  readonly isViewer: boolean;
}) {
  const { t } = useTranslation();
  const styles = useStyles();
  const name = member.displayName ?? member.userId;

  return (
    <View style={styles.row}>
      <Avatar size={40} label={name.charAt(0).toUpperCase()} />
      <View style={styles.rowText}>
        <ThemedText style={styles.rowLabel} numberOfLines={1}>
          {isViewer ? t('{{name}} (you)', { name }) : name}
        </ThemedText>
        <ThemedText style={styles.rowDetail} numberOfLines={1}>
          {member.membership === 'invited' ? t('Invited') : member.userId}
        </ThemedText>
      </View>
    </View>
  );
}

/** `useSyncExternalStore` compares snapshots by identity, so this is one object. */
const EMPTY_SNAPSHOT: RoomAdminSnapshot = {
  details: undefined,
  isLoading: false,
  error: undefined,
};
const emptySnapshot = (): RoomAdminSnapshot => EMPTY_SNAPSHOT;

function useStyles() {
  const theme = useTheme();
  return useMemo(
    () =>
      StyleSheet.create({
        centred: {
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
          padding: 32,
        },
        errorTitle: {
          fontSize: 17,
          fontWeight: '600',
          color: theme.colors.text,
          textAlign: 'center',
        },
        errorDetail: {
          fontSize: 15,
          color: theme.colors.textSecondary,
          textAlign: 'center',
          marginTop: 8,
        },
        section: {
          paddingHorizontal: 16,
          paddingTop: 16,
          gap: 12,
        },
        roomName: {
          fontSize: 20,
          fontWeight: '600',
          color: theme.colors.text,
        },
        sectionHeader: {
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingHorizontal: 16,
          paddingTop: 24,
          paddingBottom: 8,
        },
        sectionTitle: {
          fontSize: 13,
          fontWeight: '600',
          textTransform: 'uppercase',
          color: theme.colors.textSecondary,
        },
        row: {
          flexDirection: 'row',
          alignItems: 'center',
          paddingHorizontal: 16,
          paddingVertical: 12,
          gap: 12,
        },
        rowDisabled: {
          opacity: 0.5,
        },
        rowText: {
          flex: 1,
        },
        rowLabel: {
          fontSize: 16,
          color: theme.colors.text,
        },
        rowDetail: {
          fontSize: 13,
          color: theme.colors.textSecondary,
          marginTop: 2,
        },
        addIcon: {
          width: 40,
          height: 40,
          borderRadius: 20,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: theme.colors.backgroundSecondary,
        },
        reason: {
          fontSize: 13,
          color: theme.colors.textSecondary,
          paddingHorizontal: 16,
          paddingBottom: 8,
        },
        primaryButton: {
          alignSelf: 'flex-start',
          paddingHorizontal: 20,
          paddingVertical: 10,
          borderRadius: 20,
          marginTop: 16,
          backgroundColor: theme.colors.primary,
        },
        primaryButtonLabel: {
          fontSize: 15,
          fontWeight: '600',
          color: theme.colors.background,
        },
        leaveButton: {
          margin: 16,
          padding: 14,
          borderRadius: 12,
          alignItems: 'center',
          borderWidth: 1,
          borderColor: theme.colors.border,
        },
        leaveLabel: {
          fontSize: 16,
          fontWeight: '600',
          color: theme.colors.error,
        },
      }),
    [theme.colors],
  );
}
