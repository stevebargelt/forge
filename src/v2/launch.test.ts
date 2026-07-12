// FG-535: the pure halves of the durable launcher — exit-code classification
// (the operator-visible "externally terminated" evidence), shell quoting for
// the tmux wrapper, and opportunistic forge-id extraction.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildWrapperCommand, classifyExitCode, extractForgeIds, shellQuote } from "./launch.js";

test("FG-535 classify: 0 is exited_ok", () => {
  assert.deepEqual(classifyExitCode(0), { state: "exited_ok", code: 0 });
});

test("FG-535 classify: an ordinary failure is exited_error, not a signal", () => {
  assert.deepEqual(classifyExitCode(1), { state: "exited_error", code: 1 });
  assert.deepEqual(classifyExitCode(2), { state: "exited_error", code: 2 });
});

test("FG-535 classify: 143 is externally_terminated SIGTERM — the FG-535 kill signature", () => {
  assert.deepEqual(classifyExitCode(143), { state: "externally_terminated", code: 143, signal: "SIGTERM" });
});

test("FG-535 classify: 137 is externally_terminated SIGKILL", () => {
  assert.deepEqual(classifyExitCode(137), { state: "externally_terminated", code: 137, signal: "SIGKILL" });
});

test("FG-535 classify: an unnamed signal still classifies with its number", () => {
  assert.deepEqual(classifyExitCode(128 + 30), { state: "externally_terminated", code: 158, signal: "signal 30" });
});

test("FG-535 quote: single quotes inside arguments survive", () => {
  assert.equal(shellQuote("it's"), `'it'\\''s'`);
  assert.equal(shellQuote("plain"), "'plain'");
});

test("FG-535 wrapper: redirects to the log and writes the exit code LAST", () => {
  const w = buildWrapperCommand(["forge", "review-loop", "FG-1"], "/l/out.log", "/l/exit");
  assert.equal(w, `'forge' 'review-loop' 'FG-1' > '/l/out.log' 2>&1; echo $? > '/l/exit'`);
});

test("FG-535 ids: run/task ids are extracted uniquely from log text; absence is empty, not an error", () => {
  const log = "run: run-review-loop-fg-533-84f4a2\ntask task-red-wide-6e37ed done; task-red-wide-6e37ed again";
  assert.deepEqual(extractForgeIds(log), {
    runIds: ["run-review-loop-fg-533-84f4a2"],
    taskIds: ["task-red-wide-6e37ed"],
  });
  assert.deepEqual(extractForgeIds("no ids here"), { runIds: [], taskIds: [] });
});
