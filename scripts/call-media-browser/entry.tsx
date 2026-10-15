import React from 'react';
import { Room } from 'livekit-client';
import { createRoot } from 'react-dom/client';
import { createCallMedia } from '../../packages/frontend/lib/calls/webrtc';
import { CallVideo } from '../../packages/frontend/components/calls/CallVideo.web';
const a = createCallMedia(),
  b = createCallMedia();
const root = createRoot(document.getElementById('root')!);
let show = true;
let groupLayout = false;
function render() {
  root.render(
    show ? (
      <>
        <CallVideo
          stream={a.state.getSnapshot().remote[0]?.stream ?? new MediaStream()}
          label="remote"
        />
        <CallVideo stream={a.localStream() ?? new MediaStream()} mirror label="local" />
        {!groupLayout ? (
          <CallVideo stream={b.remoteStream() ?? new MediaStream()} label="remote-second" />
        ) : null}
      </>
    ) : null,
  );
}
a.state.subscribe(render);
b.state.subscribe(render);
Object.assign(window, {
  a,
  b,
  plain: async (ticket: any) => {
    const room = new Room();
    await room.connect(ticket.url, ticket.token);
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    for (const track of stream.getTracks()) await room.localParticipant.publishTrack(track);
    return true;
  },
  group: async (identity: string, ticket: unknown) => {
    groupLayout = true;
    await a.prepare({
      mode: 'video',
      group: true,
      instanceId: identity,
      iceServers: [],
      relayOnly: false,
    });
    await a.joinRoom!(ticket, new Uint8Array(32).fill(identity === 'sender-a' ? 1 : 2));
    render();
  },
  receive: async (id: string) => {
    await a.setReceiveKey!(id, new Uint8Array(32).fill(id === 'sender-a' ? 1 : 2));
  },
  run: async () => {
    const plan = { mode: 'video' as const, iceServers: [], relayOnly: false };
    await Promise.all([a.prepare(plan), b.prepare(plan)]);
    const ac: string[] = [],
      bc: string[] = [];
    a.onCandidates((cs) => ac.push(...cs));
    b.onCandidates((cs) => bc.push(...cs));
    const offer = await a.createOffer();
    const answer = await b.acceptOffer(offer);
    await a.acceptAnswer(answer);
    const timer = setInterval(() => {
      void b.addCandidates(ac.splice(0));
      void a.addCandidates(bc.splice(0));
    }, 40);
    Object.assign(window, { stopIce: () => clearInterval(timer) });
    setTimeout(() => clearInterval(timer), 5000);
    render();
  },
  toggle: () => {
    show = !show;
    render();
  },
});
