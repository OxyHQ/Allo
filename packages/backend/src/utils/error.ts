export class ApiError extends Error {
    statusCode: number;
    
    constructor(statusCode: number, message: string) {
        super(message);
        this.statusCode = statusCode;
        this.name = 'ApiError';
    }
}

export const createError = (statusCode: number, message: string) => {
    return new ApiError(statusCode, message);
};

/**
 * Type guard for a MongoDB duplicate-key error (code 11000) on an `unknown`
 * value caught in a `catch` block.
 */
export const isDuplicateKeyError = (error: unknown): boolean => {
    return (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code?: unknown }).code === 11000
    );
};