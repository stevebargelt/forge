// FG-626 (AC3): the per-invocation FORGE_ env must reach the launched workload through
// the REAL launch path — a real tmux session and a real ~/.forge/launches record. A stub
// proves the `-e` args are built; only a real recorder spawning the real workload proves
// the variable actually lands in the workload's environment (the gate is armed).
//
// tmux isolation contract (src/test-setup.ts, FG-614/FG-680): the suite DELETES TMUX and
// relocates TMUX_TMPDIR so nothing here can touch the operator's server. Every server this
// file starts lives on a socket of its OWN (its own TMUX_TMPDIR) and is killed on teardown.
// kill-server is only ever run against those private sockets — never an inherited one.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LAUNCHES_DIR, controlRuntimeProfile, readLaunch, startLaunch, type TmuxRunner } from "./launch.js";

const here = dirname(fileURLToPath(import.meta.url));
import { NODE_EXEC as tsx, BUILT_CLI_ENTRY as entry } from "../integration-cli-spawn.js";

const hasTmux = spawnSync("tmux", ["-V"], { encoding: "utf8" }).status === 0;

const scratch = mkdtempSync(join(tmpdir(), "fg626-"));
const sockets: string[] = [];

after(() => {
  for (const dir of sockets) {
    // Each server lives on its OWN socket dir (TMUX_TMPDIR) — this kill-server can only
    // reach that private server, never an inherited one.
    spawnSync("tmux", ["kill-server"], { stdio: "ignore", env: { ...process.env, TMUX_TMPDIR: dir } });
    rmSync(dir, { recursive: true, force: true });
  }
  rmSync(scratch, { recursive: true, force: true });
});

/** A TmuxRunner bound to a fresh private socket of this test's own — the session
 *  new-session creates lives there, killed in teardown. Never the operator's server. */
function privateTmux(): TmuxRunner {
  const sock = mkdtempSync("/tmp/fg626-sock-");
  sockets.push(sock);
  const env = { ...process.env, TMUX_TMPDIR: sock };
  return (args) => execFileSync("tmux", args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", env });
}

/** Poll a real, out-of-process condition — a tmux-owned command is nobody's child. */
async function waitFor(what: string, cond: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail(`timed out after ${timeoutMs}ms waiting for: ${what}`);
}

test(
  "FG-626 (AC3): FORGE_WORKTREES=1 on a forge launch run invocation REACHES the launched workload — through the real tmux/recorder path",
  { skip: hasTmux ? false : "tmux not available" },
  async () => {
    const tmux = privateTmux();
    const recorded = mkdtempSync(join(scratch, "ac3-"));
    // The workload reports the value of the gate it actually sees. Pre-fix the session
    // inherited only the tmux server's startup env, so FORGE_WORKTREES was ABSENT.
    const meta = startLaunch(
      [process.execPath, "-e", "process.stdout.write('FORGE_WORKTREES=' + (process.env.FORGE_WORKTREES ?? 'ABSENT'))"],
      { name: "fg626ac3", cwd: recorded, tmux, env: { ...process.env, FORGE_WORKTREES: "1" } },
    );

    await waitFor("the launch's exit record", () => existsSync(join(LAUNCHES_DIR, meta.id, "exit")));
    const v = readLaunch(meta.id, tmux)!;
    assert.deepEqual(v.status, { state: "exited_ok", code: 0 }, "the workload ran to completion");
    assert.match(
      readFileSync(v.logPath, "utf8"),
      /FORGE_WORKTREES=1/,
      "the gate value reached the workload's environment through the real launch path — not silently dropped",
    );

    // And the forwarded set is durably recorded for audit.
    assert.ok(
      meta.forwardedEnv?.forwarded.some((f) => f.name === "FORGE_WORKTREES" && f.value === "1"),
      "the forwarded gate is recorded on the launch record",
    );
  },
);

test(
  "FG-626 (AC1 warning): forge launch run WARNS on stderr, naming a FORGE_ var that will not survive (FORGE_RELEASE_ID) — no silent drop",
  { skip: hasTmux ? false : "tmux not available" },
  () => {
    const sock = mkdtempSync("/tmp/fg626-sock-");
    sockets.push(sock);
    const recorded = mkdtempSync(join(scratch, "warn-"));
    // The real CLI, on a private tmux socket, with a caller-supplied FORGE_RELEASE_ID —
    // the one FORGE_ var forge refuses to forward. The operator must be TOLD.
    const r = spawnSync(tsx, [entry, "launch", "run", "--name", "fg626warn", "--json", "--", process.execPath, "-e", "0"], {
      encoding: "utf8",
      cwd: recorded,
      env: { ...process.env, TMUX_TMPDIR: sock, FORGE_RELEASE_ID: "poison-release-id" },
    });
    assert.equal(r.status, 0, `launch run failed: ${r.stderr}`);
    assert.match(r.stderr, /FORGE_RELEASE_ID/, "the operator is warned, BY NAME, that FORGE_RELEASE_ID will not survive");
    assert.match(r.stderr, /not forwarded|will not survive/i, "the warning states it did not survive");

    // --json stdout stays clean: the warning is on stderr, and the record shows the drop.
    const meta = JSON.parse(r.stdout) as { forwardedEnv?: { dropped: { name: string }[] } };
    assert.ok(
      meta.forwardedEnv?.dropped.some((d) => d.name === "FORGE_RELEASE_ID"),
      "the drop is durably recorded on the launch (audit), not only printed",
    );
  },
);

test(
  "FG-706: a bare node workload uses the recorder's pinned PATH for both R3 and execution despite a pre-existing hostile tmux-server PATH",
  { skip: hasTmux ? false : "tmux not available" },
  async () => {
    // Start this server ourselves, before invoking forge, so its PATH is conclusively
    // hostile. This is the real failure shape: `new-session -e PATH=…` does not replace
    // this server value for a respawned pane. The socket is private and recorded in
    // `sockets`, so teardown can only kill this test's server.
    const sock = mkdtempSync("/tmp/fg706-sock-");
    const hostileBin = mkdtempSync(join(scratch, "hostile-bin-"));
    const hostileNodeRan = join(hostileBin, "ambient-node-ran");
    const serverPath = `${hostileBin}:${process.env.PATH ?? "/usr/bin:/bin"}`;
    sockets.push(sock);
    writeFileSync(
      join(hostileBin, "node"),
      `#!/bin/sh\nprintf ambient-node-ran > ${JSON.stringify(hostileNodeRan)}\nexec ${JSON.stringify(process.execPath)} "$@"\n`,
    );
    chmodSync(join(hostileBin, "node"), 0o755);
    const serverEnv = { ...process.env, TMUX_TMPDIR: sock, PATH: serverPath };
    assert.equal(
      spawnSync("tmux", ["new-session", "-d", "-s", "fg706-hostile-server", "cat"], { encoding: "utf8", env: serverEnv }).status,
      0,
      "the private tmux server with the hostile PATH starts",
    );
    const tmux: TmuxRunner = (args) => execFileSync("tmux", args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", env: serverEnv });
    const profile = controlRuntimeProfile({ label: "control-runtime" });
    const recorded = mkdtempSync(join(scratch, "fg706-pinned-"));
    const meta = startLaunch(
      ["node", "-e", "process.stdout.write('WORKLOAD_PATH=' + process.env.PATH + '\\nWORKLOAD_EXEC=' + process.execPath + '\\n')"],
      { name: "fg706pinned", cwd: recorded, tmux, profile },
    );

    await waitFor("the profiled hostile-server launch to exit", () => existsSync(join(LAUNCHES_DIR, meta.id, "exit")));
    const view = readLaunch(meta.id, tmux)!;
    const log = readFileSync(view.logPath, "utf8");
    const observedPath = log.match(/WORKLOAD_PATH=(.*)/)?.[1];
    const observedExec = log.match(/WORKLOAD_EXEC=(.*)/)?.[1];
    assert.equal(view.status.state, "exited_ok", "the bare-node workload completed under the profile");
    assert.equal(observedPath, profile.path, "the WORKLOAD observed the pinned PATH, never the hostile tmux-server PATH");
    assert.equal(observedPath!.split(":")[0], dirname(process.execPath), "the workload PATH begins with forge's control-node directory");
    assert.equal(view.workload?.r3.kind, "derived", "bare argv[0] is resolved by the recorder as derived R3");
    assert.equal(view.workload?.r3.kind === "derived" ? view.workload.r3.execPath : undefined, observedExec, "R3 records the same node executable that the workload actually ran");
    assert.equal(observedExec, process.execPath, "the pinned resolver selected forge's control node, not the hostile server's node");
    assert.equal(existsSync(hostileNodeRan), false, "the hostile tmux-server node was never invoked for either the probe or workload");
  },
);

test(
  "FG-706: without --require-control-toolchain the workload retains the pre-existing tmux-server PATH",
  { skip: hasTmux ? false : "tmux not available" },
  async () => {
    const sock = mkdtempSync("/tmp/fg706-unprofiled-sock-");
    const hostileBin = mkdtempSync(join(scratch, "unprofiled-bin-"));
    const serverPath = `${hostileBin}:${process.env.PATH ?? "/usr/bin:/bin"}`;
    sockets.push(sock);
    const serverEnv = { ...process.env, TMUX_TMPDIR: sock, PATH: serverPath };
    assert.equal(
      spawnSync("tmux", ["new-session", "-d", "-s", "fg706-unprofiled-server", "cat"], { encoding: "utf8", env: serverEnv }).status,
      0,
      "the private unprofiled tmux server starts",
    );
    const tmux: TmuxRunner = (args) => execFileSync("tmux", args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", env: serverEnv });
    const recorded = mkdtempSync(join(scratch, "fg706-unprofiled-"));
    const meta = startLaunch(
      [process.execPath, "-e", "process.stdout.write('WORKLOAD_PATH=' + process.env.PATH + '\\n')"],
      { name: "fg706unprofiled", cwd: recorded, tmux },
    );

    await waitFor("the unprofiled hostile-server launch to exit", () => existsSync(join(LAUNCHES_DIR, meta.id, "exit")));
    const view = readLaunch(meta.id, tmux)!;
    const observedPath = readFileSync(view.logPath, "utf8").match(/WORKLOAD_PATH=(.*)/)?.[1];
    assert.equal(view.status.state, "exited_ok", "the unprofiled workload completed");
    assert.equal(observedPath, serverPath, "without a profile, forge leaves the workload PATH inherited from its tmux server");
    assert.equal(view.workload?.profile, undefined, "no control-toolchain profile is fabricated for an unprofiled launch");
  },
);
