// FG-476 end-to-end integration test.
//
// Sibling of FG-475 (already shipped — see fg475-gate-reject-resume.integration.test.ts).
// FG-475 fixed the FINALIZATION side: isRunSettled now treats a live (pending)
// on_reject recovery task as keeping its target phase "active" even when that
// phase already has a complete primary, so a run correctly stays "active"
// instead of wrongly finalizing to "complete". FG-476 is the DISPATCH side:
// that live recovery task must actually be dispatchable, or the run makes zero
// forward progress and hangs "active" forever — the finalization fix alone
// only stops the WRONG terminal state; it does nothing to unstick the run.
//
// Reproduces the exact seeds/workflows/security-audit.yml shape: `investigate`
// (gate: human) completes; `audit` (depends_on investigate, gate: verdict,
// on_reject: investigate) reaches awaiting_gate; the operator rejects audit's
// gate. Because `investigate` already has a complete primary by the time this
// happens, computeReadyQueue's `hasCompletePrimary` skip (src/v2/ready-queue.ts)
// hides the freshly-inserted marker-tagged recovery task from the ready queue
// forever, and runNext.ts's pending-row reuse lookup (dispatchSingleStep, keyed
// on parentId === undefined) can't find it either — so pre-fix, the recovery
// task never dispatches: computeReadyQueue returns empty on every subsequent
// runNext() call and run.status is stuck "active" with zero further progress
// possible.
//
// This test exercises the REAL v2/gate.ts gate() and REAL v2/runNext.ts
// runNext() (only the docker exec boundary is stubbed, per the project's
// DockerExecFn test-injection pattern — see fg475-gate-reject-resume and
// fg381-dispatch integration tests). It does NOT mock computeReadyQueue,
// isRunSettled, or dispatchSingleStep — those are exactly (part of) what's
// under test.
//
// Unlike FG-475's campaign-level test, this test drives gate()/runNext()
// directly (no campaign layer) and calls each a bounded, small, explicit
// number of times — never a `while(true)` loop — so there is no risk of a
// real hang in the test harness itself; a stuck run simply fails an assertion
// (e.g. "task must have left pending") rather than spinning.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { getTask, tasksForRun } from "../store/tasks.js";
import { getRun } from "../store/runs.js";
import { startRun } from "../v2/startRun.js";
import { gate } from "../v2/gate.js";
import { runNext } from "../v2/runNext.js";
import { publishFlatAsGeneration } from "../v2/seed-generation.testkit.js";
import type { DockerExecFn } from "../v2/runNext.js";
import type { Workflow } from "../v2/schema.js";

const RUNTIME_NAME = "fg476-test-runtime";
const WORKFLOW_NAME = "fg476-audit-investigate";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
let projectDir: string;

const SAVED_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "FORGE_WORKTREES",
  "FORGE_NO_WORKTREES",
  "FORGE_WORKTREE_IGNORE_DIRTY",
  "FORGE_WORKTREES_EPHEMERAL",
] as const;
const savedEnv: Partial<Record<(typeof SAVED_ENV_KEYS)[number], string>> = {};

// Real runtime YAML so runNext's dispatch machinery (resolveModel, auth
// resolution, buildDockerArgs) resolves cleanly — mirrors fg475/fg381.
function ensureRuntime(name: string): void {
  const forgeHome = process.env.FORGE_HOME!;
  const runtimePath = join(forgeHome, "runtimes", `${name}.yml`);
  mkdirSync(dirname(runtimePath), { recursive: true });
  writeFileSync(
    runtimePath,
    `name: ${name}
description: FG-476 integration test runtime stub
image: test-image:latest
models:
  default: test-model
auth:
  mode: apikey
mounts:
  - host: "\${TASK_DIR}"
    container: /task
    mode: rw
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
}

// Real workflow YAML on disk (gate.ts's reject branch loads the workflow BY
// NAME from disk via loadWorkflow(run.workflow, {projectDir}), independent of
// the Workflow object passed to startRun/runNext) — must match the in-memory
// WORKFLOW object below field-for-field. Mirrors security-audit.yml's
// investigate -> audit shape exactly: investigate is gate:human with a
// non-blocking specialist red; audit depends_on investigate, is gate:verdict
// with on_reject: investigate, and a mixed-authority red panel.
function ensureWorkflow(): void {
  const forgeHome = process.env.FORGE_HOME!;
  const wfPath = join(forgeHome, "workflows", `${WORKFLOW_NAME}.yml`);
  mkdirSync(dirname(wfPath), { recursive: true });
  writeFileSync(
    wfPath,
    `name: ${WORKFLOW_NAME}
description: FG-476 integration test workflow — security-audit's audit->investigate on_reject shape
inputs: []
steps:
  - id: investigate
    agent: security-advisor
    activity: spec-writer
    gate: human
    manual: false
    depends_on: []
    runtime: ${RUNTIME_NAME}
    reds:
      - agent: red-security
        activity: fast-orchestrator
        authority: specialist
        gate_on_verdict: false
  - id: audit
    agent: security-advisor
    activity: default
    depends_on: [investigate]
    gate: verdict
    on_reject: investigate
    manual: false
    runtime: ${RUNTIME_NAME}
    reds:
      - agent: red-security
        activity: fast-orchestrator
        authority: authoritative
        gate_on_verdict: true
      - agent: red-wide
        activity: fast-orchestrator
        authority: authoritative
        gate_on_verdict: true
      - agent: red-narrow
        activity: fast-orchestrator
        authority: specialist
        gate_on_verdict: false
`,
  );
  // FG-583: publish the flat workflow + runtime as one complete seed generation —
  // there is no flat dispatch fallback, so gate()/runNext() dispatch refuses without
  // a published generation. Called after ensureRuntime in beforeEach, so this captures both.
  publishFlatAsGeneration(process.env.FORGE_HOME!);
}

// In-memory mirror of the YAML above — passed directly to startRun/runNext
// (both accept a Workflow object; only gate.ts re-loads by name from disk).
const WORKFLOW: Workflow = {
  name: WORKFLOW_NAME,
  description: "FG-476 integration test workflow",
  review_mode: "legacy_verdict" as const,
  inputs: [],
  steps: [
    {
      id: "investigate",
      agent: "security-advisor",
      activity: "spec-writer",
      gate: "human",
      manual: false,
      depends_on: [],
      runtime: RUNTIME_NAME,
      reds: [{ agent: "red-security", activity: "fast-orchestrator", authority: "specialist", gate_on_verdict: false }],
    },
    {
      id: "audit",
      agent: "security-advisor",
      activity: "default",
      depends_on: ["investigate"],
      gate: "verdict",
      on_reject: "investigate",
      manual: false,
      runtime: RUNTIME_NAME,
      reds: [
        { agent: "red-security", activity: "fast-orchestrator", authority: "authoritative", gate_on_verdict: true },
        { agent: "red-wide", activity: "fast-orchestrator", authority: "authoritative", gate_on_verdict: true },
        { agent: "red-narrow", activity: "fast-orchestrator", authority: "specialist", gate_on_verdict: false },
      ],
    },
  ],
};

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  projectDir = mkdtempSync(join(tmpdir(), "fg476-recovery-dispatch-"));
  for (const k of SAVED_ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  process.env.FORGE_WORKTREES = "0";
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  ensureRuntime(RUNTIME_NAME);
  ensureWorkflow();
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
  rmSync(projectDir, { recursive: true, force: true });
  for (const k of SAVED_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k] as string;
  }
});

test(
  "FG-476 integ: rejecting audit's gate (on_reject: investigate) actually dispatches the investigate recovery task and the run makes real forward progress — never a permanent 'active' hang",
  { timeout: 20000 },
  async () => {
    // Tracks every taskId the docker-exec boundary was actually invoked for —
    // the ground truth for "did this task get dispatched", independent of
    // whatever runNext() reports.
    const dispatchedTaskIds: string[] = [];

    const exec: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
      const nameIdx = args.indexOf("--name");
      const containerName = nameIdx >= 0 ? (args[nameIdx + 1] ?? "") : "";
      const taskId = containerName.replace(/^forge-/, "");
      dispatchedTaskIds.push(taskId);

      const dir = dirname(stdoutPath);
      mkdirSync(dir, { recursive: true });

      // Red agents (task-red-<step>-*) return a clean pass verdict so neither
      // wave gets blocked_by_red — both investigate's non-blocking specialist
      // red and audit's mixed-authority panel need to clear so the run reaches
      // a real awaiting_gate for a human decision, matching the workflow's
      // actual gate semantics instead of an invented shortcut.
      const isRed = taskId.includes("-red-") || taskId.startsWith("task-red-");
      const result = isRed
        ? { verdict: "pass", confidence: 0.9, findings: [] }
        : { status: "complete", files_modified: [] };

      writeFileSync(join(dir, "result.json"), JSON.stringify(result));
      writeFileSync(stdoutPath, "");
      writeFileSync(stderrPath, "");
      return 0;
    };

    const { runId } = startRun({
      workflow: WORKFLOW,
      title: "FG-476 audit/investigate recovery test",
      inputs: {},
      projectDir,
    });

    // ── Wave 1: investigate is the only ready step (audit depends on it).
    const wave1 = await runNext({ runId, workflow: WORKFLOW, dockerExec: exec });
    assert.deepEqual(wave1.awaitingGate, ["investigate"], "investigate (gate: human) must park awaiting a human decision");

    const investigateTaskV1 = tasksForRun(runId).find((t) => t.phase === "investigate" && t.parentId === undefined)!;
    assert.ok(investigateTaskV1, "investigate primary task must exist after wave 1");
    assert.equal(investigateTaskV1.status, "awaiting_gate");

    // ── The operator advances investigate — matches security-audit.yml's
    // real flow (human reviews coverage, then commits to the deep audit).
    await gate(investigateTaskV1.id, "advance", "coverage looks sufficient", {});
    assert.equal(getTask(investigateTaskV1.id)!.status, "complete", "investigate must be complete before audit can dispatch");

    // ── Wave 2: audit is now ready (deps met). Its reds all pass, so it parks
    // at its own gate: verdict awaiting_gate — a real human decision point.
    const wave2 = await runNext({ runId, workflow: WORKFLOW, dockerExec: exec });
    assert.deepEqual(wave2.awaitingGate, ["audit"], "audit (gate: verdict, all reds pass) must park awaiting_gate");

    const auditTask = tasksForRun(runId).find((t) => t.phase === "audit" && t.parentId === undefined)!;
    assert.ok(auditTask, "audit primary task must exist after wave 2");
    assert.equal(auditTask.status, "awaiting_gate");

    // ── The operator's reject: on_reject: investigate fires, inserting the
    // marker-tagged recovery task into the already-complete investigate phase.
    // This is the exact shape FG-476 is about: hasCompletePrimary(investigate)
    // is true, so pre-fix computeReadyQueue skips this phase forever.
    const rejectResult = await gate(auditTask.id, "reject", "investigation missed a surface — expand scope", {});
    assert.equal(getTask(auditTask.id)!.status, "failed", "audit's rejected gate must fail the audit task (the audit trail)");
    assert.equal(rejectResult.nextTasks.length, 1, "reject with on_reject must insert exactly one recovery task");

    const recoveryTask = rejectResult.nextTasks[0]!;
    assert.equal(recoveryTask.phase, "investigate", "recovery task must target on_reject's step (investigate)");
    assert.equal(recoveryTask.status, "pending");
    assert.equal(recoveryTask.parentId, auditTask.id, "recovery task lineage is the rejected task, not fanout");
    assert.equal(
      (recoveryTask.taskPackage.inputs as Record<string, unknown>)["rejectedTaskId"],
      auditTask.id,
      "recovery task must carry the rejectedTaskId marker gate.ts stamps (the FG-475/FG-476 shared signal)",
    );

    // FG-475 preserved: a live recovery task must keep the run "active", never
    // prematurely finalized to "complete" while real recovery work is outstanding.
    assert.equal(getRun(runId)!.status, "active", "FG-475: run must stay active while the recovery task is outstanding");

    // ── THE CORE FG-476 REGRESSION CHECK: driving runNext() must actually
    // dispatch the recovery task, not silently no-op forever. Pre-fix, this
    // call finds an empty ready queue (hasCompletePrimary skips the phase) and
    // does zero I/O — dispatchedTaskIds never gains recoveryTask.id, and its
    // status is still "pending" afterward.
    const recoveryWave = await runNext({ runId, workflow: WORKFLOW, dockerExec: exec });

    assert.ok(
      dispatchedTaskIds.includes(recoveryTask.id),
      `FG-476: the docker-exec boundary must have been invoked for the recovery task ${recoveryTask.id} — ` +
        `pre-fix, computeReadyQueue's hasCompletePrimary skip hides this phase forever and nothing ever dispatches`,
    );
    assert.notEqual(
      getTask(recoveryTask.id)!.status,
      "pending",
      "FG-476: the recovery task must have left 'pending' — this is the exact pre-fix hang (permanently pending, never dispatched)",
    );
    // investigate is gate: human with a non-blocking specialist red — the
    // correct real outcome of re-running it is its own awaiting_gate a second
    // time, not an invented "complete" or "failed".
    assert.equal(
      getTask(recoveryTask.id)!.status,
      "awaiting_gate",
      "recovery dispatch of investigate (gate: human) must reach awaiting_gate, mirroring its first run",
    );
    assert.ok(
      recoveryWave.dispatchedSteps.includes("investigate") || recoveryWave.awaitingGate.includes("investigate"),
      "runNext's own wave report must reflect the recovery dispatch of investigate",
    );

    // Exactly ONE parentId===undefined ("primary") task exists for investigate:
    // the fix must reuse the marker-tagged recovery row itself, never mint a
    // second fresh parentId=undefined primary alongside it (that would silently
    // strand the real recovery row pending forever while a decoy progresses —
    // the partial-fix failure mode this end-to-end test also guards against).
    const investigatePrimaries = tasksForRun(runId).filter((t) => t.phase === "investigate" && t.parentId === undefined);
    assert.equal(
      investigatePrimaries.length,
      1,
      "exactly one parentId=undefined primary must exist for investigate — the fix reuses the recovery row, it doesn't mint a duplicate",
    );
    assert.equal(investigatePrimaries[0]!.id, investigateTaskV1.id, "the original investigate primary is untouched and still authoritative for deps");
    assert.equal(investigatePrimaries[0]!.status, "complete", "the original primary's complete status is unaffected by the recovery dispatch");

    // ── Drive the recovery task to a decision so the run can actually
    // terminate — proving forward progress is genuinely possible, not just
    // that one dispatch happened in isolation.
    await gate(recoveryTask.id, "advance", "expanded scope reviewed", {});
    assert.equal(getTask(recoveryTask.id)!.status, "complete");

    const finalWave = await runNext({ runId, workflow: WORKFLOW, dockerExec: exec });
    assert.equal(finalWave.dispatchedSteps.length, 0, "audit is terminally failed with on_reject already consumed — nothing left to dispatch");

    // ── The run reaches a REAL terminal state — not stuck "active" forever.
    // audit has no pending replacement and on_reject only re-runs investigate,
    // never audit itself, so audit's own primary is terminally failed ("blocked")
    // while investigate is fully "complete". FG-585: that settles the run to
    // `failed` (audit's declared phase never reached a complete primary) — not a
    // false `complete`. The FG-476 anti-hang guarantee holds.
    assert.equal(getRun(runId)!.status, "failed", "FG-476/FG-585: the run must reach a real terminal state once recovery resolves — never a permanent active hang");

    // ── audit's reject decision remains the durable audit trail: never
    // auto-resubmitted or re-run by this fix. Recovery re-runs investigate,
    // not audit.
    const auditPrimaries = tasksForRun(runId).filter((t) => t.phase === "audit" && t.parentId === undefined);
    assert.equal(auditPrimaries.length, 1, "audit must never be re-dispatched — on_reject targets investigate only");
    assert.equal(auditPrimaries[0]!.id, auditTask.id);
    assert.equal(auditPrimaries[0]!.status, "failed", "audit's human reject decision must remain the terminal audit-trail status");
    const auditDispatchCount = dispatchedTaskIds.filter((id) => id === auditTask.id).length;
    assert.equal(auditDispatchCount, 1, "audit's task id must appear exactly once in the docker-exec boundary (its original wave-2 dispatch) — never re-dispatched by the recovery fix");
  },
);
