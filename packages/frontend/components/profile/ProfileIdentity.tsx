import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Avatar } from '@oxy.so/bloom/avatar';
import { useTheme } from '@oxy.so/bloom/theme';
import { Text } from '@oxy.so/bloom/typography';

export interface ProfileIdentityProps {
  /** The name, already resolved. Never a handle with an `@` on it. */
  displayName: string;
  /** Drawn with its `@`; pass the bare handle. */
  handle?: string;
  /** An Oxy file id or a URL; the app's image resolver turns an id into a URL. */
  avatar?: string;
  verified?: boolean;
}

/** Who somebody is: the picture, the name and the handle, centred. Presentational only. */
export function ProfileIdentity({ displayName, handle, avatar, verified = false }: ProfileIdentityProps) {
  const theme = useTheme();
  return (
    <View style={styles.root}>
      <Avatar source={avatar} name={displayName} size={96} verified={verified} alt={displayName} />
      <View style={styles.names}>
        <Text variant="title-2-semibold" style={styles.centered}>
          {displayName}
        </Text>
        {handle ? (
          <Text variant="body-regular" style={[styles.centered, { color: theme.colors.textSecondary }]}>
            @{handle}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { alignItems: 'center', gap: 12, paddingTop: 8 },
  names: { alignItems: 'center', gap: 2 },
  centered: { textAlign: 'center' },
});
