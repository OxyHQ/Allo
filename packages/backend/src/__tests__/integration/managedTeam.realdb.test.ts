import { afterAll, beforeAll, expect, it } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { TeamOperation } from '@homiio/sdk';
import { AlloTeamAccessClient } from '@oxy.so/allo-sdk';
import { managedTeams, conversations } from '../../db/schema';
import { Harness, stopAll, texts, waitForText, waitJoined, waitFor } from './harness';

const h = new Harness();
const operations = new Map<string, { value: TeamOperation; capability: string }>();
const realFetch = globalThis.fetch;
let sourceOffline = false;
beforeAll(async () => {
  await h.boot();
  globalThis.fetch = (async (url, init) => {
    if (String(url) === 'https://api.homiio.com/api/v1/team-chat/operations/read') {
      if (sourceOffline) throw new Error('source disconnected');
      const id = JSON.parse(String(init?.body)).operationId;
      const entry = operations.get(id);
      if (!entry || new Headers(init?.headers).get('x-homiio-team-operation') !== entry.capability)
        return Response.json(
          { error: { code: 'not_found', message: 'Not found' } },
          { status: 404 },
        );
      return Response.json(entry.value);
    }
    if (String(url).startsWith('https://api.allo.you/'))
      return realFetch(String(url).replace('https://api.allo.you', h.baseUrl), init);
    return realFetch(url, init);
  }) as typeof fetch;
}, 180_000);
afterAll(async () => {
  globalThis.fetch = realFetch;
  await h.shutdown();
});
function operation(
  owner: string,
  reference: string,
  targets: string[],
  action: 'open' | 'add' | 'remove' = 'open',
  caseId = 'case-ref',
) {
  const id = h.unique('operation');
  const capability = randomBytes(32).toString('base64url');
  const value: TeamOperation = {
    id,
    caseId,
    ownerAccountId: owner,
    action,
    targetAccountIds: [...targets].sort(),
    teamReferenceHash: createHash('sha256').update(reference).digest('hex'),
    finalized: false,
  };
  operations.set(id, { value, capability });
  return {
    value,
    access: { operationId: id, operationCapability: capability, teamReference: reference },
  };
}

it('freezes through source failure and lost finalization, resumes same operation, removes all future delivery without deleting history', async () => {
  const ownerId = h.account('owner');
  const memberId = h.account('member');
  const owner = await h.makeClient(ownerId, 'owner', 'web');
  const member = await h.makeClient(memberId, 'member', 'ios');
  const reference = randomBytes(32).toString('base64url');
  const create = operation(ownerId, reference, [ownerId, memberId]);
  try {
    const group = await owner.client.conversations.createGroupOnce(
      create.value.id,
      [memberId],
      create.access,
    );
    const snapshot = await new AlloTeamAccessClient().snapshot(reference);
    expect(snapshot?.frozen).toBe(true);
    await waitJoined(member, group.id);
    await owner.client.messages.send(group.id, 'paused-before-finalization');
    await expect(owner.client.conversations.finishTeam(create.access)).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(texts(member.client.messages.timeline(group.id))).not.toContain(
      'paused-before-finalization',
    );
    create.value.finalized = true;
    sourceOffline = true;
    await expect(owner.client.conversations.finishTeam(create.access)).rejects.toThrow();
    expect((await new AlloTeamAccessClient().snapshot(reference))?.frozen).toBe(true);
    sourceOffline = false;
    await owner.client.conversations.finishTeam(create.access);
    await owner.client.conversations.finishTeam(create.access); // lost response/replay
    await waitForText(member, group.id, 'paused-before-finalization');
    const remove = operation(ownerId, reference, [ownerId], 'remove');
    await owner.client.conversations.prepareTeam(remove.access);
    await owner.client.messages.send(group.id, 'future-members-only'); // pending app must not starve the Remove commit
    await owner.client.conversations.removeMember(group.id, memberId);
    const confirmed = await owner.client.conversations.confirmMembers(group.id, [ownerId]);
    expect(confirmed.epoch).toBeGreaterThan(snapshot!.epoch);
    expect((await new AlloTeamAccessClient().snapshot(reference))?.frozen).toBe(true);
    await expect(owner.client.conversations.finishTeam(remove.access)).rejects.toThrow();
    const resumed = await owner.client.conversations.prepareTeam(remove.access);
    expect(resumed?.operationId).toBe(remove.value.id);
    remove.value.finalized = true;
    await owner.client.conversations.finishTeam(remove.access);
    await waitFor(() =>
      owner.client.messages
        .timeline(group.id)
        .some(
          (message) =>
            message.content.kind === 'text' &&
            message.content.body === 'future-members-only' &&
            message.sendState === 'accepted',
        ),
    );
    await member.client.sync.now();
    expect(texts(member.client.messages.timeline(group.id))).toContain(
      'paused-before-finalization',
    );
    expect(texts(member.client.messages.timeline(group.id))).not.toContain('future-members-only');
    await expect(owner.client.conversations.prepareTeam(create.access)).rejects.toThrow();
    const rows = await h.db.select().from(managedTeams).where(eq(managedTeams.id, group.id));
    expect(rows[0].readCapabilityHash).not.toBe(reference);
    expect(JSON.stringify(rows)).not.toContain('paused-before-finalization');
  } finally {
    sourceOffline = false;
    await stopAll(owner, member);
  }
}, 60_000);

it('rejects another owner, wrong capabilities and off-source additions; a leafless account can be removed with an epoch change', async () => {
  const ownerId = h.account('owner');
  const strangerId = h.account('stranger');
  const leafless = h.account('leafless');
  const owner = await h.makeClient(ownerId, 'owner', 'web');
  const stranger = await h.makeClient(strangerId, 'stranger', 'web');
  const reference = randomBytes(32).toString('base64url');
  const create = operation(ownerId, reference, [ownerId, leafless], 'open', h.unique('case'));
  try {
    await expect(
      stranger.client.conversations.createGroupOnce(
        create.value.id,
        [ownerId, leafless],
        create.access,
      ),
    ).rejects.toThrow();
    const group = await owner.client.conversations.createGroupOnce(
      create.value.id,
      [leafless],
      create.access,
    );
    expect(
      await new AlloTeamAccessClient().snapshot(randomBytes(32).toString('base64url')),
    ).toBeNull();
    await expect(
      owner.client.conversations.prepareTeam({ ...create.access, operationCapability: 'wrong' }),
    ).rejects.toThrow();
    create.value.finalized = true;
    await owner.client.conversations.finishTeam(create.access);
    const remove = operation(ownerId, reference, [ownerId], 'remove', create.value.caseId);
    await owner.client.conversations.prepareTeam(remove.access);
    await owner.client.conversations.removeMember(group.id, leafless);
    const confirmed = await owner.client.conversations.confirmMembers(group.id, [ownerId]);
    expect(confirmed.epoch).toBeGreaterThan(0);
    remove.value.finalized = true;
    await owner.client.conversations.finishTeam(remove.access);
    await owner.client.conversations.addMember(group.id, strangerId);
    await owner.client.sync.flush();
    expect((await new AlloTeamAccessClient().snapshot(reference))?.memberAccountIds).toEqual([
      ownerId,
    ]);
    const again = await owner.client.conversations.createGroupOnce(
      create.value.id,
      [leafless],
      create.access,
    );
    expect(again.id).toBe(group.id);
    expect(
      (await h.db.select().from(conversations).where(eq(conversations.id, group.id))).length,
    ).toBe(1);
  } finally {
    await stopAll(owner, stranger);
  }
}, 60_000);

it('lost create and MLS replies retry one group and one accepted membership effect', async () => {
  const ownerId = h.account('owner');
  const memberId = h.account('member');
  let loseCreate = true;
  let loseCommit = false;
  const owner = await h.makeClient(ownerId, 'owner', 'web', {
    transport: {
      fetch: (async (url, init) => {
        const response = await globalThis.fetch(url, init);
        if (
          loseCreate &&
          String(url).endsWith('/v1/conversations') &&
          init?.method === 'POST' &&
          response.ok
        ) {
          loseCreate = false;
          throw new Error('create reply lost');
        }
        if (
          loseCommit &&
          String(url).endsWith('/events') &&
          init?.method === 'POST' &&
          response.ok
        ) {
          loseCommit = false;
          throw new Error('MLS reply lost');
        }
        return response;
      }) as typeof fetch,
    },
  });
  const member = await h.makeClient(memberId, 'member', 'ios');
  const reference = randomBytes(32).toString('base64url');
  const create = operation(ownerId, reference, [ownerId], 'open', h.unique('case'));
  try {
    await expect(
      owner.client.conversations.createGroupOnce(create.value.id, [], create.access),
    ).rejects.toThrow();
    const group = await owner.client.conversations.createGroupOnce(
      create.value.id,
      [],
      create.access,
    );
    create.value.finalized = true;
    await owner.client.conversations.finishTeam(create.access);
    const add = operation(ownerId, reference, [ownerId, memberId], 'add', create.value.caseId);
    await owner.client.conversations.prepareTeam(add.access);
    loseCommit = true;
    await owner.client.conversations.addMember(group.id, memberId);
    const added = await owner.client.conversations.confirmMembers(group.id, [ownerId, memberId]);
    add.value.finalized = true;
    await owner.client.conversations.finishTeam(add.access);
    await waitJoined(member, group.id);
    await owner.client.sync.flush();
    const afterRetry = await new AlloTeamAccessClient().snapshot(reference);
    expect(afterRetry?.epoch).toBe(added.epoch);
    await owner.client.messages.send(group.id, 'after recovered add');
    await waitForText(member, group.id, 'after recovered add');
    const remove = operation(ownerId, reference, [ownerId], 'remove', create.value.caseId);
    await owner.client.conversations.prepareTeam(remove.access);
    loseCommit = true;
    await owner.client.conversations.removeMember(group.id, memberId);
    const removed = await owner.client.conversations.confirmMembers(group.id, [ownerId]);
    remove.value.finalized = true;
    await owner.client.conversations.finishTeam(remove.access);
    await owner.client.sync.flush();
    expect((await new AlloTeamAccessClient().snapshot(reference))?.epoch).toBe(removed.epoch);
    expect(
      (
        await h.db
          .select()
          .from(managedTeams)
          .where(eq(managedTeams.readCapabilityHash, create.value.teamReferenceHash))
      ).length,
    ).toBe(1);
  } finally {
    await stopAll(owner, member);
  }
}, 60_000);
