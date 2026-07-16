import type { Command } from "commander";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { buildRelease, collectProvenance } from "../../v2/release.js";
import { findGitRoot } from "../../util/git-root.js";

// FG-569 (FG-553 Child 2): `forge release` — the INERT release-closure builder
// plus R1 runtime provenance. No promotion, no `current`, no PATH change — those
// are Child 4. This command only PRODUCES a self-contained release directory and
// reports the runtime the caller is actually running under.

const here = dirname(fileURLToPath(import.meta.url));
const requireFrom = createRequire(import.meta.url);

export function registerRelease(program: Command): void {
  const release = program
    .command("release")
    .description("Build an immutable, self-contained forge release closure and inspect runtime provenance (FG-569, inert — no promotion)");

  release
    .command("build")
    .description("Build a release closure (entry + source + entire node_modules + native binding + manifest). Refuses a torn node_modules at build.")
    .requiredOption("--out <dir>", "destination directory for the release (must not already exist)")
    .option("--source <dir>", "source root to build from (default: the git root of the cwd)")
    .option("--json", "machine-readable output")
    .action((opts: { out: string; source?: string; json?: boolean }) => {
      const sourceRoot = opts.source ? resolve(opts.source) : findGitRoot(process.cwd());
      const result = buildRelease({ sourceRoot, outDir: resolve(opts.out) });
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(`forge release: built ${result.manifest.id}`);
      console.log(`  dir:         ${result.releaseDir}`);
      console.log(`  entry:       ${result.entryPath}`);
      console.log(`  commit:      ${result.manifest.commit}`);
      console.log(`  interpreter: ${result.manifest.interpreter}`);
      console.log(`  abi:         ${result.manifest.abi}  (node ${result.manifest.nodeVersion})`);
      console.log(`  lockfile:    ${result.manifest.lockfile.name} ${result.manifest.lockfile.sha256.slice(0, 12)}…`);
    });

  release
    .command("provenance")
    .description("R1: report the RUNNING process's own runtime (execPath, ABI) — self-evidencing; compared against the manifest when run inside a release")
    .option("--json", "machine-readable output")
    .action((opts: { json?: boolean }) => {
      const prov = collectProvenance(here, requireFrom);
      if (opts.json) {
        console.log(JSON.stringify(prov, null, 2));
        return;
      }
      console.log(`pid:         ${prov.pid}`);
      console.log(`execPath:    ${prov.execPath}`);
      console.log(`abi:         ${prov.abi}  (node ${prov.nodeVersion})`);
      console.log(`bindingLoads: ${prov.bindingLoads}`);
      if (prov.release) {
        console.log(`release:     ${prov.release.id} (commit ${prov.release.commit.slice(0, 7)})`);
        console.log(`match:       interpreter=${prov.match?.interpreter} abi=${prov.match?.abi}`);
      } else {
        console.log(`release:     (not running inside a release — dev entry)`);
      }
    });
}
