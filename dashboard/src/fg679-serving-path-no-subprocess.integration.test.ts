// FG-679 (BD-7): THE RUNTIME GUARD. Not source inspection — execution.
//
// The dashboard has no authentication and an env-overridable bind address
// (dashboard/src/server.ts). BD-7 forbids its serving and polling paths from
// making ANY outbound call — no GitHub, no shell, no `git`, no `gh`, no Forge CLI,
// no tmux — and BD-12 additionally forbids `readLaunch`/`listLaunches`. The
// criterion requires that be proven by a guard over the serving path, so this test
// monkey-patches every child_process spawn primitive and `fetch`, drives REAL HTTP
// requests against the three new endpoints, and asserts ZERO invocations.
//
// SCOPING IS DELIBERATE AND MUST NOT MOVE IN EITHER DIRECTION:
//   - NOT WIDENED to `/api/in-flight`. That endpoint already `execFileSync`s
//     `docker inspect` per running task through FG-290's reconcile-candidate
//     annotation. It is a RECORDED pre-existing exception (BD-13), not one this
//     ticket absorbs, and a guard that covered it would simply be red.
//   - NOT NARROWED to skip a new path that does shell out. The negative control at
//     the bottom proves the guard can SEE a subprocess: it drives /api/in-flight
//     through the same instrumentation and asserts the counter moves. Without that
//     control, a guard whose patches silently missed would pass by observing nothing.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_PORT = 18797;
const BASE = `http://127.0.0.1:${TEST_PORT}`;

const tmpHome = mkdtempSync(join(tmpdir(), "fg679-no-subproc-"));
process.env.FORGE_HOME = tmpHome;
process.env.PORT = String(TEST_PORT);
process.env.HOST = "127.0.0.1";

const db = new Database(join(tmpHome, "forge.db"));
db.exec(`
  CREATE TABLE runs (id TEXT PRIMARY KEY, title TEXT, workflow TEXT, project_dir TEXT, status TEXT, created_at TEXT);
  CREATE TABLE tasks (id TEXT PRIMARY KEY, run_id TEXT, phase TEXT, agent_role TEXT, agent_model TEXT, status TEXT, started_at TEXT, created_at TEXT, parent_id TEXT, task_package TEXT);
  CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, task_id TEXT, event_type TEXT, payload TEXT, created_at TEXT);
  CREATE TABLE launch_observations (
    launch_id TEXT PRIMARY KEY, name TEXT, command TEXT NOT NULL, cwd TEXT NOT NULL, project_dir TEXT,
    association_kind TEXT NOT NULL, run_id TEXT, task_id TEXT, ticket_id TEXT, campaign_id TEXT, item_id TEXT,
    started_at TEXT NOT NULL, observed_at TEXT NOT NULL, state TEXT NOT NULL, exit_code INTEGER, signal TEXT,
    terminal INTEGER NOT NULL
  );
`);

const iso = new Date().toISOString();
db.prepare(`INSERT INTO runs VALUES ('run-guard','guard run','feature','/proj/guard','active', ?)`).run(iso);
// A RUNNING containerized task, so /api/in-flight's docker probe (the negative
// control below) has something to probe.
db.prepare(`INSERT INTO tasks VALUES ('task-guard','run-guard','build','engineer','sonnet','running', ?, ?, NULL, '{}')`).run(iso, iso);
// container.started is what makes the row eligible for FG-290's `docker inspect`
// probe — the pre-existing serving-path exception the negative control observes.
db.prepare(`INSERT INTO events (run_id, task_id, event_type, payload, created_at) VALUES ('run-guard','task-guard','container.started', ?, ?)`)
  .run(JSON.stringify({ container: "forge-run-guard-task-guard" }), iso);
db.prepare(`
  INSERT INTO launch_observations (launch_id, name, command, cwd, project_dir, association_kind, run_id, started_at, observed_at, state, terminal)
  VALUES ('launch-guard-aaaaaa', 'guard', ?, '/proj/guard', '/proj/guard', 'explicit', 'run-guard', ?, ?, 'running', 0)
`).run(JSON.stringify(["npm", "run", "test:worktree"]), iso, iso);
db.prepare(`INSERT INTO events (run_id, task_id, event_type, payload, created_at) VALUES ('run-guard', NULL, 'review_loop.ci_observed', ?, ?)`)
  .run(JSON.stringify({
    attemptId: "attempt-guard", ticketId: "FG-679", projectDir: "/proj/guard", candidateSha: "a".repeat(40),
    observedAt: iso, outcome: "pending", unavailableReason: null,
    contexts: [{ context: "test", state: "pending", url: "https://example.invalid/1", observedAt: iso }],
  }), iso);

// ── the instrumentation: two independent channels ────────────────────────────
//
// (1) EXECUTABLE SHIMS FIRST ON PATH for every binary BD-7 names by word — `git`,
//     `gh`, `docker`, `tmux`, `forge`. Deliberately NOT a module-level spy on
//     `node:child_process`: Node freezes a builtin's ESM namespace, so
//     `childProcess.execFileSync = spy` throws outright — and a named import
//     (`import { execFileSync } from "node:child_process"`, which is how every
//     caller in this graph reaches it) is bound at LINK time and would not observe
//     a spy even if assignment succeeded. A guard built that way sees nothing and
//     passes VACUOUSLY. Shims observe the EFFECT — a process actually executing —
//     through whatever API the caller used, and through `execFileSync`, `execSync`,
//     `spawn` and `spawnSync` alike.
// (2) OUTBOUND HTTP, by wrapping `fetch`. Loopback calls to the server under test
//     are excluded by URL; anything else is an outbound call.
//
// The negative control at the bottom is what proves channel (1) is LIVE rather than
// merely unhit — without it, "zero calls" would be unfalsifiable.
const RIG = mkdtempSync(join(tmpdir(), "fg679-guard-"));
const CALL_LOG = join(RIG, "calls.log");
writeFileSync(CALL_LOG, "");

const SHIM_DIR = join(RIG, "bin");
mkdirSync(SHIM_DIR, { recursive: true });
for (const bin of ["docker", "git", "gh", "tmux", "forge", "forge-dev"]) {
  const shim = join(SHIM_DIR, bin);
  writeFileSync(shim, `#!/bin/sh\nprintf '%s %s\\n' "shim:${bin}" "$*" >> "${CALL_LOG}"\nexit 0\n`);
  chmodSync(shim, 0o755);
}
process.env.PATH = `${SHIM_DIR}:${process.env.PATH ?? ""}`;

function observedCalls(): string[] {
  return readFileSync(CALL_LOG, "utf8").split("\n").filter((l) => l.trim() !== "");
}
function resetCalls(): void {
  writeFileSync(CALL_LOG, "");
}

// Outbound HTTP. The test's own requests go through this too, so loopback calls to
// the server under test are excluded by URL; anything else is an outbound call.
const realFetch = globalThis.fetch;
const outbound: string[] = [];
globalThis.fetch = ((input: Parameters<typeof realFetch>[0], init?: Parameters<typeof realFetch>[1]) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
  if (!url.startsWith(BASE)) outbound.push(url);
  return realFetch(input, init);
}) as typeof realFetch;

const { server } = await import("./server.js");

after(() => {
  globalThis.fetch = realFetch;
  rmSync(RIG, { recursive: true, force: true });
  server.closeAllConnections?.();
  server.close();
});

async function waitForServer(ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      await realFetch(`${BASE}/`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 40));
    }
  }
  throw new Error(`Server on port ${TEST_PORT} did not start within ${ms}ms`);
}

await waitForServer();

const NEW_PATHS = [
  "/api/current-activity",
  "/api/current-activity?runId=run-guard",
  "/api/current-activity?projectDir=/proj/guard",
  "/api/launches/launch-guard-aaaaaa",
  "/api/launches/launch-guard-aaaaaa/log",
];

test("FG-679 BD-7: the new serving paths make ZERO subprocess and ZERO outbound HTTP calls", async () => {
  resetCalls();
  outbound.length = 0;

  for (const path of NEW_PATHS) {
    // Polled the way the client polls them, so a per-request lazy probe cannot hide
    // behind a first-call cache.
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${BASE}${path}`);
      assert.ok(res.status < 500, `${path} -> ${res.status}`);
      await res.text();
    }
  }

  assert.deepEqual(observedCalls(), [], `a serving path spawned a process: ${observedCalls().join(", ")}`);
  assert.deepEqual(outbound, [], `a serving path made an outbound request: ${outbound.join(", ")}`);
});

test("FG-679 BD-7: /api/current-activity answers 'running' from persisted state alone — no tmux, no readLaunch, no launch fs record", async () => {
  // There is no ~/.forge/launches directory in this fixture at all, and no tmux
  // server. If the answer depended on either, it could not be given.
  resetCalls();
  const body = await (await fetch(`${BASE}/api/current-activity?runId=run-guard`)).json() as {
    hostVerification: Array<{ launchId: string; statusLabel: string; observation: string }>;
    requiredCi: { state: string; observations: Array<{ candidateSha: string }> };
  };
  assert.deepEqual(observedCalls(), [], "answering 'is it running?' required no subprocess");
  assert.equal(body.hostVerification.length, 1);
  assert.equal(body.hostVerification[0]!.statusLabel, "running");
  assert.equal(body.hostVerification[0]!.observation, "fresh");
  assert.equal(body.requiredCi.state, "observed");
  assert.equal(body.requiredCi.observations[0]!.candidateSha.length, 40);
});

test("FG-679 BD-13 (negative control): the guard CAN see a subprocess — /api/in-flight's pre-existing docker probe is observed, and is NOT absorbed by this ticket", async () => {
  resetCalls();
  await (await fetch(`${BASE}/api/in-flight`)).text();
  // If this is ever empty, the instrumentation above stopped working and the
  // zero-call assertions became vacuous. FG-290's `docker inspect` per running task
  // is the pre-existing exception BD-13 RECORDS rather than absorbs; it is named
  // here so a future reader knows it is known, not missed.
  const observed = observedCalls();
  assert.ok(
    observed.some((c) => /docker/.test(c)),
    `the instrumentation must be able to observe a real subprocess — /api/in-flight recorded: ${observed.join(", ") || "(nothing)"}`,
  );
  // The shim channel must be LIVE, or the zero-call assertions above are vacuous:
  // this is the execFileSync("docker", ["inspect", ...]) at
  // src/ops/reconcile-candidate.ts:65, observed executing.
  assert.ok(observed.some((c) => c.startsWith("shim:docker inspect")), "the PATH-shim channel is live");
});
