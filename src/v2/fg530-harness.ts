// FG-530 — the crash-point harness, shared by both lanes.
//
// Extracted from fg530-crash-matrix.integration.test.ts so the worktree-tier lane
// (fg530-crash-worktree.worktree.test.ts) drives the SAME machinery: one kill-point
// registry, one crash driver, one fixpoint loop, one set of invariant checkers, one
// known-failure list. Two copies of a crash harness would drift, and a drifted
// checker vouching for a green lane is exactly the failure this file prevents.
//
// Test support only: nothing here is imported by production code. The scenario sets
// live with their lanes — the machinery is what is shared.
//
// The harness's contract, unchanged from the matrix:
//   crashAt   — arm ONE named probe; at the probe the process DIES (the store is
//               taken away and the throw goes up), so nothing after the kill writes.
//   recoverToFixpoint — reconcile + runNext until two consecutive snapshots match.
//   the five checkers — named predicates over the post-recovery DB state, reusing
//               the production predicates rather than re-deriving lifecycle semantics.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Database as DatabaseInstance } from "better-sqlite3";

import { getDb, setDbForTest } from "../store/db.js";
import { tasksForRun, getTask } from "../store/tasks.js";
import { verdictsForTask } from "../store/verdicts.js";
import { eventsForTask } from "../store/events.js";
import { getRun } from "../store/runs.js";
import { taskDir } from "../util/paths.js";

import { setCrashHookForTest } from "./crash-points.js";
import { runNext, type DockerExecFn } from "./runNext.js";
import { verdictBlocksGate, findStep } from "./gate.js";
import { reconcileRun } from "./reconcile.js";
import { computeReadyQueue } from "./ready-queue.js";
import { isPhasePrimaryRow } from "./lifecycle-evaluator.js";
import { evaluateValidationContract } from "./validation-contract.js";
import { retryPolicy } from "./retry-policy.js";
import type { Workflow, Step } from "./schema.js";
import type { Task, TaskStatus } from "../types/index.js";

// ── kill-point registry ───────────────────────────────────────────────────────
//
// Walked off the production write sequences, not hand-picked:
//   dispatch  — runContainer's PRE-container span (markTaskRunning + task.started,
//               then minutes of image pull / auth staging / provisioning before
//               container.started — FG-533's wedge), then dispatchSingleStep's
//               post-container sequence (result ingestion → validation-contract
//               hold → awaiting_red → verdict inserts → blocked_by_red →
//               finalizePrimary → event appends), and dispatchFanoutStep's own
//               awaiting_red and blocked_by_red transitions — the fanout PARENT's
//               copy of those windows, separate callsites over a row no container
//               ever ran (and, for blocked_by_red, a separate FG-482 transaction
//               with its own ordering and CAS), so the single-step cells cannot
//               vouch for them
//   gate      — gate.ts's decision writes (advance, reject + on_reject recovery
//               mint OR dedup onto an existing recovery row, request-changes
//               replacement mint OR dedup onto an existing pending primary)
//   reconcile — reconcile.ts's own writes: the FG-479 failPipelineUnfinalized
//               landing (what a crashed PIPELINE step recovers into), its own
//               COMPLETION path on an invoke-like run (result on disk, or one
//               recovered from stdout — the only reconcile writes that END a
//               lifecycle rather than landing it fail-safe), the three
//               no-recoverable-result failure landings the container-gone sweep
//               chooses between (oom_killed, orphaned_work_may_persist,
//               orphaned — each a distinct evidence base and branch, so each is
//               killed in its own cell rather than vouched for by transactional
//               similarity to the others), the FG-455 Mode A backfill of a
//               complete-but-resultless row, BOTH arms of the fanout-parent
//               recovery (all children complete, or a partial wave), and the
//               FG-437 mid-provisioning landing (a DISTINCT evidence base —
//               container.provision_started with no provision_succeeded — reached
//               BEFORE the container-liveness gate, so no other reconcile cell
//               covers it)
//
// A `reconcile` cell is a crash WHILE RECOVERING from a crash: reconcile's writes
// only have anything to act on once a task is already stranded, so the driver
// strands one first (hook off), then arms the hook for the recovery reconcile. The
// shape it must strand DEPENDS on the write being killed — a stranded primary for
// the failPipelineUnfinalized landing and for the invoke-like completion, a
// stranded primary with NO result.json for the stdout-recovered completion, a
// stranded primary with NO recoverable result at all (plus, per landing, a
// docker-reported OOM kill or a dirty worktree) for the three failure landings, a
// COMPLETE row whose result was lost for the backfill, a stranded fanout PARENT
// for either fanout arm (reconcile skips parents in the per-task loop: they never
// get a container), and a task stranded MID-PROVISIONING (running, a
// container.provision_started event, no provision_succeeded, no container.started)
// for the FG-437 landing. Scenario.strand owns that; see runCrashPhase.
//
// The write-surface guard in fg530-probe-inertness.test.ts is what keeps this
// registry honest going forward: every state-write in the three covered files must
// carry a probe registered here, or an allowlist entry with a written reason.

export type Surface = "dispatch" | "gate" | "reconcile";
export type KillPoint = { point: string; surface: Surface };

export const KILL_POINTS: KillPoint[] = [
  { point: "runContainer:after-mark-running-before-container-launch", surface: "dispatch" },
  { point: "dispatchSingleStep:after-result-ingest", surface: "dispatch" },
  { point: "dispatchSingleStep:before-validation-contract", surface: "dispatch" },
  { point: "holdIfValidationContractFails:between-hold-status-and-event", surface: "dispatch" },
  { point: "dispatchSingleStep:before-awaiting-red", surface: "dispatch" },
  { point: "dispatchSingleStep:between-awaiting-red-status-and-event", surface: "dispatch" },
  { point: "dispatchSingleStep:after-awaiting-red", surface: "dispatch" },
  { point: "dispatchReds:before-verdict-insert", surface: "dispatch" },
  { point: "dispatchReds:inside-verdict-insert-txn", surface: "dispatch" },
  { point: "dispatchReds:after-verdict-insert", surface: "dispatch" },
  { point: "dispatchSingleStep:before-blocked-by-red", surface: "dispatch" },
  { point: "dispatchSingleStep:inside-blocked-by-red-txn", surface: "dispatch" },
  { point: "dispatchSingleStep:after-blocked-by-red", surface: "dispatch" },
  { point: "dispatchFanoutStep:before-awaiting-red", surface: "dispatch" },
  { point: "dispatchFanoutStep:between-awaiting-red-status-and-event", surface: "dispatch" },
  { point: "dispatchFanoutStep:after-awaiting-red", surface: "dispatch" },
  { point: "dispatchFanoutStep:before-blocked-by-red", surface: "dispatch" },
  { point: "dispatchFanoutStep:inside-blocked-by-red-txn", surface: "dispatch" },
  { point: "dispatchFanoutStep:after-blocked-by-red", surface: "dispatch" },
  { point: "finalizePrimary:before-status-write", surface: "dispatch" },
  { point: "finalizePrimary:between-complete-status-and-event", surface: "dispatch" },
  { point: "finalizePrimary:between-awaiting-gate-status-and-event", surface: "dispatch" },
  { point: "gate:before-decision-write", surface: "gate" },
  { point: "gate:inside-decision-write-txn", surface: "gate" },
  { point: "gate:after-decision-write", surface: "gate" },
  { point: "gate:advance:between-complete-status-and-event", surface: "gate" },
  { point: "gate:advance:after-complete-write", surface: "gate" },
  { point: "gate:advance:fanout-reentry:before-reentry-write", surface: "gate" },
  { point: "gate:advance:fanout-reentry:inside-reentry-write-txn", surface: "gate" },
  { point: "gate:advance:fanout-reentry:after-reentry-write", surface: "gate" },
  { point: "gate:reject:before-fail-write", surface: "gate" },
  { point: "gate:reject:inside-txn-between-fail-and-recovery-mint", surface: "gate" },
  { point: "gate:reject:inside-txn-between-recovery-mint-and-event", surface: "gate" },
  { point: "gate:reject:after-recovery-mint", surface: "gate" },
  { point: "gate:reject:dedup:inside-txn-between-inputs-and-lineage", surface: "gate" },
  { point: "gate:reject:dedup:inside-txn-between-lineage-and-event", surface: "gate" },
  { point: "gate:request-changes:before-fail-write", surface: "gate" },
  { point: "gate:request-changes:between-fail-and-replacement-mint", surface: "gate" },
  { point: "gate:request-changes:between-replacement-mint-and-event", surface: "gate" },
  { point: "gate:request-changes:dedup:between-inputs-and-event", surface: "gate" },
  { point: "gate:after-branch", surface: "gate" },
  { point: "reconcile:before-fail-pipeline-unfinalized", surface: "reconcile" },
  { point: "reconcile:inside-fail-pipeline-unfinalized-txn", surface: "reconcile" },
  { point: "reconcile:before-fail-oom-killed", surface: "reconcile" },
  { point: "reconcile:inside-fail-oom-killed-txn", surface: "reconcile" },
  { point: "reconcile:before-fail-orphaned-work-may-persist", surface: "reconcile" },
  { point: "reconcile:inside-fail-orphaned-work-may-persist-txn", surface: "reconcile" },
  { point: "reconcile:before-fail-orphaned-no-result", surface: "reconcile" },
  { point: "reconcile:inside-fail-orphaned-no-result-txn", surface: "reconcile" },
  { point: "reconcile:before-complete-invoke-like", surface: "reconcile" },
  { point: "reconcile:inside-complete-invoke-like-txn", surface: "reconcile" },
  { point: "reconcile:before-complete-invoke-like-from-stdout", surface: "reconcile" },
  { point: "reconcile:inside-complete-invoke-like-from-stdout-txn", surface: "reconcile" },
  { point: "reconcile:before-backfill-complete-empty-result", surface: "reconcile" },
  { point: "reconcile:inside-backfill-complete-empty-result-txn", surface: "reconcile" },
  { point: "reconcile:before-fail-fanout-parent-unfinalized", surface: "reconcile" },
  { point: "reconcile:inside-fail-fanout-parent-unfinalized-txn", surface: "reconcile" },
  { point: "reconcile:before-fail-fanout-wave-orphaned", surface: "reconcile" },
  { point: "reconcile:inside-fail-fanout-wave-orphaned-txn", surface: "reconcile" },
  { point: "reconcile:before-fail-provisioning-phase-crash", surface: "reconcile" },
  { point: "reconcile:inside-fail-provisioning-phase-crash-txn", surface: "reconcile" },
  // FG-531: the awaiting_red sweep's own writes (dead red rows, then the
  // single-step / fanout-parent fail-safe landings).
  { point: "reconcile:before-fail-dead-red-child", surface: "reconcile" },
  { point: "reconcile:inside-fail-dead-red-child-txn", surface: "reconcile" },
  { point: "reconcile:before-fail-awaiting-red-orphaned", surface: "reconcile" },
  { point: "reconcile:inside-fail-awaiting-red-orphaned-txn", surface: "reconcile" },
  { point: "reconcile:before-fail-awaiting-red-fanout-parent", surface: "reconcile" },
  { point: "reconcile:inside-fail-awaiting-red-fanout-parent-txn", surface: "reconcile" },
];

/** Look a kill point up BY NAME, so a lane that names one can never invent a probe
 *  the registry does not carry (a typo'd point would otherwise be a cell that
 *  silently never fires). */
export function killPoint(point: string): KillPoint {
  const kp = KILL_POINTS.find((k) => k.point === point);
  if (!kp) {
    throw new Error(
      `FG-530: '${point}' is not in the kill-point registry — a lane may only select points the registry carries`,
    );
  }
  return kp;
}

/** Every probe that actually fired, across every cell in the importing lane.
 *  Asserted against the registry by the matrix's coverage test: a kill point no
 *  scenario can reach is a production edit with zero coverage. */
export const FIRED = new Set<string>();

// ── runtimes + workflow YAML ──────────────────────────────────────────────────

export const RUNTIME = "fg530-runtime";
/** reconcile's stdout-recovery (FG-455 → FG-337 inferredResultFrom) only fires for a
 *  runtime whose log_format the provider-failure analyzer can read a final assistant
 *  message out of — today that is pi-jsonl. Without a pi-format runtime there is no
 *  path to the stdout-recovered completion write at all. */
export const PI_RUNTIME = "fg530-pi-runtime";
/** The worktree lane's runtime: identical, plus the PROJECT_DIR mount. In worktree
 *  mode that mount IS the task's worktree, so the fake container reaches its real
 *  work tree through the same docker args production would give it. */
export const WORKTREE_RUNTIME = "fg530-worktree-runtime";

function runtimeYaml(name: string, metadata: string, projectMount = false): string {
  return `name: ${name}
description: FG-530 crash-matrix stub runtime
${metadata}image: test-image:latest
models:
  default: test-model
auth:
  mode: apikey
mounts:
  - host: "\${TASK_DIR}"
    container: /task
    mode: rw
${
  projectMount
    ? `  - host: "\${PROJECT_DIR}"
    container: /project
    mode: "\${PROJECT_MODE:-rw}"
`
    : ""
}invocation:
  command: echo
  args: ["stub"]
container:
  name: "forge-\${TASK_ID}"
result:
  file: /task/result.json
`;
}

export function ensureRuntime(): void {
  const dir = join(process.env["FORGE_HOME"]!, "runtimes");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${RUNTIME}.yml`), runtimeYaml(RUNTIME, ""));
  writeFileSync(
    join(dir, `${PI_RUNTIME}.yml`),
    runtimeYaml(PI_RUNTIME, "runtime_kind: pi\nlog_format: pi-jsonl\n"),
  );
  writeFileSync(join(dir, `${WORKTREE_RUNTIME}.yml`), runtimeYaml(WORKTREE_RUNTIME, "", true));
}

/** gate.ts loads the workflow BY NAME off FORGE_HOME (runNext takes it as an
 *  arg), so any gate-driven scenario needs the YAML on disk too. */
export function writeWorkflowYaml(name: string, yaml: string): void {
  const dir = join(process.env["FORGE_HOME"]!, "workflows");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.yml`), yaml);
}

// ── the fake docker layer ─────────────────────────────────────────────────────

export type ExecOpts = {
  redVerdict: "pass" | "fail";
  /** Omit tests_run from the primary's result so it FAILS the FG-523 validation
   *  contract — the only way to reach holdIfValidationContractFails's hold write. */
  primaryFailsContract?: boolean;
  /** Write NO result.json and leave a pi-jsonl narrative on stdout instead — the
   *  shape reconcile's stdout-recovered completion is built to recover from. */
  narrativeStdoutOnly?: boolean;
  /** What the primary claims it changed. The worktree lane needs real entries so
   *  checkResultPersistence runs against real files in the task's worktree; the
   *  matrix cells claim nothing and the check is skipped, exactly as before. */
  filesModified?: string[];
  /** The worktree lane's agent work: called with the host path behind the /project
   *  mount (in worktree mode, the task's git worktree) before the result lands, so
   *  a kill downstream of it has REAL work on disk to discard. */
  agentWork?: (args: { projectMountHost: string | undefined; taskId: string }) => void;
};

/** A clean pi run whose agent honored nothing but its own narrative: agent_end with
 *  a final assistant message and no result.json. analyzePiFailure reads the message
 *  out as finalAssistantText, which inferredResultFrom turns into a result for a
 *  narrative role. */
const PI_NARRATIVE_STDOUT = JSON.stringify({
  type: "agent_end",
  messages: [{ role: "assistant", content: "FG-530 fixture: the research narrative this run produced" }],
});

/** The host-side path behind the container's `-v <host>:/project:<mode>` arg. In
 *  worktree mode that is the task's worktree — the only place the fake container
 *  can write work the way a real agent does. */
export function projectMountHost(dockerArgs: string[]): string | undefined {
  for (let i = 0; i < dockerArgs.length - 1; i++) {
    if (dockerArgs[i] === "-v" && dockerArgs[i + 1]!.includes(":/project:")) {
      return dockerArgs[i + 1]!.split(":")[0];
    }
  }
  return undefined;
}

/** Fake docker layer. Primaries return an implementer-shaped result that (by
 *  default) SATISFIES the validation contract, so the contract hold is not the
 *  accidental outcome of every cell; reds return a verdict-shaped result.
 *  The red's finding carries real `evidence` and no file/line citation, so it
 *  survives validateVerdict (nothing to verify) and gradeFindings (evidence
 *  present ⇒ no severity downgrade) — an authoritative fail that actually
 *  blocks, which is what the blocked_by_red kill points need. */
export function makeExec(opts: ExecOpts): DockerExecFn {
  return async ({ args, stdoutPath, stderrPath }) => {
    const nameIdx = args.indexOf("--name");
    const taskId = (nameIdx >= 0 ? (args[nameIdx + 1] ?? "") : "").replace(/^forge-/, "");
    const dir = dirname(stdoutPath);
    mkdirSync(dir, { recursive: true });

    if (opts.narrativeStdoutOnly) {
      writeFileSync(stdoutPath, PI_NARRATIVE_STDOUT);
      writeFileSync(stderrPath, "");
      return 0;
    }

    const isRed = taskId.includes("red") || taskId.includes("reviewer");
    // Reds are read-only reviewers and get no worktree (FG-351), so only a primary
    // has a work tree to write into.
    if (!isRed && opts.agentWork) opts.agentWork({ projectMountHost: projectMountHost(args), taskId });

    // The fanout scenario's upstream step: its result carries the array the
    // fanout step reads (`from_upstream.array_key`). One element ⇒ one child.
    const isFanoutUpstream = taskId.startsWith("task-plan-");
    const filesModified = opts.filesModified ?? [];
    const result = isRed
      ? {
          status: "complete",
          verdict: opts.redVerdict,
          confidence: 0.9,
          findings:
            opts.redVerdict === "fail"
              ? [
                  {
                    severity: "high",
                    summary: "seeded authoritative failure (FG-530 crash-matrix fixture)",
                    evidence:
                      "the crash-matrix arms this red to fail so the primary reaches the blocked_by_red write boundary",
                    hypothesis: "n/a — fixture",
                  },
                ]
              : [],
        }
      : opts.primaryFailsContract
        ? { status: "complete", files_modified: filesModified }
        : isFanoutUpstream
          ? { status: "complete", tests_run: 1, files_modified: filesModified, units: ["alpha"] }
          : { status: "complete", tests_run: 1, files_modified: filesModified };

    writeFileSync(join(dir, "result.json"), JSON.stringify(result));
    writeFileSync(stdoutPath, "stub stdout");
    writeFileSync(stderrPath, "");
    return 0;
  };
}

export function step(id: string, over: Partial<Step> = {}): Step {
  return {
    id,
    agent: "engineer",
    gate: "auto",
    manual: false,
    depends_on: [],
    runtime: RUNTIME,
    reds: [],
    ...over,
  };
}

// ── scenarios ─────────────────────────────────────────────────────────────────

export type Scenario = {
  name: string;
  workflow: Workflow;
  yaml: string;
  exec: ExecOpts;
  /** Drive the run the way an operator would, to completion or to a gate.
   *  Each call is crash-able: the hook throws from inside whichever write
   *  boundary it targets, and nothing after it runs. */
  drive: (runId: string, workflow: Workflow, exec: DockerExecFn) => Promise<void>;
  /** Put the run in the state a `reconcile` kill point exists to recover FROM
   *  (hook off — this is the FIRST crash; the reconcile cell is the second).
   *  Defaults to strandMidFinalize, a primary stranded mid-finalize. A recovery
   *  that acts on a different stranded shape needs its own. */
  strand?: (sc: Scenario, runId: string, exec: DockerExecFn) => Promise<void>;
  /** What `docker inspect` reports for the dead container. Defaults to "nothing
   *  known" — only the OOM landing needs docker to have witnessed the kill. */
  exitInfo?: ExitInfoFake;
};

export function primaryOf(runId: string, phase: string): Task | undefined {
  return tasksForRun(runId).find((t) => t.phase === phase && isPhasePrimaryRow(t));
}

/** A phase can hold several primary rows once a gate has failed one and minted a
 *  replacement, so the gate-driving scenarios must name the one actually AT a
 *  gate — primaryOf() would hand back the failed original. */
export function awaitingGatePrimary(runId: string, phase: string): Task | undefined {
  return tasksForRun(runId).find(
    (t) => t.phase === phase && isPhasePrimaryRow(t) && t.status === "awaiting_gate",
  );
}

// ── the crash driver ──────────────────────────────────────────────────────────

export class CrashInjected extends Error {
  constructor(readonly point: string) {
    super(`FG-530 crash injected at ${point}`);
  }
}

/** The dead process reaching for the store AFTER the kill. A subclass so the
 *  driver swallows it exactly like the kill itself — it IS the kill, just observed
 *  one call later. */
class DeadProcessStoreAccess extends CrashInjected {
  constructor(point: string) {
    super(point);
    this.message = `FG-530: the process died at ${point} — it cannot touch the store again`;
  }
}

/** A DB handle a dead process holds: every access throws. Throwing a THROW is the
 *  only faithful model of the kill, because the code under test is allowed to catch.
 *
 *  reconcile.ts's FG-459 guards deliberately swallow any throw from one task's
 *  writes and keep sweeping — the right production contract (a SQLITE_BUSY must not
 *  abort the pass), and fatal to the crash model if the injected throw is all we do:
 *  a "dead" process would go on reconciling, finalizing, and completing state that a
 *  real crash could never have written, and the fresh recovery pass would start from
 *  a world the crash never produced. So the hook ALSO takes the store away. The
 *  guards may still catch the throw; they cannot make the dead process write. */
function deadDb(point: string): DatabaseInstance {
  return new Proxy({} as DatabaseInstance, {
    get() {
      throw new DeadProcessStoreAccess(point);
    },
  });
}

/** Arm the hook at ONE point, run `fn`, swallow only OUR injected crash.
 *  Any other throw is a real failure and propagates.
 *
 *  At the probe the process DIES: the store is replaced with `deadDb` and the throw
 *  goes up. Whatever catches it (reconcile's FG-459 guards; a runNext/gate handler)
 *  can no longer read or write a row, so no state mutates after the kill and the
 *  fresh pass in step 3 starts from exactly the world the crash left behind. The real
 *  DB is restored when the crashed call unwinds. */
export async function crashAt(
  point: string,
  fn: () => Promise<unknown> | unknown,
  onFire?: () => void,
): Promise<boolean> {
  const live = getDb(); // the store the crashed process is about to lose
  let fired = false;
  setCrashHookForTest((p) => {
    if (p !== point) return;
    // onFire runs at the INSTANT of death — before the store is taken away, the only
    // moment the pre-kill world is observable. Once only: the process dies here.
    if (!fired) {
      fired = true;
      onFire?.();
    }
    setDbForTest(deadDb(p));
    throw new CrashInjected(p);
  });
  try {
    await fn();
  } catch (e) {
    if (!(e instanceof CrashInjected)) throw e;
  } finally {
    setCrashHookForTest(undefined);
    setDbForTest(live); // the crashed process is gone; the fresh pass gets a live store
  }
  if (fired) FIRED.add(point);
  return fired;
}

/** docker's answer to `inspect` for the dead container, per scenario. Default: it
 *  knows nothing. Set from the scenario in runCrashPhase so the recovery passes
 *  (which reconcile the SAME dead world) see the same answer the crash pass did. */
export type ExitInfoFake = () => { exitCode?: number; oomKilled?: boolean };
export const DOCKER_KNOWS_NOTHING: ExitInfoFake = () => ({});
let exitInfoFake: ExitInfoFake = DOCKER_KNOWS_NOTHING;

/** Reset the docker-inspect fake. Every lane's afterEach calls it — an exitInfo
 *  leaking into the next cell would silently change which reconcile branch it takes. */
export function resetExitInfoFake(): void {
  exitInfoFake = DOCKER_KNOWS_NOTHING;
}

const RECONCILE_FAKES = [
  () => false, // containerAlive: the crashed process's containers are gone
  () => "not_found" as const, // reapContainer
] as const;

export function reconcile(runId: string): void {
  reconcileRun(runId, RECONCILE_FAKES[0], RECONCILE_FAKES[1], exitInfoFake);
}

/** Strand a task mid-finalize the way a real crash does: the container ran and
 *  wrote result.json, but the host-side finalize never happened, so the row is
 *  still `running`. This is the state reconcile's own writes exist to clean up,
 *  and therefore the precondition for exercising a `reconcile` kill point. */
export async function strandMidFinalize(sc: Scenario, runId: string, exec: DockerExecFn): Promise<void> {
  await crashAt("dispatchSingleStep:after-result-ingest", () => sc.drive(runId, sc.workflow, exec));
}

export const strandFor = (sc: Scenario): NonNullable<Scenario["strand"]> => sc.strand ?? strandMidFinalize;

/** Strand a task the way the container-gone sweep's three failure landings need it:
 *  `running`, container gone, and NOTHING recoverable. The container ran (so
 *  container.started is on the record and the sweep looks at the task at all), but
 *  the result never survived — result.json is removed, and the stub runtime declares
 *  no log_format, so the FG-337 stdout synthesizer has nothing to infer from either.
 *  Which of the three landings reconcile then chooses is decided purely by the
 *  evidence the scenario adds on top (docker's OOM verdict, a dirty work path). */
export async function strandWithNoRecoverableResult(
  sc: Scenario,
  runId: string,
  exec: DockerExecFn,
): Promise<void> {
  await strandMidFinalize(sc, runId, exec);
  const t = primaryOf(runId, "build");
  assert.ok(t, "the primary must exist for this strand to mean anything");
  rmSync(join(taskDir(runId, t.id), "result.json"), { force: true });
}

/** Make `git status --porcelain` report changed files at the task's work path — the
 *  evidence that separates orphaned_work_may_persist from a plain orphan. With no
 *  dedicated worktree the run's projectDir IS that path, which is the
 *  `project_dir_shared` source reconcile records; in worktree mode the task's own
 *  worktree is (see the worktree lane, which dirties that instead). */
export function dirtyWorkPath(runId: string): void {
  const dir = getRun(runId)?.projectDir;
  assert.ok(dir, "the run must have a projectDir to dirty");
  if (!existsSync(join(dir, ".git"))) execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "work-the-agent-may-have-persisted.txt"), "uncommitted");
}

/** `persistedPreKill` is measured INSIDE the crash hook — the state of the world
 *  at the instant the process died, which is what invariant 4 is about. Capturing
 *  it after the driver returns (as v1 did) would miss any result or worktree the
 *  injected sequence discarded on its way down: the baseline would already be the
 *  post-discard state, and the invariant could never see it.
 *
 *  A cell whose scenario never reaches its kill point runs to its natural end; the
 *  post-drive state is then the only baseline there is, and the invariant still
 *  holds recovery to it. */
export async function runCrashPhase(
  sc: Scenario,
  runId: string,
  exec: DockerExecFn,
  kp: KillPoint,
): Promise<{ fired: boolean; persistedPreKill: PersistedWork }> {
  let atKill: PersistedWork | undefined;
  const measure = (): void => {
    atKill = capturePersistedWork(runId);
  };

  exitInfoFake = sc.exitInfo ?? DOCKER_KNOWS_NOTHING;

  let fired: boolean;
  if (kp.surface === "reconcile") {
    await strandFor(sc)(sc, runId, exec);
    fired = await crashAt(kp.point, () => reconcile(runId), measure);
  } else {
    fired = await crashAt(kp.point, () => sc.drive(runId, sc.workflow, exec), measure);
  }
  return { fired, persistedPreKill: atKill ?? capturePersistedWork(runId) };
}

// ── state snapshot + fixpoint ─────────────────────────────────────────────────

/** Everything a recovery pass could write, at FULL row fidelity. Two identical
 *  snapshots ⇒ the pass was a no-op ⇒ fixpoint.
 *
 *  It reads `SELECT *` over the real tables rather than projecting named fields:
 *  a projection only sees what someone remembered to list, so a pass that
 *  rewrote a result body, a task_package's inputs, a worktree path or a
 *  started_at could read as a "no-op" and the fixpoint assertion would vouch for
 *  a write it never looked at. With `SELECT *` a new column is covered the day
 *  it is added, by default rather than by remembering.
 *
 *  Column values are compared as SQLite returns them — raw TEXT, not parsed and
 *  re-normalized. That is deliberately the strict end: a row rewritten with the
 *  same logical JSON but different key order IS a write, and a write must fail
 *  the no-op assertion. NOTHING is excluded for the same reason — a timestamp
 *  column that ticks is the very evidence the pass wrote.
 *
 *  Events are per-owner (task id, or `<run>` for run-level rows) COUNT + TAIL:
 *  the count catches a pass that re-logs an event without changing a status
 *  (a state change, and an unbounded-event-growth bug), the tail names what it
 *  logged so the failure is diagnosable without a second run. */
type Row = Record<string, unknown>;
export type Snapshot = {
  run: Row | null;
  tasks: Row[];
  verdicts: Row[];
  gates: Row[];
  events: Record<string, { count: number; tail: Row[] }>;
};

const EVENT_TAIL = 5;

function sqlRows(sql: string, ...params: unknown[]): Row[] {
  return getDb().prepare(sql).all(...params) as Row[];
}

export function snapshot(runId: string): Snapshot {
  const tasks = sqlRows("SELECT * FROM tasks WHERE run_id = ? ORDER BY id", runId);
  const events: Snapshot["events"] = {};
  for (const e of sqlRows(
    `SELECT * FROM events
      WHERE run_id = ? OR task_id IN (SELECT id FROM tasks WHERE run_id = ?)
      ORDER BY id`,
    runId,
    runId,
  )) {
    const owner = (e["task_id"] as string | null) ?? "<run>";
    const bucket = (events[owner] ??= { count: 0, tail: [] });
    bucket.count += 1;
    bucket.tail.push(e);
    if (bucket.tail.length > EVENT_TAIL) bucket.tail.shift();
  }
  return {
    run: sqlRows("SELECT * FROM runs WHERE id = ?", runId)[0] ?? null,
    tasks,
    verdicts: sqlRows(
      "SELECT v.* FROM verdicts v JOIN tasks t ON t.id = v.task_id WHERE t.run_id = ? ORDER BY v.id",
      runId,
    ),
    gates: sqlRows("SELECT g.* FROM gates g JOIN tasks t ON t.id = g.task_id WHERE t.run_id = ? ORDER BY g.id", runId),
    events,
  };
}

export const snapshotKey = (s: Snapshot): string => JSON.stringify(s);

/** Deep diff, so a violation names the COLUMN that moved (`tasks[0].result`)
 *  rather than dumping two walls of JSON at the reader. */
export function diffSnapshots(before: Snapshot, after: Snapshot): string[] {
  const out: string[] = [];
  const trunc = (v: unknown): string => {
    const s = JSON.stringify(v) ?? "undefined";
    return s.length > 200 ? `${s.slice(0, 200)}…` : s;
  };
  const isObj = (v: unknown): v is Row => typeof v === "object" && v !== null && !Array.isArray(v);
  const walk = (a: unknown, b: unknown, path: string): void => {
    if (JSON.stringify(a) === JSON.stringify(b)) return;
    if (isObj(a) && isObj(b)) {
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) walk(a[k], b[k], `${path}.${k}`);
      return;
    }
    if (Array.isArray(a) && Array.isArray(b)) {
      for (let i = 0; i < Math.max(a.length, b.length); i++) walk(a[i], b[i], `${path}[${i}]`);
      return;
    }
    out.push(`${path}: ${trunc(a)} → ${trunc(b)}`);
  };
  walk(before, after, "");
  return out;
}

export const FIXPOINT_CAP = 12;

/** One recovery pass: what a fresh `forge next` after a crash actually does. */
export async function recoveryPass(runId: string, workflow: Workflow, exec: DockerExecFn): Promise<void> {
  reconcile(runId);
  await runNext({ runId, workflow, dockerExec: exec });
}

/** Invariant 5's driver: reconcile + runNext until nothing changes. Fails on
 *  the cap rather than looping — a recovery that never converges is the wedge
 *  this whole harness exists to catch. */
export async function recoverToFixpoint(runId: string, workflow: Workflow, exec: DockerExecFn): Promise<number> {
  let before = snapshotKey(snapshot(runId));
  for (let pass = 1; pass <= FIXPOINT_CAP; pass++) {
    await recoveryPass(runId, workflow, exec);
    const after = snapshotKey(snapshot(runId));
    if (after === before) return pass;
    before = after;
  }
  throw new Error(
    `INVARIANT 5 (fixpoint) VIOLATED: recovery did not converge in ${FIXPOINT_CAP} reconcile+runNext passes — state still changing. Final state: ${before}`,
  );
}

// ── the five invariants, as named checkers ────────────────────────────────────

export type Violation = { invariant: string; detail: string };

export const TERMINAL: ReadonlySet<TaskStatus> = new Set<TaskStatus>(["complete", "failed"]);

function failureKindOf(taskId: string): string | undefined {
  const failed = eventsForTask(taskId).filter((e) => e.eventType === "task.failed");
  const last = failed[failed.length - 1];
  const payload = last?.payload as { failure_kind?: string } | null | undefined;
  return payload?.failure_kind;
}

/** A gate.decided event with force:true is the AUDITED human override — the one
 *  documented way a task may complete over a blocking verdict or a validation
 *  hold. Anything else completing over them is a lost evidence chain. */
function hasForcedGateAdvance(taskId: string): boolean {
  return eventsForTask(taskId).some((e) => {
    if (e.eventType !== "gate.decided") return false;
    const p = e.payload as { decision?: string; force?: boolean } | null;
    return p?.decision === "advance" && p?.force === true;
  });
}

function hasValidationWaiver(taskId: string): boolean {
  return eventsForTask(taskId).some((e) => {
    if (e.eventType !== "task.decision") return false;
    const p = e.payload as { kind?: string } | null;
    return p?.kind === "validation_waiver";
  });
}

/** INVARIANT 1 — no `complete` without its evidence chain.
 *  A completed workflow primary must carry: its result, no BLOCKING verdict
 *  (the pre-FG-482 two-write dance is exactly a complete task with an
 *  authoritative fail on it), a verdict row for every gating red the step
 *  declares, and a satisfied-or-waived validation contract. */
export function checkNoCompleteWithoutEvidence(runId: string, workflow: Workflow): Violation[] {
  const v: Violation[] = [];
  const name = "1-no-complete-without-evidence-chain";
  for (const t of tasksForRun(runId)) {
    if (t.status !== "complete") continue;
    if (!isPhasePrimaryRow(t)) continue;
    const st = findStep(workflow, t.phase);
    if (!st || st.manual) continue;

    if (t.result === undefined || t.result === null) {
      v.push({ invariant: name, detail: `task ${t.id} (${t.phase}) is complete with NO result on its row` });
    }

    const verdicts = verdictsForTask(t.id);
    const blocking = verdicts.filter((row) =>
      verdictBlocksGate({ verdict: row.verdict, authority: row.authority, gateOnVerdict: row.gateOnVerdict }),
    );
    if (blocking.length > 0 && !hasForcedGateAdvance(t.id)) {
      v.push({
        invariant: name,
        detail:
          `task ${t.id} (${t.phase}) is complete while carrying ${blocking.length} BLOCKING verdict(s) ` +
          `[${blocking.map((b) => `${b.redRole}=${b.verdict}/${b.authority}`).join(", ")}] and no forced gate advance — ` +
          `a red's block was overwritten by a completion (the pre-FG-427/FG-482 two-write dance)`,
      });
    }

    // Per-role, per-count — not "are there ANY verdicts". A step declaring two
    // gating reds that completes carrying one passing verdict has lost half its
    // evidence chain, and a bare emptiness test reads that as fine.
    const gatingReds = st.reds.filter((r) => r.authority === "authoritative" && r.gate_on_verdict !== false);
    if (gatingReds.length > 0 && !hasForcedGateAdvance(t.id)) {
      const landed = new Map<string, number>();
      for (const row of verdicts) landed.set(row.redRole, (landed.get(row.redRole) ?? 0) + 1);
      const declared = new Map<string, number>();
      for (const r of gatingReds) declared.set(r.agent, (declared.get(r.agent) ?? 0) + 1);

      const short = [...declared]
        .filter(([role, want]) => (landed.get(role) ?? 0) < want)
        .map(([role, want]) => `${role} (${landed.get(role) ?? 0}/${want} verdict rows)`);

      if (short.length > 0) {
        v.push({
          invariant: name,
          detail:
            `task ${t.id} (${t.phase}) is complete but its step declares ${gatingReds.length} gating red(s) ` +
            `[${gatingReds.map((r) => r.agent).join(", ")}] and the verdict rows are MISSING for [${short.join(", ")}] — ` +
            `completed without the red evidence`,
        });
      }
    }

    // The contract binds the shapes production actually gates: single-step
    // primaries. A fanout PARENT is exempt, mirroring the FG-523 carve-out at
    // holdIfValidationContractFails (runNext.ts) — the parent runs no container,
    // and its result is a synthetic {status, children} aggregate that never
    // carries tests_run. Holding it here would make the checker stricter than the
    // contract it audits, and would flag every healthy wave. The real agent
    // results live on the CHILDREN, which are ungated today (they finalize via
    // markTaskComplete, not finalizePrimary) — a known gap, FG-524. They fall out
    // of this loop anyway: a child has a parentId, so isPhasePrimaryRow skips it.
    // When FG-524 lands, the child rows are what this invariant should grow to.
    const isFanoutParent = st.fanout !== undefined;
    const contract = isFanoutParent
      ? ({ held: false } as const)
      : evaluateValidationContract({ role: t.agentRole, result: t.result });
    if (contract.held && !hasValidationWaiver(t.id) && !hasForcedGateAdvance(t.id)) {
      v.push({
        invariant: name,
        detail: `task ${t.id} (${t.phase}) is complete but fails the validation contract (${contract.reason}) with no waiver and no forced gate advance`,
      });
    }
  }
  return v;
}

/** INVARIANT 2 — no permanent wedge.
 *  Every NON-TERMINAL task must have an enabled transition (its phase is in the
 *  ready queue — which is also how a live recovery/replacement row re-admits a
 *  phase) or a NAMED operator verb. Every TERMINAL-failed task must leave the
 *  operator a concrete verb too: retryPolicy is the production answer, so a
 *  failure kind that is neither retryable nor carrying `forge ...` advice is a
 *  dead end with nothing to type. */
export function checkNoPermanentWedge(runId: string, workflow: Workflow): Violation[] {
  const v: Violation[] = [];
  const name = "2-no-permanent-wedge";
  const tasks = tasksForRun(runId);
  const ready = new Set(computeReadyQueue(workflow, tasks).map((s) => s.id));

  for (const t of tasks) {
    if (TERMINAL.has(t.status)) {
      if (t.status !== "failed") continue;
      const kind = failureKindOf(t.id);
      const disposition = retryPolicy(kind, t.id);
      const verb = disposition.retryable
        ? `forge retry ${t.id}`
        : (disposition.advice ?? "").includes("forge ")
          ? disposition.advice
          : undefined;
      if (!verb) {
        v.push({
          invariant: name,
          detail:
            `failed task ${t.id} (${t.phase}, failure_kind=${kind ?? "none"}) is not retryable and retryPolicy offers ` +
            `no concrete operator command — the operator has nothing to type`,
        });
      }
      continue;
    }

    // Non-terminal: an enabled transition, or a named operator verb.
    if (ready.has(t.phase)) continue;
    if (t.status === "awaiting_gate" || t.status === "blocked_by_red") continue; // `forge gate <id> ...`
    if (t.status === "running") {
      // Whether container.started landed is the discriminator, not colour: it is the
      // event BOTH sweeps gate on, so a `running` row without it is unsweepable BY
      // CONSTRUCTION (FG-533) while one WITH it means the container-gone sweep itself
      // failed — a different, unknown bug. Naming it here is what lets the FG-533 pin
      // below match the first without absorbing the second.
      const started = eventsForTask(t.id).some((e) => e.eventType === "container.started");
      v.push({
        invariant: name,
        detail:
          `task ${t.id} (${t.phase}) is still 'running' at fixpoint — reconcile did not sweep it and no pass will ` +
          `[container.started seen: ${started ? "yes" : "no"}]`,
      });
      continue;
    }
    v.push({
      invariant: name,
      detail:
        `task ${t.id} (${t.phase}) is non-terminal ('${t.status}') but its phase is NOT in the ready queue ` +
        `[${[...ready].join(", ") || "empty"}] and its status carries no operator verb — permanently wedged`,
    });
  }

  const run = getRun(runId);
  if (run?.status === "active" && ready.size === 0 && !tasks.some((t) => !TERMINAL.has(t.status))) {
    v.push({
      invariant: name,
      detail: `run ${runId} is still 'active' with an empty ready queue and no non-terminal task — nothing will ever move it`,
    });
  }
  return v;
}

/** INVARIANT 3 — `abandoned` is never overwritten by completion.
 *  Task rows have no `abandoned` status (RunStatus does), so this is the run:
 *  a run abandoned before recovery must never be resurrected to complete. */
export function checkAbandonedNeverOverwritten(runId: string, wasAbandoned: boolean): Violation[] {
  if (!wasAbandoned) return [];
  const run = getRun(runId);
  if (run?.status === "abandoned") return [];
  return [
    {
      invariant: "3-abandoned-never-overwritten",
      detail: `run ${runId} was 'abandoned' before recovery but is now '${run?.status}' — recovery resurrected a cancelled run`,
    },
  ];
}

export type PersistedResult = { taskId: string; resultPath: string; bytes: string };
/** `files` is the work INSIDE the tree at the kill (repo-relative, .git excluded).
 *  A worktree directory that survives while the agent's files inside it were wiped
 *  is still a discard — the path is not the work. */
export type PersistedWorktree = { taskId: string; worktreePath: string; files: string[] };
/** The two things an agent leaves on disk: its result.json and, in worktree mode,
 *  the git worktree it worked in. Both are the crashed step's evidence, and both
 *  are what FG-352's no-discard rule keeps around after a failure. */
export type PersistedWork = { results: PersistedResult[]; worktrees: PersistedWorktree[] };

/** Snapshot the work the containers actually persisted. Call it AT the kill (see
 *  runCrashPhase) — a snapshot taken after the injected sequence unwinds cannot
 *  tell "never existed" from "existed and was discarded".
 *
 *  Worktrees are only ever populated when worktree mode is armed (FORGE_WORKTREES=1)
 *  AND preflightWorktreeGate passes. The matrix lane runs neither, so its cells carry
 *  none and this half of invariant 4 is inert there; the worktree-tier lane
 *  (fg530-crash-worktree.worktree.test.ts) is where it runs over REAL worktrees. */
export function capturePersistedWork(runId: string): PersistedWork {
  const results: PersistedResult[] = [];
  const worktrees: PersistedWorktree[] = [];
  for (const t of tasksForRun(runId)) {
    const p = join(taskDir(runId, t.id), "result.json");
    // An EMPTY result.json is not persisted work: runContainer writes a zero-byte
    // placeholder into the task dir BEFORE the container launches (so the mount has
    // the file to write into). A pre-container crash therefore always leaves one, and
    // counting it as work would make every recovery that fails such a task read as a
    // discard — the invariant would fire on a task whose agent never ran and produced
    // nothing to lose. Work is what the CONTAINER wrote, which is never empty.
    const bytes = existsSync(p) ? readFileSync(p, "utf8") : "";
    if (bytes.trim().length > 0) results.push({ taskId: t.id, resultPath: p, bytes });
    if (t.worktreePath && existsSync(t.worktreePath)) {
      worktrees.push({ taskId: t.id, worktreePath: t.worktreePath, files: worktreeFiles(t.worktreePath) });
    }
  }
  return { results, worktrees };
}

/** Every file in the tree, repo-relative, `.git` excluded (it is git's bookkeeping,
 *  not the agent's work, and it churns on every merge). */
export function worktreeFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === ".git") continue;
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(dir, e.name), rel);
      else out.push(rel);
    }
  };
  walk(root, "");
  return out.sort();
}

/** INVARIANT 4 — persisted work is never discarded.
 *  A result.json that existed before the kill must (a) still exist byte-identical
 *  after recovery, and (b) still be REFERENCED by its task row once that row is
 *  terminal — reconcile's failPipelineUnfinalized preserves the result onto the
 *  row precisely so a crashed step's work is inspectable, not silently dropped.
 *  A worktree that existed before the kill must survive too, unless its task went
 *  on to COMPLETE: removeWorktreeIfSafe is only ever called on a proven-merged
 *  worktree, so a crashed or failed step losing its worktree is the work-discard
 *  this invariant is named for. */
export function checkPersistedWorkNeverDiscarded(pre: PersistedWork): Violation[] {
  const v: Violation[] = [];
  const name = "4-persisted-work-never-discarded";
  for (const w of pre.results) {
    if (!existsSync(w.resultPath)) {
      v.push({ invariant: name, detail: `result.json for task ${w.taskId} existed before the kill and is GONE after recovery (${w.resultPath})` });
      continue;
    }
    const now = readFileSync(w.resultPath, "utf8");
    if (now !== w.bytes) {
      v.push({ invariant: name, detail: `result.json for task ${w.taskId} was REWRITTEN during recovery (persisted work must be preserved verbatim)` });
    }
    const t = getTask(w.taskId);
    if (!t) {
      v.push({ invariant: name, detail: `task ${w.taskId} had persisted work but its row VANISHED during recovery` });
      continue;
    }
    if (TERMINAL.has(t.status) && (t.result === undefined || t.result === null)) {
      v.push({
        invariant: name,
        detail:
          `task ${w.taskId} persisted a result before the kill and is now terminal ('${t.status}') with NO result on its row — ` +
          `the work is orphaned on disk with nothing pointing at it`,
      });
    }
  }
  for (const w of pre.worktrees) {
    const t = getTask(w.taskId);
    if (t?.status === "complete") continue; // proven-merged cleanup — the one sanctioned removal
    if (!existsSync(w.worktreePath)) {
      v.push({
        invariant: name,
        detail:
          `the worktree for task ${w.taskId} existed before the kill and is GONE after recovery (${w.worktreePath}), ` +
          `while the task is '${t?.status ?? "missing"}' — an unmerged step's worktree is its only copy of the work`,
      });
      continue;
    }
    // The directory surviving is not the work surviving: a recovery that emptied
    // the tree (a stray `git checkout`, a reset, a prune) discards exactly as much.
    const gone = w.files.filter((f) => !existsSync(join(w.worktreePath, f)));
    if (gone.length > 0) {
      v.push({
        invariant: name,
        detail:
          `the worktree for task ${w.taskId} survived recovery but ${gone.length} file(s) the agent had written in it ` +
          `are GONE [${gone.slice(0, 5).join(", ")}], while the task is '${t?.status ?? "missing"}' — the work inside an ` +
          `unmerged worktree is the thing the no-discard rule protects, not the directory`,
      });
    }
  }
  return v;
}

/** INVARIANT 5 — fixpoint is idempotent: one more full pass changes nothing.
 *
 *  `pass` is the recovery pass under test and defaults to the real one; every
 *  matrix cell uses that default. The detection suite substitutes a pass that
 *  writes ONE persisted field, which is how the SNAPSHOT's fidelity gets proven
 *  rather than assumed — a checker whose snapshot cannot see a write cannot
 *  honestly report "no-op", and that is precisely what it used to do. */
export async function checkFixpointIdempotent(
  runId: string,
  workflow: Workflow,
  exec: DockerExecFn,
  pass: (runId: string, workflow: Workflow, exec: DockerExecFn) => Promise<void> = recoveryPass,
): Promise<Violation[]> {
  const before = snapshot(runId);
  await pass(runId, workflow, exec);
  const after = snapshot(runId);
  if (snapshotKey(before) === snapshotKey(after)) return [];
  return [
    {
      invariant: "5-fixpoint-idempotent",
      detail:
        `a second reconcile+runNext pass after fixpoint CHANGED state:\n` +
        diffSnapshots(before, after)
          .map((d) => `    ${d}`)
          .join("\n"),
    },
  ];
}

export async function checkAllInvariants(args: {
  runId: string;
  workflow: Workflow;
  exec: DockerExecFn;
  persistedPreKill: PersistedWork;
  wasAbandoned: boolean;
}): Promise<Violation[]> {
  return [
    ...checkNoCompleteWithoutEvidence(args.runId, args.workflow),
    ...checkNoPermanentWedge(args.runId, args.workflow),
    ...checkAbandonedNeverOverwritten(args.runId, args.wasAbandoned),
    ...checkPersistedWorkNeverDiscarded(args.persistedPreKill),
    ...(await checkFixpointIdempotent(args.runId, args.workflow, args.exec)),
  ];
}

export function formatViolations(vs: Violation[]): string {
  return vs.map((x) => `  [${x.invariant}] ${x.detail}`).join("\n");
}

// ── known failures: REAL bugs this harness found on HEAD ───────────────────────
//
// FG-530's scope guard is explicit — a kill point that exposes a real bug gets
// FILED, not fixed here. Each is pinned as a `todo` test with a minimal repro in the
// matrix lane; both lanes tolerate exactly these signatures and nothing else, so the
// suite stays green while any NEW invariant break still fails loudly.
//
// Deliberately signature-matched rather than listed by cell name: a hardcoded
// list of ~24 (scenario, kill point) pairs would silently absorb a different bug
// that happened to land in one of those cells. The signatures are correspondingly
// narrow — FG-533's names the MISSING container.started event, not merely a
// `running` task, so a container-gone sweep that started failing would not hide
// behind it.

export type KnownFailure = { id: string; invariant: string; match: RegExp; summary: string };

export const KNOWN_FAILURES: KnownFailure[] = [
  // FG-530-A (the awaiting_red crash-window wedge, both callsites) was fixed by
  // FG-531 — reconcile's awaiting_red sweep lands the task fail-safe as
  // orphaned_needs_finalize (single-step) / fanout_wave_orphaned (fanout
  // parent) when no live process holds the run lock and no red container is
  // alive. Its matrix cells assert the recovery as plain passing tests now;
  // the pin is gone so a regression fails loudly.
  // FG-530-B (gate reject NULLing the rejected task's result) was fixed by
  // FG-532 — the reject branch now passes `result: task.result` through
  // failTask, matching request-changes. Its matrix cell asserts the invariant
  // as a plain passing test now; the pin is gone so a regression fails loudly.
  {
    id: "FG-533",
    invariant: "2-no-permanent-wedge",
    match: /is still 'running' at fixpoint .*\[container\.started seen: no\]/,
    summary:
      "runContainer marks the task `running` and appends task.started BEFORE the container launches; the span that follows " +
      "(image pull, auth staging, dependency provisioning) is minutes long. A crash inside it leaves a `running` task with " +
      "NO container.started — and container.started is exactly the event both rescue paths gate on (reconcile.ts's per-task " +
      "loop, `if (!hasContainerStarted) continue`, and src/ops/reconcile-candidate.ts's SQL), while `forge retry` refuses " +
      "any status but failed. Permanent wedge, same family as FG-530-A. Filed as FG-533; the pin flips to a passing " +
      "assertion when its recovery path lands.",
  },
];

export const KNOWN_HIT = new Set<string>();

export function partitionKnown(vs: Violation[]): { unexpected: Violation[]; known: KnownFailure[] } {
  const unexpected: Violation[] = [];
  const known: KnownFailure[] = [];
  for (const v of vs) {
    const k = KNOWN_FAILURES.find((kf) => kf.invariant === v.invariant && kf.match.test(v.detail));
    if (k) {
      known.push(k);
      KNOWN_HIT.add(k.id);
    } else {
      unexpected.push(v);
    }
  }
  return { unexpected, known };
}
