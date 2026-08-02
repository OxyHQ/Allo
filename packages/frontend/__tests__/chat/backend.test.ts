import { CHAT_BACKEND, CHAT_BACKEND_VARIABLE, parseChatBackend } from '@/lib/chat/backend';

/**
 * The flag that decides which messaging system a build talks to.
 *
 * The case worth being strict about is the third one: a value that is neither
 * backend has to stop the build rather than pick one, because someone who
 * mistypes it gets an app where every screen works and none of them talk to the
 * system they meant.
 */
describe('parseChatBackend', () => {
  it('leaves an unconfigured build on the Express API', () => {
    expect(parseChatBackend(undefined)).toBe('allo-api');
  });

  it('treats an empty value as unconfigured', () => {
    // Which is what a shell exports for a variable set to nothing, and what
    // Expo substitutes for one that is declared and blank.
    expect(parseChatBackend('')).toBe('allo-api');
  });

  it('selects Matrix when asked for it', () => {
    expect(parseChatBackend('matrix')).toBe('matrix');
  });

  it('selects the Express API when asked for it by name', () => {
    expect(parseChatBackend('allo-api')).toBe('allo-api');
  });

  it('refuses a value that is neither backend, and says what to write', () => {
    expect(() => parseChatBackend('Matrix')).toThrow(CHAT_BACKEND_VARIABLE);
    expect(() => parseChatBackend('Matrix')).toThrow(/allo-api, matrix/);
  });

  it('refuses a value that only looks like a switch', () => {
    // `=true` is the shape people reach for first, and silently selecting the
    // old backend for it is exactly the failure this refusal exists to prevent.
    expect(() => parseChatBackend('true')).toThrow();
    expect(() => parseChatBackend('1')).toThrow();
  });
});

describe('CHAT_BACKEND', () => {
  it('is the Express API in a build that has not asked for anything else', () => {
    // The default the whole migration rests on: an ordinary build — this test
    // run included — is the app as it was, and Matrix is what you opt into.
    // Reading the constant and not the function is the point: this is the value
    // every `CHAT_BACKEND === 'matrix'` in the app compares against.
    expect(CHAT_BACKEND).toBe('allo-api');
  });
});
