import { chromium } from 'playwright';
import { AccessToken } from 'livekit-server-sdk';
const browser = await chromium.launch({
  executablePath: process.env.ALLO_CALL_CHROMIUM_PATH,
  headless: true,
  args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
});
try {
  const pages = [];
  for (const identity of ['sender-a', 'sender-b']) {
    const context = await browser.newContext({ permissions: ['camera', 'microphone'] });
    const page = await context.newPage();
    pages.push(page);
    page.on('pageerror', (error) => {
      throw error;
    });
    await page.goto(process.env.ALLO_CALL_TEST_ORIGIN);
    const token = new AccessToken('devkey', 'development-only-video-verification-secret', {
      identity,
    });
    token.addGrant({
      roomJoin: true,
      room: 'video-verification',
      canPublish: true,
      canSubscribe: true,
      canPublishData: false,
    });
    await page.evaluate(
      async ({ identity, token }) =>
        window.group(identity, { url: 'ws://127.0.0.1:55912', token, room: 'video-verification' }),
      { identity, token: await token.toJwt() },
    );
  }
  await pages[0].waitForTimeout(1500);
  const beforeKeys = await Promise.all(
    pages.map((p) => p.evaluate(() => window.a.state.getSnapshot().remote.length)),
  );
  if (beforeKeys.some((n) => n !== 0))
    throw new Error('subscribed without authenticated sender key');
  await pages[0].evaluate(() => window.a.setReceiveKey('sender-b', new Uint8Array(32).fill(8)));
  await pages[0].waitForTimeout(1500);
  const wrongKeyWidth = await pages[0].evaluate(() => document.querySelector('video').videoWidth);
  if (wrongKeyWidth !== 0) throw new Error('wrong key decoded video');
  await pages[0].evaluate(() => window.receive('sender-b'));
  await pages[1].evaluate(() => window.receive('sender-a'));
  await Promise.all(
    pages.map((p) =>
      p.waitForFunction(
        () =>
          document.querySelector('video')?.videoWidth > 0 &&
          document.querySelector('video')?.getVideoPlaybackQuality().totalVideoFrames > 5,
      ),
    ),
  );
  const decoded = await Promise.all(
    pages.map((p) =>
      p.evaluate(() => ({
        remote: window.a.state.getSnapshot().remote.map((r) => r.id),
        frames: document.querySelector('video').getVideoPlaybackQuality().totalVideoFrames,
        width: document.querySelector('video').videoWidth,
      })),
    ),
  );
  const renewed = new AccessToken('devkey', 'development-only-video-verification-secret', {
    identity: 'sender-a',
  });
  renewed.addGrant({
    roomJoin: true,
    room: 'video-verification',
    canPublish: true,
    canSubscribe: true,
    canPublishData: false,
  });
  await pages[0].evaluate(
    async (token) =>
      window.group(
        'sender-a',
        {
          url: 'ws://127.0.0.1:55912',
          token,
          room: 'video-verification',
        },
        3,
      ),
    await renewed.toJwt(),
  );
  await pages[0].evaluate(() => window.receive('sender-b'));
  await pages[1].evaluate(() => window.a.setReceiveKey('sender-a', new Uint8Array(32).fill(3)));
  await Promise.all(
    pages.map((page) =>
      page.waitForFunction(
        () =>
          document.querySelector('video')?.videoWidth > 0 &&
          document.querySelector('video')?.getVideoPlaybackQuality().totalVideoFrames > 10,
      ),
    ),
  );
  const plainToken = new AccessToken('devkey', 'development-only-video-verification-secret', {
    identity: 'sender-plain',
  });
  plainToken.addGrant({
    roomJoin: true,
    room: 'video-verification',
    canPublish: true,
    canSubscribe: true,
  });
  const plain = await (
    await browser.newContext({ permissions: ['camera', 'microphone'] })
  ).newPage();
  await plain.goto(process.env.ALLO_CALL_TEST_ORIGIN);
  await pages[0].evaluate(() => window.a.setReceiveKey('sender-plain', new Uint8Array(32).fill(3)));
  await plain.evaluate(
    (token) => window.plain({ url: 'ws://127.0.0.1:55912', token }),
    await plainToken.toJwt(),
  );
  await pages[0].waitForTimeout(1000);
  const rejectedPlaintext = await pages[0].evaluate(
    () => !window.a.state.getSnapshot().remote.some((r) => r.id === 'sender-plain'),
  );
  if (!rejectedPlaintext) throw new Error('unencrypted media accepted');
  console.log(JSON.stringify({ beforeKeys, wrongKeyWidth, rejectedPlaintext, decoded }));
  await Promise.all(pages.map((p) => p.evaluate(() => window.a.close())));
} finally {
  await browser.close();
}
