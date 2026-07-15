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
import { buildRelease, type BuildReleaseResult } from "./release.js";
import { findGitRoot } from "../util/git-root.js";

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

// The END-TO-END proof the review-loop demanded: the prior tests inject
// FORGE_RELEASE_ID by hand, so they'd pass even if NOTHING in a real release set
// it (the confirmed bug — releaseId was null in production). This test BUILDS a
// real release and starts a launch THROUGH its generated entry, with NOBODY
// injecting the env var: the entry itself must export it from its own manifest,
// forge must forward it into the tmux session, and the recorder must capture it.
// The launch runs against a PRE-EXISTING tmux server started WITHOUT the var — the
// realistic operator case, and the exact one where naive client-env inheritance
// fails — so a green result proves the id reached the recorder by design, not luck.
const hasTmux = spawnSync("tmux", ["-V"], { encoding: "utf8" }).status === 0;

test("FG-569 R2 (END-TO-END, through a BUILT release entry): the recorder records the release's manifest id — not null, not injected", { skip: hasTmux ? false : "tmux not available" }, async () => {
  const sourceRoot = findGitRoot(process.cwd());
  const releaseDir = join(scratch, "e2e-release");
  const built: BuildReleaseResult = buildRelease({ sourceRoot, outDir: releaseDir });

  // An ISOLATED tmux server, started WITHOUT FORGE_RELEASE_ID in its environment —
  // this is what makes the test meaningful: on an already-running server tmux does
  // not copy an arbitrary client env var into a new session, so only forge's
  // explicit `new-session -e` forwarding can carry the id to the recorder.
  const tmuxTmpdir = mkdtempSync(join(scratch, "tmux-"));
  const serverEnv = { ...process.env };
  delete serverEnv.FORGE_RELEASE_ID;
  serverEnv.TMUX_TMPDIR = tmuxTmpdir;
  assert.equal(
    spawnSync("tmux", ["new-session", "-d", "-s", "fg569-pre", "cat"], { env: serverEnv, encoding: "utf8" }).status,
    0,
    "pre-existing tmux server (without FORGE_RELEASE_ID) should start",
  );

  try {
    const forgeHome = mkdtempSync(join(scratch, "home-"));
    // Run the launch THROUGH the built release entry. The entry (not this test)
    // exports FORGE_RELEASE_ID from its own manifest before exec'ing node.
    const entryEnv = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: process.env.HOME ?? "/tmp",
      FORGE_HOME: forgeHome,
      TMUX_TMPDIR: tmuxTmpdir,
    };
    const run = spawnSync(built.entryPath, ["launch", "run", "--name", "r2e2e", "--json", "--", "true"], { env: entryEnv, encoding: "utf8" });
    assert.equal(run.status, 0, `forge launch run through the release entry failed: ${run.stderr}`);
    const view = JSON.parse(run.stdout) as { id: string };
    assert.match(view.id, /^launch-r2e2e-/, `unexpected launch id: ${run.stdout}`);

    const rtPath = join(forgeHome, "launches", view.id, "runtime.json");
    const deadline = Date.now() + 20_000;
    while (!existsSync(rtPath) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.ok(existsSync(rtPath), "the recorder wrote runtime.json (its first act inside the tmux pane)");

    const runtime = parseRecorderRuntime(readFileSync(rtPath, "utf8"));
    assert.ok(runtime, "runtime.json parses as an R2 record");
    assert.equal(runtime!.releaseId, built.manifest.id, "the recorder captured THIS release's id — sourced from the entry's manifest, forwarded through tmux");
    assert.notEqual(runtime!.releaseId, null, "R2 release-id is live for a real release, not the null the bug shipped");
  } finally {
    spawnSync("tmux", ["kill-server"], { env: serverEnv, encoding: "utf8" });
  }
});
