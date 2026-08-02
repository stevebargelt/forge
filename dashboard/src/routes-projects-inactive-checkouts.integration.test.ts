// FG-595: the dashboard Projects view and its checkout scope controls must
// suppress stale checkouts — a checkout that is gone from disk AND has no
// in-flight work AND no live session — while preserving the canonical
// ProjectRecord aggregate (runCount/inFlightCount/liveSessions/lastRunAt) and
// the full historical projectDirs array so projectKey-scoped feed/usage/run
// queries still reach every historical path. A missing checkout that still has
// active work stays visible; a fully inactive missing standalone project is
// omitted entirely.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { SCHEMA_SQL } from "../../src/store/schema.js";

const TEST_PORT = 18775;
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const testHome = mkdtempSync(join(tmpdir(), "forge-inactive-checkouts-"));
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

// One real, existing Forge checkout on disk.
const forgeDir = join(reposRoot, "forge");
mkdirSync(forgeDir);
git(forgeDir, ["init", "-b", "main"]);
git(forgeDir, ["remote", "add", "origin", "git@github.com:stevebargelt/forge.git"]);

// A deleted scratchpad encodes its source checkout as an exact encoded
// path segment; two of them, both pointing back at the Forge checkout, are the
// grouped-but-gone checkouts that must be suppressed.
const forgeSegment = forgeDir.replaceAll("/", "-");
const scratchA = join(testHome, "claude-1", forgeSegment, "sess-a", "scratchpad", "wt-a");
const scratchB = join(testHome, "claude-2", forgeSegment, "sess-b", "scratchpad", "wt-b");

// A missing standalone checkout that STILL has active work — stays visible.
const ghostActive = join(testHome, "tmp", "ghost-active");
// A missing standalone temp project with only terminal history — omitted.
const ghostIdle = join(testHome, "tmp", "ghost-idle");
// A missing standalone checkout with NO db runs and NO in-flight work, kept
// alive ONLY by a live orchestrator heartbeat (liveSessions>0). This exercises
// the live-session survival boundary through the real query pipeline — the
// server-side path that the in-flight ghost above does NOT cover, because
// liveSessions is sourced from heartbeat files, not the runs table.
const ghostLive = join(testHome, "tmp", "ghost-live");

{
  const database = new Database(join(forgeHome, "forge.db"));
  database.exec(SCHEMA_SQL);
  const insertRun = database.prepare(
    "INSERT INTO runs (id,workflow,title,status,created_at,project_dir) VALUES (?,?,?,?,?,?)",
  );
  const insertDone = database.prepare(
    "INSERT INTO tasks (id,run_id,phase,agent_role,status,task_package,result,created_at,started_at,completed_at) VALUES (?,?,?,?,?,'{}','{}',?,?,?)",
  );
  const insertRunning = database.prepare(
    "INSERT INTO tasks (id,run_id,phase,agent_role,status,task_package,created_at,started_at) VALUES (?,?,?,?,?,'{}',?,?)",
  );

  const complete = (id: string, dir: string, at: string) => {
    insertRun.run(`run-${id}`, "feature", `Run ${id}`, "complete", at, dir);
    insertDone.run(`done-${id}`, `run-${id}`, "engineer", "engineer", "complete", at, at, at);
  };

  complete("forge", forgeDir, "2026-07-15T10:00:00Z");
  complete("scratch-a", scratchA, "2026-07-16T10:00:00Z");
  complete("scratch-b", scratchB, "2026-07-17T10:00:00Z");
  complete("ghost-idle", ghostIdle, "2026-07-10T10:00:00Z");

  // Missing standalone with a live, non-terminal task under an active run.
  insertRun.run("run-ghost-active", "feature", "Ghost Active", "active", "2026-07-18T10:00:00Z", ghostActive);
  insertRunning.run("running-ga", "run-ghost-active", "engineer", "engineer", "running", "2026-07-18T10:00:00Z", "2026-07-18T10:00:00Z");

  database.close();
}

// A fresh orchestrator heartbeat for the missing ghostLive path. loadHeartbeats
// treats a file whose lastSeen is under 15 minutes old as live, so this feeds
// liveSessions=1 for a checkout with no runs and no in-flight tasks — the exact
// "gone but a live session is attached" case the registry must NOT suppress.
{
  const orchestrators = join(forgeHome, "orchestrators");
  mkdirSync(orchestrators, { recursive: true });
  const nowIso = new Date().toISOString();
  writeFileSync(
    join(orchestrators, "sess-ghost-live.json"),
    JSON.stringify({ sessionId: "sess-ghost-live", projectDir: ghostLive, startedAt: nowIso, lastSeen: nowIso }),
  );
}

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

type Checkout = { projectDir: string; branch?: string; exists: boolean; inFlightCount: number; liveSessions: number };
type Project = {
  key: string;
  label: string;
  runCount: number;
  inFlightCount: number;
  liveSessions: number;
  lastRunAt?: string;
  projectDirs: string[];
  checkouts: Checkout[];
};

async function getJson(path: string): Promise<unknown> {
  const response = await fetch(`${BASE}${path}`);
  assert.equal(response.status, 200);
  return response.json();
}

test("existing Forge checkout with deleted scratchpads: scratchpads suppressed, aggregate + projectDirs preserved", async () => {
  const projects = (await getJson("/api/projects")) as Project[];
  const forge = projects.find((p) => p.label === "Forge");
  assert.ok(forge, "Forge project is present");

  // Only the on-disk main checkout survives; both deleted scratchpads are hidden.
  assert.deepEqual(
    forge.checkouts.map((c) => c.branch ?? null),
    ["main"],
    "deleted scratchpad checkouts are suppressed from the presentation registry",
  );
  assert.ok(forge.checkouts.every((c) => c.exists), "no missing checkout remains visible on Forge");

  // The canonical aggregate still counts the scratchpad runs.
  assert.equal(forge.runCount, 3, "runCount preserves scratchpad history");
  // The full historical projectDirs array is preserved for scope queries.
  assert.ok(forge.projectDirs.includes(forgeDir));
  assert.ok(forge.projectDirs.includes(scratchA), "scratchpad A still in projectDirs");
  assert.ok(forge.projectDirs.includes(scratchB), "scratchpad B still in projectDirs");
});

test("missing standalone checkout with active work stays visible with exists=false", async () => {
  const projects = (await getJson("/api/projects")) as Project[];
  const active = projects.find((p) => p.projectDirs.includes(ghostActive));
  assert.ok(active, "missing-but-active project is retained");
  assert.equal(active.inFlightCount, 1, "in-flight aggregate preserved");
  assert.equal(active.checkouts.length, 1);
  assert.equal(active.checkouts[0]!.exists, false, "the surviving checkout is truthfully marked missing");
});

test("missing standalone checkout kept alive by a live session only (no runs, no in-flight) stays visible", async () => {
  const projects = (await getJson("/api/projects")) as Project[];
  const live = projects.find((p) => p.projectDirs.includes(ghostLive));
  assert.ok(live, "missing-but-live project is retained through the real heartbeat pipeline");
  assert.equal(live.liveSessions, 1, "live session aggregate preserved");
  assert.equal(live.inFlightCount, 0, "no in-flight work — survival is due to the live session alone");
  assert.equal(live.runCount, 0, "no historical runs — survival is due to the live session alone");
  assert.equal(live.checkouts.length, 1);
  assert.equal(live.checkouts[0]!.exists, false, "the surviving live checkout is truthfully marked missing");
  assert.equal(live.checkouts[0]!.liveSessions, 1);
});

test("inactive missing standalone temp project is omitted", async () => {
  const projects = (await getJson("/api/projects")) as Project[];
  const idle = projects.find((p) => p.projectDirs.includes(ghostIdle));
  assert.equal(idle, undefined, "fully inactive missing project has no visible checkout and is omitted");
});

test("historical projectKey feed scope still queries every historical path", async () => {
  const projects = (await getJson("/api/projects")) as Project[];
  const forge = projects.find((p) => p.label === "Forge")!;
  const feed = (await getJson(`/api/feed?projectKey=${encodeURIComponent(forge.key)}`)) as Array<{ projectDir: string }>;
  const dirs = new Set(feed.map((e) => e.projectDir));
  assert.ok(dirs.has(forgeDir), "feed includes the on-disk checkout");
  assert.ok(dirs.has(scratchA), "feed still reaches deleted scratchpad A history");
  assert.ok(dirs.has(scratchB), "feed still reaches deleted scratchpad B history");
});
