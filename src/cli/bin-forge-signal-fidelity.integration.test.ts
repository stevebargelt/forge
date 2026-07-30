import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findGitRoot } from "../util/git-root.js";
import { authorityTestkitBinEnv } from "../backlog/container-authority.testkit-spawn.js";

// FG-567 / FG-569 — the LIVE control entry (bin/forge) must report its own fate
// faithfully: a signalled death is a signal, a numeric exit stays that number,
// and neither is ever laundered to 0.
//
// TIER: integration. These cases spawn the real bin/forge and kill it, so per
// FG-408 they are excluded from the fast unit tier — `npm test` does NOT run them.
// Verify with `npm run test:integration` (or `test:extended`); CI's required
// `test-extended` job gates merges on them (FG-495).
//
// FG-569 rewrote this file for EXEC-not-spawn. bin/forge is now `#!/bin/sh` that
// `exec`s node with tsx in-process — the sh process is REPLACED by node, so there
// is no wrapper between the OS signal and the process the CLI runs in. That means
// the fidelity property is a property of the REAL artifact, not a grafted harness:
// we run the ACTUAL bin/forge and read `(code, signal)` from a DIRECT child
// observer (this test process is bin/forge's parent).
//
// A regression that RE-INTRODUCED a swallowing wrapper — bin/forge spawning a node
// child and exiting `code ?? 0`, or translating a signal into a numeric 0 — would
// make the SIGKILL/SIGTERM cases below observe `{code:0}` (or a lost signal) and
// fail. The exec form is what keeps them green.

const BIN_FORGE = join(findGitRoot(process.cwd()), "bin", "forge");
let dir: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "fg567-"));
});
after(() => rmSync(dir, { recursive: true, force: true }));

// A killed wrapper that somehow stayed alive would otherwise stall `node --test`
// (no default per-test timeout). Cap each case so a regression fails loud.
const CASE = { timeout: 20_000 };

/** Run the REAL bin/forge and report what a DIRECT child observer sees of it. */
function runForge(
  args: string[],
  opts: { onSpawn?: (child: import("node:child_process").ChildProcess) => void } = {},
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((res, rej) => {
    // stdin is a pipe we hold OPEN so a stdin-reading command blocks instead of
    // seeing EOF; stdout/stderr ignored — we only care about the exit fate.
    // FG-645: the blocking case below relies on `backlog file` reaching its stdin
    // read. Inside an agent container the compiled-in authority probe REFUSES that
    // mutating verb first, so the process was already dead when the signal landed
    // and this suite reported a numeric exit for a kill it never delivered.
    const child = spawn(BIN_FORGE, args, {
      stdio: ["pipe", "ignore", "ignore"],
      env: { ...process.env, ...authorityTestkitBinEnv() },
    });
    child.on("exit", (code, signal) => res({ code, signal }));
    child.on("error", rej);
    opts.onSpawn?.(child);
  });
}

/** Spawn the REAL bin/forge on a command that BLOCKS reading stdin (so the process
 *  is genuinely long-running), let it come up, then deliver `sig` and observe. */
async function killLongRunningForge(sig: NodeJS.Signals) {
  // `backlog file --body -` reads the body from stdin (readFileSync(0)) before it
  // touches anything else, so with an open stdin pipe forge blocks there. A real
  // exec'd node process, alive until we signal it.
  return runForge(["backlog", "file", "sig-fidelity", "--body", "-", "--project", dir], {
    onSpawn: (child) => {
      // Give the exec + tsx startup a moment so the signal lands on the running
      // node process (post-exec), not the microsecond of /bin/sh before exec.
      setTimeout(() => child.kill(sig), 800);
    },
  });
}

test("bin/forge: a clean exit 0 → observer sees code=0, signal=null", CASE, async () => {
  assert.deepEqual(await runForge(["--version"]), { code: 0, signal: null });
});

test("bin/forge: a NUMERIC non-zero exit is preserved → observer sees code>0, signal=null (never a signal, never 0)", CASE, async () => {
  // An unknown subcommand makes commander exit non-zero. The point: a numeric
  // failure exit stays a NUMBER — it is neither laundered to 0 nor turned into a
  // signalled death (which is how a killed control plane must look, and only that).
  const { code, signal } = await runForge(["definitely-not-a-real-subcommand"]);
  assert.equal(signal, null, "a numeric exit is not a signalled death");
  assert.ok(typeof code === "number" && code > 0, `numeric non-zero exit preserved, got code=${code}`);
});

test("bin/forge killed by SIGTERM → observer sees code=null, signal=SIGTERM (never exit 0)", CASE, async () => {
  assert.deepEqual(await killLongRunningForge("SIGTERM"), { code: null, signal: "SIGTERM" });
});

test("bin/forge killed by SIGKILL → observer sees code=null, signal=SIGKILL (never exit 0)", CASE, async () => {
  // The reported bug shape: SIGKILL gives code=null, and a `code ?? 0` wrapper
  // turned that into a success exit — a killed control plane claiming it shipped.
  assert.deepEqual(await killLongRunningForge("SIGKILL"), { code: null, signal: "SIGKILL" });
});

test("bin/forge: the process the signal hits IS the CLI (exec, one process) — a re-introduced wrapper would launder from a grandchild", CASE, () => {
  // Signal fidelity above is only structurally guaranteed because exec leaves ONE
  // process: the process we spawn IS the one running the CLI (and loading the
  // binding). A swallowing wrapper (bin/forge spawning a tsx child and exiting
  // `code ?? 0`) would run the CLI in a grandchild — so the CLI's pid would differ
  // from the launched pid, and the `code ?? 0` launder this file guards would be
  // reachable again. Pin the single-process property so that regression fails here.
  const r = spawnSync(BIN_FORGE, ["release", "provenance", "--json"], { encoding: "utf8", env: process.env });
  assert.equal(r.status, 0, `provenance failed: ${r.stderr}`);
  assert.equal(JSON.parse(r.stdout).pid, r.pid, "the CLI's pid IS the launched pid — exec, not a spawned wrapper");
});
