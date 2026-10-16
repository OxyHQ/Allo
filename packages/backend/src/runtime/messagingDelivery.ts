/** Coalesces eager notifications into bounded live authority checks. Socket
 * handshakes establish identity; they never grant a reusable delivery lease. */
import { SERVER_SENDER_ID, type ServerToClientEvents } from '@allo/shared-types';
import { MESSAGE_ACCESS_MAX_RESOURCES } from '@oxy.so/contracts';
import { oxy } from '../oxy';
import { liveMessagingRecipients } from '../services/platform/recipientAuthority';
import { notificationProvenance } from '../db/platform/notificationPolicyRepository';
import {
  deliveryDecisions,
  uniqueParticipants,
  type DeliveryResource,
} from '../services/platform/messagingPolicy';
import { logger } from '../utils/logger';

type EventName = keyof ServerToClientEvents;
interface Recipient {
  id: string;
  handshake: { auth: Record<string, unknown> };
  data: { instance?: { id: string; accountId: string } };
  emit: (event: EventName, payload: never) => unknown;
  disconnect: (close?: boolean) => unknown;
}
interface Notification {
  event: EventName;
  payload: unknown;
  rooms: string[];
}
const stringField = (payload: unknown, key: string): string | null =>
  typeof payload === 'object' && payload !== null && typeof Reflect.get(payload, key) === 'string'
    ? Reflect.get(payload, key)
    : null;

export class MessagingDelivery {
  private pending: Notification[] = [];
  private scheduled = false;
  constructor(private readonly recipients: (rooms: string[]) => Promise<Recipient[]>) {}
  enqueue(event: EventName, payload: unknown, rooms: string[]) {
    this.pending.push({ event, payload, rooms });
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      void this.drain();
    });
  }
  private async drain() {
    try {
      while (this.pending.length)
        await this.deliver(this.pending.splice(0, MESSAGE_ACCESS_MAX_RESOURCES));
    } catch {
      // No fallback room emit. The durable sync stream remains authoritative.
      logger.warn('Live messaging delivery authorization unavailable');
    } finally {
      this.scheduled = false;
      if (this.pending.length) {
        this.scheduled = true;
        queueMicrotask(() => {
          void this.drain();
        });
      }
    }
  }
  private async deliver(batch: Notification[]) {
    const allSockets = await this.recipients([...new Set(batch.flatMap((item) => item.rooms))]);
    try {
      const fresh = await liveMessagingRecipients(
        allSockets.flatMap((socket) => {
          const instance = socket.data.instance;
          const accessToken = socket.handshake.auth.token;
          return instance && typeof accessToken === 'string'
            ? [
                {
                  requestId: socket.id,
                  accessToken,
                  accountId: instance.accountId,
                  instanceId: instance.id,
                },
              ]
            : [];
        }),
      );
      const valid = allSockets.filter((socket) => {
        if (fresh.has(socket.id)) return true;
        socket.disconnect(true);
        return false;
      });
      const provenance = await notificationProvenance({
        conversationIds: uniqueParticipants(
          batch.flatMap((item) => {
            const id = stringField(item.payload, 'conversationId');
            return id ? [id] : [];
          }),
        ),
        statusIds: uniqueParticipants(
          batch.flatMap((item) => {
            const id = stringField(item.payload, 'statusId');
            return id ? [id] : [];
          }),
        ),
        callIds: uniqueParticipants(
          batch.flatMap((item) => {
            const id = stringField(item.payload, 'callId');
            return id ? [id] : [];
          }),
        ),
      });
      const dispatches: {
        socket: Recipient;
        notification: Notification;
        resource: DeliveryResource;
      }[] = [];
      for (const [index, notification] of batch.entries())
        for (const socket of valid) {
          const instance = socket.data.instance!;
          if (
            !notification.rooms.includes(`instance:${instance.id}`) &&
            !notification.rooms.includes(`account:${instance.accountId}`)
          )
            continue;
          if (
            fresh.get(socket.id)?.status !== 'active' &&
            notification.event !== 'instance.approved'
          )
            continue;
          const callId = stringField(notification.payload, 'callId');
          const call = provenance.calls.find((row) => row.id === callId);
          const conversationId =
            call?.conversationId ?? stringField(notification.payload, 'conversationId');
          const statusId = stringField(notification.payload, 'statusId');
          const status = provenance.statuses.find((row) => row.id === statusId);
          const conversation = provenance.conversationRows.find((row) => row.id === conversationId);
          const latest = provenance.latestEvents.find(
            (row) => row.conversationId === conversationId,
          );
          // No trusted association means no cross-account notification.
          if ((callId && !call) || (statusId && !status) || (conversationId && !conversation))
            continue;
          const author =
            call?.initiatorAccountId ??
            status?.authorAccountId ??
            latest?.senderAccountId ??
            conversation?.createdByAccountId ??
            instance.accountId;
          const senderAccountId = author === SERVER_SENDER_ID ? instance.accountId : author;
          const members = conversationId ? (provenance.members.get(conversationId) ?? []) : [];
          dispatches.push({
            socket,
            notification,
            resource: {
              resourceId: `${index}:${socket.id}`,
              senderAccountId,
              participantAccountIds: uniqueParticipants([
                instance.accountId,
                senderAccountId,
                ...members,
              ]),
            },
          });
        }
      const decisions = await deliveryDecisions(dispatches.map((item) => item.resource));
      for (const { socket, notification, resource } of dispatches) {
        if (!decisions.get(resource.resourceId)?.allowed) continue;
        if (notification.event === 'history.offer') {
          // Opaque archives have no conversation coverage. The canonical
          // ordinary-account gate must still hold at delivery, after queuing.
          const allowed = await new Promise<boolean>((resolve) => {
            void oxy.middleware
              .socket()(socket, (error) => resolve(!error))
              .catch(() => resolve(false));
          });
          if (!allowed) continue;
        }
        socket.emit(notification.event, notification.payload as never);
      }
    } catch (error) {
      for (const socket of allSockets) socket.disconnect(true);
      throw error;
    }
  }
}
