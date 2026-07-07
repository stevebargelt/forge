import type { Run } from "../types/index.js";

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
