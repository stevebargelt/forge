// FG-731 (Step 2a): the `forge ci-wait` command surface, end to end through the real
// CLI (Commander parsing + --json rendering) writing the durable ci_waits row that
// Step 1's store owns. The gh-poll loop itself is proven in ci-wait.test.ts with a
// stubbed gh; this file proves the WIRING — the command exists, parses, registers
// before any poll, adopts a live twin, and cancels off the live surface.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { NODE_EXEC as node, BUILT_CLI_ENTRY as entry } from "../integration-cli-spawn.js";
import { getCiWait, observeCiWait, readCiWaits } from "../store/ci-waits.js";
import { nowIso } from "../util/ids.js";

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

// RF-1: `completed_awaiting_advance` is a NON-terminal state — a forge advance is owed —
// and NO other production path clears it, so without an advance surface a completed wait
// stays on the live surface forever (the forever-live row this ticket's contract forbids).
// `forge ci-wait advance <id>` is that production surface: it drives
// completed_awaiting_advance -> advanced and takes the wait off the live surface.
test("forge ci-wait advance takes a completed_awaiting_advance wait off the live surface", () => {
  const id = (JSON.parse(forge(["ci-wait", "register", "--kind", "pr_checks", "--repo", "acme/forge", "--pr", "11", "--json"]).stdout) as { id: string }).id;
  // Drive it to completed_awaiting_advance the way a terminal gh observation would (the
  // gh-poll loop is proven in ci-wait.test.ts). This is the state an advance clears.
  observeCiWait(id, { state: "completed" }, nowIso());
  assert.equal(getCiWait(id)?.lifecycleState, "completed_awaiting_advance");
  assert.ok(readCiWaits({ liveOnly: true }).some((w) => w.id === id), "a completed_awaiting_advance wait is still LIVE — an advance is owed");

  const res = forge(["ci-wait", "advance", id, "--json"]);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout) as { advanced: boolean; state: string };
  assert.equal(out.advanced, true);
  assert.equal(out.state, "advanced");
  const row = getCiWait(id);
  assert.equal(row?.terminal, true);
  assert.equal(row?.terminalDisposition, "advanced");
  assert.ok(!readCiWaits({ liveOnly: true }).some((w) => w.id === id), "an advanced wait must leave the live surface");
});

test("forge ci-wait advance on a wait NOT awaiting advance is a no-op refusal, not a false terminal", () => {
  const id = (JSON.parse(forge(["ci-wait", "register", "--kind", "pr_checks", "--repo", "acme/forge", "--pr", "12", "--json"]).stdout) as { id: string }).id;
  // Still `registered` (never observed completed): advance requires completed_awaiting_advance.
  const res = forge(["ci-wait", "advance", id, "--json"]);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout) as { advanced: boolean; state: string };
  assert.equal(out.advanced, false, "advance must not terminalize a wait that never completed");
  assert.equal(out.state, "registered");
  assert.equal(getCiWait(id)?.terminal, false);
  assert.ok(readCiWaits({ liveOnly: true }).some((w) => w.id === id), "the still-running wait stays live");
});

test("forge ci-wait advance on an unknown id is a clean refusal", () => {
  const res = forge(["ci-wait", "advance", "ci-wait-does-not-exist", "--json"]);
  assert.equal(res.status, 2);
  assert.match(JSON.parse(res.stdout).error, /no such ci-wait/);
});

// FG-755: the reap command exists, parses --dry-run/--json, and emits the well-formed
// outcome shape. The reap PREDICATE + terminalization are proven in fg755-ci-wait-reap.ts
// with a stubbed probe (the real command re-probes gh, which agent containers lack); this
// proves the WIRING and that a dry-run mutates nothing.
test("forge ci-wait reap --dry-run --json emits a well-formed outcome and mutates nothing", () => {
  const before = readCiWaits().length;
  const res = forge(["ci-wait", "reap", "--dry-run", "--json"]);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout) as { dryRun: boolean; count: number; reaped: unknown[] };
  assert.equal(out.dryRun, true);
  assert.equal(typeof out.count, "number");
  assert.ok(Array.isArray(out.reaped));
  assert.equal(readCiWaits().length, before, "a dry-run reap mutates nothing");
});

test("a missing --pr for pr_checks is a clean refusal, not a registered half-wait", () => {
  const before = readCiWaits().length;
  const res = forge(["ci-wait", "register", "--kind", "pr_checks", "--repo", "acme/forge", "--json"]);
  assert.equal(res.status, 2);
  assert.match(JSON.parse(res.stdout).error, /pr_checks requires --pr/);
  assert.equal(readCiWaits().length, before, "a refused request registers nothing");
});

// RF-2: a non-numeric/negative --timeout or --interval must be rejected at parse time,
// BEFORE arming or entering the poll loop — otherwise a NaN/negative delay coerces to a
// ~1ms timer with a never-satisfied deadline, an unbounded near-tight gh hammer. These
// exit fast (validation precedes the blocking loop) and register nothing.
for (const [flag, value, pattern] of [
  ["--timeout", "abc", /--timeout must be a number/],
  ["--timeout", "-1", /--timeout must be a non-negative number/],
  ["--interval", "0", /--interval must be a positive number/],
  ["--interval", "-5", /--interval must be a positive number/],
  ["--interval", "nope", /--interval must be a number/],
] as const) {
  test(`forge ci-wait wait rejects ${flag} ${value} at parse time`, () => {
    const before = readCiWaits().length;
    const res = forge(["ci-wait", "wait", "--kind", "pr_checks", "--repo", "acme/forge", "--pr", "7", flag, value, "--json"]);
    assert.equal(res.status, 2, res.stderr || res.stdout);
    assert.match(JSON.parse(res.stdout).error, pattern);
    assert.equal(readCiWaits().length, before, "a refused wait registers nothing");
  });
}

test("forge ci-wait wait ACCEPTS --timeout 0 as the no-timeout sentinel", () => {
  // 0 is valid for --timeout only; we can't let the loop block, so pair it with a bad
  // --interval so validation still fails fast — but on the INTERVAL, proving 0 timeout
  // itself passed validation.
  const res = forge(["ci-wait", "wait", "--kind", "pr_checks", "--repo", "acme/forge", "--pr", "7", "--timeout", "0", "--interval", "bad", "--json"]);
  assert.equal(res.status, 2);
  assert.match(JSON.parse(res.stdout).error, /--interval must be a number/);
});
