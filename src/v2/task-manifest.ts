import { writeFileSync } from "node:fs";
import { join } from "node:path";

// FG-350: RECORDED dispatch-time control-plane provenance. Written once at task
// dispatch and never recomputed — Explain views read RECORDED truth, not current
// host/project config. The vocabulary: SOURCE = where a file was resolved from;
// DERIVED = inferred from available data; EFFECTIVE = the resolved value at dispatch;
// RECORDED = the persisted fact (what this receipt stores).

export type ControlPlaneReceipt = {
  /** The workflow that dispatched this task. synthetic = forge invoke (no YAML file). unknown = source probe failed. */
  workflow: {
    name: string;
    source: "host" | "project" | "synthetic" | "unknown";
    path?: string;
  };
  /** The runtime YAML loaded at dispatch time. */
  runtime: {
    name: string;
    source: "host" | "project";
    path: string;
  };
  /** Model policy evaluated at dispatch. absent = no policy file, legacy resolution used. */
  modelPolicy: {
    source: "host" | "project" | "absent";
    path?: string;
  };
  /** Routing receipt when the task was dispatched under a route key. */
  routing?: {
    routeKey: string;
    source: "host" | "project";
    policyPath: string;
    responsible: string;
    pathType: string;
    requiredFollowups: string[];
  };
  /** docs-surfaces.yml evaluated at dispatch. built-in = no project file. */
  docsSurfaces: {
    source: "project" | "built-in";
    path?: string;
  };
  /** Constraint counts applied at dispatch for this specific task slot. */
  constraints: {
    dir: string;
    suggestCount: number;
    forceCount: number;
  };
  projectDir: string;
  /** Mount mode for the project directory at dispatch: ro = read-only (reds), rw = read-write (primary/fanout). */
  mountMode: "rw" | "ro";
  /** FG-374: directory forge was invoked from (may differ from projectDir when resolved from a subdir). */
  invocationCwd?: string;
  /** FG-374: true when projectDir was resolved up from a subdir (implicit invocation from within a monorepo). */
  resolvedFromSubdir?: boolean;
  /** FG-374: true when --allow-subproject was passed to intentionally mount a subdir. */
  explicitSubproject?: boolean;
  /** Non-fatal issues encountered while building this receipt (e.g. routing lookup failed). */
  warnings?: string[];
};

export type ControlPlaneReceiptInputs = {
  workflow: ControlPlaneReceipt["workflow"];
  runtime: ControlPlaneReceipt["runtime"];
  modelPolicy: ControlPlaneReceipt["modelPolicy"];
  routing?: ControlPlaneReceipt["routing"];
  docsSurfaces: ControlPlaneReceipt["docsSurfaces"];
  constraints: ControlPlaneReceipt["constraints"];
  mountMode: ControlPlaneReceipt["mountMode"];
  projectDir: string;
  invocationCwd?: string;
  resolvedFromSubdir?: boolean;
  explicitSubproject?: boolean;
  warnings?: string[];
};

/** Pure function — no side effects. Assembles the RECORDED control-plane receipt
 *  from dispatch-time inputs. Import from either dispatch path (invoke or runNext). */
export function manifestControlPlaneBlock(inputs: ControlPlaneReceiptInputs): ControlPlaneReceipt {
  const receipt: ControlPlaneReceipt = {
    workflow: inputs.workflow,
    runtime: inputs.runtime,
    modelPolicy: inputs.modelPolicy,
    docsSurfaces: inputs.docsSurfaces,
    constraints: inputs.constraints,
    mountMode: inputs.mountMode,
    projectDir: inputs.projectDir,
  };
  if (inputs.routing !== undefined) {
    receipt.routing = inputs.routing;
  }
  if (inputs.invocationCwd !== undefined) {
    receipt.invocationCwd = inputs.invocationCwd;
  }
  if (inputs.resolvedFromSubdir !== undefined) {
    receipt.resolvedFromSubdir = inputs.resolvedFromSubdir;
  }
  if (inputs.explicitSubproject !== undefined) {
    receipt.explicitSubproject = inputs.explicitSubproject;
  }
  if (inputs.warnings !== undefined && inputs.warnings.length > 0) {
    receipt.warnings = inputs.warnings;
  }
  return receipt;
}

export type TaskManifest = {
  taskId: string;
  runId: string;
  files: {
    prompt: "CLAUDE.md";
    package: "package.md";
    result: "result.json";
    stdout: "container.stdout.log";
    stderr: "container.stderr.log";
  };
  // idleTimeoutMs is the EFFECTIVE timeout resolved at dispatch (from the
  // task's runtime YAML / env at that moment), so forge show reports the value
  // the task actually ran under — not whatever the current environment resolves
  // to now. Optional: pre-#202 manifests omit it, and show falls back.
  container: { name: string; idleTimeoutMs?: number };
  auth: { profileRequested: boolean; stateMounted: boolean };
  // #292: the runtime EXECUTION metadata this task ran under, distinct from the
  // model block below (model SELECTION). `name` is the runtime YAML; the rest are
  // the resolved execution facts (parser/prompt/auth strategy). Optional: pre-#292
  // manifests omit it. Surfaced by forge show so an operator can tell runtime
  // behavior apart from upstream provider/model.
  runtime?: {
    name: string;
    kind: "claude-code" | "codex" | "pi";
    logFormat: "claude-stream-json" | "codex-jsonl" | "pi-jsonl";
    promptStrategy: "claude-stdin-package" | "stdin-prepend" | "runtime-context-file" | "message-arg";
    authStrategy: "oauth-volume" | "codex-auth" | "env-provider-api-key" | "pi-auth-json" | "local-endpoint" | "aws-bedrock";
  };
  // AWN-7: the model resolution record — answers "why did this task use this
  // model?" Present only in policy mode (a model-policy.yml resolved this task);
  // omitted in legacy mode. resolvedBy="legacy" is never written here. auth is
  // the EFFECTIVE mode (never "auto"). Mirrors the resolved_* task columns plus
  // the alias/model/costTier/runtime that don't get their own columns.
  model?: {
    alias: string;
    model: string;
    profile: string;
    provider: string;
    auth: string;
    costTier: string;
    resolvedBy: string;
    runtime: string;
  };
  // FG-350: RECORDED dispatch-time control-plane provenance. Optional: pre-FG-350
  // manifests omit it. Consumers must degrade gracefully when absent (legacy path).
  controlPlane?: ControlPlaneReceipt;
};

export function writeTaskManifest(dir: string, manifest: TaskManifest): void {
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
}
