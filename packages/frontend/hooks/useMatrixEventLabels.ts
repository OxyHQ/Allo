import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import type { UnreadableEventLabels } from '@/lib/chat/matrixViewModel';
import type { AlloMediaKind } from '@/lib/matrix/types';

/**
 * The words for the events that have no words of their own.
 *
 * One hook for the conversation list and the timeline, because they have to
 * agree: a message this device cannot decrypt says the same thing in the row as
 * it does in the bubble, and a reader who saw two different sentences for one
 * message would reasonably conclude they were two different problems.
 *
 * The mapping in `lib/chat/matrixViewModel.ts` takes these as arguments rather
 * than reaching for `t` itself, which is what keeps it testable without i18n.
 * This is where the two meet.
 */
export function useMatrixEventLabels(): UnreadableEventLabels {
  const { t } = useTranslation();

  return useMemo<UnreadableEventLabels>(() => {
    /**
     * What a conversation row calls an attachment nobody captioned.
     *
     * Written as five separate strings rather than one with the kind
     * interpolated, because a translator needs the whole sentence: languages
     * that inflect the noun cannot build "Photo" out of a template.
     */
    const mediaPreviews: Record<AlloMediaKind, string> = {
      image: t('Photo'),
      video: t('Video'),
      audio: t('Audio'),
      voice: t('Voice message'),
      file: t('File'),
    };

    return {
      undecryptable: t('This message cannot be read on this device.'),
      redacted: t('This message was deleted.'),
      // Not "deleted": at this point the content has only stopped being drawn
      // here. Whether it is also gone from the homeserver depends on whoever
      // sent it having had Allo running at the deadline.
      expired: t('This message is no longer shown here.'),
      unsupported: (description) =>
        t('Allo cannot show this yet ({{kind}}).', { kind: description }),
      mediaPreview: (kind) => mediaPreviews[kind],
    };
  }, [t]);
}
