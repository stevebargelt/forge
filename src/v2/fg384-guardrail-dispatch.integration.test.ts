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
//   (fg384-3) regression: ship over pass doneAudit → mapper returns pass,
//       pipeline does NOT degrade it (no synthetic finding, not blocked)

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
import { runNext, mapShippingReviewerVerdict } from "./runNext.js";
import { validateVerdict } from "./validate-findings.js";
import { gradeFindings } from "./review-quality.js";
import type { DockerExecFn } from "./runNext.js";
import type { Workflow } from "./schema.js";
import type { DoneAuditResult } from "../types/index.js";

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

// ─── (fg384-3) regression: ship over pass doneAudit stays pass ───────────────

test(
  "(fg384-3) regression: ship over pass doneAudit stays pass through full pipeline (no synthetic, not blocked)",
  () => {
    // Drives the mapper output through the same validateVerdict + gradeFindings +
    // line-691 logic that the real ingestion path uses, with a passing doneAudit.
    // Proves the fix does not over-block legitimate ship verdicts.
    const passDoneAudit: DoneAuditResult = {
      outcome: "pass",
      checks: [{ name: "host_verification", status: "pass" }],
      gaps: [],
      requestedAction: null,
    };

    const mapped = mapShippingReviewerVerdict(
      { verdict: "ship", doneAuditDisposition: "ok", confidence: 0.9, findings: [] },
      passDoneAudit,
    );

    assert.equal(mapped.verdict, "pass", "mapper must return pass for ship over passing doneAudit");
    assert.equal(
      mapped.findings.length,
      0,
      "no synthetic findings when guardrail is not triggered (doneAudit.outcome=pass)",
    );

    const tmpDir = makeTmpDir();

    // Simulate the ingestion pipeline exactly as runNext does at lines 678–699.
    const { validated, dropped } = validateVerdict(mapped, tmpDir);
    assert.equal(dropped.length, 0, "no findings should be dropped (no citation to validate)");

    const { graded } = gradeFindings(validated.findings);
    const gradedFindings = graded.map((g) => g.finding);

    // line-691: fail with no graded findings → inconclusive (but verdict is pass, so no-op)
    let finalVerdict = validated.verdict;
    if (finalVerdict === "fail" && gradedFindings.length === 0) {
      finalVerdict = "inconclusive";
    }

    assert.equal(finalVerdict, "pass", "pipeline must not degrade pass to inconclusive");
    assert.equal(gradedFindings.length, 0, "no graded findings (expected: pass over passing audit has none)");
  },
);
