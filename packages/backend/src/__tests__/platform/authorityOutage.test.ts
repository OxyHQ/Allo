import { expect, it } from 'bun:test';
import express from 'express';
import request from 'supertest';
import { createErrorHandler } from '../../app';
import { createMessagingAuth, createV1OxyAuth } from '../../middleware/messagingAuth';
import { verifiedBearer } from '../../services/platform/messagingPolicy';
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

it('answers the ordinary-account gate in the /v1 envelope: 401 session, 503 outage, then recovers', async () => {
  safetyFixture.reset();
  const bearer = registerFixtureActor('alice');
  const app = express();
  let entered = 0;
  app.get(
    '/archive',
    createV1OxyAuth(fixtureOxy, { forbiddenMessage: 'Not for this account.' }),
    (_req, res) => {
      entered += 1;
      res.sendStatus(204);
    },
  );
  app.use(createErrorHandler());
  try {
    const anonymous = await request(app).get('/archive');
    expect(anonymous.status).toBe(401);
    expect(anonymous.body.error.code).toBe('unauthorized');
    safetyFixture.unavailable = true;
    const failure = await request(app).get('/archive').set('Authorization', `Bearer ${bearer}`);
    expect(failure.status).toBe(503);
    expect(failure.body.error.code).toBe('unavailable');
    expect(entered).toBe(0);
    safetyFixture.unavailable = false;
    const retry = await request(app).get('/archive').set('Authorization', `Bearer ${bearer}`);
    expect(retry.status).toBe(204);
    expect(entered).toBe(1);
  } finally {
    safetyFixture.reset();
  }
});

it('forwards the bearer Oxy auth verified, never one read back from the header', async () => {
  safetyFixture.reset();
  const bearer = registerFixtureActor('alice');
  const app = express();
  app.get('/whoami', createMessagingAuth(fixtureOxy), (req, res) => {
    req.headers.authorization = 'Bearer swapped-after-auth';
    res.json({ bearer: verifiedBearer(req) });
  });
  app.get('/unauthenticated', (req, res) => {
    res.json({ bearer: verifiedBearer(req) });
  });
  app.use(createErrorHandler());
  const verified = await request(app).get('/whoami').set('Authorization', `Bearer ${bearer}`);
  expect(verified.status).toBe(200);
  expect(verified.body.bearer).toBe(bearer);
  const bypassed = await request(app)
    .get('/unauthenticated')
    .set('Authorization', `Bearer ${bearer}`);
  expect(bypassed.status).toBe(401);
});
