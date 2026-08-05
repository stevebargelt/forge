// FG-680: the harness must scrub TMUX before it spawns the real forge CLI too.
// A bare-client proof is necessary but insufficient: `forge launch run` is the
// operator flow that creates a tmux pane, and it inherits the test process env.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const testSetup = resolve(repoRoot, "src", "test-setup.ts");
const cli = resolve(repoRoot, "src", "cli", "index.ts");
const skipNoTmux = spawnSync("tmux", ["-V"], { encoding: "utf8" }).status === 0 ? false : "tmux not available";

function runHarnessChild(script: string, env: NodeJS.ProcessEnv): { status: number | null; stdout: string; stderr: string } {
  const scratch = mkdtempSync("/tmp/fg680-cli-child-");
  const file = join(scratch, "child.mjs");
  writeFileSync(file, script);
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--import", testSetup, file], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

test("FG-680: a real forge launch subprocess cannot inherit and use a pane's TMUX server", { skip: skipNoTmux }, () => {
  const sentinelDir = mkdtempSync("/tmp/fg680-cli-sentinel-");
  const forgeHome = mkdtempSync("/tmp/fg680-cli-home-");
  const sentinel = join(sentinelDir, "sock");
  const start = spawnSync("tmux", ["-S", sentinel, "new-session", "-d", "-s", "fg680-cli-sentinel", "cat"], {
    encoding: "utf8",
    env: { ...process.env },
  });
  assert.equal(start.status, 0, `the stand-in operator server should start: ${start.stderr}`);
  const pid = execFileSync("tmux", ["-S", sentinel, "display-message", "-p", "#{pid}"], { encoding: "utf8", env: { ...process.env } }).trim();

  try {
    const run = runHarnessChild(
      `import { spawnSync } from "node:child_process";\n` +
        `const r = spawnSync(process.execPath, ["--import", "tsx", ${JSON.stringify(cli)}, "launch", "run", "--json", "--name", "fg680-cli", "--", "true"], { encoding: "utf8", env: { ...process.env, FORGE_HOME: ${JSON.stringify(forgeHome)} } });\n` +
        `console.log(JSON.stringify({ status: r.status, stdout: r.stdout, stderr: r.stderr }));\n`,
      { TMUX: `${sentinel},${pid},0` },
    );

    assert.equal(run.status, 0, `the harness child should exit cleanly: ${run.stderr}`);
    const child = JSON.parse(run.stdout.trim()) as { status: number | null; stdout: string; stderr: string };
    assert.equal(child.status, 0, `forge launch run must create its own tmux session, not act as a client of inherited TMUX: ${child.stderr}`);
    assert.match(child.stdout, /"tmuxSession":\s*"forge-launch-fg680-cli-/, "the real CLI reported the launch it submitted");

    // WHERE the session landed is the whole differential. Asking only whether the sentinel
    // SURVIVED proves nothing: `forge launch run` kills no server, and with TMUX retained the
    // exit hook skips its own kill-server because the private socket dir stays empty — so the
    // sentinel is alive in BOTH arms and the check passes against an unfixed harness. What
    // separates them is the pane: defaultTmux spreads the inherited env, so an unfixed harness
    // creates `forge-launch-fg680-cli-*` on the server named by TMUX — the operator's, whenever
    // the suite runs inside a pane. startLaunch sets remain-on-exit, so the session outlives the
    // launched command and is still there to be found.
    const sessions = spawnSync("tmux", ["-S", sentinel, "list-sessions", "-F", "#{session_name}"], { encoding: "utf8", env: { ...process.env } });
    assert.equal(sessions.status, 0, `the sentinel server must still be alive to be inspected: ${sessions.stderr}`);
    assert.match(sessions.stdout, /fg680-cli-sentinel/, "and the session it was holding is still there");
    assert.doesNotMatch(
      sessions.stdout,
      /forge-launch-fg680-cli-/,
      "the real forge CLI subprocess put its pane on the server named by the INHERITED TMUX. That is the operator's " +
        "server whenever the suite runs inside a pane, and the suite's own exit hook then kills it (FG-680). " +
        "src/test-setup.ts must delete TMUX so the CLI's bare tmux client resolves the private TMUX_TMPDIR socket instead.",
    );
  } finally {
    spawnSync("tmux", ["-S", sentinel, "kill-server"], { stdio: "ignore", env: { ...process.env } });
    rmSync(sentinelDir, { recursive: true, force: true });
    rmSync(forgeHome, { recursive: true, force: true });
  }
});
