/**
 * Oxy authentication for `/v1`, built ONCE per mount and answering in the
 * contract's `{ error: { code, message } }` envelope.
 *
 * `oxy.middleware.auth()` returns whatever its `onError` returns instead of
 * answering the request itself, so each refusal comes back here as an
 * `AlloHttpError` and goes to the one error handler. The outcome mapping is the
 * SDK's: 401 means the session is gone, 403 is a definitive "no", and anything
 * else — an authority outage — is 503 `unavailable`, never a "no".
 *
 * Reviewed messaging routes (`createMessagingAuth`) name the supervised action
 * they are; opaque archives cannot prove their conversation coverage, so they
 * keep the ordinary-account gate (no supervised action).
 */
import type { RequestHandler } from 'express';
import type { OxyServer } from '@oxy.so/core/server';
import { AlloHttpError, forbidden, unauthorized } from '../utils/httpErrors';

export interface V1OxyAuthOptions {
  /** The reviewed supervised action this mount is; absent for the ordinary-account gate. */
  supervisedAction?: 'messaging';
  /** What a definitive refusal (403) says. */
  forbiddenMessage: string;
}

function refusal(status: number | undefined, forbiddenMessage: string): AlloHttpError {
  if (status === 401) return unauthorized('An Oxy session is required');
  if (status === 403) return forbidden(forbiddenMessage);
  return new AlloHttpError('unavailable', 'Oxy authorization is temporarily unavailable.');
}

export function createV1OxyAuth(oxy: OxyServer, options: V1OxyAuthOptions): RequestHandler {
  const auth = oxy.middleware.auth({
    ...(options.supervisedAction === undefined
      ? {}
      : { supervisedAction: options.supervisedAction }),
    onError: (error) => refusal(error.status, options.forbiddenMessage),
  });
  return (req, res, next) => {
    auth(req, res, next).then((outcome) => {
      if (outcome instanceof AlloHttpError) next(outcome);
    }, next);
  };
}

/** The `/v1` session gate: the reviewed supervised messaging action. */
export function createMessagingAuth(oxy: OxyServer): RequestHandler {
  return createV1OxyAuth(oxy, {
    supervisedAction: 'messaging',
    forbiddenMessage: 'Messaging is not available for this account.',
  });
}
