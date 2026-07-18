import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { SCHEMA_SQL } from "../../src/store/schema.js";

const TEST_PORT = 18767;
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const testHome = mkdtempSync(join(tmpdir(), "forge-project-route-"));
const forgeHome = join(testHome, ".forge");
const reposRoot = join(testHome, "checkouts");
mkdirSync(forgeHome, { recursive: true });
mkdirSync(reposRoot, { recursive: true });

process.env.HOME = testHome;
process.env.FORGE_HOME = forgeHome;
process.env.FORGE_PROJECT_SCAN_ROOTS = reposRoot;
process.env.PORT = String(TEST_PORT);
process.env.HOST = "127.0.0.1";

function git(dir: string, args: string[]): void {
  execFileSync("git", args, { cwd: dir, stdio: "ignore" });
}

function checkout(name: string, branch: string, remote: string): string {
  const dir = join(reposRoot, name);
  mkdirSync(dir);
  git(dir, ["init", "-b", branch]);
  git(dir, ["remote", "add", "origin", remote]);
  return dir;
}

const checkouts = [
  checkout("forge", "main", "git@github.com:stevebargelt/forge.git"),
  checkout("dashboard-renamed", "dashboard-home", "https://github.com/stevebargelt/forge"),
  checkout("forge-fg571", "fg578-raci-clobber", "ssh://git@github.com/stevebargelt/forge.git"),
];

{
  const database = new Database(join(forgeHome, "forge.db"));
  database.exec(SCHEMA_SQL);
  const insertRun = database.prepare("INSERT INTO runs (id,workflow,title,status,created_at,project_dir) VALUES (?,?,?,?,?,?)");
  const insertTask = database.prepare("INSERT INTO tasks (id,run_id,phase,agent_role,status,task_package,result,created_at,started_at,completed_at) VALUES (?,?,?,?,?,'{}','{}',?,?,?)");
  checkouts.forEach((projectDir, index) => {
    const runId = `run-${index}`;
    const createdAt = `2026-07-${15 + index}T10:00:00Z`;
    insertRun.run(runId, "feature", `Run ${index}`, index === 1 ? "active" : "complete", createdAt, projectDir);
    insertTask.run(`done-${index}`, runId, "engineer", "engineer", "complete", createdAt, createdAt, createdAt);
    if (index === 1) {
      database.prepare("INSERT INTO tasks (id,run_id,phase,agent_role,status,task_package,created_at,started_at) VALUES (?,?,?,?,?,'{}',?,?)")
        .run("running-1", runId, "engineer", "engineer", "running", createdAt, createdAt);
    }
  });
  database.close();
}

const heartbeatDir = join(testHome, ".forge", "orchestrators");
mkdirSync(heartbeatDir, { recursive: true });
writeFileSync(join(heartbeatDir, "live.json"), JSON.stringify({
  sessionId: "live",
  projectDir: checkouts[2],
  startedAt: new Date().toISOString(),
  lastSeen: new Date().toISOString(),
}));

const { server } = await import("./server.js");
after(() => {
  server.closeAllConnections?.();
  server.close();
});

for (let attempt = 0; attempt < 75; attempt += 1) {
  try {
    await fetch(`${BASE}/`);
    break;
  } catch {
    if (attempt === 74) throw new Error("dashboard test server did not start");
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

async function getJson(path: string): Promise<unknown> {
  const response = await fetch(`${BASE}${path}`);
  assert.equal(response.status, 200);
  return response.json();
}

test("canonical project endpoint collapses clones and aggregates checkout signals", async () => {
  const projects = await getJson("/api/projects") as Array<Record<string, unknown>>;
  assert.equal(projects.length, 1);
  const forge = projects[0]!;
  assert.equal(forge["label"], "Forge");
  assert.equal(forge["runCount"], 3);
  assert.equal(forge["inFlightCount"], 1);
  assert.equal(forge["liveSessions"], 1);
  assert.equal(forge["lastRunAt"], "2026-07-17T10:00:00Z");
  assert.deepEqual((forge["checkouts"] as Array<{ branch: string }>).map((entry) => entry.branch).sort(), [
    "dashboard-home", "fg578-raci-clobber", "main",
  ]);
});

test("canonical selection returns activity from every checkout while exact filtering remains available", async () => {
  const projects = await getJson("/api/projects") as Array<{ key: string }>;
  const all = await getJson(`/api/feed?projectKey=${encodeURIComponent(projects[0]!.key)}`) as Array<{ projectDir: string; projectLabel: string; checkoutBranch: string | null; checkoutName: string }>;
  assert.equal(all.length, 3);
  assert.deepEqual(new Set(all.map((entry) => entry.projectDir)), new Set(checkouts));
  assert.deepEqual(new Set(all.map((entry) => entry.projectLabel)), new Set(["Forge"]));
  assert.deepEqual(new Set(all.map((entry) => entry.checkoutBranch)), new Set([null]));
  assert.deepEqual(new Set(all.map((entry) => entry.checkoutName)), new Set(["forge", "dashboard-renamed", "forge-fg571"]));

  const exact = await getJson(`/api/feed?projectDir=${encodeURIComponent(checkouts[1]!)}`) as Array<{ projectDir: string }>;
  assert.equal(exact.length, 1);
  assert.equal(exact[0]!.projectDir, checkouts[1]);
});
