// forge submit — transitions a manual-phase task (FORGE-DEC-016) from
// awaiting_human_input → awaiting_gate after validating that the human's
// off-forge artifacts exist on disk.
//
// Each workflow that uses a manual phase needs its own validator (see
// submitValidators.ts). New manual-phase workflows add a switch arm here.

import type { Task } from "../types/index.js";
import { getTask, markTaskAwaitingGate } from "../store/tasks.js";
import { getRun } from "../store/runs.js";
import { logEvent } from "../store/events.js";
import { validateUiDesignArtifacts, type UiDesignArtifacts } from "./submitValidators.js";

export type SubmitResult = UiDesignArtifacts & {
  status: "complete";
  notes?: string;
};

export type SubmitOptions = {
  notes?: string;
};

export async function submit(
  taskId: string,
  opts: SubmitOptions = {}
): Promise<{ task: Task; result: SubmitResult }> {
  const task = getTask(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  if (task.status !== "awaiting_human_input") {
    throw new Error(
      `Task ${taskId} is in status '${task.status}', not awaiting_human_input. Cannot submit.`
    );
  }

  const run = getRun(task.runId);
  if (!run) throw new Error(`Run not found for task ${taskId}`);

  let artifacts: UiDesignArtifacts;

  if (run.workflow === "ui-design" || run.workflow === "design-revise") {
    const designDir =
      typeof run.metadata?.designDir === "string" ? (run.metadata.designDir as string) : undefined;
    if (!designDir) {
      throw new Error(
        `Run ${run.id} is missing metadata.designDir. The ${run.workflow} workflow requires --design-dir at run creation; re-create the run with 'forge new ${run.workflow} "<title>" --design-dir <path>'.`
      );
    }
    artifacts = validateUiDesignArtifacts(designDir, run.title);
  } else {
    throw new Error(
      `forge submit is not supported for workflow '${run.workflow}' — manual phases only exist in ui-design / design-revise today.`
    );
  }

  const result: SubmitResult = {
    status: "complete",
    ...artifacts,
    ...(opts.notes ? { notes: opts.notes } : {}),
  };

  markTaskAwaitingGate(taskId, result);
  logEvent("task.submitted", {
    runId: run.id,
    taskId,
    payload: {
      penFile: artifacts.penFile,
      pngCount: artifacts.pngFiles.length,
      htmlCount: artifacts.htmlFiles.length,
      hasNotes: !!opts.notes,
    },
  });

  return { task: getTask(taskId)!, result };
}
