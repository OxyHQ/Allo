import React, { useCallback, useMemo, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, FlatList, StyleSheet, TouchableOpacity, View } from 'react-native';
import { useLocalSearchParams, useRouter, type Href } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Ionicons } from '@expo/vector-icons';
import { TextFieldInput } from '@oxyhq/bloom';
import { toast } from '@oxyhq/bloom/toast';

import Avatar from '@/components/Avatar';
import { Header } from '@/components/layout/Header';
import { EphemeralSection } from '@/components/matrix/EphemeralSection';
import { MatrixSignInGate } from '@/components/matrix/MatrixSignInGate';
import { ThemedText } from '@/components/ThemedText';
import { ThemedView } from '@/components/ThemedView';
import { useChatPeople } from '@/hooks/useChatPeople';
import { useEphemeralPolicy } from '@/hooks/useEphemeralPolicy';
import { useMatrixRuntime } from '@/hooks/useMatrixRuntime';
import { useTheme } from '@/hooks/useTheme';
import { CHAT_BACKEND } from '@/lib/chat/backend';
import { ephemeralPolicies } from '@/lib/chat/ephemeralPolicies';
import {
  conversationTitleFrom,
  isOwnRoomName,
  NO_CHAT_PERSON_REQUESTS,
  viewerServerNameOf,
  type ChatPerson,
} from '@/lib/chat/people';
import { roomAdminSource, type RoomAdminSnapshot } from '@/lib/chat/roomAdmin';
import type {
  AlloEphemeralPolicy,
  AlloIdentityTrust,
  AlloRoomMember,
} from '@/lib/matrix/types';
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
  const policy = useEphemeralPolicy(roomId);

  const styles = useStyles();
  const details = snapshot.details;
  const rights = details?.rights;

  /**
   * How far each person's identity is trusted here, by user id.
   *
   * A map derived during render rather than a lookup per row: the member list
   * and the trust list are the same people, and a row that searched the second
   * one would be a scan per member per redraw.
   */
  const trustByUserId = useMemo(() => {
    const byUserId = new Map<string, AlloIdentityTrust>();
    for (const member of snapshot.trust?.members ?? []) {
      byUserId.set(member.userId, member.trust);
    }
    return byUserId;
  }, [snapshot.trust]);

  /**
   * Who everybody in this room is.
   *
   * One request for the whole room rather than one per row: a family group of
   * thirty must not be thirty requests, and `useChatPeople` collects every id
   * asked for in a tick into a single lookup. Matrix's own name for a member
   * travels with the id because for a bridged contact it is the only name there
   * will ever be.
   */
  const requests = useMemo(
    () =>
      details === undefined
        ? NO_CHAT_PERSON_REQUESTS
        : details.members.map((member) => ({
            userId: member.userId,
            matrixDisplayName: member.displayName,
          })),
    [details],
  );
  const people = useChatPeople(requests);
  const serverName = useMemo(() => viewerServerNameOf(runtime.userId), [runtime.userId]);

  /**
   * The name to put in a sentence about somebody.
   *
   * It used to be `member.displayName ?? userId`, so the warning that names the
   * people an ephemeral conversation will not send to was a list of MXIDs — the
   * exact thing `EphemeralSection` takes this mapper in order to avoid. Somebody
   * still being looked up has no name yet, and the honest word for them is the
   * one `chat.person.unknown` carries rather than their identifier.
   */
  const nameOf = useCallback(
    (userId: string) => {
      const person = people(userId);
      return person === undefined || person.displayName === ''
        ? t('chat.person.unknown')
        : person.displayName;
    },
    [people, t],
  );

  const setPolicy = useCallback(
    async (next: AlloEphemeralPolicy | undefined) => {
      await ephemeralPolicies.setPolicy(roomId, next);
    },
    [roomId],
  );

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
        <MemberRow
          member={item}
          person={people(item.userId)}
          isViewer={item.userId === runtime.userId}
          trust={trustByUserId.get(item.userId)}
          // The identity of the people in a conversation only decides anything
          // when the conversation is ephemeral, and a badge on every member of
          // every group would be a word the user has no use for.
          showTrust={policy !== undefined}
        />
      )}
      ListHeaderComponent={
        <View>
          {/* Keyed by the name the homeserver has, so that a rename made
              elsewhere replaces what is in the field instead of being fought
              over by a `useState` that was initialised once. */}
          <RoomNameSection
            key={details.name ?? ''}
            title={conversationTitleFrom(details.name, serverName, people)}
            // The room's own name and nothing else goes in the field: a title
            // computed from the people in the room is not something the user
            // typed, and offering it back would let one tap write a list of
            // Matrix ids into `m.room.name` for everybody, in the clear.
            name={isOwnRoomName(details.name, serverName) ? details.name : undefined}
            isDirect={details.isDirect}
            canRename={rights?.canRename === true}
            onRename={source.rename}
          />
          <EphemeralSection
            policy={policy}
            trust={snapshot.trust}
            nameOf={nameOf}
            onChange={setPolicy}
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
  title,
  name,
  isDirect,
  canRename,
  onRename,
}: {
  /** What this conversation is called on screen, people already resolved. */
  readonly title: string;
  /** The room's own `m.room.name`, and only that. See the call site. */
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
        <ThemedText style={styles.roomName}>{title}</ThemedText>
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

/**
 * One person in the conversation.
 *
 * It used to draw `member.displayName ?? member.userId` as the name and
 * `member.userId` underneath it, so a room on Allo's homeserver — where nobody
 * has a Matrix display name — was a column of `@<hex>:allo.you` with `@` for an
 * avatar. Both lines come from {@link ChatPerson} now, which is never an
 * identifier: their name, their handle, their face.
 *
 * A bridged contact is drawn from what Matrix says about them and from nothing
 * else — a mautrix bridge names its puppets, and that name is the only one that
 * exists — so they get no handle line. Which network carries the conversation is
 * a fact about the room, not about the row, and `roomOrigin.ts` already puts it
 * where it belongs.
 */
function MemberRow({
  member,
  person,
  isViewer,
  trust,
  showTrust,
}: {
  readonly member: AlloRoomMember;
  /** `undefined` for the moment before the lookup has been set up. */
  readonly person: ChatPerson | undefined;
  readonly isViewer: boolean;
  readonly trust: AlloIdentityTrust | undefined;
  readonly showTrust: boolean;
}) {
  const { t } = useTranslation();
  const styles = useStyles();

  // Empty while the lookup is in flight, and the row draws a nameless avatar for
  // that moment rather than an id it would have to take back.
  const name = person?.displayName ?? '';
  const detail = memberDetail(person, member.membership === 'invited', t);

  return (
    <View style={styles.row}>
      <Avatar
        size={40}
        source={person?.avatarUrl === undefined ? undefined : { uri: person.avatarUrl }}
        label={name === '' ? undefined : name.charAt(0).toUpperCase()}
      />
      <View style={styles.rowText}>
        <ThemedText style={styles.rowLabel} numberOfLines={1}>
          {isViewer && name !== '' ? t('{{name}} (you)', { name }) : name}
        </ThemedText>
        {detail !== undefined && (
          <ThemedText style={styles.rowDetail} numberOfLines={1}>
            {detail}
          </ThemedText>
        )}
        {showTrust && <TrustLine trust={trust} />}
      </View>
    </View>
  );
}

/**
 * The second line of a member row, or nothing.
 *
 * "Invited" first, because whether somebody has actually joined is what the
 * reader is looking for; then their handle, which is how they would find that
 * person anywhere else in Oxy. Nothing at all otherwise — this line used to be
 * `member.userId`, and a row with no second line says strictly more than a row
 * with an identifier on it.
 */
function memberDetail(
  person: ChatPerson | undefined,
  isInvited: boolean,
  t: (key: string) => string,
): string | undefined {
  if (isInvited) {
    return t('Invited');
  }
  return person?.handle === undefined ? undefined : `@${person.handle}`;
}

/**
 * What this device knows about one person's identity, in words that do not
 * overstate it.
 *
 * In particular there is no "verified" here for the ordinary case, and there
 * must not be: Allo cannot yet verify anybody's identity — there is no emoji
 * comparison and no QR code — so what it has is a key it saw once and has kept
 * seeing. "Recognised on this device" is that, exactly.
 */
function TrustLine({ trust }: { readonly trust: AlloIdentityTrust | undefined }) {
  const { t } = useTranslation();
  const styles = useStyles();

  if (trust === undefined) {
    return null;
  }

  const wording: Record<AlloIdentityTrust, { readonly text: string; readonly isAlarm: boolean }> = {
    verified: { text: t('Identity verified by you'), isAlarm: false },
    pinned: { text: t('Recognised on this device'), isAlarm: false },
    changed: { text: t('Their identity has changed'), isAlarm: true },
    unknown: { text: t('No identity published yet'), isAlarm: true },
  };
  const { text, isAlarm } = wording[trust];

  return (
    <ThemedText style={[styles.rowDetail, isAlarm && styles.rowAlarm]} numberOfLines={1}>
      {text}
    </ThemedText>
  );
}

/** `useSyncExternalStore` compares snapshots by identity, so this is one object. */
const EMPTY_SNAPSHOT: RoomAdminSnapshot = {
  details: undefined,
  trust: undefined,
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
        rowAlarm: {
          color: theme.colors.error,
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
