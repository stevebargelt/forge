// forge v2 — startRun: kick off a new run from a workflow + inputs.
//
// Equivalent of today's `forge new`. Creates a Run row, validates the
// inputs against the workflow's `inputs:` block, and returns the runId.
// Does NOT dispatch the first wave — that's runNext's job. Caller invokes
// runNext after this returns.
//
// NOT YET WIRED TO CLI. Like runNext, this is the v2 runner core, callable
// as a library. Wiring into `forge new` is a separate change at v2 cutover.
//
// See DECISIONS.md for the architectural calls made here.

import type { Run } from "../types/index.js";
import type { Workflow } from "./schema.js";
import { insertRun } from "../store/runs.js";
import { logEvent } from "../store/events.js";
import { newRunId } from "../util/ids.js";

export type StartRunArgs = {
  workflow: Workflow;
  title: string;
  inputs: Record<string, unknown>;
  projectDir: string;
  designDir?: string;
  /** The orchestrator's home directory — used by `forge status` to filter
   *  runs to the current workspace. Distinct from projectDir when an audit
   *  workspace's orchestrator runs against an external target repo. Defaults
   *  to projectDir at the CLI layer when not set explicitly. */
  workspace?: string;
};

export type StartRunResult = {
  runId: string;
};

export function startRun(args: StartRunArgs): StartRunResult {
  // Validate inputs against workflow's input block.
  for (const inputDef of args.workflow.inputs) {
    if (inputDef.required && !(inputDef.name in args.inputs)) {
      throw new Error(
        `startRun: required input '${inputDef.name}' missing for workflow '${args.workflow.name}'`
      );
    }
  }

  const runId = newRunId(args.title);
  const metadata: Record<string, unknown> = { ...args.inputs };
  if (args.designDir) metadata["designDir"] = args.designDir;
  if (args.workspace) metadata["workspace"] = args.workspace;

  const run: Run = {
    id: runId,
    workflow: args.workflow.name,
    title: args.title,
    status: "active",
    createdAt: new Date().toISOString(),
    metadata,
    projectDir: args.projectDir,
  };

  insertRun(run);
  logEvent("run.created", { runId, payload: { workflow: args.workflow.name, title: args.title } });

  return { runId };
}
