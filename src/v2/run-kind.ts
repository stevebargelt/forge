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

// The phase every `forge invoke` row carries (invoke.ts's synthetic step id).
// A workflow YAML may legally declare a step with this id, which is precisely
// the collision the provenance marker exists to resolve.
const INVOKE_PHASE = "task";

// FG-507: is this task ad-hoc — dispatched by `forge invoke`, not by the
// workflow runner? Ad-hoc tasks are invisible to the ready queue (computeReadyQueue
// walks workflow steps), so a pending ad-hoc row strands forever waiting for a
// `forge next` that will never see it.
//
// Answered from RECORDED provenance first: invoke stamps `dispatchSource` on the
// taskPackage at row creation, so a task it created says so itself — no workflow
// load, no structural guess. Everything below it is a fallback for rows minted
// before that marker existed.
//
// Two ad-hoc shapes, both covered by the marker; the fallbacks still cover them
// for legacy rows:
//   (a) a synthetic single-task invoke run (run.workflow === "invoke", or an
//       "invoke_chain" run from a campaign quick lane) — no workflow YAML exists,
//       so the answer is decisive without a load attempt;
//   (b) `forge invoke --run <real-workflow-run>`, which attaches a phase="task"
//       row to a run whose workflow (usually) has no such step.
//
// `unknown` is the point of the union: two DIFFERENT states leave (b) unprovable
// for a marker-less row, and neither may be collapsed into "workflow step" —
// that collapse is what stranded rows, since retry would mint a pending task and
// point at a `forge next` that never sees it.
//   - workflow_unloadable: the YAML that would answer the question is gone/broken.
//   - legacy_ambiguous_phase: the YAML loads and DOES own a step whose id is
//     `task`. A legacy invoke --run row and a genuine step of that workflow are
//     then structurally identical, and only the marker (which the row predates)
//     could have told them apart.
// No caller may silently coerce `unknown`; it forces the decision (today: refuse
// before writing — see retry.ts, the one interpreter).
export type TaskDispatchKind =
  | { kind: "adhoc" }
  | { kind: "workflow_step" }
  | { kind: "unknown"; reason: "workflow_unloadable"; loadError: string }
  | { kind: "unknown"; reason: "legacy_ambiguous_phase" };

export function taskDispatchKind(task: Task, run: Run): TaskDispatchKind {
  if (task.taskPackage.dispatchSource === "invoke") return { kind: "adhoc" };
  if (!taskHasPipelineFinalize(run)) return { kind: "adhoc" };
  let workflow;
  try {
    workflow = loadWorkflow(run.workflow, run.projectDir ? { projectDir: run.projectDir } : {});
  } catch (e) {
    return { kind: "unknown", reason: "workflow_unloadable", loadError: (e as Error).message };
  }
  if (!workflow.steps.some((s) => s.id === task.phase)) return { kind: "adhoc" };
  // The workflow owns a step with this phase. For any phase invoke never creates,
  // that settles it. For `task` it settles nothing, and this row has no marker.
  if (task.phase === INVOKE_PHASE) return { kind: "unknown", reason: "legacy_ambiguous_phase" };
  return { kind: "workflow_step" };
}
