import { describe, expect, it } from 'bun:test';
import { fakeServer, makeClient, stopAll, waitFor, waitForText, waitJoined } from './e2eHelpers';

describe('blocked contact', () => {
  it('marks new DM messages failed without retrying or losing history; shared groups continue', async () => {
    const server = fakeServer();
    const alice = await makeClient(server, 'acc-alice-01', 'Alice');
    const bob = await makeClient(server, 'acc-bob-0001', 'Bob');
    try {
      const dm = await alice.client.conversations.createDirect(bob.accountId);
      const group = await alice.client.conversations.createGroup([bob.accountId]);
      await waitJoined(bob, dm.id);
      await waitJoined(bob, group.id);
      await alice.client.messages.send(dm.id, 'history stays');
      await waitForText(bob, dm.id, 'history stays');
      server.blocks.add(`${alice.accountId}:${bob.accountId}`);
      for (const sender of [alice, bob]) {
        const localKey = await sender.client.messages.send(dm.id, 'blocked new message');
        await waitFor(() =>
          sender.client.messages
            .timeline(dm.id)
            .some((item) => item.localKey === localKey && item.sendState === 'failed'),
        );
      }
      expect(
        bob.client.messages
          .timeline(dm.id)
          .some(
            (item) =>
              !item.isOwn &&
              item.content.kind === 'text' &&
              item.content.body === 'blocked new message',
          ),
      ).toBe(false);
      await alice.client.messages.send(group.id, 'shared group still works');
      await waitForText(bob, group.id, 'shared group still works');
      expect((await waitForText(bob, dm.id, 'history stays')).content).toMatchObject({
        body: 'history stays',
      });
      server.blocks.clear();
      await bob.client.messages.send(dm.id, 'unblocked');
      await waitForText(alice, dm.id, 'unblocked');
    } finally {
      await stopAll(alice, bob);
    }
  });

  it('refuses new direct and group invitations across a block in either direction', async () => {
    const server = fakeServer();
    const alice = await makeClient(server, 'acc-alice-01', 'Alice');
    const bob = await makeClient(server, 'acc-bob-0001', 'Bob');
    try {
      server.blocks.add(`${alice.accountId}:${bob.accountId}`);
      for (const [sender, recipient] of [
        [alice, bob],
        [bob, alice],
      ]) {
        await expect(
          sender.client.conversations.createDirect(recipient.accountId),
        ).rejects.toMatchObject({ status: 403, serverCode: 'forbidden' });
        await expect(
          sender.client.conversations.createGroup([recipient.accountId]),
        ).rejects.toMatchObject({ status: 403, serverCode: 'forbidden' });
      }
      expect(server.conversations.size).toBe(0);
    } finally {
      await stopAll(alice, bob);
    }
  });
});
