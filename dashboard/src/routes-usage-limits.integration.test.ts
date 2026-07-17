import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_PORT = 18768;
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const tmpHome = mkdtempSync(join(tmpdir(), "forge-plan-route-"));

process.env.FORGE_HOME = tmpHome;
process.env.FORGE_CODEX_DIR = join(tmpHome, "codex");
process.env.CLAUDE_CODE_USE_BEDROCK = "1";
process.env.AWS_PROFILE = "integration-test";
process.env.PORT = String(TEST_PORT);
process.env.HOST = "127.0.0.1";

const { server } = await import("./server.js");

after(() => {
  server.closeAllConnections?.();
  server.close();
});

async function waitForServer(ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      await fetch(`${BASE}/api/usage/limits`);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  }
  throw new Error("plan usage test server did not start");
}

await waitForServer();

test("GET /api/usage/limits returns the normalized host provider contract", async () => {
  const response = await fetch(`${BASE}/api/usage/limits`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json() as {
    generatedAt: string;
    services: Array<{ id: string; status: string; plan: string | null }>;
  };
  assert.ok(Number.isFinite(Date.parse(body.generatedAt)));
  assert.deepEqual(body.services.map((service) => service.id), ["bedrock", "codex"]);
  assert.equal(body.services[0]!.status, "not_configured");
  assert.equal(body.services[0]!.plan, "AWS usage · integration-test");
});

test("GET /api/usage/limits?refresh=1 bypasses the short-lived collector cache", async () => {
  const first = await fetch(`${BASE}/api/usage/limits`).then((response) => response.json()) as { generatedAt: string };
  await new Promise((resolve) => setTimeout(resolve, 5));
  const refreshed = await fetch(`${BASE}/api/usage/limits?refresh=1`).then((response) => response.json()) as { generatedAt: string };
  assert.ok(Date.parse(refreshed.generatedAt) > Date.parse(first.generatedAt));
});
