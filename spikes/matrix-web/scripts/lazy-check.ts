// Answers one question with a network measurement instead of an opinion:
// does opening the app download the 7.8 MB .wasm, or is it only fetched when
// crypto is actually needed?
//
//   bun run scripts/lazy-check.ts
import puppeteer from 'puppeteer-core';

const APP_URL = process.env.SPIKE_APP_URL ?? 'http://localhost:8142';
const CHROME = process.env.SPIKE_CHROME ?? '/usr/bin/chromium';

interface Transfer {
    url: string;
    status: number;
    contentType: string;
    bytes: number;
}

const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

try {
    const page = await browser.newPage();
    const transfers: Transfer[] = [];
    page.on('response', async (response) => {
        const headers = response.headers();
        transfers.push({
            url: response.url(),
            status: response.status(),
            contentType: headers['content-type'] ?? 'none',
            bytes: Number(headers['content-length'] ?? 0),
        });
    });

    await page.goto(APP_URL, { waitUntil: 'networkidle2', timeout: 60_000 });
    await page.waitForFunction(() => window.matrixSpike !== undefined, { timeout: 30_000 });
    // Give anything lazy a chance to fire after first paint.
    await new Promise((resolve) => setTimeout(resolve, 5_000));

    const onLoad = [...transfers];
    const wasmOnLoad = onLoad.filter((t) => t.url.endsWith('.wasm'));
    const totalOnLoad = onLoad.reduce((sum, t) => sum + t.bytes, 0);

    console.log('--- after page load + 5s idle ---');
    console.log(`requests: ${onLoad.length}, total content-length: ${totalOnLoad} bytes`);
    for (const t of onLoad) {
        console.log(`  ${t.status} ${t.bytes.toString().padStart(9)} ${t.contentType.split(';')[0]}  ${t.url}`);
    }
    console.log(
        wasmOnLoad.length === 0
            ? 'WASM ON LOAD: none — the .wasm is NOT downloaded just by opening the app'
            : `WASM ON LOAD: ${wasmOnLoad.length} request(s) — the .wasm IS downloaded on open`,
    );

    transfers.length = 0;
    console.log('\n--- now calling initAsync() explicitly ---');
    const result = await page.evaluate(async (): Promise<string> => {
        const spike = window.matrixSpike;
        if (spike === undefined) return 'window.matrixSpike missing';
        return spike.step1LoadWasm();
    });
    console.log(result);
    for (const t of transfers.filter((x) => x.url.endsWith('.wasm'))) {
        console.log(`  ${t.status} ${t.bytes} bytes ${t.contentType}  ${t.url}`);
    }
} finally {
    await browser.close();
}
