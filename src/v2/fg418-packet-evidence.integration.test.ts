// FG-418 integration tests: Reviewer Context Packet evidence population fix.
//
// The verified problem: assembleReviewerContextPacket read primaryTask.result from DB,
// which is NULL at reds-dispatch time (markTaskComplete/finalizePrimary runs AFTER
// dispatchReds). So engineerSummary/git/verificationCommands/deferredScope were always
// hollow when the shipping-reviewer ran.
//
// The fix: dispatchReds threads its in-hand primaryResult into assembleReviewerContextPacket
// as an optional override. For fanout, the override is the aggregate shape with children;
// the assembler extracts evidence from child results.
//
// Covers:
//   (fg418-1) SINGLE-STEP: packet evidence is non-empty from in-hand override EVEN THOUGH
//       the primary task's DB result is still null/undefined at dispatch time.
//   (fg418-2) FANOUT: packet evidence comes from child results (union changedFiles,
//       aggregate engineerSummary), not the hollow parent aggregate.
//   (fg418-3) Default workflow advisory wiring: advisory shipping-reviewer (specialist,
//       gate_on_verdict:false) IS dispatched and receives reviewerContextPacket.
//   (fg418-4) Advisory behavior: specialist/gate_on_verdict:false fail does NOT block
//       the phase gate AND the reviewer IS dispatched (anti-inert).
//   (fg418-5) FG-384 guardrail regression: authoritative shipping-reviewer with in-hand
//       non-empty result → guardrail still fires, synthetic finding survives, primary blocked.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { tasksForRun } from "../store/tasks.js";
import { verdictsForRun } from "../store/verdicts.js";
import { insertGate } from "../store/gates.js";
import { startRun } from "./startRun.js";
import { runNext } from "./runNext.js";
import type { DockerExecFn } from "./runNext.js";
import type { Workflow } from "./schema.js";
import { publishFlatAsGeneration } from "./seed-generation.testkit.js";

// ─── Workflow fixtures ────────────────────────────────────────────────────────

const ADVISORY_SHIPPING_REVIEWER_SPEC = {
  agent: "shipping-reviewer" as const,
  activity: "fast-orchestrator",
  authority: "specialist" as const,
  gate_on_verdict: false,
};

// Single-step build with advisory shipping-reviewer — used for fg418-1, fg418-3, fg418-4.
const WORKFLOW_ADVISORY_SINGLE: Workflow = {
  name: "fg418-advisory-test",
  description: "FG-418 advisory single-step test",
  review_mode: "legacy_verdict",
  inputs: [],
  steps: [
    {
      id: "build",
      agent: "engineer",
      gate: "auto",
      manual: false,
      depends_on: [],
      runtime: "fg418-test",
      reds: [ADVISORY_SHIPPING_REVIEWER_SPEC],
    },
  ],
};

// Two-step workflow: plan → build (fanout) with advisory shipping-reviewer — used for fg418-2.
const WORKFLOW_FANOUT_ADVISORY: Workflow = {
  name: "fg418-fanout-test",
  description: "FG-418 fanout advisory test",
  review_mode: "legacy_verdict",
  inputs: [],
  steps: [
    {
      id: "plan",
      agent: "tech-lead",
      gate: "auto",
      manual: false,
      depends_on: [],
      runtime: "fg418-test",
      reds: [],
    },
    {
      id: "build",
      agent: "engineer",
      gate: "auto",
      manual: false,
      depends_on: ["plan"],
      runtime: "fg418-test",
      fanout: {
        from_upstream: { step: "plan", array_key: "steps", input_key: "step" },
        failure_mode: "fail-phase",
      },
      reds: [ADVISORY_SHIPPING_REVIEWER_SPEC],
    },
  ],
};

// Authoritative shipping-reviewer — used for fg418-5 (FG-384 regression).
const WORKFLOW_AUTH_SHIPPING_REVIEWER: Workflow = {
  name: "fg418-auth-test",
  description: "FG-418 FG-384 guardrail regression test",
  review_mode: "legacy_verdict",
  inputs: [],
  steps: [
    {
      id: "build",
      agent: "engineer",
      gate: "auto",
      manual: false,
      depends_on: [],
      runtime: "fg418-test",
      reds: [
        { agent: "shipping-reviewer", authority: "authoritative", gate_on_verdict: true },
      ],
    },
  ],
};

// ─── Shared harness ───────────────────────────────────────────────────────────

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
const tmpDirs: string[] = [];

const SAVED_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "FORGE_WORKTREES",
  "FORGE_NO_WORKTREES",
  "FORGE_WORKTREE_IGNORE_DIRTY",
  "FORGE_WORKTREES_EPHEMERAL",
] as const;
const savedEnv: Partial<Record<(typeof SAVED_ENV_KEYS)[number], string>> = {};

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  for (const k of SAVED_ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  process.env.FORGE_WORKTREES = "0";
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  ensureRuntime("fg418-test");
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
  for (const k of SAVED_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k] as string;
  }
  for (const dir of tmpDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "forge-fg418-"));
  tmpDirs.push(dir);
  return dir;
}

function ensureRuntime(name: string): void {
  const forgeHome = process.env.FORGE_HOME!;
  const runtimePath = join(forgeHome, "runtimes", `${name}.yml`);
  mkdirSync(dirname(runtimePath), { recursive: true });
  writeFileSync(
    runtimePath,
    `name: ${name}
description: FG-418 test runtime stub
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
  publishFlatAsGeneration(process.env.FORGE_HOME!);
}

function taskIdFromDockerArgs(args: string[]): string {
  const nameIdx = args.indexOf("--name");
  const containerName = nameIdx >= 0 ? (args[nameIdx + 1] ?? "") : "";
  return containerName.replace(/^forge-/, "");
}

function writeStructuredTicket(
  projectDir: string,
  opts: { id: string; title: string; body: string },
): void {
  const storiesDir = join(projectDir, "backlog", "stories");
  mkdirSync(storiesDir, { recursive: true });
  const slug = opts.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
  const lines = ["---", `id: ${opts.id}`, "type: story", "status: active", `title: ${opts.title}`, "---", ""];
  writeFileSync(join(storiesDir, `${opts.id}-${slug}.md`), lines.join("\n") + opts.body);
}

// ─── (fg418-1) SINGLE-STEP: DB null at dispatch + non-empty evidence from override ──

test(
  "(fg418-1) single-step: packet evidence is non-empty from in-hand override; primary DB result is null at dispatch time",
  async () => {
    // THE CORE TEST: proves the fix works end-to-end.
    // Without the fix, primaryTask.result from DB is null at dispatch time → packet
    // evidence is hollow. With the fix, the in-hand primaryResult override populates
    // the packet evidence even though DB is still null.
    const projectDir = makeTmpDir();
    writeStructuredTicket(projectDir, {
      id: "FG-418-1",
      title: "FG-418 single-step test",
      body: "## Acceptance Criteria\n\n- Ship it\n\n",
    });

    const { runId } = startRun({
      workflow: WORKFLOW_ADVISORY_SINGLE,
      title: "fg418-1 single-step override test",
      inputs: { ticketId: "FG-418-1" },
      projectDir,
    });

    // State captured inside the reviewer exec (during dispatch, before finalizePrimary).
    let primaryDbResultAtDispatch: unknown = "NOT_CAPTURED";
    let packetAtDispatch: unknown = undefined;

    const exec: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
      const taskId = taskIdFromDockerArgs(args);
      const dir = dirname(stdoutPath);
      mkdirSync(dir, { recursive: true });

      let result: unknown;
      if (taskId.startsWith("task-build-")) {
        // Primary engineer: create stub files so the persistence check passes,
        // insert human-advance gate for operatorAsk, return rich result.
        mkdirSync(join(projectDir, "src"), { recursive: true });
        writeFileSync(join(projectDir, "src", "feature.ts"), "// stub");
        writeFileSync(join(projectDir, "src", "utils.ts"), "// stub");
        insertGate({
          id: `gate-fg418-1-${taskId}`,
          taskId,
          decision: "advance",
          rationale: "Approved for FG-418-1",
          decidedAt: new Date().toISOString(),
          decidedBy: "human",
        });
        result = {
          status: "complete", tests_run: 1,
          files_modified: ["src/feature.ts", "src/utils.ts"],
          commitSha: "deadcafe",
          diff_summary: "implemented feature",
        };
      } else {
        // Shipping-reviewer red: capture state BEFORE finalizePrimary has run.
        const allTasks = tasksForRun(runId);

        // The primary engineer task's DB result should be undefined/null here —
        // markTaskComplete (the only writer) runs in finalizePrimary which runs AFTER dispatchReds.
        const primaryTask = allTasks.find(
          (t) => t.agentRole === "engineer" && t.parentId === undefined,
        );
        primaryDbResultAtDispatch = primaryTask?.result;

        // The reviewer task's packet (inserted before runContainer was called).
        const reviewerTask = allTasks.find((t) => t.agentRole === "shipping-reviewer");
        packetAtDispatch = (reviewerTask?.taskPackage?.inputs as Record<string, unknown>)?.[
          "reviewerContextPacket"
        ];

        result = { status: "complete", verdict: "pass", confidence: 0.9, findings: [] };
      }

      writeFileSync(join(dir, "result.json"), JSON.stringify(result));
      writeFileSync(stdoutPath, "");
      writeFileSync(stderrPath, "");
      return 0;
    };

    const wave = await runNext({
      runId,
      workflow: WORKFLOW_ADVISORY_SINGLE,
      dockerExec: exec,
    });

    assert.ok(wave.completedSteps.includes("build"), "build must complete (advisory reviewer passes)");

    // THE KEY ASSERTION: DB result was null at dispatch time.
    assert.equal(
      primaryDbResultAtDispatch,
      undefined,
      "primary task DB result must be undefined at dispatch time — markTaskComplete runs AFTER dispatchReds",
    );

    // THE FIX ASSERTION: despite null DB result, packet evidence is non-empty.
    assert.ok(packetAtDispatch !== undefined, "reviewer task must have been created and have packet");
    const pkt = packetAtDispatch as Record<string, unknown>;
    const git = pkt["git"] as Record<string, unknown>;
    assert.ok(
      Array.isArray(git["changedFiles"]) && (git["changedFiles"] as string[]).length > 0,
      "packet.git.changedFiles must be non-empty (sourced from in-hand override, not null DB)",
    );
    assert.ok(
      (git["changedFiles"] as string[]).includes("src/feature.ts"),
      "packet.git.changedFiles must include src/feature.ts",
    );
    assert.equal(
      (git as Record<string, unknown>)["commitSha"],
      "deadcafe",
      "packet.git.commitSha must match engineer result",
    );
    // engineerSummary is the full engineer result object (not null like before the fix).
    assert.ok(
      pkt["engineerSummary"] !== null && pkt["engineerSummary"] !== undefined,
      "packet.engineerSummary must be non-null (sourced from in-hand override, not null DB)",
    );
    // Backlog and operatorAsk should also be present for complete context.
    const missingCtx = pkt["missingContext"] as Array<{ field: string; required: boolean }>;
    const requiredMissing = missingCtx.filter((m) => m.required);
    assert.equal(requiredMissing.length, 0, "no required context must be missing");
  },
);

// ─── (fg418-2) FANOUT: evidence from children, not hollow parent ───────────────

test(
  "(fg418-2) fanout: packet evidence comes from child results (changedFiles union, aggregate engineerSummary); parent DB result is null at dispatch time",
  async () => {
    const projectDir = makeTmpDir();
    writeStructuredTicket(projectDir, {
      id: "FG-418-2",
      title: "FG-418 fanout test",
      body: "## Acceptance Criteria\n\n- Ship it\n\n",
    });

    const { runId } = startRun({
      workflow: WORKFLOW_FANOUT_ADVISORY,
      title: "fg418-2 fanout test",
      inputs: { ticketId: "FG-418-2" },
      projectDir,
    });

    // State captured inside the reviewer exec.
    let parentDbResultAtDispatch: unknown = "NOT_CAPTURED";
    let packetAtDispatch: unknown = undefined;

    const exec: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
      const taskId = taskIdFromDockerArgs(args);
      const dir = dirname(stdoutPath);
      mkdirSync(dir, { recursive: true });

      let result: unknown;
      if (taskId.startsWith("task-plan-")) {
        // Plan step: produce the fanout array.
        result = {
          status: "complete",
          steps: [{ discipline: "general" }, { discipline: "general" }],
        };
      } else if (taskId.startsWith("task-build-0-")) {
        // Fanout child 0: files from the first implementation step.
        result = {
          status: "complete", tests_run: 1,
          files_modified: ["src/module-a.ts"],
          commitSha: "sha-child-0",
        };
      } else if (taskId.startsWith("task-build-1-")) {
        // Fanout child 1: files from the second implementation step.
        result = {
          status: "complete", tests_run: 1,
          files_modified: ["src/module-b.ts"],
          commitSha: "sha-child-1",
        };
      } else {
        // Shipping-reviewer red: capture state.
        const allTasks = tasksForRun(runId);

        // The fanout PARENT task (parentId === undefined, phase === "build").
        // Its DB result is also null here — the parent's result is written to disk
        // (result.json) but NOT to DB until finalizePrimary/markTaskComplete.
        const parentTask = allTasks.find(
          (t) => t.phase === "build" && t.parentId === undefined,
        );
        parentDbResultAtDispatch = parentTask?.result;

        // Capture the reviewer packet.
        const reviewerTask = allTasks.find((t) => t.agentRole === "shipping-reviewer");
        packetAtDispatch = (reviewerTask?.taskPackage?.inputs as Record<string, unknown>)?.[
          "reviewerContextPacket"
        ];

        result = { status: "complete", verdict: "pass", confidence: 0.9, findings: [] };
      }

      writeFileSync(join(dir, "result.json"), JSON.stringify(result));
      writeFileSync(stdoutPath, "");
      writeFileSync(stderrPath, "");
      return 0;
    };

    // Wave 1: plan step completes.
    const wave1 = await runNext({
      runId,
      workflow: WORKFLOW_FANOUT_ADVISORY,
      dockerExec: exec,
    });
    assert.ok(wave1.completedSteps.includes("plan"), "plan step must complete in wave 1");

    // Wave 2: fanout build step dispatches children + shipping-reviewer.
    const wave2 = await runNext({
      runId,
      workflow: WORKFLOW_FANOUT_ADVISORY,
      dockerExec: exec,
    });
    assert.ok(wave2.completedSteps.includes("build"), "build step must complete in wave 2");

    // DB null assertion for fanout parent.
    assert.equal(
      parentDbResultAtDispatch,
      undefined,
      "fanout parent DB result must be undefined at dispatch time — same as single-step path",
    );

    // Fanout evidence assertions.
    assert.ok(packetAtDispatch !== undefined, "reviewer task must have packet");
    const pkt = packetAtDispatch as Record<string, unknown>;
    const git = pkt["git"] as Record<string, unknown>;
    const changedFiles = git["changedFiles"] as string[];

    // changedFiles must be the UNION of both children's files_modified, not empty.
    assert.ok(
      Array.isArray(changedFiles) && changedFiles.length === 2,
      `packet.git.changedFiles must have 2 entries (union of children); got: ${JSON.stringify(changedFiles)}`,
    );
    assert.ok(changedFiles.includes("src/module-a.ts"), "changedFiles must include child-0 file");
    assert.ok(changedFiles.includes("src/module-b.ts"), "changedFiles must include child-1 file");

    // commitSha must be from children (last non-empty), not empty.
    assert.equal(
      git["commitSha"],
      "sha-child-1",
      "packet.git.commitSha must be the last child's commitSha",
    );

    // engineerSummary must be the aggregate { children: [...] }, not null.
    const engineerSummary = pkt["engineerSummary"] as Record<string, unknown>;
    assert.ok(
      engineerSummary !== null && engineerSummary !== undefined,
      "packet.engineerSummary must be non-null for fanout",
    );
    assert.ok(
      Array.isArray(engineerSummary["children"]),
      "packet.engineerSummary.children must be an array",
    );
    assert.equal(
      (engineerSummary["children"] as unknown[]).length,
      2,
      "engineerSummary.children must have 2 entries (one per fanout child)",
    );
  },
);

// ─── (fg418-3) Feature.yml advisory wiring: shipping-reviewer IS dispatched ──────

test(
  "(fg418-3) feature.yml advisory config: advisory specialist shipping-reviewer IS dispatched and receives reviewerContextPacket",
  async () => {
    // Proves that the configuration being added to feature.yml's build phase
    // (authority: specialist, gate_on_verdict: false) actually dispatches the
    // shipping-reviewer through the real path with a populated packet.
    const projectDir = makeTmpDir();
    writeStructuredTicket(projectDir, {
      id: "FG-418-3",
      title: "FG-418 feature workflow test",
      body: "## Acceptance Criteria\n\n- Ship it\n\n",
    });

    const { runId } = startRun({
      workflow: WORKFLOW_ADVISORY_SINGLE,
      title: "fg418-3 feature.yml advisory wiring test",
      inputs: { ticketId: "FG-418-3" },
      projectDir,
    });

    let reviewerWasDispatched = false;

    const exec: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
      const taskId = taskIdFromDockerArgs(args);
      const dir = dirname(stdoutPath);
      mkdirSync(dir, { recursive: true });

      let result: unknown;
      if (taskId.startsWith("task-build-")) {
        mkdirSync(join(projectDir, "src"), { recursive: true });
        writeFileSync(join(projectDir, "src", "impl.ts"), "// stub");
        insertGate({
          id: `gate-fg418-3-${taskId}`,
          taskId,
          decision: "advance",
          rationale: "Approved for FG-418-3",
          decidedAt: new Date().toISOString(),
          decidedBy: "human",
        });
        result = {
          status: "complete", tests_run: 1,
          files_modified: ["src/impl.ts"],
          commitSha: "abc418",
        };
      } else {
        // shipping-reviewer was actually dispatched (not skipped/pre-failed).
        reviewerWasDispatched = true;
        result = { status: "complete", verdict: "pass", confidence: 0.9, findings: [] };
      }

      writeFileSync(join(dir, "result.json"), JSON.stringify(result));
      writeFileSync(stdoutPath, "");
      writeFileSync(stderrPath, "");
      return 0;
    };

    const wave = await runNext({
      runId,
      workflow: WORKFLOW_ADVISORY_SINGLE,
      dockerExec: exec,
    });

    assert.ok(wave.completedSteps.includes("build"), "build must complete");
    assert.ok(reviewerWasDispatched, "shipping-reviewer container must have been dispatched");

    const tasks = tasksForRun(runId);

    // The shipping-reviewer task must exist in the DB.
    const reviewerTask = tasks.find((t) => t.agentRole === "shipping-reviewer");
    assert.ok(reviewerTask !== undefined, "shipping-reviewer task must exist in DB");
    assert.equal(reviewerTask!.status, "complete", "shipping-reviewer must be complete (not pre-failed)");

    // The packet must be in the reviewer task's inputs.
    const reviewerInputs = reviewerTask!.taskPackage.inputs as Record<string, unknown>;
    const packet = reviewerInputs["reviewerContextPacket"];
    assert.ok(
      packet !== null && packet !== undefined,
      "shipping-reviewer taskPackage.inputs must contain reviewerContextPacket",
    );

    const pkt = packet as Record<string, unknown>;

    // Backlog must be populated (ticket found).
    const backlog = pkt["backlog"] as Record<string, unknown>;
    assert.ok(backlog !== null && backlog !== undefined, "packet.backlog must be populated");
    assert.equal(backlog["id"], "FG-418-3", "packet.backlog.id must match ticketId");

    // Engineer evidence must be populated (the core FG-418 fix).
    const git = pkt["git"] as Record<string, unknown>;
    assert.ok(
      Array.isArray(git["changedFiles"]) && (git["changedFiles"] as string[]).includes("src/impl.ts"),
      "packet.git.changedFiles must include src/impl.ts (from in-hand override)",
    );

    // No required context missing.
    const missingCtx = pkt["missingContext"] as Array<{ field: string; required: boolean }>;
    assert.equal(
      missingCtx.filter((m) => m.required).length,
      0,
      "no required context must be missing when ticket and gate are present",
    );
  },
);

// ─── (fg418-4) Advisory behavior: specialist fail does NOT block gate ──────────

test(
  "(fg418-4) advisory: shipping-reviewer fail (needs_fix) does NOT block phase gate; reviewer IS dispatched",
  async () => {
    // Proves the advisory contract: authority:specialist / gate_on_verdict:false.
    // Even when mapShippingReviewerVerdict maps needs_fix to a `fail` verdict
    // (with the FG-384 synthetic finding), it does NOT set authoritativeFail
    // (condition: authority===authoritative && gate_on_verdict). The primary
    // completes (gate: auto), proving the gate is not held.
    const projectDir = makeTmpDir();
    writeStructuredTicket(projectDir, {
      id: "FG-418-4",
      title: "FG-418 advisory behavior test",
      body: "## Acceptance Criteria\n\n- Ship it\n\n",
    });

    const { runId } = startRun({
      workflow: WORKFLOW_ADVISORY_SINGLE,
      title: "fg418-4 advisory no-block test",
      inputs: { ticketId: "FG-418-4" },
      projectDir,
    });

    let reviewerDispatchedTaskId: string | undefined;

    const exec: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
      const taskId = taskIdFromDockerArgs(args);
      const dir = dirname(stdoutPath);
      mkdirSync(dir, { recursive: true });

      let result: unknown;
      if (taskId.startsWith("task-build-")) {
        mkdirSync(join(projectDir, "src"), { recursive: true });
        writeFileSync(join(projectDir, "src", "advisory-test.ts"), "// stub");
        result = { status: "complete", tests_run: 1, files_modified: ["src/advisory-test.ts"] };
      } else {
        // Shipping-reviewer returns needs_fix → mapShippingReviewerVerdict maps to fail.
        // With advisory config (specialist, gate_on_verdict: false), this must NOT block.
        reviewerDispatchedTaskId = taskId;
        result = {
          status: "complete",
          verdict: "needs_fix",
          confidence: 0.8,
          findings: [
            { summary: "host_verification is unknown", severity: "medium" as const, anchor: "done-audit" },
          ],
        };
      }

      writeFileSync(join(dir, "result.json"), JSON.stringify(result));
      writeFileSync(stdoutPath, "");
      writeFileSync(stderrPath, "");
      return 0;
    };

    const wave = await runNext({
      runId,
      workflow: WORKFLOW_ADVISORY_SINGLE,
      dockerExec: exec,
    });

    // Anti-block-everything: the advisory fail must NOT block the gate.
    assert.ok(
      wave.completedSteps.includes("build"),
      "build must be in completedSteps — advisory specialist fail must NOT block the gate",
    );

    const tasks = tasksForRun(runId);

    // Primary must be complete (gate: auto, no authoritative fail).
    const primaryTask = tasks.find((t) => t.agentRole === "engineer" && t.parentId === undefined);
    assert.ok(primaryTask !== undefined, "primary engineer task must exist");
    assert.equal(
      primaryTask!.status,
      "complete",
      "primary must be complete — advisory reviewer fail must NOT set blocked_by_red",
    );

    // Anti-inert: the reviewer WAS dispatched (not skipped).
    assert.ok(
      reviewerDispatchedTaskId !== undefined,
      "shipping-reviewer container must have been dispatched (anti-inert check)",
    );
    const reviewerTask = tasks.find((t) => t.agentRole === "shipping-reviewer");
    assert.ok(reviewerTask !== undefined, "shipping-reviewer task must exist in DB");
    assert.equal(
      reviewerTask!.status,
      "complete",
      "shipping-reviewer must be complete (ran normally, not pre-failed)",
    );

    // The verdict must be recorded as fail (the FG-384 synthetic finding survives),
    // but it did NOT block because authority=specialist.
    const verdicts = verdictsForRun(runId);
    const reviewerVerdict = verdicts.find((v) => v.redRole === "shipping-reviewer");
    assert.ok(reviewerVerdict !== undefined, "shipping-reviewer verdict must be recorded");
    assert.equal(
      reviewerVerdict!.verdict,
      "fail",
      "recorded verdict must be fail (needs_fix maps to fail via FG-384 guardrail)",
    );
    assert.equal(
      reviewerVerdict!.authority,
      "specialist",
      "authority must be specialist (advisory config)",
    );
  },
);

// ─── (fg418-5) FG-384 guardrail regression with non-empty in-hand result ─────

test(
  "(fg418-5) FG-384 guardrail regression: authoritative reviewer with in-hand non-empty result still fires; primary blocked_by_red",
  async () => {
    // Proves that threading primaryResult through dispatchReds did NOT break the
    // FG-384 guardrail. An authoritative shipping-reviewer with gate_on_verdict:true
    // returning ship over a fail doneAudit (active ticket) must still block.
    // The engineer result is non-empty (files_modified populated) to exercise the
    // new override path — ensuring the fix doesn't interfere with guardrail logic.
    const projectDir = makeTmpDir();
    writeStructuredTicket(projectDir, {
      id: "FG-418-5",
      title: "FG-418 FG-384 guardrail regression",
      body: "## Acceptance Criteria\n\n- Ship it\n\n",
    });

    const { runId } = startRun({
      workflow: WORKFLOW_AUTH_SHIPPING_REVIEWER,
      title: "fg418-5 FG-384 guardrail regression",
      inputs: { ticketId: "FG-418-5" },
      projectDir,
    });

    const exec: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
      const taskId = taskIdFromDockerArgs(args);
      const dir = dirname(stdoutPath);
      mkdirSync(dir, { recursive: true });

      let result: unknown;
      if (taskId.startsWith("task-build-")) {
        // Non-empty engineer result (exercises the new override path).
        // Create stub file so the persistence check passes.
        mkdirSync(join(projectDir, "src"), { recursive: true });
        writeFileSync(join(projectDir, "src", "guardrail-test.ts"), "// stub");
        result = {
          status: "complete", tests_run: 1,
          files_modified: ["src/guardrail-test.ts"],
          commitSha: "guardrailsha",
        };
      } else {
        // Authoritative reviewer ships over an active (unresolved) ticket —
        // doneAudit.outcome will be fail, guardrail must fire.
        result = {
          status: "complete",
          verdict: "ship",
          doneAuditDisposition: "ok",
          confidence: 0.9,
          findings: [],
        };
      }

      writeFileSync(join(dir, "result.json"), JSON.stringify(result));
      writeFileSync(stdoutPath, "");
      writeFileSync(stderrPath, "");
      return 0;
    };

    const wave = await runNext({
      runId,
      workflow: WORKFLOW_AUTH_SHIPPING_REVIEWER,
      dockerExec: exec,
    });

    // FG-384 guardrail must still fire — build step must NOT complete.
    assert.ok(
      !wave.completedSteps.includes("build"),
      "build step must NOT complete — FG-384 guardrail must still block with non-empty in-hand result",
    );

    const tasks = tasksForRun(runId);
    const primaryTask = tasks.find((t) => t.agentRole === "engineer" && t.parentId === undefined);
    assert.ok(primaryTask !== undefined, "primary engineer task must exist");
    assert.equal(
      primaryTask!.status,
      "blocked_by_red",
      "primary must be blocked_by_red — FG-384 guardrail survives the primaryResult threading fix",
    );

    // The recorded verdict must be fail with a synthetic finding.
    const verdicts = verdictsForRun(runId);
    const reviewerVerdict = verdicts.find((v) => v.redRole === "shipping-reviewer");
    assert.ok(reviewerVerdict !== undefined, "shipping-reviewer verdict must be recorded");
    assert.equal(
      reviewerVerdict!.verdict,
      "fail",
      "recorded verdict must be fail (FG-384 synthetic finding carried through pipeline)",
    );
    assert.ok(
      reviewerVerdict!.findings.length >= 1,
      "recorded verdict must carry >= 1 finding (the synthetic guardrail finding)",
    );
    const synthSummary = reviewerVerdict!.findings[0]!.summary;
    assert.ok(
      synthSummary.includes("done-audit") || synthSummary.includes("ship over"),
      `synthetic finding summary must describe the guardrail failure; got: ${synthSummary}`,
    );
  },
);
