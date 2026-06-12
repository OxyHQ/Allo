/**
 * Hand-rolled gramjs test double.
 *
 * The real `telegram` package opens sockets and pulls heavy native-ish deps, so
 * every test mocks it entirely — NO network, NO real client. This module exports
 * the small surface the manager touches; individual test files wire
 * `jest.mock("telegram", ...)` (and the subpaths) to these implementations and
 * then drive behaviour by configuring the fake client.
 */

/** How the fake QR login flow should resolve. */
export type QrBehavior = "success" | "fail" | "hang";

/** How the fake phone login flow should resolve after the code is submitted. */
export type PhoneBehavior = "success" | "needs_password" | "fail_code" | "fail_password";

/**
 * Minimal `Api` namespace stand-in, declared first so the client's default
 * behaviour can reference `ApiUser`. `Api.User`/`Api.UserEmpty` are used with
 * `instanceof` (so the resolved "me" must be a real `ApiUser` instance for the
 * manager's `extractSelf` to read its fields); `Api.auth.LogOut` is `new`-ed.
 */
export class ApiUser {
  id: { toString: () => string };
  username?: string;
  firstName?: string;
  phone?: string;
  constructor(props: { id: string; username?: string; firstName?: string; phone?: string }) {
    this.id = { toString: () => props.id };
    this.username = props.username;
    this.firstName = props.firstName;
    this.phone = props.phone;
  }
}
export class ApiUserEmpty {
  id: { toString: () => string };
  constructor(props: { id: string }) {
    this.id = { toString: () => props.id };
  }
}
class ApiLogOut {}

export const FakeApi = {
  User: ApiUser,
  UserEmpty: ApiUserEmpty,
  auth: { LogOut: ApiLogOut },
};

/** Build the default "me" user (an ApiUser instance so `instanceof` holds). */
function defaultMe(): ApiUser {
  return new ApiUser({ id: "1000", username: "me", firstName: "Me", phone: "+34600111122" });
}

/** A configurable fake TelegramClient. Tests set `behavior` to steer it. */
export class FakeTelegramClient {
  static lastInstance: FakeTelegramClient | undefined;

  /** Steers `signInUserWithQrCode`. Default `hang` (URL issued, awaiting scan). */
  static qrBehavior: QrBehavior = "hang";

  /** Steers `start`. Default `success` (code accepted, no 2FA). */
  static phoneBehavior: PhoneBehavior = "success";

  /** FIFO of one-shot errors `connect()` throws before falling back to behavior. */
  static connectErrorQueue: unknown[] = [];

  /** Total `sendMessage` invocations across ALL instances (for dedup assertions). */
  static sendCount = 0;

  /**
   * When set, every `sendMessage` awaits this promise before completing — lets a
   * test hold a send "in-flight" while it delivers a duplicate command, then
   * release to let the original finish.
   */
  static sendGate: Promise<void> | undefined;

  session: { save: () => string };
  logLevel: string | undefined;
  handlers: Array<{ callback: (event: unknown) => void; event: unknown }> = [];
  connected = false;
  destroyed = false;
  sent: Array<{ entity: unknown; params: unknown }> = [];

  /** Test-tunable behaviour. */
  static behavior: {
    authorized: boolean;
    connectThrows: boolean;
    /** When set, `connect()` throws this (e.g. a flood) instead of `connect_failed`. */
    connectError: unknown;
    sendResultId: number;
    /** When set, `sendMessage()` throws this (e.g. a FloodWaitError). */
    sendError: unknown;
    getEntityResult: unknown;
    getMeResult: unknown;
  } = {
    authorized: true,
    connectThrows: false,
    connectError: undefined,
    sendResultId: 9999,
    sendError: undefined,
    getEntityResult: new ApiUser({ id: "42", username: "peer", firstName: "Peer" }),
    getMeResult: defaultMe(),
  };

  constructor(public sessionArg: unknown, public apiId: number, public apiHash: string) {
    this.session = { save: () => "SAVED_SESSION_STRING" };
    FakeTelegramClient.lastInstance = this;
  }

  setLogLevel(level: string): void {
    this.logLevel = level;
  }

  async connect(): Promise<void> {
    // One-shot errors are consumed first (FIFO), so a test can simulate
    // "flood once, then succeed" deterministically across the connect retry loop.
    if (FakeTelegramClient.connectErrorQueue.length > 0) {
      throw FakeTelegramClient.connectErrorQueue.shift();
    }
    if (FakeTelegramClient.behavior.connectError) {
      throw FakeTelegramClient.behavior.connectError;
    }
    if (FakeTelegramClient.behavior.connectThrows) {
      throw new Error("connect_failed");
    }
    this.connected = true;
  }

  async isUserAuthorized(): Promise<boolean> {
    return FakeTelegramClient.behavior.authorized;
  }

  async getMe(): Promise<unknown> {
    return FakeTelegramClient.behavior.getMeResult;
  }

  async getEntity(_entity: unknown): Promise<unknown> {
    return FakeTelegramClient.behavior.getEntityResult;
  }

  addEventHandler(callback: (event: unknown) => void, event: unknown): void {
    this.handlers.push({ callback, event });
  }

  async sendMessage(entity: unknown, params: unknown): Promise<{ id: number }> {
    FakeTelegramClient.sendCount += 1;
    this.sent.push({ entity, params });
    // Optionally hold the send in-flight so a test can race a duplicate command.
    if (FakeTelegramClient.sendGate) {
      await FakeTelegramClient.sendGate;
    }
    if (FakeTelegramClient.behavior.sendError) {
      throw FakeTelegramClient.behavior.sendError;
    }
    return { id: FakeTelegramClient.behavior.sendResultId };
  }

  async invoke(_request: unknown): Promise<unknown> {
    return {};
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
  }

  /**
   * Drive the QR auth flow the way gramjs does: emit a token via the `qrCode`
   * callback (so the manager resolves its first-URL Deferred), then settle per
   * {@link FakeTelegramClient.qrBehavior}. `success` resolves with a user; `fail`
   * invokes onError + rejects; `hang` emits the token but never settles (tests the
   * `pending` response without completing the login).
   */
  async signInUserWithQrCode(
    _creds: unknown,
    authParams: {
      qrCode: (code: { token: Buffer; expires: number }) => Promise<void>;
      onError: (err: Error) => Promise<boolean> | void;
    }
  ): Promise<unknown> {
    await authParams.qrCode({ token: Buffer.from("tok"), expires: 60 });
    const mode = FakeTelegramClient.qrBehavior;
    if (mode === "fail") {
      await authParams.onError(new Error("qr_failed"));
      throw new Error("qr_failed");
    }
    if (mode === "hang") {
      // Never settle: simulates a QR awaiting a scan. The Deferred URL is already
      // delivered, so the `pending` response is returned; we resolve a never-promise.
      return new Promise<unknown>(() => undefined);
    }
    return FakeTelegramClient.behavior.getMeResult;
  }

  /**
   * Drive the phone auth flow the way gramjs does: request the code via
   * `phoneCode()` (parks the manager's resolver + signals code-requested), await
   * the submitted code, then per {@link FakeTelegramClient.phoneBehavior} either
   * finish, require a 2FA password (call `password()` + await it), or fail.
   */
  async start(authParams: {
    phoneNumber: () => Promise<string>;
    phoneCode: () => Promise<string>;
    password: () => Promise<string>;
    onError: (err: Error) => Promise<boolean> | void;
  }): Promise<void> {
    await authParams.phoneNumber();
    await authParams.phoneCode();
    const mode = FakeTelegramClient.phoneBehavior;
    if (mode === "fail_code") {
      await authParams.onError(new Error("bad_code"));
      throw new Error("bad_code");
    }
    if (mode === "needs_password") {
      await authParams.password();
      // After the password is delivered the login completes (success).
    }
    if (mode === "fail_password") {
      await authParams.password();
      await authParams.onError(new Error("bad_password"));
      throw new Error("bad_password");
    }
    // mode === "success" or completed needs_password: resolve cleanly.
  }

  /** Reset tunable behaviour between tests. */
  static reset(): void {
    FakeTelegramClient.behavior = {
      authorized: true,
      connectThrows: false,
      connectError: undefined,
      sendResultId: 9999,
      sendError: undefined,
      getEntityResult: new ApiUser({ id: "42", username: "peer", firstName: "Peer" }),
      getMeResult: defaultMe(),
    };
    FakeTelegramClient.qrBehavior = "hang";
    FakeTelegramClient.phoneBehavior = "success";
    FakeTelegramClient.connectErrorQueue = [];
    FakeTelegramClient.sendCount = 0;
    FakeTelegramClient.sendGate = undefined;
    FakeTelegramClient.lastInstance = undefined;
  }
}

/**
 * A stand-in for gramjs's `FloodWaitError`. The connector detects floods
 * STRUCTURALLY (name endsWith "FloodWaitError" + numeric `seconds`), so this
 * plain class is recognised identically to the real one.
 */
export class FakeFloodWaitError extends Error {
  errorMessage: string;
  constructor(public seconds: number) {
    super(`FLOOD_WAIT_${seconds}`);
    this.name = "FloodWaitError";
    this.errorMessage = `FLOOD_WAIT_${seconds}`;
  }
}

/** Minimal `StringSession` stand-in. */
export class FakeStringSession {
  constructor(public initial?: string) {}
  save(): string {
    return "SAVED_SESSION_STRING";
  }
}

/** Minimal event-builder constructors (the manager only `new`s them). */
export class FakeNewMessage {
  constructor(public opts: unknown) {}
}
export class FakeEditedMessage {
  constructor(public opts: unknown) {}
}
export class FakeDeletedMessage {
  constructor(public opts: unknown) {}
}

/** gramjs LogLevel enum subset. */
export const FakeLogLevel = { NONE: "none" } as const;

/** Identity-ish helpers from `telegram/Utils`. */
export function fakeGetPeerId(peer: unknown): string {
  if (peer && typeof peer === "object" && "id" in (peer as Record<string, unknown>)) {
    return String((peer as { id: unknown }).id);
  }
  return String(peer);
}
export function fakeGetDisplayName(entity: unknown): string {
  if (entity && typeof entity === "object" && "firstName" in (entity as Record<string, unknown>)) {
    return String((entity as { firstName: unknown }).firstName ?? "");
  }
  return "";
}
