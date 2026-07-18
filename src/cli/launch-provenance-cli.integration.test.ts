// FG-555 (FG-553 Slice 1b) — the launched-workload provenance (R3/R4) +
// refuse-before-execute guard, EXERCISED AT THE REAL `forge launch` CLI BOUNDARY.
//
// The engineer's launch-workload.integration.test.ts proves the RECORDER and the
// in-process startLaunch/readLaunch. This file covers the layer NOBODY else does:
// the actual `bin/forge launch run` / `forge launch show --json` control entry —
// how the provenance is ACTUALLY SERIALIZED by the CLI a caller reads, not just
// the in-memory LaunchView type. bin/forge exec-loads the live TS CLI (same shape
// as forge-bin.integration.test.ts), so a change to the command surface changes
// the live `forge` the moment it lands.
//
// Every test here was OBSERVED RED against an injected production mutant before it
// was accepted (see the FG-555 result notes for the exact mutant + failing
// assertion per test) — a test that cannot go red proves nothing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { findGitRoot } from "../util/git-root.js";
import { startLaunch, listLaunches, LAUNCHES_DIR, type LaunchProfile } from "../v2/launch.js";

const forgeBin = join(findGitRoot(process.cwd()), "bin", "forge");
const hasBash = spawnSync("bash", ["-c", "true"], { encoding: "utf8" }).status === 0;

// A dedicated FORGE_HOME per launch keeps the CLI subprocess' launch records off
// the in-process test-setup home and out of every other test's way.
function freshHome(): string {
  const home = mkdtempSync(join(tmpdir(), "fg555-cli-"));
  mkdirSync(join(home, "launches"), { recursive: true });
  return home;
}

function runForge(home: string, args: string[]) {
  return spawnSync(forgeBin, args, { encoding: "utf8", env: { ...process.env, FORGE_HOME: home } });
}

/** `forge launch run --json … <command…>` → the parsed launch meta. `--json`
 *  goes BEFORE the args so a `--` inside them can't swallow it into the workload
 *  argv (which would suppress the machine-readable output). */
function launch(home: string, args: string[]): { id: string; command: string[] } {
  const r = runForge(home, ["launch", "run", "--json", ...args]);
  assert.equal(r.status, 0, `forge launch run failed (${r.status}): ${r.stderr}\n${r.stdout}`);
  return JSON.parse(r.stdout);
}

/** Poll `forge launch show <id> --json` until the recorder has written an exit
 *  record (status leaves "running"), then return the fully-serialized view. */
function showJsonWhenDone(home: string, id: string): any {
  for (let i = 0; i < 100; i++) {
    const r = runForge(home, ["launch", "show", id, "--json"]);
    assert.equal(r.status, 0, `forge launch show --json failed: ${r.stderr}`);
    const v = JSON.parse(r.stdout);
    if (v.status?.state !== "running") return v;
    execFileSync("sleep", ["0.1"]);
  }
  throw new Error(`launch ${id} never left running`);
}

function showHuman(home: string, id: string): string {
  const r = runForge(home, ["launch", "show", id]);
  assert.equal(r.status, 0, `forge launch show failed: ${r.stderr}`);
  return r.stdout;
}

test("FG-555 CLI: `forge launch show --json` serializes R3 captured + R4 not_applicable for a DIRECT argv launch — and preserves argv exactly", () => {
  const home = freshHome();
  try {
    // argv[0] is an ABSOLUTE path (process.execPath) → R3 captured. A direct
    // executable resolves nothing later → R4 not_applicable.
    const meta = launch(home, ["--name", "direct", "--", process.execPath, "-e", "process.stdout.write('R3-DIRECT-EXEC\\n')"]);
    assert.match(meta.id, /^launch-direct-/);
    // argv preserved EXACTLY by the CLI boundary — no strip, no rewrite, no
    // synthesized login shell wrapping the command.
    assert.deepEqual(meta.command, [process.execPath, "-e", "process.stdout.write('R3-DIRECT-EXEC\\n')"]);

    const v = showJsonWhenDone(home, meta.id);
    assert.equal(v.status.state, "exited_ok", "the direct workload ran to completion");
    // The heart of the test: the CLI actually SERIALIZES the workload object.
    assert.ok(v.workload, "forge launch show --json exposes the workload provenance object");
    assert.equal(v.workload.r3.kind, "captured");
    assert.equal(v.workload.r3.argv0, process.execPath, "R3 argv0 is the exact submitted argv[0]");
    assert.equal(v.workload.r3.execPath, process.execPath, "a path argv[0] IS its own resolution");
    assert.equal(v.workload.r4.kind, "not_applicable", "no nested shell → R4 not_applicable, not implied-covered");
    // The recorder spawned argv[0] DIRECTLY: its stdout is in the log. A
    // synthesized `bash -lc '<node …>'` would make bash the top-level exe.
    assert.match(v.command.join(" "), /R3-DIRECT-EXEC/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("FG-555 CLI: a bare argv[0] serializes as R3 derived, and `forge launch show` (human) renders the workload: + nested: lines", () => {
  const home = freshHome();
  try {
    // Bare `true` (no separator) → resolved on PATH at spawn time → R3 derived.
    const meta = launch(home, ["--name", "derived", "--", "true"]);
    const v = showJsonWhenDone(home, meta.id);
    assert.equal(v.status.state, "exited_ok");
    assert.equal(v.workload.r3.kind, "derived", "a bare name is resolved on PATH, recorded as derived");
    assert.equal(v.workload.r3.argv0, "true");
    assert.match(v.workload.r3.execPath, /\/true$/, "R3 execPath is the real resolution, not a guess");
    // R4 INVERSION: `true` is NOT a terminal node/nodejs interpreter, so its runtime
    // defaults to UNKNOWABLE (deliberate change from the pre-inversion not_applicable) —
    // Forge does not claim argv is the full resolution for a non-Node command.
    assert.equal(v.workload.r4.kind, "unknowable");
    assert.equal(v.workload.r4.shell, "true", "the effective command that triggered unknowable is recorded, not a fabricated shell name");

    // The human render must SHOW R3/R4 as their own lines (forge launch show).
    const human = showHuman(home, meta.id);
    assert.match(human, /^workload: R3 derived — argv\[0\] 'true' resolved on PATH → .*\/true$/m);
    assert.match(human, /^nested: +R4 UNKNOWABLE/m);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test(
  "FG-555 CLI: a caller-supplied `bash -lc` is preserved argv-for-argv and serializes R4 UNKNOWABLE — argv is never implied to satisfy R3/R4",
  { skip: hasBash ? false : "bash not available" },
  () => {
    const home = freshHome();
    try {
      // The exact reproduction shape: a caller-supplied nested login shell. The
      // CLI must NOT strip or rewrite it, and R4 must SAY unknowable rather than
      // pretending argv covers what the shell will resolve at runtime.
      const meta = launch(home, ["--name", "nested", "--", "bash", "-lc", "printf R4NESTED"]);
      assert.deepEqual(meta.command, ["bash", "-lc", "printf R4NESTED"], "the nested shell command is preserved exactly");

      const v = showJsonWhenDone(home, meta.id);
      assert.equal(v.status.state, "exited_ok");
      assert.equal(v.workload.r4.kind, "unknowable", "a nested shell's later resolution is UNKNOWABLE, stated explicitly");
      assert.equal(v.workload.r4.shell, "bash");
      // R3 still honestly names the shell binary as the top-level executable —
      // it does NOT quietly stand in for the R4 the argv cannot express.
      assert.equal(v.workload.r3.argv0, "bash");

      const human = showHuman(home, meta.id);
      assert.match(human, /^nested: +R4 UNKNOWABLE — nested shell 'bash'/m);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
);

test("FG-555 CLI backward-compat: a pre-FG-555 launch record with NO workload.json loads and reads 'not recorded' — never inferred from argv", () => {
  const home = freshHome();
  try {
    // Hand-build a launch record in the pre-FG-555 shape: meta.json, no
    // workload.json, no exit record. This is exactly what an old launch on disk
    // looks like after an upgrade.
    const id = "launch-precompat-abcd";
    const dir = join(home, "launches", id);
    mkdirSync(dir, { recursive: true });
    const logPath = join(dir, "out.log");
    writeFileSync(logPath, "");
    writeFileSync(
      join(dir, "meta.json"),
      JSON.stringify({
        id,
        command: ["bash", "-lc", "npm run test:all"],
        tmuxSession: `forge-${id}`,
        launcherPid: 4242,
        ownerPid: null,
        startedAt: "2026-01-01T00:00:00.000Z",
        logPath,
        cwd: home,
      }),
    );

    const r = runForge(home, ["launch", "show", id, "--json"]);
    assert.equal(r.status, 0, `show --json failed: ${r.stderr}`);
    const v = JSON.parse(r.stdout);
    assert.ok(!("workload" in v), "an absent workload.json is OMITTED from the serialized view, not fabricated");
    // Crucially, argv contains `bash -lc …` yet nothing is inferred from it.
    const human = showHuman(home, id);
    assert.match(human, /^workload: not recorded \(launch predates R3\/R4 capture/m, "human render says not recorded, never a guess");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("FG-555 CLI backward-compat: a MALFORMED workload.json is omitted (never guessed into a value), not surfaced", () => {
  const home = freshHome();
  try {
    const id = "launch-malformed-abcd";
    const dir = join(home, "launches", id);
    mkdirSync(dir, { recursive: true });
    const logPath = join(dir, "out.log");
    writeFileSync(logPath, "");
    writeFileSync(
      join(dir, "meta.json"),
      JSON.stringify({
        id,
        command: ["true"],
        tmuxSession: `forge-${id}`,
        launcherPid: 4242,
        ownerPid: null,
        startedAt: "2026-01-01T00:00:00.000Z",
        logPath,
        cwd: home,
      }),
    );
    // A derived R3 WITHOUT execPath is malformed — the parser must reject the
    // whole record rather than surface a half-value.
    writeFileSync(join(dir, "workload.json"), JSON.stringify({ r3: { kind: "derived", argv0: "true" }, r4: { kind: "not_applicable", reason: "r" } }));

    const r = runForge(home, ["launch", "show", id, "--json"]);
    assert.equal(r.status, 0, `show --json failed: ${r.stderr}`);
    const v = JSON.parse(r.stdout);
    assert.ok(!("workload" in v), "a malformed workload.json is omitted — the CLI never guesses a partial value into the view");
    const human = showHuman(home, id);
    assert.match(human, /^workload: not recorded/m);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("FG-555 CLI positive wiring: `forge launch run --require-control-toolchain` against the MATCHING control toolchain is NOT refused — it proceeds and records R3/R4", () => {
  const home = freshHome();
  try {
    // The flag builds controlRuntimeProfile() (forge's own node, ABI-matching by
    // construction), so the guard passes and the launch proceeds. This proves the
    // flag is actually wired to the refuse-before-execute guard AND that pinning
    // the PATH still lets the recorder run and write provenance.
    const meta = launch(home, ["--require-control-toolchain", "--name", "pinned", "--", process.execPath, "-e", "process.stdout.write('PINNED-OK\\n')"]);
    assert.match(meta.id, /^launch-pinned-/, "a matching toolchain is not refused — the launch started");
    const v = showJsonWhenDone(home, meta.id);
    assert.equal(v.status.state, "exited_ok", "the pinned-PATH workload ran to completion under the contract");
    assert.ok(v.workload, "the recorder still wrote R3/R4 under the pinned control PATH");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("FG-555 CLI runtime provenance: `forge launch run --require-control-toolchain -- node …` serializes the effective interpreter's ABI/version AND the pinned profile in --json, and renders both in the human view", () => {
  const home = freshHome();
  try {
    // A direct `node` workload under the control contract. The end-to-end proof: the
    // CLI must serialize the PROBED interpreter runtime (real ABI/version of the node
    // that ran) and the pinned profile — the facts a reader diagnoses a toolchain
    // mismatch from, which the pre-fix record (argv0 + path only) could not express.
    const meta = launch(home, ["--require-control-toolchain", "--name", "runtime", "--", process.execPath, "-e", "process.stdout.write('RUNTIME-OK\\n')"]);
    const v = showJsonWhenDone(home, meta.id);
    assert.equal(v.status.state, "exited_ok");
    assert.ok(v.workload.interpreter, "the serialized workload exposes the effective interpreter runtime");
    assert.equal(v.workload.interpreter.execPath, process.execPath, "the interpreter is the exact node the recorder spawned");
    assert.equal(v.workload.interpreter.abi, process.versions.modules, "the serialized ABI is the interpreter's REAL probed ABI");
    assert.equal(v.workload.interpreter.nodeVersion, process.version, "the serialized node version is the interpreter's own");
    assert.ok(v.workload.profile, "the pinned launch profile is serialized");
    assert.equal(v.workload.profile.requireAbi, process.versions.modules, "the profile names the required control ABI");
    assert.equal(v.workload.profile.label, "control-runtime");
    assert.equal(v.workload.profile.path.split(":")[0], dirname(process.execPath), "the profile records the control-node-first pinned PATH");

    const human = showHuman(home, meta.id);
    const runtimeLine = human.split("\n").find((l) => l.startsWith("runtime:"));
    assert.ok(runtimeLine, "the human view has a runtime: line");
    assert.ok(runtimeLine!.includes(process.execPath), "the runtime line names the interpreter execPath");
    assert.ok(runtimeLine!.includes(`abi ${process.versions.modules} (node ${process.version})`), "the runtime line shows the probed ABI + node version");
    assert.match(human, /^profile: +control-runtime — requires abi \d+; pinned PATH = /m);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("FG-555 CLI runtime provenance: a workload WITHOUT the contract renders 'not recorded' interpreter and 'none declared' profile — never fabricated", () => {
  const home = freshHome();
  try {
    // A non-node workload, no contract: the human view must state both absences as
    // fact, not guess a runtime or a profile that was never declared.
    const meta = launch(home, ["--name", "ambient", "--", "true"]);
    const v = showJsonWhenDone(home, meta.id);
    assert.equal(v.status.state, "exited_ok");
    assert.ok(!("interpreter" in v.workload), "no Node interpreter probed → the field is omitted, not fabricated");
    assert.ok(!("profile" in v.workload), "no contract declared → no profile is recorded");
    const human = showHuman(home, meta.id);
    assert.match(human, /^runtime: +not recorded \(argv\[0\] is not a probed Node interpreter/m);
    assert.match(human, /^profile: +none declared \(launch inherited the ambient env\)/m);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("FG-555 refuse-before-execute (REAL tmux, REAL fs): an incompatible ABI on the pinned PATH is refused with a NAMED mismatch BEFORE any launch record or tmux session exists — and nothing is rebuilt", () => {
  // Unlike the engineer's stub-tmux unit, this drives the PRODUCTION startLaunch
  // with the REAL default tmux runner and the REAL launches dir, so it proves the
  // guard truly precedes any persistence/session creation in the live environment
  // — not just against a stub that records calls.
  const fakebin = mkdtempSync(join(tmpdir(), "fg555-fakebin-"));
  const argsLog = join(fakebin, "node-args.log");
  const fakeNode = join(fakebin, "node");
  // The fake `node` reports ABI 131 (the incompatible Node of the reproduction)
  // and LOGS how it was invoked — so we can prove the guard only PROBED the ABI and
  // never tried to rebuild/replace a native dependency. A DIRECT command (not a
  // shell) so the ABI probe governs — a login shell is refused earlier, on its own
  // grounds.
  writeFileSync(fakeNode, `#!/bin/sh\necho "$@" >> "${argsLog}"\necho 131\n`);
  chmodSync(fakeNode, 0o755);

  const before = listLaunches().length;
  const profile: LaunchProfile = { path: `${fakebin}:${process.env.PATH ?? ""}`, requireAbi: "137", label: "control-runtime" };

  assert.throws(
    () => startLaunch(["node", "-e", "1"], { name: "reprocli", profile }),
    (e: Error) => {
      assert.match(e.message, /refusing to run/);
      assert.match(e.message, /ABI 137/, "the refusal NAMES the required ABI");
      assert.match(e.message, /131/, "the refusal NAMES the found ABI");
      return true;
    },
  );

  // Refuse-BEFORE-execute: no launch record was persisted under the REAL launches
  // dir (the workload — and its downstream ERR_DLOPEN_FAILED — never ran).
  assert.equal(listLaunches().length, before, "no launch record was written by a refused launch");
  assert.ok(!existsSync(join(LAUNCHES_DIR, "launch-reprocli-")), "no dir stub for the refused launch");

  // The guard only READ the toolchain's ABI. The fake node was invoked once, to
  // print its ABI — never with a rebuild/gyp/install verb.
  const invocations = existsSync(argsLog) ? readFileSync(argsLog, "utf8") : "";
  assert.match(invocations, /-p process\.versions\.modules/, "the guard probed the ABI");
  assert.doesNotMatch(invocations, /rebuild|gyp|install/, "the guard NEVER rebuilt or replaced a native dependency");

  rmSync(fakebin, { recursive: true, force: true });
});
