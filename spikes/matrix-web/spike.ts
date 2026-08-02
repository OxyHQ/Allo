// The whole spike lives here. It is driven either from the UI in App.tsx or
// from the browser console via `window.matrixSpike`, so that each step can be
// run in isolation and its failure attributed to one thing.
//
// Question being answered (docs/matrix/client-strategy.md §4 point 1):
// does matrix-js-sdk + @matrix-org/matrix-sdk-crypto-wasm survive Metro
// bundling in `expo export --platform web`?

import * as RustSdkCryptoJs from '@matrix-org/matrix-sdk-crypto-wasm';
import {
    ClientEvent,
    createClient,
    EventType,
    MatrixEvent,
    MsgType,
    OAuth2,
    Preset,
    RoomEvent,
    Visibility,
    type MatrixClient,
} from 'matrix-js-sdk';
import { deriveRecoveryKeyFromPassphrase } from 'matrix-js-sdk/lib/crypto-api/index.js';
import type { SecretStorageKeyDescription } from 'matrix-js-sdk/lib/secret-storage.js';

/**
 * The URL the WASM is served from. `public/matrix_sdk_crypto_wasm_bg.wasm` is
 * copied into the export output by `scripts/copy-wasm.js`, so this path is
 * valid both in `expo start --web` and in the static export.
 */
const WASM_URL = '/matrix_sdk_crypto_wasm_bg.wasm';

/** Distinct IndexedDB prefixes so the two simulated devices never share a store. */
const DEVICE_A_DB_PREFIX = 'spike-device-a';
const DEVICE_B_DB_PREFIX = 'spike-device-b';

export interface SpikeConfig {
    homeserver: string;
    user: string;
    password: string;
    /**
     * Stands in for the value §3.4 would derive from the Oxy BIP39 seed. The
     * spike only needs to prove an arbitrary passphrase can be fed in and
     * recovered from, so any ASCII string works here.
     */
    passphrase: string;
}

export type LogListener = (line: string) => void;

const listeners = new Set<LogListener>();
// Replaced (not mutated) on every line so `useSyncExternalStore` sees a new
// snapshot reference and re-renders.
let lines: readonly string[] = [];

function log(line: string): void {
    const stamped = `${new Date().toISOString().slice(11, 23)}  ${line}`;
    lines = [...lines, stamped];
    // eslint-disable-next-line no-console -- this is the spike's only output channel
    console.log(`[spike] ${line}`);
    for (const listener of listeners) listener(stamped);
}

export function subscribe(listener: LogListener): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

export function getLines(): readonly string[] {
    return lines;
}

/**
 * Server snapshot for `useSyncExternalStore`: always empty, so the statically
 * rendered HTML and the first client render agree (log lines carry timestamps,
 * which would otherwise be a hydration mismatch).
 */
const EMPTY_LINES: readonly string[] = Object.freeze([]);

export function getServerLines(): readonly string[] {
    return EMPTY_LINES;
}

function describeError(error: unknown): string {
    if (error instanceof Error) {
        return `${error.name}: ${error.message}${error.stack === undefined ? '' : `\n${error.stack}`}`;
    }
    return `non-Error thrown: ${String(error)}`;
}

function fail(message: string): never {
    throw new Error(message);
}

/** State carried between steps. */
interface SpikeState {
    config?: SpikeConfig;
    deviceA?: MatrixClient;
    deviceAAccessToken?: string;
    deviceB?: MatrixClient;
    roomId?: string;
    sentEventId?: string;
    sentBody?: string;
    recoveryKeyBase58?: string;
}

const state: SpikeState = {};

// ---------------------------------------------------------------------------
// Step 1 — the WASM loads and executes under a Metro-produced bundle.
// ---------------------------------------------------------------------------

export async function step1LoadWasm(): Promise<string> {
    log(`initAsync("${WASM_URL}") …`);
    const startedAt = performance.now();
    await RustSdkCryptoJs.initAsync(WASM_URL);
    const loadMs = Math.round(performance.now() - startedAt);

    const versions = RustSdkCryptoJs.getVersions();
    log(`wasm loaded in ${loadMs} ms — vodozemac ${versions.vodozemac}, git ${versions.git_description}`);

    // Loading is not the same as running. Build a real OlmMachine (in memory,
    // no server, no IndexedDB) so Rust code actually executes and produces
    // key material.
    const machine = await RustSdkCryptoJs.OlmMachine.initialize(
        new RustSdkCryptoJs.UserId('@spike:localhost'),
        new RustSdkCryptoJs.DeviceId('SPIKEDEVICE'),
    );
    const identity = machine.identityKeys;
    const curve = identity.curve25519.toBase64();
    const ed = identity.ed25519.toBase64();
    machine.free();

    const summary = `wasm OK in ${loadMs} ms; OlmMachine identity curve25519=${curve} ed25519=${ed}`;
    log(summary);
    return summary;
}

// ---------------------------------------------------------------------------
// Step 2 — log in and bring up the crypto stack against a real homeserver.
// ---------------------------------------------------------------------------

/**
 * Builds the `getSecretStorageKey` callback for a client: given the key
 * description published in account data, re-derives the 4S key from the
 * passphrase with the parameters the server advertises.
 */
function makeSecretStorageCallback(getPassphrase: () => string) {
    return async (
        opts: { keys: Record<string, SecretStorageKeyDescription> },
        secretName: string,
    ): Promise<[string, Uint8Array<ArrayBuffer>] | null> => {
        for (const [keyId, description] of Object.entries(opts.keys)) {
            const passphraseInfo = description.passphrase;
            if (passphraseInfo === undefined) {
                log(`getSecretStorageKey(${secretName}): key ${keyId} has no passphrase info, skipping`);
                continue;
            }
            log(
                `getSecretStorageKey(${secretName}): deriving key ${keyId} ` +
                    `(algorithm=${passphraseInfo.algorithm}, iterations=${passphraseInfo.iterations}, ` +
                    `salt=${passphraseInfo.salt.slice(0, 6)}…, bits=${passphraseInfo.bits ?? 'default'})`,
            );
            const startedAt = performance.now();
            const key = await deriveRecoveryKeyFromPassphrase(
                getPassphrase(),
                passphraseInfo.salt,
                passphraseInfo.iterations,
                passphraseInfo.bits,
            );
            log(`getSecretStorageKey(${secretName}): PBKDF2 took ${Math.round(performance.now() - startedAt)} ms`);
            return [keyId, key];
        }
        log(`getSecretStorageKey(${secretName}): no usable key`);
        return null;
    };
}

interface StartedClient {
    client: MatrixClient;
    deviceId: string;
    userId: string;
    accessToken: string;
}

/**
 * Everything a second tab needs to attach to the *same* Matrix device — which
 * is what two open tabs of one app actually do, since they share the session
 * persisted by the app.
 */
export interface DeviceCredentials {
    userId: string;
    deviceId: string;
    accessToken: string;
    roomId: string;
}

async function loginAndStart(
    config: SpikeConfig,
    dbPrefix: string,
    deviceDisplayName: string,
): Promise<StartedClient> {
    const loginClient = createClient({ baseUrl: config.homeserver });
    log(`login as ${config.user} on ${config.homeserver} …`);
    const login = await loginClient.loginRequest({
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: config.user },
        password: config.password,
        initial_device_display_name: deviceDisplayName,
    });

    const userId = login.user_id;
    const deviceId = login.device_id;
    if (deviceId === undefined) fail('homeserver returned no device_id');
    log(`logged in: ${userId} device=${deviceId}`);

    const client = createClient({
        baseUrl: config.homeserver,
        accessToken: login.access_token,
        userId,
        deviceId,
        cryptoCallbacks: {
            getSecretStorageKey: makeSecretStorageCallback(() => config.passphrase),
        },
    });

    log(`initRustCrypto(cryptoDatabasePrefix=${dbPrefix}) …`);
    await client.initRustCrypto({ useIndexedDB: true, cryptoDatabasePrefix: dbPrefix });

    const crypto = client.getCrypto();
    if (crypto === undefined) fail('client.getCrypto() is undefined after initRustCrypto');

    const ownKeys = await crypto.getOwnDeviceKeys();
    log(`own device keys: curve25519=${ownKeys.curve25519} ed25519=${ownKeys.ed25519}`);

    await client.startClient({ initialSyncLimit: 20 });
    await waitForSync(client);
    log(`client started and synced (${deviceDisplayName})`);

    return { client, deviceId, userId, accessToken: login.access_token };
}

function waitForSync(client: MatrixClient): Promise<void> {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            client.off(ClientEvent.Sync, onSync);
            reject(new Error('timed out waiting for first sync (60s)'));
        }, 60_000);

        function onSync(syncState: string, _prev: string | null, data?: { error?: Error }): void {
            if (syncState === 'PREPARED' || syncState === 'SYNCING') {
                clearTimeout(timeout);
                client.off(ClientEvent.Sync, onSync);
                resolve();
            } else if (syncState === 'ERROR') {
                clearTimeout(timeout);
                client.off(ClientEvent.Sync, onSync);
                reject(data?.error ?? new Error('sync entered ERROR state'));
            }
        }

        client.on(ClientEvent.Sync, onSync);
    });
}

export async function step2Login(config: SpikeConfig): Promise<string> {
    state.config = config;
    const started = await loginAndStart(config, DEVICE_A_DB_PREFIX, 'allo-web-spike-A');
    state.deviceA = started.client;
    state.deviceAAccessToken = started.accessToken;

    const crypto = started.client.getCrypto();
    if (crypto === undefined) fail('no crypto api');
    const crossSigningReady = await crypto.isCrossSigningReady();
    const secretStorageReady = await crypto.isSecretStorageReady();
    const backupVersion = await crypto.getActiveSessionBackupVersion();

    const summary =
        `device A up: ${started.userId} / ${started.deviceId}; ` +
        `crossSigningReady=${crossSigningReady} secretStorageReady=${secretStorageReady} ` +
        `activeBackupVersion=${backupVersion ?? 'none'}`;
    log(summary);
    return summary;
}

// ---------------------------------------------------------------------------
// Step 3 — encrypted round trip: create room, send, read back decrypted.
// ---------------------------------------------------------------------------

function requireDeviceA(): MatrixClient {
    const client = state.deviceA;
    if (client === undefined) fail('run step 2 first (device A is not logged in)');
    return client;
}

export async function step3RoundTrip(): Promise<string> {
    const client = requireDeviceA();
    const crypto = client.getCrypto();
    if (crypto === undefined) fail('no crypto api');

    log('creating encrypted room …');
    const created = await client.createRoom({
        preset: Preset.PrivateChat,
        visibility: Visibility.Private,
        name: `allo web spike ${new Date().toISOString()}`,
        initial_state: [
            {
                type: EventType.RoomEncryption,
                state_key: '',
                content: { algorithm: 'm.megolm.v1.aes-sha2' },
            },
        ],
    });
    state.roomId = created.room_id;
    log(`room created: ${created.room_id}`);

    await waitForRoom(client, created.room_id);
    await waitForEncryptionFlag(client, created.room_id);
    log('crypto stack confirms the room is encrypted');

    const body = `spike round trip ${Date.now()}`;
    state.sentBody = body;
    log(`sending encrypted message: "${body}"`);
    const sent = await client.sendMessage(created.room_id, { msgtype: MsgType.Text, body });
    state.sentEventId = sent.event_id;
    log(`sent event ${sent.event_id}`);

    // Read it back off the wire rather than from the local echo: fetch the raw
    // event from the homeserver and check the server really stored ciphertext,
    // then check the client decrypts what the timeline holds.
    const raw = await client.fetchRoomEvent(created.room_id, sent.event_id);
    if (raw.type !== EventType.RoomMessageEncrypted) {
        fail(`server stored plaintext: event type is ${raw.type}, expected ${EventType.RoomMessageEncrypted}`);
    }
    const rawContent = JSON.stringify(raw.content);
    if (rawContent.includes(body)) fail('plaintext body found in the event stored on the server');
    log(`server-side event type=${raw.type}, ciphertext only (${rawContent.length} bytes of content)`);

    const decrypted = await readMessageFromTimeline(client, created.room_id, sent.event_id);
    if (decrypted !== body) fail(`decrypted body mismatch: got "${decrypted}", expected "${body}"`);

    const summary = `round trip OK: sent + decrypted "${body}" in ${created.room_id}`;
    log(summary);
    return summary;
}

function waitForRoom(client: MatrixClient, roomId: string): Promise<void> {
    if (client.getRoom(roomId) !== null) return Promise.resolve();
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            client.off(ClientEvent.Room, onRoom);
            reject(new Error(`timed out waiting for room ${roomId} to appear in sync (30s)`));
        }, 30_000);
        function onRoom(): void {
            if (client.getRoom(roomId) !== null) {
                clearTimeout(timeout);
                client.off(ClientEvent.Room, onRoom);
                resolve();
            }
        }
        client.on(ClientEvent.Room, onRoom);
    });
}

/**
 * `createRoom` returns before the room's state has come back down /sync, so the
 * crypto stack learns about `m.room.encryption` a moment later. Poll rather than
 * assert instantly — but keep failing if it never arrives, because sending into
 * a room the crypto stack thinks is unencrypted would send plaintext.
 */
async function waitForEncryptionFlag(client: MatrixClient, roomId: string, timeoutMs = 30_000): Promise<void> {
    const crypto = client.getCrypto();
    if (crypto === undefined) fail('no crypto api');
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await crypto.isEncryptionEnabledInRoom(roomId)) return;
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
    fail(`room ${roomId} was still not seen as encrypted by the crypto stack after ${timeoutMs} ms`);
}

/**
 * Waits until `eventId` is present in the room timeline and decrypted, and
 * returns its plaintext body. Throws with the decryption failure reason if the
 * event stays undecryptable.
 */
async function readMessageFromTimeline(
    client: MatrixClient,
    roomId: string,
    eventId: string,
    timeoutMs = 30_000,
): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    let lastFailure = 'event never appeared in the timeline';

    while (Date.now() < deadline) {
        const room = client.getRoom(roomId);
        const event: MatrixEvent | undefined = room?.findEventById(eventId);
        if (event !== undefined) {
            if (event.isBeingDecrypted() || event.isDecryptionFailure()) {
                lastFailure = event.isDecryptionFailure()
                    ? `decryption failure: ${JSON.stringify(event.getContent())}`
                    : 'still decrypting';
            } else {
                const content = event.getContent();
                if (typeof content.body === 'string') return content.body;
                lastFailure = `event has no string body: ${JSON.stringify(content)}`;
            }
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
    }

    throw new Error(`could not read ${eventId} as plaintext — ${lastFailure}`);
}

// ---------------------------------------------------------------------------
// Step 4 — 4S with a passphrase + key backup, proved on a second device.
// ---------------------------------------------------------------------------

/** PBKDF2 parameters documented in client-strategy.md §3.1 / §3.3. */
const EXPECTED_PBKDF2_ALGORITHM = 'm.pbkdf2';
const EXPECTED_PBKDF2_ITERATIONS = 500_000;

export async function step4aBootstrapRecovery(): Promise<string> {
    const client = requireDeviceA();
    const config = state.config;
    if (config === undefined) fail('no config; run step 2 first');
    const crypto = client.getCrypto();
    if (crypto === undefined) fail('no crypto api');

    log('bootstrapCrossSigning …');
    await crypto.bootstrapCrossSigning({
        setupNewCrossSigning: true,
        authUploadDeviceSigningKeys: async (makeRequest) => {
            // Password auth is enough for a spike; a real client would run the
            // full UIA flow.
            await makeRequest({
                type: 'm.login.password',
                identifier: { type: 'm.id.user', user: config.user },
                password: config.password,
            });
        },
    });
    log('cross-signing bootstrapped');

    log(`bootstrapSecretStorage with passphrase-derived key …`);
    const startedAt = performance.now();
    await crypto.bootstrapSecretStorage({
        setupNewSecretStorage: true,
        setupNewKeyBackup: true,
        createSecretStorageKey: async () => {
            const generated = await crypto.createRecoveryKeyFromPassphrase(config.passphrase);
            state.recoveryKeyBase58 = generated.encodedPrivateKey;
            log(
                `createRecoveryKeyFromPassphrase: ${generated.privateKey.length}-byte key, ` +
                    `base58=${generated.encodedPrivateKey?.slice(0, 12)}…, ` +
                    `passphraseInfo=${JSON.stringify(generated.keyInfo?.passphrase)}`,
            );
            return generated;
        },
    });
    log(`bootstrapSecretStorage done in ${Math.round(performance.now() - startedAt)} ms`);

    // Verify the parameters actually published on the server match §3.1.
    const defaultKeyId = await client.secretStorage.getDefaultKeyId();
    if (defaultKeyId === null) fail('no default secret storage key id after bootstrap');
    const description = await client.secretStorage.getKey(defaultKeyId);
    if (description === null) fail(`no key description for ${defaultKeyId}`);
    const [, keyDescription] = description;
    const passphraseInfo = keyDescription.passphrase;
    if (passphraseInfo === undefined) fail('4S key was created without passphrase info in account data');
    if (passphraseInfo.algorithm !== EXPECTED_PBKDF2_ALGORITHM) {
        fail(`unexpected KDF algorithm: ${passphraseInfo.algorithm}`);
    }
    if (passphraseInfo.iterations !== EXPECTED_PBKDF2_ITERATIONS) {
        fail(`unexpected iteration count: ${passphraseInfo.iterations}`);
    }
    log(
        `account data m.secret_storage.key.${defaultKeyId}: algorithm=${passphraseInfo.algorithm} ` +
            `iterations=${passphraseInfo.iterations} salt.length=${passphraseInfo.salt.length} ` +
            `bits=${passphraseInfo.bits ?? 'default'}`,
    );

    const backupVersion = await waitForActiveBackupVersion(crypto);
    const secretStorageReady = await crypto.isSecretStorageReady();
    const crossSigningReady = await crypto.isCrossSigningReady();

    const summary =
        `4S created from passphrase: keyId=${defaultKeyId} PBKDF2-${passphraseInfo.algorithm} ` +
        `iterations=${passphraseInfo.iterations}; backupVersion=${backupVersion}; ` +
        `secretStorageReady=${secretStorageReady} crossSigningReady=${crossSigningReady}`;
    log(summary);
    return summary;
}

/**
 * Logs in a *second* device with an independent store, confirms it cannot read
 * the message device A sent, then recovers from 4S with the same passphrase and
 * confirms it can. That is the whole point of the key backup for Allo.
 */
export async function step4bRecoverOnSecondDevice(): Promise<string> {
    const config = state.config;
    const roomId = state.roomId;
    const eventId = state.sentEventId;
    const body = state.sentBody;
    if (config === undefined) fail('no config; run step 2 first');
    if (roomId === undefined || eventId === undefined || body === undefined) {
        fail('run step 3 first (no message to recover)');
    }

    // Device A must have uploaded the room key to the backup before device B
    // can find it there.
    const deviceA = requireDeviceA();
    const cryptoA = deviceA.getCrypto();
    if (cryptoA === undefined) fail('no crypto api on device A');
    log('waiting for device A to finish uploading room keys to the backup …');
    await waitForBackupUpload(cryptoA);

    const started = await loginAndStart(config, DEVICE_B_DB_PREFIX, 'allo-web-spike-B');
    state.deviceB = started.client;
    const cryptoB = started.client.getCrypto();
    if (cryptoB === undefined) fail('no crypto api on device B');

    await waitForRoom(started.client, roomId);

    // Before recovery: expect a decryption failure. If this *succeeds*, the
    // test proves nothing, so treat it as a failed test.
    let preRecoveryReadable: boolean;
    try {
        await readMessageFromTimeline(started.client, roomId, eventId, 15_000);
        preRecoveryReadable = true;
    } catch (error) {
        preRecoveryReadable = false;
        log(`device B cannot read the message yet, as expected — ${describeError(error).split('\n')[0]}`);
    }
    if (preRecoveryReadable) {
        fail('device B could already decrypt the message before recovering from 4S — test is inconclusive');
    }

    // Web needs three explicit calls where the native binding's
    // `recover(passphrase)` does everything in one:
    //   1. pull the cross-signing secrets out of 4S (this also signs this device),
    //   2. pull the megolm backup decryption key out of 4S,
    //   3. actually download and import the keys.
    log('device B: bootstrapCrossSigning({}) to pull cross-signing secrets out of 4S …');
    await cryptoB.bootstrapCrossSigning({});

    log('device B: loadSessionBackupPrivateKeyFromSecretStorage() …');
    await cryptoB.loadSessionBackupPrivateKeyFromSecretStorage();

    const backupCheck = await cryptoB.checkKeyBackupAndEnable();
    log(
        `device B: backup version=${backupCheck?.backupInfo.version ?? 'none'} ` +
            `trusted=${backupCheck?.trustInfo.trusted ?? false} ` +
            `matchesDecryptionKey=${backupCheck?.trustInfo.matchesDecryptionKey ?? false}`,
    );

    log('device B: restoreKeyBackup() …');
    const restoreStartedAt = performance.now();
    const result = await cryptoB.restoreKeyBackup();
    log(
        `restoreKeyBackup: imported ${result.imported}/${result.total} keys ` +
            `in ${Math.round(performance.now() - restoreStartedAt)} ms`,
    );

    const decrypted = await readMessageFromTimeline(started.client, roomId, eventId, 30_000);
    if (decrypted !== body) fail(`device B decrypted "${decrypted}", expected "${body}"`);

    const ownDevice = await cryptoB.getDeviceVerificationStatus(started.userId, started.deviceId);
    const verified = ownDevice?.crossSigningVerified ?? false;
    const secretStorageReady = await cryptoB.isSecretStorageReady();

    const summary =
        `device B recovered from 4S with the passphrase: imported ${result.imported}/${result.total} keys, ` +
        `decrypted "${decrypted}"; ownDeviceCrossSigningVerified=${verified} ` +
        `secretStorageReady=${secretStorageReady}`;
    log(summary);
    return summary;
}

type CryptoApi = NonNullable<ReturnType<MatrixClient['getCrypto']>>;

/**
 * `bootstrapSecretStorage` creates the backup version, but the local backup
 * engine only becomes "active" once `checkKeyBackupAndEnable` has run and
 * trusted it. That is asynchronous, so poll.
 */
async function waitForActiveBackupVersion(crypto: CryptoApi, timeoutMs = 30_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const version = await crypto.getActiveSessionBackupVersion();
        if (version !== null) return version;
        const check = await crypto.checkKeyBackupAndEnable();
        if (check !== null) {
            log(
                `checkKeyBackupAndEnable: version=${check.backupInfo.version ?? '?'} ` +
                    `trusted=${check.trustInfo.trusted} matchesDecryptionKey=${check.trustInfo.matchesDecryptionKey}`,
            );
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    fail(`no active key backup version after ${timeoutMs} ms`);
}

async function waitForBackupUpload(crypto: CryptoApi): Promise<void> {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
        // The public `checkKeyBackupAndEnable()` forces a re-fetch from the
        // server; `getKeyBackupInfo()` on its own returns a cached copy whose
        // `count` never moves.
        await crypto.checkKeyBackupAndEnable();
        const info = await crypto.getKeyBackupInfo();
        if (info !== null && typeof info.count === 'number' && info.count > 0) {
            log(`backup version ${info.version ?? '?'} holds ${info.count} keys`);
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    log('warning: backup key count never went above zero within 60s; continuing anyway');
}

// ---------------------------------------------------------------------------
// Step 5 — multi-tab collision (reproduce, do not fix).
// ---------------------------------------------------------------------------

/**
 * Brings up a client using the *same* IndexedDB prefix as device A. Run this in
 * a second tab while the first tab has device A running: that is exactly the
 * situation client-strategy.md §2.1 point 3 warns about.
 */
export async function step5MultiTab(config: SpikeConfig): Promise<string> {
    log('multi-tab: starting a client on the SAME crypto store prefix as device A');
    const started = await loginAndStart(config, DEVICE_A_DB_PREFIX, 'allo-web-spike-multitab');
    const crypto = started.client.getCrypto();
    if (crypto === undefined) fail('no crypto api');
    const keys = await crypto.getOwnDeviceKeys();
    const summary = `multi-tab client came up on shared store: device=${started.deviceId} ed25519=${keys.ed25519}`;
    log(summary);
    return summary;
}

/** Hands device A's session to a second tab, which is what a shared session is. */
export function getDeviceACredentials(): DeviceCredentials {
    const client = requireDeviceA();
    const accessToken = state.deviceAAccessToken;
    const roomId = state.roomId;
    const userId = client.getUserId();
    const deviceId = client.getDeviceId();
    if (accessToken === undefined) fail('no access token for device A');
    if (roomId === undefined) fail('run step 3 first (no room to share)');
    if (userId === null || deviceId === null) fail('device A has no user/device id');
    return { userId, deviceId, accessToken, roomId };
}

/**
 * The real multi-tab case: a second tab of the same app, with the same Matrix
 * device and therefore the same IndexedDB crypto store, brought up while the
 * first tab is still running. This is precisely what client-strategy.md §2.1
 * point 3 warns about.
 */
export async function step5AttachSameDevice(
    config: SpikeConfig,
    credentials: DeviceCredentials,
): Promise<string> {
    state.config = config;
    state.roomId = credentials.roomId;
    log(`attaching to the SAME device ${credentials.deviceId} and the SAME crypto store as tab A`);

    const client = createClient({
        baseUrl: config.homeserver,
        accessToken: credentials.accessToken,
        userId: credentials.userId,
        deviceId: credentials.deviceId,
        cryptoCallbacks: {
            getSecretStorageKey: makeSecretStorageCallback(() => config.passphrase),
        },
    });

    await client.initRustCrypto({ useIndexedDB: true, cryptoDatabasePrefix: DEVICE_A_DB_PREFIX });
    const crypto = client.getCrypto();
    if (crypto === undefined) fail('no crypto api');
    const keys = await crypto.getOwnDeviceKeys();
    log(`second tab opened the shared store; own device keys ed25519=${keys.ed25519}`);

    await client.startClient({ initialSyncLimit: 20 });
    await waitForSync(client);
    state.deviceA = client;
    state.deviceAAccessToken = credentials.accessToken;

    // Now use the crypto stack from this tab, in the room the first tab created.
    await waitForEncryptionFlag(client, credentials.roomId);
    const body = `second tab ${Date.now()}`;
    const sent = await client.sendMessage(credentials.roomId, { msgtype: MsgType.Text, body });
    log(`second tab sent ${sent.event_id}`);
    const readBack = await readMessageFromTimeline(client, credentials.roomId, sent.event_id);
    if (readBack !== body) fail(`second tab read "${readBack}", expected "${body}"`);

    const summary = `second tab on the shared store sent and decrypted its own message ("${body}")`;
    log(summary);
    return summary;
}

/** Reads a specific event, used to check the *other* tab afterwards. */
export async function step5ReadEvent(roomId: string, eventId: string): Promise<string> {
    const client = requireDeviceA();
    const body = await readMessageFromTimeline(client, roomId, eventId, 30_000);
    const summary = `read ${eventId} as "${body}"`;
    log(summary);
    return summary;
}

/** Sends a message from this tab and returns the event id, for cross-tab checks. */
export async function step5SendFromThisTab(): Promise<string> {
    const client = requireDeviceA();
    const roomId = state.roomId;
    if (roomId === undefined) fail('no room id in this tab');
    const body = `cross-tab probe ${Date.now()}`;
    const sent = await client.sendMessage(roomId, { msgtype: MsgType.Text, body });
    const summary = `${sent.event_id}|${body}`;
    log(`sent from this tab: ${summary}`);
    return summary;
}

/**
 * The decisive multi-tab probe: what Olm identity does *this* tab think the
 * shared device has? If two tabs on one device_id report different keys, the
 * shared IndexedDB store has been clobbered.
 */
export async function step5ReportOwnKeys(): Promise<string> {
    const client = requireDeviceA();
    const crypto = client.getCrypto();
    if (crypto === undefined) fail('no crypto api');
    const keys = await crypto.getOwnDeviceKeys();
    const summary = `${client.getDeviceId() ?? 'unknown'}|${keys.ed25519}|${keys.curve25519}`;
    log(`own keys in this tab: ${summary}`);
    return summary;
}

/**
 * A third, independent device that just watches. It logs in *before* the
 * shared-store tabs start sending, so it receives room keys normally. If two
 * tabs sharing one crypto store diverge on megolm session state, the symptom
 * is that this observer cannot decrypt some of what they sent — which is the
 * user-visible version of "data corruption and decryption failures".
 */
export async function step5LoginObserver(config: SpikeConfig, roomId: string): Promise<string> {
    state.config = config;
    state.roomId = roomId;
    const started = await loginAndStart(config, 'spike-device-observer', 'allo-web-spike-observer');
    state.deviceA = started.client;
    state.deviceAAccessToken = started.accessToken;
    await waitForRoom(started.client, roomId);
    const summary = `observer up as device ${started.deviceId}`;
    log(summary);
    return summary;
}

/** Reports whether the browser offers the two escape hatches §2.1 point 3 lists. */
export function step5ProbeLockPrimitives(): string {
    const hasLocks = typeof navigator !== 'undefined' && 'locks' in navigator;
    const hasSharedWorker = typeof SharedWorker !== 'undefined';
    const summary = `navigator.locks=${hasLocks} SharedWorker=${hasSharedWorker}`;
    log(summary);
    return summary;
}

// ---------------------------------------------------------------------------
// Extra — OIDC / MSC2965, the login path production will actually use.
// ---------------------------------------------------------------------------

/**
 * Deliberately NOT a real registered client id. Dynamic client registration
 * (`OAuth2.registerClient`) writes state on someone else's authorization
 * server, so this step stops short of it: discovery is a read, and the
 * authorization URL is built locally.
 */
const PLACEHOLDER_CLIENT_ID = 'https://allo.you/spike-placeholder-client';

export async function stepOidcDiscovery(homeserver: string): Promise<string> {
    const client = createClient({ baseUrl: homeserver });

    log(`getAuthMetadata() against ${homeserver} …`);
    const metadata = await client.getAuthMetadata();
    log(
        `issuer=${metadata.issuer}\n` +
            `  authorization_endpoint=${metadata.authorization_endpoint}\n` +
            `  token_endpoint=${metadata.token_endpoint}\n` +
            `  registration_endpoint=${metadata.registration_endpoint}\n` +
            `  revocation_endpoint=${metadata.revocation_endpoint}\n` +
            `  device_authorization_endpoint=${metadata.device_authorization_endpoint ?? 'none'}\n` +
            `  grant_types_supported=${metadata.grant_types_supported.join(',')}\n` +
            `  code_challenge_methods_supported=${metadata.code_challenge_methods_supported.join(',')}\n` +
            `  response_modes_supported=${metadata.response_modes_supported.join(',')}\n` +
            `  prompt_values_supported=${metadata.prompt_values_supported?.join(',') ?? 'none'}\n` +
            `  account_management_uri=${metadata.account_management_uri ?? 'none'}`,
    );

    // `getAuthMetadata` already validates against MSC2965; reaching here means
    // the SDK accepted this server's metadata.
    const auth = new OAuth2(metadata, {
        clientId: PLACEHOLDER_CLIENT_ID,
        redirectUri: `${globalThis.location.origin}/`,
        deviceId: 'ALLOSPIKEDEVICE',
    });
    const authorizationUrl = await auth.generateAuthorizationCodeGrantUrl('spike-state');
    const parsed = new URL(authorizationUrl);
    const params = parsed.searchParams;
    log(
        `authorization URL built locally: ${parsed.origin}${parsed.pathname}\n` +
            `  response_type=${params.get('response_type')}\n` +
            `  response_mode=${params.get('response_mode')}\n` +
            `  code_challenge_method=${params.get('code_challenge_method')}\n` +
            `  code_challenge=${params.get('code_challenge')?.slice(0, 12)}…\n` +
            `  scope=${params.get('scope')}`,
    );

    const challengeMethod = params.get('code_challenge_method');
    if (challengeMethod !== 'S256') fail(`expected PKCE S256, got ${String(challengeMethod)}`);

    const summary =
        `OIDC discovery OK: issuer=${metadata.issuer}, PKCE=${challengeMethod}, ` +
        `grants=[${metadata.grant_types_supported.join(' ')}], ` +
        `deviceGrant=${metadata.device_authorization_endpoint === undefined ? 'no' : 'yes'}, ` +
        `dynamicRegistration=${metadata.registration_endpoint === '' ? 'no' : 'advertised (not exercised)'}`;
    log(summary);
    return summary;
}

// ---------------------------------------------------------------------------
// Driving surface
// ---------------------------------------------------------------------------

export async function run<T>(name: string, fn: () => Promise<T> | T): Promise<{ ok: boolean; detail: string }> {
    log(`--- ${name}: start ---`);
    try {
        const detail = String(await fn());
        log(`--- ${name}: PASS ---`);
        return { ok: true, detail };
    } catch (error) {
        const detail = describeError(error);
        log(`--- ${name}: FAIL ---\n${detail}`);
        return { ok: false, detail };
    }
}

export interface SpikeGlobal {
    step1LoadWasm: typeof step1LoadWasm;
    step2Login: typeof step2Login;
    step3RoundTrip: typeof step3RoundTrip;
    step4aBootstrapRecovery: typeof step4aBootstrapRecovery;
    step4bRecoverOnSecondDevice: typeof step4bRecoverOnSecondDevice;
    step5MultiTab: typeof step5MultiTab;
    step5AttachSameDevice: typeof step5AttachSameDevice;
    step5ReportOwnKeys: typeof step5ReportOwnKeys;
    step5LoginObserver: typeof step5LoginObserver;
    step5ReadEvent: typeof step5ReadEvent;
    step5SendFromThisTab: typeof step5SendFromThisTab;
    step5ProbeLockPrimitives: typeof step5ProbeLockPrimitives;
    stepOidcDiscovery: typeof stepOidcDiscovery;
    getDeviceACredentials: typeof getDeviceACredentials;
    run: typeof run;
    getLines: typeof getLines;
}

declare global {
    // eslint-disable-next-line no-var -- global augmentation requires `var`
    var matrixSpike: SpikeGlobal | undefined;
}

export function installGlobal(): void {
    globalThis.matrixSpike = {
        step1LoadWasm,
        step2Login,
        step3RoundTrip,
        step4aBootstrapRecovery,
        step4bRecoverOnSecondDevice,
        step5MultiTab,
        step5AttachSameDevice,
        step5ReportOwnKeys,
        step5LoginObserver,
        step5ReadEvent,
        step5SendFromThisTab,
        step5ProbeLockPrimitives,
        stepOidcDiscovery,
        getDeviceACredentials,
        run,
        getLines,
    };
    log('window.matrixSpike installed');
}
