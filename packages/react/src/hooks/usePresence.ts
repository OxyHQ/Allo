import { PRESENCE_UNKNOWN, type PresenceView } from "@allo/core";
import { useEffect, useMemo } from "react";
import { useAlloContext } from "../AlloProvider";
import { useClientSnapshot } from "../internal/useClientSnapshot";

export interface Presence {
  /** One account's presence. Stable between changes; `known` is false until the server has answered. */
  of(accountId: string): PresenceView;
  /**
   * Whether THIS account publishes its own presence — the same switch that
   * decides whether it may see anybody else's. When false every answer above
   * is the hidden one, and the screen should say so rather than drawing
   * everybody as offline.
   */
  publishing: boolean;
}

/**
 * Who is online, among the accounts a screen is SHOWING.
 *
 * The argument is the watch set: the SDK tells the server exactly this list
 * and hears about exactly this list. Pass the accounts on screen, not the
 * address book — presence for an account nobody is drawing is a notification
 * nobody reads and a dot somebody could scrape.
 *
 * Subscribes to `presence`. The list is compared by VALUE, so a caller that
 * builds a fresh array each render (every caller) does not re-watch on every
 * render; but keep it short, and let it change when the screen does.
 */
export function usePresence(accountIds: readonly string[]): Presence {
  const { client } = useAlloContext();
  const key = accountIds.join(",");
  const watched = useMemo(() => (key ? key.split(",") : []), [key]);

  useEffect(() => {
    void client.presence.watch(watched);
    // Watching nothing on unmount is what stops the updates for a screen that
    // is gone; the next screen replaces the set with its own.
    return () => void client.presence.watch([]);
  }, [client, watched]);

  const version = useClientSnapshot(client, "presence", () => client.presence.version());
  const publishing = useClientSnapshot(client, "presence", () => client.presence.publishing());

  return useMemo(
    () => ({
      // `version` is in the dependency list, not the body: it is what makes a
      // change re-render, while `of` stays the same function.
      of: (accountId: string) => (watched.includes(accountId) ? client.presence.of(accountId) : PRESENCE_UNKNOWN),
      publishing,
    }),
    [client, publishing, version, watched],
  );
}
