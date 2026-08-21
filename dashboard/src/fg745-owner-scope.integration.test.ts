// FG-745 (review RF-3 / AC5) — selecting an owner project includes a SEPARATELY-
// IDENTIFIED artifact's live work in Current Activity under that owner.
//
// THE DEFECT. The Projects grid suppresses a recorded artifact (a disposable clone,
// worktree, evidence fixture). That suppression is meant to live ONLY in the Projects
// projection — run-scoping stays purpose-blind, so an active artifact's runs and live
// session must still be reachable under its OWNER. But resolveProjectScope expanded the
// selected key to that ONE record's own member paths, and an artifact whose repository
// identity does NOT converge with its owner — a private, no-remote local clone — is its
// OWN ProjectRecord. So its live work was globally queryable yet VANISHED the moment the
// operator selected its owner: exactly the AC5 regression.
//
// NON-VACUOUS BY CONSTRUCTION. The artifact carries a repository identity DIFFERENT from
// its owner's (asserted below), and the owner-identity set the scope resolves does NOT
// contain the artifact's own identity — so the FG-663 identity arm could never have
// pulled the artifact in. Only the ownership link (workspace_purposes.project_identity)
// adds its paths. Remove the fix and the artifact's running task leaves the owner scope.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// FG-607/FG-616: FORGE_HOME must be assigned BEFORE anything that transitively
// evaluates src/util/paths.ts is imported, hence the dynamic imports below.
const root = mkdtempSync(join(tmpdir(), "fg745-owner-scope-"));
const forgeHome = join(root, "forge-home");
mkdirSync(forgeHome, { recursive: true });
process.env.FORGE_HOME = forgeHome;
process.env.FORGE_PROJECT_SCAN_ROOTS = join(root, "scan-roots");
mkdirSync(process.env.FORGE_PROJECT_SCAN_ROOTS, { recursive: true });

const { getDb } = await import("../../src/store/db.js");
const { insertRun } = await import("../../src/store/runs.js");
const { repositoryCheckoutIdentity } = await import("../../src/util/repository-identity.js");
const { inFlight, recentActivity, resolveProjectScope, operatorProjectsForDashboard } = await import("./queries.js");

// ─── fixtures ────────────────────────────────────────────────────────────────
//
//   trees/owner       an OPERATOR project with a git remote → REPO_OWNER, registered
//                     to pk-owner. This is what the operator selects.
//   trees/artifact    a private, NO-REMOTE local clone → its OWN path-based repo key.
//                     Recorded as a disposable_clone OWNED by pk-owner. Has LIVE work.
//   trees/unrelated   a distinct project with its own remote and its own live work —
//                     the isolation control that must never leak into the owner scope.

const trees = join(root, "trees");
mkdirSync(trees, { recursive: true });

function checkout(name: string, remote?: string): string {
  const dir = join(trees, name);
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  if (remote) execFileSync("git", ["remote", "add", "origin", remote], { cwd: dir, stdio: "ignore" });
  return realpathSync(dir);
}

const ownerDir = checkout("owner", "git@github.com:stevebargelt/fg745-owner.git");
const artifactDir = checkout("artifact"); // no remote: a private local clone
const unrelatedDir = checkout("unrelated", "git@github.com:stevebargelt/fg745-unrelated.git");

const REPO_OWNER = repositoryCheckoutIdentity(ownerDir).key;
const REPO_ARTIFACT = repositoryCheckoutIdentity(artifactDir).key;
const REPO_UNRELATED = repositoryCheckoutIdentity(unrelatedDir).key;
const PK_OWNER = "pk-fg745-owner";

assert.notEqual(REPO_ARTIFACT, REPO_OWNER, "fixture: the artifact's repository identity must NOT converge with its owner");
assert.notEqual(REPO_UNRELATED, REPO_OWNER, "fixture: the isolation control is a genuinely distinct repository");

const AT = "2026-08-21T10:00:00Z";

const store = getDb();

// Register the owner so its evidence maps to a declared pk-; the artifact's recorded
// owner (project_identity = PK_OWNER) resolves into the owner's identity set.
store
  .prepare(
    `INSERT INTO project_identity (project_key, repo_evidence_key, repo_evidence_source, created_at)
     VALUES (?, ?, 'remote', ?)`,
  )
  .run(PK_OWNER, REPO_OWNER, AT);

// The artifact's durable purpose: a disposable clone OWNED by pk-owner. This is the ONLY
// thing that ties the separately-identified artifact back to the owner.
store
  .prepare(
    `INSERT INTO workspace_purposes (path, path_as_written, kind, project_identity, run_id, task_id, reason, source, created_at, updated_at)
     VALUES (?, ?, 'disposable_clone', ?, ?, NULL, NULL, 'creation', ?, ?)`,
  )
  .run(artifactDir, artifactDir, PK_OWNER, "run-artifact-live", AT, AT);

// The owner's own completed activity, captured through the shipping writer.
insertRun({ id: "run-owner-done", workflow: "feature", title: "owner, completed", status: "complete", createdAt: AT, completedAt: AT, projectDir: ownerDir });

// The artifact's LIVE work — an active run with a running task.
insertRun({ id: "run-artifact-live", workflow: "feature", title: "artifact, live", status: "active", createdAt: AT, projectDir: artifactDir });

// The isolation control's live work.
insertRun({ id: "run-unrelated-live", workflow: "feature", title: "unrelated, live", status: "active", createdAt: AT, projectDir: unrelatedDir });

function completedTask(id: string, runId: string): void {
  store
    .prepare(
      `INSERT INTO tasks (id, run_id, phase, agent_role, status, task_package, result, created_at, started_at, completed_at)
       VALUES (?, ?, 'implementation', 'engineer', 'complete', '{}', '{"ok":true}', ?, ?, ?)`,
    )
    .run(id, runId, AT, AT, "2026-08-21T10:05:00Z");
}
function runningTask(id: string, runId: string): void {
  store
    .prepare(
      `INSERT INTO tasks (id, run_id, phase, agent_role, status, task_package, created_at, started_at)
       VALUES (?, ?, 'implementation', 'engineer', 'running', '{}', ?, ?)`,
    )
    .run(id, runId, AT, AT);
}
completedTask("task-owner-done", "run-owner-done");
runningTask("task-artifact-live", "run-artifact-live");
runningTask("task-unrelated-live", "run-unrelated-live");

// The owner-identity set the scope resolves. Proving the artifact's OWN identity is not
// in it makes the fix non-vacuous: the identity arm could not have caught the artifact.
assert.ok(
  !new Set([REPO_OWNER, PK_OWNER]).has(REPO_ARTIFACT),
  "fixture: the artifact's identity is NOT one the owner scope resolves — only the ownership link can add it",
);

const runIds = (entries: ReadonlyArray<{ runId: string }>): string[] => [...new Set(entries.map((e) => e.runId))].sort();

// ─── the fix ──────────────────────────────────────────────────────────────────

test("resolveProjectScope expands an owner key to include its separately-identified artifact's paths", () => {
  const scope = resolveProjectScope(REPO_OWNER);
  assert.ok(Array.isArray(scope), "an owner key resolves to a member-path array");
  assert.ok(scope.includes(ownerDir), "the owner's own member path is in scope");
  assert.ok(scope.includes(artifactDir), "AC5: the owned artifact's member path is pulled into the owner scope");
  assert.ok(!scope.includes(unrelatedDir), "isolation: an unrelated project's path is never added");
});

test("inFlight scoped to the owner surfaces the artifact's LIVE task, and never the unrelated one (AC5)", () => {
  const scope = resolveProjectScope(REPO_OWNER);
  const live = inFlight(scope, () => "alive");
  const taskIds = live.map((e) => e.taskId).sort();
  assert.ok(taskIds.includes("task-artifact-live"), "the separately-identified artifact's live work appears under its owner");
  assert.ok(!taskIds.includes("task-unrelated-live"), "no other project's live work leaks into the owner scope");
});

test("recentActivity scoped to the owner includes the owner's own completed run", () => {
  const scope = resolveProjectScope(REPO_OWNER);
  const ids = runIds(recentActivity(100, undefined, scope));
  assert.ok(ids.includes("run-owner-done"), "the owner's own activity is unaffected by the artifact expansion");
});

test("the artifact stays SUPPRESSED from the Projects grid — suppression lives only in the projection", () => {
  const grid = operatorProjectsForDashboard();
  const keys = grid.map((p) => p.key);
  assert.ok(keys.includes(REPO_OWNER), "the owner is a first-class operator project");
  assert.ok(!keys.includes(REPO_ARTIFACT), "the disposable-clone artifact is NOT a peer operator project");
});

test.after(() => {
  rmSync(root, { recursive: true, force: true });
});
