// FG-666: THROUGH THE PRODUCTION DISPATCH SEAM.
//
// NOTHING here calls a backlog-authority primitive. A test that constructs the
// resolver's INPUT itself cannot detect a caller passing the wrong input — which is
// precisely why FG-621's substrate change, from linked worktrees (which converge
// with their parent's repository evidence) to private clones (which do not), went
// unnoticed for twelve consecutive dispatches. Every FG-608 test called
// prepareBacklogSnapshotMount(projectDir, …) directly, so the argument production
// stopped being exercised.
//
// Every case therefore drives runContainer through runNext with an INJECTED
// dockerExec, exactly the shape ten existing *.worktree.test.ts files use, and
// asserts on what the production path produced: the marker, the argv, the mounted
// snapshot's contents, and the events.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest, writeTransaction } from "../store/db.js";
import { upsertTicket, setStorageMode, ensureStorageMode } from "../store/tickets.js";
import { clearBacklogStoreCache } from "../backlog/storage-mode.js";
import { computeRepositoryEvidence } from "../store/project-registry.js";
import { SNAPSHOT_DB_BASENAME } from "../backlog/snapshot.js";
import { tasksForRun } from "../store/tasks.js";
import { eventsForTask } from "../store/events.js";
import { startRun } from "./startRun.js";
import { runNext } from "./runNext.js";
import { backlogSnapshotHostDir } from "./spawn.js";
import { publishFlatAsGeneration } from "./seed-generation.testkit.js";
import type { Workflow } from "./schema.js";
import type { DockerExecFn } from "./docker-exec.js";

// ─── Workflow fixture: one engineer step, auto gate, no reds ─────────────────

const SEAM_WORKFLOW: Workflow = {
  name: "fg666-seam-test",
  description: "FG-666 dispatch-seam test: single step",
  review_mode: "legacy_verdict",
  inputs: [],
  steps: [
    {
      id: "build",
      agent: "engineer",
      gate: "auto",
      manual: false,
      depends_on: [],
      runtime: "fg666-seam-test",
      reds: [],
    },
  ],
};

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
const dirs: string[] = [];

const ENV_VARS = [
  "FORGE_WORKTREES",
  "FORGE_NO_WORKTREES",
  "FORGE_WORKTREE_IGNORE_DIRTY",
  "FORGE_WORKTREES_EPHEMERAL",
  "FORGE_NO_NM_SHADOW",
  "ANTHROPIC_API_KEY",
] as const;
const savedEnv: Partial<Record<(typeof ENV_VARS)[number], string>> = {};

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  clearBacklogStoreCache();
  for (const k of ENV_VARS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  process.env.FORGE_WORKTREES = "0";
  // The FG-376 named-volume path is darwin-only and needs a lockfile; these
  // fixtures have neither. Pinned off so the platform override below (which the
  // clone substrate requires) cannot drag the dependency block in with it.
  process.env.FORGE_NO_NM_SHADOW = "1";
  ensureSeamRuntime("fg666-seam-test");
});

afterEach(() => {
  setPlatform(REAL_PLATFORM);
  setDbForTest(prev as DatabaseInstance);
  db.close();
  for (const k of ENV_VARS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k] as string;
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  clearBacklogStoreCache();
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

const REAL_PLATFORM = process.platform;
const NOW = "2026-08-03T00:00:00Z";

function setPlatform(p: string): void {
  Object.defineProperty(process, "platform", { value: p, configurable: true });
}

/** The private-clone substrate IS the defect's substrate. isWorktreeModeEnabled +
 *  preflightWorktreeGate are both macOS-gated, so a clone dispatch cannot be driven
 *  on any other platform — the same override fg351-dispatch.worktree.test.ts uses. */
function armCloneSubstrate(): void {
  setPlatform("darwin");
  delete process.env.FORGE_NO_WORKTREES;
  process.env.FORGE_WORKTREES = "1";
  process.env.FORGE_WORKTREE_IGNORE_DIRTY = "1";
}

/** Mount the project directory itself — no workspace substitution at all. */
function armDirectSubstrate(): void {
  setPlatform(REAL_PLATFORM);
  delete process.env.FORGE_WORKTREES;
  process.env.FORGE_NO_WORKTREES = "1";
}

function newDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: ["ignore", "ignore", "pipe"] });
}

function ensureSeamRuntime(name: string): void {
  const forgeHome = process.env.FORGE_HOME!;
  const runtimePath = join(forgeHome, "runtimes", `${name}.yml`);
  mkdirSync(dirname(runtimePath), { recursive: true });
  writeFileSync(
    runtimePath,
    `name: ${name}
description: FG-666 dispatch-seam test runtime stub
image: test-image:latest
models:
  default: test-model
auth:
  mode: apikey
env: {}
mounts:
  - host: "\${TASK_DIR}"
    container: /task
    mode: rw
  - host: "\${PROJECT_DIR}"
    container: /project
    mode: "\${PROJECT_MODE:-rw}"
invocation:
  command: echo
  args: ["stub"]
container:
  name: "forge-\${TASK_ID}"
  remove_on_exit: true
result:
  file: /task/result.json
`,
  );
  publishFlatAsGeneration(forgeHome);
}

function initRepo(prefix: string, remote?: string): string {
  const dir = newDir(prefix);
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "test@forge.test"]);
  git(dir, ["config", "user.name", "Forge Test"]);
  if (remote) git(dir, ["remote", "add", "origin", remote]);
  writeFileSync(join(dir, "README.md"), "# fixture\n");
  return dir;
}

/** A real git repository, cut over to the db backlog store, with its project_key
 *  COMMITTED (as FG-608 commits it) so every private clone inherits it, and its
 *  repository evidence registered (as `forge backlog migrate` registers it).
 *
 *  `remote` selects which rung of the identity ladder the parent's evidence comes
 *  off: a normalized remote when one is set, the git common dir when none is. Both
 *  are ordinary shapes, and they diverge from a private clone for DIFFERENT reasons
 *  — see the substrate-contrast test below. */
function dbModeProject(
  projectKey: string,
  ticketId: string,
  body: string,
  opts: { remote?: string } = {},
): string {
  const dir = initRepo("fg666-seam-proj-", opts.remote);
  mkdirSync(join(dir, ".forge"), { recursive: true });
  writeFileSync(join(dir, ".forge", "config.yml"), `project_key: ${projectKey}\n`);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", "initial"]);

  writeTransaction(() => {
    ensureStorageMode(projectKey, NOW);
    upsertTicket({
      projectKey,
      ticketId,
      type: "story",
      status: "active",
      title: `title ${ticketId}`,
      body,
      importedAt: NOW,
    });
  });
  setStorageMode(projectKey, "db", NOW);
  const evidence = computeRepositoryEvidence(dir);
  db.prepare(
    `INSERT OR REPLACE INTO project_identity (project_key, repo_evidence_key, repo_evidence_source, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run(projectKey, evidence.key, evidence.source, NOW);
  clearBacklogStoreCache();
  return dir;
}

/** An UNRELATED repository that committed someone else's project_key — the copied
 *  `.forge/config.yml` FG-608's cross-repository guard exists to refuse. */
function foreignRepoWithCopiedKey(projectKey: string): string {
  const dir = initRepo("fg666-seam-foreign-");
  mkdirSync(join(dir, ".forge"), { recursive: true });
  writeFileSync(join(dir, ".forge", "config.yml"), `project_key: ${projectKey}\n`);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", "initial"]);
  clearBacklogStoreCache();
  return dir;
}

/** A plain git repository with NO project_key at all — the NORMAL markdown-mode /
 *  non-forge outcome, which must dispatch untouched. */
function markdownProject(): string {
  const dir = initRepo("fg666-seam-md-");
  mkdirSync(join(dir, "backlog", "stories"), { recursive: true });
  writeFileSync(
    join(dir, "backlog", "stories", "FG-1-x.md"),
    `---\nid: FG-1\ntype: story\nstatus: active\ntitle: x\n---\n\nbody\n`,
  );
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", "initial"]);
  clearBacklogStoreCache();
  return dir;
}

type ExecCapture = { calls: number; args: string[] };

function capturingExec(capture: ExecCapture): DockerExecFn {
  return async ({ args, stdoutPath, stderrPath }) => {
    capture.calls += 1;
    capture.args = [...args];
    const d = dirname(stdoutPath);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "result.json"), JSON.stringify({ status: "complete", tests_run: 1, tests_passed: 1 }));
    writeFileSync(stdoutPath, "stub stdout");
    writeFileSync(stderrPath, "");
    return 0;
  };
}

function primaryTask(runId: string) {
  const t = tasksForRun(runId).find((x) => x.phase === "build" && x.parentId === undefined);
  assert.ok(t, "primary build task must exist");
  return t!;
}

function snapshotBindSource(args: string[]): string | undefined {
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === "-v" && args[i + 1]!.includes(":/forge-backlog:ro")) return args[i + 1]!.split(":")[0];
  }
  return undefined;
}

function readMarker(hostDir: string): { mode: string; projectKey: string | null } {
  return JSON.parse(readFileSync(join(hostDir, "authority.json"), "utf8")) as {
    mode: string;
    projectKey: string | null;
  };
}

function evidenceKey(dir: string): string {
  return computeRepositoryEvidence(dir).key;
}

async function dispatch(projectDir: string, exec: DockerExecFn, opts: { ticketId?: string; title?: string } = {}) {
  const { runId } = startRun({
    workflow: SEAM_WORKFLOW,
    title: opts.title ?? "fg666 seam",
    inputs: opts.ticketId ? { ticketId: opts.ticketId } : {},
    projectDir,
  });
  const wave = await runNext({ runId, workflow: SEAM_WORKFLOW, dockerExec: exec });
  return { runId, wave };
}

/** Everything the production path asserted about ONE dispatch's ticket authority:
 *  the marker it wrote, the directory it bound `:ro` into the container, and the
 *  bodies actually readable through that mount. */
function dispatchedAuthority(runId: string, capture: ExecCapture) {
  const task = primaryTask(runId);
  const hostDir = backlogSnapshotHostDir(task.id);
  dirs.push(hostDir);
  const snapshotPath = join(hostDir, SNAPSHOT_DB_BASENAME);
  return {
    task,
    hostDir,
    marker: readMarker(hostDir),
    boundSource: snapshotBindSource(capture.args),
    hasSnapshot: existsSync(snapshotPath),
    ticketBody: (ticketId: string): string | undefined => {
      if (!existsSync(snapshotPath)) return undefined;
      const snap = new Database(snapshotPath, { readonly: true });
      try {
        const row = snap.prepare(`SELECT body FROM tickets WHERE ticket_id = ?`).get(ticketId) as
          | { body: string }
          | undefined;
        return row?.body;
      } finally {
        snap.close();
      }
    },
    unresolvedSignals: eventsForTask(task.id).filter(
      (e) => e.eventType === "container.backlog_authority_unresolved",
    ),
  };
}

// ─── (1) A REMOTE-BEARING project: the parent and its private clone ──────────

test("FG-666 (1): a remote-bearing project resolves db + the correct project_key from BOTH the parent and a private-clone dispatch", async () => {
  const KEY = "pk-fg666-remote";
  const BODY = "THE-ACCEPTANCE-CRITERIA-THE-AGENT-MUST-BE-ABLE-TO-READ";
  const projectDir = dbModeProject(KEY, "FG-1", BODY, { remote: "https://example.com/fg666.git" });

  armDirectSubstrate();
  const direct: ExecCapture = { calls: 0, args: [] };
  const parent = await dispatch(projectDir, capturingExec(direct), { ticketId: "FG-1" });
  assert.deepEqual(parent.wave.failedSteps, []);
  assert.equal(direct.calls, 1);
  const parentAuthority = dispatchedAuthority(parent.runId, direct);
  assert.equal(parentAuthority.marker.mode, "db");
  assert.equal(parentAuthority.marker.projectKey, KEY);

  armCloneSubstrate();
  const cloned: ExecCapture = { calls: 0, args: [] };
  const clone = await dispatch(projectDir, capturingExec(cloned), { ticketId: "FG-1" });
  assert.deepEqual(clone.wave.failedSteps, [], "the clone-dispatched task must not fail");
  assert.equal(cloned.calls, 1);

  const cloneAuthority = dispatchedAuthority(clone.runId, cloned);
  // The substrate really is a private clone whose own evidence diverges — otherwise
  // this proves nothing about the defect.
  assert.ok(cloneAuthority.task.worktreePath, "the task ran in an isolated workspace");
  assert.notEqual(
    evidenceKey(cloneAuthority.task.worktreePath!),
    evidenceKey(projectDir),
    "and that workspace's repository evidence genuinely DIVERGES from the project's",
  );
  assert.equal(cloneAuthority.marker.mode, "db", "authority resolves to the project's real store, not `unknown`");
  assert.equal(cloneAuthority.marker.projectKey, KEY, "and to the CORRECT project_key");

  // `forge backlog show FG-1` inside the container answers rather than refuses: the
  // artifact exists before the container starts and carries the ticket's body.
  assert.equal(cloneAuthority.boundSource, cloneAuthority.hostDir, "the argv binds the snapshot directory read-only");
  assert.equal(cloneAuthority.ticketBody("FG-1"), BODY);
});

// ─── (2) A REMOTELESS project: the other evidence rung ──────────────────────

test("FG-666 (2): a REMOTELESS project resolves db + the correct project_key from BOTH the parent and a private-clone dispatch", async () => {
  const KEY = "pk-fg666-remoteless";
  const BODY = "REMOTELESS-ACCEPTANCE-CRITERIA";
  const projectDir = dbModeProject(KEY, "FG-2", BODY);
  assert.equal(
    computeRepositoryEvidence(projectDir).source,
    "git-common-dir",
    "the fixture really is remoteless — its evidence comes off the common-dir rung",
  );

  armDirectSubstrate();
  const direct: ExecCapture = { calls: 0, args: [] };
  const parent = await dispatch(projectDir, capturingExec(direct), { ticketId: "FG-2" });
  assert.deepEqual(parent.wave.failedSteps, []);
  const parentAuthority = dispatchedAuthority(parent.runId, direct);
  assert.equal(parentAuthority.marker.mode, "db");
  assert.equal(parentAuthority.marker.projectKey, KEY);

  armCloneSubstrate();
  const cloned: ExecCapture = { calls: 0, args: [] };
  const clone = await dispatch(projectDir, capturingExec(cloned), { ticketId: "FG-2" });
  assert.deepEqual(clone.wave.failedSteps, []);

  const cloneAuthority = dispatchedAuthority(clone.runId, cloned);
  assert.notEqual(
    evidenceKey(cloneAuthority.task.worktreePath!),
    evidenceKey(projectDir),
    "a clone of a remoteless parent diverges too — through its own git common dir",
  );
  assert.equal(cloneAuthority.marker.mode, "db");
  assert.equal(cloneAuthority.marker.projectKey, KEY);
  assert.equal(cloneAuthority.ticketBody("FG-2"), BODY);
});

// ─── (3) The substrate contrast, asserted directly ──────────────────────────

test("FG-666 (3): a linked worktree CONVERGES with its parent and a private clone DIVERGES — and both dispatch db", async () => {
  const KEY = "pk-fg666-substrate";
  const projectDir = dbModeProject(KEY, "FG-3", "body");

  const worktreePath = join(newDir("fg666-seam-wt-"), "wt");
  git(projectDir, ["worktree", "add", "--quiet", "-b", "fg666-wt", worktreePath]);

  // THE ASYMMETRY THE DEFECT RODE ON, stated as an assertion rather than as prose:
  // repository evidence resolves through the git COMMON DIR (or a normalized
  // remote), and a linked worktree shares its parent's — so for as long as dispatch
  // used worktrees, asking the WORKSPACE for the project's identity happened to give
  // the right answer. A private clone has its own common dir and a filesystem-path
  // `origin` that does not normalize as a remote, so it answers differently. Nothing
  // declared the dependency, and nothing failed when FG-621 changed the substrate.
  assert.equal(evidenceKey(worktreePath), evidenceKey(projectDir), "a linked worktree CONVERGES with its parent");

  armDirectSubstrate();
  const fromWorktree: ExecCapture = { calls: 0, args: [] };
  const wt = await dispatch(worktreePath, capturingExec(fromWorktree), { ticketId: "FG-3" });
  assert.deepEqual(wt.wave.failedSteps, []);
  const wtAuthority = dispatchedAuthority(wt.runId, fromWorktree);
  assert.equal(wtAuthority.marker.mode, "db");
  assert.equal(wtAuthority.marker.projectKey, KEY);

  armCloneSubstrate();
  const fromClone: ExecCapture = { calls: 0, args: [] };
  const cl = await dispatch(projectDir, capturingExec(fromClone), { ticketId: "FG-3" });
  assert.deepEqual(cl.wave.failedSteps, []);
  const clAuthority = dispatchedAuthority(cl.runId, fromClone);
  assert.notEqual(
    evidenceKey(clAuthority.task.worktreePath!),
    evidenceKey(projectDir),
    "a private clone DIVERGES from its parent",
  );
  assert.equal(clAuthority.marker.mode, "db", "and the divergence no longer decides anything: the run's project does");
  assert.equal(clAuthority.marker.projectKey, KEY);
});

// ─── (4) The guard still refuses a foreign repository ───────────────────────
//
// PAIRED DELIBERATELY. The two halves are the two ways to get this wrong, and no
// single shortcut satisfies both: exempting the clones directory by path prefix (or
// otherwise relaxing FG-608's cross-repository guard) would resolve the clone and
// also hand the foreign repository the project's tickets, while leaving the guard
// pointed at the WORKSPACE keeps the foreign refusal and blinds every clone. Only
// moving the QUESTION — ask the run's recorded project, keep the guard exactly as
// it is — passes both halves.

test("FG-666 (4): a clone-dispatched task resolves db while a FOREIGN repository carrying a copied project_key is still refused", async () => {
  armCloneSubstrate();
  const KEY = "pk-fg666-guard";
  const projectDir = dbModeProject(KEY, "FG-4", "body");

  const legit: ExecCapture = { calls: 0, args: [] };
  const owned = await dispatch(projectDir, capturingExec(legit), { ticketId: "FG-4", title: "fg666 owner" });
  assert.deepEqual(owned.wave.failedSteps, []);
  const ownedAuthority = dispatchedAuthority(owned.runId, legit);
  assert.equal(ownedAuthority.marker.mode, "db", "the owning project's clone-dispatched task reads its own store");
  assert.equal(ownedAuthority.marker.projectKey, KEY);
  assert.equal(ownedAuthority.ticketBody("FG-4"), "body");
  assert.deepEqual(ownedAuthority.unresolvedSignals, [], "and says nothing: a healthy dispatch is silent");

  // A DIFFERENT repository that committed the same project_key. It is genuinely
  // foreign — different evidence, no registry row of its own.
  const foreignDir = foreignRepoWithCopiedKey(KEY);
  assert.notEqual(evidenceKey(foreignDir), evidenceKey(projectDir));

  const foreign: ExecCapture = { calls: 0, args: [] };
  const stolen = await dispatch(foreignDir, capturingExec(foreign), { ticketId: "FG-4", title: "fg666 foreign" });
  assert.deepEqual(stolen.wave.failedSteps, [], "the dispatch itself proceeds, exactly as it did before FG-666");
  assert.equal(foreign.calls, 1);

  const foreignAuthority = dispatchedAuthority(stolen.runId, foreign);
  assert.equal(foreignAuthority.marker.mode, "unknown", "the copied key buys NOTHING: the marker refuses");
  assert.equal(foreignAuthority.marker.projectKey, null);
  assert.equal(
    foreignAuthority.hasSnapshot,
    false,
    "and no snapshot of the other project's tickets is published anywhere the foreign container can reach",
  );

  // The degradation is SAID, not left for the operator to infer from an agent's
  // prose — which is the only place it surfaced while twelve dispatches ran blind.
  assert.equal(foreignAuthority.unresolvedSignals.length, 1, "exactly one signal on the task's timeline");
  const payload = foreignAuthority.unresolvedSignals[0]!.payload as Record<string, unknown>;
  assert.equal(payload["projectDir"], foreignDir, "naming the directory the authority was resolved against");
  assert.match(String(payload["error"]), new RegExp(KEY), "and the key that could not be honoured");
  assert.match(String(payload["error"]), new RegExp(evidenceKey(foreignDir)), "against this checkout's evidence");
});

// ─── (5) A markdown-mode project dispatches untouched ───────────────────────

test("FG-666 (5): a project that declares no project_key dispatches unchanged, with no snapshot and NO signal", async () => {
  armCloneSubstrate();
  const projectDir = markdownProject();

  const capture: ExecCapture = { calls: 0, args: [] };
  const { runId, wave } = await dispatch(projectDir, capturingExec(capture), { ticketId: "FG-1" });
  assert.deepEqual(wave.failedSteps, [], "a normal markdown-mode project must dispatch untouched");
  assert.equal(capture.calls, 1);

  const authority = dispatchedAuthority(runId, capture);
  assert.equal(authority.marker.mode, "markdown", "it resolves CLEANLY — it is not `unknown`");
  assert.equal(authority.marker.projectKey, null);
  assert.equal(authority.hasSnapshot, false, "no snapshot is published for a markdown project");
  assert.equal(authority.boundSource, authority.hostDir, "the marker mount is still bound, as FG-608 requires");
  // THE PIN THAT STOPS THE SIGNAL BECOMING NOISE: one that fires on every normal
  // project reproduces exactly the silence it exists to end.
  assert.deepEqual(authority.unresolvedSignals, [], "and NOTHING is reported: this is a healthy outcome");
});
