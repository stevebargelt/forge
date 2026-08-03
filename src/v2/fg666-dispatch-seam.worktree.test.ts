// FG-666: THROUGH THE PRODUCTION DISPATCH SEAM.
//
// Why this file exists separately from fg666-dispatch-authority.worktree.test.ts:
// a test that constructs the resolver's INPUT itself cannot detect a caller passing
// the wrong input. Every FG-608 test calls prepareBacklogSnapshotMount(projectDir, …)
// directly, which is precisely why FG-621's substrate change — from linked worktrees
// (which converge with their parent's repository evidence) to private clones (which
// do not) — went unnoticed for twelve consecutive dispatches. The argument production
// stopped being exercised.
//
// So NOTHING here calls a backlog-authority primitive. Every case drives runContainer
// through runNext (or the invoke seam) with an INJECTED dockerExec, exactly the shape
// ten existing *.worktree.test.ts files use, and asserts on what the production path
// produced: the marker, the argv, the target rows, the events, and the manifest.

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
import { SNAPSHOT_DB_BASENAME, liveSnapshotTargets, releasedSnapshotTargets } from "../backlog/snapshot.js";
import { tasksForRun, setTaskStatus } from "../store/tasks.js";
import { eventsForTask } from "../store/events.js";
import { failureKindFromEvents } from "./failure-kind.js";
import { retryPolicy } from "./retry-policy.js";
import { startRun } from "./startRun.js";
import { runNext } from "./runNext.js";
import { invoke } from "./invoke.js";
import { backlogSnapshotHostDir } from "./spawn.js";
import { taskDir } from "../util/paths.js";
import { publishFlatAsGeneration } from "./seed-generation.testkit.js";
import type { Workflow } from "./schema.js";
import type { DockerExecFn } from "./docker-exec.js";
import type { TaskManifest } from "./task-manifest.js";

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

// Same step, plus one non-blocking specialist red. Reds are dispatched against the
// PUBLISHER'S CANDIDATE, which is where the identity question can be forged.
const SEAM_WORKFLOW_WITH_RED: Workflow = {
  name: "fg666-seam-test",
  description: "FG-666 dispatch-seam test: single step with a red",
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
      reds: [{ agent: "red-narrow", authority: "specialist", gate_on_verdict: false }],
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
  ensureSeamRuntime("fg666-seam-test", {});
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
  process.env.FORGE_WORKTREES = "1";
  process.env.FORGE_WORKTREE_IGNORE_DIRTY = "1";
}

function newDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: ["ignore", "ignore", "pipe"] });
}

function ensureSeamRuntime(name: string, env: Record<string, string>): void {
  const forgeHome = process.env.FORGE_HOME!;
  const runtimePath = join(forgeHome, "runtimes", `${name}.yml`);
  mkdirSync(dirname(runtimePath), { recursive: true });
  const envBlock = Object.entries(env).length
    ? Object.entries(env)
        .map(([k, v]) => `  ${k}: "${v}"`)
        .join("\n")
    : "{}";
  writeFileSync(
    runtimePath,
    `name: ${name}
description: FG-666 dispatch-seam test runtime stub
image: test-image:latest
models:
  default: test-model
auth:
  mode: apikey
env: ${Object.entries(env).length ? `\n${envBlock}` : "{}"}
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

/** A real git repository, cut over to the db backlog store, with its project_key
 *  COMMITTED (as FG-608 committed it here) so every private clone inherits it, and
 *  its repository evidence registered (as `forge backlog migrate` registers it). */
function dbModeProject(projectKey: string, ticketId: string, body: string): string {
  const dir = newDir("fg666-seam-proj-");
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "test@forge.test"]);
  git(dir, ["config", "user.name", "Forge Test"]);
  writeFileSync(join(dir, "README.md"), "# fixture\n");
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

/** A real git repository with a project_key that is registered to a DIFFERENT
 *  repository — the shape that makes authority resolve to `unknown` even from the
 *  project directory (a copied key, or evidence that moved). */
function unresolvableProject(projectKey: string): string {
  const owner = newDir("fg666-seam-owner-");
  git(owner, ["init", "-b", "main"]);
  git(owner, ["config", "user.email", "test@forge.test"]);
  git(owner, ["config", "user.name", "Forge Test"]);
  writeFileSync(join(owner, "README.md"), "# owner\n");
  git(owner, ["add", "-A"]);
  git(owner, ["commit", "-m", "initial"]);

  writeTransaction(() => ensureStorageMode(projectKey, NOW));
  setStorageMode(projectKey, "db", NOW);
  const evidence = computeRepositoryEvidence(owner);
  db.prepare(
    `INSERT OR REPLACE INTO project_identity (project_key, repo_evidence_key, repo_evidence_source, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run(projectKey, evidence.key, evidence.source, NOW);

  const dir = newDir("fg666-seam-copied-");
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "test@forge.test"]);
  git(dir, ["config", "user.name", "Forge Test"]);
  writeFileSync(join(dir, "README.md"), "# copied\n");
  mkdirSync(join(dir, ".forge"), { recursive: true });
  writeFileSync(join(dir, ".forge", "config.yml"), `project_key: ${projectKey}\n`);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", "initial"]);
  clearBacklogStoreCache();
  return dir;
}

/** Register `projectKey` against a DIFFERENT repository, so any checkout declaring
 *  it resolves `unknown` (identity-conflict). The forgeable half of RF-11's attack:
 *  the key exists and is registered — just not to the tree that claims it. */
function registerKeyToForeignRepo(projectKey: string): void {
  const owner = newDir("fg666-seam-foreign-");
  git(owner, ["init", "-b", "main"]);
  git(owner, ["config", "user.email", "test@forge.test"]);
  git(owner, ["config", "user.name", "Forge Test"]);
  writeFileSync(join(owner, "README.md"), "# foreign owner\n");
  git(owner, ["add", "-A"]);
  git(owner, ["commit", "-m", "initial"]);
  writeTransaction(() => ensureStorageMode(projectKey, NOW));
  setStorageMode(projectKey, "db", NOW);
  const evidence = computeRepositoryEvidence(owner);
  db.prepare(
    `INSERT OR REPLACE INTO project_identity (project_key, repo_evidence_key, repo_evidence_source, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run(projectKey, evidence.key, evidence.source, NOW);
  clearBacklogStoreCache();
}

/** A plain git repository with NO project_key at all — the NORMAL markdown-mode /
 *  non-forge outcome, which must dispatch untouched. */
function markdownProject(): string {
  const dir = newDir("fg666-seam-md-");
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "test@forge.test"]);
  git(dir, ["config", "user.name", "Forge Test"]);
  mkdirSync(join(dir, "backlog", "stories"), { recursive: true });
  writeFileSync(join(dir, "backlog", "stories", "FG-1-x.md"), `---\nid: FG-1\ntype: story\nstatus: active\ntitle: x\n---\n\nbody\n`);
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

/** An executor that THROWS. `signalsStart` selects the contract: true is the
 *  detached/attached production shape (runContainer waits for onContainerStarted,
 *  which this never calls); false is the legacy/fake shape (runContainer records
 *  the start up-front). The two fail in opposite directions and BOTH must retain
 *  the artifact. */
function throwingExec(signalsStart: boolean, capture: ExecCapture): DockerExecFn {
  const fn: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
    capture.calls += 1;
    capture.args = [...args];
    const d = dirname(stdoutPath);
    mkdirSync(d, { recursive: true });
    writeFileSync(stdoutPath, "");
    writeFileSync(stderrPath, "");
    throw new Error("fg666: executor died before the container could be observed");
  };
  if (signalsStart) fn.signalsContainerStart = true;
  return fn;
}

/** The detached executor's WORST shape: the daemon created the container (the start
 *  signal fired) and the host-side watcher then died. The container is running. */
function throwsAfterStartExec(capture: ExecCapture): DockerExecFn {
  const fn: DockerExecFn = async ({ args, stdoutPath, stderrPath, onContainerStarted }) => {
    capture.calls += 1;
    capture.args = [...args];
    mkdirSync(dirname(stdoutPath), { recursive: true });
    writeFileSync(stdoutPath, "");
    writeFileSync(stderrPath, "");
    onContainerStarted?.("container-id-fg666");
    throw new Error("fg666: the watcher died AFTER the daemon created the container");
  };
  fn.signalsContainerStart = true;
  return fn;
}

/** An executor whose container RUNS and exits nonzero with no result — the ordinary
 *  agent-crash shape, and by far the most common post-publication failure. */
function crashingExec(capture: ExecCapture): DockerExecFn {
  const fn: DockerExecFn = async ({ args, stdoutPath, stderrPath, onContainerStarted }) => {
    capture.calls += 1;
    capture.args = [...args];
    mkdirSync(dirname(stdoutPath), { recursive: true });
    writeFileSync(stdoutPath, "");
    writeFileSync(stderrPath, "");
    onContainerStarted?.("container-id-fg666");
    return 1;
  };
  fn.signalsContainerStart = true;
  return fn;
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

function projectMountSource(args: string[]): string | undefined {
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === "-v" && args[i + 1]!.includes(":/project:")) return args[i + 1]!.split(":")[0];
  }
  return undefined;
}

function readMarker(hostDir: string): { mode: string; projectKey: string | null } {
  return JSON.parse(readFileSync(join(hostDir, "authority.json"), "utf8")) as {
    mode: string;
    projectKey: string | null;
  };
}

function readManifest(runId: string, taskId: string): TaskManifest {
  return JSON.parse(readFileSync(join(taskDir(runId, taskId), "manifest.json"), "utf8")) as TaskManifest;
}

function dispatch(
  projectDir: string,
  exec: DockerExecFn,
  opts: { ticketId?: string; title?: string } = {},
) {
  const { runId } = startRun({
    workflow: SEAM_WORKFLOW,
    title: opts.title ?? "fg666 seam",
    inputs: opts.ticketId ? { ticketId: opts.ticketId } : {},
    projectDir,
  });
  return runNext({ runId, workflow: SEAM_WORKFLOW, dockerExec: exec }).then((wave) => ({ runId, wave }));
}

// ─── (6) AC1/AC2: the clone-dispatched task resolves the PROJECT's store ─────

test("FG-666 (6): a CLONE-dispatched ticketed task resolves mode db + the correct project_key, and mounts a snapshot holding the ticket", async () => {
  armCloneSubstrate();
  const KEY = "pk-fg666-seam";
  const BODY = "THE-ACCEPTANCE-CRITERIA-THE-AGENT-MUST-BE-ABLE-TO-READ";
  const projectDir = dbModeProject(KEY, "FG-1", BODY);

  const capture: ExecCapture = { calls: 0, args: [] };
  const { runId, wave } = await dispatch(projectDir, capturingExec(capture), { ticketId: "FG-1" });

  assert.deepEqual(wave.failedSteps, [], "the dispatch must not fail");
  assert.equal(capture.calls, 1, "the agent container was dispatched");

  const task = primaryTask(runId);
  // The substrate really is a private clone — otherwise this test proves nothing.
  assert.ok(task.worktreePath, "the task ran in an isolated workspace");
  assert.notEqual(
    computeRepositoryEvidence(task.worktreePath!).key,
    computeRepositoryEvidence(projectDir).key,
    "and that workspace's repository evidence genuinely DIVERGES from the project's",
  );

  const hostDir = backlogSnapshotHostDir(task.id);
  dirs.push(hostDir);
  const marker = readMarker(hostDir);
  assert.equal(marker.mode, "db", "AC1: authority resolves to the project's real store, not `unknown`");
  assert.equal(marker.projectKey, KEY, "AC1: and to the CORRECT project_key");

  // AC2: the snapshot the container reads through really contains the ticket, so
  // `forge backlog show FG-1` inside it answers rather than refuses.
  assert.equal(snapshotBindSource(capture.args), hostDir, "the argv binds the snapshot directory read-only");
  const snapPath = join(hostDir, SNAPSHOT_DB_BASENAME);
  assert.equal(existsSync(snapPath), true, "and the artifact exists before the container starts");
  const snap = new Database(snapPath, { readonly: true });
  try {
    const row = snap.prepare(`SELECT body FROM tickets WHERE ticket_id = ?`).get("FG-1") as { body: string };
    assert.equal(row.body, BODY, "the mounted snapshot carries the ticket the task was dispatched for");
  } finally {
    snap.close();
  }
});

// ─── (7) AC4: the refusal, before any container ─────────────────────────────

test("FG-666 (7): a TICKETED dispatch with unresolvable authority is refused BEFORE any container starts", async () => {
  armCloneSubstrate();
  const projectDir = unresolvableProject("pk-fg666-copied");

  const capture: ExecCapture = { calls: 0, args: [] };
  const { runId, wave } = await dispatch(projectDir, capturingExec(capture), { ticketId: "FG-1" });

  assert.deepEqual(wave.failedSteps, ["build"], "the ticketed dispatch is refused");
  assert.deepEqual(wave.completedSteps, []);
  assert.equal(
    capture.calls,
    0,
    "NO container at all — not the agent, not the FG-376 provisioner, not the FG-664 probe",
  );

  const task = primaryTask(runId);
  assert.equal(task.status, "failed");

  // TASK surface: the failure names the ticket, the directory resolved against, and
  // the classified reason with its keys — never a flattened "unknown".
  const failure = eventsForTask(task.id).find((e) => e.eventType === "task.failed");
  const failureText = JSON.stringify(failure?.payload ?? {}) + (task.error ?? "");
  assert.match(failureText, /FG-1/, "names the ticket");
  assert.match(failureText, /identity-conflict/, "carries the classified reason");
  assert.match(failureText, /pk-fg666-copied/, "and the declared key from the detail");
  assert.match(failureText, new RegExp(projectDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "and the project dir");

  // RUN surface.
  const refusal = eventsForTask(task.id).filter((e) => e.eventType === "task.backlog_authority_refused");
  assert.equal(refusal.length, 1, "exactly one refusal event on the run timeline");
  const payload = refusal[0]!.payload as Record<string, unknown>;
  assert.equal(payload["ticketId"], "FG-1");
  assert.equal(payload["mode"], "unknown");
  assert.equal(payload["reason"], "identity-conflict");
  assert.match(String(payload["detail"]), /pk-fg666-copied/);

  // RECEIPT surface: committed, even though no container ran.
  const manifest = readManifest(runId, task.id);
  const warnings = manifest.controlPlane?.warnings ?? [];
  assert.equal(
    warnings.some((w) => /backlog_authority_conflict/.test(w) && /FG-1/.test(w)),
    true,
    `the committed control-plane receipt names the refusal; got ${JSON.stringify(warnings)}`,
  );

  // THE KIND, not just the message. failureKindFromEvents is the single source of
  // truth every retry/recovery consumer reads — forge show, forge retry, forge
  // recover, the campaign policy. A refusal recorded as `unknown` would reach all
  // four as "cause unclear; re-dispatch", advertising a deterministic identity
  // refusal as retryable and making it indistinguishable from an infrastructure
  // failure that a retry really could clear.
  assert.equal(
    failureKindFromEvents(eventsForTask(task.id)),
    "backlog_authority_conflict",
    "the identity refusal is its OWN terminal kind",
  );
  assert.equal(
    retryPolicy("backlog_authority_conflict").retryable,
    false,
    "and it is NOT advertised as re-dispatchable: re-resolving reaches the same answer every time",
  );
  assert.equal(
    retryPolicy("backlog_authority_unresolvable").retryable,
    true,
    "while the infrastructure refusal IS retryable — the two are never flattened into one terminal state",
  );

  // And nothing was published for a dispatch that never ran.
  assert.deepEqual(liveSnapshotTargets("pk-fg666-copied"), [], "no target registered by a refused dispatch");
});

// ─── (7b) AC4/AC7: the ticket itself is unreadable ───────────────────────────

test("FG-666 (7b): a ticketed dispatch whose TICKET has no readable row is refused — not dispatched with zero evidence", async () => {
  armCloneSubstrate();
  const KEY = "pk-fg666-noticket";
  // The store resolves perfectly. Only the ticket the run is anchored to is absent —
  // removed, archived, or unreadable between `forge new --ticket` (which validates
  // it) and this dispatch.
  const projectDir = dbModeProject(KEY, "FG-1", "body");

  const capture: ExecCapture = { calls: 0, args: [] };
  const { runId, wave } = await dispatch(projectDir, capturingExec(capture), { ticketId: "FG-404" });

  assert.deepEqual(wave.failedSteps, ["build"], "a run anchored to a ticket that cannot be read is refused");
  assert.equal(capture.calls, 0, "no container: the snapshot would not have contained the ticket");

  const task = primaryTask(runId);
  assert.equal(
    failureKindFromEvents(eventsForTask(task.id)),
    "backlog_ticket_unreadable",
    "and it is refused for the RIGHT reason — the store resolved, the ticket did not",
  );
  const payload = eventsForTask(task.id).find((e) => e.eventType === "task.backlog_authority_refused")!
    .payload as Record<string, unknown>;
  assert.equal(payload["mode"], "db", "the store's own mode is reported honestly");
  assert.equal(payload["reason"], "ticket-unreadable");
  assert.match(String(payload["detail"]), /FG-404/);

  // AC7's exactly-one-evidence-write guarantee: this dispatch wrote NO evidence, and
  // that is now a recorded refusal rather than a silent zero.
  const n = db
    .prepare(`SELECT COUNT(*) AS n FROM ticket_dispatch_evidence WHERE task_id = ?`)
    .get(task.id) as { n: number };
  assert.equal(n.n, 0);
});

// ─── (8) AC4 non-regression: the refusal stays narrow ───────────────────────

test("FG-666 (8a): a ticketed dispatch with valid db authority proceeds", async () => {
  armCloneSubstrate();
  const projectDir = dbModeProject("pk-fg666-ok", "FG-1", "body");
  const capture: ExecCapture = { calls: 0, args: [] };
  const { runId, wave } = await dispatch(projectDir, capturingExec(capture), { ticketId: "FG-1" });

  assert.deepEqual(wave.failedSteps, []);
  assert.equal(capture.calls, 1);
  const task = primaryTask(runId);
  dirs.push(backlogSnapshotHostDir(task.id));
  assert.equal(
    eventsForTask(task.id).filter((e) => e.eventType === "task.backlog_authority_refused").length,
    0,
  );
});

test("FG-666 (8b): a ticketed dispatch on a markdown project with NO project_key proceeds, with no refusal and no warning", async () => {
  armCloneSubstrate();
  const projectDir = markdownProject();
  const capture: ExecCapture = { calls: 0, args: [] };
  const { runId, wave } = await dispatch(projectDir, capturingExec(capture), { ticketId: "FG-1" });

  assert.deepEqual(wave.failedSteps, [], "a normal markdown-mode project must dispatch untouched");
  assert.equal(capture.calls, 1);

  const task = primaryTask(runId);
  const hostDir = backlogSnapshotHostDir(task.id);
  dirs.push(hostDir);
  assert.equal(readMarker(hostDir).mode, "markdown", "it resolves cleanly — it is not `unknown`");
  assert.equal(
    eventsForTask(task.id).filter((e) => e.eventType === "task.backlog_authority_refused").length,
    0,
    "no refusal",
  );
  // THE PIN THAT STOPS THIS BECOMING NOISE: a warning that fires on every normal
  // project reproduces exactly the silence AC4 exists to end.
  const warnings = readManifest(runId, task.id).controlPlane?.warnings ?? [];
  assert.equal(
    warnings.some((w) => /backlog_authority/.test(w)),
    false,
    `no backlog-authority warning on a normal project; got ${JSON.stringify(warnings)}`,
  );
});

test("FG-666 (8c): an UNTICKETED dispatch with unknown authority proceeds", async () => {
  armCloneSubstrate();
  const projectDir = unresolvableProject("pk-fg666-unticketed");
  const capture: ExecCapture = { calls: 0, args: [] };
  const { runId, wave } = await dispatch(projectDir, capturingExec(capture));

  assert.deepEqual(wave.failedSteps, [], "the refusal is scoped to TICKETED dispatches");
  assert.equal(capture.calls, 1);
  const task = primaryTask(runId);
  const hostDir = backlogSnapshotHostDir(task.id);
  dirs.push(hostDir);
  assert.equal(readMarker(hostDir).mode, "unknown", "it still asserts `unknown` — a refusal surface, not a fallback");
});

// ─── (9)+(10) AC6 lifecycle: the ROW follows what is KNOWN about the container ─
//
// The two halves of AC6 are decided by DIFFERENT facts, and this pair is the proof:
//
//   ARTIFACT — deleted only against an authoritative daemon-side no-container-created
//   fact. No executor contract surfaces one, so the bytes are ALWAYS retained here.
//
//   ROW — released only where no container can still be reading the snapshot. That
//   is a fact the throw path sometimes has (the executor signals start, and no start
//   was recorded → nothing was created) and sometimes does not (start recorded, or
//   an executor that never signals). Fan-out to a registered target is how a
//   post-start ticket amendment reaches a running agent; releasing the row of a
//   possibly-live container silently cuts that agent off from every later amendment.

test("FG-666 (9): DETACHED/ATTACHED — a throw with NO start recorded releases the ROW and retains the artifact", async () => {
  armCloneSubstrate();
  const KEY = "pk-fg666-detached";
  const projectDir = dbModeProject(KEY, "FG-1", "body");

  const capture: ExecCapture = { calls: 0, args: [] };
  const { runId, wave } = await dispatch(projectDir, throwingExec(true, capture), { ticketId: "FG-1" });

  assert.deepEqual(wave.failedSteps, ["build"]);
  assert.equal(capture.calls, 1, "the executor really was invoked (so publication had already committed)");

  const task = primaryTask(runId);
  const hostDir = backlogSnapshotHostDir(task.id);
  dirs.push(hostDir);

  assert.deepEqual(
    liveSnapshotTargets(KEY).map((t) => t.targetDir),
    [],
    "the ROW is released: this executor signals start, none was recorded, so no container was created",
  );
  assert.equal(
    existsSync(join(hostDir, SNAPSHOT_DB_BASENAME)),
    true,
    "and the ARTIFACT is RETAINED: no executor contract surfaces an authoritative no-container-created " +
      "fact, so deleting here could unlink the source of a live `:ro` bind",
  );
});

test("FG-666 (10): LEGACY/FAKE — a throw whose start was recorded up front RETAINS the row: the container may be alive", async () => {
  armCloneSubstrate();
  const KEY = "pk-fg666-legacy";
  const projectDir = dbModeProject(KEY, "FG-1", "body");

  const capture: ExecCapture = { calls: 0, args: [] };
  const { runId, wave } = await dispatch(projectDir, throwingExec(false, capture), { ticketId: "FG-1" });

  assert.deepEqual(wave.failedSteps, ["build"]);
  assert.equal(capture.calls, 1);

  const task = primaryTask(runId);
  const hostDir = backlogSnapshotHostDir(task.id);
  dirs.push(hostDir);

  assert.deepEqual(
    liveSnapshotTargets(KEY).map((t) => t.targetDir),
    [hostDir],
    "the ROW is RETAINED: this executor never signals start, so the recorded start proves nothing and " +
      "the container's liveness is unknown — the same unknown that forbids deleting the bytes forbids " +
      "asserting the container is gone",
  );
  assert.equal(existsSync(join(hostDir, SNAPSHOT_DB_BASENAME)), true, "and the artifact is retained");
});

test("FG-666 (10b): a throw AFTER the daemon created the container keeps fanning out to that live agent", async () => {
  // The detached executor's real worst case, and the one the ambiguity argument is
  // actually about: `docker run -d` succeeded, the container is running the task,
  // and the host-side watcher died. Releasing the row here would cut a LIVE agent
  // off from every subsequent ticket amendment — the exact delivery FG-608's
  // registration exists to provide.
  armCloneSubstrate();
  const KEY = "pk-fg666-live-throw";
  const projectDir = dbModeProject(KEY, "FG-1", "body");

  const capture: ExecCapture = { calls: 0, args: [] };
  const { runId, wave } = await dispatch(projectDir, throwsAfterStartExec(capture), { ticketId: "FG-1" });

  assert.deepEqual(wave.failedSteps, ["build"]);
  const task = primaryTask(runId);
  const hostDir = backlogSnapshotHostDir(task.id);
  dirs.push(hostDir);

  assert.equal(
    eventsForTask(task.id).some((e) => e.eventType === "container.started"),
    true,
    "the fixture really is the post-creation shape — otherwise this test proves nothing",
  );
  assert.deepEqual(
    liveSnapshotTargets(KEY).map((t) => t.targetDir),
    [hostDir],
    "the container the daemon created is still running: it stays in the fan-out set",
  );
  assert.equal(existsSync(join(hostDir, SNAPSHOT_DB_BASENAME)), true, "and its mount source is retained");
});

test("FG-666 (10c): an ordinary NONZERO exec return releases the row — exec returning IS the container-is-gone fact", async () => {
  // The common failure. Before this, only the exec-THROW path compensated, so every
  // crashed agent left its target registered and every subsequent host ticket write
  // for the project fanned out to a directory nothing would ever read again —
  // unbounded work per write, until some later dispatch happened to sweep it. There
  // may be no later dispatch.
  armCloneSubstrate();
  const KEY = "pk-fg666-nonzero";
  const projectDir = dbModeProject(KEY, "FG-1", "body");

  const capture: ExecCapture = { calls: 0, args: [] };
  const { runId, wave } = await dispatch(projectDir, crashingExec(capture), { ticketId: "FG-1" });

  assert.deepEqual(wave.failedSteps, ["build"], "a nonzero exit with no result fails the task");
  const task = primaryTask(runId);
  const hostDir = backlogSnapshotHostDir(task.id);
  dirs.push(hostDir);
  assert.equal(failureKindFromEvents(eventsForTask(task.id)), "container_crash", "through the NORMAL-return path");

  assert.deepEqual(
    liveSnapshotTargets(KEY).map((t) => t.targetDir),
    [],
    "the row is released: exec returned, so the container has exited and can read nothing more",
  );
  assert.equal(
    existsSync(join(hostDir, SNAPSHOT_DB_BASENAME)),
    true,
    "the bytes stay for the sweep to reclaim — the dispatch layer never deletes a mount source",
  );
});

// ─── (11) AC6: deletion only against a POSITIVE finished fact ───────────────

test("FG-666 (11a): deletion only against a POSITIVE `finished` fact — a REGISTERED target whose task reads `running` survives, and is reclaimed once it reads `finished`", async () => {
  armCloneSubstrate();
  const KEY = "pk-fg666-gc";
  const projectDir = dbModeProject(KEY, "FG-1", "body");

  // A dispatch that SUCCEEDS leaves its target registered — the shape
  // releaseFinishedTargets exists to sweep. (The compensated shape is 11b.)
  const firstCapture: ExecCapture = { calls: 0, args: [] };
  const first = await dispatch(projectDir, capturingExec(firstCapture), { ticketId: "FG-1", title: "fg666 gc 1" });
  const firstTask = primaryTask(first.runId);
  const firstHostDir = backlogSnapshotHostDir(firstTask.id);
  dirs.push(firstHostDir);
  assert.equal(existsSync(join(firstHostDir, SNAPSHOT_DB_BASENAME)), true);

  // A task the store still reads as LIVE must never have its bytes deleted — that
  // directory may be a running container's `:ro` mount source. FINISHED is a
  // POSITIVE fact, not the absence of one.
  setTaskStatus(firstTask.id, "running");
  const secondCapture: ExecCapture = { calls: 0, args: [] };
  const second = await dispatch(projectDir, capturingExec(secondCapture), { ticketId: "FG-1", title: "fg666 gc 2" });
  dirs.push(backlogSnapshotHostDir(primaryTask(second.runId).id));
  assert.equal(
    existsSync(join(firstHostDir, SNAPSHOT_DB_BASENAME)),
    true,
    "a target whose task is still `running` is NOT deleted by the next dispatch",
  );

  // Now it reads finished — and the FG-608 GC reclaims it, unchanged by FG-666.
  setTaskStatus(firstTask.id, "failed");
  const thirdCapture: ExecCapture = { calls: 0, args: [] };
  const third = await dispatch(projectDir, capturingExec(thirdCapture), { ticketId: "FG-1", title: "fg666 gc 3" });
  dirs.push(backlogSnapshotHostDir(primaryTask(third.runId).id));
  assert.equal(
    existsSync(firstHostDir),
    false,
    "reclamation happens where FG-608 already put it — against `finished`, not against the dispatch layer's guesswork",
  );
});

test("FG-666 (11b): a COMPENSATED target stops fanning out immediately, and its retained directory IS reclaimed by the next dispatch", async () => {
  // The two halves of AC6's cost, bounded separately and both MEASURED:
  //
  //   the per-write cost ends IMMEDIATELY — releasing the row takes the dead target
  //   out of the fan-out set, so no subsequent host ticket write pays for it;
  //
  //   the one-off disk cost ends at the project's NEXT dispatch — reclaimReleasedTargets
  //   sweeps released-but-present targets, which releaseFinishedTargets cannot see
  //   (it iterates liveSnapshotTargets, released_at IS NULL). Without that second
  //   sweep a released-but-present directory holding the project's full ticket
  //   bodies is reachable by NO sweep, ever.
  armCloneSubstrate();
  const KEY = "pk-fg666-compensated";
  const projectDir = dbModeProject(KEY, "FG-1", "body");

  const failCapture: ExecCapture = { calls: 0, args: [] };
  const first = await dispatch(projectDir, throwingExec(true, failCapture), { ticketId: "FG-1", title: "fg666 comp 1" });
  const failedTask = primaryTask(first.runId);
  const failedHostDir = backlogSnapshotHostDir(failedTask.id);
  dirs.push(failedHostDir);

  assert.deepEqual(
    liveSnapshotTargets(KEY).map((t) => t.targetDir),
    [],
    "fan-out to the dead target stops IMMEDIATELY — this is the unbounded-cost half AC6 names",
  );
  assert.equal(existsSync(join(failedHostDir, SNAPSHOT_DB_BASENAME)), true, "the bytes are retained for now");
  assert.deepEqual(
    releasedSnapshotTargets(KEY).map((t) => t.targetDir),
    [failedHostDir],
    "and the released row is still on record — which is what makes the directory findable",
  );

  // The failed task reads as `finished`, so the next dispatch's released-target sweep
  // reclaims both the bytes and the row.
  const secondCapture: ExecCapture = { calls: 0, args: [] };
  const second = await dispatch(projectDir, capturingExec(secondCapture), { ticketId: "FG-1", title: "fg666 comp 2" });
  dirs.push(backlogSnapshotHostDir(primaryTask(second.runId).id));
  assert.equal(
    existsSync(failedHostDir),
    false,
    "the compensated directory is reclaimed by the project's next dispatch — not stranded forever",
  );
  assert.equal(
    releasedSnapshotTargets(KEY).some((t) => t.targetDir === failedHostDir),
    false,
    "and its row goes with it, so the table stays bounded too",
  );
});

test("FG-666 (11b-i): a released target whose task still reads LIVE keeps its bytes", async () => {
  // The reclaim sweep inherits releaseFinishedTargets' polarity exactly: bytes are
  // deleted against a POSITIVE fact, never against the absence of one. A row is
  // released when the container is known gone — but if the store still reads the
  // task as live, that outranks it, because the directory may be a `:ro` mount source.
  armCloneSubstrate();
  const KEY = "pk-fg666-released-live";
  const projectDir = dbModeProject(KEY, "FG-1", "body");

  const failCapture: ExecCapture = { calls: 0, args: [] };
  const first = await dispatch(projectDir, throwingExec(true, failCapture), { ticketId: "FG-1", title: "fg666 rel 1" });
  const failedTask = primaryTask(first.runId);
  const failedHostDir = backlogSnapshotHostDir(failedTask.id);
  dirs.push(failedHostDir);
  setTaskStatus(failedTask.id, "running");

  const secondCapture: ExecCapture = { calls: 0, args: [] };
  const second = await dispatch(projectDir, capturingExec(secondCapture), { ticketId: "FG-1", title: "fg666 rel 2" });
  dirs.push(backlogSnapshotHostDir(primaryTask(second.runId).id));
  assert.equal(
    existsSync(join(failedHostDir, SNAPSHOT_DB_BASENAME)),
    true,
    "a released target whose task reads `running` is NOT deleted",
  );
});

test("FG-666 (11c): an ARGV failure after the publication commit point compensates, and nothing is stranded", async () => {
  // The commit point sits immediately BEFORE buildDockerArgs, because
  // FORGE_DISPATCHED_TICKET is built out of what publication produced (see (14)).
  // That puts one more failure path after publication, and this is the pin that it
  // is fully compensated: no container, no live target, and no directory left behind
  // once the project dispatches again.
  armCloneSubstrate();
  const KEY = "pk-fg666-prepub";
  const projectDir = dbModeProject(KEY, "FG-1", "body");
  // FG-497's argv guard fires inside buildDockerArgs.
  ensureSeamRuntime("fg666-seam-test", { OVERSIZED: "x".repeat(130_000) });

  const capture: ExecCapture = { calls: 0, args: [] };
  const { runId, wave } = await dispatch(projectDir, capturingExec(capture), { ticketId: "FG-1" });

  assert.deepEqual(wave.failedSteps, ["build"]);
  assert.equal(capture.calls, 0, "no container");
  const task = primaryTask(runId);
  const hostDir = backlogSnapshotHostDir(task.id);
  dirs.push(hostDir);
  assert.match(task.error ?? "", /buildDockerArgs failed/);
  assert.deepEqual(liveSnapshotTargets(KEY), [], "the target it published was released — nothing fans out to it");

  ensureSeamRuntime("fg666-seam-test", {});
  const secondCapture: ExecCapture = { calls: 0, args: [] };
  const second = await dispatch(projectDir, capturingExec(secondCapture), { ticketId: "FG-1", title: "fg666 prepub 2" });
  dirs.push(backlogSnapshotHostDir(primaryTask(second.runId).id));
  assert.equal(existsSync(hostDir), false, "and its bytes are reclaimed by the next dispatch");
});

// ─── (12) AC7: exactly ONE dispatch-evidence write per dispatch ─────────────

test("FG-666 (12): one ticketed dispatch records EXACTLY ONE dispatch-evidence row and one FORGE_DISPATCHED_TICKET", async () => {
  armCloneSubstrate();
  const KEY = "pk-fg666-evidence";
  const projectDir = dbModeProject(KEY, "FG-1", "body");

  const capture: ExecCapture = { calls: 0, args: [] };
  const { runId } = await dispatch(projectDir, capturingExec(capture), { ticketId: "FG-1" });
  const task = primaryTask(runId);
  dirs.push(backlogSnapshotHostDir(task.id));

  // FG-608's dispatch-evidence path had NEVER fired for a real run — SpawnContext
  // .TICKET_ID was set by no production dispatch site. Activating it is exactly
  // where a duplicate or double-write goes unnoticed, so the assertion is the
  // COUNT, not existence.
  const n = db
    .prepare(`SELECT COUNT(*) AS n FROM ticket_dispatch_evidence WHERE task_id = ? AND ticket_id = ?`)
    .get(task.id, "FG-1") as { n: number };
  assert.equal(n.n, 1, "exactly one evidence row for this (task, ticket)");

  const dispatched = capture.args.filter((a) => a.startsWith("FORGE_DISPATCHED_TICKET="));
  assert.equal(dispatched.length, 1, "and exactly one FORGE_DISPATCHED_TICKET in the argv");
  assert.match(dispatched[0]!, /^FORGE_DISPATCHED_TICKET=FG-1:1:/);
});

// ─── (14) AC7: the evidence names the revision the CONTAINER was given ───────

test("FG-666 (14): a ticket amended between resolve and publish is named by BOTH the evidence row and FORGE_DISPATCHED_TICKET", async () => {
  // Resolution now happens before the dependency block (image pull plus install —
  // minutes), and the snapshot is published at the far end of it. A host ticket
  // amendment in that window lands in the published snapshot, so evidence read at
  // resolve time would name a revision the container was NOT given — while the
  // in-container reader asserts the task was BUILT FROM the dispatched revision.
  //
  // Driven at the seam by amending the ticket from inside the executor's own
  // dispatch: the run's FIRST dispatch publishes revision 1, the amendment makes it
  // 2, and the SECOND dispatch is the one under test — its snapshot, its evidence
  // row and its argv must agree.
  armCloneSubstrate();
  const KEY = "pk-fg666-amend";
  const projectDir = dbModeProject(KEY, "FG-1", "original body");

  writeTransaction(() =>
    upsertTicket({
      projectKey: KEY,
      ticketId: "FG-1",
      type: "story",
      status: "active",
      title: "title FG-1",
      body: "AMENDED-ACCEPTANCE-CRITERIA",
      importedAt: NOW,
    }),
  );
  const amended = db
    .prepare(`SELECT revision, body_hash AS bodyHash FROM tickets WHERE project_key = ? AND ticket_id = ?`)
    .get(KEY, "FG-1") as { revision: number; bodyHash: string };
  assert.equal(amended.revision, 2, "the fixture really amended the ticket");

  const capture: ExecCapture = { calls: 0, args: [] };
  const { runId } = await dispatch(projectDir, capturingExec(capture), { ticketId: "FG-1" });
  const task = primaryTask(runId);
  const hostDir = backlogSnapshotHostDir(task.id);
  dirs.push(hostDir);

  const row = db
    .prepare(`SELECT revision, body_hash AS bodyHash FROM ticket_dispatch_evidence WHERE task_id = ?`)
    .get(task.id) as { revision: number; bodyHash: string };
  assert.equal(row.revision, amended.revision, "the evidence row names the revision that was published");
  assert.equal(row.bodyHash, amended.bodyHash);

  const dispatched = capture.args.filter((a) => a.startsWith("FORGE_DISPATCHED_TICKET="));
  assert.deepEqual(
    dispatched,
    [`FORGE_DISPATCHED_TICKET=FG-1:${amended.revision}:${amended.bodyHash}`],
    "and the container is told the SAME revision the evidence records",
  );

  // The claim is only worth anything if the mounted snapshot really holds that body.
  const snap = new Database(join(hostDir, SNAPSHOT_DB_BASENAME), { readonly: true });
  try {
    const t = snap.prepare(`SELECT body FROM tickets WHERE ticket_id = ?`).get("FG-1") as { body: string };
    assert.equal(t.body, "AMENDED-ACCEPTANCE-CRITERIA", "the snapshot the container reads carries that revision");
  } finally {
    snap.close();
  }
});

// ─── (15) AC4: publication can DEGRADE a healthy resolution ─────────────────

test("FG-666 (15): a ticketed dispatch whose snapshot cannot be PUBLISHED is refused — the refusal re-checks what publication produced", async () => {
  // The resolution is perfect; the marker/snapshot write is what fails. Publication
  // converts that into mode `unknown`, and an `unknown` marker makes the container's
  // reader refuse every backlog read. A refusal decided only against the RESOLVED
  // value would start that container anyway: ticketed, and blind — the exact
  // invariant this ticket exists to establish.
  //
  // Blocked by making ~/.forge/backlog-snapshots a FILE, so no task's snapshot
  // directory can be created under it.
  armCloneSubstrate();
  const KEY = "pk-fg666-nopublish";
  const projectDir = dbModeProject(KEY, "FG-1", "body");

  const snapshotsRoot = dirname(backlogSnapshotHostDir("probe"));
  rmSync(snapshotsRoot, { recursive: true, force: true });
  mkdirSync(dirname(snapshotsRoot), { recursive: true });
  writeFileSync(snapshotsRoot, "not a directory");
  dirs.push(snapshotsRoot);

  const capture: ExecCapture = { calls: 0, args: [] };
  const { runId, wave } = await dispatch(projectDir, capturingExec(capture), { ticketId: "FG-1" });

  assert.deepEqual(wave.failedSteps, ["build"], "the dispatch is refused");
  assert.equal(capture.calls, 0, "and no agent container was started");

  const task = primaryTask(runId);
  assert.equal(
    failureKindFromEvents(eventsForTask(task.id)),
    "backlog_authority_unresolvable",
    "recorded as the RETRYABLE infrastructure refusal — a re-dispatch re-resolves and may well succeed",
  );
  const refusal = eventsForTask(task.id).filter((e) => e.eventType === "task.backlog_authority_refused");
  assert.equal(refusal.length, 1);
  assert.equal((refusal[0]!.payload as Record<string, unknown>)["stage"], "publish", "at the PUBLICATION stage");
  assert.equal(
    eventsForTask(task.id).some((e) => e.eventType === "container.started"),
    false,
    "nothing was started for a task that would have run blind",
  );
});

// ─── (16) AC5: a RED's authority is not readable out of the tree it reviews ──

test("FG-666 (16): an agent that COMMITS a foreign project_key cannot make its own reviewers refuse", async () => {
  // The security half of "resolved from Forge-owned run state". A red is dispatched
  // with projectDir = the publisher's CANDIDATE worktree, whose tracked
  // .forge/config.yml is content merged out of the agent's private clone. Resolving
  // the identity question from it means an agent can commit any unregistered or
  // foreign project_key and make every subsequent red on a ticketed run resolve
  // `unknown` and be refused before its container starts — an identity-forgery
  // vector against the review lane itself, with blue steps (resolved against the
  // run's project directory) unaffected.
  //
  // The red still MOUNTS the candidate. Only the identity question is asked
  // elsewhere.
  armCloneSubstrate();
  const KEY = "pk-fg666-red-authority";
  const FORGED = "pk-fg666-forged";
  const projectDir = dbModeProject(KEY, "FG-1", "body");
  registerKeyToForeignRepo(FORGED);

  const { runId } = startRun({
    workflow: SEAM_WORKFLOW_WITH_RED,
    title: "fg666 red authority",
    inputs: { ticketId: "FG-1" },
    projectDir,
  });

  let calls = 0;
  let redProjectMount: string | undefined;
  let redCandidateConfig: string | undefined;
  const stubExec: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
    calls += 1;
    const mount = projectMountSource(args);
    mkdirSync(dirname(stdoutPath), { recursive: true });
    writeFileSync(stdoutPath, "stub stdout");
    writeFileSync(stderrPath, "");
    if (calls === 1) {
      // The BLUE agent, in its private clone: commit a project_key belonging to
      // another repository.
      assert.ok(mount, "the blue agent's /project mount must be in the argv");
      writeFileSync(join(mount!, ".forge", "config.yml"), `project_key: ${FORGED}\n`);
      execFileSync("git", ["add", "-A"], { cwd: mount!, stdio: "ignore" });
      execFileSync(
        "git",
        ["-c", "user.name=Agent", "-c", "user.email=agent@forge.test", "commit", "-m", "forge config"],
        { cwd: mount!, stdio: "ignore" },
      );
      writeFileSync(
        join(dirname(stdoutPath), "result.json"),
        JSON.stringify({ status: "complete", tests_run: 1, tests_passed: 1, files_modified: [".forge/config.yml"] }),
      );
      return 0;
    }
    redProjectMount = mount;
    // Read the candidate's config HERE: the publication worktree is torn down once
    // the wave finishes, so red time is the only moment it can be observed.
    redCandidateConfig = mount && existsSync(join(mount, ".forge", "config.yml"))
      ? readFileSync(join(mount, ".forge", "config.yml"), "utf8")
      : undefined;
    writeFileSync(
      join(dirname(stdoutPath), "result.json"),
      JSON.stringify({ status: "complete", verdict: "inconclusive", confidence: "low", findings: [] }),
    );
    return 0;
  };

  await runNext({ runId, workflow: SEAM_WORKFLOW_WITH_RED, dockerExec: stubExec });

  const red = tasksForRun(runId).find((t) => t.phase === "build" && t.parentId !== undefined);
  assert.ok(red, "a red task must have been dispatched");
  dirs.push(backlogSnapshotHostDir(red!.id));
  for (const t of tasksForRun(runId)) dirs.push(backlogSnapshotHostDir(t.id));

  // The fixture only proves something if the tree the red reviewed really carries
  // the forged key.
  assert.ok(redProjectMount, "the red's /project mount must have been observed");
  assert.notEqual(redProjectMount, projectDir, "and it really is the candidate, not the project directory");
  assert.match(
    redCandidateConfig ?? "",
    new RegExp(FORGED),
    "the candidate the red mounts really does declare the agent's forged project_key",
  );

  assert.deepEqual(
    eventsForTask(red!.id).filter((e) => e.eventType === "task.backlog_authority_refused"),
    [],
    "the red is NOT refused: its authority came from the run's project directory, not from the tree under review",
  );
  const marker = readMarker(backlogSnapshotHostDir(red!.id));
  assert.equal(marker.mode, "db", "and it resolved the REAL project's store");
  assert.equal(marker.projectKey, KEY, "under the real project_key, not the committed one");
});

// ─── (13) AC7: `forge invoke` — the OTHER production buildDockerArgs caller ──

test("FG-666 (13): a `forge invoke` dispatch still resolves mode db with the correct project_key", async () => {
  // invoke.ts is edited by no step. It passes PROJECT_DIR = args.projectDir with no
  // worktree substitution, so its authority already resolved correctly — the
  // optional-parameter design is what preserves that, and this is the proof rather
  // than the argument.
  const KEY = "pk-fg666-invoke";
  const projectDir = dbModeProject(KEY, "FG-1", "body");

  const capture: ExecCapture = { calls: 0, args: [] };
  const r = await invoke({
    agentRole: "engineer",
    task: "do the thing",
    projectDir,
    runtimeName: "fg666-seam-test",
    dockerExec: capturingExec(capture),
  });

  assert.equal(r.status, "complete", r.error ?? "");
  const hostDir = backlogSnapshotHostDir(r.taskId);
  dirs.push(hostDir);
  const marker = readMarker(hostDir);
  assert.equal(marker.mode, "db", "invoke's authority still resolves");
  assert.equal(marker.projectKey, KEY);
  assert.equal(snapshotBindSource(capture.args), hostDir, "and its argv still carries the snapshot bind");
});
