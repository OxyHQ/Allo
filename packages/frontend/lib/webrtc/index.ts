/**
 * Default WebRTC entry. Metro/Expo automatically resolve `index.native.ts`
 * on iOS/Android and `index.web.ts` on web. This file is only used by `tsc`
 * during type-checking (and by Node tooling that ignores platform extensions),
 * so we re-export the web implementation here — its types are the canonical
 * superset (browser standard DOM lib `MediaStream`, etc.).
 */
import webrtcImpl from './index.web';
export default webrtcImpl;
export const webrtc = webrtcImpl;
export * from './index.web';
