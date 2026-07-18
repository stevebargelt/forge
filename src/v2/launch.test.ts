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

test("FG-555 R4 honesty: a nested shell HIDDEN behind env + a PATH-mutating assignment is still UNKNOWABLE, never a false not_applicable", () => {
  // Pre-fix R4 only looked at argv[0]; `env … bash -lc …` made argv[0]==="env" and
  // recorded not_applicable — a FALSE "no later shell resolution occurs". The fix skips
  // the leading assignments and the `env` prefix, sees the nested `bash -lc`, and records
  // unknowable. R3 still honestly names `env` as the top-level executable.
  const w = deriveWorkloadProvenance(["env", "PATH=/evil", "bash", "-lc", "npm test"], { resolve: () => "/usr/bin/env" });
  assert.equal(w.r4.kind, "unknowable", "the nested shell behind env is not hidden from R4");
  assert.equal(w.r4.kind === "unknowable" ? w.r4.shell : "", "bash");
  assert.equal(w.r3.argv0, "env", "R3 honestly names the top-level executable that actually ran");

  // A non-PATH exec-prefix in front of a nested shell is also seen through.
  const t = deriveWorkloadProvenance(["nohup", "bash", "-c", "x"], { resolve: () => "/x" });
  assert.equal(t.r4.kind, "unknowable", "a shell behind nohup is still unknowable");

  // A direct, non-shell effective command behind a prefix stays not_applicable.
  const d = deriveWorkloadProvenance(["env", "FOO=bar", "node", "-e", "0"], { resolve: () => "/x" });
  assert.equal(d.r4.kind, "not_applicable", "env FOO=bar node … has no nested shell — honestly not_applicable");
});

test("FG-555 R4 honesty: a bare npm/npx/forge launcher is UNKNOWABLE — its shebang resolves Node later, so not_applicable would be a false 'no later resolution'", () => {
  // npm/npx/forge are themselves Node scripts (`#!/usr/bin/env node`): the recorder
  // spawns argv[0], and only THEN does the shebang resolve a Node interpreter against
  // PATH. So a direct `npm …` still has a later, unknowable interpreter resolution —
  // recording not_applicable (as a plain `node …` correctly does) would falsely imply
  // the argv is the full resolution. R3 still honestly names the launcher itself.
  for (const tool of ["npm", "npx", "forge", "yarn", "pnpm"]) {
    const w = deriveWorkloadProvenance([tool, "run", "test:all"], { resolve: () => `/usr/local/bin/${tool}` });
    assert.equal(w.r4.kind, "unknowable", `${tool} resolves Node via its shebang at runtime — unknowable`);
    assert.equal(w.r4.kind === "unknowable" ? w.r4.shell : "", tool);
    assert.equal(w.r3.kind, "derived", `R3 still honestly names ${tool} as the top-level executable`);
    assert.equal(w.interpreter, undefined, "the launcher's own Node interpreter is never guessed");
  }

  // The same launcher hidden behind an exec-prefix is seen through, exactly like a shell.
  const behindEnv = deriveWorkloadProvenance(["env", "FOO=bar", "npm", "test"], { resolve: () => "/x" });
  assert.equal(behindEnv.r4.kind, "unknowable", "npm behind env is still unknowable");
  assert.equal(behindEnv.r4.kind === "unknowable" ? behindEnv.r4.shell : "", "npm");

  // A direct `node …` remains not_applicable — its argv IS the full resolution.
  const directNode = deriveWorkloadProvenance(["node", "-e", "0"], { resolve: () => "/b/node" });
  assert.equal(directNode.r4.kind, "not_applicable", "a direct node interpreter has no later launcher resolution");
});

test("FG-555 workload record: valid R3/R4 parses; a missing required field is omitted, never guessed", () => {
  const good = { r3: { kind: "captured", argv0: "/n", execPath: "/n" }, r4: { kind: "unknowable", shell: "bash", reason: "r" } };
  assert.deepEqual(parseWorkloadProvenance(JSON.stringify(good)), good);
  assert.equal(parseWorkloadProvenance(JSON.stringify({ r3: { kind: "captured", argv0: "/n" }, r4: { kind: "not_applicable", reason: "r" } })), undefined, "captured without execPath is malformed — omitted");
  assert.equal(parseWorkloadProvenance(JSON.stringify({ r3: { kind: "derived", argv0: "n", execPath: "/n" } })), undefined, "missing r4 is malformed");
  assert.equal(parseWorkloadProvenance("garbage"), undefined);
});

test("FG-555 workload runtime provenance: deriveWorkloadProvenance carries the pinned profile and probes the effective Node interpreter (bounded to node/nodejs); parse round-trips both", () => {
  const profile = { path: "/control/bin:/usr/bin", requireAbi: "137", label: "control-runtime" };
  const probeInterpreter = (ep: string) => ({ execPath: ep, abi: "137", nodeVersion: "v24.1.0" });

  // A direct node interpreter → probed; profile carried through.
  const d = deriveWorkloadProvenance(["/control/bin/node", "-e", "0"], { profile, probeInterpreter });
  assert.deepEqual(d.profile, profile, "the pinned profile is carried on the provenance");
  assert.deepEqual(d.interpreter, { execPath: "/control/bin/node", abi: "137", nodeVersion: "v24.1.0" }, "a Node interpreter is probed for its ABI/version");

  // A non-node workload → not probed (its runtime is unknowable, never guessed).
  const nn = deriveWorkloadProvenance(["/usr/bin/make", "test"], { profile, probeInterpreter });
  assert.equal(nn.interpreter, undefined, "a non-node argv[0] is not probed for a Node ABI");

  // No profile / no prober → neither field appears.
  const bare = deriveWorkloadProvenance(["/control/bin/node"]);
  assert.equal(bare.profile, undefined);
  assert.equal(bare.interpreter, undefined);

  // Serialization round-trips profile + interpreter; a malformed optional is dropped
  // without invalidating the core R3/R4.
  assert.deepEqual(parseWorkloadProvenance(JSON.stringify(d)), d, "profile + interpreter round-trip through the recorder's JSON");
  const partialBadItp = { ...d, interpreter: { execPath: "/n" } };
  const parsed = parseWorkloadProvenance(JSON.stringify(partialBadItp));
  assert.ok(parsed, "a malformed interpreter does not invalidate the core record");
  assert.equal(parsed!.interpreter, undefined, "the malformed interpreter is omitted, never guessed");
  assert.deepEqual(parsed!.profile, profile, "the still-valid profile survives");
});

test("FG-555 control-runtime profile: pins forge's OWN node dir at the FRONT of PATH and requires the control ABI", () => {
  const p = controlRuntimeProfile({ label: "control-runtime" });
  assert.equal(p.requireAbi, process.versions.modules, "the contract requires the control runtime's own ABI");
  assert.equal(p.path.split(":")[0], dirname(process.execPath), "the control node dir is FIRST on the pinned PATH");
  assert.equal(p.label, "control-runtime");
});

test("FG-555 toolchain guard (fail-closed): a control tool inside the pinned dir passes; an unprovable command is REFUSED — the invariant is 'prove it, or refuse'", () => {
  const profile = { path: "/p", requireAbi: "137", label: "control-runtime" };
  // `forge`/`npm`/`npx` resolving to a binary INSIDE the pinned dir (/p) run under the
  // pinned control node by construction — allowed, no ABI probe needed.
  const insidePinned = (name: string) => (name.includes("/") ? name : `/p/${name}`);
  assert.deepEqual(assertProfileToolchain(profile, ["forge", "next"], { resolve: insidePinned }), { ok: true }, "forge inside the pinned dir is provable");
  assert.deepEqual(assertProfileToolchain(profile, ["npm", "run", "test:all"], { resolve: insidePinned }), { ok: true }, "npm inside the pinned dir is provable");

  // DELIBERATE CHANGE vs the pre-fix guard: the old code returned ok:true when node
  // was UNRESOLVABLE ("nothing to assert"). Fail-closed inverts that — a control tool
  // that does NOT resolve inside the pinned dir is REFUSED, because the contract
  // cannot prove it runs the pinned node.
  const gone = assertProfileToolchain(profile, ["forge", "next"], { resolve: () => undefined });
  assert.equal(gone.ok, false, "a forge that does not resolve on the pinned PATH is now refused, not waved through");
  assert.match(gone.ok === false ? gone.message : "", /refusing to run/);

  // A control tool resolving OUTSIDE the pinned dir is also refused (it might be a
  // different, incompatible install).
  const outside = assertProfileToolchain(profile, ["forge", "next"], { resolve: () => "/usr/local/bin/forge" });
  assert.equal(outside.ok, false, "forge outside the pinned dir is not provable");

  // An unrecognized wrapper/binary is refused (fail closed), not passed through.
  const unknown = assertProfileToolchain(profile, ["make", "test"], { resolve: () => "/usr/bin/make" });
  assert.equal(unknown.ok, false, "an unknown binary the contract cannot prove is refused");
  assert.match(unknown.ok === false ? unknown.message : "", /cannot prove/);
});

test("FG-555 toolchain guard: a node argv[0] is ALLOWED only when its probed ABI matches; a mismatch/unreadable ABI is a NAMED refusal", () => {
  const profile = { path: "/p", requireAbi: "137", label: "control-runtime" };
  const resolve = (name: string) => (name === "node" ? "/p/node" : name.includes("/") ? name : undefined);

  const bad = assertProfileToolchain(profile, ["node", "x.js"], { resolve, probeAbi: () => "131" });
  assert.equal(bad.ok, false);
  assert.match(bad.ok === false ? bad.message : "", /refusing to run/);
  assert.match(bad.ok === false ? bad.message : "", /ABI 137/);
  assert.match(bad.ok === false ? bad.message : "", /131/);

  assert.deepEqual(assertProfileToolchain(profile, ["node", "x.js"], { resolve, probeAbi: () => "137" }), { ok: true }, "a matching ABI passes");

  const unreadable = assertProfileToolchain(profile, ["node", "x.js"], { resolve, probeAbi: () => undefined });
  assert.equal(unreadable.ok, false, "an unreadable ABI is not waved through (reuses checkAbi's unverifiable-ABI refusal)");
});

test("FG-555 toolchain guard (fail-closed): a shell is refused whether or not it is a login shell — a shell can rebuild PATH and resolve an arbitrary runtime", () => {
  // ABI would MATCH (resolve → a control node, probe → the required ABI), so the
  // refusal is about the shell itself, NOT the probe: a shell can rebuild PATH and
  // resolve any node it likes at runtime, so the contract can never prove what it runs.
  const profile = { path: "/p", requireAbi: "137", label: "control-runtime" };
  const resolve = () => "/p/node";
  const probeAbi = () => "137";

  // DELIBERATE CHANGE vs the pre-fix guard: a NON-login shell (`bash -c …`) used to be
  // waved through ("governed by the ABI probe"). Under the fail-closed invariant EVERY
  // shell is refused — login or not — because none is provable.
  for (const argv of [["bash", "-lc", "npm run test:all"], ["zsh", "--login", "-c", "x"], ["sh", "-il"], ["bash", "-c", "npm run test:all"]]) {
    const r = assertProfileToolchain(profile, argv, { resolve, probeAbi });
    assert.equal(r.ok, false, `${argv.join(" ")} is refused`);
    assert.match(r.ok === false ? r.message : "", /shell/);
  }
});

test("FG-555 toolchain guard (fail-closed): an env-wrapped login shell is REFUSED — the PATH-mutating assignment defeats the pin (env PATH=… bash -lc …)", () => {
  // Round 3's bypass: `env PATH=/evil bash -lc '…'`. Pre-fix this reached ok:true —
  // the guard only probed the node on the pinned PATH and never saw the `env PATH=`
  // that resets it, nor the nested login shell behind `env`. Fail-closed refuses it:
  // the effective argv[0] after skipping `env` is a shell, AND the assignment mutates
  // PATH. Either is fatal; the message is the single named refusal.
  const profile = { path: "/p", requireAbi: "137", label: "control-runtime" };
  const resolve = () => "/p/node";
  const probeAbi = () => "137";

  const r = assertProfileToolchain(profile, ["env", "PATH=/evil", "bash", "-lc", "npm run test:all"], { resolve, probeAbi });
  assert.equal(r.ok, false, "env PATH=… bash -lc … must be refused (pre-fix this returned ok:true)");
  assert.match(r.ok === false ? r.message : "", /refusing to run/);
  assert.match(r.ok === false ? r.message : "", /PATH/);
});

test("FG-555 argv[0] bypass regression: an explicitly-named ABI-mismatched node as argv[0] is REFUSED before execution, even when the pinned-PATH probe is green", () => {
  // The bypass this closes: `forge launch run --require-control-toolchain -- /usr/local/bin/node test.js`.
  // The pinned PATH resolves the CONTROL node (ABI 137), so the pinned-PATH probe is green — but the
  // recorder spawns argv[0] DIRECTLY, so the ABI-131 node the caller named is what actually runs. Pre-fix,
  // the guard only probed the pinned-PATH node NAME and let this through; it must refuse the named interpreter.
  const profile = { path: "/control/bin:/usr/local/bin", requireAbi: "137", label: "control-runtime" };
  // Resolve "node" (bare, on PATH) to the CONTROL node; an explicit path resolves to itself.
  const resolve = (name: string) => (name === "node" ? "/control/bin/node" : name.includes("/") ? name : undefined);
  // The control node is ABI 137 (pinned probe passes); the caller-named node is ABI 131.
  const probeAbi = (nodeExec: string) => (nodeExec === "/control/bin/node" ? "137" : "131");

  const r = assertProfileToolchain(profile, ["/usr/local/bin/node", "test.js"], { resolve, probeAbi });
  assert.equal(r.ok, false, "the explicitly-named ABI-131 node must be refused before execution");
  const msg = r.ok === false ? r.message : "";
  assert.match(msg, /ABI 137/, "names the expected ABI");
  assert.match(msg, /131/, "names the found ABI");
  assert.match(msg, /argv\[0\]/, "attributes the refusal to the directly-named interpreter, not the pinned PATH");
});

test("FG-555 boundary (fail-closed): a directly-named node with the REQUIRED ABI is allowed; a non-node wrapper is now REFUSED, not passed through", () => {
  const profile = { path: "/control/bin", requireAbi: "137", label: "control-runtime" };
  const resolve = (name: string) => (name === "node" ? "/control/bin/node" : name.includes("/") ? name : undefined);

  // argv[0] IS a node whose ABI MATCHES the contract → not refused (an explicit path is
  // probed the same as a bare `node`: the recorder spawns exactly this executable).
  const okNode = assertProfileToolchain(profile, ["/opt/n24/bin/node", "test.js"], { resolve, probeAbi: () => "137" });
  assert.deepEqual(okNode, { ok: true }, "a directly-named node with the required ABI is not refused");

  // DELIBERATE CHANGE vs the pre-fix guard: a caller-authored NON-node wrapper used to be
  // the documented "unknowable boundary" that was passed through unprobed. The whole point
  // of this fix is to INVERT that: forge cannot prove what runtime such a wrapper selects,
  // so under the fail-closed contract it is REFUSED rather than waved through. Enumerating
  // wrappers is unwinnable; proving the toolchain is the only durable invariant.
  const wrapper = assertProfileToolchain(profile, ["/usr/local/bin/run-tests.sh", "test.js"], {
    resolve,
    probeAbi: (n: string) => (n === "/control/bin/node" ? "137" : "131"),
  });
  assert.equal(wrapper.ok, false, "a non-node wrapper argv[0] is not provable — now refused (fail closed)");
  assert.match(wrapper.ok === false ? wrapper.message : "", /cannot prove/);
});

test("FG-535 ids: run/task ids are extracted uniquely from log text; absence is empty, not an error", () => {
  const log = "run: run-review-loop-fg-533-84f4a2\ntask task-red-wide-6e37ed done; task-red-wide-6e37ed again";
  assert.deepEqual(extractForgeIds(log), {
    runIds: ["run-review-loop-fg-533-84f4a2"],
    taskIds: ["task-red-wide-6e37ed"],
  });
  assert.deepEqual(extractForgeIds("no ids here"), { runIds: [], taskIds: [] });
});
