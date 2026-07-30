import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempHome = mkdtempSync(join(tmpdir(), "forge-test-"));
process.env["FORGE_HOME"] = tempHome;

// FG-621: no test may read the OPERATOR's global git config. A `git clone`
// inherits none of the source repo's LOCAL config, so every commit made in a
// task's private clone resolves its identity from the global file — which exists
// on a developer machine and does NOT exist on a CI runner. That difference made
// the worktree tier pass locally and fail on CI, and it made a green local run
// worthless as evidence. Neutralizing the global file here makes every host agree
// with the runner, so identity must be supplied explicitly at each commit site
// (as the agent container does via GIT_AUTHOR_*/GIT_COMMITTER_*) instead of being
// silently borrowed. Deliberately NOT setting GIT_AUTHOR_*/GIT_COMMITTER_* here:
// a blanket identity would also satisfy Forge's OWN commits and stop the suite
// from proving they carry one.
//
// An empty REAL file, not /dev/null: a fixture that legitimately writes global
// config (`git config --global ...`, as the release-build suites do) must still
// succeed, and a write to /dev/null fails. This file is empty and lives in the
// per-process temp home, so it starts with no identity and dies with the run.
const gitConfigGlobal = join(tempHome, "gitconfig");
writeFileSync(gitConfigGlobal, "");
process.env["GIT_CONFIG_GLOBAL"] = gitConfigGlobal;

// FG-614: NO test may touch the DEFAULT tmux socket. The tmux server is a host-wide
// daemon that outlives every session and holds ONE working directory — the first
// client's. A test that starts a session on the default socket from a fixture dir it
// later deletes therefore bricks the operator's server: every later `forge launch run`
// dies at node bootstrap (ENOENT/uv_cwd) and recovery costs a `tmux kill-server` that
// also kills unrelated live work. That is exactly the FG-614 incident.
//
// TMUX_TMPDIR relocates the socket DIRECTORY, so every tmux client in this test process
// — including the CLI subprocesses tests spawn, which inherit this env — reaches a
// server private to this process. `/tmp` rather than os.tmpdir() on purpose: a unix
// socket path has a ~104-char limit and macOS's per-user tmpdir eats most of it.
const tmuxTmpdir = mkdtempSync("/tmp/forge-test-tmux-");
process.env["TMUX_TMPDIR"] = tmuxTmpdir;

// FG-374: integration tests use hardcoded /tmp/<name> project dirs as
// placeholders. With preflightProjectMount now active on both invoke and
// runNext paths, these dirs must exist before any test runs.
for (const dir of [
  "/tmp/test-project",
  "/tmp/x",
  "/tmp/proj",
  "/tmp/some-project",
  "/tmp/integ-manifest-project",
  "/tmp/fg364-test-project",
  "/tmp/fg368-test-project",
  "/tmp/fg371-test-project",
  "/tmp/fg371-retry-once-test",
]) {
  mkdirSync(dir, { recursive: true });
}

// #198: silence notifications for the whole suite via the explicit, provider-
// agnostic kill switch. NO_NOTIFY=true short-circuits isAnyProviderEnabled() and
// dispatch() regardless of FORGE_NOTIFY / NTFY_URL / TWILIO_* — so even a test
// that sets a provider env won't fire a REAL push. This is the explicit
// successor to #175's implicit "clear FORGE_NOTIFY" trick (kept below as
// defense-in-depth). #170 isolated the test DB; this isolates the notification
// side-effect.
process.env["NO_NOTIFY"] = "true";
process.env["FORGE_NOTIFY"] = "";

// FG-636: NO ambient worktree PRODUCTION switch may reach the suite. These three
// decide whether dispatch takes the git-worktree path at all
// (isWorktreeModeEnabled, src/v2/worktree-lifecycle.ts), and the tests dispatch
// against mkdtemp project dirs with no `.git` — so an inherited FORGE_WORKTREES=1
// aborts worktree creation and the task manifest is never written. That is not
// hypothetical: the integration gate spread the orchestrator's whole environment
// into the candidate's test child, a wave launched as
// `env FORGE_WORKTREES=1 forge next …` turned the switch on, and nine tests
// "failed" on a candidate containing no code change. The gate no longer leaks
// them; clearing here means no launcher's ambient value can decide a test outcome.
// Safe because every worktree-tier test sets its own value INSIDE the test rather
// than reading an ambient one.
//
// FG-345: FORGE_WORKTREES is PINNED to explicit-off rather than cleared, because
// clearing it no longer means "off" — the production default is now PLATFORM-
// dependent (darwin on, else off). Left ambient, ~39 unit-tier files that dispatch
// without setting either switch would take the worktree path on the macOS host,
// hit preflightWorktreeGate against a `.git`-less mkdtemp dir, and throw — while
// CI, which runs on Linux, stayed green. A suite whose outcome depends on
// process.platform is not evidence, so it is pinned to one value on every host.
// It must be this variable and not FORGE_NO_WORKTREES: the kill switch outranks
// everything, so it would also disable the ~42 worktree-tier files that legitimately
// opt in with `process.env.FORGE_WORKTREES = "1"` inside the test. Pinning the same
// variable they assign means their assignment still wins.
//
// An explicit named list, deliberately NOT a blanket FORGE_* deletion: harness
// INPUTS are legitimate and must survive — FORGE_TEST_PRINT_CMD is one. Only
// production behavior switches belong below. FORGE_WORKTREES_EPHEMERAL is not here
// on purpose — it only affects cleanup once worktree mode is already engaged,
// which these three now prevent.
for (const key of ["FORGE_NO_WORKTREES", "FORGE_WORKTREE_IGNORE_DIRTY"]) {
  delete process.env[key];
}
process.env["FORGE_WORKTREES"] = "0";

process.on("exit", () => {
  try {
    rmSync(tempHome, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
  // FG-614: this process's OWN tmux server dies with this process. Killing it here is
  // safe precisely because the socket is private — it can never reach the operator's
  // server, which is the whole point of the isolation above. tmux creates its
  // `tmux-<uid>/` socket dir on first use, so an empty dir means no server was ever
  // started and the subprocess is skipped (most test files never touch tmux).
  try {
    if (readdirSync(tmuxTmpdir).length > 0) {
      spawnSync("tmux", ["kill-server"], { stdio: "ignore", env: { ...process.env, TMUX_TMPDIR: tmuxTmpdir } });
    }
  } catch {
    // no socket dir to read, or no tmux on this host
  }
  try {
    rmSync(tmuxTmpdir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});
