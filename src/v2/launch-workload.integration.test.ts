// FG-555 (FG-553 Slice 1b) — the LAUNCHED WORKLOAD's execution environment,
// EXECUTED.
//
// Two halves, both proven against the real launch boundary:
//   • R3/R4 provenance resolved BY THE RECORDER, in the environment the command
//     actually ran under (not the submitting CLI — fg553-slice1-architecture.md C2).
//     These tests EXECUTE the real recorder (the `node -e` script
//     buildWrapperCommand emits, run through /bin/sh exactly as the tmux pane
//     does) and read the workload.json it wrote.
//   • Refuse-before-execute on an ABI/toolchain mismatch — the Node 23/ABI 131 vs
//     Node 24/ABI 137 reproduction, at the production `startLaunch` boundary,
//     caught BEFORE any tmux session exists.

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  LAUNCHES_DIR,
  buildWrapperCommand,
  controlRuntimeProfile,
  listLaunches,
  parseWorkloadProvenance,
  readLaunch,
  startLaunch,
  type LaunchProfile,
  type TmuxRunner,
  type WorkloadProvenance,
} from "./launch.js";

let scratch: string;

before(() => {
  scratch = mkdtempSync(join(tmpdir(), "fg555-"));
});
after(() => {
  rmSync(scratch, { recursive: true, force: true });
});
beforeEach(() => {
  rmSync(LAUNCHES_DIR, { recursive: true, force: true });
});

/** EXECUTE the real recorder through /bin/sh, exactly as the tmux pane does, and
 *  return the R3/R4 record it wrote from inside itself, plus the workload log. */
function runRecorder(argv: string[], env?: NodeJS.ProcessEnv): { workload: WorkloadProvenance | undefined; log: string } {
  const dir = mkdtempSync(join(scratch, "rec-"));
  const wrapper = buildWrapperCommand(argv, join(dir, "out.log"), join(dir, "exit"), join(dir, "runtime.json"), process.execPath);
  const r = spawnSync("/bin/sh", ["-c", wrapper], { encoding: "utf8", env: env ?? process.env });
  assert.equal(r.status, 0, `recorder wrapper failed: ${r.stderr}`);
  const wlPath = join(dir, "workload.json");
  return {
    workload: existsSync(wlPath) ? parseWorkloadProvenance(readFileSync(wlPath, "utf8")) : undefined,
    log: existsSync(join(dir, "out.log")) ? readFileSync(join(dir, "out.log"), "utf8") : "",
  };
}

/** A minimal tmux stub: records calls, answers pane pid / pane_dead by format. */
function tmuxStub(): { tmux: TmuxRunner; calls: string[][]; alive: Set<string> } {
  const calls: string[][] = [];
  const alive = new Set<string>();
  const tmux: TmuxRunner = (args) => {
    calls.push(args);
    if (args[0] === "has-session" && !alive.has(args[2]!)) throw new Error("no such session");
    if (args[0] === "new-session") alive.add(args[args.indexOf("-s") + 1]!);
    if (args[0] === "display-message") return "4242\n";
  };
  return { tmux, calls, alive };
}

const hasBash = spawnSync("bash", ["-c", "true"], { encoding: "utf8" }).status === 0;

test("FG-555 R3 + argv preservation: the recorder resolves argv[0] AND spawns it DIRECTLY — no synthesized shell", () => {
  const { workload, log } = runRecorder([process.execPath, "-e", "process.stdout.write('DIRECT-EXEC\\n')"]);
  assert.ok(workload, "the recorder wrote workload.json (R3/R4) before spawning");
  assert.equal(workload!.r3.kind, "captured");
  assert.equal(workload!.r3.kind === "captured" ? workload!.r3.execPath : "", process.execPath, "R3 is the EXACT argv[0] the recorder spawned");
  assert.equal(workload!.r4.kind, "not_applicable", "a direct executable has no nested-shell resolution");
  // The real proof forge did not wrap the argv in a login shell: argv[0] ran and
  // its output landed in the log. A synthesized `bash -lc '<node …>'` would make
  // bash the top-level executable, not this node.
  assert.match(log, /DIRECT-EXEC/, "argv[0] executed directly");
});

test("FG-555 R3 derived: a bare argv[0] resolves on PATH at spawn time (recorded, not guessed)", () => {
  const { workload } = runRecorder(["true"]);
  assert.ok(workload);
  assert.equal(workload!.r3.kind, "derived");
  assert.match(workload!.r3.kind === "derived" ? workload!.r3.execPath : "", /\/true$/);
});

test("FG-555 R3 unresolved: an argv[0] not on PATH is recorded as fact, never guessed", () => {
  const { workload } = runRecorder(["forge-fg555-no-such-binary"], { ...process.env, PATH: "/nonexistent-fg555" });
  assert.ok(workload);
  assert.deepEqual(workload!.r3, { kind: "unresolved", argv0: "forge-fg555-no-such-binary" });
});

test(
  "FG-555 R4 UNKNOWABLE: a caller-supplied `bash -lc` is recorded as unknowable — argv never implies it is covered",
  { skip: hasBash ? false : "bash not available" },
  () => {
    // The EXACT reproduction shape: a caller-supplied nested login shell. Forge did
    // not synthesize it — the caller did — and R4 says the node/npm/forge it will
    // resolve later is unknowable, rather than implying argv covers it.
    const { workload } = runRecorder(["bash", "-lc", "true"]);
    assert.ok(workload);
    assert.equal(workload!.r4.kind, "unknowable");
    assert.equal(workload!.r4.kind === "unknowable" ? workload!.r4.shell : "", "bash");
    assert.equal(workload!.r3.argv0, "bash", "R3 still honestly names the shell binary as the top-level executable");
  },
);

test("FG-555 refuse-before-execute: Node 23/ABI 131 vs required ABI 137 is refused BEFORE the workload runs, with a NAMED mismatch", () => {
  // A fake `node` on the pinned PATH that reports ABI 131 — the incompatible Node
  // the reproduction's caller-supplied login shell resolved. The control contract
  // requires ABI 137. This is the exact false-red trigger: opening better-sqlite3
  // under ABI 131 dies with ERR_DLOPEN_FAILED across hundreds of unrelated tests.
  const fakebin = mkdtempSync(join(scratch, "fakebin-"));
  const fakeNode = join(fakebin, "node");
  writeFileSync(fakeNode, "#!/bin/sh\necho 131\n");
  chmodSync(fakeNode, 0o755);

  const stub = tmuxStub();
  const profile: LaunchProfile = { path: `${fakebin}:${process.env.PATH ?? ""}`, requireAbi: "137", label: "control-runtime" };

  assert.throws(
    () => startLaunch(["bash", "-lc", "npm run test:all"], { name: "repro", tmux: stub.tmux, profile }),
    (e: Error) => {
      assert.match(e.message, /refusing to run/);
      assert.match(e.message, /ABI 137/);
      assert.match(e.message, /131/);
      return true;
    },
  );

  // Refuse-BEFORE-execute: no tmux session was ever created, so the workload — and
  // its hundreds of downstream ERR_DLOPEN_FAILED — never ran, and no launch record
  // was written. The guard only READ the toolchain's ABI (`echo 131`); it never
  // rebuilt or replaced a shared native dependency to match (FG-555 non-goal).
  assert.ok(!stub.calls.some((c) => c[0] === "new-session"), "the guard refused BEFORE any tmux session existed");
  assert.equal(listLaunches(stub.tmux).length, 0, "and no launch record was written");
});

test("FG-555 contract satisfied: the matching control toolchain is NOT refused — the launch proceeds", () => {
  // controlRuntimeProfile pins forge's OWN node (dir first on PATH); its ABI is by
  // construction the required ABI, so a real control launch runs unhindered.
  const stub = tmuxStub();
  const profile = controlRuntimeProfile({ label: "control-runtime" });
  const meta = startLaunch(["true"], { name: "okabi", tmux: stub.tmux, profile });
  assert.match(meta.id, /^launch-okabi-/);
  assert.ok(stub.calls.some((c) => c[0] === "new-session"), "a matching toolchain proceeds to create the session");
});

test("FG-555 contract pins the session PATH via `new-session -e` — the workload never inherits an ambient login-shell PATH", () => {
  const stub = tmuxStub();
  // node resolves to the real control node (dir first) so the guard passes; the
  // point under test is the pinned PATH reaching the tmux session.
  const pinned = `${dirname(process.execPath)}:/fg555-pinned-marker`;
  const profile: LaunchProfile = { path: pinned, requireAbi: process.versions.modules, label: "control-runtime" };
  startLaunch(["true"], { name: "pinpath", tmux: stub.tmux, profile });

  const newSession = stub.calls.find((c) => c[0] === "new-session")!;
  const eIdx = newSession.indexOf("-e");
  assert.ok(eIdx >= 0, "new-session carries an -e env pin under the contract");
  assert.equal(newSession[eIdx + 1], `PATH=${pinned}`, "the session PATH is the contract's pinned PATH, not the ambient one");
});

test("FG-555 readLaunch surfaces R3/R4 from workload.json; malformed is omitted (never guessed); absent reads as not-recorded", () => {
  const stub = tmuxStub();
  const m = startLaunch(["forge", "next"], { name: "wl", tmux: stub.tmux });

  // Absent (stubbed tmux ran no real recorder) → not recorded, never inferred.
  assert.equal(readLaunch(m.id, stub.tmux)!.workload, undefined);

  const wlPath = join(LAUNCHES_DIR, m.id, "workload.json");
  const valid = { r3: { kind: "derived", argv0: "forge", execPath: "/x/forge" }, r4: { kind: "not_applicable", reason: "r" } };
  writeFileSync(wlPath, JSON.stringify(valid));
  assert.deepEqual(readLaunch(m.id, stub.tmux)!.workload, valid, "a valid record surfaces");

  writeFileSync(wlPath, JSON.stringify({ r3: { kind: "derived", argv0: "forge" }, r4: { kind: "not_applicable", reason: "r" } }));
  assert.equal(readLaunch(m.id, stub.tmux)!.workload, undefined, "a derived R3 without execPath is malformed — omitted, never surfaced as a guess");
});

test("FG-555: LAUNCHES_DIR is test-scoped, not the real home", () => {
  assert.ok(!LAUNCHES_DIR.startsWith(join(process.env.HOME ?? "/nonexistent", ".forge")), LAUNCHES_DIR);
});
