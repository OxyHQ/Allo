import { expect, it } from 'bun:test';
import { fakeServer, makeClient, stopAll, waitJoined, waitForText, texts } from './e2eHelpers';

it('adds and removes an account without a device through confirmed MLS epoch changes', async () => {
  const server = fakeServer();
  const owner = await makeClient(server, 'team-owner', 'owner');
  try {
    const group = await owner.client.conversations.createGroup([]);
    await owner.client.conversations.addMember(group.id, 'not-enrolled');
    const added = await owner.client.conversations.confirmMembers(group.id, [
      'team-owner',
      'not-enrolled',
    ]);
    expect(added.epoch).toBeGreaterThan(0);
    await owner.client.conversations.removeMember(group.id, 'not-enrolled');
    const removed = await owner.client.conversations.confirmMembers(group.id, ['team-owner']);
    expect(removed.epoch).toBeGreaterThan(added.epoch);
    const later = await makeClient(server, 'not-enrolled', 'later');
    await later.client.sync.now();
    expect(later.client.conversations.get(group.id)?.joined).not.toBe(true);
    await stopAll(later);
  } finally {
    await stopAll(owner);
  }
});

it('reuses the exact group after a lost create reply, and survives client restart', async () => {
  const server = fakeServer();
  let drop = false;
  const transport = {
    socketFactory: server.socketFactory,
    fetch: (async (url, init) => {
      const response = await server.fetch(url, init);
      if (drop && String(url).endsWith('/v1/conversations') && init?.method === 'POST') {
        drop = false;
        throw new Error('reply lost after server commit');
      }
      return response;
    }) as typeof fetch,
  };
  let owner = await makeClient(server, 'team-owner', 'owner', 'web', undefined, true, {
    transport,
  });
  const bob = await makeClient(server, 'team-bob', 'bob');
  try {
    drop = true;
    await expect(
      owner.client.conversations.createGroupOnce('one-case', ['team-bob']),
    ).rejects.toThrow();
    const persisted = { storage: owner.storage, secrets: owner.secrets };
    await stopAll(owner);
    owner = await makeClient(server, 'team-owner', 'owner', 'web', persisted, true, { transport });
    const recovered = await owner.client.conversations.createGroupOnce('one-case', ['team-bob']);
    const again = await owner.client.conversations.createGroupOnce('one-case', ['team-bob']);
    expect(again.id).toBe(recovered.id);
    expect(owner.client.conversations.list()).toHaveLength(1);
    await waitJoined(bob, recovered.id);
    await owner.client.messages.send(recovered.id, 'before removal');
    await waitForText(bob, recovered.id, 'before removal');
    await owner.client.conversations.removeMember(recovered.id, 'team-bob');
    await owner.client.conversations.confirmMembers(recovered.id, ['team-owner']);
    await owner.client.messages.send(recovered.id, 'after removal');
    await owner.client.sync.flush();
    await bob.client.sync.now();
    expect(texts(bob.client.messages.timeline(recovered.id))).toContain('before removal');
    expect(texts(bob.client.messages.timeline(recovered.id))).not.toContain('after removal');
    await expect(
      owner.client.conversations.createGroupOnce('one-case', ['different-person']),
    ).rejects.toThrow('different members');
  } finally {
    await stopAll(owner, bob);
  }
});
