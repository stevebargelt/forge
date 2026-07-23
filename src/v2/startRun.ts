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
import { resolvePolicyPath } from "../raci/project.js";
import { resolveSeedGeneration } from "./seed-generation.js";
import { explainRouteFile } from "../cli/commands/route.js";

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
  /** #176: name of a captured auth profile injected into browser-verify steps
   *  of this run. Stored in metadata; runNext scopes it to browser-capable
   *  roles. */
  authProfile?: string;
  /** AWN-7: run-level model-profile override (`forge new --profile`). Stored in
   *  metadata; runNext pins every task (primary/red/fanout) to it at the highest
   *  profile-selection precedence. No-op in legacy mode (no model-policy.yml). */
  modelProfile?: string;
  /** FG-28: opt-in constraint scoping. Tagged constraints only fire for runs that
   *  carry at least one matching tag. Untagged constraints remain global. */
  tags?: string[];
  /** FG-350: resolved route key for this run. When provided, startRun resolves
   *  the routing policy and stores a routeReceipt in run metadata capturing the
   *  dispatch-time routing decision (responsible, pathType, requiredFollowups). */
  routeKey?: string;
  /** FG-350: provenance of the workflow file (host or project, with path). When
   *  provided, stored as workflowReceipt in run metadata. */
  workflowSource?: { source: "host" | "project"; path: string };
  /** FG-374: directory forge was invoked from (recorded for provenance). */
  invocationCwd?: string;
  /** FG-374: true when projectDir was resolved up from a monorepo subdir. */
  resolvedFromSubdir?: boolean;
  /** FG-374: true when --allow-subproject was passed. */
  explicitSubproject?: boolean;
  /** FG-563 (CP2, F17 receipt bridge): the deterministic continuation dispatch_key
   *  this run is the physical dispatch OF. Stamped into run metadata at creation —
   *  BEFORE the first wave spawns — so runByDispatchKey can adopt this exact run on
   *  a recovery instead of duplicating it. Control-plane metadata (never poured into
   *  task inputs — see CONTROL_PLANE_METADATA_KEYS). Absent for an ordinary run not
   *  driven by a durable continuation. */
  dispatchKey?: string;
  /** FG-596: the item-attempt identity carried on a campaign drive-item run — the
   *  LOGICAL attempt generation of the campaign item this run is dispatching. Stored
   *  in run metadata (control-plane, never task input) alongside itemId/campaignId so
   *  a later slice can bind an attempt-specific phase and a delayed completion from a
   *  prior retry cannot advance a new attempt. Absent for an ordinary (non-campaign)
   *  run. */
  attemptGeneration?: number;
};

export type StartRunResult = {
  runId: string;
};

// Run-metadata keys that are CONTROL-PLANE, not task input. Each is set from a
// dedicated CLI surface (--design-dir, --auth-profile, --profile) or derived
// (--workspace), stored in run metadata for the runner/mounts/scoping, and MUST
// NOT leak into task inputs or composed prompts — that would let a profile name
// or workspace path ride into the model's context and blur the "policy chooses
// models; workflows describe work" boundary. `forge new` rejects these from
// --meta (so they can only be set through their explicit flags); runNext strips
// them wherever run metadata is poured into task inputs.
export const CONTROL_PLANE_METADATA_KEYS = [
  "designDir",
  "authProfile",
  "modelProfile",
  "workspace",
  "tags",
  "reportOutputPath",
  "routeReceipt",
  "workflowReceipt",
  "invocationCwd",       // FG-374
  "resolvedFromSubdir",  // FG-374
  "explicitSubproject",  // FG-374
  "dispatchKey",         // FG-563 (CP2): F17 dispatch receipt, never task input
  "attemptGeneration",   // FG-596: campaign item-attempt identity, never task input
] as const;

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
  if (args.authProfile) metadata["authProfile"] = args.authProfile;
  if (args.modelProfile) metadata["modelProfile"] = args.modelProfile;
  if (args.tags && args.tags.length > 0) metadata["tags"] = args.tags;
  if (args.invocationCwd) metadata["invocationCwd"] = args.invocationCwd;
  if (args.resolvedFromSubdir) metadata["resolvedFromSubdir"] = args.resolvedFromSubdir;
  if (args.explicitSubproject) metadata["explicitSubproject"] = args.explicitSubproject;
  // FG-563 (CP2): stamp the F17 dispatch receipt into metadata BEFORE insertRun, so
  // the run is discoverable by runByDispatchKey the instant it exists — before the
  // first wave (runNext) can spawn anything observable.
  if (args.dispatchKey) metadata["dispatchKey"] = args.dispatchKey;
  // FG-596: stamp the campaign item-attempt identity BEFORE insertRun, in the same
  // pre-observability window as the dispatch key. Control-plane metadata only.
  if (args.attemptGeneration !== undefined) metadata["attemptGeneration"] = args.attemptGeneration;

  if (args.routeKey !== undefined) {
    // FG-583: resolve the routeReceipt's policy from the live seed generation, so
    // the recorded route comes from the SAME generation dispatch will consume.
    const resolved = resolvePolicyPath(args.projectDir, resolveSeedGeneration());
    const explanation = explainRouteFile(resolved.path, args.routeKey);
    if (explanation.ok) {
      metadata["routeReceipt"] = {
        routeKey: args.routeKey,
        source: resolved.source,
        policyPath: resolved.path,
        responsible: explanation.route.responsible,
        pathType: explanation.route.path,
        requiredFollowups: explanation.route.required_followups,
      };
    } else {
      metadata["routeReceipt"] = {
        routeKey: args.routeKey,
        warnings: explanation.findings.map((f) => f.message),
      };
    }
  }

  if (args.workflowSource !== undefined) {
    metadata["workflowReceipt"] = args.workflowSource;
  }

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
