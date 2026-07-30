/**
 * Global test setup for the backend package.
 *
 * Keeps unit tests free of a live MongoDB or Oxy API. Mongoose itself stays REAL
 * — schemas, `Types.ObjectId` and model construction are used by the code under
 * test — and only the connection is stubbed, so nothing opens a socket to
 * localhost:27017 and stalls for the server-selection timeout.
 *
 * The singleton is proxied rather than cloned: `Schema`, `model` and `Types` are
 * prototype members a spread would drop.
 */
import { vi } from "vitest";

vi.mock("mongoose", async () => {
  const actual = await vi.importActual<typeof import("mongoose")>("mongoose");

  const connect = vi.fn().mockResolvedValue(undefined);
  const disconnect = vi.fn().mockResolvedValue(undefined);

  const mongooseSingleton = new Proxy(actual.default, {
    get(target, property) {
      if (property === "connect") return connect;
      if (property === "disconnect") return disconnect;
      return Reflect.get(target, property, target);
    },
  });

  return {
    ...actual,
    default: mongooseSingleton,
    connect,
    disconnect,
  };
});

// Suppress log output; assertions that care about logging spy on it explicitly.
vi.mock("../utils/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));
