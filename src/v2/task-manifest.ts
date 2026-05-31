import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TaskContract } from "./contract.js";

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
  // AWN-4: the task contract this task was dispatched under, if any. Surfaced in
  // forge show; consumed by the agent via its rendered package.
  contract?: TaskContract;
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
};

export function writeTaskManifest(dir: string, manifest: TaskManifest): void {
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
}
