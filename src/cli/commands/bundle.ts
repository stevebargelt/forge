import type { Command } from "commander";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { getDb } from "../../store/db.js";
import { assertStoreForLookup } from "../no-store.js";
import { ensureForgeDirs } from "../../util/paths.js";
import { assembleBundle } from "../../v2/bundle.js";

// RUN-4: `forge bundle <run-id>` — write a sanitized debug archive for a run.

export function registerBundle(program: Command): void {
  program
    .command("bundle")
    .argument("<run-id>", "run id to bundle")
    .description("Assemble a sanitized debug bundle (metadata + events + manifests + bounded logs) for a run")
    .option("--out <dir>", "destination directory (default: cwd)")
    .option("--include-prompts", "include CLAUDE.md / package.md (task prompts)")
    .option("--tar", "also produce <run-id>-bundle.tar.gz (requires tar on PATH)")
    .option("--json", "emit the bundle manifest summary as JSON")
    .action((runId: string, opts: { out?: string; includePrompts?: boolean; tar?: boolean; json?: boolean }) => {
      ensureForgeDirs();
      assertStoreForLookup(`run ${runId}`);
      getDb({ readOnly: true });

      const destRoot = resolve(opts.out ?? process.cwd());
      const result = assembleBundle(runId, destRoot, { includePrompts: !!opts.includePrompts });

      let tarball: string | undefined;
      if (opts.tar) {
        tarball = `${result.bundleDir}.tar.gz`;
        const r = spawnSync("tar", ["-czf", tarball, "-C", destRoot, `${runId}-bundle`], { stdio: "ignore" });
        if (r.status !== 0) {
          console.error(`forge bundle: tar failed (status ${r.status}); the bundle directory is still at ${result.bundleDir}`);
          tarball = undefined;
        }
      }

      if (opts.json) {
        console.log(JSON.stringify({ ...result, tarball: tarball ?? null }, null, 2));
        return;
      }

      console.log(`Bundle: ${result.bundleDir}`);
      if (tarball) console.log(`Archive: ${tarball}`);
      console.log(`  tasks: ${result.taskCount}  ·  files: ${result.filesIncluded.length}${result.truncated.length ? `  ·  truncated: ${result.truncated.length}` : ""}`);
      console.log(`  ${result.note}`);
    });
}
