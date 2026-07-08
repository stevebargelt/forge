import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "./db.js";
import {
  insertHostVerification,
  queryHostVerificationRows,
  queryHostVerificationRowsForGate,
  findCoveringGateEvidence,
  describeGateEvidence,
  REQUIRED_CI_CHECK_CONTEXT,
  type CiCheckStatus,
} from "./host-verifications.js";
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

// ── FG-474: findCoveringGateEvidence / describeGateEvidence ────────────────────

const GATE_SHA = "abc123def456abc123def456abc123def456abc";
const GATE_CMD = "npm run test:all";

// A stub that throws if invoked — proves the CI provider was never consulted
// (the host-row match short-circuited before reaching it).
function unreachableProvider(): CiCheckStatus | null {
  throw new Error("checkStatusProvider must not be called — a covering host row already satisfied the lookup");
}

test("findCoveringGateEvidence: a passing row at the exact sha+command is covering evidence (source host_row), CI provider never consulted", () => {
  insertHostVerification({
    ticketId: "FG-700", projectDir: "/home/test/project", commitSha: GATE_SHA,
    gateName: GATE_CMD, command: GATE_CMD, exitCode: 0, recordedAt: "2026-01-01T00:00:00Z",
  });

  const evidence = findCoveringGateEvidence({
    ticketId: "FG-700", projectDir: "/home/test/project", sha: GATE_SHA, command: GATE_CMD,
    checkStatusProvider: unreachableProvider,
  });
  assert.ok(evidence);
  assert.equal(evidence!.source, "host_row");
  assert.equal((evidence as { source: "host_row"; row: { commitSha: string } }).row.commitSha, GATE_SHA);
});

test("findCoveringGateEvidence: no rows and provider returns null → no covering evidence (fail closed)", () => {
  let called = false;
  const evidence = findCoveringGateEvidence({
    ticketId: "FG-701", projectDir: "/home/test/project", sha: GATE_SHA, command: GATE_CMD,
    checkStatusProvider: () => { called = true; return null; },
  });
  assert.equal(evidence, null);
  assert.equal(called, true, "provider must be consulted when no host row covers");
});

test("findCoveringGateEvidence: a row at a DIFFERENT sha does not satisfy — falls through to the provider", () => {
  insertHostVerification({
    ticketId: "FG-702", projectDir: "/home/test/project", commitSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    gateName: GATE_CMD, command: GATE_CMD, exitCode: 0, recordedAt: "2026-01-01T00:00:00Z",
  });
  let called = false;
  const evidence = findCoveringGateEvidence({
    ticketId: "FG-702", projectDir: "/home/test/project", sha: GATE_SHA, command: GATE_CMD,
    checkStatusProvider: () => { called = true; return null; },
  });
  assert.equal(evidence, null);
  assert.equal(called, true, "a different-sha row must not satisfy the lookup — must fall through to CI");
});

test("findCoveringGateEvidence: a row for a DIFFERENT command does not satisfy — command mismatch never covers", () => {
  insertHostVerification({
    ticketId: "FG-703", projectDir: "/home/test/project", commitSha: GATE_SHA,
    gateName: "npm run test", command: "npm run test", exitCode: 0, recordedAt: "2026-01-01T00:00:00Z",
  });
  const evidence = findCoveringGateEvidence({
    ticketId: "FG-703", projectDir: "/home/test/project", sha: GATE_SHA, command: GATE_CMD,
    checkStatusProvider: () => null,
  });
  assert.equal(evidence, null, "a row recorded for a lesser/different command must never satisfy a broader required gate");
});

test("findCoveringGateEvidence: a FAILING row (exitCode != 0) at the exact sha+command does not satisfy", () => {
  insertHostVerification({
    ticketId: "FG-704", projectDir: "/home/test/project", commitSha: GATE_SHA,
    gateName: GATE_CMD, command: GATE_CMD, exitCode: 1, recordedAt: "2026-01-01T00:00:00Z",
  });
  const evidence = findCoveringGateEvidence({
    ticketId: "FG-704", projectDir: "/home/test/project", sha: GATE_SHA, command: GATE_CMD,
    checkStatusProvider: () => null,
  });
  assert.equal(evidence, null, "a failing covering row must never satisfy the lookup");
});

test("findCoveringGateEvidence: a green required CI check at the exact sha is covering evidence (source ci)", () => {
  const evidence = findCoveringGateEvidence({
    ticketId: "FG-705", projectDir: "/home/test/project", sha: GATE_SHA, command: GATE_CMD,
    checkStatusProvider: (opts) => {
      assert.equal(opts.checkContext, REQUIRED_CI_CHECK_CONTEXT);
      assert.equal(opts.sha, GATE_SHA);
      return { sha: GATE_SHA, state: "success", detailsUrl: "https://github.com/acme/forge/actions/runs/999" };
    },
  });
  assert.ok(evidence);
  assert.equal(evidence!.source, "ci");
  assert.equal((evidence as { source: "ci"; sha: string }).sha, GATE_SHA);
  assert.equal((evidence as { source: "ci"; checkUrl?: string }).checkUrl, "https://github.com/acme/forge/actions/runs/999");
});

test("findCoveringGateEvidence: a PENDING CI check does not satisfy", () => {
  const evidence = findCoveringGateEvidence({
    ticketId: "FG-706", projectDir: "/home/test/project", sha: GATE_SHA, command: GATE_CMD,
    checkStatusProvider: () => ({ sha: GATE_SHA, state: "pending" }),
  });
  assert.equal(evidence, null);
});

test("findCoveringGateEvidence: a FAILED CI check does not satisfy", () => {
  const evidence = findCoveringGateEvidence({
    ticketId: "FG-707", projectDir: "/home/test/project", sha: GATE_SHA, command: GATE_CMD,
    checkStatusProvider: () => ({ sha: GATE_SHA, state: "failure" }),
  });
  assert.equal(evidence, null);
});

test("findCoveringGateEvidence: a green CI check for a DIFFERENT sha does not satisfy (spoof/staleness guard)", () => {
  const evidence = findCoveringGateEvidence({
    ticketId: "FG-708", projectDir: "/home/test/project", sha: GATE_SHA, command: GATE_CMD,
    checkStatusProvider: () => ({ sha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", state: "success" }),
  });
  assert.equal(evidence, null, "a green check reported for a DIFFERENT sha (e.g. a stale branch head) must never cover the requested sha");
});

test("describeGateEvidence: host_row and ci evidence render distinct, informative descriptions", () => {
  insertHostVerification({
    ticketId: "FG-709", projectDir: "/home/test/project", commitSha: GATE_SHA,
    gateName: GATE_CMD, command: GATE_CMD, exitCode: 0, recordedAt: "2026-01-01T00:00:00Z",
  });
  const rowEvidence = findCoveringGateEvidence({
    ticketId: "FG-709", projectDir: "/home/test/project", sha: GATE_SHA, command: GATE_CMD,
    checkStatusProvider: unreachableProvider,
  })!;
  const rowDesc = describeGateEvidence(rowEvidence);
  assert.match(rowDesc, /host_verifications row #\d+/);
  assert.match(rowDesc, new RegExp(GATE_SHA));

  const ciEvidence = findCoveringGateEvidence({
    ticketId: "FG-710", projectDir: "/home/test/project", sha: GATE_SHA, command: GATE_CMD,
    checkStatusProvider: () => ({ sha: GATE_SHA, state: "success", detailsUrl: "https://example.com/run/1" }),
  })!;
  const ciDesc = describeGateEvidence(ciEvidence);
  assert.match(ciDesc, /CI check/);
  assert.match(ciDesc, /https:\/\/example\.com\/run\/1/);
});
