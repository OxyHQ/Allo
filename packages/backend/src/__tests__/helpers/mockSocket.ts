/**
 * Test helper: a minimal mock of the Socket.IO `/messaging` namespace that
 * records every `.to(room).emit(event, payload)` call. Installed on
 * `global.io` so the message/device routes can fan out exactly as in prod, and
 * tests can assert on what was emitted to which room.
 */

export interface RecordedEmit {
  room: string;
  event: string;
  payload: unknown;
}

export interface RecordedDisconnect {
  room: string;
  /** The `close` argument passed to `disconnectSockets(close)`. */
  close: boolean;
}

export interface MockMessaging {
  emits: RecordedEmit[];
  /** Every `.in(room).disconnectSockets(close)` call, in order. */
  disconnects: RecordedDisconnect[];
  /** Restore the previous `global.io` value. */
  restore: () => void;
  /** All emits sent to a given room. */
  emitsTo: (room: string) => RecordedEmit[];
  /** All emits of a given event name. */
  emitsOf: (event: string) => RecordedEmit[];
  /** All disconnectSockets calls targeting a given room. */
  disconnectsOf: (room: string) => RecordedDisconnect[];
}

interface GlobalWithIo {
  io?: unknown;
}

export function installMockMessaging(): MockMessaging {
  const emits: RecordedEmit[] = [];
  const disconnects: RecordedDisconnect[] = [];

  const namespace = {
    to(room: string) {
      return {
        emit(event: string, payload: unknown) {
          emits.push({ room, event, payload });
        },
      };
    },
    in(room: string) {
      return {
        disconnectSockets(close: boolean) {
          disconnects.push({ room, close });
        },
      };
    },
  };

  const io = {
    of(nsp: string) {
      if (nsp !== "/messaging") {
        throw new Error(`Unexpected namespace requested in test: ${nsp}`);
      }
      return namespace;
    },
  };

  const globalRef = global as GlobalWithIo;
  const previous = globalRef.io;
  globalRef.io = io;

  return {
    emits,
    disconnects,
    restore: () => {
      globalRef.io = previous;
    },
    emitsTo: (room: string) => emits.filter((e) => e.room === room),
    emitsOf: (event: string) => emits.filter((e) => e.event === event),
    disconnectsOf: (room: string) => disconnects.filter((d) => d.room === room),
  };
}
