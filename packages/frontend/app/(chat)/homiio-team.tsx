import { useMemo, useState } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useOxy } from '@oxy.so/services/ui/client';
import { useAlloClient } from '@allo/react';
import { HomiioTeamClient } from '@oxy.so/homiio-sdk';
import { useTranslation } from 'react-i18next';
import { completeHomiioTeam } from '@/lib/homiio/team';

import { Button as LButton, Header, ScrollView, Text as LText } from '@oxy.so/bloom-language';
import { screen } from '@oxy.so/bloom-language/router';

export default screen(function HomiioTeamRoute() {
  const { caseId, action, accountId } = useLocalSearchParams<{
    caseId?: string;
    action?: string;
    accountId?: string;
  }>();
  const { oxyServices } = useOxy();
  const client = useAlloClient();
  const router = useRouter();
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const source = useMemo(() => {
    const linked = oxyServices.createLinkedClient({ baseURL: 'https://api.homiio.com' });
    return new HomiioTeamClient({
      transport: async (method, path, body) => {
        const response =
          method === 'GET' ? await linked.client.get(path) : await linked.client.post(path, body);
        return response;
      },
    });
  }, [oxyServices]);
  const chosen = action === 'add' || action === 'remove' ? action : 'open';
  const valid =
    typeof caseId === 'string' &&
    caseId.length > 0 &&
    (chosen === 'open' || typeof accountId === 'string');
  const proceed = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setFailed(false);
    try {
      const conversationId = await completeHomiioTeam(client, source, caseId!, {
        action: chosen,
        ...(accountId ? { oxyUserId: accountId } : {}),
        ...(chosen === 'add' ? { acknowledgeExactLocationAccess: true } : {}),
      });
      await client.conversations.rename(conversationId, t('homiio.team.title'));
      router.replace(`/c/${conversationId}`);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  return ScrollView(
    LText(
      t(
        chosen === 'add'
          ? 'homiio.team.addWarning'
          : chosen === 'remove'
            ? 'homiio.team.removeWarning'
            : 'homiio.team.description',
      ),
    ),
    failed ? LText(t('homiio.team.retry')) : null,
    LButton(LText(t(busy ? 'homiio.team.working' : 'homiio.team.continue')))
      .disabled(!valid || busy)
      .onPress(() => {
        void proceed();
      }),
  )
    .keyboardTaps('handled')
    .contentView((v) => v.padding('horizontal', 'lg').padding('bottom', '3xl').spacing('lg'))
    .screenScroll('content')
    .header(Header(t('homiio.team.title')).inPage());
});
