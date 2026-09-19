import type { StatusDraft, StatusView, StatusViewerView } from "@allo/core";
import { useCallback, useMemo } from "react";
import { useAlloContext } from "../AlloProvider";
import { useClientSnapshot } from "../internal/useClientSnapshot";

export interface Statuses {
  /** Everything this device can read, newest first. Stable between `statuses` emissions. */
  all: readonly StatusView[];
  /** Only this account's own, newest first. */
  mine: readonly StatusView[];
  /** Post one. The audience is resolved on the device; the server is never asked for a contact list. */
  post(draft: StatusDraft): Promise<string>;
  /** Tell the author it was seen. Whether your name travels is your own setting. */
  view(statusId: string): Promise<void>;
  /** Who saw one of YOURS. Refused for anybody else's. */
  viewers(statusId: string): Promise<StatusViewerView>;
  /** Take one of yours down before its deadline. */
  remove(statusId: string): Promise<void>;
  /** Re-read the listing. The socket does this on its own when somebody posts. */
  refresh(): Promise<void>;
}

/**
 * Status updates: one ciphertext, a key sealed to each recipient device, 24
 * hours. Subscribes to `statuses`.
 *
 * Nothing is persisted by the SDK, so this list is empty until the first
 * refresh lands — which `client.start()` kicks off. The media of a status is
 * NOT fetched by any of this; `client.statuses.media(id)` does that, once
 * somebody opens one.
 */
export function useStatuses(): Statuses {
  const { client } = useAlloContext();
  const all = useClientSnapshot(client, "statuses", () => client.statuses.list());
  const mine = useMemo(() => all.filter((status) => status.mine), [all]);

  const post = useCallback((draft: StatusDraft) => client.statuses.post(draft), [client]);
  const view = useCallback((statusId: string) => client.statuses.view(statusId), [client]);
  const viewers = useCallback((statusId: string) => client.statuses.viewers(statusId), [client]);
  const remove = useCallback((statusId: string) => client.statuses.remove(statusId), [client]);
  const refresh = useCallback(() => client.statuses.refresh(), [client]);

  return useMemo(
    () => ({ all, mine, post, view, viewers, remove, refresh }),
    [all, mine, post, view, viewers, remove, refresh],
  );
}
