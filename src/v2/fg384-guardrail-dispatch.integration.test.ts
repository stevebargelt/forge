// FG-384 dispatch-path integration tests for the Shipping Reviewer guardrail.
//
// The pure mapper unit tests in shipping-reviewer-verdict.test.ts already cover
// mapShippingReviewerVerdict in isolation. These tests prove the GUARDRAIL
// SURVIVES the full dispatch path: mapper → validateVerdict → gradeFindings →
// line-691 "fail with no findings → inconclusive" downgrade.
//
// The bug (confirmed pre-fix): mapShippingReviewerVerdict correctly mapped bad
// states to `fail`, but the returned `fail` carried EMPTY findings (the reviewer's
// own findings for a "ship" verdict). Line-691 then downgraded every
// unsubstantiated `fail` to `inconclusive`, and only `fail` blocks an authoritative
// red — so the guardrail was neutralized.
//
// The fix: synthetic findings are now prepended in each contract-fail branch so
// the `fail` is substantiated and survives line-691.
//
// Covers:
//   (fg384-1) ship over fail doneAudit + authoritative reviewer → recorded fail,
//       primary blocked_by_red (NOT inconclusive / not complete)
//   (fg384-2) invalid ship_with_named_deferrals (missing followUpTicketId) →
//       recorded fail, primary blocked_by_red
//   (fg384-3) regression: valid ship with accepted_exception disposition → mapper
//       returns pass, real pipeline does NOT block (primary completes, not blocked_by_red)
//   (fg384-4) needs_fix with zero findings → synthetic anchor survives pipeline →
//       recorded fail, primary blocked_by_red
//   (fg384-5) needs_fix with all-malformed findings (no summary) → synthetic anchor
//       survives gradeFindings even though reviewer findings are graded away →
//       recorded fail, primary blocked_by_red (key regression for unconditional synthetic)

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
import type { DockerExecFn } from "./runNext.js";
import type { Workflow } from "./schema.js";

// ─── Workflow fixture ─────────────────────────────────────────────────────────

// Authoritative shipping-reviewer with gate_on_verdict:true — a fail verdict
// from this red blocks the primary task.
const WORKFLOW_AUTH_SHIPPING_REVIEWER: Workflow = {
  name: "fg381-dispatch-test",
  description: "FG-384 guardrail dispatch integration test",
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
  const dir = mkdtempSync(join(tmpdir(), "forge-fg384-"));
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
description: FG-384 dispatch test runtime stub
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

// ─── (fg384-1) ship over fail doneAudit → synth finding survives, blocks ─────

test(
  "(fg384-1) ship over fail doneAudit: guardrail synth finding survives pipeline → recorded fail, primary blocked",
  async () => {
    // An "active" ticket produces doneAudit.outcome="fail" (ticket_closed:fail).
    // The shipping-reviewer returns ship + doneAuditDisposition:"ok" with no
    // exception/deferral disposition — the guardrail backstop must fire, produce
    // a synthetic finding, and survive validateVerdict+gradeFindings so the fail
    // is NOT downgraded to inconclusive by line-691.
    const projectDir = makeTmpDir();
    writeStructuredTicket(projectDir, {
      id: "FG-T384-1",
      title: "FG-384 guardrail test 1",
      body: "## Acceptance Criteria\n\n- Ship it\n\n",
    });

    const { runId } = startRun({
      workflow: WORKFLOW_AUTH_SHIPPING_REVIEWER,
      title: "fg384-1 guardrail dispatch test",
      inputs: { ticketId: "FG-T384-1" },
      projectDir,
    });

    const exec: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
      const taskId = taskIdFromDockerArgs(args);
      const dir = dirname(stdoutPath);
      mkdirSync(dir, { recursive: true });

      let result: unknown;
      if (taskId.startsWith("task-build-")) {
        result = { status: "complete", files_modified: [], commitSha: "deadbeef" };
      } else {
        // shipping-reviewer returns ship over an active (unresolved) done-audit
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

    // Guardrail must fire — build step must NOT complete.
    assert.ok(
      !wave.completedSteps.includes("build"),
      "build step must NOT be in completedSteps when guardrail blocks",
    );

    const tasks = tasksForRun(runId);
    const primaryTask = tasks.find((t) => t.agentRole === "engineer" && t.parentId === undefined);
    assert.ok(primaryTask !== undefined, "primary engineer task must exist");
    assert.equal(
      primaryTask!.status,
      "blocked_by_red",
      "primary must be blocked_by_red — guardrail fired and synthetic finding survived the pipeline (NOT inconclusive via line-691)",
    );

    // The recorded verdict must be "fail" — proves the synthetic finding survived
    // validateVerdict+gradeFindings and was NOT downgraded by line-691.
    const verdicts = verdictsForRun(runId);
    const reviewerVerdict = verdicts.find((v) => v.redRole === "shipping-reviewer");
    assert.ok(reviewerVerdict !== undefined, "shipping-reviewer verdict must be recorded");
    assert.equal(
      reviewerVerdict!.verdict,
      "fail",
      "recorded verdict must be fail — NOT inconclusive (synthetic finding carried the fail through line-691)",
    );
    assert.ok(
      reviewerVerdict!.findings.length >= 1,
      "recorded verdict must carry >= 1 finding (the synthetic guardrail finding)",
    );
    // The synthetic finding summary must name the done-audit outcome.
    const synthSummary = reviewerVerdict!.findings[0]!.summary;
    assert.ok(
      synthSummary.includes("done-audit") || synthSummary.includes("ship over"),
      `synthetic finding summary must describe the guardrail failure; got: ${synthSummary}`,
    );
  },
);

// ─── (fg384-2) invalid ship_with_named_deferrals → synth finding, blocks ──────

test(
  "(fg384-2) invalid ship_with_named_deferrals (missing followUpTicketId): synth finding survives pipeline → recorded fail, primary blocked",
  async () => {
    const projectDir = makeTmpDir();
    writeStructuredTicket(projectDir, {
      id: "FG-T384-2",
      title: "FG-384 guardrail test 2",
      body: "## Acceptance Criteria\n\n- Ship it\n\n",
    });

    const { runId } = startRun({
      workflow: WORKFLOW_AUTH_SHIPPING_REVIEWER,
      title: "fg384-2 invalid deferrals dispatch test",
      inputs: { ticketId: "FG-T384-2" },
      projectDir,
    });

    const exec: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
      const taskId = taskIdFromDockerArgs(args);
      const dir = dirname(stdoutPath);
      mkdirSync(dir, { recursive: true });

      let result: unknown;
      if (taskId.startsWith("task-build-")) {
        result = { status: "complete", files_modified: [], commitSha: "deadbeef" };
      } else {
        // deferral is missing followUpTicketId — invalid
        result = {
          status: "complete",
          verdict: "ship_with_named_deferrals",
          named_deferrals: [{ description: "Defer host verify" }],
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
      !wave.completedSteps.includes("build"),
      "build step must NOT complete when deferrals are invalid",
    );

    const tasks = tasksForRun(runId);
    const primaryTask = tasks.find((t) => t.agentRole === "engineer" && t.parentId === undefined);
    assert.ok(primaryTask !== undefined, "primary engineer task must exist");
    assert.equal(
      primaryTask!.status,
      "blocked_by_red",
      "primary must be blocked_by_red — invalid deferrals must block, not degrade to inconclusive",
    );

    const verdicts = verdictsForRun(runId);
    const reviewerVerdict = verdicts.find((v) => v.redRole === "shipping-reviewer");
    assert.ok(reviewerVerdict !== undefined, "shipping-reviewer verdict must be recorded");
    assert.equal(
      reviewerVerdict!.verdict,
      "fail",
      "recorded verdict must be fail for invalid ship_with_named_deferrals",
    );
    assert.ok(
      reviewerVerdict!.findings.length >= 1,
      "recorded verdict must carry >= 1 synthetic finding",
    );
    const synthSummary = reviewerVerdict!.findings[0]!.summary;
    assert.ok(
      synthSummary.includes("ship_with_named_deferrals") || synthSummary.includes("deferral"),
      `synthetic finding must describe the invalid-deferral failure; got: ${synthSummary}`,
    );
  },
);

// ─── (fg384-3) regression: valid ship with accepted_exception stays pass ──────

test(
  "(fg384-3) regression: ship with accepted_exception disposition passes through real pipeline (not blocked, primary completes)",
  async () => {
    // Drives a legitimate ship verdict through the REAL dispatchReds/runNext path.
    // The reviewer acknowledges the audit via accepted_exception, so the guardrail
    // backstop condition (isExcepted=true) suppresses the downgrade.
    // Proves the needs_fix synthetic fix does NOT over-block legitimate ship verdicts.
    const projectDir = makeTmpDir();
    writeStructuredTicket(projectDir, {
      id: "FG-T384-3",
      title: "FG-384 guardrail test 3",
      body: "## Acceptance Criteria\n\n- Ship it\n\n",
    });

    const { runId } = startRun({
      workflow: WORKFLOW_AUTH_SHIPPING_REVIEWER,
      title: "fg384-3 valid ship regression test",
      inputs: { ticketId: "FG-T384-3" },
      projectDir,
    });

    const exec: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
      const taskId = taskIdFromDockerArgs(args);
      const dir = dirname(stdoutPath);
      mkdirSync(dir, { recursive: true });

      let result: unknown;
      if (taskId.startsWith("task-build-")) {
        result = { status: "complete", files_modified: [], commitSha: "deadbeef" };
      } else {
        // shipping-reviewer ships with an accepted exception — guardrail sees
        // accepted_exception disposition so isExcepted=true and ship stays pass.
        result = {
          status: "complete",
          verdict: "ship",
          doneAuditDisposition: "accepted_exception:testing",
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

    // Valid ship must NOT be blocked — primary must complete.
    assert.ok(
      wave.completedSteps.includes("build"),
      "build step must be in completedSteps — valid ship must not be blocked",
    );

    const tasks = tasksForRun(runId);
    const primaryTask = tasks.find((t) => t.agentRole === "engineer" && t.parentId === undefined);
    assert.ok(primaryTask !== undefined, "primary engineer task must exist");
    assert.equal(
      primaryTask!.status,
      "complete",
      "primary must be complete — valid ship with accepted_exception must not be blocked_by_red",
    );

    const verdicts = verdictsForRun(runId);
    const reviewerVerdict = verdicts.find((v) => v.redRole === "shipping-reviewer");
    assert.ok(reviewerVerdict !== undefined, "shipping-reviewer verdict must be recorded");
    assert.equal(
      reviewerVerdict!.verdict,
      "pass",
      "recorded verdict must be pass — ship with accepted_exception stays pass through full pipeline",
    );
    assert.equal(
      reviewerVerdict!.findings.length,
      0,
      "no findings on a valid ship (no synthetic should be added for a passing verdict)",
    );
  },
);

// ─── (fg384-4) needs_fix with zero findings → synthetic anchor survives ───────

test(
  "(fg384-4) needs_fix with zero findings: synthetic anchor survives pipeline → recorded fail, primary blocked",
  async () => {
    const projectDir = makeTmpDir();
    writeStructuredTicket(projectDir, {
      id: "FG-T384-4",
      title: "FG-384 guardrail test 4",
      body: "## Acceptance Criteria\n\n- Ship it\n\n",
    });

    const { runId } = startRun({
      workflow: WORKFLOW_AUTH_SHIPPING_REVIEWER,
      title: "fg384-4 needs_fix zero findings test",
      inputs: { ticketId: "FG-T384-4" },
      projectDir,
    });

    const exec: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
      const taskId = taskIdFromDockerArgs(args);
      const dir = dirname(stdoutPath);
      mkdirSync(dir, { recursive: true });

      let result: unknown;
      if (taskId.startsWith("task-build-")) {
        result = { status: "complete", files_modified: [], commitSha: "deadbeef" };
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
    assert.equal(
      reviewerVerdict!.findings[0]!.summary,
      "shipping-reviewer returned needs_fix",
      "synthetic anchor summary must match",
    );
  },
);

// ─── (fg384-5) needs_fix with all-malformed findings → synthetic anchor survives

test(
  "(fg384-5) needs_fix with all-malformed findings: synthetic anchor survives gradeFindings → recorded fail, primary blocked",
  async () => {
    // Key regression: needs_fix result where the reviewer's own findings are ALL
    // malformed (missing summary — gradeFindings rejects them). Without the
    // unconditional synthetic, gradedFindings.length === 0 → line-691 downgrades
    // fail to inconclusive → primary NOT blocked. With the unconditional synthetic,
    // the well-formed synthetic survives grading, fail stays fail, primary blocks.
    const projectDir = makeTmpDir();
    writeStructuredTicket(projectDir, {
      id: "FG-T384-5",
      title: "FG-384 guardrail test 5",
      body: "## Acceptance Criteria\n\n- Ship it\n\n",
    });

    const { runId } = startRun({
      workflow: WORKFLOW_AUTH_SHIPPING_REVIEWER,
      title: "fg384-5 needs_fix malformed findings test",
      inputs: { ticketId: "FG-T384-5" },
      projectDir,
    });

    const exec: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
      const taskId = taskIdFromDockerArgs(args);
      const dir = dirname(stdoutPath);
      mkdirSync(dir, { recursive: true });

      let result: unknown;
      if (taskId.startsWith("task-build-")) {
        result = { status: "complete", files_modified: [], commitSha: "deadbeef" };
      } else {
        // All reviewer findings are malformed: severity present but summary absent.
        // gradeFindings will reject every one of them. The unconditional synthetic
        // must still survive so the fail blocks rather than degrading to inconclusive.
        result = {
          status: "complete",
          verdict: "needs_fix",
          confidence: 0.9,
          findings: [
            { severity: "high" },
            { severity: "medium" },
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
      workflow: WORKFLOW_AUTH_SHIPPING_REVIEWER,
      dockerExec: exec,
    });

    assert.ok(
      !wave.completedSteps.includes("build"),
      "build step must NOT complete — needs_fix with all-malformed findings must still block",
    );

    const tasks = tasksForRun(runId);
    const primaryTask = tasks.find((t) => t.agentRole === "engineer" && t.parentId === undefined);
    assert.ok(primaryTask !== undefined, "primary engineer task must exist");
    assert.equal(
      primaryTask!.status,
      "blocked_by_red",
      "primary must be blocked_by_red — unconditional synthetic survived grading even though reviewer findings were rejected",
    );

    const verdicts = verdictsForRun(runId);
    const reviewerVerdict = verdicts.find((v) => v.redRole === "shipping-reviewer");
    assert.ok(reviewerVerdict !== undefined, "shipping-reviewer verdict must be recorded");
    assert.equal(
      reviewerVerdict!.verdict,
      "fail",
      "recorded verdict must be fail — NOT inconclusive (unconditional synthetic prevented line-691 downgrade)",
    );
    assert.ok(
      reviewerVerdict!.findings.length >= 1,
      "recorded verdict must carry >= 1 finding — the synthetic anchor must survive even when all reviewer findings are graded away",
    );
    assert.equal(
      reviewerVerdict!.findings[0]!.summary,
      "shipping-reviewer returned needs_fix",
      "surviving finding must be the unconditional synthetic anchor",
    );
  },
);
