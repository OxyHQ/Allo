/**
 * The API's circuit breaker: stops requests to a backend that keeps failing,
 * so a fault does not cascade into every screen.
 */

import { getHttpStatus, getErrorMessage } from '@/utils/errors';

/**
 * Circuit breaker pattern
 * Prevents cascading failures by stopping requests after too many failures
 */
export class CircuitBreaker {
  private failures = 0;
  private lastFailureTime = 0;
  private state: 'closed' | 'open' | 'half-open' = 'closed';

  constructor(
    private threshold: number = 5,
    private timeout: number = 60000, // 1 minute
    private resetTimeout: number = 30000, // 30 seconds
    /** Identifies this breaker in errors and logs, so an open circuit is diagnosable. */
    private name: string = 'api',
  ) {}

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    // Check if circuit is open
    if (this.state === 'open') {
      const timeSinceLastFailure = Date.now() - this.lastFailureTime;
      if (timeSinceLastFailure < this.resetTimeout) {
        const retryInSeconds = Math.ceil((this.resetTimeout - timeSinceLastFailure) / 1000);
        throw new Error(
          `Circuit breaker is open for ${this.name} after ${this.failures} failures. ` +
            `Retrying in ${retryInSeconds}s.`,
        );
      }
      // Try to transition to half-open
      this.state = 'half-open';
    }

    try {
      const result = await fn();

      // Any success clears the count, not just one that closes a half-open
      // circuit. The breaker trips on *consecutive* failures: a request that
      // succeeds proves the service is up, so earlier isolated failures must
      // not be held against it. Without this, failures accumulate for the
      // lifetime of the app and the circuit eventually opens on a healthy
      // backend.
      this.state = 'closed';
      this.failures = 0;

      return result;
    } catch (error: unknown) {
      // A 4xx is a definitive answer from a healthy server: the request was
      // rejected, the service is fine. Counting those toward the breaker lets
      // an ordinary "not found" — a profile handle nobody owns, say —
      // trip the circuit and take down unrelated calls. Only server faults
      // (5xx), an explicit back-off (429), a timeout (408), and transport
      // failures (no status at all) mean the backend is actually in trouble.
      const status = getHttpStatus(error);
      const isClientError =
        status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429;
      if (isClientError) {
        throw error;
      }

      // Failures older than the window are stale evidence: a fault an hour ago
      // says nothing about the service now, so the run starts over rather than
      // accumulating across unrelated incidents.
      const now = Date.now();
      if (this.failures > 0 && now - this.lastFailureTime > this.timeout) {
        this.failures = 0;
      }

      this.failures++;
      this.lastFailureTime = now;

      // Open circuit if threshold exceeded
      if (this.failures >= this.threshold) {
        this.state = 'open';
        console.error(
          `[Circuit Breaker] Opened for ${this.name} after ${this.failures} failures. ` +
            `Last error: ${getErrorMessage(error)}`,
        );
      }

      throw error;
    }
  }

  reset(): void {
    this.failures = 0;
    this.state = 'closed';
  }

  getState(): 'closed' | 'open' | 'half-open' {
    return this.state;
  }
}
