import {
  ConnectionState,
  Room,
  RoomEvent,
  type RemoteParticipant,
  type RemoteTrackPublication,
} from 'livekit-client';
import type { CallMediaPlan, CallRoomTicket } from '@allo/core';
import { createEncryption } from './encryption';
/** No track is subscribed before its authenticated sender key is installed. */
export function createGroupMedia(
  plan: CallMediaPlan,
  update: (remote: Array<{ id: string; stream: MediaStream }>) => void,
  connection: (status: 'connected' | 'disconnected' | 'failed') => void,
) {
  const encryption = createEncryption();
  const room = new Room({ ...encryption.options, adaptiveStream: false, dynacast: false });
  const allowed = new Set<string>();
  const streams = new Map<string, MediaStream>();
  let closed = false;
  const publish = () => update([...streams].map(([id, stream]) => ({ id, stream })));
  const subscribe = (publication: RemoteTrackPublication, participant: RemoteParticipant) => {
    publication.setSubscribed(
      !closed && allowed.has(participant.identity) && publication.isEncrypted,
    );
  };
  room.on(RoomEvent.TrackPublished, subscribe);
  room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
    if (closed || !allowed.has(participant.identity) || !publication.isEncrypted) {
      publication.setSubscribed(false);
      return;
    }
    let stream = streams.get(participant.identity);
    if (!stream) {
      stream = new MediaStream();
      streams.set(participant.identity, stream);
    }
    stream.addTrack(track.mediaStreamTrack);
    publish();
  });
  room.on(RoomEvent.TrackUnsubscribed, (track, _publication, participant) => {
    streams.get(participant.identity)?.removeTrack(track.mediaStreamTrack);
    publish();
  });
  room.on(RoomEvent.ParticipantDisconnected, (participant) => {
    streams.delete(participant.identity);
    publish();
  });
  room.on(RoomEvent.Disconnected, () => {
    streams.clear();
    publish();
    if (!closed) connection('failed');
  });
  room.on(RoomEvent.ConnectionStateChanged, (state) => {
    if (
      !closed &&
      (state === ConnectionState.Reconnecting || state === ConnectionState.SignalReconnecting)
    )
      connection('disconnected');
    if (!closed && state === ConnectionState.Connected) connection('connected');
  });
  return {
    async setKey(id: string, bytes: Uint8Array) {
      if (closed) return;
      await encryption.setKey(id, bytes);
      if (closed) return;
      allowed.add(id);
      const participant = room.remoteParticipants.get(id);
      if (participant)
        for (const publication of participant.trackPublications.values())
          subscribe(publication, participant);
    },
    async join(ticket: CallRoomTicket, local: MediaStream) {
      await room.setE2EEEnabled(true);
      if (closed) throw new Error('call closed');
      await room.connect(ticket.url, ticket.token, {
        autoSubscribe: false,
        rtcConfig: {
          iceServers: plan.iceServers,
          iceTransportPolicy: plan.relayOnly ? 'relay' : 'all',
        },
      });
      if (closed) {
        await room.disconnect();
        throw new Error('call closed');
      }
      if (!room.isE2EEEnabled) throw new Error('group media encryption is unavailable');
      for (const participant of room.remoteParticipants.values())
        for (const publication of participant.trackPublications.values())
          subscribe(publication, participant);
      for (const track of local.getTracks()) {
        if (closed) throw new Error('call closed');
        await room.localParticipant.publishTrack(track, { simulcast: false });
      }
    },
    async close() {
      closed = true;
      streams.clear();
      publish();
      await room.disconnect(false);
      encryption.dispose();
    },
  };
}
