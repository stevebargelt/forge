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

/** tmux stub: records calls; `has-session` consults a mutable alive set;
 *  `display-message` answers by format — pane pid, or pane_dead from the
 *  mutable deadPanes set. */
function tmuxStub(alive: Set<string> = new Set()): { tmux: TmuxRunner; calls: string[][]; alive: Set<string>; deadPanes: Set<string> } {
  const calls: string[][] = [];
  const deadPanes = new Set<string>();
  const tmux: TmuxRunner = (args) => {
    calls.push(args);
    if (args[0] === "has-session") {
      const session = args[2]!;
      if (!alive.has(session)) throw new Error("no such session");
    }
    if (args[0] === "new-session") alive.add(args[args.indexOf("-s") + 1]!);
    if (args[0] === "kill-session") alive.delete(args[args.indexOf("-t") + 1]!);
    if (args[0] === "display-message") {
      const target = args[args.indexOf("-t") + 1]!.replace(/:$/, "");
      if (args.includes("#{pane_dead}")) return deadPanes.has(target) ? "1\n" : "0\n";
      return "4242\n";
    }
  };
  return { tmux, calls, alive, deadPanes };
}

function names(calls: string[][]): string[] {
  return calls.map((c) => c[0]!);
}

beforeEach(() => {
  rmSync(LAUNCHES_DIR, { recursive: true, force: true });
});

test("FG-535 start: persists meta.json (command, session, start time, log path) and hands ownership to tmux with remain-on-exit", () => {
  const { tmux, calls } = tmuxStub();
  const meta = startLaunch(["forge", "review-loop", "FG-1"], { name: "loop", tmux });
  const startup = [...calls];

  assert.match(meta.id, /^launch-loop-[a-z0-9]{6}$/);
  assert.equal(meta.tmuxSession, `forge-${meta.id}`);
  assert.ok(existsSync(join(LAUNCHES_DIR, meta.id, "meta.json")));

  const persisted = readLaunch(meta.id, tmux)!;
  assert.deepEqual(persisted.command, ["forge", "review-loop", "FG-1"]);
  assert.equal(persisted.status.state, "running", "no exit file + live session = running");

  const newSession = startup.find((c) => c[0] === "new-session")!;
  assert.ok(newSession.includes("-d"), "the session is detached — the submitter never owns the process");

  // The ORDER is the invariant: remain-on-exit must be armed before the target
  // command can ever run, or a fast command destroys the session first.
  // FG-614 inserted one `display-message` BEFORE new-session: the tmux server's own cwd
  // is probed against the EXISTING server, so it must be asked before forge's own
  // new-session can be the thing that starts one.
  assert.deepEqual(names(startup), ["-V", "display-message", "new-session", "set-option", "respawn-pane", "display-message"]);
  assert.ok(!newSession.includes("forge"), "the session is born with an inert pane, not the target command");
  const respawn = startup.find((c) => c[0] === "respawn-pane")!;
  assert.ok(respawn.some((a) => a.includes("review-loop")), "the target command arrives via respawn-pane");
});

test("FG-552 F32: a directory-discovering reader never sees a RUNNING launch as absent during initial publication", () => {
  // The window the finding names: startLaunch mkdir's a discoverable dir, then
  // respawn-pane starts the command. A concurrent listLaunches/readLaunch that
  // lands after the command runs but before meta.json is published would map the
  // absent meta.json to undefined — a running launch seen as "no such launch".
  // We reproduce it by observing FROM INSIDE respawn-pane (the command is now
  // running) and again right after set-option, asserting the launch is
  // discoverable and reads `running` at every point past mkdir.
  const stub = tmuxStub();
  const observed: Array<{ at: string; count: number; state: string | undefined }> = [];
  const tmux: TmuxRunner = (args) => {
    const out = stub.tmux(args);
    if (args[0] === "set-option" || args[0] === "respawn-pane") {
      const all = listLaunches(tmux);
      const mine = all[0];
      observed.push({ at: args[0]!, count: all.length, state: mine?.status.state });
    }
    return out;
  };
  const meta = startLaunch(["forge", "review-loop", "FG-1"], { name: "pubwindow", tmux });

  assert.ok(observed.length >= 2, "observed the publication window from inside tmux calls");
  for (const o of observed) {
    assert.equal(o.count, 1, `${o.at}: the launch dir is discoverable (not absent) while the command is being started`);
    assert.equal(o.state, "running", `${o.at}: a discoverable in-flight launch reads running, never undefined`);
  }
  assert.equal(readLaunch(meta.id, tmux)!.status.state, "running", "and it still reads running after startLaunch returns");
});

test("FG-552 concurrent start: a directory-discovering reader in the PRE-TMUX window reads running, never terminal unknown", () => {
  // The narrower race the F32 test above does NOT cover: meta.json is published
  // BEFORE any tmux session exists, so a concurrent listLaunches/readLaunch that
  // lands after publication but before new-session would consult owner evidence,
  // find no session, and classify the just-created launch terminal `unknown` — a
  // waiter would then advance before respawn-pane ever starts the work. We
  // reproduce it precisely: observe from INSIDE the new-session call, when
  // meta.json is on disk (startLaunch writes it before any tmux call) but the
  // session does not exist yet.
  const stub = tmuxStub();
  let observedCount = -1;
  let observedStatus: { state: string } | undefined;
  const tmux: TmuxRunner = (args) => {
    if (args[0] === "new-session") {
      const all = listLaunches(tmux);
      observedCount = all.length;
      observedStatus = all[0]?.status;
    }
    return stub.tmux(args);
  };
  const meta = startLaunch(["forge", "review-loop", "FG-1"], { name: "concurrentstart", tmux });

  assert.equal(observedCount, 1, "the launch dir is discoverable before the session is created");
  assert.deepEqual(observedStatus, { state: "running" }, "a launch whose session is not yet created reads running, never terminal unknown");
  assert.equal(readLaunch(meta.id, tmux)!.status.state, "running", "and still running once ownership is established");
});

test("FG-535 start: persists launcher identity — the submitting pid and the tmux-owned pane pid", () => {
  const { tmux, calls } = tmuxStub();
  const meta = startLaunch(["sleep", "600"], { name: "pids", tmux });

  assert.equal(meta.launcherPid, process.pid, "the submitting process is named in the record");
  assert.equal(meta.ownerPid, 4242, "the tmux pane's pid — the process that actually owns the command");

  // The owner pid must be read AFTER the real command takes the pane, or it
  // would name the inert bootstrap pane instead. Matched on the pane_pid FORMAT: the
  // FG-614 server-cwd probe is also a display-message, and it runs before new-session.
  const askedAt = calls.findIndex((c) => c[0] === "display-message" && c.includes("#{pane_pid}"));
  assert.ok(askedAt > calls.findIndex((c) => c[0] === "respawn-pane"), "owner pid is queried after respawn-pane");

  const persisted = readLaunch(meta.id, tmux)!;
  assert.equal(persisted.launcherPid, process.pid, "and survives to any later session");
  assert.equal(persisted.ownerPid, 4242);
});

test("FG-535 start: an owner pid tmux cannot report stays null — never inferred", () => {
  const alive = new Set<string>();
  const tmux: TmuxRunner = (args) => {
    if (args[0] === "has-session" && !alive.has(args[2]!)) throw new Error("no such session");
    if (args[0] === "new-session") alive.add(args[args.indexOf("-s") + 1]!);
    if (args[0] === "display-message") throw new Error("lost server");
  };
  const meta = startLaunch(["sleep", "600"], { name: "nopid", tmux });

  assert.equal(meta.ownerPid, null);
  assert.equal(readLaunch(meta.id, tmux)!.status.state, "running", "an unreadable owner pid does not break the record");
});

test("FG-535 status: the exit record is authoritative — 0 is exited_ok, WIFSIGNALED is signaled with no sender claim", () => {
  const { tmux } = tmuxStub();
  const ok = startLaunch(["true"], { name: "ok", tmux });
  const killed = startLaunch(["sleep", "600"], { name: "killed", tmux });
  writeFileSync(join(LAUNCHES_DIR, ok.id, "exit"), `{"code":0,"signal":null}`);
  writeFileSync(join(LAUNCHES_DIR, killed.id, "exit"), `{"code":null,"signal":"SIGTERM"}`);

  assert.deepEqual(readLaunch(ok.id, tmux)!.status, { state: "exited_ok", code: 0 });
  assert.deepEqual(readLaunch(killed.id, tmux)!.status, {
    state: "signaled", signal: "SIGTERM", sender: "unrecorded",
  });
});

test("FG-535 status: a deliberate exit 143 is never reported as a kill", () => {
  const { tmux } = tmuxStub();
  const meta = startLaunch(["sh", "-c", "exit 143"], { name: "deliberate", tmux });
  writeFileSync(join(LAUNCHES_DIR, meta.id, "exit"), `{"code":143,"signal":null}`);

  assert.deepEqual(readLaunch(meta.id, tmux)!.status, { state: "terminated_unattributed", code: 143 });
});

test("FG-535 status: a live session holding a DEAD pane with no exit record is owner_gone — an indeterminate claim (killed OR failed its last-act write)", () => {
  const stub = tmuxStub();
  const meta = startLaunch(["sleep", "600"], { name: "wrapperkilled", tmux: stub.tmux });
  stub.deadPanes.add(meta.tmuxSession); // remain-on-exit retained the pane; no exit file was ever written

  assert.deepEqual(readLaunch(meta.id, stub.tmux)!.status, { state: "owner_gone", cause: "unrecorded", sender: "unrecorded" });

  // Not "running", so cleanup no longer demands --force — but the record must
  // survive intact up to the explicit rm.
  removeLaunch(meta.id, { tmux: stub.tmux });
  assert.equal(readLaunch(meta.id, stub.tmux), undefined);
});

test("FG-535 status: a pane tmux cannot classify stays running — fail-safe, rm keeps refusing", () => {
  const alive = new Set<string>();
  const tmux: TmuxRunner = (args) => {
    if (args[0] === "has-session" && !alive.has(args[2]!)) throw new Error("no such session");
    if (args[0] === "new-session") alive.add(args[args.indexOf("-s") + 1]!);
    if (args[0] === "display-message") throw new Error("cannot answer");
  };
  const meta = startLaunch(["sleep", "600"], { name: "unanswerable", tmux });

  assert.deepEqual(readLaunch(meta.id, tmux)!.status, { state: "running" });
  assert.throws(() => removeLaunch(meta.id, { tmux }), /still running .* --force/);
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

test("FG-569 R2: a malformed releaseId (non-string, non-null) OMITS the recorder from launch show — never a guessed null-release; valid string and valid null still surface", () => {
  const { tmux } = tmuxStub();
  const base = { execPath: "/opt/n/bin/node", abi: "137", nodeVersion: "v24.0.0" };
  const rt = (id: string) => join(LAUNCHES_DIR, id, "runtime.json");

  // The exact documented-promise case: releaseId is the number 42. It is treated as an
  // absent/unparseable record — omitted from BOTH surfaces (readLaunch is the single
  // source the human `not recorded` line and the `--json` view derive from). It is NOT
  // presented as a null-release recorder, and readLaunch does not crash.
  const bad = startLaunch(["forge", "next"], { name: "badrel", tmux });
  writeFileSync(rt(bad.id), JSON.stringify({ ...base, releaseId: 42 }));
  assert.equal(readLaunch(bad.id, tmux)!.recorder, undefined, "a number releaseId is malformed R2 — omitted, not surfaced as a null-release");

  const good = startLaunch(["forge", "next"], { name: "goodrel", tmux });
  writeFileSync(rt(good.id), JSON.stringify({ ...base, releaseId: "release-xyz-1" }));
  assert.deepEqual(readLaunch(good.id, tmux)!.recorder, { ...base, releaseId: "release-xyz-1" }, "a valid string releaseId still surfaces");

  const dev = startLaunch(["forge", "next"], { name: "devrel", tmux });
  writeFileSync(rt(dev.id), JSON.stringify({ ...base, releaseId: null }));
  assert.deepEqual(readLaunch(dev.id, tmux)!.recorder, { ...base, releaseId: null }, "a valid null release (dev) still surfaces correctly");
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

test("FG-535 traversal guard: a crafted --name is slugified into the safe charset — it can never escape the launches dir", () => {
  const { tmux } = tmuxStub();
  const meta = startLaunch(["true"], { name: "../../../etc/passwd", tmux });

  assert.match(meta.id, /^launch-etc-passwd-[a-z0-9]{6}$/);
  assert.ok(existsSync(join(LAUNCHES_DIR, meta.id, "meta.json")), "the record landed INSIDE the launches dir");
});

test("FG-535 traversal guard: show/rm reject a path-shaped id at the chokepoint instead of joining it", () => {
  const { tmux } = tmuxStub();
  for (const evil of ["../../../etc", "a/b", "..", ".hidden"]) {
    assert.throws(() => readLaunch(evil, tmux), /invalid launch id/);
    assert.throws(() => removeLaunch(evil, { force: true, tmux }), /invalid launch id/);
  }
});

test("FG-535 start: refuses when tmux is unavailable, before writing anything", () => {
  const noTmux: TmuxRunner = () => { throw new Error("not found"); };
  assert.throws(() => startLaunch(["true"], { tmux: noTmux }), /requires tmux/);
  assert.ok(!existsSync(LAUNCHES_DIR) || listLaunches(noTmux).length === 0);
});

test("FG-535 start: a tmux failure AFTER new-session kills the half-built session — no untracked pane survives the deleted record", () => {
  for (const failing of ["set-option", "respawn-pane"]) {
    rmSync(LAUNCHES_DIR, { recursive: true, force: true });
    const stub = tmuxStub();
    const tmux: TmuxRunner = (args) => {
      if (args[0] === failing) throw new Error(`tmux ${failing} exploded`);
      return stub.tmux(args);
    };

    assert.throws(() => startLaunch(["sleep", "600"], { name: "half", tmux }), /tmux failed to start the session/);
    assert.equal(stub.alive.size, 0, `${failing}: the session created by new-session was killed, not stranded`);
    assert.equal(listLaunches(tmux).length, 0, `${failing}: no record left behind either`);
  }
});

test("FG-535: LAUNCHES_DIR is test-scoped, not the real home", () => {
  // test-setup points FORGE_HOME at a scratch dir; guard the suite against
  // ever writing launch records into the operator's real ~/.forge.
  assert.ok(!LAUNCHES_DIR.startsWith(join(process.env.HOME ?? "/nonexistent", ".forge")), LAUNCHES_DIR);
  mkdirSync(LAUNCHES_DIR, { recursive: true }); // and it is writable where it points
});
