// FG-535: the PRODUCTION launch path, end to end — the real `forge launch` CLI
// (Commander parsing, human + --json rendering) driving a REAL tmux server that
// really owns the process. Nothing here is stubbed: the sibling
// launch.integration.test.ts injects a TmuxRunner to pin record-keeping, but a
// stub cannot prove the two things FG-535 actually turns on — that tmux keeps
// the work alive after the submitter is gone, and that a signal-killed command
// is distinguishable from one that merely returned 143.
//
// Requires tmux (present on ubuntu-latest, where the extended tier runs).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LAUNCHES_DIR, startLaunch, type LaunchView, type TmuxRunner } from "./launch.js";

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, "..", "cli", "index.ts");
const tsx = resolve(here, "..", "..", "node_modules", ".bin", "tsx");

const started: string[] = [];

function forge(args: string[]) {
  return spawnSync(tsx, [entry, ...args], { encoding: "utf8" });
}

function launchRun(name: string, command: string[]): LaunchView {
  const res = forge(["launch", "run", "--name", name, "--json", "--", ...command]);
  assert.equal(res.status, 0, `forge launch run failed: ${res.stderr}`);
  const meta = JSON.parse(res.stdout) as LaunchView;
  started.push(meta.id);
  return meta;
}

function show(id: string): LaunchView {
  const res = forge(["launch", "show", id, "--json"]);
  assert.equal(res.status, 0, `forge launch show failed: ${res.stderr}`);
  return JSON.parse(res.stdout) as LaunchView;
}

function tmuxSessionAlive(session: string): boolean {
  return spawnSync("tmux", ["has-session", "-t", session], { encoding: "utf8" }).status === 0;
}

/** Poll a real, out-of-process condition — the tmux-owned command is nobody's
 *  child here, so there is nothing to await. */
async function waitFor(what: string, cond: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail(`timed out after ${timeoutMs}ms waiting for: ${what}`);
}

const hasTmux = spawnSync("tmux", ["-V"], { encoding: "utf8" }).status === 0;

before(() => {
  assert.ok(hasTmux, "these tests require tmux — install it (apt install tmux / brew install tmux)");
});

after(() => {
  for (const id of started) forge(["launch", "rm", id, "--force"]);
  rmSync(LAUNCHES_DIR, { recursive: true, force: true });
});

test("FG-535 CLI: a FAST command keeps its durable record and its inspectable pane (remain-on-exit is armed before the command runs)", async () => {
  // The regression this pins: when the target command was the session's own
  // command, a command that finished immediately destroyed the session before
  // remain-on-exit could be set — set-option then threw, and the error path
  // DELETED the launch record of a command that had actually run to completion.
  const meta = launchRun("fast", ["sh", "-c", "echo done-fast"]);

  await waitFor("the fast command's exit record", () => existsSync(join(LAUNCHES_DIR, meta.id, "exit")));

  const v = show(meta.id);
  assert.deepEqual(v.status, { state: "exited_ok", code: 0 }, "the completed command has a terminal record");
  assert.equal(readFileSync(v.logPath, "utf8").trim(), "done-fast");
  assert.ok(tmuxSessionAlive(meta.tmuxSession), "remain-on-exit kept the dead pane inspectable");
});

test("FG-535 tmux: a command that finishes BEFORE remain-on-exit could be armed still keeps its record", async () => {
  // The regression, forced rather than raced. When the target command WAS the
  // session's own command, a command that finished before `set-option` landed
  // destroyed the session; set-option then threw and the error path DELETED the
  // record of a command that had run to completion. Racing a fast command can't
  // prove this reliably (node's own startup usually wins the race), so this
  // stretches the window the way a loaded host would: real tmux, real process
  // ownership, with the set-option call delayed a full second. Under the
  // bootstrap-pane sequence the delay is harmless — the inert pane cannot exit,
  // so there is no window to lose.
  const slowSetOption: TmuxRunner = (args) => {
    if (args[0] === "set-option") Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
    execFileSync("tmux", args, { stdio: ["ignore", "ignore", "pipe"] });
  };

  const meta = startLaunch(["sh", "-c", "echo instant"], { name: "slowarm", tmux: slowSetOption });
  started.push(meta.id);

  await waitFor("the exit record", () => existsSync(join(LAUNCHES_DIR, meta.id, "exit")));
  const v = show(meta.id);
  assert.deepEqual(v.status, { state: "exited_ok", code: 0 }, "the completed command kept a terminal record");
  assert.equal(readFileSync(v.logPath, "utf8").trim(), "instant");
  assert.ok(existsSync(join(LAUNCHES_DIR, meta.id, "meta.json")), "the record was not deleted by a failed set-option");
  assert.ok(tmuxSessionAlive(meta.tmuxSession), "remain-on-exit was armed before the command could ever run");
});

test("FG-535 CLI: tmux owns the process — it outlives the submitting CLI call, which returns at once", async () => {
  const pidFile = join(tmpdir(), `fg535-own-${process.pid}.pid`);
  rmSync(pidFile, { force: true });

  const before = Date.now();
  const meta = launchRun("owned", ["sh", "-c", `echo $$ > ${pidFile}; exec sleep 300`]);
  const submitMs = Date.now() - before;

  // The submitting call is synchronous and short — it never owns the work.
  assert.ok(submitMs < 15_000, `forge launch run should return promptly, took ${submitMs}ms`);

  await waitFor("the launched command to report its pid", () => existsSync(pidFile));
  const pid = Number(readFileSync(pidFile, "utf8").trim());

  // The submitter has already exited; the command is still running, and it is
  // NOT a descendant of this test process — the tmux server owns it.
  process.kill(pid, 0);
  assert.equal(show(meta.id).status.state, "running");
  assert.ok(tmuxSessionAlive(meta.tmuxSession));

  const ppid = spawnSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
  assert.notEqual(Number(ppid), process.pid, "the launched process is not this process's child");

  rmSync(pidFile, { force: true });
});

test("FG-535 CLI: the persisted owner pid names the REAL live process that owns the command", async () => {
  const meta = launchRun("ownerpid", ["sleep", "300"]);

  // The record is only useful for attribution if the pid it names is the actual
  // owner: alive, owned by the tmux server, and not a child of the submitter
  // (which has already exited).
  assert.ok(typeof meta.ownerPid === "number" && meta.ownerPid > 0, `owner pid was not recorded: ${meta.ownerPid}`);
  process.kill(meta.ownerPid!, 0);

  const paneOwner = spawnSync("tmux", ["display-message", "-p", "-t", `${meta.tmuxSession}:`, "#{pane_pid}"], { encoding: "utf8" });
  assert.equal(Number(paneOwner.stdout.trim()), meta.ownerPid, "the record names the pane tmux itself owns");

  const ppid = spawnSync("ps", ["-o", "ppid=", "-p", String(meta.ownerPid)], { encoding: "utf8" }).stdout.trim();
  assert.notEqual(Number(ppid), meta.launcherPid, "the owner is not a child of the launcher");

  const human = forge(["launch", "show", meta.id]);
  assert.match(human.stdout, new RegExp(`owner:\\s+pid ${meta.ownerPid} \\(tmux pane\\)  launched by pid ${meta.launcherPid}`));
  assert.equal(show(meta.id).status.state, "running");
});

test("FG-535 CLI: a REAL SIGTERM records WIFSIGNALED evidence and still refuses to name a sender", async () => {
  const pidFile = join(tmpdir(), `fg535-term-${process.pid}.pid`);
  rmSync(pidFile, { force: true });
  const meta = launchRun("termed", ["sh", "-c", `echo $$ > ${pidFile}; exec sleep 300`]);

  await waitFor("the launched command to report its pid", () => existsSync(pidFile));
  process.kill(Number(readFileSync(pidFile, "utf8").trim()), "SIGTERM");

  await waitFor("the terminal record", () => existsSync(join(LAUNCHES_DIR, meta.id, "exit")));

  // The kernel's verdict, not a guess from a 143-shaped number.
  assert.deepEqual(JSON.parse(readFileSync(join(LAUNCHES_DIR, meta.id, "exit"), "utf8")), {
    code: null, signal: "SIGTERM",
  });
  assert.deepEqual(show(meta.id).status, { state: "signaled", signal: "SIGTERM", sender: "unrecorded" });

  const human = forge(["launch", "show", meta.id]);
  assert.match(human.stdout, /terminated by SIGTERM/);
  assert.match(human.stdout, /sender not recorded — origin unknown/,
    "FG-535 AC: attribution stays unknown when the signal sender was never captured");

  rmSync(pidFile, { force: true });
});

test("FG-535 CLI: a command that DELIBERATELY exits 143 is not reported as a kill", async () => {
  const meta = launchRun("selfexit", ["sh", "-c", "exit 143"]);
  await waitFor("the terminal record", () => existsSync(join(LAUNCHES_DIR, meta.id, "exit")));

  assert.deepEqual(show(meta.id).status, { state: "terminated_unattributed", code: 143 });

  const human = forge(["launch", "show", meta.id]);
  assert.match(human.stdout, /no signal evidence — origin unknown/);
  assert.doesNotMatch(human.stdout, /SIGTERM/, "exit 143 alone must never be read as a SIGTERM");
});

test("FG-535 CLI: list and show render the operator surface, and rm cleans up", async () => {
  const meta = launchRun("listed", ["sh", "-c", "echo hello from run-abc-123 task-engineer-9f"]);
  await waitFor("the exit record", () => existsSync(join(LAUNCHES_DIR, meta.id, "exit")));

  const list = forge(["launch", "list"]);
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, new RegExp(`${meta.id}\\s+exited 0`), list.stdout);

  const human = forge(["launch", "show", meta.id]);
  assert.match(human.stdout, new RegExp(`launch:\\s+${meta.id}`));
  assert.match(human.stdout, /status:\s+exited 0/);
  assert.match(human.stdout, /runs:\s+run-abc-123/, "forge ids are surfaced from the log");
  assert.match(human.stdout, /tasks:\s+task-engineer-9f/);
  assert.match(human.stdout, /log tail/);

  // The machine surface an orchestrator polls between turns.
  const json = show(meta.id);
  assert.deepEqual(json.command, ["sh", "-c", "echo hello from run-abc-123 task-engineer-9f"]);
  assert.deepEqual(json.forgeIds, { runIds: ["run-abc-123"], taskIds: ["task-engineer-9f"] });
  assert.ok(json.startedAt && json.tmuxSession && json.logPath && json.cwd);

  const rm = forge(["launch", "rm", meta.id]);
  assert.equal(rm.status, 0, rm.stderr);
  assert.ok(!existsSync(join(LAUNCHES_DIR, meta.id)), "the record is gone");
  assert.ok(!tmuxSessionAlive(meta.tmuxSession), "the remain-on-exit pane is cleaned up");
});

test("FG-535 CLI: rm refuses a RUNNING launch without --force — removal must never be what kills the work", () => {
  const meta = launchRun("guarded", ["sleep", "300"]);

  const refused = forge(["launch", "rm", meta.id]);
  assert.notEqual(refused.status, 0, "removing a running launch must fail");
  assert.match(refused.stderr, /still running/);
  assert.ok(existsSync(join(LAUNCHES_DIR, meta.id)), "the record survives the refused removal");
  assert.ok(tmuxSessionAlive(meta.tmuxSession), "and so does the work");

  assert.equal(forge(["launch", "rm", meta.id, "--force"]).status, 0);
  assert.ok(!tmuxSessionAlive(meta.tmuxSession));
});
