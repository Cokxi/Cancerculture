import "server-only";

import { AuthError } from "@/lib/auth/AuthError";

const DEFAULT_AUTH_QUERY_TIMEOUT_MS = 5_000;

export async function runAuthQueryWithTimeout<T>(
  label: string,
  query: PromiseLike<T>,
  timeoutMs = DEFAULT_AUTH_QUERY_TIMEOUT_MS
) {
  const startedAt = performance.now();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  try {
    const result = await Promise.race([
      Promise.resolve(query),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(
            new AuthError(
              503,
              "Authentication service temporarily unavailable"
            )
          );
        }, timeoutMs);
      }),
    ]);

    console.log(
      `[AUTH_PERF] ${label}: ${(performance.now() - startedAt).toFixed(1)}ms`
    );
    return result;
  } catch (error) {
    const durationMs = performance.now() - startedAt;
    const timedOut =
      error instanceof AuthError && error.status === 503;

    console.error(
      `[AUTH_PERF] ${label} ${timedOut ? "timeout" : "failed"}: ${durationMs.toFixed(1)}ms`,
      error
    );
    throw error;
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}
