/**
 * Shared utility functions for async operations.
 */

/**
 * Returns a promise that resolves after the specified number of milliseconds.
 * Used for rate-limiting, backoff delays, and polling intervals.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * Race a promise against a wall-clock deadline.
 * Does NOT cancel the underlying work — pair with AbortSignal at call sites
 * when cancellation is required (teleproto RPC cancel is still limited).
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timed out after ${ms}ms`));
        }, ms);
        if (typeof timer.unref === "function") {
          timer.unref();
        }
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/**
 * Safely parse a JSON string, returning undefined on failure.
 * Avoids the common pattern of empty catch blocks for JSON.parse.
 */
export function safeJsonParse<T = unknown>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}
