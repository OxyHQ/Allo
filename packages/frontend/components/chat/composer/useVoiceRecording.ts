import { useCallback, useEffect, useState } from 'react';
import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from 'expo-audio';

/** Shorter than this is a mis-tap, not a message. */
const MIN_DURATION_MS = 500;

export interface VoiceRecording {
  recording: boolean;
  seconds: number;
  /** Asks for the microphone if needed and starts. `false` when permission was refused. */
  start: () => Promise<boolean>;
  /** Stops and answers the file and its length, or `null` for a recording too short to send. */
  finish: () => Promise<{ uri: string; durationMs: number } | null>;
  cancel: () => Promise<void>;
}

export function useVoiceRecording(): VoiceRecording {
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const state = useAudioRecorderState(recorder, 250);
  const [recording, setRecording] = useState(false);

  useEffect(
    () => () => {
      if (recorder.isRecording) void recorder.stop();
    },
    [recorder],
  );

  const start = useCallback(async () => {
    const permission = await requestRecordingPermissionsAsync();
    if (!permission.granted) return false;
    await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: true });
    await recorder.prepareToRecordAsync();
    recorder.record();
    setRecording(true);
    return true;
  }, [recorder]);

  const finish = useCallback(async () => {
    const durationMs = state.durationMillis;
    await recorder.stop();
    setRecording(false);
    await setAudioModeAsync({ allowsRecording: false });
    const uri = recorder.uri;
    return uri && durationMs >= MIN_DURATION_MS ? { uri, durationMs } : null;
  }, [recorder, state.durationMillis]);

  const cancel = useCallback(async () => {
    await recorder.stop();
    setRecording(false);
    await setAudioModeAsync({ allowsRecording: false });
  }, [recorder]);

  return { recording, seconds: Math.floor(state.durationMillis / 1000), start, finish, cancel };
}
