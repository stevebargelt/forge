import { after, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_PORT = 18768;
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const tmpHome = mkdtempSync(join(tmpdir(), "forge-plan-route-"));
const fakeCodex = join(tmpHome, "fake-codex");

writeFileSync(fakeCodex, `#!${process.execPath}
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  input += chunk;
  let newline;
  while ((newline = input.indexOf("\\n")) >= 0) {
    const line = input.slice(0, newline);
    input = input.slice(newline + 1);
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (message.method === "initialize") process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\\n");
    if (message.method === "account/rateLimits/read") process.stdout.write(JSON.stringify({ id: message.id, result: {
      rateLimits: { planType: "prolite", primary: { usedPercent: 14, windowDurationMins: 300, resetsAt: ${Math.floor((Date.now() + 3600_000) / 1000)} }, secondary: null }
    } }) + "\\n");
  }
});
`);
chmodSync(fakeCodex, 0o700);

process.env.FORGE_HOME = tmpHome;
process.env.FORGE_CODEX_DIR = join(tmpHome, "codex");
process.env.FORGE_CODEX_BIN = fakeCodex;
process.env.CLAUDE_CONFIG_DIR = join(tmpHome, "claude");
process.env.CLAUDE_CODE_USE_BEDROCK = "1";
process.env.AWS_PROFILE = "integration-test";
process.env.USER = "";
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_API_KEY;
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
  assert.deepEqual(body.services.map((service) => service.id), ["bedrock", "codex-subscription"]);
  assert.equal(body.services[0]!.status, "not_configured");
  assert.equal(body.services[0]!.plan, "AWS usage · integration-test");
  assert.equal(body.services[1]!.status, "live");
  assert.equal(body.services[1]!.plan, "ChatGPT Pro (5×)");
});

test("GET /api/usage/limits?refresh=1 bypasses the short-lived collector cache", async () => {
  const first = await fetch(`${BASE}/api/usage/limits`).then((response) => response.json()) as { generatedAt: string };
  await new Promise((resolve) => setTimeout(resolve, 5));
  const refreshed = await fetch(`${BASE}/api/usage/limits?refresh=1`).then((response) => response.json()) as { generatedAt: string };
  assert.ok(Date.parse(refreshed.generatedAt) > Date.parse(first.generatedAt));
});
