// Drives the exported build in a real browser and reports each step's verdict.
//
// Usage:
//   bun run scripts/drive.ts <steps...>
// e.g.
//   bun run scripts/drive.ts 1
//   bun run scripts/drive.ts 1 2 3 4a 4b
//   bun run scripts/drive.ts multitab
//
// Homeserver credentials come from the environment so nothing sensitive is
// written to disk:
//   SPIKE_HOMESERVER, SPIKE_USER, SPIKE_PASSWORD, SPIKE_PASSPHRASE
import puppeteer, { type ConsoleMessage, type Page } from 'puppeteer-core';

const APP_URL = process.env.SPIKE_APP_URL ?? 'http://localhost:8142';
const CHROME = process.env.SPIKE_CHROME ?? '/usr/bin/chromium';

interface DriveConfig {
    homeserver: string;
    user: string;
    password: string;
    passphrase: string;
    /** Server to run the OIDC discovery step against; may differ from `homeserver`. */
    oidcHomeserver: string;
}

const config: DriveConfig = {
    homeserver: process.env.SPIKE_HOMESERVER ?? 'http://localhost:8008',
    user: process.env.SPIKE_USER ?? 'spike',
    password: process.env.SPIKE_PASSWORD ?? '',
    passphrase: process.env.SPIKE_PASSPHRASE ?? 'spike-passphrase-stands-in-for-oxy-hkdf-output',
    oidcHomeserver:
        process.env.SPIKE_OIDC_HOMESERVER ?? process.env.SPIKE_HOMESERVER ?? 'http://localhost:8008',
};

interface StepResult {
    ok: boolean;
    detail: string;
}

interface DeviceCredentials {
    userId: string;
    deviceId: string;
    accessToken: string;
    roomId: string;
}

declare global {
    interface Window {
        matrixSpike?: {
            step1LoadWasm(): Promise<string>;
            step2Login(config: DriveConfig): Promise<string>;
            step3RoundTrip(): Promise<string>;
            step4aBootstrapRecovery(): Promise<string>;
            step4bRecoverOnSecondDevice(): Promise<string>;
            step5MultiTab(config: DriveConfig): Promise<string>;
            step5AttachSameDevice(config: DriveConfig, credentials: DeviceCredentials): Promise<string>;
            step5ReportOwnKeys(): Promise<string>;
            step5ReadEvent(roomId: string, eventId: string): Promise<string>;
            step5SendFromThisTab(): Promise<string>;
            step5ProbeLockPrimitives(): string;
            stepOidcDiscovery(homeserver: string): Promise<string>;
            getDeviceACredentials(): DeviceCredentials;
            run<T>(name: string, fn: () => Promise<T> | T): Promise<StepResult>;
        };
    }
}

function attachLogging(page: Page, label: string): void {
    page.on('console', (message: ConsoleMessage) => {
        const text = message.text();
        const type = message.type();
        if (text.startsWith('[spike]') || type === 'error' || type === 'warn') {
            console.log(`  ${label} ${type}: ${text}`);
        }
    });
    page.on('pageerror', (error: unknown) => {
        console.log(`  ${label} PAGEERROR: ${error instanceof Error ? error.message : String(error)}`);
    });
    page.on('requestfailed', (request) => {
        console.log(`  ${label} REQUEST FAILED: ${request.url()} — ${request.failure()?.errorText ?? 'unknown'}`);
    });
    page.on('response', (response) => {
        const url = response.url();
        if (url.endsWith('.wasm')) {
            console.log(
                `  ${label} wasm response: ${response.status()} ${url} ` +
                    `content-type=${response.headers()['content-type'] ?? 'none'}`,
            );
        } else if (response.status() >= 400) {
            console.log(`  ${label} HTTP ${response.status()}: ${url}`);
        }
    });
}

async function openApp(label: string, browser: Awaited<ReturnType<typeof puppeteer.launch>>): Promise<Page> {
    const page = await browser.newPage();
    attachLogging(page, label);
    await page.goto(APP_URL, { waitUntil: 'networkidle2', timeout: 60_000 });
    await page.waitForFunction(() => window.matrixSpike !== undefined, { timeout: 30_000 });
    return page;
}

async function runStep(page: Page, name: string, steps: string[]): Promise<StepResult> {
    console.log(`\n=== ${name} ===`);
    const result = await page.evaluate(
        async (stepNames: string[], cfg: typeof config): Promise<StepResult> => {
            const spike = window.matrixSpike;
            if (spike === undefined) return { ok: false, detail: 'window.matrixSpike missing' };
            const details: string[] = [];
            for (const step of stepNames) {
                let outcome: StepResult;
                switch (step) {
                    case '1':
                        outcome = await spike.run('step1', () => spike.step1LoadWasm());
                        break;
                    case '2':
                        outcome = await spike.run('step2', () => spike.step2Login(cfg));
                        break;
                    case '3':
                        outcome = await spike.run('step3', () => spike.step3RoundTrip());
                        break;
                    case '4a':
                        outcome = await spike.run('step4a', () => spike.step4aBootstrapRecovery());
                        break;
                    case '4b':
                        outcome = await spike.run('step4b', () => spike.step4bRecoverOnSecondDevice());
                        break;
                    case 'multitab':
                        outcome = await spike.run('step5 multitab', () => spike.step5MultiTab(cfg));
                        break;
                    case 'oidc':
                        outcome = await spike.run('oidc', () => spike.stepOidcDiscovery(cfg.oidcHomeserver));
                        break;
                    case 'probe':
                        outcome = await spike.run('step5 probe', () => spike.step5ProbeLockPrimitives());
                        break;
                    default:
                        outcome = { ok: false, detail: `unknown step "${step}"` };
                }
                details.push(`${step}: ${outcome.ok ? 'PASS' : 'FAIL'}\n${outcome.detail}`);
                if (!outcome.ok) return { ok: false, detail: details.join('\n\n') };
            }
            return { ok: true, detail: details.join('\n\n') };
        },
        steps,
        config,
    );
    console.log(result.ok ? `RESULT: PASS\n${result.detail}` : `RESULT: FAIL\n${result.detail}`);
    return result;
}

const requested = process.argv.slice(2);
if (requested.length === 0) {
    console.error('usage: bun run scripts/drive.ts <step> [...steps]   (steps: 1 2 3 4a 4b multitab probe)');
    process.exit(1);
}

const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

try {
    if (requested[0] === 'shared-session-stress') {
        // Two tabs on one crypto store take turns sending, while an independent
        // third device watches. Divergence in the shared store shows up as the
        // observer failing to decrypt some messages.
        const rounds = Number(process.env.SPIKE_ROUNDS ?? 5);
        const tabA = await openApp('[tab A]', browser);
        const setup = await runStep(tabA, 'tab A setup', ['1', '2', '3']);
        if (!setup.ok) throw new Error('tab A setup failed');

        const credentials = await tabA.evaluate((): DeviceCredentials => {
            const spike = window.matrixSpike;
            if (spike === undefined) throw new Error('window.matrixSpike missing');
            return spike.getDeviceACredentials();
        });

        // Observer logs in *before* any of the alternating sends, so it should
        // receive every room key through the normal to-device path.
        const observer = await openApp('[observer]', browser);
        const observerUp = await observer.evaluate(
            async (cfg: DriveConfig, roomId: string): Promise<StepResult> => {
                const spike = window.matrixSpike;
                if (spike === undefined) return { ok: false, detail: 'window.matrixSpike missing' };
                const wasm = await spike.run('step1', () => spike.step1LoadWasm());
                if (!wasm.ok) return wasm;
                return spike.run('observer login', () => spike.step5LoginObserver(cfg, roomId));
            },
            config,
            credentials.roomId,
        );
        console.log(`\nobserver: ${observerUp.ok ? 'PASS' : 'FAIL'} — ${observerUp.detail}`);
        if (!observerUp.ok) throw new Error('observer failed to start');

        const tabB = await openApp('[tab B]', browser);
        const attached = await tabB.evaluate(
            async (cfg: DriveConfig, creds: DeviceCredentials): Promise<StepResult> => {
                const spike = window.matrixSpike;
                if (spike === undefined) return { ok: false, detail: 'window.matrixSpike missing' };
                const wasm = await spike.run('step1', () => spike.step1LoadWasm());
                if (!wasm.ok) return wasm;
                return spike.run('attach shared store', () => spike.step5AttachSameDevice(cfg, creds));
            },
            config,
            credentials,
        );
        console.log(`\ntab B attach: ${attached.ok ? 'PASS' : 'FAIL'} — ${attached.detail}`);
        if (!attached.ok) throw new Error('tab B could not attach to the shared store');

        const sendFrom = async (page: Page, label: string): Promise<{ eventId: string; body: string } | null> => {
            const result = await page.evaluate(async (): Promise<StepResult> => {
                const spike = window.matrixSpike;
                if (spike === undefined) return { ok: false, detail: 'window.matrixSpike missing' };
                return spike.run('send', () => spike.step5SendFromThisTab());
            });
            if (!result.ok) {
                console.log(`  ${label} send FAILED: ${result.detail.split('\n')[0]}`);
                return null;
            }
            const [eventId, body] = result.detail.split('|');
            if (eventId === undefined || body === undefined) return null;
            return { eventId, body };
        };

        const sent: { from: string; eventId: string; body: string }[] = [];
        for (let round = 0; round < rounds; round += 1) {
            const fromA = await sendFrom(tabA, 'tab A');
            if (fromA !== null) sent.push({ from: 'tab A', ...fromA });
            const fromB = await sendFrom(tabB, 'tab B');
            if (fromB !== null) sent.push({ from: 'tab B', ...fromB });
        }
        console.log(`\nsent ${sent.length} messages alternating between two tabs on one crypto store`);

        console.log('\n=== observer: can an independent device decrypt every message? ===');
        const failures: string[] = [];
        for (const message of sent) {
            const read = await observer.evaluate(
                async (roomId: string, evId: string): Promise<StepResult> => {
                    const spike = window.matrixSpike;
                    if (spike === undefined) return { ok: false, detail: 'window.matrixSpike missing' };
                    return spike.run('observer read', () => spike.step5ReadEvent(roomId, evId));
                },
                credentials.roomId,
                message.eventId,
            );
            const ok = read.ok && read.detail.includes(message.body);
            console.log(`  ${message.eventId} (${message.from}): ${ok ? 'decrypted' : 'FAILED'}`);
            if (!ok) failures.push(`${message.eventId} from ${message.from}: ${read.detail.split('\n')[0]}`);
        }
        console.log(
            failures.length === 0
                ? `\nOBSERVER RESULT: all ${sent.length} messages decrypted — no divergence observed`
                : `\nOBSERVER RESULT: ${failures.length}/${sent.length} messages undecryptable:\n${failures.join('\n')}`,
        );
        process.exitCode = 0;
    } else if (requested[0] === 'shared-session') {
        // Two tabs of the same app: same Matrix device, same IndexedDB crypto
        // store, both live at once.
        const tabA = await openApp('[tab A]', browser);
        console.log('\n=== tab A: wasm, login, encrypted round trip ===');
        const a = await runStep(tabA, 'tab A setup', ['1', '2', '3']);
        if (!a.ok) throw new Error('tab A setup failed; cannot test the collision');

        const credentials = await tabA.evaluate((): DeviceCredentials => {
            const spike = window.matrixSpike;
            if (spike === undefined) throw new Error('window.matrixSpike missing');
            return spike.getDeviceACredentials();
        });
        console.log(
            `\nsharing session: device=${credentials.deviceId} room=${credentials.roomId} ` +
                `(token withheld from logs)`,
        );

        const tabB = await openApp('[tab B]', browser);
        console.log('\n=== tab B: attach to the SAME device + store while tab A is live ===');
        const b = await tabB.evaluate(
            async (cfg: DriveConfig, creds: DeviceCredentials): Promise<StepResult> => {
                const spike = window.matrixSpike;
                if (spike === undefined) return { ok: false, detail: 'window.matrixSpike missing' };
                const wasm = await spike.run('step1', () => spike.step1LoadWasm());
                if (!wasm.ok) return wasm;
                return spike.run('step5 shared session', () => spike.step5AttachSameDevice(cfg, creds));
            },
            config,
            credentials,
        );
        console.log(b.ok ? `tab B: PASS\n${b.detail}` : `tab B: FAIL\n${b.detail}`);

        // Decisive check: both tabs claim the same device_id. If they report
        // different Olm identity keys, the shared store has been clobbered.
        const readKeys = async (page: Page, label: string): Promise<string> => {
            const result = await page.evaluate(async (): Promise<StepResult> => {
                const spike = window.matrixSpike;
                if (spike === undefined) return { ok: false, detail: 'window.matrixSpike missing' };
                return spike.run('own keys', () => spike.step5ReportOwnKeys());
            });
            console.log(`${label} own keys: ${result.detail}`);
            return result.detail;
        };
        console.log('\n=== identity check: same device_id in both tabs ===');
        const keysA = await readKeys(tabA, 'tab A');
        const keysB = await readKeys(tabB, 'tab B');
        console.log(
            keysA === keysB
                ? 'IDENTITY MATCH: both tabs agree on the device identity'
                : `IDENTITY DIVERGED:\n  tab A = ${keysA}\n  tab B = ${keysB}`,
        );

        console.log('\n=== tab A: still functional after tab B attached to its store? ===');
        const aAfterSend = await tabA.evaluate(async (): Promise<StepResult> => {
            const spike = window.matrixSpike;
            if (spike === undefined) return { ok: false, detail: 'window.matrixSpike missing' };
            return spike.run('tab A send after collision', () => spike.step5SendFromThisTab());
        });
        console.log(aAfterSend.ok ? `tab A send: PASS\n${aAfterSend.detail}` : `tab A send: FAIL\n${aAfterSend.detail}`);

        if (aAfterSend.ok) {
            const [eventId] = aAfterSend.detail.split('|');
            console.log('\n=== tab B: can it decrypt what tab A sent after the collision? ===');
            const crossRead = await tabB.evaluate(
                async (roomId: string, evId: string): Promise<StepResult> => {
                    const spike = window.matrixSpike;
                    if (spike === undefined) return { ok: false, detail: 'window.matrixSpike missing' };
                    return spike.run('tab B read tab A message', () => spike.step5ReadEvent(roomId, evId));
                },
                credentials.roomId,
                eventId ?? '',
            );
            console.log(crossRead.ok ? `tab B read: PASS\n${crossRead.detail}` : `tab B read: FAIL\n${crossRead.detail}`);
        }
        process.exitCode = 0;
    } else if (requested[0] === 'multitab-collision') {
        // Special mode: two tabs on the same origin, both bringing up crypto on
        // the same IndexedDB store, exactly as two open Allo tabs would.
        const tabA = await openApp('[tab A]', browser);
        const tabB = await openApp('[tab B]', browser);
        console.log('\n=== tab A: login + crypto (store prefix spike-device-a) ===');
        const a = await runStep(tabA, 'tab A step2', ['1', '2']);
        console.log('\n=== tab B: second client on the SAME store, while tab A is live ===');
        const b = await runStep(tabB, 'tab B multitab', ['1', 'multitab']);
        console.log('\n=== tab A: can it still use crypto after tab B attached? ===');
        const aAgain = await runStep(tabA, 'tab A round trip after collision', ['3']);
        process.exitCode = a.ok && b.ok && aAgain.ok ? 0 : 1;
    } else {
        const page = await openApp('[tab]', browser);
        const result = await runStep(page, `steps ${requested.join(' ')}`, requested);
        process.exitCode = result.ok ? 0 : 1;
    }
} finally {
    await browser.close();
}
