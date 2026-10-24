import { useAlloClient } from '@allo/react';
import { toast } from '@oxy.so/bloom/toast';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { readAttachmentBytes } from '@/lib/allo/attachmentBytes';
import { pickMediaAttachments } from '@/lib/chat/attachments';
import { logger } from '@/utils/logger';

/**
 * Adding to your status: the app's existing picker (`lib/chat/attachments.ts`,
 * the one the composer uses), then one encrypted post. ONE implementation for
 * every way in — the "My status" ring at the top of `/updates` and the
 * floating action while that page is in front (`app/(chat)/_layout.tsx`).
 *
 * The audience is everybody this device shares a conversation with, resolved
 * on the device (ADR 0002). Narrowing it is its own screen and its own change;
 * posting to nobody in particular is not a thing this offers.
 */
export function usePostStatus(): () => Promise<void> {
  const client = useAlloClient();
  const { t } = useTranslation();
  return useCallback(async () => {
    try {
      const picked = await pickMediaAttachments();
      const first = picked[0];
      if (!first) return;
      await client.statuses.post({
        kind: first.mimetype.startsWith('video/') ? 'video' : 'image',
        media: {
          bytes: await readAttachmentBytes(first.uri),
          mime: first.mimetype,
          width: first.width,
          height: first.height,
        },
        audience: { mode: 'all', accountIds: [] },
      });
      toast.success(t('stories.added'));
    } catch (error: unknown) {
      logger.error('[updates] could not post', error);
      toast.error(t('stories.addFailed'));
    }
  }, [client, t]);
}
