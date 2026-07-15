interface LoggerFunction {
  (message: string, ...args: unknown[]): void;
}

interface Logger {
  info: LoggerFunction;
  warn: LoggerFunction;
  error: LoggerFunction;
  debug: LoggerFunction;
}

const PREFIX = '[Allo]';

const createLogger = (): Logger => {
  return {
    info: (message: string, ...args: unknown[]) => {
      if (process.env.NODE_ENV !== 'production') {
        console.log(`${PREFIX} [INFO] ${message}`, ...args);
      }
    },
    warn: (message: string, ...args: unknown[]) => {
      console.warn(`${PREFIX} [WARN] ${message}`, ...args);
    },
    error: (message: string, ...args: unknown[]) => {
      console.error(`${PREFIX} [ERROR] ${message}`, ...args);
    },
    debug: (message: string, ...args: unknown[]) => {
      if (process.env.NODE_ENV !== 'production') {
        console.debug(`${PREFIX} [DEBUG] ${message}`, ...args);
      }
    }
  };
};

export const logger = createLogger();