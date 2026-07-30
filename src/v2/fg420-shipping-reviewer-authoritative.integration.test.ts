// FG-420 integration tests: authoritative shipping-reviewer promotion.
//
// Proves that once shipping-reviewer is authoritative with gate_on_verdict:true,
// the full dispatchReds path correctly blocks (or passes) the primary task.
//
// Key scenario: needs_human (and unrecognized verdicts) → inconclusive → our
// FG-420 synthetic finding is prepended and persisted → authoritativeFail → primary
// blocked_by_red. This is the "option b" hard-block design for needs_human.
//
// Covers:
//   (fg420-1) ship with accepted_exception (clean path) → primary completes, not blocked
//   (fg420-2) valid ship_with_named_deferrals + covered_by_deferral → primary completes, not blocked
//   (fg420-3) needs_fix → primary blocked_by_red, recorded verdict=fail with findings
//   (fg420-4) needs_human → primary blocked_by_red, verdict=inconclusive with human-decision finding
//   (fg420-5) unrecognized verdict (unknown_state) → primary blocked_by_red, verdict=inconclusive
//   (fg420-6) gate() without --force on blocked_by_red task → throws "blocked_by_red"

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { tasksForRun } from "../store/tasks.js";
import { verdictsForRun } from "../store/verdicts.js";
import { startRun } from "./startRun.js";
import { runNext } from "./runNext.js";
import { gate } from "./gate.js";
import type { DockerExecFn } from "./runNext.js";
import type { Workflow } from "./schema.js";
import { gatesForTask } from "../store/gates.js";
import { publishFlatAsGeneration } from "./seed-generation.testkit.js";

// ─── Workflow fixture ─────────────────────────────────────────────────────────

// Authoritative shipping-reviewer with gate_on_verdict:true — the promoted config.
const WORKFLOW_AUTH_SHIPPING_REVIEWER: Workflow = {
  name: "fg420-dispatch-test",
  description: "FG-420 authoritative shipping-reviewer integration test",
  review_mode: "legacy_verdict",
  inputs: [],
  steps: [
    {
      id: "build",
      agent: "engineer",
      gate: "auto",
      manual: false,
      depends_on: [],
      runtime: "fg420-dispatch-test",
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
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  ensureRuntime("fg420-dispatch-test");
  ensureWorkflow("fg420-dispatch-test");
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
  const dir = mkdtempSync(join(tmpdir(), "forge-fg420-"));
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
description: FG-420 dispatch test runtime stub
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

function ensureWorkflow(name: string): void {
  const forgeHome = process.env.FORGE_HOME!;
  const workflowPath = join(forgeHome, "workflows", `${name}.yml`);
  mkdirSync(dirname(workflowPath), { recursive: true });
  writeFileSync(
    workflowPath,
    `name: ${name}
description: FG-420 dispatch test workflow stub
inputs: []
steps:
  - id: build
    agent: engineer
    gate: auto
    manual: false
    depends_on: []
    runtime: ${name}
    reds:
      - agent: shipping-reviewer
        authority: authoritative
        gate_on_verdict: true
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

// ─── (fg420-1) ship with accepted_exception → primary completes ───────────────

test(
  "(fg420-1) ship with accepted_exception: valid ship stays pass through real pipeline, primary completes",
  async () => {
    const projectDir = makeTmpDir();
    writeStructuredTicket(projectDir, {
      id: "FG-T420-1",
      title: "FG-420 test 1 ship accepted exception",
      body: "## Acceptance Criteria\n\n- Ship it\n\n",
    });

    const { runId } = startRun({
      workflow: WORKFLOW_AUTH_SHIPPING_REVIEWER,
      title: "fg420-1 ship accepted_exception test",
      inputs: { ticketId: "FG-T420-1" },
      projectDir,
    });

    const exec: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
      const taskId = taskIdFromDockerArgs(args);
      const dir = dirname(stdoutPath);
      mkdirSync(dir, { recursive: true });

      let result: unknown;
      if (taskId.startsWith("task-build-")) {
        result = { status: "complete", tests_run: 1, files_modified: [], commitSha: "deadbeef" };
      } else {
        result = {
          status: "complete",
          verdict: "ship",
          doneAuditDisposition: "accepted_exception:fg420-1-clean-path",
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

    assert.ok(
      wave.completedSteps.includes("build"),
      "build step must be in completedSteps — valid ship with accepted_exception must not be blocked",
    );

    const tasks = tasksForRun(runId);
    const primaryTask = tasks.find((t) => t.agentRole === "engineer" && t.parentId === undefined);
    assert.ok(primaryTask !== undefined, "primary engineer task must exist");
    assert.equal(
      primaryTask!.status,
      "complete",
      "primary must be complete — ship with accepted_exception must not be blocked_by_red",
    );

    const verdicts = verdictsForRun(runId);
    const reviewerVerdict = verdicts.find((v) => v.redRole === "shipping-reviewer");
    assert.ok(reviewerVerdict !== undefined, "shipping-reviewer verdict must be recorded");
    assert.equal(
      reviewerVerdict!.verdict,
      "pass",
      "recorded verdict must be pass — ship with accepted_exception stays pass through full pipeline",
    );
  },
);

// ─── (fg420-2) valid ship_with_named_deferrals → primary completes ────────────

test(
  "(fg420-2) valid ship_with_named_deferrals (description + followUpTicketId): primary completes, not blocked",
  async () => {
    const projectDir = makeTmpDir();
    writeStructuredTicket(projectDir, {
      id: "FG-T420-2",
      title: "FG-420 test 2 valid deferrals",
      body: "## Acceptance Criteria\n\n- Ship it with deferrals\n\n",
    });

    const { runId } = startRun({
      workflow: WORKFLOW_AUTH_SHIPPING_REVIEWER,
      title: "fg420-2 valid deferrals test",
      inputs: { ticketId: "FG-T420-2" },
      projectDir,
    });

    const exec: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
      const taskId = taskIdFromDockerArgs(args);
      const dir = dirname(stdoutPath);
      mkdirSync(dir, { recursive: true });

      let result: unknown;
      if (taskId.startsWith("task-build-")) {
        result = { status: "complete", tests_run: 1, files_modified: [], commitSha: "deadbeef" };
      } else {
        // Valid deferrals: both description and followUpTicketId present.
        // covered_by_deferral bypasses the done-audit guardrail backstop.
        result = {
          status: "complete",
          verdict: "ship_with_named_deferrals",
          named_deferrals: [
            { description: "Defer host verification for this cycle", followUpTicketId: "FG-9001" },
          ],
          doneAuditDisposition: "covered_by_deferral",
          confidence: 0.85,
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

    assert.ok(
      wave.completedSteps.includes("build"),
      "build step must be in completedSteps — valid ship_with_named_deferrals must not be blocked",
    );

    const tasks = tasksForRun(runId);
    const primaryTask = tasks.find((t) => t.agentRole === "engineer" && t.parentId === undefined);
    assert.ok(primaryTask !== undefined, "primary engineer task must exist");
    assert.equal(
      primaryTask!.status,
      "complete",
      "primary must be complete — valid ship_with_named_deferrals must not be blocked_by_red",
    );

    const verdicts = verdictsForRun(runId);
    const reviewerVerdict = verdicts.find((v) => v.redRole === "shipping-reviewer");
    assert.ok(reviewerVerdict !== undefined, "shipping-reviewer verdict must be recorded");
    assert.equal(
      reviewerVerdict!.verdict,
      "pass",
      "recorded verdict must be pass — valid deferrals stay pass through full pipeline",
    );
  },
);

// ─── (fg420-3) needs_fix → primary blocked_by_red, verdict=fail ──────────────

test(
  "(fg420-3) needs_fix: synthetic anchor survives pipeline → recorded fail, primary blocked_by_red",
  async () => {
    const projectDir = makeTmpDir();
    writeStructuredTicket(projectDir, {
      id: "FG-T420-3",
      title: "FG-420 test 3 needs fix",
      body: "## Acceptance Criteria\n\n- Fix it\n\n",
    });

    const { runId } = startRun({
      workflow: WORKFLOW_AUTH_SHIPPING_REVIEWER,
      title: "fg420-3 needs_fix test",
      inputs: { ticketId: "FG-T420-3" },
      projectDir,
    });

    const exec: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
      const taskId = taskIdFromDockerArgs(args);
      const dir = dirname(stdoutPath);
      mkdirSync(dir, { recursive: true });

      let result: unknown;
      if (taskId.startsWith("task-build-")) {
        result = { status: "complete", tests_run: 1, files_modified: [], commitSha: "deadbeef" };
      } else {
        result = {
          status: "complete",
          verdict: "needs_fix",
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

    assert.ok(
      !wave.completedSteps.includes("build"),
      "build step must NOT complete — needs_fix must block",
    );

    const tasks = tasksForRun(runId);
    const primaryTask = tasks.find((t) => t.agentRole === "engineer" && t.parentId === undefined);
    assert.ok(primaryTask !== undefined, "primary engineer task must exist");
    assert.equal(
      primaryTask!.status,
      "blocked_by_red",
      "primary must be blocked_by_red — needs_fix synthetic anchor survived pipeline",
    );

    const verdicts = verdictsForRun(runId);
    const reviewerVerdict = verdicts.find((v) => v.redRole === "shipping-reviewer");
    assert.ok(reviewerVerdict !== undefined, "shipping-reviewer verdict must be recorded");
    assert.equal(
      reviewerVerdict!.verdict,
      "fail",
      "recorded verdict must be fail — NOT inconclusive (synthetic anchor carried the fail through line-691)",
    );
    assert.ok(
      reviewerVerdict!.findings.length >= 1,
      "recorded verdict must carry >= 1 finding (the synthetic anchor)",
    );
  },
);

// ─── (fg420-4) needs_human → primary blocked_by_red, verdict=inconclusive ────

test(
  "(fg420-4) needs_human: FG-420 synthetic finding persisted → recorded inconclusive, primary blocked_by_red",
  async () => {
    // needs_human → mapShippingReviewerVerdict returns inconclusive.
    // FG-420 logic: authoritative shipping-reviewer inconclusive → prepend synthetic
    // finding (persisted to DB) AND set authoritativeFail=true → primary blocked_by_red.
    // Verdict stored as inconclusive (NOT fail) but WITH the human-decision synthetic finding.
    const projectDir = makeTmpDir();
    writeStructuredTicket(projectDir, {
      id: "FG-T420-4",
      title: "FG-420 test 4 needs human",
      body: "## Acceptance Criteria\n\n- Human required\n\n",
    });

    const { runId } = startRun({
      workflow: WORKFLOW_AUTH_SHIPPING_REVIEWER,
      title: "fg420-4 needs_human test",
      inputs: { ticketId: "FG-T420-4" },
      projectDir,
    });

    const exec: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
      const taskId = taskIdFromDockerArgs(args);
      const dir = dirname(stdoutPath);
      mkdirSync(dir, { recursive: true });

      let result: unknown;
      if (taskId.startsWith("task-build-")) {
        result = { status: "complete", tests_run: 1, files_modified: [], commitSha: "deadbeef" };
      } else {
        result = {
          status: "complete",
          verdict: "needs_human",
          confidence: 0.5,
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

    assert.ok(
      !wave.completedSteps.includes("build"),
      "build step must NOT complete — needs_human must now block (FG-420 authoritative path)",
    );

    const tasks = tasksForRun(runId);
    const primaryTask = tasks.find((t) => t.agentRole === "engineer" && t.parentId === undefined);
    assert.ok(primaryTask !== undefined, "primary engineer task must exist");
    assert.equal(
      primaryTask!.status,
      "blocked_by_red",
      "primary must be blocked_by_red — needs_human under authoritative authority is now a hard block",
    );

    const verdicts = verdictsForRun(runId);
    const reviewerVerdict = verdicts.find((v) => v.redRole === "shipping-reviewer");
    assert.ok(reviewerVerdict !== undefined, "shipping-reviewer verdict must be recorded");
    assert.equal(
      reviewerVerdict!.verdict,
      "inconclusive",
      "recorded verdict must be inconclusive — needs_human maps to inconclusive, not fail",
    );
    assert.ok(
      reviewerVerdict!.findings.length >= 1,
      "recorded verdict must carry >= 1 finding — FG-420 synthetic finding must be persisted",
    );
    const synthSummary = reviewerVerdict!.findings[0]!.summary;
    assert.ok(
      synthSummary.includes("shippable verdict") && synthSummary.includes("blocked pending human review"),
      `FG-420 synthetic finding summary must describe the block reason; got: ${synthSummary}`,
    );
  },
);

// ─── (fg420-5) unrecognized verdict → primary blocked_by_red, verdict=inconclusive

test(
  "(fg420-5) unrecognized verdict (unknown_state): FG-420 synthetic finding persisted → recorded inconclusive, primary blocked_by_red",
  async () => {
    // An unrecognized verdict maps to inconclusive just like needs_human.
    // FG-420 must block this too — a malformed or future-extended verdict must not
    // silently advance the gate under authoritative authority.
    const projectDir = makeTmpDir();
    writeStructuredTicket(projectDir, {
      id: "FG-T420-5",
      title: "FG-420 test 5 unknown state",
      body: "## Acceptance Criteria\n\n- Unknown verdict\n\n",
    });

    const { runId } = startRun({
      workflow: WORKFLOW_AUTH_SHIPPING_REVIEWER,
      title: "fg420-5 unrecognized verdict test",
      inputs: { ticketId: "FG-T420-5" },
      projectDir,
    });

    const exec: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
      const taskId = taskIdFromDockerArgs(args);
      const dir = dirname(stdoutPath);
      mkdirSync(dir, { recursive: true });

      let result: unknown;
      if (taskId.startsWith("task-build-")) {
        result = { status: "complete", tests_run: 1, files_modified: [], commitSha: "deadbeef" };
      } else {
        result = {
          status: "complete",
          verdict: "unknown_state",
          confidence: 0.5,
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

    assert.ok(
      !wave.completedSteps.includes("build"),
      "build step must NOT complete — unrecognized verdict must block under authoritative authority",
    );

    const tasks = tasksForRun(runId);
    const primaryTask = tasks.find((t) => t.agentRole === "engineer" && t.parentId === undefined);
    assert.ok(primaryTask !== undefined, "primary engineer task must exist");
    assert.equal(
      primaryTask!.status,
      "blocked_by_red",
      "primary must be blocked_by_red — unrecognized verdict under authoritative authority is a hard block",
    );

    const verdicts = verdictsForRun(runId);
    const reviewerVerdict = verdicts.find((v) => v.redRole === "shipping-reviewer");
    assert.ok(reviewerVerdict !== undefined, "shipping-reviewer verdict must be recorded");
    assert.equal(
      reviewerVerdict!.verdict,
      "inconclusive",
      "recorded verdict must be inconclusive — unrecognized verdict maps to inconclusive",
    );
    assert.ok(
      reviewerVerdict!.findings.length >= 1,
      "recorded verdict must carry >= 1 finding — FG-420 synthetic finding must be persisted",
    );
  },
);

// ─── (fg420-7) container crash → primary blocked_by_red, broadened finding ────

test(
  "(fg420-7) container crash (no result.json): FG-420 broadened synthetic finding persisted → recorded inconclusive, primary blocked_by_red",
  async () => {
    // When the authoritative shipping-reviewer's container fails to produce a
    // result (exit code non-zero, result.json left empty), runOneRed synthesizes
    // verdict=inconclusive. FG-420 must block this and persist the broadened
    // diagnostic finding (not the misleading "requires a human decision" message).
    const projectDir = makeTmpDir();
    writeStructuredTicket(projectDir, {
      id: "FG-T420-7",
      title: "FG-420 test 7 container crash",
      body: "## Acceptance Criteria\n\n- Crash path blocked\n\n",
    });

    const { runId } = startRun({
      workflow: WORKFLOW_AUTH_SHIPPING_REVIEWER,
      title: "fg420-7 container crash test",
      inputs: { ticketId: "FG-T420-7" },
      projectDir,
    });

    const exec: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
      const taskId = taskIdFromDockerArgs(args);
      const dir = dirname(stdoutPath);
      mkdirSync(dir, { recursive: true });

      if (taskId.startsWith("task-build-")) {
        // Primary engineer task succeeds normally.
        writeFileSync(join(dir, "result.json"), JSON.stringify({ status: "complete", tests_run: 1, files_modified: [], commitSha: "deadbeef" }));
        writeFileSync(stdoutPath, "");
        writeFileSync(stderrPath, "");
        return 0;
      } else {
        // Shipping-reviewer container crashes: write stdout/stderr but leave
        // result.json empty (runContainer pre-writes it as "" at line 1781).
        // Exit code 1 → exitCode !== 0 && !resultRaw → kind: "failed".
        writeFileSync(stdoutPath, "");
        writeFileSync(stderrPath, "container crash simulated");
        return 1;
      }
    };

    const wave = await runNext({
      runId,
      workflow: WORKFLOW_AUTH_SHIPPING_REVIEWER,
      dockerExec: exec,
    });

    assert.ok(
      !wave.completedSteps.includes("build"),
      "build step must NOT complete — crashed authoritative shipping-reviewer must block (FG-420 fail-safe)",
    );

    const tasks = tasksForRun(runId);
    const primaryTask = tasks.find((t) => t.agentRole === "engineer" && t.parentId === undefined);
    assert.ok(primaryTask !== undefined, "primary engineer task must exist");
    assert.equal(
      primaryTask!.status,
      "blocked_by_red",
      "primary must be blocked_by_red — crashed authoritative shipping-reviewer is a fail-safe block",
    );

    const verdicts = verdictsForRun(runId);
    const reviewerVerdict = verdicts.find((v) => v.redRole === "shipping-reviewer");
    assert.ok(reviewerVerdict !== undefined, "shipping-reviewer verdict must be recorded even on crash");
    assert.equal(
      reviewerVerdict!.verdict,
      "inconclusive",
      "recorded verdict must be inconclusive — crash synthesizes inconclusive",
    );
    assert.ok(
      reviewerVerdict!.findings.length >= 1,
      "recorded verdict must carry >= 1 finding — FG-420 broadened synthetic finding must be persisted",
    );
    const synthFinding = reviewerVerdict!.findings[0]!;
    assert.ok(
      synthFinding.summary.includes("shippable verdict") && synthFinding.summary.includes("blocked pending human review"),
      `FG-420 broadened finding summary must cover crash case; got: ${synthFinding.summary}`,
    );
    assert.ok(
      synthFinding.evidence.includes("failed to produce a result"),
      `FG-420 broadened finding evidence must mention failed-to-produce case; got: ${synthFinding.evidence}`,
    );
  },
);

// ─── (fg420-6) gate() without force on blocked_by_red → throws ───────────────

test(
  "(fg420-6) gate() without --force on blocked_by_red task throws with 'blocked_by_red'",
  async () => {
    // After a needs_human result blocks the primary, calling gate(advance) without
    // --force must throw the 'blocked_by_red. Re-run with --force' error from gate.ts.
    const projectDir = makeTmpDir();
    writeStructuredTicket(projectDir, {
      id: "FG-T420-6",
      title: "FG-420 test 6 gate blocked",
      body: "## Acceptance Criteria\n\n- Gate blocked\n\n",
    });

    const { runId } = startRun({
      workflow: WORKFLOW_AUTH_SHIPPING_REVIEWER,
      title: "fg420-6 gate blocked_by_red test",
      inputs: { ticketId: "FG-T420-6" },
      projectDir,
    });

    const exec: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
      const taskId = taskIdFromDockerArgs(args);
      const dir = dirname(stdoutPath);
      mkdirSync(dir, { recursive: true });

      let result: unknown;
      if (taskId.startsWith("task-build-")) {
        result = { status: "complete", tests_run: 1, files_modified: [], commitSha: "deadbeef" };
      } else {
        // needs_human → inconclusive → FG-420 blocks
        result = {
          status: "complete",
          verdict: "needs_human",
          confidence: 0.5,
          findings: [],
        };
      }

      writeFileSync(join(dir, "result.json"), JSON.stringify(result));
      writeFileSync(stdoutPath, "");
      writeFileSync(stderrPath, "");
      return 0;
    };

    await runNext({
      runId,
      workflow: WORKFLOW_AUTH_SHIPPING_REVIEWER,
      dockerExec: exec,
    });

    const tasks = tasksForRun(runId);
    const primaryTask = tasks.find((t) => t.agentRole === "engineer" && t.parentId === undefined);
    assert.ok(primaryTask !== undefined, "primary engineer task must exist");
    assert.equal(
      primaryTask!.status,
      "blocked_by_red",
      "primary must be blocked_by_red before we test gate()",
    );

    await assert.rejects(
      gate(primaryTask!.id, "advance", undefined),
      (err: unknown) => {
        assert.ok(err instanceof Error, "gate() must throw an Error");
        assert.ok(
          err.message.includes("blocked_by_red"),
          `gate() error must mention 'blocked_by_red'; got: ${err.message}`,
        );
        return true;
      },
      "gate() without --force on a blocked_by_red task must throw",
    );
  },
);

// ─── (fg420-8) force-advance without rationale → throws, no gate row ─────────

test(
  "(fg420-8) gate() --force on blocked_by_red task WITHOUT rationale throws and writes no gate row",
  async () => {
    const projectDir = makeTmpDir();
    writeStructuredTicket(projectDir, {
      id: "FG-T420-8",
      title: "FG-420 test 8 force no rationale",
      body: "## Acceptance Criteria\n\n- Force rationale required\n\n",
    });

    const { runId } = startRun({
      workflow: WORKFLOW_AUTH_SHIPPING_REVIEWER,
      title: "fg420-8 force without rationale",
      inputs: { ticketId: "FG-T420-8" },
      projectDir,
    });

    const exec: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
      const taskId = taskIdFromDockerArgs(args);
      const dir = dirname(stdoutPath);
      mkdirSync(dir, { recursive: true });
      let result: unknown;
      if (taskId.startsWith("task-build-")) {
        result = { status: "complete", tests_run: 1, files_modified: [], commitSha: "deadbeef" };
      } else {
        result = { status: "complete", verdict: "needs_human", confidence: 0.5, findings: [] };
      }
      writeFileSync(join(dir, "result.json"), JSON.stringify(result));
      writeFileSync(stdoutPath, "");
      writeFileSync(stderrPath, "");
      return 0;
    };

    await runNext({ runId, workflow: WORKFLOW_AUTH_SHIPPING_REVIEWER, dockerExec: exec });

    const tasks = tasksForRun(runId);
    const primaryTask = tasks.find((t) => t.agentRole === "engineer" && t.parentId === undefined);
    assert.ok(primaryTask !== undefined, "primary engineer task must exist");
    assert.equal(primaryTask!.status, "blocked_by_red", "primary must be blocked_by_red before test");

    const gatesBefore = gatesForTask(primaryTask!.id);

    await assert.rejects(
      gate(primaryTask!.id, "advance", undefined, { force: true }),
      (err: unknown) => {
        assert.ok(err instanceof Error, "gate() must throw an Error");
        assert.ok(
          err.message.includes("--rationale is required"),
          `error must mention --rationale is required; got: ${err.message}`,
        );
        return true;
      },
      "gate() --force without rationale on blocked_by_red must throw",
    );

    const gatesAfter = gatesForTask(primaryTask!.id);
    assert.equal(
      gatesAfter.length,
      gatesBefore.length,
      "no gate row must be inserted when force-advance without rationale throws",
    );
  },
);

// ─── (fg420-9) force-advance with rationale → succeeds, gate row written ─────

test(
  "(fg420-9) gate() --force on blocked_by_red task WITH rationale succeeds and writes gate row with rationale",
  async () => {
    const projectDir = makeTmpDir();
    writeStructuredTicket(projectDir, {
      id: "FG-T420-9",
      title: "FG-420 test 9 force with rationale",
      body: "## Acceptance Criteria\n\n- Force with rationale succeeds\n\n",
    });

    const { runId } = startRun({
      workflow: WORKFLOW_AUTH_SHIPPING_REVIEWER,
      title: "fg420-9 force with rationale",
      inputs: { ticketId: "FG-T420-9" },
      projectDir,
    });

    const exec: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
      const taskId = taskIdFromDockerArgs(args);
      const dir = dirname(stdoutPath);
      mkdirSync(dir, { recursive: true });
      let result: unknown;
      if (taskId.startsWith("task-build-")) {
        result = { status: "complete", tests_run: 1, files_modified: [], commitSha: "deadbeef" };
      } else {
        result = { status: "complete", verdict: "needs_human", confidence: 0.5, findings: [] };
      }
      writeFileSync(join(dir, "result.json"), JSON.stringify(result));
      writeFileSync(stdoutPath, "");
      writeFileSync(stderrPath, "");
      return 0;
    };

    await runNext({ runId, workflow: WORKFLOW_AUTH_SHIPPING_REVIEWER, dockerExec: exec });

    const tasks = tasksForRun(runId);
    const primaryTask = tasks.find((t) => t.agentRole === "engineer" && t.parentId === undefined);
    assert.ok(primaryTask !== undefined, "primary engineer task must exist");
    assert.equal(primaryTask!.status, "blocked_by_red", "primary must be blocked_by_red before test");

    const HUMAN_RATIONALE = "Reviewed needs_human finding; ship approved by product owner.";
    await gate(primaryTask!.id, "advance", HUMAN_RATIONALE, { force: true });

    const gatesAfter = gatesForTask(primaryTask!.id);
    assert.equal(gatesAfter.length, 1, "exactly one gate row must be written");
    assert.equal(gatesAfter[0]!.rationale, HUMAN_RATIONALE, "gate row must carry the provided rationale");
    assert.equal(gatesAfter[0]!.decision, "advance", "gate row decision must be advance");

    const taskAfter = tasksForRun(runId).find((t) => t.id === primaryTask!.id);
    assert.ok(taskAfter !== undefined, "task must still exist");
    assert.ok(
      taskAfter!.status === "complete" || taskAfter!.status === "pending",
      `task must have advanced past blocked_by_red; got: ${taskAfter!.status}`,
    );
  },
);
