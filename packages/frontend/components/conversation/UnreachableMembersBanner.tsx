import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { useTheme } from '@/hooks/useTheme';
import { useUnreachableMembers } from '@/hooks/useUnreachableMembers';
import type { Conversation } from '@/lib/chat/model';

/**
 * "<Name> hasn't set up Allo yet" — drawn above the composer while somebody
 * in the conversation has no device that could read what is sent, and nothing
 * once they all do.
 *
 * It informs and never blocks: the composer under it stays enabled, because
 * the SDK keeps what is typed and delivers it on its own when the person
 * installs the app (`docs/platform/crypto.md` section 5). A modal or a
 * disabled input would say the opposite of what happens. The words are
 * `useUnreachableMembers`'; this only draws them.
 */
export function UnreachableMembersBanner({ conversation }: { conversation: Pick<Conversation, 'type' | 'unreachableMemberAccountIds'> | null | undefined }) {
  const { banner } = useUnreachableMembers(conversation);
  const styles = useStyles();
  if (banner === null) return null;
  return (
    <View style={styles.banner} accessibilityRole="text" accessibilityLiveRegion="polite" testID="unreachable-members-banner">
      <Text style={styles.text}>{banner}</Text>
    </View>
  );
}

function useStyles() {
  const theme = useTheme();
  return useMemo(
    () =>
      StyleSheet.create({
        banner: {
          paddingHorizontal: 16,
          paddingVertical: 8,
          backgroundColor: theme.colors.backgroundSecondary,
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopColor: theme.colors.border,
        },
        text: {
          fontSize: 13,
          textAlign: 'center',
          color: theme.colors.textSecondary,
        },
      }),
    [theme],
  );
}
