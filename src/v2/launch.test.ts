// FG-535: the pure halves of the durable launcher — exit-code classification
// (the operator-visible "externally terminated" evidence), shell quoting for
// the tmux wrapper, and opportunistic forge-id extraction.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildWrapperCommand, classifyExit, extractForgeIds, parseExitRecord, parseRecorderRuntime, shellQuote } from "./launch.js";

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

test("FG-535 ids: run/task ids are extracted uniquely from log text; absence is empty, not an error", () => {
  const log = "run: run-review-loop-fg-533-84f4a2\ntask task-red-wide-6e37ed done; task-red-wide-6e37ed again";
  assert.deepEqual(extractForgeIds(log), {
    runIds: ["run-review-loop-fg-533-84f4a2"],
    taskIds: ["task-red-wide-6e37ed"],
  });
  assert.deepEqual(extractForgeIds("no ids here"), { runIds: [], taskIds: [] });
});
