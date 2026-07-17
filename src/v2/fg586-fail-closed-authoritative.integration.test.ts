// FG-586 integration tests: fail-closed on unreadable AUTHORITATIVE reviewer output.
//
// Proves two things on the REAL dispatchReds/runOneRed ingestion path:
//
//   Part A (bounded envelope recovery): a real verdict wrapped in a single leading
//   diff/patch marker byte (`+{...}`) — or a Markdown code fence — survives the
//   parse and is honored. This is the exact incident fixture: a `+` byte in front
//   of `{ verdict: "fail", confidence: 0.98, findings: [...] }`. Before FG-586 the
//   `+` made JSON.parse throw, the verdict was lost, and the red silently became a
//   non-blocking inconclusive. After FG-586 the fail survives and BLOCKS.
//
//   Part B (fail-closed on unreadable authoritative output): a genuinely
//   internally-malformed result payload from an authoritative gate_on_verdict red
//   (a stray byte in the MIDDLE — which Part A deliberately does NOT recover) must
//   BLOCK the parent gate (blocked_by_red) with a named HIGH-severity "unreadable
//   reviewer output" finding — never advance as a bare inconclusive.
//
// The red under test is a NON-shipping-reviewer authoritative red (red-wide), the
// exact class the live incident (red-build b0c441) fell through.

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

// ─── Workflow fixture: a NON-shipping-reviewer authoritative red ───────────────

const WORKFLOW_AUTH_RED_WIDE: Workflow = {
  name: "fg586-dispatch-test",
  description: "FG-586 fail-closed authoritative red integration test",
  inputs: [],
  steps: [
    {
      id: "build",
      agent: "engineer",
      gate: "auto",
      manual: false,
      depends_on: [],
      runtime: "fg586-dispatch-test",
      reds: [{ agent: "red-wide", authority: "authoritative", gate_on_verdict: true }],
    },
  ],
};

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
  ensureRuntime("fg586-dispatch-test");
  ensureWorkflow("fg586-dispatch-test");
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

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "forge-fg586-"));
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
description: FG-586 dispatch test runtime stub
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

function ensureWorkflow(name: string): void {
  const forgeHome = process.env.FORGE_HOME!;
  const workflowPath = join(forgeHome, "workflows", `${name}.yml`);
  mkdirSync(dirname(workflowPath), { recursive: true });
  writeFileSync(
    workflowPath,
    `name: ${name}
description: FG-586 dispatch test workflow stub
inputs: []
steps:
  - id: build
    agent: engineer
    gate: auto
    manual: false
    depends_on: []
    runtime: ${name}
    reds:
      - agent: red-wide
        authority: authoritative
        gate_on_verdict: true
`,
  );
}

function taskIdFromDockerArgs(args: string[]): string {
  const nameIdx = args.indexOf("--name");
  const containerName = nameIdx >= 0 ? (args[nameIdx + 1] ?? "") : "";
  return containerName.replace(/^forge-/, "");
}

function writeStructuredTicket(projectDir: string, opts: { id: string; title: string; body: string }): void {
  const storiesDir = join(projectDir, "backlog", "stories");
  mkdirSync(storiesDir, { recursive: true });
  const slug = opts.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
  const lines = ["---", `id: ${opts.id}`, "type: story", "status: active", `title: ${opts.title}`, "---", ""];
  writeFileSync(join(storiesDir, `${opts.id}-${slug}.md`), lines.join("\n") + opts.body);
}

// The exact incident fixture: a real fail:0.98 verdict prefixed with a single `+`
// diff/patch marker byte. `findings` cites the primary result so it survives the
// #147 citation validation (which the incident's real red-build verdict also had).
const INCIDENT_FAIL_JSON = JSON.stringify({
  verdict: "fail",
  confidence: 0.98,
  findings: [
    {
      severity: "high",
      summary: "authoritative red found a real defect",
      evidence: "the primary result asserts status complete but the invariant is violated",
      hypothesis: "the change must be fixed before it can ship",
    },
  ],
});

// Drives the run with a dockerExec that writes `rawResult` verbatim into the
// red's result.json. Returns the completed wave + tasks/verdicts for assertions.
async function runWithRedResult(rawResult: string, ticketId: string) {
  const projectDir = makeTmpDir();
  writeStructuredTicket(projectDir, {
    id: ticketId,
    title: `FG-586 ${ticketId}`,
    body: "## Acceptance Criteria\n\n- Fail closed on unreadable authoritative output\n\n",
  });

  const { runId } = startRun({
    workflow: WORKFLOW_AUTH_RED_WIDE,
    title: `fg586 ${ticketId}`,
    inputs: { ticketId },
    projectDir,
  });

  const exec: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
    const taskId = taskIdFromDockerArgs(args);
    const dir = dirname(stdoutPath);
    mkdirSync(dir, { recursive: true });
    if (taskId.startsWith("task-build-")) {
      writeFileSync(
        join(dir, "result.json"),
        JSON.stringify({ status: "complete", tests_run: 1, files_modified: [], commitSha: "deadbeef" }),
      );
    } else {
      // The red container: write the raw (possibly wrapped/malformed) payload verbatim.
      writeFileSync(join(dir, "result.json"), rawResult);
    }
    writeFileSync(stdoutPath, "");
    writeFileSync(stderrPath, "");
    return 0;
  };

  const wave = await runNext({ runId, workflow: WORKFLOW_AUTH_RED_WIDE, dockerExec: exec });
  return { runId, wave };
}

// ─── (fg586-A1) leading-`+` envelope: the real fail:0.98 verdict SURVIVES and blocks

test(
  "(fg586-A1) leading `+` diff-marker before a valid fail:0.98 JSON — verdict survives the bounded strip and BLOCKS",
  async () => {
    const { runId, wave } = await runWithRedResult(`+${INCIDENT_FAIL_JSON}`, "FG-T586-A1");

    assert.ok(!wave.completedSteps.includes("build"), "build must NOT complete — the recovered fail must block the gate");

    const primaryTask = tasksForRun(runId).find((t) => t.agentRole === "engineer" && t.parentId === undefined);
    assert.ok(primaryTask !== undefined, "primary engineer task must exist");
    assert.equal(
      primaryTask!.status,
      "blocked_by_red",
      "primary must be blocked_by_red — the fail:0.98 verdict survived the leading-`+` envelope strip",
    );

    const reviewerVerdict = verdictsForRun(runId).find((v) => v.redRole === "red-wide");
    assert.ok(reviewerVerdict !== undefined, "red-wide verdict must be recorded");
    assert.equal(reviewerVerdict!.verdict, "fail", "recovered verdict must be the real fail (NOT lost to inconclusive)");
    assert.equal(reviewerVerdict!.confidence, 0.98, "recovered confidence must be the real 0.98");
    assert.ok(reviewerVerdict!.findings.length >= 1, "the real finding must survive");
  },
);

// ─── (fg586-A2) Markdown code fence envelope: verdict survives ────────────────

test(
  "(fg586-A2) ```json fenced valid fail JSON — verdict survives the bounded fence strip and BLOCKS",
  async () => {
    const fenced = "```json\n" + INCIDENT_FAIL_JSON + "\n```";
    const { runId, wave } = await runWithRedResult(fenced, "FG-T586-A2");

    assert.ok(!wave.completedSteps.includes("build"), "build must NOT complete — fenced fail must block");
    const primaryTask = tasksForRun(runId).find((t) => t.agentRole === "engineer" && t.parentId === undefined);
    assert.equal(primaryTask!.status, "blocked_by_red", "primary must be blocked_by_red — fenced verdict survived");
    const reviewerVerdict = verdictsForRun(runId).find((v) => v.redRole === "red-wide");
    assert.equal(reviewerVerdict!.verdict, "fail", "recovered verdict must be the real fail");
  },
);

// ─── (fg586-B1) internal bad byte: unreadable authoritative result FAILS CLOSED ─

test(
  "(fg586-B1) internally-malformed authoritative result (mid-document bad byte) BLOCKS with an 'unreadable reviewer output' finding",
  async () => {
    // A stray byte in the MIDDLE — Part A deliberately does NOT recover this. The
    // authoritative gate_on_verdict red must fail CLOSED, not advance.
    const internallyMalformed = '{ "verdict": "fail", "confidence": 0.9, XX "findings": [] }';
    const { runId, wave } = await runWithRedResult(internallyMalformed, "FG-T586-B1");

    assert.ok(
      !wave.completedSteps.includes("build"),
      "build must NOT complete — an unreadable authoritative result must fail closed, never advance",
    );

    const primaryTask = tasksForRun(runId).find((t) => t.agentRole === "engineer" && t.parentId === undefined);
    assert.ok(primaryTask !== undefined, "primary engineer task must exist");
    assert.equal(
      primaryTask!.status,
      "blocked_by_red",
      "primary must be blocked_by_red — unreadable authoritative output is a fail-closed block",
    );

    const reviewerVerdict = verdictsForRun(runId).find((v) => v.redRole === "red-wide");
    assert.ok(reviewerVerdict !== undefined, "red-wide verdict must be recorded even when the result was unreadable");
    assert.ok(reviewerVerdict!.findings.length >= 1, "the synthetic unreadable-output finding must be persisted");
    const synth = reviewerVerdict!.findings[0]!;
    assert.equal(synth.severity, "high", "the unreadable-output finding must be HIGH severity");
    assert.ok(
      synth.summary.includes("UNREADABLE"),
      `finding summary must name the unreadable-output block; got: ${synth.summary}`,
    );
    assert.ok(
      synth.hypothesis.includes("forge gate --force --rationale"),
      `finding must point the operator at the explicit override; got: ${synth.hypothesis}`,
    );
  },
);

// ─── (fg586-B2) unrecoverable envelope (interior break inside a fence) fails closed

test(
  "(fg586-B2) fenced block whose body is itself malformed still fails closed (bounded strip does not salvage interior)",
  async () => {
    const fencedButBroken = "```json\n{ \"verdict\": \"fail\", oops }\n```";
    const { runId, wave } = await runWithRedResult(fencedButBroken, "FG-T586-B2");

    assert.ok(!wave.completedSteps.includes("build"), "build must NOT complete — a broken fenced body is still unreadable");
    const primaryTask = tasksForRun(runId).find((t) => t.agentRole === "engineer" && t.parentId === undefined);
    assert.equal(
      primaryTask!.status,
      "blocked_by_red",
      "primary must be blocked_by_red — the bounded strip must not salvage a mid-body break",
    );
  },
);
