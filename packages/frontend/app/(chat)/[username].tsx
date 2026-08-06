import React from 'react';
import { useLocalSearchParams } from 'expo-router';

import NotFoundScreen from '@/components/NotFoundScreen';
import { ProfileScreen } from '@/components/profile/ProfileScreen';
import { handleFromProfileSegment } from '@/lib/profile/handle';

/**
 * `/@alice` — a person's profile.
 *
 * One dynamic segment carrying the `@` inside its VALUE, which is how Mention
 * routes profiles and why it is how Allo does: the two share an identity
 * namespace, so a handle copied out of one has to name the same account in the
 * other. `useLocalSearchParams()` hands back the literal `@alice`; the `@` is
 * stripped here and only the handle travels any further.
 *
 * This file is also the app's catch-all for unknown SINGLE-segment paths, because
 * a bare `[username]` matches every one of them that no static route claimed. The
 * `@` is what tells the two apart: with it, this is a profile URL and an unknown
 * handle is answered by the screen; without it, the path was never a profile and
 * the 404 is drawn here, with no request made.
 */
export default function ProfileRoute() {
  const { username } = useLocalSearchParams<{ username: string }>();
  const handle = handleFromProfileSegment(username);

  if (handle === null) {
    return <NotFoundScreen />;
  }

  return <ProfileScreen handle={handle} />;
}
