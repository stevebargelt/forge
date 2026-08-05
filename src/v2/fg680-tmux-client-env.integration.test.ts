// FG-680: the ENFORCEMENT half of the tmux socket isolation — what the harness does when a
// foreign socket is actually present in the environment.
//
// `fg614-tmux-socket-isolation.test.ts` asserts the mechanism is ARMED (TMUX_TMPDIR is set to
// a per-process dir). That assertion passes with this bug present, because TMUX_TMPDIR is not
// what a bare tmux client obeys: given neither -L nor -S it resolves its socket from $TMUX
// first, and only falls back to TMUX_TMPDIR when $TMUX is unset. Run the suite inside a tmux
// pane — what `forge launch run` creates — and $TMUX names the OPERATOR's default socket, so
// src/test-setup.ts's exit-hook `tmux kill-server` took down the operator's server and every
// live launch, review and campaign on it.
//
// So this file does not check which socket is used when nothing competes. It hands a test
// process a $TMUX naming a REAL server it must never touch, and checks that server is still
// alive afterwards.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const testSetup = resolve(repoRoot, "src", "test-setup.ts");
const skipNoTmux = spawnSync("tmux", ["-V"], { encoding: "utf8" }).status === 0 ? false : "tmux not available";

/** A test process as the harness really starts one, with `env` layered over this one's. */
function runTestProcess(script: string, env: NodeJS.ProcessEnv): { status: number | null; stdout: string; stderr: string } {
  const scratch = mkdtempSync("/tmp/fg680-child-");
  const file = join(scratch, "child.mjs");
  writeFileSync(file, script);
  try {
    const r = spawnSync(process.execPath, ["--import", "tsx", "--import", testSetup, file], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

test("FG-680: a test process started inside a tmux pane cannot resolve the pane's server — TMUX is deleted", () => {
  const run = runTestProcess(
    `console.log(JSON.stringify({ tmux: process.env.TMUX ?? null, tmpdir: process.env.TMUX_TMPDIR ?? null }))`,
    { TMUX: "/private/tmp/tmux-501/default,4242,0" },
  );

  assert.equal(run.status, 0, `the child should exit clean: ${run.stderr}`);
  const seen = JSON.parse(run.stdout.trim()) as { tmux: string | null; tmpdir: string | null };
  assert.equal(
    seen.tmux,
    null,
    "src/test-setup.ts must DELETE TMUX. Left set, every tmux client in the suite that names no socket resolves " +
      "the operator's server from it — TMUX_TMPDIR is consulted only when TMUX is unset (FG-680).",
  );
  assert.match(seen.tmpdir ?? "", /forge-test-tmux-/, "and the private socket dir is still the fallback the isolation relies on");
});

test("FG-680: the suite's cleanup never reaches the server named by an inherited TMUX", { skip: skipNoTmux }, () => {
  // The stand-in for the operator's server: a real tmux server on a socket of this test's
  // own, addressed by explicit -S so nothing about the environment can move it.
  const sentinelDir = mkdtempSync("/tmp/fg680-sent-");
  const sentinel = join(sentinelDir, "sock");
  const start = spawnSync("tmux", ["-S", sentinel, "new-session", "-d", "-s", "fg680-sentinel", "cat"], {
    encoding: "utf8",
    env: { ...process.env },
  });
  assert.equal(start.status, 0, `the sentinel server should start: ${start.stderr}`);
  const pid = execFileSync("tmux", ["-S", sentinel, "display-message", "-p", "#{pid}"], { encoding: "utf8", env: { ...process.env } }).trim();

  try {
    // `-L default` names the socket a bare client WOULD use — its directory comes from
    // TMUX_TMPDIR and it ignores $TMUX. So the child's private socket dir is non-empty in
    // BOTH arms of this test, which is what makes the exit hook's kill-server actually run
    // whether or not the fix is in place. Without that, an unfixed harness would simply skip
    // the kill and the test would pass vacuously.
    const run = runTestProcess(
      `import { spawnSync } from "node:child_process";\n` +
        `const r = spawnSync("tmux", ["-L", "default", "new-session", "-d", "-s", "fg680-private", "cat"], { encoding: "utf8" });\n` +
        `console.log(JSON.stringify({ started: r.status, stderr: r.stderr }));\n`,
      { TMUX: `${sentinel},${pid},0` },
    );
    assert.equal(run.status, 0, `the child should exit clean: ${run.stderr}`);
    const child = JSON.parse(run.stdout.trim()) as { started: number | null; stderr: string };
    assert.equal(child.started, 0, `the child must really start a server on its private socket, or the exit hook is never exercised: ${child.stderr}`);

    const alive = spawnSync("tmux", ["-S", sentinel, "ls"], { encoding: "utf8", env: { ...process.env } });
    assert.equal(
      alive.status,
      0,
      "the test process's exit hook killed the server named by the INHERITED TMUX rather than its own. " +
        "That server is the operator's whenever the suite runs inside a tmux pane, and taking it down kills every " +
        "live launch, review and campaign on it (FG-680). src/test-setup.ts must delete TMUX alongside relocating TMUX_TMPDIR.",
    );
    assert.match(alive.stdout, /fg680-sentinel/, "and the session it was holding is still there");
  } finally {
    spawnSync("tmux", ["-S", sentinel, "kill-server"], { stdio: "ignore", env: { ...process.env } });
    rmSync(sentinelDir, { recursive: true, force: true });
  }
});
