import { fixtureFetch } from "./fixture-fetch.js";

export class DashboardReadinessTimeoutError extends Error {
  override name = "DashboardReadinessTimeoutError";

  constructor(base: string, timeoutMs: number, cause?: unknown) {
    super(`dashboard at ${base} did not answer a successful readiness request within ${timeoutMs}ms`, { cause });
  }
}

/** Poll the dashboard's real root route until its HTTP server is ready for a fixture case. */
export async function awaitDashboardReady(base: string, { timeoutMs }: { timeoutMs: number }): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  for (;;) {
    try {
      const response = await fixtureFetch(base);
      if (response.ok) return;
      lastError = new Error(`dashboard readiness route answered ${response.status}`);
    } catch (error) {
      lastError = error;
    }

    if (Date.now() >= deadline) throw new DashboardReadinessTimeoutError(base, timeoutMs, lastError);
    await new Promise<void>((resolve) => setTimeout(resolve, 40));
  }
}
