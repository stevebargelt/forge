import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "./db.js";
import { insertHostVerification, queryHostVerificationRows } from "./host-verifications.js";
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
