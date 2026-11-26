import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useCallMedia } from '@/lib/allo/callMedia';
import { Button as LButton, Text, toElement } from '@oxy.so/bloom-language';
function RemoteAudio({ stream }: { stream: MediaStream }) {
  const ref = useRef<HTMLAudioElement>(null);
  const [blocked, setBlocked] = useState(false);
  const { t } = useTranslation();
  useEffect(() => {
    let active = true;
    const audio = ref.current;
    if (!audio) return;
    audio.srcObject = stream;
    void audio
      .play()
      .then(() => {
        if (active) setBlocked(false);
      })
      .catch(() => {
        if (active) setBlocked(true);
      });
    return () => {
      active = false;
      audio.pause();
      audio.srcObject = null;
    };
  }, [stream]);
  return (
    <>
      {/* Live E2EE media has no transcript track; never upload call audio for captions. */}
      {/* biome-ignore lint/a11y/useMediaCaption: live encrypted call audio has no caption source */}
      <audio ref={ref} autoPlay />
      {blocked
        ? toElement(
            LButton(Text(t('calls.enableAudio'))).onPress(() => {
              void ref.current
                ?.play()
                .then(() => setBlocked(false))
                .catch(() => setBlocked(true));
            }),
          )
        : null}
    </>
  );
}
/** Mounted once per client, survives route changes/minimisation. */
export function CallAudio() {
  const { remote } = useCallMedia();
  return (
    <>
      {remote.map(({ id, stream }) => (
        <RemoteAudio key={id} stream={stream} />
      ))}
    </>
  );
}
