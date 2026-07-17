import type { ServerResponse } from "node:http";

type ErrorResponse = Pick<ServerResponse, "headersSent" | "writeHead" | "end" | "destroy">;

/** Finish an unhandled async request without corrupting a partial response. */
export function finishUnhandledRequest(res: ErrorResponse): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(500, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Internal server error" }));
}
