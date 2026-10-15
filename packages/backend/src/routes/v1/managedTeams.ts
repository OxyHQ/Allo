import { getDb } from '../../db';
import { lockConversation } from '../../db/platform/conversationRepository';
import { findTeamByHash } from '../../db/platform/managedTeamRepository';
import { Router, type RequestHandler } from 'express';
import { TEAM_CAPABILITY_HEADER, teamOperationRequestSchema } from '@oxy.so/allo-contracts';
import { HOMIIO_TEAM_OPERATION_HEADER } from '@oxy.so/homiio-contracts';
import { callerOf } from './conversations';
import { asyncRoute } from './asyncRoute';
import { parseBody } from './validate';
import {
  authorizeTeamOperation,
  prepareTeam,
  finishTeam,
} from '../../services/platform/managedTeamService';
import { teamCapabilityHash, teamSnapshot } from '../../db/platform/managedTeamRepository';
/** Header capability is a read grant only, never an Oxy identity or an MLS signer. */
export function createTeamAccessRoutes(): Router {
  const router = Router();
  router.post(
    '/snapshot',
    asyncRoute(async (req, res) => {
      const capability = req.get(TEAM_CAPABILITY_HEADER) ?? '';
      const snapshot = /^[A-Za-z0-9_-]{43}$/.test(capability)
        ? await getDb().transaction(async (tx) => {
            const hash = teamCapabilityHash(capability);
            const team = await findTeamByHash(hash, tx);
            if (!team) return null;
            await lockConversation(team.id, tx);
            return teamSnapshot(hash, tx);
          })
        : null;
      if (!snapshot) {
        res.status(404).json({ error: { code: 'not_found', message: 'Team chat not found' } });
        return;
      }
      res.json(snapshot);
    }),
  );
  return router;
}
export function createManagedTeamRoutes(deps: { instanceAuth: RequestHandler }): Router {
  const router = Router();
  router.use('/teams', deps.instanceAuth);
  for (const [path, action] of [
    ['prepare', prepareTeam],
    ['finish', finishTeam],
  ] as const) {
    router.post(
      `/teams/${path}`,
      asyncRoute(async (req, res) => {
        const body = parseBody(teamOperationRequestSchema, req);
        const caller = callerOf(req);
        const auth = await authorizeTeamOperation(
          caller,
          body.operationId,
          req.get(HOMIIO_TEAM_OPERATION_HEADER) ?? '',
          req.get(TEAM_CAPABILITY_HEADER) ?? '',
        );
        res.json(await action(caller, auth));
      }),
    );
  }
  return router;
}
