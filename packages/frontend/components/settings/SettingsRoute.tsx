import { useScreenBack } from '@oxy.so/bloom/screen';
import { useEffect } from 'react';
import { useAlloSettings } from './context';

/**
 * Existing links remain valid; settings lives over the conversation, never in
 * its pane. The route steps back (to the chats when a link opened it) and the
 * modal opens over what is there.
 */
export function SettingsRoute({ page }: { page?: string }) {
  const back = useScreenBack();
  const settings = useAlloSettings();
  useEffect(() => {
    back?.();
    settings.open(page);
  }, [back, page, settings]);
  return null;
}
