// FG-356 — the reaper's EVIDENCE and its blast radius, over a real on-disk store.
//
// The companion lane (fg356-reaper-drive.worktree.test.ts) drives reconcileRun
// over real linked worktrees; this one covers the halves of the contract that do
// not involve a worktree at all, and the one property an in-memory DB cannot
// prove:
//
//   • DURABILITY. The retain event is the whole recovery contract — it is how an
//     operator learns, possibly weeks later, that a crashed task's work is still
//     sitting in a workspace and where. If it did not survive the process that
//     wrote it, retaining the workspace would just be a silent leak with extra
//     steps. So the store here is a real SQLite file, closed and reopened.
//   • The substrates that are NOT linked worktrees: FG-621's private clone (an
//     explicit, tested no-op), an unidentifiable directory, and — the safety
//     catch that matters most — a main checkout, including the run's own
//     projectDir.
//   • That the production retain-by-design kind set cannot grow without the
//     drive lane growing with it.
//
// Per the tier rule in docs/how-to-testing.md, no test in this file creates a git
// worktree; real repos, clones and an on-disk DB are integration-tier fixtures.
// Every fixture builds its own repo under its own temp dir and its own DB file —
// nothing touches ~/.forge/forge.db.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import type { Database as DatabaseInstance } from "better-sqlite3";

import { applyMigrations, setDbForTest } from "../store/db.js";
import { SCHEMA_SQL } from "../store/schema.js";
import { insertRun } from "../store/runs.js";
import { insertTask, getTask } from "../store/tasks.js";
import { eventsForTask, logEvent } from "../store/events.js";
import { reconcileRun } from "./reconcile.js";
import { classifyWorkspace, worktreeBranchName } from "./worktree-lifecycle.js";
import type { Run, Task, TaskStatus } from "../types/index.js";

const RUN_ID = "run-fg356-evidence";
const ALIVE = () => true;

const here = dirname(fileURLToPath(import.meta.url));
const CLI_ENTRY = resolve(here, "..", "cli", "index.ts");
const TSX = resolve(here, "..", "..", "node_modules", ".bin", "tsx");

const tmpDirs: string[] = [];
let openDbs: DatabaseInstance[] = [];
let prev: DatabaseInstance | null = null;

function tmpRoot(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `forge-fg356e-${label}-`));
  tmpDirs.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** A REAL on-disk store, so a close/reopen is a genuine process restart rather
 *  than a same-handle read. */
function openStore(dbFile: string): DatabaseInstance {
  const db = new Database(dbFile);
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  applyMigrations(db);
  openDbs.push(db);
  const previous = setDbForTest(db);
  if (prev === null) prev = previous;
  return db;
}

function makeRepo(label = "repo"): string {
  const dir = tmpRoot(label);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@forge.test");
  git(dir, "config", "user.name", "Forge Test");
  writeFileSync(join(dir, "README.md"), "# fg356 evidence\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "initial");
  return dir;
}

function startRunFor(projectDir: string): void {
  const run: Run = {
    id: RUN_ID,
    workflow: "invoke",
    title: "fg356 reaper evidence",
    status: "active",
    createdAt: "2026-07-26T00:00:00Z",
    projectDir,
  };
  insertRun(run);
}

function insertTaskRow(id: string, opts: { status: TaskStatus; workspace: string; failureKind?: string }): Task {
  const t: Task = {
    id,
    runId: RUN_ID,
    phase: "build",
    agentRole: "engineer",
    status: opts.status,
    taskPackage: { taskId: id, runId: RUN_ID, phase: "build", role: "engineer", inputs: {}, composedSystemPrompt: "" },
    createdAt: "2026-07-26T00:00:00Z",
    startedAt: "2026-07-26T00:00:01Z",
    worktreePath: opts.workspace,
  };
  insertTask(t);
  if (opts.status === "failed") {
    logEvent("task.failed", {
      runId: RUN_ID,
      taskId: id,
      payload: { failure_kind: opts.failureKind ?? "orphaned", error: "reconciled after crash" },
    });
  }
  if (opts.status === "complete") logEvent("task.completed", { runId: RUN_ID, taskId: id });
  return t;
}

type WorkspaceEvent = { type: string; payload: Record<string, unknown> };

function workspaceEvents(taskId: string): WorkspaceEvent[] {
  return eventsForTask(taskId)
    .filter((e) => e.eventType === "task.workspace_reaped" || e.eventType === "task.workspace_retained")
    .map((e) => ({ type: e.eventType, payload: (e.payload ?? {}) as Record<string, unknown> }));
}

function onlyEvent(taskId: string): WorkspaceEvent {
  const evs = workspaceEvents(taskId);
  assert.equal(evs.length, 1, `expected exactly one workspace disposition event, got ${JSON.stringify(evs)}`);
  return evs[0]!;
}

/** A mutating agent's private `--shared` clone (FG-621's substrate). */
function makePrivateClone(parent: string, taskId: string): string {
  const clone = join(tmpRoot("clone"), taskId);
  execFileSync("git", ["clone", "--quiet", "--shared", parent, clone], { stdio: ["ignore", "ignore", "pipe"] });
  git(clone, "config", "user.email", "agent@forge.test");
  git(clone, "config", "user.name", "Agent");
  git(clone, "checkout", "-q", "-b", worktreeBranchName(RUN_ID, taskId));
  return clone;
}

beforeEach(() => {
  openDbs = [];
});

afterEach(() => {
  for (const db of openDbs.splice(0)) {
    try {
      db.close();
    } catch {
      // already closed by the test
    }
  }
  if (prev) setDbForTest(prev);
  for (const dir of tmpDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

// ── Durable evidence ──────────────────────────────────────────────────────────

test("fg356 evidence: a retain event survives a store close + reopen, and the reopened process does not re-record it", () => {
  const dbFile = join(tmpRoot("db"), "forge.db");
  const repo = makeRepo();
  openStore(dbFile);
  startRunFor(repo);

  const clone = makePrivateClone(repo, "t-durable");
  writeFileSync(join(clone, "unfetched.ts"), "commits the parent never fetched\n");
  git(clone, "add", ".");
  git(clone, "commit", "-q", "-m", "agent work in a private clone");
  insertTaskRow("t-durable", { status: "failed", workspace: clone, failureKind: "orphaned" });

  reconcileRun(RUN_ID, ALIVE);
  const written = onlyEvent("t-durable");
  assert.equal(written.type, "task.workspace_retained");

  // The forge process that recorded it exits. Days later, another one opens the
  // same store — which is the only way this evidence is ever useful.
  openDbs.pop()!.close();

  const reopened = new Database(dbFile);
  reopened.pragma("foreign_keys = ON");
  openDbs.push(reopened);
  setDbForTest(reopened);

  const rehydrated = onlyEvent("t-durable");
  assert.equal(rehydrated.type, "task.workspace_retained", "the disposition outlived the process that decided it");
  assert.equal(rehydrated.payload["workspacePath"], clone, "and still names WHERE the unrecovered work is");
  assert.equal(rehydrated.payload["branch"], worktreeBranchName(RUN_ID, "t-durable"), "and on which branch");
  assert.equal(rehydrated.payload["substrate"], "private_clone");
  // FG-621: the clone is retained for a PROVEN reason now, not for its substrate
  // — its commit is in no Forge-owned ref, so the work exists only here.
  assert.equal(rehydrated.payload["reason"], "unmerged_commits");
  assert.equal(rehydrated.payload["taskStatus"], "failed");
  assert.equal(getTask("t-durable")!.worktreePath, clone, "the row still points at the workspace it named");

  // Re-entry across the restart: the dedupe reads the persisted events, not
  // in-process memory, so the second process must not re-log the same retention.
  reconcileRun(RUN_ID, ALIVE);
  reconcileRun(RUN_ID, ALIVE);
  assert.equal(workspaceEvents("t-durable").length, 1, "a restart is not a licence to re-log the same fact");
  assert.ok(existsSync(join(clone, "unfetched.ts")), "and the work is still there — the retain held across the restart");
});

// ── The substrates that are not linked worktrees ──────────────────────────────

test("fg356/fg621 evidence: a private clone that passes every proof is DISPOSED of, and the disposal is what gets recorded", () => {
  const dbFile = join(tmpRoot("db"), "forge.db");
  const repo = makeRepo();
  openStore(dbFile);
  startRunFor(repo);

  // Clean, owned by its alternates, and holding nothing the parent does not
  // already have. Before FG-621 this was retained for its SUBSTRATE alone —
  // clone disposal was unimplemented, so the reaper refused before probing
  // anything. It is now proven and disposed of, and the record says so.
  const clone = makePrivateClone(repo, "t-clone-clean");
  assert.equal(classifyWorkspace(clone), "private_clone");
  assert.equal(git(clone, "status", "--porcelain").trim(), "", "fixture: clean tree");
  insertTaskRow("t-clone-clean", { status: "complete", workspace: clone });

  reconcileRun(RUN_ID, ALIVE);

  assert.equal(existsSync(clone), false, "the directory IS the repository, so removing it disposes of both");
  const ev = onlyEvent("t-clone-clean");
  assert.equal(ev.type, "task.workspace_reaped");
  assert.equal(ev.payload["reason"], "work_captured");
  assert.equal(ev.payload["substrate"], "private_clone");
  assert.equal(ev.payload["workspacePath"], clone, "and it names the path it disposed of");
});

test("fg356/fg621 evidence: a clone whose ALTERNATES point somewhere else is retained as not-owned, however much it looks like a task workspace", () => {
  const dbFile = join(tmpRoot("db"), "forge.db");
  const repo = makeRepo();
  const stranger = makeRepo("stranger");
  openStore(dbFile);
  startRunFor(repo);

  // Same layout, same deterministic branch name, same substrate — and clean, so
  // every capture probe would sanction removing it. It is a clone of a DIFFERENT
  // repository, and the alternates target is the only thing that says so.
  const foreign = join(tmpRoot("foreign"), "t-foreign");
  execFileSync("git", ["clone", "--quiet", "--shared", stranger, foreign], { stdio: ["ignore", "ignore", "pipe"] });
  git(foreign, "checkout", "-q", "-b", worktreeBranchName(RUN_ID, "t-foreign"));
  insertTaskRow("t-foreign", { status: "complete", workspace: foreign });

  reconcileRun(RUN_ID, ALIVE);

  assert.ok(existsSync(foreign), "a clone of somebody else's repository is not forge's to delete");
  const ev = onlyEvent("t-foreign");
  assert.equal(ev.type, "task.workspace_retained");
  assert.equal(ev.payload["reason"], "workspace_not_owned");
  assert.equal(ev.payload["substrate"], "private_clone");
  assert.ok(
    (ev.payload["details"] as string[]).some((d) => d.includes("alternates")),
    "and the evidence names the proof that failed",
  );
});

test("fg356 evidence: a workspace that is neither substrate is retained as unknown_substrate — never guessed at", () => {
  const dbFile = join(tmpRoot("db"), "forge.db");
  const repo = makeRepo();
  openStore(dbFile);
  startRunFor(repo);

  // A directory forge cannot identify: no .git at all. It may be a half-created
  // workspace, a stale mount point, or something entirely else — the one thing
  // the reaper may not do is assume.
  const opaque = join(tmpRoot("opaque"), "t-unknown");
  mkdirSync(opaque, { recursive: true });
  writeFileSync(join(opaque, "unclassifiable-work.txt"), "no repository here\n");
  assert.equal(classifyWorkspace(opaque), "unknown");
  insertTaskRow("t-unknown", { status: "failed", workspace: opaque, failureKind: "orphaned" });

  reconcileRun(RUN_ID, ALIVE);

  assert.ok(existsSync(opaque), "an unidentifiable directory is not removed");
  assert.equal(readFileSync(join(opaque, "unclassifiable-work.txt"), "utf8"), "no repository here\n");
  const ev = onlyEvent("t-unknown");
  assert.equal(ev.type, "task.workspace_retained");
  assert.equal(ev.payload["reason"], "unknown_substrate");
  assert.equal(ev.payload["substrate"], "unknown");
  assert.equal(ev.payload["workspacePath"], opaque);
  assert.equal(ev.payload["branch"], worktreeBranchName(RUN_ID, "t-unknown"), "still named, so the operator can look");
});

// ── Blast radius: main checkouts ──────────────────────────────────────────────

test("fg356 evidence: the run's OWN projectDir recorded as a workspace is never reaped — the live source survives verbatim", () => {
  const dbFile = join(tmpRoot("db"), "forge.db");
  const repo = makeRepo();
  writeFileSync(join(repo, "operator-uncommitted.txt"), "the operator's live edit\n");
  openStore(dbFile);
  startRunFor(repo);

  // The no-worktree path: a task whose recorded workspace IS the shared project
  // checkout (FG-455 calls this evidence source "project_dir_shared"). Reaping it
  // would delete the operator's source tree.
  insertTaskRow("t-livesource", { status: "complete", workspace: repo });

  reconcileRun(RUN_ID, ALIVE);

  assert.ok(existsSync(repo), "a main checkout has a .git DIRECTORY, so it can never classify as a linked worktree");
  assert.equal(readFileSync(join(repo, "README.md"), "utf8"), "# fg356 evidence\n");
  assert.equal(readFileSync(join(repo, "operator-uncommitted.txt"), "utf8"), "the operator's live edit\n");
  assert.equal(git(repo, "rev-parse", "--is-inside-work-tree").trim(), "true", "and the repository itself is untouched");
  // FG-621: classification alone no longer saves it — a main checkout classifies
  // as `private_clone` and the clone branch now REAPS. What keeps it out of reach
  // is the alternates proof: no repository is ever its own alternate.
  assert.equal(onlyEvent("t-livesource").payload["reason"], "workspace_not_owned");
});

test("fg356 evidence: an unrelated repository's main checkout is not reaped either, whatever the task row claims", () => {
  const dbFile = join(tmpRoot("db"), "forge.db");
  const repo = makeRepo();
  const unrelated = makeRepo("unrelated");
  writeFileSync(join(unrelated, "somebody-elses-source.txt"), "not forge's to delete\n");
  openStore(dbFile);
  startRunFor(repo);

  insertTaskRow("t-unrelated", { status: "failed", workspace: unrelated, failureKind: "orphaned" });

  reconcileRun(RUN_ID, ALIVE);

  assert.ok(existsSync(unrelated));
  assert.equal(readFileSync(join(unrelated, "somebody-elses-source.txt"), "utf8"), "not forge's to delete\n");
  assert.equal(git(unrelated, "status", "--porcelain").trim(), "?? somebody-elses-source.txt", "untouched, down to its git state");
  assert.equal(workspaceEvents("t-unrelated").length, 1, "the refusal is recorded rather than silent");
});

// ── The evidence as an operator actually reads it ─────────────────────────────
//
// A durable event nobody can read is not evidence. `forge show`'s timeline
// renders payloads through a generic summary that prints KEY NAMES and stops
// after three, so a retention displayed as `{workspacePath, branch, substrate,
// …}` — the docs promise the timeline names WHERE the work is and WHY it was
// kept, and it named neither. This runs the real command surface, in its own
// process, against the store the reaper wrote, and greps what an operator sees.

/** `forge show` as a subprocess: real commander parsing, real on-disk store,
 *  real rendering — the thing a unit test of the renderer cannot prove. */
function forgeShow(home: string, args: string[]): string {
  const r = spawnSync(TSX, [CLI_ENTRY, "show", ...args], {
    encoding: "utf8",
    env: { ...process.env, FORGE_HOME: home, NO_NOTIFY: "true" },
  });
  assert.equal(r.status, 0, `forge show ${args.join(" ")} exited ${r.status}: ${r.stderr}`);
  return r.stdout;
}

function timelineLine(out: string, eventType: string): string {
  const line = out.split("\n").find((l) => l.includes(eventType));
  assert.ok(line, `no ${eventType} line in the rendered timeline:\n${out}`);
  return line;
}

test("fg356 evidence: `forge show` names the retained path, branch and reason as VALUES", () => {
  const home = tmpRoot("home");
  const repo = makeRepo();
  openStore(join(home, "forge.db"));
  startRunFor(repo);

  const clone = makePrivateClone(repo, "t-cli-retained");
  writeFileSync(join(clone, "unfetched.ts"), "work that exists nowhere else\n");
  insertTaskRow("t-cli-retained", { status: "failed", workspace: clone, failureKind: "orphaned" });

  // A workspace already gone whose branch outlived it — the reaper retries the
  // deletion it lost, and records a disposal with no worktree in play.
  const reapedBranch = worktreeBranchName(RUN_ID, "t-cli-reaped");
  git(repo, "branch", reapedBranch);
  insertTaskRow("t-cli-reaped", { status: "complete", workspace: join(repo, "already-gone") });

  reconcileRun(RUN_ID, ALIVE);
  assert.equal(onlyEvent("t-cli-retained").type, "task.workspace_retained");
  assert.equal(onlyEvent("t-cli-reaped").type, "task.workspace_reaped");

  // The forge process that recorded it exits; the CLI below is a different one.
  openDbs.pop()!.close();

  const retained = timelineLine(forgeShow(home, ["t-cli-retained"]), "task.workspace_retained");
  assert.ok(retained.includes(clone), `the timeline must name WHERE the work still is: ${retained}`);
  assert.ok(retained.includes(worktreeBranchName(RUN_ID, "t-cli-retained")), `...and its branch: ${retained}`);
  assert.ok(retained.includes("uncommitted_work"), `...and why it was kept: ${retained}`);
  assert.ok(!retained.includes("{workspacePath"), `key names are not evidence: ${retained}`);

  const reaped = timelineLine(forgeShow(home, ["t-cli-reaped"]), "task.workspace_reaped");
  assert.ok(reaped.includes(join(repo, "already-gone")), `a disposal names the path it disposed of: ${reaped}`);
  assert.ok(reaped.includes(reapedBranch), `...and the branch that went with it: ${reaped}`);
  assert.ok(reaped.includes("branch_deletion_retried"), `...and why: ${reaped}`);

  // Every OTHER event type keeps the generic key-name summary untouched.
  const failed = timelineLine(forgeShow(home, ["t-cli-retained"]), "task.failed");
  assert.ok(failed.includes("{failure_kind, error}"), `the generic summary must be unchanged: ${failed}`);

  // And the JSON surface is untouched — this is the human rendering only.
  const parsed = JSON.parse(forgeShow(home, ["t-cli-retained", "--json"])) as {
    events: { eventType: string; payload: Record<string, unknown> | null }[];
  };
  const ev = parsed.events.find((e) => e.eventType === "task.workspace_retained");
  assert.ok(ev, "the retain event must still be in --json");
  assert.equal(ev.payload?.["workspacePath"], clone);
  assert.equal(ev.payload?.["branch"], worktreeBranchName(RUN_ID, "t-cli-retained"));
  assert.equal(ev.payload?.["reason"], "uncommitted_work");
  assert.equal(ev.payload?.["substrate"], "private_clone");
});

// ── The retain-by-design set cannot grow uncovered ────────────────────────────

test("fg356 evidence: every kind in RETAIN_WORKSPACE_FAILURE_KINDS is exercised by the drive lane", () => {
  const source = readFileSync(new URL("./reconcile.ts", import.meta.url), "utf8");
  const block = /RETAIN_WORKSPACE_FAILURE_KINDS\s*=\s*new Set\(\[([\s\S]*?)\]\)/.exec(source);
  assert.ok(block, "RETAIN_WORKSPACE_FAILURE_KINDS must remain a literal set in src/v2/reconcile.ts");
  const kinds = [...block[1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
  assert.ok(kinds.length > 0, "parsed no kinds — the parity check would be vacuous");

  // The retain contract is enforcement, not documentation: a kind that says it
  // keeps its workspace has to be driven through reconcileRun and asserted, or
  // the guarantee is only a comment. Adding a kind above without adding it to the
  // drive lane's table fails here.
  const driveLane = readFileSync(new URL("./fg356-reaper-drive.worktree.test.ts", import.meta.url), "utf8");
  const table = /RETAIN_BY_DESIGN_KINDS\s*=\s*\[([\s\S]*?)\] as const/.exec(driveLane);
  assert.ok(table, "the drive lane must keep its retain-by-design table as a literal array");
  const covered = new Set([...table[1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!));

  for (const kind of kinds) {
    assert.ok(
      covered.has(kind),
      `${kind} retains a workspace by design but no fg356-reaper-drive.worktree.test.ts case proves it — add one`,
    );
  }
  assert.deepEqual(
    [...covered].filter((k) => !kinds.includes(k)),
    [],
    "the drive lane asserts retain-by-design for a kind production no longer retains",
  );
});
