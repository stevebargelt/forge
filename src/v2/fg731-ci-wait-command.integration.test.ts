// FG-731 (Step 2a): the `forge ci-wait` command surface, end to end through the real
// CLI (Commander parsing + --json rendering) writing the durable ci_waits row that
// Step 1's store owns. The gh-poll loop itself is proven in ci-wait.test.ts with a
// stubbed gh; this file proves the WIRING — the command exists, parses, registers
// before any poll, adopts a live twin, and cancels off the live surface.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { NODE_EXEC as node, BUILT_CLI_ENTRY as entry } from "../integration-cli-spawn.js";
import { getCiWait, readCiWaits } from "../store/ci-waits.js";

function forge(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(node, [entry, ...args], { encoding: "utf8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

test("forge ci-wait register writes a durable record BEFORE any poll, and reports its id", () => {
  const res = forge(["ci-wait", "register", "--kind", "pr_checks", "--repo", "acme/forge", "--pr", "7", "--json"]);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout) as { id: string; adopted: boolean; kind: string };
  assert.equal(out.adopted, false);
  assert.equal(out.kind, "pr_checks");
  const row = getCiWait(out.id);
  assert.ok(row, "the record must exist immediately after register, before any gh call");
  assert.equal(row.lifecycleState, "registered");
  assert.equal(row.observedState, null, "a register-before-poll row has observed nothing yet");
  assert.equal(row.prNumber, 7);
});

test("a second register for the same live remote identity ADOPTS — no duplicate", () => {
  const first = JSON.parse(forge(["ci-wait", "register", "--kind", "workflow_dispatch", "--repo", "acme/forge", "--workflow", "timings.yml", "--ref", "main", "--json"]).stdout) as { id: string };
  const second = JSON.parse(forge(["ci-wait", "register", "--kind", "workflow_dispatch", "--repo", "acme/forge", "--workflow", "timings.yml", "--ref", "main", "--json"]).stdout) as { id: string; adopted: boolean };
  assert.equal(second.adopted, true);
  assert.equal(second.id, first.id);
  const live = readCiWaits({ liveOnly: true }).filter((w) => w.workflowFile === "timings.yml");
  assert.equal(live.length, 1);
});

test("forge ci-wait cancel takes a registered wait off the live surface deterministically", () => {
  const id = (JSON.parse(forge(["ci-wait", "register", "--kind", "push_actions", "--repo", "acme/forge", "--sha", "deadbeef", "--json"]).stdout) as { id: string }).id;
  const res = forge(["ci-wait", "cancel", id, "--json"]);
  assert.equal(res.status, 0, res.stderr);
  assert.equal((JSON.parse(res.stdout) as { cancelled: boolean }).cancelled, true);
  const row = getCiWait(id);
  assert.equal(row?.terminal, true);
  assert.equal(row?.terminalDisposition, "cancelled");
  assert.ok(!readCiWaits({ liveOnly: true }).some((w) => w.id === id), "a cancelled wait must leave the live surface");
});

test("a missing --pr for pr_checks is a clean refusal, not a registered half-wait", () => {
  const before = readCiWaits().length;
  const res = forge(["ci-wait", "register", "--kind", "pr_checks", "--repo", "acme/forge", "--json"]);
  assert.equal(res.status, 2);
  assert.match(JSON.parse(res.stdout).error, /pr_checks requires --pr/);
  assert.equal(readCiWaits().length, before, "a refused request registers nothing");
});
