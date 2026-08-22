// FG-348 [C]: buildTaskExplain — the ONE pure projection of a SINGLE task's
// already-fetched data into the TaskExplain contract. Consumed unreshaped by both
// the dashboard query (taskExplain) and the CLI JSON surface (`forge explain
// task`), so they are byte-identical by construction.
//
// PURE: no db, no disk, no fs. It NEVER imports config-graph — the RECORDED
// manifest receipt is the SOLE authority for a task's resolution here; a caller
// that wants a live "current config" contrast attaches it separately and labels
// it as current.
//
// Each output block is driven off the presence/absence of its OWN recorded block,
// INDEPENDENTLY: a present block is authoritative; an absent one degrades to
// inferred/unknown and emits the ticket's warning derived from the ACTUAL missing
// block — never from a run-age heuristic. A wholly-absent manifest degrades every
// manifest-backed block to unknown and warns "predates manifest.json".

import type { Task } from "../types/index.js";
import type { ControlPlaneReceipt, TaskManifest } from "./task-manifest.js";
import {
  RUN_EXPLAIN_VERSION,
  type ArtifactRef,
  type ExplainBlockStatus,
  type GateBlock,
  type GateDecisionEntry,
  type ModelResolutionBlock,
  type MountModeBlock,
  type RedEntry,
  type RedsBlock,
  type RuntimeBlock,
  type TaskExplain,
  type UpstreamInput,
  type UpstreamInputsBlock,
  type WorkflowSourceBlock,
} from "./run-explain-types.js";

/** The DB-sourced gate decision, projected (matches the dashboard GateRow). */
export type ExplainGate = {
  decision: string;
  rationale?: string | null;
  decidedBy: string;
  decidedAt: string;
};

/** The DB-sourced verdict facts the reds block needs (matches VerdictRow). */
export type ExplainVerdict = {
  redTaskId: string;
  redRole: string;
  verdict: string;
  confidence: number;
  authority: string;
  findings: unknown;
};

export type BuildTaskExplainInput = {
  task: Task;
  gates: ExplainGate[];
  verdicts: ExplainVerdict[];
  /** The parsed manifest.json, or undefined when the task has none (legacy). The
   *  caller reads it (readTaskManifest, undefined-on-failure); the builder does
   *  no disk access itself. */
  manifest?: Partial<TaskManifest>;
  /** Gate type declared by the backing workflow step, when the caller resolved a
   *  workflow. Absent for legacy/unresolvable runs. */
  gateType?: string;
  /** Artifact availability the caller probed from disk. Undefined => the builder
   *  derives a minimal list from the row (result presence only). */
  artifacts?: ArtifactRef[];
};

const WARN_MANIFEST_ABSENT =
  "This task predates manifest.json — control-plane provenance and mount details are inferred.";
const WARN_CONTROLPLANE_ABSENT =
  "Control-plane receipt absent — mount details are inferred.";
const WARN_MODEL_ABSENT =
  "Model policy absent; legacy runtime alias resolution used.";
const WARN_PROJECT_OVERRIDE = "Project workflow override is active.";
const WARN_FANOUT_CHILD =
  "Fanout children were created from plan.steps.";

function findingCount(findings: unknown): number {
  return Array.isArray(findings) ? findings.length : 0;
}

/** A compact, redaction-safe summary of one input value — never the raw value.
 *
 *  FG-348 (RF-3/RF-4): task inputs are free-form and can be attacker-influenced, so
 *  ANY string under ANY key may be a bearer token, credential, or sensitive prompt.
 *  The whole-payload redaction sweep the caller applies (redactGraph → redactSecrets)
 *  is STRUCTURAL — it blanks credential-SHAPED substrings (basic-auth URLs,
 *  `_authToken=`, `NAME_TOKEN=`, `Authorization:` headers) but by deliberate policy
 *  does NOT catch a BARE token value with no surrounding structure. So a preview of
 *  raw string content — even truncated — leaks a bare secret past the process. The
 *  only fix that honors the invariant ("secrets never leave the process") for both
 *  short and long strings is to surface the value's SHAPE, never its content: the key
 *  name and a length, matching how arrays/objects are already summarized. */
function summarizeInput(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return `string[${value.length}]`;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `array[${value.length}]`;
  if (typeof value === "object") return `object{${Object.keys(value as object).length}}`;
  return typeof value;
}

function workflowSourceBlock(cp: ControlPlaneReceipt | undefined, manifestPresent: boolean): WorkflowSourceBlock {
  if (cp?.workflow) {
    const block: WorkflowSourceBlock = {
      name: cp.workflow.name,
      source: cp.workflow.source,
      status: "recorded",
      native: cp.workflow,
    };
    if (cp.workflow.path !== undefined) block.path = cp.workflow.path;
    return block;
  }
  return { status: manifestPresent ? "inferred" : "unknown" };
}

function modelResolutionBlock(
  task: Task,
  model: TaskManifest["model"] | undefined,
  manifestPresent: boolean,
): ModelResolutionBlock {
  if (model) {
    return {
      alias: model.alias,
      model: model.model,
      profile: model.profile,
      provider: model.provider,
      auth: model.auth,
      costTier: model.costTier,
      resolvedBy: model.resolvedBy,
      capabilitySource: model.capabilitySource,
      mappingPath: model.mappingPath,
      status: "recorded",
      native: model,
    };
  }
  // Legacy mode (no policy-mode model block): best-effort from the row columns.
  const block: ModelResolutionBlock = { status: manifestPresent ? "inferred" : "unknown" };
  if (task.agentAlias !== undefined) block.alias = task.agentAlias;
  if (task.agentModel !== undefined) block.model = task.agentModel;
  if (task.resolvedProfile !== undefined) block.profile = task.resolvedProfile;
  if (task.resolvedProvider !== undefined) block.provider = task.resolvedProvider;
  if (task.resolvedAuth !== undefined) block.auth = task.resolvedAuth;
  if (task.resolvedBy !== undefined) block.resolvedBy = task.resolvedBy;
  return block;
}

function runtimeBlock(
  runtime: TaskManifest["runtime"] | undefined,
  cp: ControlPlaneReceipt | undefined,
  manifestPresent: boolean,
): RuntimeBlock {
  if (runtime) {
    return {
      name: runtime.name,
      kind: runtime.kind,
      logFormat: runtime.logFormat,
      promptStrategy: runtime.promptStrategy,
      authStrategy: runtime.authStrategy,
      status: "recorded",
      native: runtime,
    };
  }
  if (cp?.runtime) {
    return { name: cp.runtime.name, status: "inferred", native: cp.runtime };
  }
  return { status: manifestPresent ? "inferred" : "unknown" };
}

function mountModeBlock(cp: ControlPlaneReceipt | undefined, manifestPresent: boolean): MountModeBlock {
  if (cp) {
    const block: MountModeBlock = {
      mountMode: cp.mountMode,
      projectDir: cp.projectDir,
      status: "recorded",
      native: { mountMode: cp.mountMode, projectDir: cp.projectDir },
    };
    if (cp.invocationCwd !== undefined) block.invocationCwd = cp.invocationCwd;
    if (cp.resolvedFromSubdir !== undefined) block.resolvedFromSubdir = cp.resolvedFromSubdir;
    if (cp.explicitSubproject !== undefined) block.explicitSubproject = cp.explicitSubproject;
    return block;
  }
  return { status: manifestPresent ? "inferred" : "unknown" };
}

function gateBlock(gates: ExplainGate[], gateType: string | undefined): GateBlock {
  const decisions: GateDecisionEntry[] = gates.map((g) => {
    const entry: GateDecisionEntry = {
      decision: g.decision,
      decidedBy: g.decidedBy,
      decidedAt: g.decidedAt,
    };
    if (g.rationale != null) entry.rationale = g.rationale;
    return entry;
  });
  const status: ExplainBlockStatus = gateType !== undefined ? "recorded" : "inferred";
  const block: GateBlock = { decisions, status };
  if (gateType !== undefined) block.gateType = gateType;
  return block;
}

function redsBlock(verdicts: ExplainVerdict[]): RedsBlock {
  const reds: RedEntry[] = verdicts.map((v) => ({
    redTaskId: v.redTaskId,
    redRole: v.redRole,
    verdict: v.verdict,
    confidence: v.confidence,
    authority: v.authority,
    findingCount: findingCount(v.findings),
  }));
  return { reds, status: "recorded" };
}

function upstreamBlock(task: Task): UpstreamInputsBlock {
  const inputs: UpstreamInput[] = Object.entries(task.taskPackage.inputs ?? {}).map(([key, value]) => ({
    key,
    summary: summarizeInput(value),
  }));
  return { inputs, status: "recorded" };
}

function artifactList(task: Task, provided: ArtifactRef[] | undefined): ArtifactRef[] {
  if (provided !== undefined) return provided;
  return [{ kind: "result", name: "result.json", available: task.result !== undefined && task.result !== null }];
}

export function buildTaskExplain(input: BuildTaskExplainInput): TaskExplain {
  const { task, gates, verdicts, manifest, gateType, artifacts } = input;
  const manifestPresent = manifest !== undefined;
  const cp = manifest?.controlPlane;
  const warnings: string[] = [];

  if (!manifestPresent) {
    warnings.push(WARN_MANIFEST_ABSENT);
  } else if (!cp) {
    warnings.push(WARN_CONTROLPLANE_ABSENT);
  }
  if (manifestPresent && !manifest?.model) {
    warnings.push(WARN_MODEL_ABSENT);
  }
  if (cp?.workflow.source === "project") {
    warnings.push(WARN_PROJECT_OVERRIDE);
  }
  if (typeof task.taskPackage.inputs?.["fanoutIndex"] === "number") {
    warnings.push(WARN_FANOUT_CHILD);
  }
  // Receipt-recorded warnings, verbatim and last (so derived-absence callouts
  // lead — they explain WHY blocks are degraded).
  if (cp?.warnings) warnings.push(...cp.warnings);

  return {
    version: RUN_EXPLAIN_VERSION,
    taskId: task.id,
    runId: task.runId,
    role: task.agentRole,
    status: task.status,
    warnings,
    workflowSource: workflowSourceBlock(cp, manifestPresent),
    modelResolution: modelResolutionBlock(task, manifest?.model, manifestPresent),
    runtime: runtimeBlock(manifest?.runtime, cp, manifestPresent),
    mountMode: mountModeBlock(cp, manifestPresent),
    gate: gateBlock(gates, gateType),
    reds: redsBlock(verdicts),
    upstream: upstreamBlock(task),
    artifacts: artifactList(task, artifacts),
  };
}
