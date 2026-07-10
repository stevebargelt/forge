import type { Run, Task } from "../types/index.js";
import { loadWorkflow } from "./loader.js";

// FG-486: the one definition of "this run's tasks go through the host-side
// pipeline finalize (worktree merge → integration gate → reds → gates)".
//
// `invoke` (forge invoke, single-invoke campaign lanes) and `invoke_chain`
// (campaign quick lanes chaining plain invokes on one run, executor.ts) both
// dispatch through v2/invoke.ts, which has no finalize sequence at all — a
// usable result IS the end of the task's lifecycle, so container-gone
// recovery may complete such a task and `forge recover --continue` may adopt
// it. Every other workflow is a pipeline driven by runNext.ts, where a task
// stays `running` through merge → integration gate → reds → gates and a
// result alone proves nothing.
//
// TASK-level only. Run-level completion is a different question: reconcile
// may complete an idle `invoke` run (single step, unambiguous), but never an
// `invoke_chain` run — whether the chain has another invoke coming is known
// only to the campaign executor (see reconcile.ts's run-level guard).
const NO_PIPELINE_FINALIZE_WORKFLOWS = new Set(["invoke", "invoke_chain"]);

export function taskHasPipelineFinalize(run: Run): boolean {
  return !NO_PIPELINE_FINALIZE_WORKFLOWS.has(run.workflow);
}

// FG-507: is this task ad-hoc — dispatched by `forge invoke`, not by the
// workflow runner? Ad-hoc tasks are invisible to the ready queue (computeReadyQueue
// walks workflow steps), so a pending ad-hoc row strands forever waiting for a
// `forge next` that will never see it.
//
// Two ad-hoc shapes, both covered:
//   (a) a synthetic single-task invoke run (run.workflow === "invoke", or an
//       "invoke_chain" run from a campaign quick lane) — no workflow YAML exists,
//       so the answer is decisive without a load attempt;
//   (b) `forge invoke --run <real-workflow-run>`, which attaches a phase="task"
//       row to a run whose workflow has no such step.
//
// Keyed on the workflow's actual step ids, never on phase === "task" alone — a
// real workflow may legitimately declare a step called "task".
//
// The third state is the point of the union: a workflow that won't load leaves
// (b) UNPROVABLE. Collapsing that into "workflow step" is what stranded rows —
// retry would mint a pending task and point at a `forge next` that never sees
// it. `unknown` is not a value any caller may silently coerce; it forces the
// decision (today: refuse before writing — see retry.ts).
export type TaskDispatchKind =
  | { kind: "adhoc" }
  | { kind: "workflow_step" }
  | { kind: "unknown"; loadError: string };

export function taskDispatchKind(task: Task, run: Run): TaskDispatchKind {
  if (!taskHasPipelineFinalize(run)) return { kind: "adhoc" };
  let workflow;
  try {
    workflow = loadWorkflow(run.workflow, run.projectDir ? { projectDir: run.projectDir } : {});
  } catch (e) {
    return { kind: "unknown", loadError: (e as Error).message };
  }
  return workflow.steps.some((s) => s.id === task.phase) ? { kind: "workflow_step" } : { kind: "adhoc" };
}
