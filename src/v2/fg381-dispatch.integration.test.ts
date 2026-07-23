// FG-381 dispatch-level integration tests.
//
// The assembler unit tests in reviewer-context-packet.test.ts cover
// assembleReviewerContextPacket in isolation. These tests exercise the
// dispatchReds WIRING in runNext.ts — shipping-reviewer detection, packet
// assembly, fail-loud pre-fail, and reviewerContextPacket injection into red
// task inputs — using a stubbed DockerExecFn so no real containers are spawned.
//
// Covers:
//   (fg381-1) Complete context: shipping-reviewer red receives reviewerContextPacket
//       in its taskPackage.inputs; non-shipping-reviewer reds do NOT.
//   (fg381-2) Fail-loud path: missing run.metadata.ticketId → task.failed event
//       emitted for the reviewer task carrying missingContext (required:true), and
//       NO container is dispatched for shipping-reviewer.
//   (fg381-3) Regression guard: step with only non-shipping-reviewer reds →
//       no reviewerContextPacket in any task inputs, dispatch behavior unchanged.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { tasksForRun } from "../store/tasks.js";
import { eventsForRun } from "../store/events.js";
import { insertGate } from "../store/gates.js";
import { startRun } from "./startRun.js";
import { runNext } from "./runNext.js";
import type { DockerExecFn } from "./runNext.js";
import type { Workflow } from "./schema.js";
import type { MissingContextItem } from "../types/index.js";
import { publishFlatAsGeneration } from "./seed-generation.testkit.js";

// ─── Workflow fixtures ────────────────────────────────────────────────────────

// engineer step with two reds: red-wide + shipping-reviewer.
const WORKFLOW_WITH_SHIPPING_REVIEWER: Workflow = {
  name: "fg381-dispatch-test",
  description: "FG-381 dispatch-level integration test",
  inputs: [],
  steps: [
    {
      id: "build",
      agent: "engineer",
      gate: "auto",
      manual: false,
      depends_on: [],
      runtime: "fg381-dispatch-test",
      reds: [
        { agent: "red-wide", authority: "specialist", gate_on_verdict: false },
        { agent: "shipping-reviewer", authority: "specialist", gate_on_verdict: false },
      ],
    },
  ],
};

// engineer step with ONLY shipping-reviewer (so the fail-loud path leaves no reds to launch).
const WORKFLOW_ONLY_SHIPPING_REVIEWER: Workflow = {
  name: "fg381-dispatch-test",
  description: "FG-381 dispatch-level integration test: fail-loud",
  inputs: [],
  steps: [
    {
      id: "build",
      agent: "engineer",
      gate: "auto",
      manual: false,
      depends_on: [],
      runtime: "fg381-dispatch-test",
      reds: [
        { agent: "shipping-reviewer", authority: "specialist", gate_on_verdict: false },
      ],
    },
  ],
};

// engineer step with ONLY shipping-reviewer at AUTHORITATIVE+gate_on_verdict:true (original escape scenario).
const WORKFLOW_AUTHORITATIVE_SHIPPING_REVIEWER: Workflow = {
  name: "fg381-dispatch-test",
  description: "FG-381 dispatch-level integration test: authoritative shipping-reviewer (original escape)",
  inputs: [],
  steps: [
    {
      id: "build",
      agent: "engineer",
      gate: "auto",
      manual: false,
      depends_on: [],
      runtime: "fg381-dispatch-test",
      reds: [
        { agent: "shipping-reviewer", authority: "authoritative", gate_on_verdict: true },
      ],
    },
  ],
};

// engineer step with ONLY red-wide (no shipping-reviewer at all).
const WORKFLOW_NO_SHIPPING_REVIEWER: Workflow = {
  name: "fg381-nored-test",
  description: "FG-381 dispatch-level integration test: regression guard",
  inputs: [],
  steps: [
    {
      id: "build",
      agent: "engineer",
      gate: "auto",
      manual: false,
      depends_on: [],
      runtime: "fg381-dispatch-test",
      reds: [
        { agent: "red-wide", authority: "specialist", gate_on_verdict: false },
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
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  ensureRuntime("fg381-dispatch-test");
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
  const dir = mkdtempSync(join(tmpdir(), "forge-fg381-"));
  tmpDirs.push(dir);
  return dir;
}

// Write a minimal runtime YAML stub to FORGE_HOME so runNext can load the workflow.
function ensureRuntime(name: string): void {
  const forgeHome = process.env.FORGE_HOME!;
  const runtimePath = join(forgeHome, "runtimes", `${name}.yml`);
  mkdirSync(dirname(runtimePath), { recursive: true });
  writeFileSync(
    runtimePath,
    `name: ${name}
description: FG-381 dispatch test runtime stub
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


// Extract the taskId embedded in docker exec args via --name forge-<taskId>.
function taskIdFromDockerArgs(args: string[]): string {
  const nameIdx = args.indexOf("--name");
  const containerName = nameIdx >= 0 ? (args[nameIdx + 1] ?? "") : "";
  return containerName.replace(/^forge-/, "");
}

// Write a structured backlog ticket to backlog/stories/ in the given dir.
function writeStructuredTicket(
  projectDir: string,
  opts: { id: string; title: string; epic?: string; body: string },
): void {
  const storiesDir = join(projectDir, "backlog", "stories");
  mkdirSync(storiesDir, { recursive: true });
  const slug = opts.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
  const lines = [
    "---",
    `id: ${opts.id}`,
    "type: story",
    "status: active",
    `title: ${opts.title}`,
    ...(opts.epic ? [`epic: ${opts.epic}`] : []),
    "---",
    "",
  ];
  writeFileSync(join(storiesDir, `${opts.id}-${slug}.md`), lines.join("\n") + opts.body);
}

// ─── (fg381-1) Complete context → shipping-reviewer gets reviewerContextPacket ─

test(
  "(fg381-1) complete context: shipping-reviewer task inputs contain reviewerContextPacket; red-wide task inputs do not",
  async () => {
    // Set up a real project dir with a structured ticket so readTicket can resolve it.
    const projectDir = makeTmpDir();
    writeStructuredTicket(projectDir, {
      id: "FG-381",
      title: "Ship FG-381",
      body: "## Acceptance Criteria\n\n- Ship it\n\n",
    });

    // Start a run with ticketId pointing to the structured ticket.
    const { runId } = startRun({
      workflow: WORKFLOW_WITH_SHIPPING_REVIEWER,
      title: "fg381-1 complete context test",
      inputs: { ticketId: "FG-381" },
      projectDir,
    });

    // Docker exec stub:
    //   Primary engineer task (task-build-*): inserts a human-advance gate so
    //   assembleReviewerContextPacket finds operatorAsk, then writes an engineer result.
    //   Red tasks (task-red-build-*): write a pass verdict.
    // The gate is inserted inside the exec stub (after the primary task row exists in DB
    // but before dispatchReds calls assembleReviewerContextPacket).
    const exec: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
      const taskId = taskIdFromDockerArgs(args);
      const dir = dirname(stdoutPath);
      mkdirSync(dir, { recursive: true });

      let result: unknown;
      if (taskId.startsWith("task-build-")) {
        // Primary task is in DB (insertTask ran before runContainer). Insert a
        // human-advance gate so operatorAsk is present when assembleReviewerContextPacket
        // reads gatesForRun after this exec returns.
        insertGate({
          id: `gate-fg381-human-${taskId}`,
          taskId,
          decision: "advance",
          rationale: "Ship it — looks good",
          decidedAt: new Date().toISOString(),
          decidedBy: "human",
        });
        result = {
          status: "complete", tests_run: 1,
          files_modified: [],
          commitSha: "deadbeef",
        };
      } else {
        // Red agent — return a pass verdict.
        result = { status: "complete", verdict: "pass", confidence: 0.9, findings: [] };
      }

      writeFileSync(join(dir, "result.json"), JSON.stringify(result));
      writeFileSync(stdoutPath, "");
      writeFileSync(stderrPath, "");
      return 0;
    };

    const wave = await runNext({
      runId,
      workflow: WORKFLOW_WITH_SHIPPING_REVIEWER,
      dockerExec: exec,
    });

    assert.deepEqual(
      wave.completedSteps,
      ["build"],
      "build step must complete when both reds pass",
    );

    const tasks = tasksForRun(runId);

    // shipping-reviewer red task must have reviewerContextPacket in its inputs.
    const reviewerTask = tasks.find((t) => t.agentRole === "shipping-reviewer");
    assert.ok(reviewerTask, "shipping-reviewer red task must exist in DB");
    assert.equal(reviewerTask!.status, "complete", "shipping-reviewer task must be complete");

    const reviewerInputs = reviewerTask!.taskPackage.inputs as Record<string, unknown>;
    const packet = reviewerInputs["reviewerContextPacket"];
    assert.ok(
      packet !== null && packet !== undefined,
      "shipping-reviewer taskPackage.inputs must contain reviewerContextPacket",
    );

    const pkt = packet as Record<string, unknown>;

    // Backlog must be populated (ticket FG-381 was found).
    assert.ok(pkt["backlog"] !== null && pkt["backlog"] !== undefined, "packet.backlog must be populated");
    const backlog = pkt["backlog"] as Record<string, unknown>;
    assert.equal(backlog["id"], "FG-381", "packet.backlog.id must match structured ticketId");
    assert.equal(backlog["title"], "Ship FG-381", "packet.backlog.title must match ticket title");

    // operatorAsk must reflect the human gate rationale.
    assert.equal(pkt["operatorAsk"], "Ship it — looks good", "packet.operatorAsk must match gate rationale");

    // missingContext must be empty (all required fields are present).
    const missingCtx = pkt["missingContext"] as MissingContextItem[];
    assert.ok(Array.isArray(missingCtx), "packet.missingContext must be an array");
    assert.equal(missingCtx.length, 0, "packet.missingContext must be empty for complete context");

    // red-wide red task must NOT carry reviewerContextPacket.
    const redWideTask = tasks.find((t) => t.agentRole === "red-wide");
    assert.ok(redWideTask, "red-wide red task must exist in DB");
    assert.equal(redWideTask!.status, "complete", "red-wide task must be complete");

    const redWideInputs = redWideTask!.taskPackage.inputs as Record<string, unknown>;
    assert.equal(
      redWideInputs["reviewerContextPacket"],
      undefined,
      "red-wide taskPackage.inputs must NOT carry reviewerContextPacket",
    );
  },
);

// ─── (fg381-2) Fail-loud path: missing ticketId → task.failed, no container ──

test(
  "(fg381-2) fail-loud path: missing run.metadata.ticketId → task.failed event with missingContext; NO container dispatched for shipping-reviewer",
  async () => {
    // No BACKLOG.md needed — assembleReviewerContextPacket short-circuits on missing ticketId.
    const projectDir = "/tmp/test-project";

    // Start a run WITHOUT ticketId in metadata — this is the condition under test.
    const { runId } = startRun({
      workflow: WORKFLOW_ONLY_SHIPPING_REVIEWER,
      title: "fg381-2 fail-loud test",
      inputs: {}, // intentionally no ticketId
      projectDir,
    });

    // Track which task IDs the exec was called for so we can verify the
    // shipping-reviewer container was never dispatched.
    const execCalledFor: string[] = [];

    const exec: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
      const taskId = taskIdFromDockerArgs(args);
      execCalledFor.push(taskId);
      const dir = dirname(stdoutPath);
      mkdirSync(dir, { recursive: true });
      // Only the primary engineer should reach this stub.
      writeFileSync(
        join(dir, "result.json"),
        JSON.stringify({ status: "complete", tests_run: 1, files_modified: [] }),
      );
      writeFileSync(stdoutPath, "");
      writeFileSync(stderrPath, "");
      return 0;
    };

    const wave = await runNext({ runId, workflow: WORKFLOW_ONLY_SHIPPING_REVIEWER, dockerExec: exec });

    // Exec must have been called exactly once — for the primary engineer task.
    assert.equal(
      execCalledFor.length,
      1,
      "exec must be called exactly once (only the primary engineer, not the pre-failed shipping-reviewer)",
    );
    assert.ok(
      execCalledFor[0]!.startsWith("task-build-"),
      `exec call must be for the primary engineer task (task-build-*), got: ${execCalledFor[0]}`,
    );

    // A task.failed event must have been emitted for the shipping-reviewer task,
    // carrying the missingContext array in its payload.
    const events = eventsForRun(runId);
    const failedEvents = events.filter((e) => e.eventType === "task.failed");
    assert.ok(failedEvents.length > 0, "at least one task.failed event must be emitted");

    // Identify the reviewer-specific fail event by presence of missingContext in payload.
    const reviewerFailEvent = failedEvents.find((e) => {
      const p = e.payload as Record<string, unknown> | null;
      return Array.isArray(p?.["missingContext"]);
    });
    assert.ok(
      reviewerFailEvent !== undefined,
      "a task.failed event carrying missingContext must be emitted for the shipping-reviewer",
    );

    const payload = reviewerFailEvent!.payload as Record<string, unknown>;
    const missingContext = payload["missingContext"] as MissingContextItem[];
    assert.ok(
      Array.isArray(missingContext) && missingContext.length > 0,
      "task.failed payload.missingContext must be a non-empty array",
    );

    // Must contain a required:true item for the missing backlogTicket.
    const backlogMissing = missingContext.find((m) => m.field === "backlogTicket");
    assert.ok(backlogMissing !== undefined, "missingContext must include a backlogTicket item");
    assert.equal(
      backlogMissing!.required,
      true,
      "backlogTicket missing item must have required:true",
    );

    // The shipping-reviewer task row must exist in the DB with status "failed"
    // (pre-failed without a container being dispatched).
    const tasks = tasksForRun(runId);
    const reviewerTask = tasks.find((t) => t.agentRole === "shipping-reviewer");
    assert.ok(
      reviewerTask !== undefined,
      "shipping-reviewer task row must be inserted into DB even in the fail-loud path",
    );
    assert.equal(
      reviewerTask!.status,
      "failed",
      "shipping-reviewer task must be marked failed (pre-failed, no container run)",
    );

    // PRIMARY must be BLOCKED (blocked_by_red), NOT complete.
    // Missing required reviewer context is a hard stop — the change cannot be accepted.
    const primaryTask = tasks.find((t) => t.agentRole === "engineer" && t.parentId === undefined);
    assert.ok(primaryTask !== undefined, "primary engineer task must exist");
    assert.equal(
      primaryTask!.status,
      "blocked_by_red",
      "primary task must be blocked_by_red when required reviewer context is missing, not complete",
    );

    // The wave must NOT include the build step in completedSteps.
    assert.ok(
      !wave.completedSteps.includes("build"),
      "build step must NOT be in completedSteps when shipping-reviewer was pre-failed",
    );
  },
);

// ─── (fg381-3) Regression guard: non-shipping-reviewer reds only ──────────────

test(
  "(fg381-3) regression guard: step with only non-shipping-reviewer reds → no reviewerContextPacket in any task inputs",
  async () => {
    const projectDir = "/tmp/test-project";

    const { runId } = startRun({
      workflow: WORKFLOW_NO_SHIPPING_REVIEWER,
      title: "fg381-3 regression guard test",
      inputs: {},
      projectDir,
    });

    const exec: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
      const taskId = taskIdFromDockerArgs(args);
      const dir = dirname(stdoutPath);
      mkdirSync(dir, { recursive: true });

      let result: unknown;
      if (taskId.startsWith("task-build-")) {
        result = { status: "complete", tests_run: 1, files_modified: [] };
      } else {
        result = { status: "complete", verdict: "pass", confidence: 0.9, findings: [] };
      }

      writeFileSync(join(dir, "result.json"), JSON.stringify(result));
      writeFileSync(stdoutPath, "");
      writeFileSync(stderrPath, "");
      return 0;
    };

    const wave = await runNext({
      runId,
      workflow: WORKFLOW_NO_SHIPPING_REVIEWER,
      dockerExec: exec,
    });

    // Build step must complete normally (red-wide passes, no shipping-reviewer to fail-loud).
    assert.deepEqual(
      wave.completedSteps,
      ["build"],
      "build must complete normally when only red-wide is present",
    );

    const tasks = tasksForRun(runId);

    // No task must carry reviewerContextPacket in its inputs.
    const withPacket = tasks.filter(
      (t) =>
        (t.taskPackage.inputs as Record<string, unknown>)["reviewerContextPacket"] !== undefined,
    );
    assert.equal(
      withPacket.length,
      0,
      "no task must carry reviewerContextPacket when no shipping-reviewer is in step.reds",
    );

    // red-wide task must have been dispatched and completed normally.
    const redWideTask = tasks.find((t) => t.agentRole === "red-wide");
    assert.ok(redWideTask !== undefined, "red-wide red task must exist");
    assert.equal(redWideTask!.status, "complete", "red-wide task must be complete");
  },
);

// ─── (fg381-4) Original escape: authoritative+gate_on_verdict:true + missing context ──

test(
  "(fg381-4) original escape: authoritative+gate_on_verdict:true + missing ticketId → primary blocked_by_red, NOT complete",
  async () => {
    // This reproduces the pre-fix escape: shipping-reviewer config is authoritative with
    // gate_on_verdict:true. Before the fix, shippingReviewerPreFailed did NOT set
    // authoritativeFail, so the primary slipped through to "complete". After the fix,
    // shippingReviewerPreFailed unconditionally sets authoritativeFail=true.
    const projectDir = "/tmp/test-project";

    const { runId } = startRun({
      workflow: WORKFLOW_AUTHORITATIVE_SHIPPING_REVIEWER,
      title: "fg381-4 original escape test",
      inputs: {}, // no ticketId — required context missing
      projectDir,
    });

    const execCalledFor: string[] = [];
    const exec: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
      const taskId = taskIdFromDockerArgs(args);
      execCalledFor.push(taskId);
      const dir = dirname(stdoutPath);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "result.json"),
        JSON.stringify({ status: "complete", tests_run: 1, files_modified: [] }),
      );
      writeFileSync(stdoutPath, "");
      writeFileSync(stderrPath, "");
      return 0;
    };

    const wave = await runNext({
      runId,
      workflow: WORKFLOW_AUTHORITATIVE_SHIPPING_REVIEWER,
      dockerExec: exec,
    });

    // Only primary engineer should have been exec'd — reviewer is pre-failed, no container.
    assert.equal(
      execCalledFor.length,
      1,
      "exec must be called exactly once: only the primary engineer (shipping-reviewer pre-failed)",
    );
    assert.ok(
      execCalledFor[0]!.startsWith("task-build-"),
      `exec must be for primary engineer (task-build-*), got: ${execCalledFor[0]}`,
    );

    const tasks = tasksForRun(runId);
    const primaryTask = tasks.find((t) => t.agentRole === "engineer" && t.parentId === undefined);
    assert.ok(primaryTask !== undefined, "primary engineer task must exist");
    assert.equal(
      primaryTask!.status,
      "blocked_by_red",
      "primary must be blocked_by_red when authoritative shipping-reviewer context is missing — NOT complete",
    );

    // build step must NOT be in completedSteps.
    assert.ok(
      !wave.completedSteps.includes("build"),
      "build step must NOT appear in completedSteps when required reviewer context is missing",
    );

    // shipping-reviewer task must be pre-failed.
    const reviewerTask = tasks.find((t) => t.agentRole === "shipping-reviewer");
    assert.ok(reviewerTask !== undefined, "shipping-reviewer task row must be inserted in DB");
    assert.equal(
      reviewerTask!.status,
      "failed",
      "shipping-reviewer must be marked failed (pre-failed, no container dispatched)",
    );
  },
);

// ─── (fg381-5) Contrast: context PRESENT (structured ticket + human gate) → not pre-blocked ──

test(
  "(fg381-5) contrast: context PRESENT (structured ticket + human-advance gate) → shipping-reviewer launched normally; primary NOT pre-blocked",
  async () => {
    // This is the over-blocking guard: when all required context IS available, the
    // shipping-reviewer must run normally and the primary must not be pre-blocked.
    const projectDir = makeTmpDir();
    writeFileSync(join(projectDir, "README.md"), "# test\n");
    writeStructuredTicket(projectDir, {
      id: "FG-555",
      title: "Contrast Case Feature",
      epic: "FG-500",
      body: [
        "## Acceptance Criteria",
        "",
        "- Ships correctly",
        "",
      ].join("\n"),
    });

    const { runId } = startRun({
      workflow: WORKFLOW_AUTHORITATIVE_SHIPPING_REVIEWER,
      title: "fg381-5 contrast test",
      inputs: { ticketId: "FG-555" },
      projectDir,
    });

    const execCalledFor: string[] = [];
    const exec: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
      const taskId = taskIdFromDockerArgs(args);
      execCalledFor.push(taskId);
      const dir = dirname(stdoutPath);
      mkdirSync(dir, { recursive: true });

      let result: unknown;
      if (taskId.startsWith("task-build-")) {
        // Insert human-advance gate so assembleReviewerContextPacket finds operatorAsk.
        insertGate({
          id: `gate-fg381-5-${taskId}`,
          taskId,
          decision: "advance",
          rationale: "Approved: ship FG-555",
          decidedAt: new Date().toISOString(),
          decidedBy: "human",
        });
        result = { status: "complete", tests_run: 1, files_modified: [], commitSha: "cafebabe" };
      } else {
        // doneAuditDisposition needed: FG-555 is status:active so doneAudit.outcome=fail; without it FG-384 backstop downgrades ship→fail.
        result = { status: "complete", verdict: "ship", doneAuditDisposition: "accepted_exception: contrast-case test fixture", confidence: 0.95, findings: [] };
      }

      writeFileSync(join(dir, "result.json"), JSON.stringify(result));
      writeFileSync(stdoutPath, "");
      writeFileSync(stderrPath, "");
      return 0;
    };

    const wave = await runNext({
      runId,
      workflow: WORKFLOW_AUTHORITATIVE_SHIPPING_REVIEWER,
      dockerExec: exec,
    });

    // Both primary and shipping-reviewer containers must have been exec'd.
    assert.equal(
      execCalledFor.length,
      2,
      "both primary engineer and shipping-reviewer containers must run when context is present",
    );

    const tasks = tasksForRun(runId);

    // shipping-reviewer must exist and NOT be pre-failed.
    const reviewerTask = tasks.find((t) => t.agentRole === "shipping-reviewer");
    assert.ok(reviewerTask !== undefined, "shipping-reviewer task must exist");
    assert.equal(
      reviewerTask!.status,
      "complete",
      "shipping-reviewer must be complete (launched normally, not pre-failed)",
    );

    // reviewerContextPacket must have been injected with the structured ticket data.
    const reviewerInputs = reviewerTask!.taskPackage.inputs as Record<string, unknown>;
    const packet = reviewerInputs["reviewerContextPacket"] as Record<string, unknown>;
    assert.ok(packet !== undefined && packet !== null, "reviewerContextPacket must be in shipping-reviewer inputs");
    const backlog = packet["backlog"] as Record<string, unknown>;
    assert.ok(backlog !== null && backlog !== undefined, "packet.backlog must be populated");
    assert.equal(backlog["id"], "FG-555", "packet.backlog.id from structured ticket");
    assert.equal(backlog["title"], "Contrast Case Feature");
    assert.equal(backlog["parentEpic"], "FG-500", "parentEpic from epic frontmatter");

    // missingContext must be empty — all required fields present.
    const missingCtx = packet["missingContext"] as Array<{ field: string; required: boolean }>;
    assert.ok(Array.isArray(missingCtx), "missingContext must be an array");
    const requiredMissing = missingCtx.filter((m) => m.required);
    assert.equal(requiredMissing.length, 0, "no required context must be missing when ticket + gate present");

    // Primary must complete (authoritative reviewer passed).
    const primaryTask = tasks.find((t) => t.agentRole === "engineer" && t.parentId === undefined);
    assert.ok(primaryTask !== undefined, "primary task must exist");
    assert.notEqual(
      primaryTask!.status,
      "blocked_by_red",
      "primary must NOT be blocked_by_red when shipping-reviewer passes",
    );

    // build step must appear in completedSteps.
    assert.ok(
      wave.completedSteps.includes("build"),
      "build must be in completedSteps when context present and reviewer passes",
    );
  },
);
