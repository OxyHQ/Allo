import { useEffect, useRef } from 'react';
/** Video is always muted. Exactly one account-scoped audio host plays sound. */
export function CallVideo({
  stream,
  mirror = false,
  label,
}: {
  stream: MediaStream;
  mirror?: boolean;
  label: string;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    video.srcObject = stream;
    void video.play().catch(() => undefined);
    return () => {
      video.srcObject = null;
    };
  }, [stream]);
  return (
    <video
      ref={ref}
      autoPlay
      playsInline
      muted
      aria-label={label}
      style={{
        width: '100%',
        height: '100%',
        objectFit: 'cover',
        transform: mirror ? 'scaleX(-1)' : undefined,
      }}
    />
  );
}
