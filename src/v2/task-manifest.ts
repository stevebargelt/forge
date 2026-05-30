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
  container: { name: string };
  auth: { profileRequested: boolean; stateMounted: boolean };
};

export function writeTaskManifest(dir: string, manifest: TaskManifest): void {
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
}
