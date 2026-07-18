// FG-535: the pure halves of the durable launcher — exit-code classification
// (the operator-visible "externally terminated" evidence), shell quoting for
// the tmux wrapper, and opportunistic forge-id extraction.

import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname } from "node:path";
import {
  assertProfileToolchain,
  buildWrapperCommand,
  classifyExit,
  controlRuntimeProfile,
  deriveWorkloadProvenance,
  extractForgeIds,
  parseExitRecord,
  parseRecorderRuntime,
  parseWorkloadProvenance,
  shellQuote,
} from "./launch.js";

test("FG-535 classify: 0 is exited_ok", () => {
  assert.deepEqual(classifyExit({ code: 0, signal: null }), { state: "exited_ok", code: 0 });
});

test("FG-535 classify: an ordinary failure is exited_error, not a signal", () => {
  assert.deepEqual(classifyExit({ code: 1, signal: null }), { state: "exited_error", code: 1 });
  assert.deepEqual(classifyExit({ code: 2, signal: null }), { state: "exited_error", code: 2 });
});

test("FG-535 classify: WIFSIGNALED evidence names the signal but NEVER the sender", () => {
  // The kernel told us a SIGTERM landed. It did not tell us who sent it, and
  // nothing here records si_pid — so the sender stays unrecorded rather than
  // being asserted as "external". FG-535 AC.
  assert.deepEqual(classifyExit({ code: null, signal: "SIGTERM" }), {
    state: "signaled", signal: "SIGTERM", sender: "unrecorded",
  });
  assert.deepEqual(classifyExit({ code: null, signal: "SIGKILL" }), {
    state: "signaled", signal: "SIGKILL", sender: "unrecorded",
  });
});

test("FG-535 classify: a DELIBERATE exit 143 is not a kill — it has no signal evidence", () => {
  // The bug this guards: exit 143 alone is ambiguous. A command that returns
  // 143 on purpose must never be reported as terminated by SIGTERM.
  assert.deepEqual(classifyExit({ code: 143, signal: null }), { state: "terminated_unattributed", code: 143 });
});

test("FG-535 classify: a signal-range code with no signal evidence stays unattributed, never upgraded", () => {
  for (const code of [137, 143, 158]) {
    const status = classifyExit({ code, signal: null });
    assert.equal(status.state, "terminated_unattributed", `exit ${code} must not claim a signal`);
  }
});

test("FG-535 exit record: JSON is authoritative; a bare number (older wrapper) carries no signal evidence", () => {
  assert.deepEqual(parseExitRecord(`{"code":null,"signal":"SIGTERM"}`), { code: null, signal: "SIGTERM" });
  assert.deepEqual(parseExitRecord("143\n"), { code: 143, signal: null });
  assert.deepEqual(classifyExit(parseExitRecord("143\n")!), { state: "terminated_unattributed", code: 143 });
  assert.equal(parseExitRecord("garbage"), undefined);
  assert.equal(parseExitRecord(""), undefined);
});

test("FG-569 R2: the recorder runtime record is parsed; a missing required field is rejected, never guessed", () => {
  assert.deepEqual(
    parseRecorderRuntime(`{"execPath":"/opt/n/bin/node","abi":"137","nodeVersion":"v24.0.0","releaseId":"release-abc-1"}`),
    { execPath: "/opt/n/bin/node", abi: "137", nodeVersion: "v24.0.0", releaseId: "release-abc-1" },
  );
  // releaseId is optional (dev has none) and defaults to null, never fabricated.
  assert.deepEqual(
    parseRecorderRuntime(`{"execPath":"/usr/bin/node","abi":"137","nodeVersion":"v24.0.0"}`),
    { execPath: "/usr/bin/node", abi: "137", nodeVersion: "v24.0.0", releaseId: null },
  );
  assert.equal(parseRecorderRuntime(`{"abi":"137"}`), undefined, "no execPath ⇒ not a usable R2 record");
  assert.equal(parseRecorderRuntime("garbage"), undefined);
});

test("FG-535 quote: single quotes inside arguments survive", () => {
  assert.equal(shellQuote("it's"), `'it'\\''s'`);
  assert.equal(shellQuote("plain"), "'plain'");
});

test("FG-535 wrapper: runs the target under a node runner that records signal separately from code", () => {
  const w = buildWrapperCommand(["forge", "review-loop", "FG-1"], "/l/out.log", "/l/exit", "/l/runtime.json", "/usr/bin/node");
  assert.ok(w.startsWith("'/usr/bin/node' '-e'"), w);
  assert.ok(w.includes("spawnSync"), "the OS reports WIFSIGNALED — the shell's $? cannot");
  // FG-569: the runtime.json path is threaded before the target argv so the
  // recorder writes its OWN R2 runtime as its first act.
  assert.ok(w.endsWith(`'/l/exit' '/l/out.log' '/l/runtime.json' 'forge' 'review-loop' 'FG-1'`), w);
});

test("FG-555 argv preservation: buildWrapperCommand spawns argv[0] DIRECTLY — no synthesized bash / login shell around the caller argv", () => {
  const w = buildWrapperCommand(["npm", "run", "test:all"], "/l/out.log", "/l/exit", "/l/runtime.json", "/usr/bin/node");
  // The ONLY shell is the /bin/sh tmux uses to run the `node -e` wrapper. The
  // CALLER argv is never wrapped: the wrapper's trailing tokens are EXACTLY the
  // shell-quoted submitted argv, in order.
  assert.ok(w.endsWith(`'/l/exit' '/l/out.log' '/l/runtime.json' 'npm' 'run' 'test:all'`), w);
  // No login shell was synthesized around the caller argv (these single-quoted
  // forms are how a synthesized argv[0]='bash' / '-lc' would appear).
  assert.ok(!w.includes(`'bash'`), "forge must not synthesize a bash argv[0]");
  assert.ok(!w.includes(`'-lc'`) && !w.includes(`'--login'`), "forge must not synthesize a login shell");
  // And the recorder's own spawn is spawnSync(a0, …) — argv[0] directly.
  assert.ok(w.includes("spawnSync(a0,a.slice(1)"), "the recorder spawns argv[0] directly, not through a shell");
});

test("FG-555 R3/R4 derivation: captured path, derived-on-PATH, unresolved, and a nested-shell R4 unknowable", () => {
  // R3 captured — argv[0] is itself a path, so the string IS the resolution.
  assert.deepEqual(deriveWorkloadProvenance(["/opt/node", "x"]).r3, { kind: "captured", argv0: "/opt/node", execPath: "/opt/node" });

  // R3 derived — a bare name resolved against PATH (resolver injected).
  const d = deriveWorkloadProvenance(["node", "-v"], { path: "/b", resolve: (n) => (n === "node" ? "/b/node" : undefined) });
  assert.deepEqual(d.r3, { kind: "derived", argv0: "node", execPath: "/b/node" });
  assert.equal(d.r4.kind, "not_applicable", "a direct executable has no later nested-shell resolution");

  // R3 unresolved — recorded as fact, never guessed.
  assert.deepEqual(deriveWorkloadProvenance(["ghost"], { resolve: () => undefined }).r3, { kind: "unresolved", argv0: "ghost" });

  // R4 unknowable — a caller-supplied nested login shell; argv NEVER implies it is covered.
  const s = deriveWorkloadProvenance(["bash", "-lc", "npm test"], { resolve: () => "/bin/bash" });
  assert.equal(s.r4.kind, "unknowable");
  assert.equal(s.r4.kind === "unknowable" ? s.r4.shell : "", "bash");
  assert.equal(s.r3.kind, "derived", "R3 still honestly names the shell binary as the top-level executable");
});

test("FG-555 workload record: valid R3/R4 parses; a missing required field is omitted, never guessed", () => {
  const good = { r3: { kind: "captured", argv0: "/n", execPath: "/n" }, r4: { kind: "unknowable", shell: "bash", reason: "r" } };
  assert.deepEqual(parseWorkloadProvenance(JSON.stringify(good)), good);
  assert.equal(parseWorkloadProvenance(JSON.stringify({ r3: { kind: "captured", argv0: "/n" }, r4: { kind: "not_applicable", reason: "r" } })), undefined, "captured without execPath is malformed — omitted");
  assert.equal(parseWorkloadProvenance(JSON.stringify({ r3: { kind: "derived", argv0: "n", execPath: "/n" } })), undefined, "missing r4 is malformed");
  assert.equal(parseWorkloadProvenance("garbage"), undefined);
});

test("FG-555 control-runtime profile: pins forge's OWN node dir at the FRONT of PATH and requires the control ABI", () => {
  const p = controlRuntimeProfile({ label: "control-runtime" });
  assert.equal(p.requireAbi, process.versions.modules, "the contract requires the control runtime's own ABI");
  assert.equal(p.path.split(":")[0], dirname(process.execPath), "the control node dir is FIRST on the pinned PATH");
  assert.equal(p.label, "control-runtime");
});

test("FG-555 toolchain guard: a mismatched ABI is a NAMED refusal; a match passes; an unresolvable node has nothing to assert", () => {
  const profile = { path: "/p", requireAbi: "137", label: "control-runtime" };
  const resolve = () => "/p/node";

  const bad = assertProfileToolchain(profile, ["forge", "next"], { resolve, probeAbi: () => "131" });
  assert.equal(bad.ok, false);
  assert.match(bad.ok === false ? bad.message : "", /refusing to run/);
  assert.match(bad.ok === false ? bad.message : "", /ABI 137/);
  assert.match(bad.ok === false ? bad.message : "", /131/);

  assert.deepEqual(assertProfileToolchain(profile, ["forge", "next"], { resolve, probeAbi: () => "137" }), { ok: true }, "a matching ABI passes");

  const unreadable = assertProfileToolchain(profile, ["forge", "next"], { resolve, probeAbi: () => undefined });
  assert.equal(unreadable.ok, false, "an unreadable ABI is not waved through (reuses checkAbi's unverifiable-ABI refusal)");

  assert.deepEqual(assertProfileToolchain(profile, ["forge", "next"], { resolve: () => undefined, probeAbi: () => "999" }), { ok: true }, "no node resolvable on the pinned PATH ⇒ nothing to assert");
});

test("FG-555 toolchain guard: a caller-supplied login shell is refused under the contract — the pinned PATH cannot survive its profile scripts", () => {
  // ABI would MATCH (resolve → a control node, probe → the required ABI), so the
  // refusal is about the login shell itself, NOT the probe: the probe reads the
  // pre-shell PATH, but a login shell resets PATH afterwards and can still resolve
  // a wrong-ABI node during the run.
  const profile = { path: "/p", requireAbi: "137", label: "control-runtime" };
  const resolve = () => "/p/node";
  const probeAbi = () => "137";

  for (const argv of [["bash", "-lc", "npm run test:all"], ["zsh", "--login", "-c", "x"], ["sh", "-il"]]) {
    const r = assertProfileToolchain(profile, argv, { resolve, probeAbi });
    assert.equal(r.ok, false, `${argv.join(" ")} is refused`);
    assert.match(r.ok === false ? r.message : "", /login shell/);
  }

  // A NON-login shell keeps the pinned session PATH, so the ABI probe governs it
  // (here it matches) — it is not refused outright.
  assert.deepEqual(assertProfileToolchain(profile, ["bash", "-c", "npm run test:all"], { resolve, probeAbi }), { ok: true }, "a non-login shell is governed by the ABI probe, not refused as a login shell");
});

test("FG-535 ids: run/task ids are extracted uniquely from log text; absence is empty, not an error", () => {
  const log = "run: run-review-loop-fg-533-84f4a2\ntask task-red-wide-6e37ed done; task-red-wide-6e37ed again";
  assert.deepEqual(extractForgeIds(log), {
    runIds: ["run-review-loop-fg-533-84f4a2"],
    taskIds: ["task-red-wide-6e37ed"],
  });
  assert.deepEqual(extractForgeIds("no ids here"), { runIds: [], taskIds: [] });
});
