import { afterEach, expect, it } from 'bun:test';
import express from 'express';
import request from 'supertest';

import { createDirectoryRoutes } from '../../routes/directory';
import { createOxyDirectoryService } from '../../services/oxy/OxyDirectoryService';
import { fixtureOxy, safetyFixture } from '../platform/oxySafetyFixture';

/**
 * The by-ids lookup through the REAL `OxyServer` (`users.lookupMany` over the
 * service lane) against the external Oxy fixture: an outage is a 502 and is
 * not remembered, so the next request asks Oxy again and gets the answer.
 */

const KNOWN = '507f1f77bcf86cd799439011';
const UNKNOWN = '507f191e810c19729de860ea';

function directoryApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(
    '/api/directory',
    createDirectoryRoutes({ service: createOxyDirectoryService(fixtureOxy) }),
  );
  return app;
}

afterEach(() => safetyFixture.reset());

it('answers an Oxy outage with 502, never as "no such account", and asks again next time', async () => {
  safetyFixture.reset();
  safetyFixture.users.add(KNOWN);
  const app = directoryApp();
  const ask = () =>
    request(app)
      .post('/api/directory/users/by-ids')
      .send({ ids: [KNOWN, UNKNOWN] });

  // Oxy answers: the known account is found and the unknown one is absent.
  const before = await ask();
  expect(before.status).toBe(200);
  expect(before.body.data.users.map((user: { id: string }) => user.id)).toEqual([KNOWN]);

  // Oxy is down: the lookup fails as a whole instead of answering an empty list.
  safetyFixture.unavailable = true;
  const outage = await ask();
  expect(outage.status).toBe(502);
  expect(JSON.stringify(outage.body)).not.toContain(KNOWN);

  // Oxy is back: the next request asks again; nothing remembered the outage.
  safetyFixture.unavailable = false;
  const after = await ask();
  expect(after.status).toBe(200);
  expect(after.body.data.users.map((user: { id: string }) => user.id)).toEqual([KNOWN]);
});
