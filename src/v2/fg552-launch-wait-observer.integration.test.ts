// FG-552 verify (integration): the observer's LOAD-BEARING properties driven
// through the REAL reader (readLaunch over real files) and the REAL harness
// (realWaitHarness: real fs.watch + real setInterval reconcile). The engineer's
// unit test proves these with a FULLY FAKE harness; here the same three
// properties run against the real filesystem boundary:
//
//   • BD-6 subscribe race — a launch that goes terminal in the check-then-subscribe
//     window is caught by the post-install immediate reread, with the watcher AND
//     reconcile deliberately dead so ONLY the reread can explain the observation.
//   • F34 mandatory reconciliation — owner_gone produces no fs artifact, so a
//     WATCH-ONLY harness (real read, no reconcile) is OBSERVED FAILING to see it
//     (times out), while the real reconcile INTERVAL observes it.
//   • F4/F32 atomic records — a SEPARATE process hammers meta.json while the real
//     reader reads it thousands of times; with the atomic temp+rename discipline a
//     running launch is NEVER seen as "no such launch" or a torn record. Set
//     FG552_STRESS_ATOMIC=0 to run the writer non-atomically and OBSERVE the tear.
//
// Crosses the real fs + spawns a writer process → integration tier.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  LAUNCHES_DIR,
  readLaunch,
  realWaitHarness,
  startLaunch,
  waitForLaunchTerminal,
  type LaunchView,
  type TmuxRunner,
  type WaitHarness,
} from "./launch.js";

/** A tmux stub: `alive`/`deadPanes` are toggled by hand so readLaunch classifies
 *  a real launch dir deterministically without a real tmux server. */
function tmuxStub(): { tmux: TmuxRunner; alive: Set<string>; deadPanes: Set<string> } {
  const alive = new Set<string>();
  const deadPanes = new Set<string>();
  const tmux: TmuxRunner = (args) => {
    if (args[0] === "has-session") {
      if (!alive.has(args[2]!)) throw new Error("no such session");
    }
    if (args[0] === "new-session") alive.add(args[args.indexOf("-s") + 1]!);
    if (args[0] === "kill-session") alive.delete(args[args.indexOf("-t") + 1]!);
    if (args[0] === "display-message") {
      const target = args[args.indexOf("-t") + 1]!.replace(/:$/, "");
      if (args.includes("#{pane_dead}")) return deadPanes.has(target) ? "1\n" : "0\n";
      return "4242\n";
    }
  };
  return { tmux, alive, deadPanes };
}

beforeEach(() => {
  rmSync(LAUNCHES_DIR, { recursive: true, force: true });
});

test("FG-552 observer (BD-6, real reader): a launch that becomes terminal in the check-then-subscribe window is caught by the immediate reread — proven by killing the watcher AND reconcile so NOTHING else could have observed it", async () => {
  const stub = tmuxStub();
  const meta = startLaunch(["sh", "-c", "sleep 600"], { name: "bd6", tmux: stub.tmux });
  const dir = join(LAUNCHES_DIR, meta.id);

  // read() delegates to the REAL readLaunch. On the FIRST read the launch is still
  // running; that read then writes the REAL atomic exit record — i.e. the launch
  // completes exactly in the check-then-subscribe gap. The watcher and reconcile
  // installers are dead no-ops, so if the observation happens at all it can ONLY be
  // the post-install immediate reread (waitForLaunchTerminal's trailing check()).
  const base = realWaitHarness(meta.id, { tmux: stub.tmux, timeoutMs: 5000 });
  let reads = 0;
  const harness: WaitHarness = {
    read: () => {
      const v = base.read();
      if (++reads === 1) {
        // atomic temp+rename, exactly as the recorder commits the exit record
        const tmp = join(dir, `exit.tmp.race`);
        writeFileSync(tmp, JSON.stringify({ code: 0, signal: null }));
        renameSync(tmp, join(dir, "exit"));
      }
      return v;
    },
    installWatcher: () => () => {}, // DEAD: no fs event will explain the observation
    startReconcile: () => () => {}, // DEAD: no tick will explain the observation
    startTimeout: base.startTimeout, // real safety timeout (proves a hang would surface as wait_timeout)
    onCancel: () => () => {},
    startInvalidBound: base.startInvalidBound, // never armed here (the record is valid), but the interface requires it
  };

  const o = await waitForLaunchTerminal(meta.id, harness);
  assert.equal(o.kind, "terminal", "the immediate reread caught the in-window completion (BD-6)");
  assert.deepEqual((o as { view: LaunchView }).view.status, { state: "exited_ok", code: 0 });
  assert.ok(reads >= 2, `the observation came from the post-install reread, not the first read (reads=${reads})`);
});

test("FG-552 observer (F34, real reader + real interval): owner_gone has NO fs artifact — a watch-only harness is OBSERVED FAILING to see it (its last observation is a STALE running), while the real reconcile INTERVAL observes it", async () => {
  // The launch is RUNNING when each wait starts; the owner then vanishes (dead
  // pane, live session, no exit record) DURING the wait — a transition that
  // produces NO filesystem artifact, so fs.watch structurally cannot fire for it.
  // Only a re-read of owner evidence (the reconcile tick) can catch it.

  // Watch-only: real read, real fs.watch, but reconcile is a no-op. The owner
  // vanishes after the wait starts, yet nothing re-reads, so the wait ends on its
  // (short) timeout with a STALE 'running' as its last observation.
  const wo = tmuxStub();
  const woMeta = startLaunch(["sh", "-c", "sleep 600"], { name: "f34wo", tmux: wo.tmux });
  const woBase = realWaitHarness(woMeta.id, { tmux: wo.tmux, timeoutMs: 500 });
  const watchOnly: WaitHarness = {
    read: woBase.read,
    installWatcher: woBase.installWatcher,
    startReconcile: () => () => {}, // the structural gap F34 pins
    startTimeout: woBase.startTimeout,
    onCancel: woBase.onCancel,
    startInvalidBound: woBase.startInvalidBound, // never armed here (owner_gone, not an unreadable record)
  };
  setTimeout(() => wo.deadPanes.add(woMeta.tmuxSession), 80); // owner gone mid-wait, no fs event
  const missed = await waitForLaunchTerminal(woMeta.id, watchOnly);
  assert.equal(missed.kind, "wait_timeout", "a watch-only design cannot observe owner_gone — it times out instead");
  assert.equal(
    (missed as { lastObserved: { state: string } }).lastObserved.state,
    "running",
    "its last observation is a STALE running even though the owner has actually vanished — the exact structural blindness F34 pins",
  );

  // Real harness: same transition, but the reconcile INTERVAL (real setInterval,
  // short period) re-reads owner evidence and observes owner_gone — no hang, no
  // stale running, no fabricated exit.
  const rc = tmuxStub();
  const rcMeta = startLaunch(["sh", "-c", "sleep 600"], { name: "f34rc", tmux: rc.tmux });
  const full = realWaitHarness(rcMeta.id, { tmux: rc.tmux, reconcileMs: 20, timeoutMs: 5000 });
  setTimeout(() => rc.deadPanes.add(rcMeta.tmuxSession), 40);
  const seen = await waitForLaunchTerminal(rcMeta.id, full);
  assert.equal(seen.kind, "terminal", "the reconcile tick observes owner_gone");
  assert.deepEqual((seen as { view: LaunchView }).view.status, { state: "owner_gone", cause: "unrecorded", sender: "unrecorded" });
});

test("FG-552 observer (F4/F32, cross-process): while a SEPARATE process hammers meta.json, the real reader NEVER sees a torn record or a running launch as 'no such launch' — atomic temp+rename holds under concurrency", async () => {
  const stub = tmuxStub();
  const meta = startLaunch(["sh", "-c", "sleep 600"], { name: "stress", tmux: stub.tmux });
  const dir = join(LAUNCHES_DIR, meta.id);
  const metaPath = join(dir, "meta.json");

  // The writer runs in a DIFFERENT process — the only way to make a truncate window
  // real (a single sync process cannot interleave its own read and write). It rewrites
  // meta.json in a tight loop, padded large so a non-atomic write spans several
  // write() syscalls and reliably tears. Atomic by default (temp+rename, exactly as
  // production's writeJsonAtomic); FG552_STRESS_ATOMIC=0 flips it non-atomic to
  // OBSERVE the tear the fix prevents.
  const WRITES = 4000;
  const atomic = process.env.FG552_STRESS_ATOMIC !== "0";
  const writerSrc = `
    const fs = require("fs"), path = require("path");
    const metaPath = ${JSON.stringify(metaPath)};
    const atomic = ${atomic ? "true" : "false"};
    const N = ${WRITES};
    const base = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    const pad = "x".repeat(200 * 1024); // 200KB so a raw write is not a single syscall
    for (let i = 0; i < N; i++) {
      const rec = { ...base, _pad: pad, _seq: i };
      const json = JSON.stringify(rec, null, 2);
      if (atomic) {
        const tmp = metaPath + ".tmp." + process.pid;
        fs.writeFileSync(tmp, json);
        fs.renameSync(tmp, metaPath);
      } else {
        fs.writeFileSync(metaPath, json); // truncate-then-fill: a reader can catch the gap
      }
    }
    process.stdout.write(String(N));
  `;
  const writer = spawn("node", ["-e", writerSrc], { stdio: ["ignore", "pipe", "pipe"] });
  let writerDone = false;
  let writerErr = "";
  writer.stderr.on("data", (d) => (writerErr += d));
  writer.on("exit", () => (writerDone = true));

  let reads = 0;
  let torn = 0;
  let notFound = 0;
  while (!writerDone) {
    const v = readLaunch(meta.id, stub.tmux);
    reads++;
    if (!v) {
      notFound++; // a running launch observed as "no such launch" — the F32 defect
    } else if (v.status.state !== "running") {
      torn++; // meta was fine but something classified wrong — should be impossible here
    }
    // yield so the writer's exit event can land and the OS interleaves the file ops
    await new Promise((r) => setImmediate(r));
  }

  assert.equal(writerErr, "", `writer process errored: ${writerErr}`);
  assert.ok(reads > 500, `the stress ran a meaningful number of reads (reads=${reads})`);
  // eslint-disable-next-line no-console
  console.log(`FG-552 F4/F32 stress: atomic=${atomic} reads=${reads} writes=${WRITES} notFound=${notFound} torn=${torn}`);
  assert.equal(notFound, 0, `a running launch was seen as 'no such launch' ${notFound}x over ${reads} reads — atomic publication must prevent this`);
  assert.equal(torn, 0, `the reader observed a torn/misclassified record ${torn}x — must never happen under atomic writes`);
});
