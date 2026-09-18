import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from 'expo-audio';

/** Shorter than this is a mis-tap, not a message. */
const MIN_DURATION_MS = 500;

export interface Recording {
  uri: string;
  durationMs: number;
  /** What the recorder actually produced, when it can be known (the web says so on the blob). */
  mimetype?: string;
}

export interface VoiceRecording {
  recording: boolean;
  seconds: number;
  /** Asks for the microphone if needed and starts. `false` when permission was refused. */
  start: () => Promise<boolean>;
  /** Stops and answers the file and its length, or `null` for a recording too short to send. */
  finish: () => Promise<Recording | null>;
  cancel: () => Promise<void>;
}

/**
 * What the web recorder produced. `expo-audio` hands back an object URL with no
 * extension there, so without asking the blob every voice note would be named
 * (and typed) as whatever the filename fallback guesses — a picture.
 */
async function recordedMimetype(uri: string): Promise<string | undefined> {
  if (Platform.OS !== 'web') return undefined;
  try {
    const blob = await fetch(uri).then((response) => response.blob());
    return blob.type || undefined;
  } catch {
    return undefined;
  }
}

export function useVoiceRecording(): VoiceRecording {
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const state = useAudioRecorderState(recorder, 250);
  const [recording, setRecording] = useState(false);
  // The polled state lags by up to its interval, which drops a short recording
  // and shortens every other one; the clock does not.
  const startedAt = useRef(0);

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
    startedAt.current = Date.now();
    setRecording(true);
    return true;
  }, [recorder]);

  const finish = useCallback(async (): Promise<Recording | null> => {
    const durationMs = Date.now() - startedAt.current;
    await recorder.stop();
    setRecording(false);
    await setAudioModeAsync({ allowsRecording: false });
    const uri = recorder.uri;
    if (!uri || durationMs < MIN_DURATION_MS) return null;
    return { uri, durationMs, mimetype: await recordedMimetype(uri) };
  }, [recorder]);

  const cancel = useCallback(async () => {
    await recorder.stop();
    setRecording(false);
    await setAudioModeAsync({ allowsRecording: false });
  }, [recorder]);

  return { recording, seconds: Math.floor(state.durationMillis / 1000), start, finish, cancel };
}
