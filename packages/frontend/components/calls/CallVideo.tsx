import { RTCView } from '@livekit/react-native-webrtc';
import { StyleSheet } from 'react-native';
export function CallVideo({
  stream,
  mirror = false,
  label,
}: {
  stream: MediaStream;
  mirror?: boolean;
  label: string;
}) {
  // The registered native MediaStream exposes toURL; the DOM type does not.
  const native = stream as MediaStream & { toURL(): string };
  return (
    <RTCView
      streamURL={native.toURL()}
      mirror={mirror}
      objectFit="cover"
      style={styles.video}
      accessibilityLabel={label}
    />
  );
}
const styles = StyleSheet.create({ video: { width: '100%', height: '100%' } });
