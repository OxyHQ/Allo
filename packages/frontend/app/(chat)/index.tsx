import React from 'react';
import { useTranslation } from 'react-i18next';

import { ConversationList } from '@/components/chat/list/ConversationList';
import { EmptyDetail } from '@/components/shell/EmptyDetail';
import { useSplitLayout } from '@/hooks/useSplitLayout';

/** `/` — the conversation list on a phone; beside the list, the empty detail pane. */
export default function ChatsRoute() {
  const split = useSplitLayout();
  const { t } = useTranslation();
  if (split) return <EmptyDetail title={t('chat.select.title')} description={t('chat.select.description')} />;
  return <ConversationList />;
}
