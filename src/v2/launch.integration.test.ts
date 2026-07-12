// FG-535: the durable launcher's persisted-record lifecycle over the real
// filesystem (FORGE_HOME is test-scoped via test-setup), with an injectable
// tmux runner — the REAL tmux ownership is validated live (the AC's >10-minute
// representative run), this file pins what any later session can read back:
// meta persistence, derived status in every state, and removal safety.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  LAUNCHES_DIR,
  listLaunches,
  readLaunch,
  removeLaunch,
  startLaunch,
  type TmuxRunner,
} from "./launch.js";

/** tmux stub: records calls; `has-session` consults a mutable alive set. */
function tmuxStub(alive: Set<string> = new Set()): { tmux: TmuxRunner; calls: string[][]; alive: Set<string> } {
  const calls: string[][] = [];
  const tmux: TmuxRunner = (args) => {
    calls.push(args);
    if (args[0] === "has-session") {
      const session = args[2]!;
      if (!alive.has(session)) throw new Error("no such session");
    }
    if (args[0] === "new-session") alive.add(args[args.indexOf("-s") + 1]!);
    if (args[0] === "kill-session") alive.delete(args[args.indexOf("-t") + 1]!);
  };
  return { tmux, calls, alive };
}

beforeEach(() => {
  rmSync(LAUNCHES_DIR, { recursive: true, force: true });
});

test("FG-535 start: persists meta.json (command, session, start time, log path) and hands ownership to tmux with remain-on-exit", () => {
  const { tmux, calls } = tmuxStub();
  const meta = startLaunch(["forge", "review-loop", "FG-1"], { name: "loop", tmux });

  assert.match(meta.id, /^launch-loop-[a-z0-9]{6}$/);
  assert.equal(meta.tmuxSession, `forge-${meta.id}`);
  assert.ok(existsSync(join(LAUNCHES_DIR, meta.id, "meta.json")));

  const persisted = readLaunch(meta.id, tmux)!;
  assert.deepEqual(persisted.command, ["forge", "review-loop", "FG-1"]);
  assert.equal(persisted.status.state, "running", "no exit file + live session = running");

  const newSession = calls.find((c) => c[0] === "new-session")!;
  assert.ok(newSession.includes("-d"), "the session is detached — the submitter never owns the process");
  assert.ok(calls.some((c) => c[0] === "set-option" && c.includes("remain-on-exit")));
});

test("FG-535 status: the exit file is authoritative — 0 reads exited_ok, 143 reads externally_terminated SIGTERM", () => {
  const { tmux } = tmuxStub();
  const ok = startLaunch(["true"], { name: "ok", tmux });
  const killed = startLaunch(["sleep", "600"], { name: "killed", tmux });
  writeFileSync(join(LAUNCHES_DIR, ok.id, "exit"), "0\n");
  writeFileSync(join(LAUNCHES_DIR, killed.id, "exit"), "143\n");

  assert.deepEqual(readLaunch(ok.id, tmux)!.status, { state: "exited_ok", code: 0 });
  assert.deepEqual(readLaunch(killed.id, tmux)!.status, { state: "externally_terminated", code: 143, signal: "SIGTERM" });
});

test("FG-535 status: no exit record and no live session is UNKNOWN — never guessed into a terminal claim", () => {
  const stub = tmuxStub();
  const meta = startLaunch(["sleep", "600"], { name: "rebooted", tmux: stub.tmux });
  stub.alive.clear(); // the tmux server died (host reboot) without the wrapper writing exit

  assert.deepEqual(readLaunch(meta.id, stub.tmux)!.status, { state: "unknown" });
});

test("FG-535 forge ids: extracted from the log when present", () => {
  const { tmux } = tmuxStub();
  const meta = startLaunch(["forge", "invoke", "engineer"], { name: "ids", tmux });
  writeFileSync(meta.logPath, "created run-abc-123 with task-engineer-9f\n");

  assert.deepEqual(readLaunch(meta.id, tmux)!.forgeIds, {
    runIds: ["run-abc-123"],
    taskIds: ["task-engineer-9f"],
  });
});

test("FG-535 list: returns every persisted launch, oldest first", () => {
  const { tmux } = tmuxStub();
  startLaunch(["a"], { name: "one", tmux, now: new Date("2026-07-11T01:00:00Z") });
  startLaunch(["b"], { name: "two", tmux, now: new Date("2026-07-11T02:00:00Z") });

  const all = listLaunches(tmux);
  assert.equal(all.length, 2);
  assert.match(all[0]!.id, /^launch-one-/);
  assert.match(all[1]!.id, /^launch-two-/);
});

test("FG-535 rm: refuses a RUNNING launch without --force — removal must never be what kills the work", () => {
  const { tmux } = tmuxStub();
  const meta = startLaunch(["sleep", "600"], { name: "live", tmux });

  assert.throws(() => removeLaunch(meta.id, { tmux }), /still running .* --force/);
  assert.ok(existsSync(join(LAUNCHES_DIR, meta.id)), "the record survives the refused removal");

  removeLaunch(meta.id, { force: true, tmux });
  assert.equal(readLaunch(meta.id, tmux), undefined);
});

test("FG-535 rm: a finished launch removes cleanly and kills the remain-on-exit session remains", () => {
  const stub = tmuxStub();
  const meta = startLaunch(["true"], { name: "done", tmux: stub.tmux });
  writeFileSync(join(LAUNCHES_DIR, meta.id, "exit"), "0\n");

  removeLaunch(meta.id, { tmux: stub.tmux });
  assert.equal(readLaunch(meta.id, stub.tmux), undefined);
  assert.ok(stub.calls.some((c) => c[0] === "kill-session"), "the dead-pane session is cleaned up");
});

test("FG-535 start: refuses when tmux is unavailable, before writing anything", () => {
  const noTmux: TmuxRunner = () => { throw new Error("not found"); };
  assert.throws(() => startLaunch(["true"], { tmux: noTmux }), /requires tmux/);
  assert.ok(!existsSync(LAUNCHES_DIR) || listLaunches(noTmux).length === 0);
});

test("FG-535: LAUNCHES_DIR is test-scoped, not the real home", () => {
  // test-setup points FORGE_HOME at a scratch dir; guard the suite against
  // ever writing launch records into the operator's real ~/.forge.
  assert.ok(!LAUNCHES_DIR.startsWith(join(process.env.HOME ?? "/nonexistent", ".forge")), LAUNCHES_DIR);
  mkdirSync(LAUNCHES_DIR, { recursive: true }); // and it is writable where it points
});
