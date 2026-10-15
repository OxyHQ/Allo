import { chromium } from 'playwright';
import { createHmac } from 'node:crypto';
const secret = process.env.ALLO_CALL_TEST_TURN_SECRET;
const url = process.env.ALLO_CALL_TEST_TURN_URL;
if (!secret || !url) throw new Error('ephemeral local TURN fixture required');
const plan = (ttl) => {
  const username = `${Math.floor(Date.now() / 1000) + ttl}:browser-fixture`;
  return {
    relayOnly: true,
    iceServers: [
      {
        urls: [url],
        username,
        credential: createHmac('sha1', secret).update(username).digest('base64'),
      },
    ],
  };
};
const browser = await chromium.launch({
  executablePath: process.env.ALLO_CALL_CHROMIUM_PATH,
  headless: true,
  args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
});
try {
  const context = await browser.newContext({ permissions: ['camera', 'microphone'] });
  await context.addInitScript(() => {
    window.turnPeers = [];
    const NativePeer = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends NativePeer {
      constructor(config) {
        super(config);
        window.turnPeers.push(this);
      }
    };
  });
  const page = await context.newPage();
  await page.goto(process.env.ALLO_CALL_TEST_ORIGIN);
  await page.evaluate((initial) => window.run(initial), plan(5));
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('video')].length === 3 &&
      [...document.querySelectorAll('video')].every(
        (v) => v.getVideoPlaybackQuality().totalVideoFrames > 5,
      ),
  );
  const stats = async () =>
    page.evaluate(async () =>
      Promise.all(
        window.turnPeers.map(async (peer) => {
          const reports = await peer.getStats();
          const transport = [...reports.values()].find(
            (r) => r.type === 'transport' && r.selectedCandidatePairId,
          );
          const pair = reports.get(transport.selectedCandidatePairId);
          const local = reports.get(pair.localCandidateId);
          return {
            type: local.candidateType,
            relayProtocol: local.relayProtocol,
            candidate: local.id,
            ufrag: local.usernameFragment,
            bytes: pair.bytesReceived,
          };
        }),
      ),
    );
  const before = await stats();
  if (before.some((r) => r.type !== 'relay'))
    throw new Error('direct candidate bypassed relay-only policy');
  await page.waitForTimeout(6000);
  const preserved = await page.evaluate((fresh) => window.restart(fresh), plan(60));
  await page.waitForFunction(() =>
    window.turnPeers.every((p) => p.connectionState === 'connected'),
  );
  await page.waitForTimeout(1500);
  const after = await stats();
  if (
    !preserved ||
    after.some((r, i) => r.type !== 'relay' || r.bytes <= 0 || r.candidate === before[i].candidate)
  )
    throw new Error('new authenticated relay allocation / capture continuity failed');
  console.log(
    JSON.stringify({
      before,
      after,
      freshAllocationAfterExpiry: true,
      capturePreserved: preserved,
    }),
  );
} finally {
  await browser.close();
}
