import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { awaitDashboardReady, DashboardReadinessTimeoutError } from "./await-dashboard-ready.js";

async function withServer(status: number, run: (base: string) => Promise<void>): Promise<void> {
  const server = createServer((_request, response) => response.writeHead(status).end());
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.close();
    await once(server, "close");
  }
}

test("awaitDashboardReady waits for a successful real route response", async () => {
  await withServer(200, async (base) => {
    await awaitDashboardReady(base, { timeoutMs: 200 });
  });
});

test("awaitDashboardReady reports a named timeout when the route never becomes successful", async () => {
  await withServer(503, async (base) => {
    await assert.rejects(
      awaitDashboardReady(base, { timeoutMs: 50 }),
      (error: unknown) => error instanceof DashboardReadinessTimeoutError && error.name === "DashboardReadinessTimeoutError"
    );
  });
});
