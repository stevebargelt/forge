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

function gatherSourceFiles(dir: string, root: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...gatherSourceFiles(full, root));
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      results.push(relative(root, full));
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
  "gate:request-changes:before-fail-write",
  "gate:request-changes:between-fail-and-replacement-mint",
  "gate:request-changes:between-replacement-mint-and-event",
  "gate:after-branch",
  "reconcile:before-fail-pipeline-unfinalized",
  "reconcile:inside-fail-pipeline-unfinalized-txn",
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
