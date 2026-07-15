// FG-569 (FG-553 Child 2) — R2 provenance, EXECUTED.
//
// The launch exit recorder (FG-535) is a SECOND runtime, distinct from the forge
// CLI (R1) that submitted the launch. It can run under a different interpreter
// than the CLI, so its runtime (execPath / ABI / release identity) must be
// captured from INSIDE the recorder process — never inferred or copied from R1.
//
// These tests EXECUTE the real recorder (the node -e script buildWrapperCommand
// emits, run through /bin/sh exactly as tmux would) and read what it wrote. The
// MUTANT the acceptance names — "infer R2 from R1 (copy the CLI's value)" — is
// killed two ways: the same launcher (R1) drives two recorders that record two
// DIFFERENT values, which a copy-from-R1 implementation cannot produce.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, existsSync, copyFileSync, chmodSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildWrapperCommand, parseRecorderRuntime, type RecorderRuntime } from "./launch.js";

let scratch: string;
let altNode: string;

before(() => {
  scratch = mkdtempSync(join(tmpdir(), "fg569-r2-"));
  // A genuinely DIFFERENT interpreter path: a real copy of this node binary. A
  // symlink would resolve back to the same execPath; only a distinct file gives
  // the recorder an execPath that differs from R1's (the test process).
  altNode = join(scratch, "alt-node");
  copyFileSync(process.execPath, altNode);
  chmodSync(altNode, 0o755);
});

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** EXECUTE the real recorder: run its wrapper command through /bin/sh, exactly
 *  as the tmux pane does. Returns the R2 record it wrote from inside itself. */
function runRecorder(opts: { node?: string; env?: NodeJS.ProcessEnv; argv?: string[] }): { runtime: RecorderRuntime | undefined; exitExists: boolean; dir: string } {
  const dir = mkdtempSync(join(scratch, "run-"));
  const exitPath = join(dir, "exit");
  const logPath = join(dir, "out.log");
  const rtPath = join(dir, "runtime.json");
  const argv = opts.argv ?? ["true"];
  const wrapper = buildWrapperCommand(argv, logPath, exitPath, rtPath, opts.node ?? process.execPath);
  const r = spawnSync("/bin/sh", ["-c", wrapper], { encoding: "utf8", env: opts.env ?? process.env });
  assert.equal(r.status, 0, `recorder wrapper failed: ${r.stderr}`);
  const runtime = existsSync(rtPath) ? parseRecorderRuntime(readFileSync(rtPath, "utf8")) : undefined;
  return { runtime, exitExists: existsSync(exitPath), dir };
}

test("FG-569 R2: the recorder records its OWN execPath / ABI / release id, from inside itself, before running the target", () => {
  const { runtime, exitExists } = runRecorder({
    env: { ...process.env, FORGE_RELEASE_ID: "release-r2-inside" },
    argv: ["true"],
  });
  assert.ok(runtime, "the recorder wrote its R2 runtime as its first act");
  assert.equal(runtime!.execPath, process.execPath, "execPath is the recorder's own process.execPath");
  assert.equal(runtime!.abi, process.versions.modules, "ABI is the recorder's own process.versions.modules");
  assert.equal(runtime!.releaseId, "release-r2-inside", "release id comes from the recorder's OWN environment");
  assert.ok(exitExists, "and the recorder still ran the target and wrote its exit record");
});

test("FG-569 R2 (MUTANT killed): one launcher, TWO recorders under different interpreters record DIFFERENT execPaths — impossible if R2 were copied from R1", () => {
  // Same test process = same R1. If R2 were inferred from R1 (the CLI's own
  // process.execPath baked in), BOTH records would carry THIS process's execPath.
  assert.notEqual(altNode, process.execPath, "the alt interpreter is genuinely a different path");

  const underReal = runRecorder({ node: process.execPath });
  const underAlt = runRecorder({ node: altNode });

  assert.equal(underReal.runtime!.execPath, process.execPath, "recorder run by the real node records the real node");
  // realpathSync both sides: the recorder captures a CANONICALIZED process.execPath
  // (on macOS /var → /private/var), so compare canonical-to-canonical or /var vs
  // /private/var yields a false mismatch (FG-556 class).
  assert.equal(realpathSync(underAlt.runtime!.execPath), realpathSync(altNode), "recorder run by the ALT node records the ALT node — captured from inside, not copied from R1");
  assert.notEqual(underAlt.runtime!.execPath, underReal.runtime!.execPath, "two recorders, two interpreters, two values — a copy-from-R1 recorder cannot do this");
});

test("FG-569 R2 (MUTANT killed): one launcher, two recorders with different release env record DIFFERENT release ids", () => {
  const a = runRecorder({ env: { ...process.env, FORGE_RELEASE_ID: "rel-A" } });
  const b = runRecorder({ env: { ...process.env, FORGE_RELEASE_ID: "rel-B" } });
  assert.equal(a.runtime!.releaseId, "rel-A");
  assert.equal(b.runtime!.releaseId, "rel-B");
  assert.notEqual(a.runtime!.releaseId, b.runtime!.releaseId, "each recorder read its own env — a value copied from the single R1 could not differ");
});

test("FG-569 R2: no release env ⇒ releaseId is null, never fabricated", () => {
  const env = { ...process.env };
  delete env.FORGE_RELEASE_ID;
  const { runtime } = runRecorder({ env });
  assert.equal(runtime!.releaseId, null);
});
