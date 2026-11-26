import { useOxyRuntime } from '@oxy.so/services/runtime';
import { useLayoutEffect } from 'react';

import { followOxyRuntime } from '@/lib/query/accountQueryCache';
import { accountQueryCache } from '@/lib/query/queryClient';

/**
 * Keeps Allo's React Query cache on the session's account. Mounted once, as the
 * first child of `OxyProvider`, so it follows the runtime before any account
 * content mounts; it renders nothing.
 */
export function AccountQueryScope() {
  const runtime = useOxyRuntime();
  useLayoutEffect(() => followOxyRuntime(accountQueryCache, runtime), [runtime]);
  return null;
}
