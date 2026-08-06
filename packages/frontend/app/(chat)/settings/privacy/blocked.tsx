import React from 'react';

import { ModeratedUsersScreen } from '@/components/settings/ModeratedUsersScreen';

/**
 * The people this account has blocked.
 *
 * The list and every action on it are `ModeratedUsersScreen`, shared with
 * `restricted.tsx`; this file is the endpoint and the wording.
 */
export default function BlockedUsersRoute() {
  return (
    <ModeratedUsersScreen
      list="blocks"
      titleKey="settings.privacy.blockedUsers"
      descriptionKey="settings.privacy.blockedUsersDescription"
      searchPlaceholderKey="settings.privacy.searchUsersToBlock"
      emptyKey="settings.privacy.noBlockedUsers"
      removeActionKey="settings.privacy.unblock"
      removeConfirmKey="settings.privacy.unblockUserConfirm"
      addedKey="settings.privacy.userBlocked"
      removedKey="settings.privacy.userUnblocked"
      addFailedKey="settings.privacy.failedToBlockUser"
      removeFailedKey="settings.privacy.failedToUnblockUser"
      selfKey="settings.privacy.cannotBlockYourself"
    />
  );
}
