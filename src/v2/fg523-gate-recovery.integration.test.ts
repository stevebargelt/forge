// FG-523 (F19) — the recovery half: a held task must always have an enabled
// transition. Over-holding is only acceptable because it is recoverable, so the
// escape hatches are load-bearing and get their own coverage.
//
// Covered here (the engineer's fg523-validation-contract.integration.test.ts
// drives the plain --advance case; none of the below is in it):
//   - `forge gate --reject` on a held task follows the NORMAL reject path:
//     failed + the on_reject recovery task seeded, exactly as a rejected
//     ordinary gate would be. A validation hold is not a special terminal state.
//   - the no-wedge invariant: re-running `forge next` over a held task neither
//     wedges nor silently advances it — it stays held, awaiting the human, and
//     the run reports it as awaiting-gate rather than stalling with no
//     enabled transition.
//   - the operator SURFACE, both renderings of the same held task: the human
//     `gate hold:` line (house rule: human first) and --json
//     diagnostic.gateHold. Plus the negative: an ordinary human gate carries no
//     hold reason in either rendering, so `gate hold:` means what it says.

import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { Command } from "commander";
import { runNext, type DockerExecFn } from "./runNext.js";
import { startRun } from "./startRun.js";
import { gate } from "./gate.js";
import { isRunSettled } from "./ready-queue.js";
import { tasksForRun, getTask } from "../store/tasks.js";
import { registerShow } from "../cli/commands/show.js";
import type { Workflow } from "./schema.js";
import { publishFlatAsGeneration } from "./seed-generation.testkit.js";

function ensureRuntime(): void {
  const runtimePath = join(process.env.FORGE_HOME!, "runtimes", "claude.yml");
  if (existsSync(runtimePath)) return;
  mkdirSync(dirname(runtimePath), { recursive: true });
  writeFileSync(runtimePath, `name: claude
description: test stub runtime
image: test-image:latest
models:
  default: test-model
auth:
  mode: apikey
mounts:
  - { host: "\${TASK_DIR}", container: /task }
invocation:
  command: echo
  args: ["stub"]
container:
  name: "forge-\${TASK_ID}"
result:
  file: /task/result.json
`);
}

function stubExec(result: unknown): DockerExecFn {
  return async ({ stdoutPath, stderrPath }) => {
    const dir = dirname(stdoutPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "result.json"), JSON.stringify(result));
    writeFileSync(stdoutPath, "stub stdout");
    writeFileSync(stderrPath, "");
    return 0;
  };
}

type StepSpec = {
  id: string;
  agent: string;
  gate: Workflow["steps"][number]["gate"];
  depends_on?: string[];
  on_reject?: string;
};

function workflow(name: string, specs: StepSpec[]): Workflow {
  return {
    name,
    description: "FG-523 gate recovery",
    inputs: [],
    steps: specs.map((s) => ({
      id: s.id,
      agent: s.agent,
      gate: s.gate,
      manual: false,
      depends_on: s.depends_on ?? [],
      runtime: "claude",
      reds: [],
      ...(s.on_reject ? { on_reject: s.on_reject } : {}),
    })) as Workflow["steps"],
  };
}

// gate() re-loads the workflow from disk by name, so the YAML must mirror the
// in-memory Workflow the runner was driven with — including on_reject.
function ensureWorkflowYaml(wf: Workflow): void {
  const dir = join(process.env.FORGE_HOME!, "workflows");
  mkdirSync(dir, { recursive: true });
  const steps = wf.steps
    .map((s) => {
      const onReject = (s as { on_reject?: string }).on_reject;
      return (
        `  - id: ${s.id}\n    agent: ${s.agent}\n    gate: ${s.gate}\n` +
        `    depends_on: [${s.depends_on.join(", ")}]` +
        (onReject ? `\n    on_reject: ${onReject}` : "")
      );
    })
    .join("\n");
  writeFileSync(
    join(dir, `${wf.name}.yml`),
    `name: ${wf.name}\ndescription: ${wf.description}\ninputs: []\nsteps:\n${steps}\n`,
  );
  publishFlatAsGeneration(process.env.FORGE_HOME!);
}

async function startHeld(
  name: string,
  specs: StepSpec[],
  result: unknown = { status: "complete" },
  waves = 1,
) {
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  ensureRuntime();
  const wf = workflow(name, specs);
  ensureWorkflowYaml(wf);
  const { runId } = startRun({ workflow: wf, title: name, inputs: {}, projectDir: "/tmp/test-project" });
  // One wave per call: a `build` step behind an upstream dependency needs the
  // upstream wave to land first.
  for (let i = 0; i < waves; i++) {
    await runNext({ runId, workflow: wf, dockerExec: stubExec(result) });
  }
  return { runId, wf, build: tasksForRun(runId).find((t) => t.phase === "build")! };
}

function captureConsoleLog(): string[] {
  const lines: string[] = [];
  mock.method(console, "log", (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  return lines;
}

async function showTask(taskId: string, json = false): Promise<string> {
  const lines = captureConsoleLog();
  try {
    const program = new Command();
    registerShow(program);
    const argv = json ? ["show", taskId, "--json"] : ["show", taskId];
    await program.parseAsync(argv, { from: "user" });
    return lines.join("\n");
  } finally {
    mock.restoreAll();
  }
}

const BUILD_AFTER: StepSpec[] = [
  { id: "build", agent: "engineer", gate: "auto" },
  { id: "after", agent: "docs-agent", gate: "auto", depends_on: ["build"] },
];

test("FG-523 F19 recovery: `forge gate --reject` on a held task takes the NORMAL reject path — failed, downstream never runs", async () => {
  const { runId, wf, build } = await startHeld("fg523-recover-reject", BUILD_AFTER);
  assert.equal(build.status, "awaiting_gate");

  const result = await gate(build.id, "reject", "no evidence the change was ever exercised", {});
  assert.equal(result.task.status, "failed", "a rejected hold fails the task like any other rejected gate");
  assert.equal(getTask(build.id)!.error, "no evidence the change was ever exercised");

  const wave = await runNext({ runId, workflow: wf, dockerExec: stubExec({ status: "complete" }) });
  assert.deepEqual(wave.completedSteps, [], "a rejected step releases nothing downstream");
  assert.equal(tasksForRun(runId).find((t) => t.phase === "after"), undefined);
});

test("FG-523 F19 recovery: reject with on_reject seeds the recovery step — a held task re-enters the workflow, it is not a dead end", async () => {
  // The real on_reject shape (seeds/workflows/security-audit.yml): the target is
  // the UPSTREAM step, so a reject sends the work back rather than aborting the
  // run. `scope` is a non-implementer step so the shared stub result doesn't
  // hold it too — only `build` is subject to the contract.
  const { runId, build } = await startHeld(
    "fg523-recover-onreject",
    [
      { id: "scope", agent: "docs-agent", gate: "auto" },
      { id: "build", agent: "engineer", gate: "auto", depends_on: ["scope"], on_reject: "scope" },
    ],
    { status: "complete" },
    2,
  );
  assert.equal(build.status, "awaiting_gate", "the implementer step is held; the upstream step is not");

  const rationale = "tests_run was never produced — re-do with real validation";
  await gate(build.id, "reject", rationale, {});
  assert.equal(getTask(build.id)!.status, "failed");

  const recovery = tasksForRun(runId).find((t) => t.phase === "scope" && t.status === "pending");
  assert.ok(recovery, "on_reject recovery task seeded from a validation hold, same as any reject");
  assert.equal(
    recovery!.taskPackage.inputs["rejectedRationale"],
    rationale,
    "the recovery task carries WHY it was rejected — the hold reason reaches the agent that must fix it",
  );
  assert.equal(recovery!.taskPackage.inputs["rejectedTaskId"], build.id);
});

test("FG-523 F19 no-wedge: re-running the runner over a held task neither advances it nor stalls the run", async () => {
  const { runId, wf, build } = await startHeld("fg523-no-wedge", BUILD_AFTER);
  assert.equal(build.status, "awaiting_gate");

  // The wedge failure mode: a status with no enabled transition. `forge next`
  // over a held run must be a clean no-op — and the run must stay ACTIVE
  // (unsettled), i.e. still owed a human decision rather than quietly finished.
  // (awaitingGate on the wave lists what THIS wave parked, so it is empty on a
  // no-op pass — the live state lives on the task and the settle check.)
  const wave = await runNext({ runId, workflow: wf, dockerExec: stubExec({ status: "complete" }) });
  assert.deepEqual(wave.completedSteps, [], "the runner must not silently complete a held task on a second pass");
  assert.deepEqual(wave.failedSteps, [], "nor fail it");
  assert.equal(getTask(build.id)!.status, "awaiting_gate");
  assert.equal(
    isRunSettled(wf, tasksForRun(runId)),
    false,
    "the run is parked on the human, not settled — a settled run with an undecided gate IS the wedge",
  );

  // And the transition is genuinely enabled — the human verb still works after
  // the extra runner pass, and the run then drains to completion.
  await gate(build.id, "advance", "verified by hand", {});
  assert.equal(getTask(build.id)!.status, "complete");
  const w2 = await runNext({ runId, workflow: wf, dockerExec: stubExec({ status: "complete" }) });
  assert.deepEqual(w2.completedSteps, ["after"], "the run drains once the gate is decided");
});

test("FG-523 F19 surface: a held task renders `gate hold: <reason>` in human output AND diagnostic.gateHold in --json", async () => {
  const { build } = await startHeld("fg523-surface", BUILD_AFTER, { status: "complete", tests_run: "many" });
  assert.equal(build.status, "awaiting_gate");

  // Human first (house rule) — the operator reads this, not the JSON.
  const human = await showTask(build.id);
  assert.match(human, /^\s*gate hold: validation contract: engineer returned status=complete with tests_run="many"/m);
  assert.match(human, /and no no_validation_reason waiver — held for a gate decision/);

  // Same fact, machine-readable, same reason string.
  const parsed = JSON.parse(await showTask(build.id, true)) as {
    task: { status: string };
    diagnostic: { gateHold: string | null };
  };
  assert.equal(parsed.task.status, "awaiting_gate");
  assert.ok(parsed.diagnostic.gateHold, "--json must carry diagnostic.gateHold for a held task");
  assert.match(parsed.diagnostic.gateHold!, /^validation contract: engineer returned status=complete with tests_run="many"/);
  assert.ok(
    human.includes(parsed.diagnostic.gateHold!),
    "the two renderings must not drift — the JSON reason is the string the human line prints",
  );
});

test("FG-523 F19 surface: an ORDINARY human gate carries no hold reason in either rendering", async () => {
  // A human-gated step with a contract-satisfying result parks at awaiting_gate
  // for the normal reason. `gate hold:` must not fire here, or it means nothing.
  const { build } = await startHeld(
    "fg523-surface-ordinary",
    [{ id: "build", agent: "engineer", gate: "human" }],
    { status: "complete", tests_run: 9, tests_passed: 9 },
  );
  assert.equal(build.status, "awaiting_gate", "parked at an ordinary human gate");

  const human = await showTask(build.id);
  assert.doesNotMatch(human, /gate hold:/, "no validation hold — the line must not appear");

  const parsed = JSON.parse(await showTask(build.id, true)) as { diagnostic: { gateHold: string | null } };
  assert.equal(parsed.diagnostic.gateHold, null);
});
