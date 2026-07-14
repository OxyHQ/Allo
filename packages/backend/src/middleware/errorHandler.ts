/**
 * Application error type
 *
 * Operational (trusted) error carrying an HTTP status code. Thrown by services
 * (e.g. ConversationService) and translated to a client response at the route
 * boundary.
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
