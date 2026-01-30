import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';

/**
 * Request Logging Middleware
 *
 * WhatsApp/Telegram-level: Structured logging for monitoring and debugging
 * Tracks request duration, status codes, errors
 */

interface RequestLog {
  method: string;
  url: string;
  status: number;
  duration: number;
  ip: string;
  userAgent: string;
  userId?: string;
  error?: string;
}

/**
 * Log incoming HTTP requests with response time
 */
export const requestLogger = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const startTime = Date.now();

  // Log request
  logger.info(`${req.method} ${req.path}`, {
    method: req.method,
    url: req.originalUrl,
    ip: req.ip,
    userAgent: req.get('user-agent'),
    userId: (req as any).user?.id,
  });

  // Capture response
  const originalSend = res.send;
  res.send = function (data: any) {
    const duration = Date.now() - startTime;

    const logData: RequestLog = {
      method: req.method,
      url: req.originalUrl,
      status: res.statusCode,
      duration,
      ip: req.ip || '',
      userAgent: req.get('user-agent') || '',
      userId: (req as any).user?.id,
    };

    // Log based on status code
    if (res.statusCode >= 500) {
      logger.error(`${req.method} ${req.path} - ${res.statusCode} (${duration}ms)`, logData);
    } else if (res.statusCode >= 400) {
      logger.warn(`${req.method} ${req.path} - ${res.statusCode} (${duration}ms)`, logData);
    } else {
      logger.info(`${req.method} ${req.path} - ${res.statusCode} (${duration}ms)`, logData);
    }

    // Log slow requests (> 1s)
    if (duration > 1000) {
      logger.warn(`Slow request detected: ${req.method} ${req.path} took ${duration}ms`, logData);
    }

    return originalSend.call(this, data);
  };

  next();
};

/**
 * Log database query performance
 * Use this with Mongoose middleware
 *
 * @example
 * // In database.ts or model file:
 * mongoose.set('debug', (collectionName, method, query, doc) => {
 *   logDatabaseQuery(collectionName, method, query);
 * });
 */
export function logDatabaseQuery(
  collection: string,
  method: string,
  query: any,
  duration?: number
) {
  const logData = {
    collection,
    method,
    query: JSON.stringify(query).substring(0, 200), // Limit query length
    duration,
  };

  if (duration && duration > 100) {
    logger.warn(`Slow database query: ${collection}.${method} took ${duration}ms`, logData);
  } else if (process.env.NODE_ENV === 'development') {
    logger.debug(`DB Query: ${collection}.${method}`, logData);
  }
}

/**
 * Log API errors with full context
 */
export function logApiError(
  req: Request,
  error: Error,
  additionalContext?: Record<string, any>
) {
  logger.error('API Error', {
    error: {
      message: error.message,
      stack: error.stack,
      name: error.name,
    },
    request: {
      method: req.method,
      url: req.originalUrl,
      body: sanitizeBody(req.body),
      params: req.params,
      query: req.query,
      headers: sanitizeHeaders(req.headers),
      ip: req.ip,
      userAgent: req.get('user-agent'),
    },
    user: (req as any).user?.id,
    ...additionalContext,
  });
}

/**
 * Sanitize request body (remove sensitive fields)
 */
function sanitizeBody(body: any): any {
  if (!body) return {};

  const sanitized = { ...body };
  const sensitiveFields = ['password', 'token', 'apiKey', 'secret', 'authorization'];

  sensitiveFields.forEach(field => {
    if (sanitized[field]) {
      sanitized[field] = '[REDACTED]';
    }
  });

  return sanitized;
}

/**
 * Sanitize request headers (remove sensitive values)
 */
function sanitizeHeaders(headers: any): any {
  const sanitized = { ...headers };

  if (sanitized.authorization) {
    sanitized.authorization = '[REDACTED]';
  }
  if (sanitized.cookie) {
    sanitized.cookie = '[REDACTED]';
  }

  return sanitized;
}
