import { writeFileSync } from "node:fs";
import { join } from "node:path";

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
};

export function writeTaskManifest(dir: string, manifest: TaskManifest): void {
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
}
