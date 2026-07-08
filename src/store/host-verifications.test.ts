import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeInMemoryDb, setDbForTest, applyMigrations } from "./db.js";
import { SCHEMA_SQL } from "./schema.js";
import {
  insertHostVerification,
  queryHostVerificationRows,
  queryHostVerificationRowsForGate,
  findCoveringGateEvidence,
  describeGateEvidence,
  aggregateCiCheckRuns,
  projectCiRunsCommand,
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

// ── FG-474 (task-red-wide-16933b): projectCiRunsCommand — per-project,
// content-verified pairing between a CI check name and the command it runs ──
//
// forge is host-global: opts.projectDir in findCoveringGateEvidence is an
// ARBITRARY managed project, never forge's own repo. So the pairing between a
// green "CI / test" check and the command it proves ran can only be verified
// by reading THAT project's own .github/workflows content at lookup time —
// never by a hardcoded constant (which only pairs with forge's OWN ci.yml).

function writeWorkflowFile(dir: string, filename: string, yamlContent: string): void {
  const workflowsDir = join(dir, ".github", "workflows");
  mkdirSync(workflowsDir, { recursive: true });
  writeFileSync(join(workflowsDir, filename), yamlContent);
}

function withTempProjectDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "hv-ci-fixture-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("projectCiRunsCommand: an exact-matching run step -> true", () => {
  withTempProjectDir((dir) => {
    writeWorkflowFile(dir, "ci.yml", "name: CI\njobs:\n  test:\n    steps:\n      - run: npm run test:all\n");
    assert.equal(projectCiRunsCommand(dir, "CI / test", "npm run test:all"), true);
  });
});

test("projectCiRunsCommand: the command as a substring of a longer run line -> false", () => {
  withTempProjectDir((dir) => {
    writeWorkflowFile(dir, "ci.yml", "name: CI\njobs:\n  test:\n    steps:\n      - run: npm run test:all -- --coverage\n");
    assert.equal(projectCiRunsCommand(dir, "CI / test", "npm run test:all"), false, "must be an EXACT match, not a substring/prefix match");
  });
});

test("projectCiRunsCommand: matching workflow but a DIFFERENT job -> false", () => {
  withTempProjectDir((dir) => {
    writeWorkflowFile(dir, "ci.yml", "name: CI\njobs:\n  lint:\n    steps:\n      - run: npm run test:all\n");
    assert.equal(projectCiRunsCommand(dir, "CI / test", "npm run test:all"), false);
  });
});

test("projectCiRunsCommand: a DIFFERENT workflow name -> false", () => {
  withTempProjectDir((dir) => {
    writeWorkflowFile(dir, "ci.yml", "name: Build\njobs:\n  test:\n    steps:\n      - run: npm run test:all\n");
    assert.equal(projectCiRunsCommand(dir, "CI / test", "npm run test:all"), false);
  });
});

test("projectCiRunsCommand: no .github/workflows directory at all -> false", () => {
  withTempProjectDir((dir) => {
    assert.equal(projectCiRunsCommand(dir, "CI / test", "npm run test:all"), false);
  });
});

test("projectCiRunsCommand: unparseable YAML -> false", () => {
  withTempProjectDir((dir) => {
    writeWorkflowFile(dir, "ci.yml", "name: CI\njobs:\n  test:\n    steps: [\n");
    assert.equal(projectCiRunsCommand(dir, "CI / test", "npm run test:all"), false);
  });
});

test("projectCiRunsCommand: multiple workflow files where a NON-'CI' workflow contains the command -> false", () => {
  withTempProjectDir((dir) => {
    writeWorkflowFile(dir, "build.yml", "name: Build\njobs:\n  test:\n    steps:\n      - run: npm run test:all\n");
    writeWorkflowFile(dir, "ci.yml", "name: CI\njobs:\n  test:\n    steps:\n      - run: npm run lint\n");
    assert.equal(projectCiRunsCommand(dir, "CI / test", "npm run test:all"), false, "only the workflow actually named 'CI' may satisfy the pairing");
  });
});

// ── FG-474: findCoveringGateEvidence / describeGateEvidence ────────────────────
//
// projectDir here is a REAL temp directory with a matching .github/workflows/ci.yml
// (workflow "CI", job "test", running GATE_CMD) — not the pre-fix "/home/test/project"
// placeholder — so these tests exercise the real per-project pairing gate end to end,
// not just the provider dispatch downstream of it.

const GATE_SHA = "abc123def456abc123def456abc123def456abc";
const GATE_CMD = "npm run test:all";

// A stub that throws if invoked — proves the CI provider was never consulted
// (the host-row match, or the pairing gate itself, short-circuited before reaching it).
function unreachableProvider(): CiCheckStatus | null {
  throw new Error("checkStatusProvider must not be called — a covering host row already satisfied the lookup");
}

describe("findCoveringGateEvidence / describeGateEvidence (real per-project ci.yml pairing)", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "hv-evidence-project-"));
    writeWorkflowFile(projectDir, "ci.yml", `name: CI\njobs:\n  test:\n    steps:\n      - run: ${GATE_CMD}\n`);
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  test("a passing row at the exact sha+command is covering evidence (source host_row), CI provider never consulted", () => {
    insertHostVerification({
      ticketId: "FG-700", projectDir, commitSha: GATE_SHA,
      gateName: GATE_CMD, command: GATE_CMD, exitCode: 0, recordedAt: "2026-01-01T00:00:00Z",
    });

    const evidence = findCoveringGateEvidence({
      ticketId: "FG-700", projectDir, sha: GATE_SHA, command: GATE_CMD,
      checkStatusProvider: unreachableProvider,
    });
    assert.ok(evidence);
    assert.equal(evidence!.source, "host_row");
    assert.equal((evidence as { source: "host_row"; row: { commitSha: string } }).row.commitSha, GATE_SHA);
  });

  test("no rows and provider returns null → no covering evidence (fail closed)", () => {
    let called = false;
    const evidence = findCoveringGateEvidence({
      ticketId: "FG-701", projectDir, sha: GATE_SHA, command: GATE_CMD,
      checkStatusProvider: () => { called = true; return null; },
    });
    assert.equal(evidence, null);
    assert.equal(called, true, "provider must be consulted when no host row covers and this project's ci.yml pairs the check with the command");
  });

  test("a row at a DIFFERENT sha does not satisfy — falls through to the provider", () => {
    insertHostVerification({
      ticketId: "FG-702", projectDir, commitSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      gateName: GATE_CMD, command: GATE_CMD, exitCode: 0, recordedAt: "2026-01-01T00:00:00Z",
    });
    let called = false;
    const evidence = findCoveringGateEvidence({
      ticketId: "FG-702", projectDir, sha: GATE_SHA, command: GATE_CMD,
      checkStatusProvider: () => { called = true; return null; },
    });
    assert.equal(evidence, null);
    assert.equal(called, true, "a different-sha row must not satisfy the lookup — must fall through to CI");
  });

  test("a row for a DIFFERENT command does not satisfy — command mismatch never covers", () => {
    insertHostVerification({
      ticketId: "FG-703", projectDir, commitSha: GATE_SHA,
      gateName: "npm run test", command: "npm run test", exitCode: 0, recordedAt: "2026-01-01T00:00:00Z",
    });
    const evidence = findCoveringGateEvidence({
      ticketId: "FG-703", projectDir, sha: GATE_SHA, command: GATE_CMD,
      checkStatusProvider: () => null,
    });
    assert.equal(evidence, null, "a row recorded for a lesser/different command must never satisfy a broader required gate");
  });

  test("a FAILING row (exitCode != 0) at the exact sha+command does not satisfy", () => {
    insertHostVerification({
      ticketId: "FG-704", projectDir, commitSha: GATE_SHA,
      gateName: GATE_CMD, command: GATE_CMD, exitCode: 1, recordedAt: "2026-01-01T00:00:00Z",
    });
    const evidence = findCoveringGateEvidence({
      ticketId: "FG-704", projectDir, sha: GATE_SHA, command: GATE_CMD,
      checkStatusProvider: () => null,
    });
    assert.equal(evidence, null, "a failing covering row must never satisfy the lookup");
  });

  test("a green required CI check at the exact sha but a DIFFERENT command never satisfies — this project's ci.yml never ran that command (FG-419 gate_name spoofing guard)", () => {
    let called = false;
    const evidence = findCoveringGateEvidence({
      ticketId: "FG-711", projectDir, sha: GATE_SHA, command: "npm run verify",
      checkStatusProvider: () => { called = true; return { sha: GATE_SHA, state: "success" }; },
    });
    assert.equal(evidence, null, "a green CI check must never cover a command this project's ci.yml never ran");
    assert.equal(called, false, "the provider must not even be consulted for a command the pairing gate rejects");
  });

  test("a green required CI check at the exact sha is covering evidence (source ci)", () => {
    const evidence = findCoveringGateEvidence({
      ticketId: "FG-705", projectDir, sha: GATE_SHA, command: GATE_CMD,
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

  test("a green required CI check at the exact sha but a projectDir whose ci.yml runs something else -> null, and the provider is never consulted", () => {
    rmSync(join(projectDir, ".github"), { recursive: true, force: true });
    writeWorkflowFile(projectDir, "ci.yml", "name: CI\njobs:\n  test:\n    steps:\n      - run: npm run something-else\n");

    let called = false;
    const evidence = findCoveringGateEvidence({
      ticketId: "FG-713", projectDir, sha: GATE_SHA, command: GATE_CMD,
      checkStatusProvider: () => { called = true; return { sha: GATE_SHA, state: "success" }; },
    });
    assert.equal(evidence, null, "a green check on a project whose ci.yml runs a DIFFERENT command must never be labeled as covering evidence");
    assert.equal(called, false, "the pairing check runs BEFORE the provider — a failed pairing must never even reach it");
  });

  test("a PENDING CI check does not satisfy", () => {
    const evidence = findCoveringGateEvidence({
      ticketId: "FG-706", projectDir, sha: GATE_SHA, command: GATE_CMD,
      checkStatusProvider: () => ({ sha: GATE_SHA, state: "pending" }),
    });
    assert.equal(evidence, null);
  });

  test("a FAILED CI check does not satisfy", () => {
    const evidence = findCoveringGateEvidence({
      ticketId: "FG-707", projectDir, sha: GATE_SHA, command: GATE_CMD,
      checkStatusProvider: () => ({ sha: GATE_SHA, state: "failure" }),
    });
    assert.equal(evidence, null);
  });

  test("a green CI check for a DIFFERENT sha does not satisfy (spoof/staleness guard)", () => {
    const evidence = findCoveringGateEvidence({
      ticketId: "FG-708", projectDir, sha: GATE_SHA, command: GATE_CMD,
      checkStatusProvider: () => ({ sha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", state: "success" }),
    });
    assert.equal(evidence, null, "a green check reported for a DIFFERENT sha (e.g. a stale branch head) must never cover the requested sha");
  });

  test("describeGateEvidence: host_row and ci evidence render distinct, informative descriptions", () => {
    insertHostVerification({
      ticketId: "FG-709", projectDir, commitSha: GATE_SHA,
      gateName: GATE_CMD, command: GATE_CMD, exitCode: 0, recordedAt: "2026-01-01T00:00:00Z",
    });
    const rowEvidence = findCoveringGateEvidence({
      ticketId: "FG-709", projectDir, sha: GATE_SHA, command: GATE_CMD,
      checkStatusProvider: unreachableProvider,
    })!;
    const rowDesc = describeGateEvidence(rowEvidence);
    assert.match(rowDesc, /host_verifications row #\d+/);
    assert.match(rowDesc, new RegExp(GATE_SHA));

    const ciEvidence = findCoveringGateEvidence({
      ticketId: "FG-710", projectDir, sha: GATE_SHA, command: GATE_CMD,
      checkStatusProvider: () => ({ sha: GATE_SHA, state: "success", detailsUrl: "https://example.com/run/1" }),
    })!;
    const ciDesc = describeGateEvidence(ciEvidence);
    assert.match(ciDesc, /CI check/);
    assert.match(ciDesc, /https:\/\/example\.com\/run\/1/);
  });
});

// ── FG-474: aggregateCiCheckRuns — pure check-runs response parsing/aggregation ─
//
// Exercises the check-runs API aggregation WITHOUT invoking gh: defaultCheckStatusProvider
// is gh-backed and untestable directly, but its response handling is factored into this
// pure function (raw parsed JSON -> CiCheckStatus | null) precisely so these rules are
// covered here.

const CR_SHA = "3a1ff5d90af281c731a2a047d6a138daa7b38d66";
const CR_OPTS = { sha: CR_SHA, checkName: "test" };

function checkRun(overrides: Record<string, unknown>): Record<string, unknown> {
  return { head_sha: CR_SHA, name: "test", status: "completed", conclusion: "success", ...overrides };
}

test("aggregateCiCheckRuns: a single completed successful run aggregates to success", () => {
  const result = aggregateCiCheckRuns(
    { check_runs: [checkRun({ html_url: "https://github.com/acme/forge/actions/runs/1" })] },
    CR_OPTS
  );
  assert.deepEqual(result, { sha: CR_SHA, state: "success", detailsUrl: "https://github.com/acme/forge/actions/runs/1" });
});

test("aggregateCiCheckRuns: duplicate successful runs (push + pull_request) still aggregate to success", () => {
  const result = aggregateCiCheckRuns(
    {
      check_runs: [
        checkRun({ html_url: "https://github.com/acme/forge/actions/runs/1" }),
        checkRun({ html_url: "https://github.com/acme/forge/actions/runs/2" }),
      ],
    },
    CR_OPTS
  );
  assert.ok(result);
  assert.equal(result!.state, "success");
});

test("aggregateCiCheckRuns: one success + one failure for the same sha aggregates to failure (disagreement is never covering evidence)", () => {
  const result = aggregateCiCheckRuns(
    {
      check_runs: [
        checkRun({ conclusion: "success", html_url: "https://github.com/acme/forge/actions/runs/1" }),
        checkRun({ conclusion: "failure", html_url: "https://github.com/acme/forge/actions/runs/2" }),
      ],
    },
    CR_OPTS
  );
  assert.ok(result);
  assert.equal(result!.state, "failure");
  assert.equal(result!.detailsUrl, "https://github.com/acme/forge/actions/runs/2");
});

test("aggregateCiCheckRuns: a queued/in_progress run with no failures aggregates to pending", () => {
  const result = aggregateCiCheckRuns(
    { check_runs: [checkRun({ status: "in_progress", conclusion: null })] },
    CR_OPTS
  );
  assert.deepEqual(result, { sha: CR_SHA, state: "pending" });
});

test("aggregateCiCheckRuns: a completed run for a DIFFERENT sha does not satisfy — sha mismatch means no matching run", () => {
  const result = aggregateCiCheckRuns(
    { check_runs: [checkRun({ head_sha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" })] },
    CR_OPTS
  );
  assert.equal(result, null);
});

test("aggregateCiCheckRuns: malformed JSON shape (check_runs missing/not an array) returns null", () => {
  assert.equal(aggregateCiCheckRuns({}, CR_OPTS), null);
  assert.equal(aggregateCiCheckRuns({ check_runs: "not-an-array" }, CR_OPTS), null);
  assert.equal(aggregateCiCheckRuns(null, CR_OPTS), null);
  assert.equal(aggregateCiCheckRuns("a string", CR_OPTS), null);
});

test("aggregateCiCheckRuns: no runs matching the requested check name returns null", () => {
  const result = aggregateCiCheckRuns({ check_runs: [checkRun({ name: "lint" })] }, CR_OPTS);
  assert.equal(result, null);
});

test("aggregateCiCheckRuns: a completed run with a non-success/failure conclusion (e.g. cancelled) and no other runs aggregates to other", () => {
  const result = aggregateCiCheckRuns({ check_runs: [checkRun({ conclusion: "cancelled" })] }, CR_OPTS);
  assert.deepEqual(result, { sha: CR_SHA, state: "other" });
});

// ── FG-474 red-review fix (low #3): pre-FG-474 shape migration ─────────────────
//
// A host_verifications row written before FG-474 added source/ci_url has
// neither column. applyMigrations's ALTER ... DEFAULT 'host' must backfill it
// to classify as a real host-run row (source='host', ci_url=null) — the same
// classification a fresh-schema host row gets — and the migration must be
// idempotent (a second open must not throw or reclassify anything).

test("applyMigrations: a pre-FG-474 host_verifications row (no source/ci_url columns) migrates to source='host'/ci_url=null, and re-running migrations is idempotent", () => {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  // Re-shape to the pre-FG-474 CREATE — no source/ci_url columns at all.
  db.exec("DROP TABLE host_verifications");
  db.exec(`CREATE TABLE host_verifications (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id   TEXT NOT NULL,
    project_dir TEXT NOT NULL,
    commit_sha  TEXT NOT NULL,
    gate_name   TEXT NOT NULL,
    command     TEXT NOT NULL,
    exit_code   INTEGER NOT NULL,
    run_id      TEXT REFERENCES runs(id),
    recorded_at TEXT NOT NULL
  )`);
  db.prepare(
    `INSERT INTO host_verifications (ticket_id, project_dir, commit_sha, gate_name, command, exit_code, run_id, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run("FG-720", "/home/test/project", "abc123", "npm run test:all", "npm run test:all", 0, null, "2026-01-01T00:00:00Z");

  applyMigrations(db);

  const prev = setDbForTest(db);
  try {
    const rows = queryHostVerificationRows("FG-720", "/home/test/project", "abc123", "npm run test:all");
    assert.equal(rows.length, 1, "the pre-existing row must survive the migration");
    assert.equal(rows[0]!.source, "host", "a pre-FG-474 row must backfill to source='host'");
    assert.equal(rows[0]!.ciUrl, null, "a pre-FG-474 row must backfill to ci_url=null");
  } finally {
    setDbForTest(prev as DatabaseInstance);
  }

  assert.doesNotThrow(() => applyMigrations(db), "re-running migrations on an already-migrated DB must be a no-op, not throw");
  const cols = new Set((db.prepare("PRAGMA table_info(host_verifications)").all() as { name: string }[]).map((r) => r.name));
  assert.ok(cols.has("source"));
  assert.ok(cols.has("ci_url"));
  db.close();
});
