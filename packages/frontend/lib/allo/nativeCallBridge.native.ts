import { requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';
import type { NativeCallBridge } from './nativeCalls';
const native = requireOptionalNativeModule<NativeCallBridge>('AlloNativeCalls');
export const nativeCallBridge: NativeCallBridge | null = native
  ? {
      bind: (account, instance) => native.bind(account, instance),
      clear: (instance) => native.clear(instance),
      snapshot: () => native.snapshot(),
      acknowledge: (event, success, terminal) => native.acknowledge(event, success, terminal),
      end: (id) => native.end(id),
      audio: async (active) => {
        if (Platform.OS !== 'ios') return;
        const { RTCAudioSession } = await import('@livekit/react-native-webrtc');
        if (active) RTCAudioSession.audioSessionDidActivate();
        else RTCAudioSession.audioSessionDidDeactivate();
      },
    }
  : null;
