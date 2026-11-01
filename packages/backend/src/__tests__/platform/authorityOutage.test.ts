import { expect, it } from 'bun:test';
import express from 'express';
import request from 'supertest';
import { createErrorHandler } from '../../app';
import { createMessagingAuth } from '../../middleware/messagingAuth';
import { fixtureOxy, registerFixtureActor, safetyFixture } from './oxySafetyFixture';

it('denies a request with 503 during an authority outage and accepts a retry after recovery', async () => {
  safetyFixture.reset();
  const bearer = registerFixtureActor('alice');
  const app = express();
  let entered = 0;
  app.get('/protected', fixtureOxy.middleware.auth(), (_req, res) => {
    entered += 1;
    res.sendStatus(204);
  });
  try {
    safetyFixture.unavailable = true;
    const failure = await request(app).get('/protected').set('Authorization', `Bearer ${bearer}`);
    expect(failure.status).toBe(503);
    expect(JSON.stringify(failure.body)).not.toContain(bearer);
    expect(entered).toBe(0);
    safetyFixture.unavailable = false;
    const retry = await request(app).get('/protected').set('Authorization', `Bearer ${bearer}`);
    expect(retry.status).toBe(204);
    expect(entered).toBe(1);
  } finally {
    safetyFixture.reset();
  }
});

it('maps an unavailable messaging authority to 503 and recovers on retry', async () => {
  safetyFixture.reset();
  const bearer = registerFixtureActor('alice');
  const app = express();
  let entered = 0;
  app.get('/protected', createMessagingAuth(fixtureOxy), (_req, res) => {
    entered += 1;
    res.sendStatus(204);
  });
  app.use(createErrorHandler());
  try {
    safetyFixture.unavailable = true;
    const failure = await request(app).get('/protected').set('Authorization', `Bearer ${bearer}`);
    expect(failure.status).toBe(503);
    expect(failure.body.error.code).toBe('unavailable');
    expect(JSON.stringify(failure.body)).not.toContain(bearer);
    expect(entered).toBe(0);
    safetyFixture.unavailable = false;
    const retry = await request(app).get('/protected').set('Authorization', `Bearer ${bearer}`);
    expect(retry.status).toBe(204);
    expect(entered).toBe(1);
  } finally {
    safetyFixture.reset();
  }
});
