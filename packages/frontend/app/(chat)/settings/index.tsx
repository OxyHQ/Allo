import React from 'react';
import { useTranslation } from 'react-i18next';

import { SettingsMenu } from '@/components/settings/SettingsMenu';
import { EmptyDetail } from '@/components/shell/EmptyDetail';
import { useSplitLayout } from '@/hooks/useSplitLayout';

/**
 * `/settings`. On a wide window the chat layout already draws the menu in the
 * list pane, so this route is the detail pane before a row is chosen; on a
 * narrow one it is the menu itself.
 */
export default function SettingsScreen() {
  const { t } = useTranslation();
  const split = useSplitLayout();
  if (split) {
    return <EmptyDetail title={t('settings.empty.title')} description={t('settings.empty.description')} />;
  }
  return <SettingsMenu />;
}
