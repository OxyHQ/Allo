/** Local ALLO_HARNESS fixture only: the Services runtime of the one harness account, which never changes. */
import { HARNESS_ME } from './oxy-services';

const snapshot = { account: HARNESS_ME };

export function useOxyRuntime() {
  return { getSnapshot: () => snapshot, subscribe: () => () => undefined };
}
