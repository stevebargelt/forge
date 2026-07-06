import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "./db.js";
import { insertHostVerification, queryHostVerificationRows, queryHostVerificationRowsForGate } from "./host-verifications.js";
import { insertRun } from "./runs.js";
import type { Run } from "../types/index.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
});

const SAMPLE_RUN: Run = {
  id: "run-hv-test",
  workflow: "feature",
  title: "Host Verification Test Run",
  status: "complete",
  createdAt: "2026-01-01T00:00:00Z",
};

// ── insertHostVerification / queryHostVerificationRows ────────────────────────

test("insertHostVerification: stores a row and queryHostVerificationRows retrieves it (without runId)", () => {
  insertHostVerification({
    ticketId: "FG-001",
    projectDir: "/home/test/project",
    commitSha: "abc123",
    gateName: "npm run test:all",
    command: "npm run test:all",
    exitCode: 0,
    recordedAt: "2026-01-01T00:00:00Z",
  });

  const rows = queryHostVerificationRows("FG-001", "/home/test/project", "abc123", "npm run test:all");
  assert.equal(rows.length, 1);
  const row = rows[0]!;
  assert.equal(row.ticketId, "FG-001");
  assert.equal(row.projectDir, "/home/test/project");
  assert.equal(row.commitSha, "abc123");
  assert.equal(row.gateName, "npm run test:all");
  assert.equal(row.command, "npm run test:all");
  assert.equal(row.exitCode, 0);
  assert.equal(row.runId, null);
  assert.equal(row.recordedAt, "2026-01-01T00:00:00Z");
  assert.ok(typeof row.id === "number", "id must be a number");
});

test("insertHostVerification: runId stored correctly when referencing an existing run", () => {
  insertRun(SAMPLE_RUN);
  insertHostVerification({
    ticketId: "FG-001-B",
    projectDir: "/home/test/project",
    commitSha: "abc123",
    gateName: "npm run test:all",
    command: "npm run test:all",
    exitCode: 0,
    runId: SAMPLE_RUN.id,
    recordedAt: "2026-01-01T00:00:00Z",
  });

  const rows = queryHostVerificationRows("FG-001-B", "/home/test/project", "abc123", "npm run test:all");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.runId, SAMPLE_RUN.id);
});

test("insertHostVerification: runId defaults to null when not provided", () => {
  insertHostVerification({
    ticketId: "FG-002",
    projectDir: "/home/test/project",
    commitSha: "abc123",
    gateName: "npm run test:all",
    command: "npm run test:all",
    exitCode: 1,
    recordedAt: "2026-01-01T00:00:00Z",
  });

  const rows = queryHostVerificationRows("FG-002", "/home/test/project", "abc123", "npm run test:all");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.runId, null);
});

// ── composite key matching ────────────────────────────────────────────────────

test("queryHostVerificationRows: empty when ticket_id does not match", () => {
  insertHostVerification({
    ticketId: "FG-003",
    projectDir: "/home/test/project",
    commitSha: "abc123",
    gateName: "npm run test:all",
    command: "npm run test:all",
    exitCode: 0,
    recordedAt: "2026-01-01T00:00:00Z",
  });

  const rows = queryHostVerificationRows("FG-WRONG", "/home/test/project", "abc123", "npm run test:all");
  assert.equal(rows.length, 0, "must return empty when ticket_id does not match");
});

test("queryHostVerificationRows: empty when project_dir does not match", () => {
  insertHostVerification({
    ticketId: "FG-004",
    projectDir: "/home/test/project",
    commitSha: "abc123",
    gateName: "npm run test:all",
    command: "npm run test:all",
    exitCode: 0,
    recordedAt: "2026-01-01T00:00:00Z",
  });

  const rows = queryHostVerificationRows("FG-004", "/different/dir", "abc123", "npm run test:all");
  assert.equal(rows.length, 0, "must return empty when project_dir does not match");
});

test("queryHostVerificationRows: empty when commit_sha does not match", () => {
  insertHostVerification({
    ticketId: "FG-005",
    projectDir: "/home/test/project",
    commitSha: "abc123",
    gateName: "npm run test:all",
    command: "npm run test:all",
    exitCode: 0,
    recordedAt: "2026-01-01T00:00:00Z",
  });

  const rows = queryHostVerificationRows("FG-005", "/home/test/project", "different-sha", "npm run test:all");
  assert.equal(rows.length, 0, "must return empty when commit_sha does not match");
});

test("queryHostVerificationRows: empty when gate_name does not match", () => {
  insertHostVerification({
    ticketId: "FG-006",
    projectDir: "/home/test/project",
    commitSha: "abc123",
    gateName: "npm run test:all",
    command: "npm run test:all",
    exitCode: 0,
    recordedAt: "2026-01-01T00:00:00Z",
  });

  const rows = queryHostVerificationRows("FG-006", "/home/test/project", "abc123", "make test");
  assert.equal(rows.length, 0, "must return empty when gate_name does not match");
});

// ── ordering and multiple rows ────────────────────────────────────────────────

test("queryHostVerificationRows: returns multiple rows in recorded_at ASC order", () => {
  insertHostVerification({
    ticketId: "FG-007",
    projectDir: "/home/test/project",
    commitSha: "abc123",
    gateName: "npm run test:all",
    command: "npm run test:all",
    exitCode: 1,
    recordedAt: "2026-01-01T01:00:00Z",
  });
  insertHostVerification({
    ticketId: "FG-007",
    projectDir: "/home/test/project",
    commitSha: "abc123",
    gateName: "npm run test:all",
    command: "npm run test:all",
    exitCode: 0,
    recordedAt: "2026-01-01T02:00:00Z",
  });

  const rows = queryHostVerificationRows("FG-007", "/home/test/project", "abc123", "npm run test:all");
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.recordedAt, "2026-01-01T01:00:00Z", "first row must be the earlier one (ASC order)");
  assert.equal(rows[0]!.exitCode, 1);
  assert.equal(rows[1]!.recordedAt, "2026-01-01T02:00:00Z");
  assert.equal(rows[1]!.exitCode, 0);
});

test("queryHostVerificationRows: rows for different keys are independent — each key only returns its own rows", () => {
  insertHostVerification({
    ticketId: "FG-008",
    projectDir: "/home/test/project",
    commitSha: "sha-a",
    gateName: "npm run test:all",
    command: "npm run test:all",
    exitCode: 0,
    recordedAt: "2026-01-01T00:00:00Z",
  });
  insertHostVerification({
    ticketId: "FG-009",
    projectDir: "/home/test/project",
    commitSha: "sha-b",
    gateName: "npm run test:all",
    command: "npm run test:all",
    exitCode: 1,
    recordedAt: "2026-01-01T01:00:00Z",
  });

  const rowsA = queryHostVerificationRows("FG-008", "/home/test/project", "sha-a", "npm run test:all");
  const rowsB = queryHostVerificationRows("FG-009", "/home/test/project", "sha-b", "npm run test:all");

  assert.equal(rowsA.length, 1);
  assert.equal(rowsA[0]!.ticketId, "FG-008");
  assert.equal(rowsB.length, 1);
  assert.equal(rowsB[0]!.ticketId, "FG-009");
});

test("queryHostVerificationRows: non-zero exit code persisted and retrieved correctly", () => {
  insertHostVerification({
    ticketId: "FG-010",
    projectDir: "/home/test/project",
    commitSha: "abc123",
    gateName: "npm run test:all",
    command: "npm run test:all",
    exitCode: 2,
    recordedAt: "2026-01-01T00:00:00Z",
  });

  const rows = queryHostVerificationRows("FG-010", "/home/test/project", "abc123", "npm run test:all");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.exitCode, 2);
});

// ── FG-440: narrowed insertHostVerification retry (dangling run_id FK only) ────

test("insertHostVerification: a dangling run_id FK is retried once with run_id nulled — the real result is still recorded", () => {
  insertHostVerification({
    ticketId: "FG-011",
    projectDir: "/home/test/project",
    commitSha: "abc123",
    gateName: "npm run test:all",
    command: "npm run test:all",
    exitCode: 0,
    runId: "run-does-not-exist",
    recordedAt: "2026-01-01T00:00:00Z",
  });

  const rows = queryHostVerificationRows("FG-011", "/home/test/project", "abc123", "npm run test:all");
  assert.equal(rows.length, 1, "the real gate result must still be recorded despite the dangling run_id FK");
  assert.equal(rows[0]!.runId, null, "retried with run_id nulled");
  assert.equal(rows[0]!.exitCode, 0);
});

test("insertHostVerification: a non-FK DB error surfaces (is thrown), not silently retried or swallowed", () => {
  assert.throws(() => {
    insertHostVerification({
      // A NOT NULL column forced null via an intentional type violation —
      // a DB error that is NOT the dangling run_id FK case the retry exists for.
      ticketId: null as unknown as string,
      projectDir: "/home/test/project",
      commitSha: "abc123",
      gateName: "npm run test:all",
      command: "npm run test:all",
      exitCode: 0,
      recordedAt: "2026-01-01T00:00:00Z",
    });
  }, "a non-FK DB error must surface as a real error, not be assumed to be the dangling-run_id case and retried away");

  const rows = queryHostVerificationRowsForGate("FG-012", "/home/test/project", "npm run test:all");
  assert.equal(rows.length, 0, "the failed insert must not have silently landed a row under some other key");
});

// ── FG-440: queryHostVerificationRowsForGate (unfiltered by commit_sha) ────────

test("queryHostVerificationRowsForGate: returns rows across different commit shas for the same ticket+project+gate", () => {
  insertHostVerification({
    ticketId: "FG-013",
    projectDir: "/home/test/project",
    commitSha: "sha-early",
    gateName: "npm run test:all",
    command: "npm run test:all",
    exitCode: 0,
    recordedAt: "2026-01-01T00:00:00Z",
  });
  insertHostVerification({
    ticketId: "FG-013",
    projectDir: "/home/test/project",
    commitSha: "sha-later",
    gateName: "npm run test:all",
    command: "npm run test:all",
    exitCode: 1,
    recordedAt: "2026-01-01T01:00:00Z",
  });

  const rows = queryHostVerificationRowsForGate("FG-013", "/home/test/project", "npm run test:all");
  assert.equal(rows.length, 2, "unfiltered by commit_sha — both rows for this ticket+project+gate are returned");
  assert.deepEqual(rows.map((r) => r.commitSha).sort(), ["sha-early", "sha-later"]);
});

test("queryHostVerificationRowsForGate: excludes rows for a different gate_name", () => {
  insertHostVerification({
    ticketId: "FG-014",
    projectDir: "/home/test/project",
    commitSha: "sha-a",
    gateName: "npm run verify",
    command: "npm run verify",
    exitCode: 0,
    recordedAt: "2026-01-01T00:00:00Z",
  });

  const rows = queryHostVerificationRowsForGate("FG-014", "/home/test/project", "npm run test:all");
  assert.equal(rows.length, 0);
});

// ── FG-431: projectDir canonicalization on BOTH the insert and lookup side ────
//
// insertHostVerification (backing the public `forge record-host-verification`
// CLI command) can be handed a relative or otherwise non-canonical project
// path. Reconcile's lookup exact-matches project_dir, so a row recorded under
// an equivalent-but-differently-spelled path must still resolve — otherwise
// legitimate evidence silently becomes unmatchable and reconcile falsely
// refuses with host_verification_not_recorded.

test("FG-431: a row recorded with a non-canonical projectDir (redundant segments) is found by queryHostVerificationRows using the canonical absolute path", () => {
  const nonCanonical = "/home/test/other/../project";
  const canonical = "/home/test/project";
  // Confirm the fixture actually exercises a non-canonical path, not a no-op.
  assert.notEqual(nonCanonical, canonical);

  insertHostVerification({
    ticketId: "FG-015",
    projectDir: nonCanonical,
    commitSha: "sha-a",
    gateName: "npm run test:all",
    command: "npm run test:all",
    exitCode: 0,
    recordedAt: "2026-01-01T00:00:00Z",
  });

  const rows = queryHostVerificationRows("FG-015", canonical, "sha-a", "npm run test:all");
  assert.equal(rows.length, 1, "a non-canonical projectDir at insert must resolve to the same row the canonical lookup expects");
  assert.equal(rows[0]!.projectDir, canonical, "the stored projectDir is itself canonicalized");
});

test("FG-431: a row recorded with an equivalent non-canonical projectDir (trailing slash) is found by queryHostVerificationRowsForGate", () => {
  const nonCanonical = "/home/test/project/";
  const canonical = "/home/test/project";
  assert.notEqual(nonCanonical, canonical);

  insertHostVerification({
    ticketId: "FG-016",
    projectDir: nonCanonical,
    commitSha: "sha-b",
    gateName: "npm run test:all",
    command: "npm run test:all",
    exitCode: 0,
    recordedAt: "2026-01-01T00:00:00Z",
  });

  const rows = queryHostVerificationRowsForGate("FG-016", canonical, "npm run test:all");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.projectDir, canonical);
});

test("FG-431: canonicalization does not loosen matching — a genuinely different project still does not match", () => {
  insertHostVerification({
    ticketId: "FG-017",
    projectDir: "/home/test/project-a",
    commitSha: "sha-c",
    gateName: "npm run test:all",
    command: "npm run test:all",
    exitCode: 0,
    recordedAt: "2026-01-01T00:00:00Z",
  });

  const rows = queryHostVerificationRowsForGate("FG-017", "/home/test/project-b", "npm run test:all");
  assert.equal(rows.length, 0, "a different project directory must never match, canonicalized or not");
});
