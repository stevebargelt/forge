// FG-530 scope guard: the crash-injection hook must be INERT in production.
//
// Two halves, both required by the ticket's "zero production-code behavior
// changes" AC:
//   (a) content guard — no production file installs a hook. crash-points.ts
//       defines the seam; only *.test.ts files may call setCrashHookForTest.
//   (b) runtime inertness — with no hook installed, crashPoint() is a no-op
//       for every probe name the runner carries, and uninstalling restores it.
//
// The FLOW-level half of (b) — that an installed but non-throwing hook does not
// change what the real runner writes — lives in fg530-crash-matrix.integration
// .test.ts, which can drive runNext against a fake docker layer.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { crashPoint, setCrashHookForTest } from "./crash-points.js";

const SRC_ROOT = fileURLToPath(new URL("..", import.meta.url));
const HOOK_MODULE = "v2/crash-points.ts";
/** The shared crash driver, imported by BOTH FG-530 lanes (the integration-tier
 *  matrix and the worktree-tier lane). It is test support that happens to carry no
 *  `.test.ts` suffix — it registers no tests — so it must be named here rather than
 *  read as production. The exemption is kept honest in fg530-probe-inertness.test.ts:
 *  a test there fails if any NON-TEST file imports it, which is the only way this
 *  carve-out could hand production a path to the setter. */
const HARNESS = "v2/fg530-harness.ts";

function gatherSourceFiles(dir: string, root: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...gatherSourceFiles(full, root));
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      const rel = relative(root, full);
      if (rel === HARNESS) continue;
      results.push(rel);
    }
  }
  return results;
}

test("FG-530 (a) content guard: no PRODUCTION file installs a crash hook — only crash-points.ts defines the seam", () => {
  const offenders: string[] = [];
  for (const rel of gatherSourceFiles(SRC_ROOT, SRC_ROOT)) {
    if (rel === HOOK_MODULE) continue;
    const content = readFileSync(join(SRC_ROOT, rel), "utf8");
    if (content.includes("setCrashHookForTest")) {
      offenders.push(rel);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `Production files must never install a crash hook (that would make the injection live outside tests):\n${offenders.join("\n")}`,
  );
});

test("FG-530 (a) content guard: the hook module reads no env and does no I/O — an unset hook must cost one field read, not a config lookup", () => {
  const source = readFileSync(join(SRC_ROOT, HOOK_MODULE), "utf8");
  for (const forbidden of ["process.env", "readFileSync", "require(", "import("]) {
    assert.ok(
      !source.includes(forbidden),
      `crash-points.ts must not contain '${forbidden}' — crashPoint() is on the runner's hot write path and must stay a no-op field read when unset`,
    );
  }
});

// Every probe name the production runner carries. Kept in lockstep with the
// registry the matrix iterates (fg530-crash-matrix.integration.test.ts asserts
// each of these actually fires); listed here so inertness is proven for the
// real names, not a synthetic one.
const PROBE_NAMES = [
  "runContainer:after-mark-running-before-container-launch",
  "runContainer:after-container-started-before-exec",
  "dispatchSingleStep:after-result-ingest",
  "dispatchSingleStep:before-validation-contract",
  "holdIfValidationContractFails:between-hold-status-and-event",
  "dispatchSingleStep:before-awaiting-red",
  "dispatchSingleStep:between-awaiting-red-status-and-event",
  "dispatchSingleStep:after-awaiting-red",
  "dispatchReds:before-verdict-insert",
  "dispatchReds:inside-verdict-insert-txn",
  "dispatchReds:after-verdict-insert",
  "dispatchSingleStep:before-blocked-by-red",
  "dispatchSingleStep:inside-blocked-by-red-txn",
  "dispatchSingleStep:after-blocked-by-red",
  "dispatchFanoutStep:before-awaiting-red",
  "dispatchFanoutStep:between-awaiting-red-status-and-event",
  "dispatchFanoutStep:after-awaiting-red",
  "dispatchFanoutStep:before-blocked-by-red",
  "dispatchFanoutStep:inside-blocked-by-red-txn",
  "dispatchFanoutStep:after-blocked-by-red",
  "finalizePrimary:before-status-write",
  "finalizePrimary:between-complete-status-and-event",
  "finalizePrimary:between-awaiting-gate-status-and-event",
  "gate:before-decision-write",
  "gate:inside-decision-write-txn",
  "gate:after-decision-write",
  "gate:advance:between-complete-status-and-event",
  "gate:advance:after-complete-write",
  "gate:advance:fanout-reentry:before-reentry-write",
  "gate:advance:fanout-reentry:inside-reentry-write-txn",
  "gate:advance:fanout-reentry:after-reentry-write",
  "gate:reject:before-fail-write",
  "gate:reject:inside-txn-between-fail-and-recovery-mint",
  "gate:reject:inside-txn-between-recovery-mint-and-event",
  "gate:reject:after-recovery-mint",
  "gate:reject:dedup:inside-txn-between-inputs-and-lineage",
  "gate:reject:dedup:inside-txn-between-lineage-and-event",
  "gate:request-changes:before-fail-write",
  "gate:request-changes:between-fail-and-replacement-mint",
  "gate:request-changes:between-replacement-mint-and-event",
  "gate:request-changes:dedup:between-inputs-and-event",
  "gate:after-branch",
  "reconcile:before-fail-pipeline-unfinalized",
  "reconcile:inside-fail-pipeline-unfinalized-txn",
  "reconcile:before-fail-oom-killed",
  "reconcile:inside-fail-oom-killed-txn",
  "reconcile:before-fail-orphaned-work-may-persist",
  "reconcile:inside-fail-orphaned-work-may-persist-txn",
  "reconcile:before-fail-orphaned-no-result",
  "reconcile:inside-fail-orphaned-no-result-txn",
  "reconcile:before-complete-invoke-like",
  "reconcile:inside-complete-invoke-like-txn",
  "reconcile:before-complete-invoke-like-from-stdout",
  "reconcile:inside-complete-invoke-like-from-stdout-txn",
  "reconcile:before-backfill-complete-empty-result",
  "reconcile:inside-backfill-complete-empty-result-txn",
  "reconcile:before-fail-fanout-parent-unfinalized",
  "reconcile:inside-fail-fanout-parent-unfinalized-txn",
  "reconcile:before-fail-fanout-wave-orphaned",
  "reconcile:inside-fail-fanout-wave-orphaned-txn",
  "reconcile:before-fail-provisioning-phase-crash",
  "reconcile:inside-fail-provisioning-phase-crash-txn",
  "reconcile:before-fail-pre-container-crash",
  "reconcile:inside-fail-pre-container-crash-txn",
  "reconcile:before-fail-dead-red-child",
  "reconcile:inside-fail-dead-red-child-txn",
  "reconcile:before-fail-awaiting-red-orphaned",
  "reconcile:inside-fail-awaiting-red-orphaned-txn",
  "reconcile:before-fail-awaiting-red-fanout-parent",
  "reconcile:inside-fail-awaiting-red-fanout-parent-txn",
];

test("FG-530 (b) runtime inertness: with NO hook installed, every probe name is a silent no-op", () => {
  setCrashHookForTest(undefined);
  for (const name of PROBE_NAMES) {
    assert.equal(crashPoint(name), undefined, `crashPoint(${name}) must return undefined and not throw when unset`);
  }
});

test("FG-530 (b) runtime inertness: uninstalling a hook restores the no-op — a test that armed the seam cannot leak into the next one", () => {
  const seen: string[] = [];
  setCrashHookForTest((p) => {
    seen.push(p);
    throw new Error("armed");
  });
  assert.throws(() => crashPoint("dispatchSingleStep:after-result-ingest"), /armed/, "an installed hook fires");
  assert.deepEqual(seen, ["dispatchSingleStep:after-result-ingest"], "and receives the probe name verbatim");

  setCrashHookForTest(undefined);
  for (const name of PROBE_NAMES) crashPoint(name);
  assert.deepEqual(seen, ["dispatchSingleStep:after-result-ingest"], "an uninstalled hook observes nothing further");
});
