// FG-817 pass 2: receipts are recorded dispatch facts and per-role dashboard usage
// is the same accounting surface as `forge usage --by role`, not a parallel rollup.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeTaskManifest } from "./task-manifest.js";
import { publishTestGeneration } from "./seed-generation.testkit.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = 18818;
const BASE = `http://127.0.0.1:${PORT}`;
const home = mkdtempSync(join(tmpdir(), "forge-fg817-receipts-usage-"));
process.env.FORGE_HOME = home;
process.env.PORT = String(PORT);
process.env.HOST = "127.0.0.1";

const gen = publishTestGeneration(home, {
  assetsParent: home,
  raciPath: join(ROOT, "seeds", "forge-raci.md"),
  runtimes: { "claude-oauth": readFileSync(join(ROOT, "seeds", "runtimes", "claude-oauth.yml"), "utf8") },
});
const generationId = basename(gen.root);
const protocolSource = join(gen.root, "agent-protocols", "engineer.md");
const protocolSha = gen.manifest.files["agent-protocols/engineer.md"]!;

for (const role of ["engineer", "test-engineer", "red-wide"]) {
  mkdirSync(join(home, "agents", role), { recursive: true });
  writeFileSync(join(home, "agents", role, "CLAUDE.md"), `# ${role}\n\nFixture role.\n`);
}
writeFileSync(join(home, "model-policy.yml"), readFileSync(join(ROOT, "seeds", "model-policy.example.yml"), "utf8"));

const { getDb, writeTransaction } = await import("../store/db.js");
const createdAt = new Date().toISOString();
writeTransaction(() => {
  const db = getDb();
  db.prepare("INSERT INTO runs (id, workflow, title, status, created_at, project_dir) VALUES (?,?,?,?,?,?)")
    .run("fg817-run", "invoke", "Receipt parity", "complete", createdAt, ROOT);
  const task = db.prepare("INSERT INTO tasks (id, run_id, phase, agent_role, status, task_package, created_at) VALUES (?,?,?,?,?,?,?)");
  task.run("fg817-engineer-task", "fg817-run", "task", "engineer", "complete", "{}", createdAt);
  task.run("fg817-test-task", "fg817-run", "task", "test-engineer", "complete", "{}", createdAt);
  task.run("fg817-empty-task", "fg817-run", "task", "red-wide", "complete", "{}", createdAt);
  const call = db.prepare("INSERT INTO model_calls (task_id, request_id, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, created_at) VALUES (?,?,?,?,?,?,?,?)");
  call.run("fg817-engineer-task", "fg817-eng-1", "claude-sonnet-5", 101, 11, 7, 3, createdAt);
  call.run("fg817-engineer-task", "fg817-eng-2", "claude-sonnet-5", 202, 22, 8, 4, createdAt);
  call.run("fg817-test-task", "fg817-test-1", "claude-opus-5-5", 303, 33, 9, 5, createdAt);
});

// The manifest writer is the dispatch persistence seam. Its receipt is deliberately
// read back through HTTP rather than reconstructed from the current generation.
const taskDir = join(home, "runs", "fg817-run", "fg817-engineer-task");
mkdirSync(taskDir, { recursive: true });
writeTaskManifest(taskDir, {
  taskId: "fg817-engineer-task",
  runId: "fg817-run",
  files: { prompt: "CLAUDE.md", package: "package.md", result: "result.json", stdout: "container.stdout.log", stderr: "container.stderr.log" },
  container: { name: "fg817-engineer" },
  auth: { profileRequested: false, stateMounted: false },
  agentProtocol: { role: "engineer", sha256: protocolSha, source: protocolSource },
});

// Start the actual dashboard entrypoint as its own workspace process. This matters
// because its tsconfig owns the @forge/* path map used by the HTTP server.
const dashboard = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
  cwd: join(ROOT, "dashboard"),
  env: { ...process.env, FORGE_HOME: home, PORT: String(PORT), HOST: "127.0.0.1" },
  stdio: "ignore",
});
after(() => {
  dashboard.kill();
});

async function getRole(role: string): Promise<any> {
  const deadline = Date.now() + 4_000;
  for (;;) {
    try {
      const response = await fetch(`${BASE}/api/roles/${role}`);
      assert.equal(response.status, 200);
      return await response.json();
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

function cliUsage(): Map<string, any> {
  const output = execFileSync(process.execPath, ["--import", "tsx", "src/cli/index.ts", "usage", "show", "--by", "role", "--json"], {
    cwd: ROOT, env: { ...process.env, FORGE_HOME: home }, encoding: "utf8",
  });
  const parsed = JSON.parse(output) as { rows: Array<{ bucket: string }> };
  return new Map(parsed.rows.map((row: any) => [row.bucket, row]));
}

test("FG-817: receipts tab preserves the dispatch manifest protocol bytes and disk generation history", async () => {
  const body = await getRole("engineer");
  const receipt = body.receipts.dispatches.find((row: any) => row.taskId === "fg817-engineer-task");
  assert.ok(receipt, "the task created through the manifest writer is listed");
  assert.deepEqual(receipt.protocol, { sha256: protocolSha, source: protocolSource });
  assert.equal(receipt.generation, generationId);

  const diskRows = readdirSync(join(home, "seed-generations"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => {
      const root = join(home, "seed-generations", entry.name);
      const manifest = JSON.parse(readFileSync(join(root, ".seed-generation.json"), "utf8"));
      return { id: entry.name, publishedAt: statSync(root).mtime.toISOString(), protocolSha: manifest.files["agent-protocols/engineer.md"] ?? null };
    })
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt) || b.id.localeCompare(a.id));
  assert.deepEqual(body.receipts.generations.map((row: any) => ({ id: row.id, publishedAt: row.publishedAt, protocolSha: row.protocolSha })), diskRows);
});

test("FG-817: usage tab equals the real role-grouped CLI totals, including a zero-usage role", async () => {
  const usage = cliUsage();
  for (const role of ["engineer", "test-engineer"]) {
    const dashboard = (await getRole(role)).usage.windows.find((row: any) => row.since === "all");
    const cli = usage.get(role);
    assert.ok(cli, `forge usage returns ${role}`);
    assert.deepEqual(
      [dashboard.inputTokens, dashboard.outputTokens, dashboard.cacheReadTokens, dashboard.cacheCreationTokens, dashboard.requests],
      [cli.inputTokens, cli.outputTokens, cli.cacheReadTokens, cli.cacheCreationTokens, cli.requests],
    );
  }
  const empty = (await getRole("red-wide")).usage.windows.find((row: any) => row.since === "all");
  assert.deepEqual([empty.inputTokens, empty.outputTokens, empty.cacheReadTokens, empty.cacheCreationTokens, empty.requests], [0, 0, 0, 0, 0]);
});
