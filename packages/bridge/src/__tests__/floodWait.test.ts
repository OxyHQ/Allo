import { detectFloodWait } from "../telegram/floodWait";
import { FakeFloodWaitError } from "./__mocks__/gramjs";

/**
 * FLOOD_WAIT detection is structural (not `instanceof`) so it works across realms
 * and is trivially mockable. These tests pin both the recognition and the
 * `seconds` extraction (field first, then parsed from the message, then 0).
 */
describe("detectFloodWait", () => {
  it("recognises a gramjs-style FloodWaitError and reads its seconds field", () => {
    const result = detectFloodWait(new FakeFloodWaitError(42));
    expect(result).toEqual({ seconds: 42 });
  });

  it("recognises a flood by errorMessage prefix and reads the numeric field", () => {
    const result = detectFloodWait({ errorMessage: "FLOOD_WAIT_17", seconds: 17 });
    expect(result).toEqual({ seconds: 17 });
  });

  it("parses seconds out of the message when no numeric field is present", () => {
    const result = detectFloodWait({ errorMessage: "FLOOD_WAIT_99" });
    expect(result).toEqual({ seconds: 99 });
  });

  it("recognises SLOWMODE_WAIT as a flood-style wait", () => {
    const result = detectFloodWait({ errorMessage: "SLOWMODE_WAIT_8", seconds: 8 });
    expect(result).toEqual({ seconds: 8 });
  });

  it("defaults to 0 seconds when a flood is recognised but no hint can be read", () => {
    const result = detectFloodWait({ name: "FloodWaitError" });
    expect(result).toEqual({ seconds: 0 });
  });

  it("returns null for non-flood errors", () => {
    expect(detectFloodWait(new Error("AUTH_KEY_UNREGISTERED"))).toBeNull();
    expect(detectFloodWait({ errorMessage: "PEER_ID_INVALID" })).toBeNull();
    expect(detectFloodWait(null)).toBeNull();
    expect(detectFloodWait("FLOOD_WAIT_5")).toBeNull(); // not an object
    expect(detectFloodWait(undefined)).toBeNull();
  });
});
