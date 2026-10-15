/** Ephemeral media owned by one client. Rendering never owns or stops tracks. */
export interface CallMediaSnapshot {
  local: MediaStream | null;
  remote: ReadonlyArray<{ id: string; stream: MediaStream }>;
  revision: number;
}
export function createMediaState() {
  let snapshot: CallMediaSnapshot = { local: null, remote: [], revision: 0 };
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    update(local: MediaStream | null, remote: CallMediaSnapshot['remote']) {
      snapshot = { local, remote, revision: snapshot.revision + 1 };
      for (const listener of listeners) listener();
    },
  };
}
