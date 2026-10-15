import { chromium } from 'playwright';
const browser = await chromium.launch({
  executablePath: process.env.ALLO_CALL_CHROMIUM_PATH,
  headless: true,
  args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
});
try {
  const context = await browser.newContext({ permissions: ['camera', 'microphone'] });
  const page = await context.newPage();
  page.on('pageerror', (error) => {
    throw error;
  });
  await page.goto(process.env.ALLO_CALL_TEST_ORIGIN);
  await page.evaluate(() => window.run());
  await page.waitForFunction(
    () =>
      document.querySelectorAll('video').length === 3 &&
      [...document.querySelectorAll('video')].every(
        (v) => v.videoWidth > 0 && v.getVideoPlaybackQuality().totalVideoFrames > 5,
      ),
  );
  const decoded = await page.evaluate(() =>
    [...document.querySelectorAll('video')].map((v) => ({
      label: v.getAttribute('aria-label'),
      width: v.videoWidth,
      frames: v.getVideoPlaybackQuality().totalVideoFrames,
      muted: v.muted,
    })),
  );
  await page.evaluate(() => window.toggle());
  await page.waitForTimeout(150);
  const aliveAfterUnmount = await page.evaluate(() =>
    window.a
      .localStream()
      .getTracks()
      .every((t) => t.readyState === 'live'),
  );
  await page.evaluate(() => window.toggle());
  await page.waitForFunction(() => document.querySelector('video')?.videoWidth > 0);
  await page.evaluate(async () => {
    window.stopIce();
    window.old = window.a.localStream();
    await window.a.close();
    await window.b.close();
  });
  const stopped = await page.evaluate(
    () =>
      window.old.getTracks().every((t) => t.readyState === 'ended') &&
      window.a.state.getSnapshot().remote.length === 0,
  );
  console.log(JSON.stringify({ decoded, aliveAfterUnmount, stopped }));
  if (decoded.length !== 3 || !aliveAfterUnmount || !stopped || decoded.some((v) => !v.muted))
    throw new Error('media lifecycle failed');
} finally {
  await browser.close();
}
