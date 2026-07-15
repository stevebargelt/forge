#!/usr/bin/env bash
# FG-524 / FG-525 reachability probe — does an implementer result with
# status:"complete", NO tests_run and NO waiver actually complete SILENTLY today,
# through the REAL dispatch paths?
#
# Reachability is the whole question: an unreachable gap is a doc bug, a reachable
# one is a trust hole. So nothing here is stubbed except `dockerExec` (the same
# injection point the repo's own fanout tests use -- see
# src/v2/fg519-fanout-mixed-phase.worktree.test.ts). runNext / dispatchFanoutStep /
# invoke / markTaskComplete / the store are all REAL, against a REAL sqlite DB.
#
# Three arms:
#   ARM 1 (control): the FG-523 evaluator, run directly on the offending result.
#                    It MUST say held -- proving the result is genuinely contraband.
#   ARM 2 (FG-524):  a fanout implementer CHILD returns that same result through
#                    the real dispatchFanoutStep. Does it land `complete`?
#   ARM 3 (FG-525):  `forge invoke` returns that same result through the real
#                    invoke path. Does it land `complete`?
#
# A gate that is real in ARM 1 and absent in ARMs 2/3 is the finding.
#
# Rerun: bash docs/plans/foundations-lane-b-probes/fg524-fg525-ungated-finalize.sh
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/fg524.XXXXXX")"
trap 'rm -rf "$SCRATCH"' EXIT
cd "$REPO"

echo "=== runtime identity ==="
echo "node : $(node --version)   ABI: $(node -p 'process.versions.modules')   $(node -p 'process.platform+" "+process.arch')"
echo "repo HEAD : $(git rev-parse HEAD)"
echo

cat > "$SCRATCH/probe.test.ts" <<'PROBE'
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { runNext, type DockerExecFn } from "/project/src/v2/runNext.js";
import { startRun } from "/project/src/v2/startRun.js";
import { invoke } from "/project/src/v2/invoke.js";
import { tasksForRun, getTask } from "/project/src/store/tasks.js";
import { evaluateValidationContract, WAIVER_FIELD } from "/project/src/v2/validation-contract.js";
import type { Workflow } from "/project/src/v2/schema.js";

// THE CONTRABAND RESULT: an implementer claiming success with no evidence of
// validation and no waiver. This is exactly what FG-523's gate exists to stop.
const CONTRABAND = { status: "complete", summary: "shipped it, trust me" };

function ensureRuntime(): void {
  const runtimePath = join(process.env.FORGE_HOME!, "runtimes", "claude.yml");
  if (existsSync(runtimePath)) return;
  mkdirSync(dirname(runtimePath), { recursive: true });
  writeFileSync(runtimePath, `name: claude
description: probe stub runtime
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

// The ONLY stub: dockerExec. Writes the agent's result.json, exactly as the
// repo's own fanout tests do. Everything downstream of this is real Forge.
function makeExec(routes: { prefix: string; result: unknown }[]): DockerExecFn {
  return async ({ args, stdoutPath, stderrPath }) => {
    const nameIdx = args.indexOf("--name");
    const taskId = (nameIdx >= 0 ? (args[nameIdx + 1] ?? "") : "").replace(/^forge-/, "");
    const dir = dirname(stdoutPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(stdoutPath, "stub");
    writeFileSync(stderrPath, "");
    const route = routes.find((r) => taskId.startsWith(r.prefix));
    writeFileSync(join(dir, "result.json"), JSON.stringify(route ? route.result : CONTRABAND));
    return 0;
  };
}

const FANOUT_WF: Workflow = {
  name: "fg524-probe",
  description: "fanout whose CHILDREN are implementers (engineer)",
  inputs: [],
  steps: [
    { id: "frame", agent: "research-framer", gate: "auto", manual: false, depends_on: [], runtime: "claude", reds: [] },
    {
      id: "build",
      agent: "engineer",                      // <-- an IMPLEMENTER_ROLE
      gate: "auto", manual: false, depends_on: ["frame"], runtime: "claude", reds: [],
      fanout: { from_upstream: { step: "frame", array_key: "lanes", input_key: "lane" }, max_concurrency: 2, failure_mode: "continue" },
    },
  ],
};

test("FG-524 / FG-525 — the tests_run gate is enforced on one finalize path and absent on the others", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  ensureRuntime();

  // ---------- ARM 1 (control): is the result actually contraband? ----------
  const verdict = evaluateValidationContract({ role: "engineer", result: CONTRABAND });
  console.log("\n=== ARM 1 (control) — the FG-523 evaluator, run directly ===");
  console.log("  result under test :", JSON.stringify(CONTRABAND));
  console.log("  waiver field      :", WAIVER_FIELD, "(absent)");
  console.log("  evaluator says    :", JSON.stringify(verdict));
  assert.equal(verdict.held, true, "control failed: the evaluator must consider this result contraband");
  console.log("  >>> CONFIRMED contraband. A PRIMARY carrying this result is HELD at awaiting_gate.");

  // ---------- ARM 2 (FG-524): the fanout CHILD ----------
  const { runId } = startRun({ workflow: FANOUT_WF, title: "fg524 probe", inputs: {}, projectDir: "/tmp/test-project" });
  const exec = makeExec([
    { prefix: "task-frame-", result: { status: "complete", lanes: ["lane-a", "lane-b"] } },
    // children fall through to CONTRABAND
  ]);

  await runNext({ runId, workflow: FANOUT_WF, dockerExec: exec });  // frame
  await runNext({ runId, workflow: FANOUT_WF, dockerExec: exec });  // fanout build

  const tasks = tasksForRun(runId);
  const parent = tasks.find((t) => t.phase === "build" && t.parentId === undefined);
  const children = tasks.filter((t) => t.phase === "build" && t.parentId === parent?.id);

  console.log("\n=== ARM 2 (FG-524) — fanout implementer CHILDREN, via the real dispatchFanoutStep ===");
  console.log("  children dispatched :", children.length);
  for (const c of children) {
    console.log(`    child ${c.id}`);
    console.log(`      agentRole : ${c.agentRole}`);
    console.log(`      result    : ${JSON.stringify(c.result)}`);
    console.log(`      STATUS    : ${c.status}   ${c.status === "complete" ? "<-- COMPLETED SILENTLY. No tests_run. No waiver. No hold." : ""}`);
  }
  console.log(`  fanout PARENT status : ${parent?.status}`);
  console.log(`  parent result        : ${JSON.stringify(parent?.result)}`);

  assert.ok(children.length > 0, "probe invalid: no children were dispatched — the gap would be unreachable");
  for (const c of children) {
    assert.equal(c.agentRole, "engineer", "child must carry an implementer role for the gate to be in scope");
    assert.equal(c.status, "complete", "FG-524 REACHABLE: the child completed with no tests_run and no waiver");
    assert.notEqual(c.status, "awaiting_gate", "if this ever fails, FG-524 has been fixed");
  }

  // ---------- ARM 3 (FG-525): forge invoke ----------
  const inv = await invoke({
    agentRole: "engineer",                     // <-- an IMPLEMENTER_ROLE
    task: "probe: ad-hoc implementer invoke returning no tests_run",
    projectDir: "/tmp/test-project",
    dockerExec: makeExec([]),                  // everything -> CONTRABAND
  });

  const invTask = getTask(inv.taskId);
  console.log("\n=== ARM 3 (FG-525) — `forge invoke` ad-hoc implementer, via the real invoke path ===");
  console.log(`  taskId    : ${invTask?.id}`);
  console.log(`  agentRole : ${invTask?.agentRole}`);
  console.log(`  result    : ${JSON.stringify(invTask?.result)}`);
  console.log(`  STATUS    : ${invTask?.status}   ${invTask?.status === "complete" ? "<-- COMPLETED SILENTLY. No tests_run. No waiver. No hold." : ""}`);
  assert.equal(invTask?.status, "complete", "FG-525 REACHABLE: the invoked implementer completed with no tests_run and no waiver");

  console.log("\n=== VERDICT ===");
  console.log("  Same role. Same result. Three finalize paths:");
  console.log("    PRIMARY        (runNext.ts:681 holdIfValidationContractFails) -> HELD      (gate enforced)");
  console.log("    FANOUT CHILD   (runNext.ts:2541 markTaskComplete)             -> COMPLETE  (gate absent)  FG-524");
  console.log("    INVOKE         (invoke.ts:813  markTaskComplete)              -> COMPLETE  (gate absent)  FG-525");
});
PROBE

echo "=== running the probe against a REAL sqlite store (only dockerExec is stubbed) ==="
node --import tsx --import "$REPO/src/test-setup.ts" --test "$SCRATCH/probe.test.ts" 2>&1
rc=$?
echo
if [ $rc -ne 0 ]; then
  echo "!!! PROBE FAILED (exit $rc) — read the assertion above before trusting any conclusion. !!!"
  exit $rc
fi
cat <<'EOF'
=== CONCLUSION ===
BOTH gaps are REACHABLE through the real dispatch paths. This is not a
documentation defect; it is a live trust hole.

The FG-523 evaluator is real and correct -- ARM 1 proves it holds the result. It
is simply NOT CALLED on two of the three finalize paths. The gate is enforced at
the CALLER (runNext.ts:681), not at the finalize primitive (markTaskComplete),
so every finalize site that does not happen to route through
holdIfValidationContractFails is silently ungated by construction.
EOF
