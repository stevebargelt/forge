// FG-677 (e) — FG-632 absorbed: host readiness-record prune. A record is pruned ONLY when
// its bound workspace was positively retired in the SAME pass AND no live reader remains;
// otherwise retained with a named reason. Idempotent (2nd-pass fixpoint), dry-run visible.
// hostReadinessDir() resolves into the per-process FORGE_HOME temp home (test-setup.ts).

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { hostReadinessDir } from "../util/paths.js";
import { writeReadinessRecord, pruneReadinessRecords, readinessRecordPath, type HostReadinessRecord } from "./host-readiness-store.js";

function record(workspace: string): HostReadinessRecord {
  return {
    workspace,
    treeSha: "deadbeef",
    lockfileDigest: "sha256:abc",
    nodeVersion: "24.0.0",
    abi: "137",
    state: "ready",
    setupCommand: "npm ci",
    coveredCommandSet: ["test"],
    assertedAt: new Date().toISOString(),
  };
}

beforeEach(() => {
  mkdirSync(hostReadinessDir(), { recursive: true });
});
afterEach(() => {
  try { rmSync(hostReadinessDir(), { recursive: true, force: true }); } catch { /* best-effort */ }
});

test("FG-677 readiness: a record whose workspace was retired this pass (no live reader) is PRUNED", () => {
  const ws = "/w/publications/attempt-a-r0";
  writeReadinessRecord(record(ws));
  assert.ok(existsSync(readinessRecordPath(ws)));

  const { readinessRecords } = pruneReadinessRecords({ workspaceRetired: (w) => w === ws });

  assert.ok(!existsSync(readinessRecordPath(ws)), "the record file is removed");
  assert.equal(readinessRecords.filter((r) => r.action === "removed").length, 1);
});

test("FG-677 readiness: a record whose workspace was NOT retired is RETAINED (never pruned on path-absence alone)", () => {
  const ws = "/w/publications/attempt-live-r0";
  writeReadinessRecord(record(ws));

  const { readinessRecords } = pruneReadinessRecords({ workspaceRetired: () => false });

  assert.ok(existsSync(readinessRecordPath(ws)), "an un-retired workspace's record is kept");
  assert.equal(readinessRecords.find((r) => r.path === readinessRecordPath(ws))!.reason, "ownership_ambiguous");
});

test("FG-677 readiness: a retired workspace with a LIVE READER fails closed — RETAINED readiness_live_reader", () => {
  const ws = "/w/publications/attempt-reader-r0";
  writeReadinessRecord(record(ws));

  const { readinessRecords } = pruneReadinessRecords({ workspaceRetired: () => true, hasLiveReader: () => true });

  assert.ok(existsSync(readinessRecordPath(ws)), "a live reader retains the record");
  assert.equal(readinessRecords.find((r) => r.path === readinessRecordPath(ws))!.reason, "readiness_live_reader");
});

test("FG-677 readiness: DRY-RUN performs no mutation and proposes the prune", () => {
  const ws = "/w/publications/attempt-dry-r0";
  writeReadinessRecord(record(ws));

  const dry = pruneReadinessRecords({ dryRun: true, workspaceRetired: () => true });
  assert.ok(existsSync(readinessRecordPath(ws)), "dry-run removes nothing");
  assert.equal(dry.readinessRecords.find((r) => r.path === readinessRecordPath(ws))!.action, "removed");
  assert.equal(dry.readinessRecords.find((r) => r.path === readinessRecordPath(ws))!.dryRun, true);

  const real = pruneReadinessRecords({ workspaceRetired: () => true });
  assert.ok(!existsSync(readinessRecordPath(ws)), "the real pass prunes what the dry run proposed");
});

test("FG-677 readiness: idempotent — a second pass after prune is a no-op fixpoint", () => {
  const ws = "/w/publications/attempt-idem-r0";
  writeReadinessRecord(record(ws));
  pruneReadinessRecords({ workspaceRetired: () => true });
  const second = pruneReadinessRecords({ workspaceRetired: () => true });
  assert.equal(second.readinessRecords.length, 0, "the pruned record is gone; second pass finds nothing");
});

test("FG-677 readiness: an unparseable record file is RETAINED as ownership_ambiguous, never deleted", () => {
  const file = readinessRecordPath("/w/whatever");
  writeFileSync(file, "{ not valid json");
  const { readinessRecords } = pruneReadinessRecords({ workspaceRetired: () => true });
  assert.ok(existsSync(file), "an unattributable record is never deleted");
  assert.equal(readinessRecords.find((r) => r.path === file)!.reason, "ownership_ambiguous");
});
