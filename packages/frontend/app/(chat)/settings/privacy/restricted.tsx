import React from 'react';

import { ModeratedUsersScreen } from '@/components/settings/ModeratedUsersScreen';

/**
 * The people this account has restricted.
 *
 * The list and every action on it are `ModeratedUsersScreen`, shared with
 * `blocked.tsx`; this file is the endpoint and the wording.
 */
export default function RestrictedUsersRoute() {
  return (
    <ModeratedUsersScreen
      list="restricts"
      titleKey="settings.privacy.restrictedUsers"
      descriptionKey="settings.privacy.restrictedUsersDescription"
      searchPlaceholderKey="settings.privacy.searchUsersToRestrict"
      emptyKey="settings.privacy.noRestrictedUsers"
      removeActionKey="settings.privacy.unrestrict"
      removeConfirmKey="settings.privacy.unrestrictUserConfirm"
      addedKey="settings.privacy.userRestricted"
      removedKey="settings.privacy.userUnrestricted"
      addFailedKey="settings.privacy.failedToRestrictUser"
      removeFailedKey="settings.privacy.failedToUnrestrictUser"
      selfKey="settings.privacy.cannotRestrictYourself"
    />
  );
}
