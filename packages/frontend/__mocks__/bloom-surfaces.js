/**
 * Bloom's surface stack, stood in for under jest.
 *
 * `@oxy.so/bloom/surfaces` reaches Bloom's `Dialog`, which imports
 * `react-native-reanimated`, which this runner cannot load — the same reason
 * `AGENTS.md` says component coverage here stays at the data-path level and
 * the screens are looked at in a browser instead.
 *
 * So the dialogs are doubled rather than rendered. `confirm` resolves TRUE,
 * because every test that reaches one is exercising what happens after the
 * person agrees; a test that needs the refusal mocks this module itself.
 */
module.exports = {
  confirm: async () => true,
  alert: () => undefined,
  prompt: async () => null,
  present: () => undefined,
  dismiss: () => undefined,
  dismissAll: () => undefined,
  surfaces: { confirm: async () => true, alert: () => undefined },
};
