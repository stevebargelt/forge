import type { ServerResponse } from "node:http";
import { redactSecrets } from "../../src/v2/host-readiness.js";

type ErrorResponse = Pick<ServerResponse, "headersSent" | "writeHead" | "end" | "destroy">;

/** Serialize a degraded-read `{error}` payload with the exception message routed
 *  through the config-graph redaction boundary — a surfaced string must not leak a
 *  secret just because it travelled the error path instead of the graph object. */
export function degradedGraphErrorPayload(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return JSON.stringify({ error: redactSecrets(message) });
}

/** Finish an unhandled async request without corrupting a partial response. */
export function finishUnhandledRequest(res: ErrorResponse): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(500, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Internal server error" }));
}
