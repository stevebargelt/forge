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
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
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
function runRecorder(argv: string[], env?: NodeJS.ProcessEnv, profile?: LaunchProfile): { workload: WorkloadProvenance | undefined; log: string } {
  const dir = mkdtempSync(join(scratch, "rec-"));
  const wrapper = buildWrapperCommand(argv, join(dir, "out.log"), join(dir, "exit"), join(dir, "runtime.json"), process.execPath, null, profile ?? null);
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

test("FG-555 workload runtime: the recorder PROBES the effective Node interpreter (R3) for its real ABI/version, and PERSISTS the pinned profile — the runtime provenance a reader diagnoses a toolchain mismatch from", () => {
  // argv[0] is THIS node (a real Node interpreter), launched under a pinned profile.
  // The recorder must probe the interpreter it actually spawns and record its ABI +
  // version — the exact fact `forge launch show` needs to tell whether a direct node
  // workload ran the compatible toolchain — plus the contract that was pinned.
  const profile: LaunchProfile = { path: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`, requireAbi: process.versions.modules, label: "control-runtime" };
  const { workload } = runRecorder([process.execPath, "-e", "0"], undefined, profile);
  assert.ok(workload, "the recorder wrote workload.json");
  assert.ok(workload!.interpreter, "the effective Node interpreter was probed and persisted");
  assert.equal(workload!.interpreter!.execPath, process.execPath, "the probed interpreter is the exact executable the recorder spawned");
  assert.equal(workload!.interpreter!.abi, process.versions.modules, "the probed ABI is the interpreter's REAL ABI, not the recorder's copied value");
  assert.equal(workload!.interpreter!.nodeVersion, process.version, "the probed node version is the interpreter's own");
  assert.deepEqual(workload!.profile, profile, "the pinned launch profile (PATH + required ABI + label) is persisted verbatim");
});

test("FG-555 workload runtime: an `env FOO=bar <node> …` launch PROBES the effective node behind env — provenance is not defeated by a supported, allowed env prefix", () => {
  // The allowed contract form `env FOO=bar node …`: the top-level executable (R3) is
  // `env`, but the runtime that actually executes is the node behind it. The recorder
  // must probe that EFFECTIVE interpreter and record its ABI/version — otherwise a
  // supported launch shows R4 not_applicable with no interpreter, defeating provenance.
  const { workload } = runRecorder(["env", "FOO=bar", process.execPath, "-e", "0"]);
  assert.ok(workload, "the recorder wrote workload.json");
  assert.equal(workload!.r3.argv0, "env", "R3 honestly names the top-level env that ran");
  assert.equal(workload!.r4.kind, "not_applicable", "the effective argv[0] behind env IS a terminal node — R4 not_applicable");
  assert.ok(workload!.interpreter, "the EFFECTIVE node behind env was probed and persisted");
  assert.equal(workload!.interpreter!.execPath, process.execPath, "the probed interpreter is the effective node, not env");
  assert.equal(workload!.interpreter!.abi, process.versions.modules, "the probed ABI is the effective node's own");
  assert.equal(workload!.interpreter!.nodeVersion, process.version, "the probed version is the effective node's own");
});

test("FG-555 workload runtime: a NON-node workload records no interpreter (its runtime is the same unknowable class as R4 — never guessed), and no profile without a contract", () => {
  const { workload } = runRecorder(["true"]);
  assert.ok(workload);
  assert.equal(workload!.interpreter, undefined, "a non-node argv[0] is not probed for a Node ABI it does not have");
  assert.equal(workload!.profile, undefined, "no profile was declared, so none is recorded — never fabricated");
});

test("FG-555 R3 derived: a bare argv[0] resolves on PATH at spawn time (recorded, not guessed)", () => {
  const { workload } = runRecorder(["true"]);
  assert.ok(workload);
  assert.equal(workload!.r3.kind, "derived");
  assert.match(workload!.r3.kind === "derived" ? workload!.r3.execPath : "", /\/true$/);
});

test("FG-555 R3 empty PATH component = cwd: the recorder resolves argv[0] against the launch cwd exactly as spawnSync does — not skipped as if unresolved", () => {
  // A leading `:` in PATH is an empty component, which execvp (and thus spawnSync)
  // treats as the launch cwd. Pre-fix the recorder skipped empty components, so a
  // bare argv[0] living ONLY in cwd recorded `unresolved` (or a wrong /usr/bin path)
  // while spawnSync actually ran `./argv0` — the exact spawn-time/record divergence
  // the effective-executable evidence forbids. Now cwd is resolved like any dir.
  const workdir = realpathSync(mkdtempSync(join(scratch, "cwd-")));
  const binName = "fg555cwdbin";
  const bin = join(workdir, binName);
  writeFileSync(bin, "#!/bin/sh\necho CWD-RAN\n");
  chmodSync(bin, 0o755);

  const dir = mkdtempSync(join(scratch, "rec-cwd-"));
  const wrapper = buildWrapperCommand([binName], join(dir, "out.log"), join(dir, "exit"), join(dir, "runtime.json"), process.execPath, null, null);
  // Empty leading component (cwd), then a dir that does NOT contain the binary: the
  // ONLY way argv[0] resolves is via the empty=cwd rule.
  const r = spawnSync("/bin/sh", ["-c", wrapper], { encoding: "utf8", cwd: workdir, env: { ...process.env, PATH: ":/nonexistent-fg555" } });
  assert.equal(r.status, 0, `recorder wrapper failed: ${r.stderr}`);

  const workload = parseWorkloadProvenance(readFileSync(join(dir, "workload.json"), "utf8"));
  assert.ok(workload);
  assert.equal(workload!.r3.kind, "derived", "argv[0] in cwd resolves via the empty PATH component, not skipped as unresolved");
  const execPath = workload!.r3.kind === "derived" ? workload!.r3.execPath : "";
  assert.equal(basename(execPath), binName);
  assert.equal(execPath, bin, "R3 records the exact cwd executable spawnSync ran, not a wrong PATH entry");
  assert.match(readFileSync(join(dir, "out.log"), "utf8"), /CWD-RAN/, "the cwd binary really executed — the record matches the spawn");
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

test(
  "FG-555 R4 honesty: the RECORDER records `env … bash -lc …` as UNKNOWABLE, not a false not_applicable — the nested shell behind env is not hidden",
  { skip: hasBash ? false : "bash not available" },
  () => {
    // The exact round-3 shape run through the REAL recorder: a nested shell hidden
    // behind `env` (with a benign assignment). Pre-fix the recorder classified argv[0]
    // ("env") and wrote r4 not_applicable — a false "no later shell resolution occurs".
    // The recorder now skips the `env` prefix + assignment, sees `bash -lc`, and records
    // unknowable. This holds regardless of the flag: an honest record is unconditional.
    const { workload } = runRecorder(["env", "FOO=bar", "bash", "-lc", "true"]);
    assert.ok(workload);
    assert.equal(workload!.r4.kind, "unknowable", "env … bash -lc … must record R4 unknowable");
    assert.equal(workload!.r4.kind === "unknowable" ? workload!.r4.shell : "", "bash");
    assert.equal(workload!.r3.argv0, "env", "R3 honestly names env as the top-level executable that actually ran");
  },
);

test("FG-555 bare assignment (recorder): a leading `VAR=VAL node …` records R3 unresolved / R4 unknowable AND the direct spawn ENOENTs — the assignment is NOT applied without a shell", () => {
  // `-- FOO=bar node -e 0` at the real recorder boundary. The recorder spawns
  // argv[0]=`FOO=bar` DIRECTLY (no shell to apply it), so it ENOENTs. Pre-fix the R4
  // classifier skipped the bare assignment and recorded not_applicable (as it does for
  // a direct `node`), falsely implying the `node` behind it was the runtime. The record
  // must honestly name the assignment as the (unresolved) effective argv[0] and stay
  // unknowable — and the spawn must NOT silently succeed as if `node` had run.
  const { workload, log } = runRecorder(["FOO=bar", process.execPath, "-e", "process.stdout.write('SHOULD-NOT-RUN\\n')"]);
  assert.ok(workload, "the recorder wrote workload.json");
  assert.deepEqual(workload!.r3, { kind: "unresolved", argv0: "FOO=bar" }, "R3 records the bare assignment as the unresolved effective argv[0] a direct spawn ran");
  assert.equal(workload!.r4.kind, "unknowable", "R4 stays unknowable — a bare assignment is not a terminal node interpreter");
  assert.equal(workload!.interpreter, undefined, "no interpreter is probed — argv[0] did not resolve to node");
  assert.ok(!log.includes("SHOULD-NOT-RUN"), "the direct spawn of `FOO=bar` ENOENTs — the node behind the un-applied assignment never ran");
});

test("FG-555 R4 UNKNOWABLE: the RECORDER records a bare `npm`-style launcher as unknowable — its shebang resolves Node AFTER argv[0] is spawned, so not_applicable would be a false 'no later resolution'", () => {
  // A real npm-style launcher on PATH: a Node-shebang script (`#!/usr/bin/env node`).
  // The recorder spawns argv[0] (`npm`) directly and resolves it to this path (R3
  // derived), but the Node interpreter that actually runs the launcher's JS is
  // resolved LATER, by the shebang, against whatever PATH exec builds — unknowable at
  // launch time. Pre-fix the recorder wrote r4 not_applicable (as it does for a direct
  // `node`), falsely implying the argv was the full resolution while an ABI-incompatible
  // node could still run. It must record R4 unknowable and probe no interpreter.
  const bindir = mkdtempSync(join(scratch, "npmbin-"));
  const fakeNpm = join(bindir, "npm");
  writeFileSync(fakeNpm, "#!/usr/bin/env node\nprocess.stdout.write('NPM-RAN\\n')\n");
  chmodSync(fakeNpm, 0o755);

  const { workload, log } = runRecorder(["npm", "run", "test:all"], { ...process.env, PATH: `${bindir}:${process.env.PATH ?? ""}` });
  assert.ok(workload, "the recorder wrote workload.json");
  assert.equal(workload!.r3.kind, "derived", "R3 resolves the launcher on PATH");
  assert.equal(workload!.r3.kind === "derived" ? workload!.r3.execPath : "", fakeNpm, "R3 is the exact npm the recorder spawned");
  assert.equal(workload!.r4.kind, "unknowable", "a Node-shebang launcher has a later, unknowable interpreter resolution");
  assert.equal(workload!.r4.kind === "unknowable" ? workload!.r4.shell : "", "npm");
  assert.equal(workload!.interpreter, undefined, "the launcher's own Node interpreter is never guessed at launch time");
  // The launcher really executed through its shebang — proof there WAS a later Node
  // resolution the recorder could not have named.
  assert.match(log, /NPM-RAN/, "npm ran via its shebang-resolved node");
});

test("FG-555 R4 INVERSION (recorder): default unknowable — a bare script and an arbitrary node-shebang launcher (NOT in any allowlist) both record unknowable; a terminal node stays not_applicable", () => {
  // The inversion: the recorder no longer enumerates launcher basenames. A bare
  // script (its own shebang selects an interpreter later) and an unrecognized
  // node-shebang launcher (`vitest`, not npm/npx/forge/yarn/pnpm) both fall to the
  // unknowable default — pre-fix each recorded a false not_applicable.
  const bindir = mkdtempSync(join(scratch, "inv-"));

  const script = join(bindir, "verify.sh");
  writeFileSync(script, "#!/bin/sh\necho SCRIPT-RAN\n");
  chmodSync(script, 0o755);
  const s = runRecorder([script]);
  assert.ok(s.workload, "the recorder wrote workload.json");
  assert.equal(s.workload!.r3.kind, "captured", "R3 captures the script path the recorder spawned");
  assert.equal(s.workload!.r4.kind, "unknowable", "a bare script's shebang resolves its interpreter later — unknowable");
  assert.equal(s.workload!.r4.kind === "unknowable" ? s.workload!.r4.shell : "", "verify.sh");
  assert.equal(s.workload!.interpreter, undefined, "a non-node argv[0] is never probed for a Node ABI");
  assert.match(s.log, /SCRIPT-RAN/, "the script really ran via its own shebang");

  const vitest = join(bindir, "vitest");
  writeFileSync(vitest, `#!${process.execPath}\nprocess.stdout.write('VITEST-RAN\\n')\n`);
  chmodSync(vitest, 0o755);
  const v = runRecorder(["vitest", "run"], { ...process.env, PATH: `${bindir}:${process.env.PATH ?? ""}` });
  assert.ok(v.workload, "the recorder wrote workload.json");
  assert.equal(v.workload!.r3.kind, "derived", "R3 resolves the launcher on PATH");
  assert.equal(v.workload!.r4.kind, "unknowable", "vitest resolves node via its shebang — unknowable even though it is not an enumerated launcher");
  assert.equal(v.workload!.r4.kind === "unknowable" ? v.workload!.r4.shell : "", "vitest");
  assert.equal(v.workload!.interpreter, undefined, "the launcher's own Node interpreter is never guessed at launch time");
  assert.match(v.log, /VITEST-RAN/, "vitest ran via its shebang-resolved node");

  // The one provable case survives the inversion: a terminal node interpreter.
  const n = runRecorder([process.execPath, "-e", "0"]);
  assert.ok(n.workload);
  assert.equal(n.workload!.r4.kind, "not_applicable", "a terminal node interpreter IS the runtime — not_applicable");
});

test("FG-555 refuse-before-execute: Node 23/ABI 131 vs required ABI 137 is refused BEFORE the workload runs, with a NAMED mismatch", () => {
  // A fake `node` on the pinned PATH that reports ABI 131 — the incompatible Node
  // of the reproduction. The control contract requires ABI 137. This is the exact
  // false-red trigger: opening better-sqlite3 under ABI 131 dies with
  // ERR_DLOPEN_FAILED across hundreds of unrelated tests. A DIRECT command (not a
  // shell) so the ABI probe governs — a login shell is refused earlier, on its own
  // grounds (covered below).
  const fakebin = mkdtempSync(join(scratch, "fakebin-"));
  const fakeNode = join(fakebin, "node");
  writeFileSync(fakeNode, "#!/bin/sh\necho 131\n");
  chmodSync(fakeNode, 0o755);

  const stub = tmuxStub();
  const profile: LaunchProfile = { path: `${fakebin}:${process.env.PATH ?? ""}`, requireAbi: "137", label: "control-runtime" };

  assert.throws(
    () => startLaunch(["node", "-e", "1"], { name: "repro", tmux: stub.tmux, profile }),
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

test("FG-555 refuse-before-execute: a caller-supplied login shell is refused under the contract even when the pinned toolchain's ABI matches — the pin cannot survive the shell's profile scripts", () => {
  // controlRuntimeProfile pins forge's OWN node first, so the ABI probe would PASS.
  // But the workload is `bash -lc`: a login shell re-sources profile scripts that
  // reset PATH after the pin, so it can still resolve a wrong-ABI node at runtime.
  // The contract cannot protect that, so it refuses BEFORE any session exists —
  // the exact hole a passing ABI probe would otherwise mask.
  const stub = tmuxStub();
  const profile = controlRuntimeProfile({ label: "control-runtime" });

  assert.throws(
    () => startLaunch(["bash", "-lc", "npm run test:all"], { name: "loginrepro", tmux: stub.tmux, profile }),
    (e: Error) => {
      assert.match(e.message, /refusing to run/);
      // Fail-closed: the refusal is because a shell is not PROVABLE (login or not),
      // not a special-cased login-shell message.
      assert.match(e.message, /shell/);
      return true;
    },
  );

  assert.ok(!stub.calls.some((c) => c[0] === "new-session"), "the shell refusal precedes any tmux session");
  assert.equal(listLaunches(stub.tmux).length, 0, "and no launch record was written");
});

test("FG-555 refuse-before-execute (fail-closed): an env-wrapped login shell (env PATH=… bash -lc …) is refused — the PATH-mutating assignment behind env defeats the pin", () => {
  // Round 3's bypass, at the production boundary: `env PATH=/evil bash -lc …`. The
  // pinned PATH still resolves the control node (probe green), but the effective
  // command behind `env` is a shell AND the assignment mutates PATH — both fatal
  // under the fail-closed contract. Refused BEFORE any tmux session exists.
  const stub = tmuxStub();
  const profile = controlRuntimeProfile({ label: "control-runtime" });

  assert.throws(
    () => startLaunch(["env", "PATH=/evil", "bash", "-lc", "npm run test:all"], { name: "envrepro", tmux: stub.tmux, profile }),
    (e: Error) => {
      assert.match(e.message, /refusing to run/);
      assert.match(e.message, /PATH/);
      return true;
    },
  );

  assert.ok(!stub.calls.some((c) => c[0] === "new-session"), "the env-wrapper refusal precedes any tmux session");
  assert.equal(listLaunches(stub.tmux).length, 0, "and no launch record was written");
});

test("FG-555 refuse-before-execute (fail-closed): a bare `VAR=VAL node …` is REFUSED — a direct spawn runs argv[0] literally (ENOENT), so the assignment is never applied; the broken spawn never reaches a tmux session", () => {
  // `forge launch run --require-control-toolchain -- FOO=bar node -e 0`. The node behind
  // the assignment resolves on the pinned PATH (probe would be green), but the recorder
  // spawns argv[0]=`FOO=bar` DIRECTLY — a literal executable name that ENOENTs. Pre-fix
  // the guard skipped the bare assignment, proved the `node` behind it, and let this
  // through to a broken spawn. The contract refuses it BEFORE any tmux session exists.
  const stub = tmuxStub();
  const profile = controlRuntimeProfile({ label: "control-runtime" });

  assert.throws(
    () => startLaunch(["FOO=bar", process.execPath, "-e", "0"], { name: "bareassign", tmux: stub.tmux, profile }),
    (e: Error) => {
      assert.match(e.message, /refusing to run/);
      assert.match(e.message, /assignment/, "the refusal names the bare assignment, not the node behind it");
      return true;
    },
  );

  assert.ok(!stub.calls.some((c) => c[0] === "new-session"), "the bare-assignment refusal precedes any tmux session — the broken spawn never runs");
  assert.equal(listLaunches(stub.tmux).length, 0, "and no launch record was written");

  // No regression: `env FOO=bar <control-node> …` is a real exec-prefix — `env` applies
  // the assignment and execs the pinned control node, so it is NOT refused and proceeds.
  const okStub = tmuxStub();
  const meta = startLaunch(["env", "FOO=bar", process.execPath, "-e", "0"], { name: "envassign", tmux: okStub.tmux, profile });
  assert.match(meta.id, /^launch-envassign-/, "env FOO=bar <control node> … proceeds — the effective argv[0] is the control node");
  assert.ok(okStub.calls.some((c) => c[0] === "new-session"), "the env-prefixed control node proceeds to create the session");
});

test("FG-555 contract satisfied: the matching control toolchain is NOT refused — the launch proceeds", () => {
  // controlRuntimeProfile pins forge's OWN node (dir first on PATH); its ABI is by
  // construction the required ABI. A direct node interpreter (this very node, ABI ==
  // required) is a PROVABLE command under the fail-closed contract, so it runs unhindered.
  const stub = tmuxStub();
  const profile = controlRuntimeProfile({ label: "control-runtime" });
  const meta = startLaunch([process.execPath, "-e", "0"], { name: "okabi", tmux: stub.tmux, profile });
  assert.match(meta.id, /^launch-okabi-/);
  assert.ok(stub.calls.some((c) => c[0] === "new-session"), "a matching toolchain proceeds to create the session");
});

test("FG-555 contract pins the session PATH via `new-session -e` — the workload never inherits an ambient login-shell PATH", () => {
  const stub = tmuxStub();
  // node resolves to the real control node (dir first) so the guard passes; the
  // point under test is the pinned PATH reaching the tmux session.
  const pinned = `${dirname(process.execPath)}:/fg555-pinned-marker`;
  const profile: LaunchProfile = { path: pinned, requireAbi: process.versions.modules, label: "control-runtime" };
  // A direct node interpreter (provable under the fail-closed contract) so the guard
  // passes; the point under test is the pinned PATH reaching the tmux session.
  startLaunch([process.execPath, "-e", "0"], { name: "pinpath", tmux: stub.tmux, profile });

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
