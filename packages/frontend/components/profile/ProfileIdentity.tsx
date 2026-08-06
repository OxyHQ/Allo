import React, { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';

import Avatar from '@/components/Avatar';
import { ThemedText } from '@/components/ThemedText';
import type { AvatarShapeKey } from '@/components/avatar/avatarShapes';
import { useTheme } from '@/hooks/useTheme';

/**
 * WHO SOMEBODY IS, drawn once.
 *
 * The picture, the name, the handle and a line of status, centred. Two surfaces
 * show exactly this and they must not drift: the conversation-details pane
 * (`components/ContactDetails.tsx`), where it sits above the tabs, and the
 * profile screen you reach by tapping an @mention or your own avatar in the
 * sidebar. The second was the one at risk — a profile screen is the obvious
 * place to write a second, slightly different person-renderer, and then the
 * verified tick appears on one of them and not the other.
 *
 * Presentational only: it fetches nothing and knows about no conversation. What
 * the status line says — presence, "last seen", how many people are in a group —
 * is the caller's sentence, because only the caller knows which it has.
 */
export interface ProfileIdentityProps {
  /** The name, already resolved. Never a handle with an `@` on it. */
  displayName: string;
  /** The line under the name. Drawn with its `@`; pass the bare handle. */
  handle?: string;
  /** A third line: presence, "last seen …", or a participant count. */
  status?: string;
  /**
   * Draws the status line as presence rather than as absence.
   *
   * The one visual difference between "Online" and "Last seen 3h ago", and the
   * reason it is a flag rather than a colour prop: a caller that could pass a
   * colour would eventually pass a hardcoded one.
   */
  statusIsPresence?: boolean;
  /** A resolved image URL. An id will not do — resolve it before you get here. */
  avatarUrl?: string;
  avatarShape?: AvatarShapeKey;
  /** Replaces the single avatar. A group has several faces, not one. */
  avatarSlot?: React.ReactNode;
  verified?: boolean;
  size?: number;
}

/** The size the two current callers draw it at. */
const DEFAULT_AVATAR_SIZE = 100;

export function ProfileIdentity({
  displayName,
  handle,
  status,
  statusIsPresence = false,
  avatarUrl,
  avatarShape,
  avatarSlot,
  verified = false,
  size = DEFAULT_AVATAR_SIZE,
}: ProfileIdentityProps) {
  const theme = useTheme();

  const styles = useMemo(
    () =>
      StyleSheet.create({
        container: {
          alignItems: 'center',
          marginBottom: 24,
        },
        avatar: {
          marginBottom: 12,
        },
        names: {
          alignItems: 'center',
          marginBottom: 8,
        },
        name: {
          fontSize: 22,
          fontWeight: 'bold',
          color: theme.colors.text,
          marginBottom: 4,
          textAlign: 'center',
        },
        handle: {
          fontSize: 16,
          color: theme.colors.textSecondary,
          marginBottom: 8,
        },
        status: {
          fontSize: 14,
          color: theme.colors.textSecondary,
        },
        presence: {
          fontSize: 14,
          fontWeight: '500',
          color: theme.colors.success,
        },
      }),
    [theme],
  );

  return (
    <View style={styles.container}>
      {avatarSlot ?? (
        <Avatar
          source={avatarUrl ? { uri: avatarUrl } : undefined}
          size={size}
          style={styles.avatar}
          label={displayName.charAt(0)}
          shape={avatarShape}
          verified={verified}
        />
      )}
      <View style={styles.names}>
        <ThemedText style={styles.name}>{displayName}</ThemedText>
        {handle ? <ThemedText style={styles.handle}>@{handle}</ThemedText> : null}
        {status ? (
          <ThemedText style={statusIsPresence ? styles.presence : styles.status}>
            {status}
          </ThemedText>
        ) : null}
      </View>
    </View>
  );
}

export default ProfileIdentity;
