import type { Command } from "commander";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { SHIM_NAME, buildRelease, collectProvenance, renderShim } from "../../v2/release.js";
import { installShim, promote, readPrevious, readSelection, rollback, type PromoteResult } from "../../v2/promote.js";
import { FORGE_HOME, currentLinkIn } from "../../util/paths.js";
import { findGitRoot } from "../../util/git-root.js";

// FG-569 (FG-553 Child 2): `forge release` — the release-closure builder plus R1 runtime
// provenance.
// FG-571 (FG-553 Child 4): ...and PROMOTION — `current`, atomic promote/rollback, and the
// machine-wide PATH shim. The builder itself stays inert (it never promotes what it
// builds); promotion is an explicit operator act, and installing the shim is a second,
// separate explicit act (its contract change is install-level breaking, so a promotion
// never rewrites it).
//
// BOTH surfaces — human and --json — must identify the selected release and its
// interpreter provenance TRUTHFULLY. Two rules follow from FG-569 and hold here:
//  - a REFUSED promotion never reports success and never claims the candidate is active
//    (validateCandidate throws; commander exits non-zero; `current` still names the old
//    release);
//  - absent provenance reads as "not recorded" — never a manufactured or guessed value.
//    An old release or installation that recorded nothing gets null/(not recorded), and
//    the operator can tell the difference between "unknown" and "this value".

const here = dirname(fileURLToPath(import.meta.url));
const requireFrom = createRequire(import.meta.url);

/** The one shape both surfaces report, so the human text and the JSON cannot disagree
 *  about what got selected or what runs it. */
function promotionReport(r: PromoteResult) {
  return {
    selected: { id: r.id, releaseDir: r.releaseDir },
    interpreter: { path: r.interpreter, abi: r.abi, nodeVersion: r.nodeVersion },
    previous: r.previous,
  };
}

function printPromotion(verb: string, r: PromoteResult): void {
  console.log(`forge release: ${verb} ${r.id}`);
  console.log(`  dir:         ${r.releaseDir}`);
  console.log(`  interpreter: ${r.interpreter}`);
  console.log(`  abi:         ${r.abi}  (node ${r.nodeVersion})`);
  // "not recorded", never a guess: a first promotion into a fresh forge home genuinely
  // has no previous release, and saying so is the honest answer.
  console.log(`  previous:    ${r.previous ? `${r.previous.id} (${r.previous.releaseDir})` : "(none — nothing was selected before)"}`);
  console.log(`  retained:    every release and interpreter (promotion deletes nothing)`);
}

export function registerRelease(program: Command): void {
  const release = program
    .command("release")
    .description("Build an immutable, self-contained forge release closure, promote it atomically, and inspect runtime provenance");

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
      // FG-571 (F32): the identity as carried in THIS process's environment — what
      // everything forge starts records as provenance. null on the dev entry is the
      // honest answer, not a gap to fill.
      console.log(`releaseId:   ${prov.releaseId ?? "(not recorded — dev entry has no manifest)"}`);
    });

  release
    .command("promote")
    .argument("<dir|id>", "release directory to promote, or the id of a release already in the store")
    .description("Validate a release (its closure is RUN) and atomically select it as the machine-wide forge. Retains the superseded release — promotion never deletes.")
    .option("--json", "machine-readable output")
    .action((candidate: string, opts: { json?: boolean }) => {
      // Throws a named refusal on an invalid candidate — leaving the previously selected
      // release selected, and reporting nothing as promoted (F26).
      const r = promote({ candidate });
      if (opts.json) {
        console.log(JSON.stringify({ promoted: true, ...promotionReport(r) }, null, 2));
        return;
      }
      printPromotion("promoted", r);
    });

  release
    .command("rollback")
    .description("Atomically select the previous release again (the same rename(2) pointer swap as promote). Deletes nothing.")
    .option("--json", "machine-readable output")
    .action((opts: { json?: boolean }) => {
      const r = rollback();
      if (opts.json) {
        console.log(JSON.stringify({ rolledBack: true, ...promotionReport(r) }, null, 2));
        return;
      }
      printPromotion("rolled back to", r);
    });

  release
    .command("current")
    .description("Report the release `current` selects and the interpreter that runs it")
    .option("--json", "machine-readable output")
    .action((opts: { json?: boolean }) => {
      const sel = readSelection();
      const prev = readPrevious();
      // A selected release whose manifest cannot be read is reported AS THAT — not as
      // "nothing selected" and not with invented values. The operator needs to tell the
      // two apart: one means promote something, the other means the selected release is
      // corrupt and should be rolled back from.
      const describe = (s: ReturnType<typeof readSelection>) =>
        s
          ? {
              id: s.manifest?.id ?? null,
              releaseDir: s.releaseDir,
              commit: s.manifest?.commit ?? null,
              interpreter: s.manifest?.interpreter ?? null,
              abi: s.manifest?.abi ?? null,
              nodeVersion: s.manifest?.nodeVersion ?? null,
              manifestReadable: s.manifest !== null,
            }
          : null;
      if (opts.json) {
        console.log(JSON.stringify({ forgeHome: FORGE_HOME, current: describe(sel), previous: describe(prev) }, null, 2));
        return;
      }
      console.log(`forgeHome:   ${FORGE_HOME}`);
      if (!sel) {
        // Nothing selected is a real, ordinary state — say so plainly rather than
        // inventing a release to name.
        console.log(`current:     (nothing selected — ${currentLinkIn(FORGE_HOME)} does not resolve to a release)`);
        console.log(`Promote one with \`forge release promote <dir|id>\`.`);
        return;
      }
      if (!sel.manifest) {
        console.log(`current:     ${sel.releaseDir}`);
        console.log(`  WARNING: this release's manifest is missing or unreadable, so forge cannot say what it is.`);
        console.log(`  The machine-wide shim will refuse to run it. Roll back with \`forge release rollback\`, or promote a known-good release.`);
        return;
      }
      console.log(`current:     ${sel.manifest.id} (commit ${sel.manifest.commit.slice(0, 7)})`);
      console.log(`  dir:         ${sel.releaseDir}`);
      console.log(`  interpreter: ${sel.manifest.interpreter}`);
      console.log(`  abi:         ${sel.manifest.abi}  (node ${sel.manifest.nodeVersion})`);
      console.log(`previous:    ${prev ? `${prev.manifest?.id ?? `${prev.releaseDir} (manifest unreadable)`}` : "(none recorded)"}`);
    });

  release
    .command("install-shim")
    .description("Install the machine-wide `forge` PATH shim into --prefix, atomically (temp + rename). EXPLICIT ONLY: a promotion never installs or rewrites the shim, because the shim's contract is not atomic with a release.")
    .requiredOption("--prefix <dir>", "directory to install the shim into (typically a directory on your PATH)")
    .option("--json", "machine-readable output")
    .action((opts: { prefix: string; json?: boolean }) => {
      const path = installShim({ prefix: resolve(opts.prefix), shimText: renderShim(), shimName: SHIM_NAME });
      const sel = readSelection();
      if (opts.json) {
        console.log(
          JSON.stringify(
            {
              installed: path,
              forgeHome: FORGE_HOME,
              // The shim resolves `current` at RUN time and bakes no interpreter, so
              // what it will select is a fact about now, not about the install.
              selects: sel ? { id: sel.manifest?.id ?? null, releaseDir: sel.releaseDir, interpreter: sel.manifest?.interpreter ?? null } : null,
            },
            null,
            2,
          ),
        );
        return;
      }
      console.log(`forge release: installed the shim at ${path}`);
      console.log(`  forgeHome:   ${FORGE_HOME}`);
      console.log(`  selects:     ${sel ? `${sel.manifest?.id ?? "(a release whose manifest is unreadable)"} — ${sel.releaseDir}` : "(nothing yet — promote a release before running it)"}`);
      console.log(`  interpreter: ${sel?.manifest?.interpreter ?? "(read from the selected release's manifest at run time)"}`);
    });
}
