/**
 * Global Jest setup for @allo/frontend.
 *
 * Tests target pure logic (Signal Protocol, offline queue, optimistic updates).
 * We mock the native / Oxy modules that the production code imports so that
 * each unit can run on plain Node without booting React Native or Expo.
 */

jest.mock("@react-native-async-storage/async-storage", () =>
  require("@react-native-async-storage/async-storage/jest/async-storage-mock")
);

jest.mock("@react-native-community/netinfo", () => ({
  __esModule: true,
  default: {
    addEventListener: jest.fn(() => jest.fn()),
    fetch: jest.fn(() =>
      Promise.resolve({ isConnected: true, type: "wifi", isInternetReachable: true })
    ),
  },
}));

jest.mock("react-native", () => ({
  Platform: { OS: "ios", select: (obj: Record<string, unknown>) => obj.ios ?? obj.default },
  NativeModules: {},
}));

jest.mock("react-native-webrtc", () => ({}), { virtual: true });

// expo-file-system ships untransformed ESM and is pulled in transitively by the
// media path (uploadAttachment / mediaCache). Stub its class surface so unit
// tests that import stores depending on it can run on plain Node.
jest.mock(
  "expo-file-system",
  () => ({
    __esModule: true,
    File: class File {},
    Directory: class Directory {},
    Paths: { cache: "", document: "" },
  }),
  { virtual: true }
);

jest.mock("expo-secure-store", () => {
  const store = new Map<string, string>();
  return {
    getItemAsync: jest.fn(async (key: string) => store.get(key) ?? null),
    setItemAsync: jest.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    deleteItemAsync: jest.fn(async (key: string) => {
      store.delete(key);
    }),
    isAvailableAsync: jest.fn(async () => true),
    AFTER_FIRST_UNLOCK: "AFTER_FIRST_UNLOCK",
  };
});

jest.mock("@oxyhq/services", () => ({}), { virtual: true });

jest.mock("@oxyhq/core", () => ({
  oxyClient: {
    auth: jest.fn(),
    getUserById: jest.fn(),
  },
}));

// Silence noisy production logs in tests; failures still surface via `expect()`.
jest.spyOn(console, "log").mockImplementation(() => {});
jest.spyOn(console, "warn").mockImplementation(() => {});
jest.spyOn(console, "error").mockImplementation(() => {});
