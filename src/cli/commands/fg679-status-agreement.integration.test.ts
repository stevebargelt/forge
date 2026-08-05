// FG-679 (BD-9): `/status` and the dashboard MUST agree.
//
// The ticket makes a disagreement here a DEFECT, not a difference of presentation.
// Prose in a SKILL.md cannot enforce that, and two independently-written renderers
// that happen to agree today will not agree tomorrow. So agreement is STRUCTURAL:
// both surfaces call the SAME exported derivation over the SAME persisted state.
//
// This suite proves it three ways:
//   1. `forge status --json` carries a `currentActivity` block whose content equals
//      what `deriveCurrentActivity` returns for the same store and the same clock —
//      for a host launch running with no active agent task, AND for a pending
//      required check with no active agent task.
//   2. `forge status` HUMAN output renders the three sections and the launch, so the
//      agreement is over the SURFACE an operator reads, not only over a JSON field.
//   3. The dashboard's `currentActivity` query delegates to that same function, so a
//      change to one surface cannot move without the other.
//
// Spawns the real CLI against a real store on disk → integration tier.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveCurrentActivity } from "../../v2/current-activity.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");
const CLI = join(REPO, "src", "cli", "index.ts");

let home = "";
let dbPath = "";
const PROJECT = "/tmp/test-project";
const SHA = "b".repeat(40);
const NOW = new Date();
const iso = NOW.toISOString();

function seed(): void {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE runs (id TEXT PRIMARY KEY, workflow TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, completed_at TEXT, metadata TEXT, project_dir TEXT, review_mode TEXT NOT NULL DEFAULT 'legacy_verdict');
    CREATE TABLE tasks (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, parent_id TEXT, phase TEXT NOT NULL, agent_role TEXT NOT NULL, agent_alias TEXT, agent_model TEXT, status TEXT NOT NULL, task_package TEXT NOT NULL, result TEXT, created_at TEXT NOT NULL, started_at TEXT, completed_at TEXT, error TEXT);
    CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, task_id TEXT, event_type TEXT NOT NULL, payload TEXT, created_at TEXT NOT NULL);
    CREATE TABLE launch_observations (
      launch_id TEXT PRIMARY KEY, name TEXT, command TEXT NOT NULL, cwd TEXT NOT NULL, project_dir TEXT,
      association_kind TEXT NOT NULL, run_id TEXT, task_id TEXT, ticket_id TEXT, campaign_id TEXT, item_id TEXT,
      started_at TEXT NOT NULL, observed_at TEXT NOT NULL, state TEXT NOT NULL, exit_code INTEGER, signal TEXT,
      terminal INTEGER NOT NULL
    );
  `);
  db.prepare(`INSERT INTO runs (id, workflow, title, status, created_at, project_dir) VALUES ('run-agree','feature','agreement run','active', ?, ?)`).run(iso, PROJECT);
  // Deliberately NO running/awaiting task: the whole point is a run whose only
  // in-flight work is a host launch and a pending check.
  db.prepare(`INSERT INTO tasks (id, run_id, phase, agent_role, status, task_package, created_at, completed_at) VALUES ('task-done','run-agree','plan','tech-lead','complete','{}', ?, ?)`).run(iso, iso);
  db.prepare(`
    INSERT INTO launch_observations (launch_id, name, command, cwd, project_dir, association_kind, run_id, ticket_id, started_at, observed_at, state, terminal)
    VALUES ('launch-worktree-agree1', 'worktree', ?, ?, ?, 'explicit', 'run-agree', 'FG-679', ?, ?, 'running', 0)
  `).run(JSON.stringify(["npm", "run", "test:worktree"]), PROJECT, PROJECT, iso, iso);
  db.prepare(`INSERT INTO events (run_id, task_id, event_type, payload, created_at) VALUES ('run-agree', NULL, 'review_loop.ci_observed', ?, ?)`)
    .run(JSON.stringify({
      attemptId: "attempt-agree", ticketId: "FG-679", projectDir: PROJECT, candidateSha: SHA,
      observedAt: iso, outcome: "pending", unavailableReason: null,
      contexts: [
        { context: "test", state: "pending", url: "https://example.invalid/1", observedAt: iso },
        { context: "test-extended", state: "queued", url: "https://example.invalid/2", observedAt: iso },
      ],
    }), iso);
  db.close();
}

function forge(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, ["--import", "tsx", CLI, ...args], {
    cwd: REPO,
    encoding: "utf8",
    env: { ...process.env, FORGE_HOME: home, FORGE_DB_PATH: dbPath, NO_NOTIFY: "true" },
  });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

/** The derivation, read through a SEPARATE connection to the same store — the
 *  dashboard's position exactly. */
function derived(scope: { runId?: string }): ReturnType<typeof deriveCurrentActivity> {
  const db = new Database(dbPath, { readonly: true });
  try {
    return deriveCurrentActivity(db, { now: NOW, scope });
  } finally {
    db.close();
  }
}

/** Everything except the wall-clock stamp, which is the one field that legitimately
 *  differs between two calls. */
function comparable(activity: ReturnType<typeof deriveCurrentActivity>): unknown {
  const { generatedAt: _ignored, ...rest } = activity;
  return rest;
}

before(() => {
  home = mkdtempSync(join(tmpdir(), "fg679-agree-"));
  dbPath = join(home, "forge.db");
  seed();
});

after(() => {
  if (home) rmSync(home, { recursive: true, force: true });
});

describe("FG-679 BD-9 — /status and the dashboard answer from ONE derivation", () => {
  test("(a) a host launch running with no active agent task: `forge status --json` and the shared derivation agree exactly", () => {
    const res = forge(["status", "run-agree", "--json"]);
    assert.equal(res.status, 0, res.stderr);
    const payload = JSON.parse(res.stdout) as { currentActivity: ReturnType<typeof deriveCurrentActivity> };
    assert.ok(payload.currentActivity, "`forge status --json` carries the Current activity block");
    assert.deepEqual(comparable(payload.currentActivity), comparable(derived({ runId: "run-agree" })));

    // …and it is the launch, not an agent, that the surface reports as active.
    assert.equal(payload.currentActivity.agents.length, 0);
    assert.equal(payload.currentActivity.hostVerification.length, 1);
    assert.equal(payload.currentActivity.hostVerification[0]!.launchId, "launch-worktree-agree1");
    assert.equal(payload.currentActivity.hostVerification[0]!.statusLabel, "running");
  });

  test("(b) a pending required check with no active agent task: both name the same sha and the same contexts", () => {
    const res = forge(["status", "run-agree", "--json"]);
    const payload = JSON.parse(res.stdout) as { currentActivity: ReturnType<typeof deriveCurrentActivity> };
    const fromDerivation = derived({ runId: "run-agree" });

    assert.deepEqual(payload.currentActivity.requiredCi, fromDerivation.requiredCi);
    assert.equal(payload.currentActivity.requiredCi.observations[0]!.candidateSha, SHA);
    assert.deepEqual(
      payload.currentActivity.requiredCi.observations[0]!.contexts.map((c) => c.context),
      ["test", "test-extended"],
    );
    assert.equal(payload.currentActivity.requiredCi.observations[0]!.state, "running");
  });

  test("the HUMAN `forge status` surface renders the three sections, the launch, and the per-context CI detail", () => {
    const res = forge(["status", "run-agree"]);
    assert.equal(res.status, 0, res.stderr);
    const out = res.stdout;

    assert.match(out, /^Current activity$/m);
    assert.match(out, /^ {2}Agents$/m);
    assert.match(out, /^ {2}Host verification$/m);
    assert.match(out, /^ {2}Required CI$/m);
    // The launch is under Host verification, and NO agent task reads as running.
    assert.match(out, /\(no agent task in flight\)/);
    assert.match(out, /running {2}launch-worktree-agree1/);
    assert.match(out, /npm run test:worktree/);
    // BD-5 on the human surface: the exact sha and EVERY context.
    assert.match(out, new RegExp(`candidate ${SHA}`));
    assert.match(out, /test: pending {2}https:\/\/example\.invalid\/1/);
    assert.match(out, /test-extended: queued {2}https:\/\/example\.invalid\/2/);
  });

  test("the host-wide `forge status --all` surface renders Current activity too, so /status can enumerate host-wide", () => {
    const res = forge(["status", "--all", "--json"]);
    assert.equal(res.status, 0, res.stderr);
    const payload = JSON.parse(res.stdout) as { currentActivity: ReturnType<typeof deriveCurrentActivity> };
    assert.deepEqual(comparable(payload.currentActivity), comparable(derived({})));

    const human = forge(["status", "--all"]);
    assert.match(human.stdout, /^Current activity$/m);
    assert.match(human.stdout, /launch-worktree-agree1/);
  });

  test("agreement is STRUCTURAL: the dashboard's query delegates to the same exported function", async () => {
    const queriesSource = await import("node:fs").then((fs) =>
      fs.readFileSync(join(REPO, "dashboard", "src", "queries.ts"), "utf8"));
    assert.match(queriesSource, /deriveCurrentActivity/, "the dashboard calls the shared derivation");
    assert.match(queriesSource, /from "@forge\/current-activity"/);
    const statusSource = await import("node:fs").then((fs) =>
      fs.readFileSync(join(REPO, "src", "cli", "commands", "status.ts"), "utf8"));
    assert.match(statusSource, /deriveCurrentActivity/, "`forge status` calls the shared derivation");
    // Neither surface may grow its own copy of the launch status rendering.
    assert.doesNotMatch(queriesSource, /terminated by \$\{/, "the dashboard must not compose a launch status string");
    assert.doesNotMatch(statusSource, /terminated by \$\{/, "`forge status` must not compose a launch status string");
  });
});
