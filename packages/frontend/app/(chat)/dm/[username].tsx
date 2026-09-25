import React from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { Redirect, useLocalSearchParams } from 'expo-router';
import { useTheme } from '@oxy.so/bloom/theme';

import NotFoundScreen from '@/components/NotFoundScreen';
import { ProfileScreen } from '@/components/profile/ProfileScreen';
import { useProfileData } from '@/hooks/useProfileData';
import { handleFromDirectMessageSegment } from '@/lib/profile/handle';

/**
 * `/dm/alice` — the conversation with a person, by HANDLE.
 *
 * For an app that holds only a handle (OxyHQ/Allo#176): the handle is resolved
 * to an Oxy account and the route is replaced with `/c/<account id>`, which
 * opens the direct conversation with that person, creating it if there is none.
 * A handle nobody holds, or a lookup that fails, is answered by the profile
 * screen, which already says which of the two it was.
 */
export default function DirectMessageRoute() {
  const { username } = useLocalSearchParams<{ username: string }>();
  const handle = handleFromDirectMessageSegment(username);
  const theme = useTheme();
  const { data: profile, loading } = useProfileData(handle ?? undefined);

  if (handle === null) return <NotFoundScreen />;
  if (profile) return <Redirect href={`/c/${profile.id}`} />;
  if (!loading) return <ProfileScreen handle={handle} />;
  return (
    <View style={[styles.pending, { backgroundColor: theme.colors.background }]}>
      <ActivityIndicator color={theme.colors.primary} />
    </View>
  );
}

const styles = StyleSheet.create({
  pending: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
