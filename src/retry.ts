import { MarkovaError } from "./types";

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function backoffDelay(attempt: number, baseMs = 500, maxMs = 30_000): number {
  const exponential = Math.min(maxMs, baseMs * 2 ** attempt);
  const jitter = Math.random() * 0.3 * exponential;
  return Math.round(Math.min(maxMs, exponential + jitter));
}

export function classifyHttpError(status: number): MarkovaError {
  if (status === 401 || status === 403) {
    return new MarkovaError("AUTH_ERROR", "API key invalid or revoked", status);
  }
  if (status === 429) {
    return new MarkovaError("RATE_LIMITED", "Rate limit exceeded - events requeued", status);
  }
  if (status >= 400 && status < 500) {
    return new MarkovaError("VALIDATION_ERROR", `Request rejected with status ${status}`, status);
  }
  return new MarkovaError("UNKNOWN_ERROR", `Server error with status ${status}`, status);
}

// Events failing with 4xx validation errors must not be retried forever.
export function isRetryable(error: unknown): boolean {
  if (error instanceof MarkovaError) {
    return error.code === "NETWORK_ERROR" || error.code === "RATE_LIMITED" || error.code === "UNKNOWN_ERROR";
  }
  return true;
}
