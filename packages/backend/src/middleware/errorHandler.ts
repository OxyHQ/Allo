import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';

/**
 * Professional Error Handling Middleware
 *
 * WhatsApp/Telegram-level: Centralized error handling with proper logging
 * Never exposes internal errors to clients
 */

export class AppError extends Error {
  statusCode: number;
  status: string;
  isOperational: boolean;

  constructor(message: string, statusCode: number = 500) {
    super(message);
    this.statusCode = statusCode;
    this.status = `${statusCode}`.startsWith('4') ? 'fail' : 'error';
    this.isOperational = true; // Operational errors vs programming errors

    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Async handler wrapper
 * Eliminates need for try/catch in every route
 *
 * @example
 * router.get('/users', asyncHandler(async (req, res) => {
 *   const users = await User.find();
 *   res.json(users);
 * }));
 */
export const asyncHandler = (fn: Function) => {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};

/**
 * Handle validation errors from express-validator
 */
function handleValidationError(error: any): AppError {
  const message = Object.values(error.errors)
    .map((val: any) => val.message)
    .join('. ');
  return new AppError(`Invalid input: ${message}`, 400);
}

/**
 * Handle Mongoose cast errors (invalid MongoDB ObjectId)
 */
function handleCastError(error: any): AppError {
  const message = `Invalid ${error.path}: ${error.value}`;
  return new AppError(message, 400);
}

/**
 * Handle Mongoose duplicate key errors
 */
function handleDuplicateKeyError(error: any): AppError {
  const field = Object.keys(error.keyValue)[0];
  const value = error.keyValue[field];
  const message = `Duplicate value for field ${field}: ${value}. Please use another value`;
  return new AppError(message, 409);
}

/**
 * Handle JWT errors
 */
function handleJWTError(): AppError {
  return new AppError('Invalid token. Please log in again', 401);
}

function handleJWTExpiredError(): AppError {
  return new AppError('Your token has expired. Please log in again', 401);
}

/**
 * Send error response in development mode
 * Includes stack trace and full error details
 */
function sendErrorDev(error: AppError, req: Request, res: Response) {
  logger.error('ERROR 💥', {
    error: {
      message: error.message,
      stack: error.stack,
      statusCode: error.statusCode,
    },
    request: {
      method: req.method,
      url: req.originalUrl,
      body: req.body,
      params: req.params,
      query: req.query,
      ip: req.ip,
    },
  });

  res.status(error.statusCode).json({
    status: error.status,
    error: error,
    message: error.message,
    stack: error.stack,
  });
}

/**
 * Send error response in production mode
 * Hides internal errors from clients
 */
function sendErrorProd(error: AppError, req: Request, res: Response) {
  // Operational, trusted error: send message to client
  if (error.isOperational) {
    logger.warn('Operational error', {
      message: error.message,
      statusCode: error.statusCode,
      url: req.originalUrl,
      method: req.method,
    });

    res.status(error.statusCode).json({
      status: error.status,
      message: error.message,
    });
  } else {
    // Programming or unknown error: don't leak error details
    logger.error('ERROR 💥 Unexpected error', {
      error: {
        message: error.message,
        stack: error.stack,
      },
      request: {
        method: req.method,
        url: req.originalUrl,
        ip: req.ip,
      },
    });

    res.status(500).json({
      status: 'error',
      message: 'Something went wrong',
    });
  }
}

/**
 * Global error handling middleware
 * Must be the last middleware in the app
 *
 * @example
 * // In server.ts, AFTER all routes:
 * app.use(errorHandler);
 */
export const errorHandler = (
  err: any,
  req: Request,
  res: Response,
  next: NextFunction
) => {
  err.statusCode = err.statusCode || 500;
  err.status = err.status || 'error';

  if (process.env.NODE_ENV === 'development') {
    sendErrorDev(err, req, res);
  } else if (process.env.NODE_ENV === 'production') {
    let error = { ...err };
    error.message = err.message;

    // Handle specific error types
    if (err.name === 'CastError') error = handleCastError(err);
    if (err.code === 11000) error = handleDuplicateKeyError(err);
    if (err.name === 'ValidationError') error = handleValidationError(err);
    if (err.name === 'JsonWebTokenError') error = handleJWTError();
    if (err.name === 'TokenExpiredError') error = handleJWTExpiredError();

    sendErrorProd(error, req, res);
  }
};

/**
 * Handle 404 errors (route not found)
 * Must be placed AFTER all route definitions but BEFORE errorHandler
 *
 * @example
 * // In server.ts:
 * app.use('/api', routes);
 * app.use(notFoundHandler);
 * app.use(errorHandler);
 */
export const notFoundHandler = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const error = new AppError(
    `Cannot ${req.method} ${req.originalUrl}`,
    404
  );
  next(error);
};

/**
 * Validation error helper
 * Use with express-validator
 *
 * @example
 * import { body, validationResult } from 'express-validator';
 *
 * router.post('/users',
 *   body('email').isEmail(),
 *   body('name').notEmpty(),
 *   validateRequest,
 *   async (req, res) => {
 *     // Validation passed, safe to proceed
 *   }
 * );
 */
export const validateRequest = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const { validationResult } = require('express-validator');
  const errors = validationResult(req);

  if (!errors.isEmpty()) {
    const error = new AppError(
      errors.array().map((e: any) => e.msg).join('. '),
      400
    );
    return next(error);
  }

  next();
};
