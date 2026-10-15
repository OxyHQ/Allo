/** Reviewed messaging routes preserve the original Oxy bearer. Opaque archives
 * cannot prove their conversation coverage and retain the ordinary-account gate. */
import type { RequestHandler } from 'express';
import type { OxyServer } from '@oxy.so/core/server';
import { AlloHttpError } from '../utils/httpErrors';

export function createMessagingAuth(oxy: OxyServer): RequestHandler {
  return (req, res, next) => {
    const auth = oxy.middleware.auth({
      supervisedAction: 'messaging',
      onError: (error) =>
        next(
          new AlloHttpError(
            error.status === 401
              ? 'unauthorized'
              : error.status === 403
                ? 'forbidden'
                : 'unavailable',
            error.status === 401
              ? 'An Oxy session is required'
              : error.status === 403
                ? 'Messaging is not available for this account.'
                : 'Messaging authorization is temporarily unavailable.',
          ),
        ),
    });
    return auth(req, res, next);
  };
}
