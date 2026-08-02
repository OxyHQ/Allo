import { Ionicons } from '@expo/vector-icons';
import { SettingsListItem } from '@oxyhq/bloom/settings-list';
import React from 'react';
import { useTranslation } from 'react-i18next';

import { useTheme } from '@/hooks/useTheme';
import { CHAT_BACKEND } from '@/lib/chat/backend';

import {
  RECOVERY_DISCLOSURE_BODY,
  RECOVERY_DISCLOSURE_TITLE,
} from './recoveryDisclosureCopy';

/**
 * The sentence a user has to be able to read before they decide how carefully to
 * keep their Oxy recovery phrase.
 *
 * Allo unlocks its Matrix key backup with a key derived from that phrase
 * (`lib/matrix/recovery/passphrase.ts`), which is what makes a new device open
 * the old conversations by itself. It also changes what the phrase is worth to
 * somebody else. Before, whoever held it could take the account and read
 * everything sent *from then on*; now they can read everything sent *before*
 * as well, which in the ordinary Matrix design would have been behind a second
 * credential the user keeps separately.
 *
 * That is a real trade and the design (`docs/matrix/client-strategy.md` §3.6)
 * asks for it to be made in the user's words rather than in a comment: someone
 * who treats the phrase as the key to everything is acting correctly, and
 * someone who believes Allo keeps a secret of its own is not. So this is a
 * screen and not a code comment, and the wording says what happens rather than
 * that "your data is protected".
 *
 * Only rendered when the build talks to Matrix. On the legacy backend the claim
 * would simply be false — nothing derives anything from the Oxy phrase there.
 */
export function RecoveryDisclosure() {
  const { t } = useTranslation();
  const theme = useTheme();

  if (CHAT_BACKEND !== 'matrix') {
    return null;
  }

  return (
    <SettingsListItem
      icon={<Ionicons name="key-outline" size={20} color={theme.colors.textSecondary} />}
      title={t(RECOVERY_DISCLOSURE_TITLE)}
      description={t(RECOVERY_DISCLOSURE_BODY)}
    />
  );
}
