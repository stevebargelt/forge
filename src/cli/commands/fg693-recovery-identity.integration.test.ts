// FG-693 (step 11): TERMINAL-RUN CLEANUP AND RECOVERY — the most destructive
// consumers — decided by the ONE filesystem-identity contract.
//
// WHY THESE TWO MODULES SHARE A FILE. They are the two halves of one question:
// "is the tree I am about to act on the same tree the run is FOR?" `forge
// recover` asks it to decide whether a diff is the agent's or the operator's;
// the reaper asks it immediately before an irreversible `rm`. Both answered it
// from raw strings, and both take the ACTING-class projection now: an unproven
// identity never authorizes a delete, a reclaim, or a shared-checkout
// classification (src/util/path-identity.ts).
//
// AC5 IS TAKEN LITERALLY. Every case below drives a REAL production entry point
// — performInspect / performContinue for recover, reapTaskWorkspace and
// removeWorktreeIfSafe for the reaper — and asserts on what those entry points
// DID (refused / adopted / retained / removed, and whether the directory still
// exists). Not one assertion reads compareIdentity's return value.
//
// THE TWO DEFECTS, both reachable and both demonstrated below.
//
//   1. RECOVER'S --force GATE WENT INERT. `--continue` adopts a task's persisted
//      work irreversibly. When the evidence came from the shared project
//      checkout it demands an explicit --force, because the diff may be the
//      operator's own uncommitted work. That gate was `task.worktreePath ? ... :
//      ...` — a presence check on a STRING. A worktree path recorded as another
//      SPELLING of run.projectDir (symlinked parent, trailing separator,
//      relative) named the shared checkout and classified as a DEDICATED
//      workspace, so the gate never fired.
//
//   2. THE REAPER DELETED THE PROJECT CHECKOUT. Both of the reaper's ownership
//      proofs interrogate git ABOUT the recorded path — which repository, which
//      branch, whose object store. None asked the prior question: is this tree
//      the one being reaped FROM? When run.projectDir is itself a linked
//      worktree sitting on the task's own branch, both halves of
//      ownershipMismatch compare that tree against ITSELF and pass, the capture
//      checks pass trivially (its HEAD is reachable from its own HEAD), and the
//      reaper force-removes run.projectDir. The alias spelling is what makes
//      this FG-693's rather than a stray equality check: a naive
//      `workspacePath === projectDir` fix passes every string test and still
//      deletes the tree here.
//
// PORTABLE BY CONSTRUCTION. Every alias below is one this file CREATES — a
// symlinked parent, a trailing separator, a relative spelling — so Linux CI
// carries the class natively (AC9). None depends on an alias a particular OS
// happens to provide, which is exactly why the earlier coverage was CI-green and
// host-red.
//
// HOST (darwin): the same seams must be re-run against the NATIVE aliases —
// /var/... vs /private/var/..., which is where forge's own worktree roots and
// every mkdtemp fixture actually live, so on darwin the two spellings arise
// without anyone creating a symlink. A green Linux run is not evidence for this
// ticket.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { tmpdir } from "node:os";
import type { Database as DatabaseInstance } from "better-sqlite3";

import { makeInMemoryDb, setDbForTest } from "../../store/db.js";
import { insertRun } from "../../store/runs.js";
import { insertTask, getTask } from "../../store/tasks.js";
import { logEvent } from "../../store/events.js";
import { reconcileRun } from "../../v2/reconcile.js";
import { taskDir } from "../../util/paths.js";
import { reapTaskWorkspace, removeWorktreeIfSafe, worktreeBranchName, classifyWorkspace } from "../../v2/worktree-lifecycle.js";
import { performInspect, performContinue } from "./recover.js";
import type { Run, Task } from "../../types/index.js";

const RUN_ID = "run-fg693-recovery";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
const tmpDirs: string[] = [];
let cwdBefore: string;
let ephemeralBefore: string | undefined;

/** A temp root, REALPATHED: on darwin `mkdtemp` hands back a `/var/...` spelling
 *  whose physical path is `/private/var/...`, and a fixture that starts from the
 *  aliased spelling would compare two aliases rather than an alias against a
 *  canonical path. The aliases under test are the ones this file creates. */
function tmpRoot(label: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `forge-fg693rec-${label}-`)));
  tmpDirs.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function makeRepo(label = "repo"): string {
  const dir = tmpRoot(label);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@forge.test");
  git(dir, "config", "user.name", "Forge Test");
  writeFileSync(join(dir, "README.md"), "# fg693 recovery identity\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "initial");
  return dir;
}

/** `target` reached through a symlinked PARENT — the alias class that exists on
 *  every platform, and the one an operator creates without thinking about it
 *  (`~/src` -> a volume, a `current` link, a home under an automounter). */
function symlinkedSpellingOf(target: string, label: string): string {
  const root = tmpRoot(`link-${label}`);
  const link = join(root, "via-link");
  symlinkSync(target, link, "dir");
  return link;
}

function mkTask(id: string, o: Partial<Task> = {}): Task {
  const runId = o.runId ?? RUN_ID;
  return {
    id,
    runId,
    phase: o.phase ?? "task",
    agentRole: o.agentRole ?? "engineer",
    status: o.status ?? "running",
    taskPackage: { taskId: id, runId, phase: o.phase ?? "task", role: o.agentRole ?? "engineer", inputs: {}, composedSystemPrompt: "" },
    createdAt: "2026-08-01T00:00:00Z",
    startedAt: "2026-08-01T00:00:01Z",
    ...o,
  };
}

/** Insert a run + a containerized task, then reconcile it into the `orphaned`
 *  failure kind `--continue` accepts. This is the production route to the state
 *  the gate under test guards; nothing is hand-stamped. */
function orphanedTask(id: string, projectDir: string | undefined, worktreePath: string | undefined): void {
  const run: Run = {
    id: RUN_ID,
    workflow: "invoke",
    title: "fg693 recovery identity",
    status: "active",
    createdAt: "2026-08-01T00:00:00Z",
    ...(projectDir ? { projectDir } : {}),
  };
  insertRun(run);
  const task = mkTask(id, { status: "running", ...(worktreePath ? { worktreePath } : {}) });
  insertTask(task);
  logEvent("container.started", { runId: RUN_ID, taskId: id, payload: { containerName: `forge-${id}` } });
  reconcileRun(RUN_ID, () => false);
  assert.equal(getTask(id)!.status, "failed", "the fixture must reach the state --continue guards");
}

/** A valid result.json in the task's own directory — adoption evidence that does
 *  NOT come from the project path, so a case can exercise the identity gate
 *  without also needing a readable diff. */
function writeAdoptableResult(taskId: string): void {
  const dir = taskDir(RUN_ID, taskId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "result.json"), JSON.stringify({ status: "complete", tests_run: 1 }));
}

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  cwdBefore = process.cwd();
  ephemeralBefore = process.env["FORGE_WORKTREES_EPHEMERAL"];
});

afterEach(() => {
  process.chdir(cwdBefore);
  if (ephemeralBefore === undefined) delete process.env["FORGE_WORKTREES_EPHEMERAL"];
  else process.env["FORGE_WORKTREES_EPHEMERAL"] = ephemeralBefore;
  setDbForTest(prev as DatabaseInstance);
  db.close();
  for (const dir of tmpDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

// ── recover: the --force gate, through performInspect / performContinue ───────

test("FG-693 AC5 (recover): a worktree path that is ANOTHER SPELLING of run.projectDir is shared, not dedicated — --continue refuses without --force", () => {
  const checkout = makeRepo("shared");
  writeFileSync(join(checkout, "operator-uncommitted.txt"), "the operator's own live edit\n");
  const alias = symlinkedSpellingOf(checkout, "shared");

  // The whole point: these are DIFFERENT STRINGS naming ONE tree. A gate built
  // on string equality — or, as it was, on mere presence — cannot see this.
  assert.notEqual(alias, checkout, "the fixture must not be trivially string-equal");
  assert.equal(realpathSync(alias), checkout, "…but it must be one tree");

  orphanedTask("t-alias", checkout, alias);

  const inspected = performInspect("t-alias");
  assert.equal(inspected.kind, "inspect-task");
  if (inspected.kind !== "inspect-task") return;
  assert.equal(inspected.task.source, "project_dir_shared", "an aliased spelling is the SHARED checkout, not a dedicated workspace");
  assert.match(inspected.task.recommendation, /--force/, "and the recommended command says so");

  const refused = performContinue("t-alias");
  assert.equal(refused.kind, "continue-refused", "adopting the operator's own diff must not proceed unforced");
  assert.equal(getTask("t-alias")!.status, "failed", "a refusal writes nothing");
  if (refused.kind !== "continue-refused") return;
  assert.match(refused.reason, /project_dir_shared/);
  assert.match(refused.reason, /SAME tree spelled two different ways/, "and it names WHY the recorded worktree path did not count");

  // --force is still the operator's acknowledged escape, unchanged.
  const forced = performContinue("t-alias", { force: true });
  assert.equal(forced.kind, "continued");
  assert.equal(getTask("t-alias")!.status, "complete");
});

test("FG-693 AC2/AC5 (recover): a trailing-separator and a relative spelling of run.projectDir are shared too", () => {
  const checkout = makeRepo("spellings");
  writeFileSync(join(checkout, "operator-uncommitted.txt"), "live edit\n");

  orphanedTask("t-trailing", checkout, checkout + sep);
  const trailing = performInspect("t-trailing");
  assert.equal(trailing.kind === "inspect-task" && trailing.task.source, "project_dir_shared");
  assert.equal(performContinue("t-trailing").kind, "continue-refused");

  // A relative spelling resolves against the CURRENT working directory, which is
  // why it is identity only once the filesystem has answered for it.
  process.chdir(dirname(checkout));
  db.exec("DELETE FROM tasks; DELETE FROM events; DELETE FROM runs");
  orphanedTask("t-relative", checkout, basename(checkout));
  const relative = performInspect("t-relative");
  assert.equal(relative.kind === "inspect-task" && relative.task.source, "project_dir_shared");
  assert.equal(performContinue("t-relative").kind, "continue-refused");
});

test("FG-693 AC7 (recover, NEGATIVE CONTROL): a genuinely dedicated workspace whose path SHARES A LEXICAL PREFIX with the project dir still adopts unforced", () => {
  const root = tmpRoot("prefix");
  const checkout = join(root, "checkout");
  const dedicated = join(root, "checkout-task"); // a lexical prefix of nothing useful — and a different tree
  mkdirSync(checkout, { recursive: true });
  mkdirSync(dedicated, { recursive: true });
  for (const dir of [checkout, dedicated]) {
    git(dir, "init", "-q", "-b", "main");
    git(dir, "config", "user.email", "test@forge.test");
    git(dir, "config", "user.name", "Forge Test");
  }
  writeFileSync(join(dedicated, "agent-output.ts"), "export const work = 1;\n");

  orphanedTask("t-dedicated", checkout, dedicated);

  const inspected = performInspect("t-dedicated");
  assert.equal(inspected.kind === "inspect-task" && inspected.task.source, "worktree", "distinct trees stay distinct");

  const continued = performContinue("t-dedicated");
  assert.equal(continued.kind, "continued", "the gate must not degenerate into 'always refuse'");
  assert.equal(continued.kind === "continued" ? continued.adoptedFrom : "", "diff_adopted");
});

test("FG-693 AC5 (recover): an UNRESOLVABLE side is its own disposition — it refuses, and names which side the filesystem would not answer for", () => {
  const checkout = makeRepo("unresolvable");
  writeFileSync(join(checkout, "operator-uncommitted.txt"), "live edit\n");
  const goneWorkspace = join(dirname(checkout), "reaped-workspace");

  orphanedTask("t-unresolved-workspace", checkout, goneWorkspace);
  // An adoptable result on disk, so the gate under test is what refuses rather
  // than the earlier "nothing to adopt" arm. The identity question only ever
  // arises for a task that HAS something to adopt.
  writeAdoptableResult("t-unresolved-workspace");

  const inspected = performInspect("t-unresolved-workspace");
  assert.equal(inspected.kind, "inspect-task");
  if (inspected.kind !== "inspect-task") return;
  assert.equal(inspected.task.source, "identity_unproven", "unproven is NOT silently promoted to a dedicated workspace…");
  assert.notEqual(inspected.task.source, "project_dir_shared", "…and it is NOT silently folded into the shared classification either");
  assert.ok(
    (inspected.task.unprovenIdentity ?? []).some((d) => d.includes("recorded worktree path") && d.includes("UNRESOLVED")),
    "the diagnostic names the side that could not be resolved, labelled as unresolved",
  );

  const refused = performContinue("t-unresolved-workspace");
  assert.equal(refused.kind, "continue-refused");
  assert.equal(getTask("t-unresolved-workspace")!.status, "failed", "a refusal writes nothing");
  if (refused.kind !== "continue-refused") return;
  assert.match(refused.reason, /could not be PROVEN distinct/);
  assert.match(refused.reason, /never authorizes an irreversible adoption/);
});

test("FG-693 AC5 (recover): an unresolvable PROJECT DIR refuses too, and says it was the project dir", () => {
  const root = tmpRoot("gone-project");
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  git(workspace, "init", "-q", "-b", "main");
  writeFileSync(join(workspace, "agent-output.ts"), "export const work = 1;\n");

  orphanedTask("t-unresolved-project", join(root, "never-existed"), workspace);

  const inspected = performInspect("t-unresolved-project");
  assert.equal(inspected.kind, "inspect-task");
  if (inspected.kind !== "inspect-task") return;
  assert.equal(inspected.task.source, "identity_unproven");
  assert.ok(
    (inspected.task.unprovenIdentity ?? []).some((d) => d.includes("run project dir")),
    "the operator is told WHICH side, not just that something failed",
  );
  assert.equal(performContinue("t-unresolved-project").kind, "continue-refused");
});

// ── the reaper: reapTaskWorkspace, at its real entry point ────────────────────
//
// The fixture below is the reachable shape both git-level ownership proofs miss.
// `shared` is a LINKED WORKTREE of `parent` with the task's own deterministic
// branch checked out, and it is ALSO the run's project dir. So:
//   • gitCommonDir(workspace) === gitCommonDir(projectDir)  — same tree
//   • checkedOutRef(workspace) === refs/heads/<task branch> — same tree
//   • its HEAD is reachable from its own HEAD                — same tree
// Every proof passes by comparing the tree against ITSELF, and the reaper
// force-removes run.projectDir.

function sharedLinkedCheckout(taskId: string): { parent: string; shared: string; branch: string } {
  const parent = makeRepo("parent");
  const branch = worktreeBranchName(RUN_ID, taskId);
  const shared = join(tmpRoot("shared-root"), "checkout");
  git(parent, "worktree", "add", "-q", "-b", branch, shared);
  return { parent, shared, branch };
}

test("FG-693 AC5 (reaper): a workspace path that is another SPELLING of run.projectDir is RETAINED — the project checkout is never reaped", () => {
  const { shared } = sharedLinkedCheckout("t-reap-alias");
  assert.equal(classifyWorkspace(shared), "linked_worktree", "the substrate the git-level ownership proofs cannot save");
  const alias = symlinkedSpellingOf(shared, "reap");
  assert.notEqual(alias, shared, "different strings…");
  assert.equal(realpathSync(alias), shared, "…one tree");

  const outcome = reapTaskWorkspace(alias, RUN_ID, "t-reap-alias", shared);

  assert.equal(outcome.action, "retained", "removing run.projectDir is never a reap");
  assert.equal(outcome.action === "retained" ? outcome.reason : "", "workspace_not_owned");
  assert.ok(
    outcome.action === "retained" && outcome.details.some((d) => d.includes("ONE tree")),
    "and the evidence names the identity failure specifically, not a git-level one",
  );
  assert.ok(existsSync(shared), "the run's project directory survives");
  assert.ok(existsSync(join(shared, "README.md")));
});

test("FG-693 AC5 (reaper): an UNRESOLVABLE project dir declines the removal and says which side — it never falls through to a delete", () => {
  const { shared } = sharedLinkedCheckout("t-reap-gone-project");
  const workspace = join(tmpRoot("reap-ws"), "workspace");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "agent-output.ts"), "export const work = 1;\n");

  const outcome = reapTaskWorkspace(workspace, RUN_ID, "t-reap-gone-project", join(dirname(shared), "never-existed"));

  assert.equal(outcome.action, "retained");
  assert.equal(outcome.action === "retained" ? outcome.reason : "", "workspace_not_owned");
  assert.ok(
    outcome.action === "retained" && outcome.details.some((d) => d.includes("project directory") && d.includes("UNRESOLVED")),
    "the retention names the unresolved side and labels it unresolved",
  );
  assert.ok(existsSync(join(workspace, "agent-output.ts")), "an unproven identity never authorizes a delete");
});

test("FG-693 AC7 (reaper, NEGATIVE CONTROL): a genuinely dedicated worktree under a PREFIX-SHARING sibling path is still recognised as dedicated and is still reaped", () => {
  const parent = makeRepo("parent-ctl");
  const root = tmpRoot("ctl-root");
  const shared = join(root, "checkout");
  const dedicated = join(root, "checkout-task"); // shares the lexical prefix with the project dir
  const branch = worktreeBranchName(RUN_ID, "t-reap-ctl");
  git(parent, "worktree", "add", "-q", shared);
  git(parent, "worktree", "add", "-q", "-b", branch, dedicated);

  const outcome = reapTaskWorkspace(dedicated, RUN_ID, "t-reap-ctl", shared);

  assert.equal(outcome.action, "reaped", "a shared lexical prefix is not shared identity — the reaper must still work");
  assert.equal(existsSync(dedicated), false);
  assert.ok(existsSync(shared), "and it took only the tree it was asked about");
});

// ── the reaper: removeWorktreeIfSafe, the dispatch-path disposal ──────────────

test("FG-693 AC5 (dispatch disposal): removeWorktreeIfSafe declines an aliased spelling of run.projectDir, by name", () => {
  process.env["FORGE_WORKTREES_EPHEMERAL"] = "1"; // the eligible-to-remove branch
  const { shared } = sharedLinkedCheckout("t-remove-alias");
  const alias = symlinkedSpellingOf(shared, "remove");

  const outcome = removeWorktreeIfSafe(alias, RUN_ID, "t-remove-alias", shared, true);

  assert.equal(outcome.removed, false);
  assert.equal(outcome.reason, "identity_not_proven_distinct", "a declining destructive path says WHY it declined");
  assert.ok(outcome.details.some((d) => d.includes("ONE tree")));
  assert.ok(existsSync(join(shared, "README.md")), "the project checkout survives");
});

test("FG-693 AC5 (dispatch disposal): removeWorktreeIfSafe declines when the project dir is unresolvable, and still reports the ordinary dispositions", () => {
  process.env["FORGE_WORKTREES_EPHEMERAL"] = "1";
  const root = tmpRoot("remove-gone");
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "agent-output.ts"), "export const work = 1;\n");

  const unproven = removeWorktreeIfSafe(workspace, RUN_ID, "t-remove-gone", join(root, "never-existed"), true);
  assert.equal(unproven.removed, false);
  assert.equal(unproven.reason, "identity_not_proven_distinct");
  assert.ok(unproven.details.some((d) => d.includes("project directory") && d.includes("UNRESOLVED")));
  assert.ok(existsSync(join(workspace, "agent-output.ts")));

  // The no-discard invariant still decides FIRST, and an absent path is still
  // the idempotent no-op it always was — the identity guard did not displace
  // either of them.
  const parent = makeRepo("remove-ordinary");
  assert.equal(removeWorktreeIfSafe(join(root, "never-made"), RUN_ID, "t-remove-gone", parent, true).reason, "absent");
  delete process.env["FORGE_WORKTREES_EPHEMERAL"];
  assert.equal(
    removeWorktreeIfSafe(workspace, RUN_ID, "t-remove-gone", parent, false).reason,
    "not_eligible",
    "the no-discard invariant is still evaluated before anything touches the filesystem",
  );
  assert.ok(existsSync(join(workspace, "agent-output.ts")));
});
