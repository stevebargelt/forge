// FG-755 integration coverage: an on-disk Forge store seeded through its public
// write APIs, then the built `forge ci-wait reap` CLI and its real reaper logic.
//
// The fake `gh` is deliberately only the remote boundary. The store, subprocess
// command parsing, default probe dispatch, live-surface query, and terminal write
// all run exactly as production does against the test process's disposable DB.

import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { NODE_EXEC as node, BUILT_CLI_ENTRY as entry } from "../integration-cli-spawn.js";
import { getDb } from "../store/db.js";
import { CI_WAIT_LIVE_WHERE, advanceCiWait, getCiWait, observeCiWait, readCiWaits, registerCiWait, type CiWaitKind } from "../store/ci-waits.js";
import { PUSH_ACTIONS_NO_RUNS_DURABLE_MS, reapStuckCiWaits, type CiWaitProbeOutcome } from "./ci-wait.js";

const NOW = Date.now();
const DURABLE_AGE_MS = PUSH_ACTIONS_NO_RUNS_DURABLE_MS + 60_000;
const TRANSIENT_AGE_MS = PUSH_ACTIONS_NO_RUNS_DURABLE_MS - 60_000;
const tempBins: string[] = [];

afterEach(() => {
  for (const bin of tempBins.splice(0)) rmSync(bin, { recursive: true, force: true });
});

function seedWait(
  id: string,
  {
    kind = "push_actions" as CiWaitKind,
    ageMs = DURABLE_AGE_MS,
    leaseExpiresAtMs = NOW - 60_000,
    observed = "no_runs" as "no_runs" | "completed",
  }: {
    kind?: CiWaitKind;
    ageMs?: number;
    leaseExpiresAtMs?: number;
    observed?: "no_runs" | "completed";
  } = {},
): void {
  const startedAt = new Date(NOW - ageMs).toISOString();
  assert.equal(registerCiWait({
    id,
    kind,
    remote: { repo: "acme/forge", headSha: `sha-${id}` },
    startedAt,
    owner: `dead-owner-${id}`,
  }), true);
  assert.equal(observeCiWait(id, observed === "no_runs" ? { state: "no_runs" } : { state: "completed" }, startedAt), true);
  getDb().prepare("UPDATE ci_waits SET lease_expires_at_ms = ? WHERE id = ?").run(leaseExpiresAtMs, id);
}

/** A process-level `gh` replacement so the CLI's DEFAULT probe really observes no runs. */
function forge(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const bin = mkdtempSync(join(tmpdir(), "fg755-gh-"));
  tempBins.push(bin);
  const gh = join(bin, "gh");
  writeFileSync(gh, "#!/bin/sh\nprintf '[]\\n'\n");
  chmodSync(gh, 0o755);
  const result = spawnSync(node, [entry, ...args], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("FG-755 CLI reaps a durable dead-owner push wait, preserving its row and removing it from the live surface", () => {
  const id = "fg755-positive";
  seedWait(id);

  const result = forge(["ci-wait", "reap", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout) as { dryRun: boolean; count: number; reaped: Array<Record<string, unknown>> };
  assert.equal(out.dryRun, false);
  assert.equal(out.count, 1);
  assert.deepEqual(Object.keys(out.reaped[0]!).sort(), ["ageMs", "headSha", "id", "kind", "observedState", "owner", "reason"]);
  assert.equal(out.reaped[0]!.id, id);
  assert.equal(out.reaped[0]!.kind, "push_actions");
  assert.equal(out.reaped[0]!.headSha, `sha-${id}`);
  assert.equal(out.reaped[0]!.observedState, "no_runs");

  const row = getCiWait(id);
  assert.ok(row, "the terminalized row is durable and queryable; it is never deleted");
  assert.equal(row.lifecycleState, "abandoned");
  assert.equal(row.terminalDisposition, "abandoned");
  assert.match(row.observedReason ?? "", /no matching CI run found within 30m.*waiter dead/);
  assert.ok(!readCiWaits({ liveOnly: true }).some((wait) => wait.id === id));
  const liveRow = getDb()
    .prepare(`SELECT COUNT(*) AS count FROM ci_waits WHERE ${CI_WAIT_LIVE_WHERE} AND id = ?`)
    .get(id) as { count: number };
  assert.equal(liveRow.count, 0);
});

test("FG-755 requires both reaping gates and leaves other kinds plus completed-awaiting-advance unchanged", () => {
  seedWait("fg755-transient", { ageMs: TRANSIENT_AGE_MS });
  seedWait("fg755-live-lease", { leaseExpiresAtMs: NOW + 60_000 });
  seedWait("fg755-fresh-run");
  seedWait("fg755-pr", { kind: "pr_checks" });
  seedWait("fg755-dispatch", { kind: "workflow_dispatch" });
  seedWait("fg755-completed", { observed: "completed" });

  const ids = ["fg755-transient", "fg755-live-lease", "fg755-fresh-run", "fg755-pr", "fg755-dispatch", "fg755-completed"];
  const before = new Map(ids.map((id) => [id, getCiWait(id)!]));
  const freshRunProbe = (wait: { id: string }): CiWaitProbeOutcome =>
    wait.id === "fg755-fresh-run"
      ? { observation: { state: "running", m: 0, n: 1 } }
      : { observation: { state: "no_runs" } };

  const outcome = reapStuckCiWaits({ dryRun: false }, freshRunProbe, () => NOW);
  assert.deepEqual(outcome.reaped, []);
  for (const id of ids) {
    const after = getCiWait(id)!;
    assert.deepEqual(after, before.get(id), `${id} must remain byte-for-byte unchanged when its gate/scope excludes it`);
    assert.ok(readCiWaits({ liveOnly: true }).some((wait) => wait.id === id), `${id} remains live`);
  }
  assert.equal(getCiWait("fg755-completed")!.lifecycleState, "completed_awaiting_advance");
  // Keep this deliberate fail-safe fixture from becoming an unrelated CLI candidate in
  // the next test; the assertion above has already proven it was not reaped.
  assert.equal(advanceCiWait("fg755-fresh-run", "cancelled"), true);
});

test("FG-755 CLI dry-run lists every immortal candidate without mutation, then real and human surfaces report the terminalization", () => {
  const ids = Array.from({ length: 10 }, (_, index) => `fg755-immortal-${index}`);
  for (const id of ids) seedWait(id);
  const before = new Map(ids.map((id) => [id, getCiWait(id)!]));

  const dryJson = forge(["ci-wait", "reap", "--dry-run", "--json"]);
  assert.equal(dryJson.status, 0, dryJson.stderr);
  const dry = JSON.parse(dryJson.stdout) as { dryRun: boolean; count: number; reaped: Array<{ id: string; kind: string; headSha: string; owner: string; observedState: string; ageMs: number }> };
  assert.equal(dry.dryRun, true);
  assert.equal(dry.count, ids.length);
  assert.deepEqual(dry.reaped.map((candidate) => candidate.id).sort(), [...ids].sort());
  for (const candidate of dry.reaped) {
    assert.equal(candidate.kind, "push_actions");
    assert.equal(candidate.headSha, `sha-${candidate.id}`);
    assert.match(candidate.owner, /^dead-owner-/);
    assert.equal(candidate.observedState, "no_runs");
    assert.ok(candidate.ageMs >= PUSH_ACTIONS_NO_RUNS_DURABLE_MS);
  }
  for (const id of ids) assert.deepEqual(getCiWait(id), before.get(id), `dry-run must not mutate ${id}`);

  const dryHuman = forge(["ci-wait", "reap", "--dry-run"]);
  assert.equal(dryHuman.status, 0, dryHuman.stderr);
  assert.match(dryHuman.stdout, /WOULD reap 10 wait\(s\)/);
  for (const id of ids) assert.match(dryHuman.stdout, new RegExp(`${id} kind=push_actions head_sha=sha-${id} owner=dead-owner-${id} observed=no_runs age=`));

  const realJson = forge(["ci-wait", "reap", "--json"]);
  assert.equal(realJson.status, 0, realJson.stderr);
  const real = JSON.parse(realJson.stdout) as { dryRun: boolean; count: number; reaped: Array<{ id: string }> };
  assert.equal(real.dryRun, false);
  assert.equal(real.count, ids.length);
  assert.deepEqual(real.reaped.map((candidate) => candidate.id).sort(), [...ids].sort());
  assert.equal(readCiWaits({ liveOnly: true }).filter((wait) => ids.includes(wait.id)).length, 0);
  for (const id of ids) {
    const row = getCiWait(id);
    assert.ok(row, "reap preserves every row");
    assert.equal(row.terminalDisposition, "abandoned");
  }

  // A no-candidate human run proves the non-JSON command path remains readable after
  // terminalization rather than emitting an empty or machine-only response.
  const human = forge(["ci-wait", "reap"]);
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /no stuck push_actions waits to reap/);
});
