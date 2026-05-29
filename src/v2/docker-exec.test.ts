// docker-exec tests: container-name parsing + the authoritative kill path.
// The full executor (spawn + streams + timers) isn't exercised here, but the
// two pieces that make idle-kill correct — finding the right container name and
// issuing `docker kill <name>` — are unit-tested directly.

import { test } from "node:test";
import assert from "node:assert/strict";
import { containerNameFromArgs, killContainer } from "./docker-exec.js";

test("containerNameFromArgs: extracts the value after --name", () => {
  assert.equal(
    containerNameFromArgs(["run", "--rm", "--name", "forge-task-abc", "img"]),
    "forge-task-abc",
  );
});

test("containerNameFromArgs: undefined when --name is absent", () => {
  assert.equal(containerNameFromArgs(["run", "--rm", "img"]), undefined);
});

test("containerNameFromArgs: undefined when --name is the last token (no value)", () => {
  assert.equal(containerNameFromArgs(["run", "--name"]), undefined);
});

test("killContainer: runs `docker kill <name>` for the container", () => {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const fakeExecFile = ((cmd: string, args: string[], _cb: () => void) => {
    calls.push({ cmd, args });
  }) as unknown as typeof import("node:child_process").execFile;

  killContainer("forge-task-abc", fakeExecFile);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.cmd, "docker");
  assert.deepEqual(calls[0]!.args, ["kill", "forge-task-abc"]);
});

test("killContainer: no-op when the container name is undefined", () => {
  let called = false;
  const fakeExecFile = (() => {
    called = true;
  }) as unknown as typeof import("node:child_process").execFile;

  killContainer(undefined, fakeExecFile);

  assert.equal(called, false);
});
