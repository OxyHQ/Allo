import { useRouter } from 'expo-router';
import { useEffect } from 'react';
import { useAlloSettings } from './context';

/** Existing links remain valid; settings lives over the conversation, never in its pane. */
export function SettingsRoute({ page }: { page?: string }) {
  const router = useRouter();
  const settings = useAlloSettings();
  useEffect(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/');
    settings.open(page);
  }, [page, router, settings]);
  return null;
}
