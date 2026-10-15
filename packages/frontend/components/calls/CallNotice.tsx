import { useEffect, useRef } from 'react';
import { useCall } from '@allo/react';
import { toast } from '@oxy.so/bloom/toast';
import i18n from '@/lib/i18n';
/** Mounted once per account, including while the call screen is minimised. */
export function CallNotice() {
  const call = useCall();
  const shown = useRef<string | null>(null);
  useEffect(() => {
    if (
      call?.phase !== 'ended' ||
      call.endNotice !== 'membership_changed' ||
      shown.current === call.id
    )
      return;
    shown.current = call.id;
    toast.error(i18n.t('calls.membershipChanged'));
  }, [call]);
  return null;
}
