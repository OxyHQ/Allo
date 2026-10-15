import type { NativeCallBridge } from './nativeCalls';
/** Web has no OS call service. Native uses the platform-specific sibling. */
export const nativeCallBridge: NativeCallBridge | null = null;
