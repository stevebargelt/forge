// FG-419 independent verification: gate-label spoofing regression.
// Adds coverage for two vectors the engineer's 4 regression tests missed:
//   (A) Full done-audit evaluateDoneAudit outcome check (engineer checks hostVerified: null but
//       never calls evaluateDoneAudit — so the outcome: unknown invariant is untested).
//   (B) Explicit --gate override auditability: engineer's CLI override tests all use command ==
//       gate. This test uses command != gate to verify both are stored independently in the DB.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync, execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { writeTicket } from "../backlog/structured.js";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { insertHostVerification } from "../store/host-verifications.js";
import { collectDoneAuditInputFor } from "./collect.js";
import { evaluateDoneAudit } from "./done-audit.js";

const here = dirname(fileURLToPath(import.meta.url));
const cliEntry = resolve(here, "..", "cli", "index.ts");
const tsx = resolve(here, "..", "..", "node_modules", ".bin", "tsx");

let projectDir: string;
let forgeHome: string;
let prevDb: DatabaseInstance | null = null;

function gitExec(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 10000,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "t@t.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "t@t.com",
    },
  });
}

function makeCommit(label: string): string {
  writeFileSync(join(projectDir, `${label}.txt`), label);
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", label], projectDir);
  return gitExec(["rev-parse", "HEAD"], projectDir).trim();
}

function runCli(args: string[]) {
  return spawnSync(tsx, [cliEntry, ...args], {
    encoding: "utf8",
    env: { ...process.env, FORGE_HOME: forgeHome, NO_NOTIFY: "true" },
  });
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "fg419-spoof-verify-"));
  forgeHome = mkdtempSync(join(tmpdir(), "fg419-spoof-verify-home-"));
  gitExec(["init"], projectDir);
  gitExec(["config", "user.email", "t@t.com"], projectDir);
  gitExec(["config", "user.name", "Test"], projectDir);
  prevDb = setDbForTest(makeInMemoryDb());
});

afterEach(() => {
  if (prevDb) setDbForTest(prevDb);
  prevDb = null;
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(forgeHome, { recursive: true, force: true });
});

// ── (A) Core regression: spoofing closed + full done-audit outcome check ──────

test("FG419 verify: typecheck-without-gate row → hostVerified: null AND evaluateDoneAudit outcome: unknown (not pass)", () => {
  // The engineer's collect FG419 spoofing test asserts hostVerified: null but stops there.
  // This independently verifies the FULL path: collect → evaluateDoneAudit → outcome: unknown.
  // The invariant: a typecheck row with the fixed recorder must never produce outcome 'pass'.
  const commitSha = makeCommit("spoof-eval");

  writeTicket(projectDir, {
    id: "FG-V419A-EVAL-1",
    type: "story",
    status: "done",
    closedCommit: commitSha,
    title: "Spoof Eval Full Path",
    body: "done",
    related: [],
  });
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "ticket"], projectDir);

  // Insert what the FIXED recorder now writes for:
  //   record-host-verification --command "npm run typecheck" --exit-code 0   (no --gate)
  // gate_name = command = "npm run typecheck" — NOT the required gate "npm run test:all"
  insertHostVerification({
    ticketId: "FG-V419A-EVAL-1",
    projectDir,
    commitSha,
    gateName: "npm run typecheck",
    command: "npm run typecheck",
    exitCode: 0,
    recordedAt: "2026-01-01T00:00:00Z",
  });

  const input = collectDoneAuditInputFor(projectDir, "FG-V419A-EVAL-1");

  assert.equal(
    input.verification.hostVerified,
    null,
    "hostVerified must be null — typecheck gate_name does not match required gate 'npm run test:all'"
  );

  // Evaluate full done-audit: outcome must NOT be pass
  const result = evaluateDoneAudit(input);

  const hostCheck = result.checks.find((c) => c.name === "host_verification");
  assert.ok(hostCheck, "host_verification check must be present in evaluator output");
  assert.equal(
    hostCheck!.status,
    "unknown",
    "host_verification check must be 'unknown' — typecheck row does not satisfy the required gate"
  );
  assert.notEqual(
    result.outcome,
    "pass",
    "done-audit outcome must NOT be 'pass' when typecheck row spoofs required gate (spoofing is closed)"
  );
});

// ── (B) Explicit gate override auditability (glass-box) ───────────────────────

test("FG419 verify: CLI --command typecheck --gate test:all stores BOTH distinctly in DB (auditable glass-box)", () => {
  // The engineer's --gate CLI tests use the same value for both --command and --gate.
  // This test uses DIFFERENT values (weak command overridden to required gate) to verify:
  //   1. The DB stores command="npm run typecheck" AND gate_name="npm run test:all" independently
  //      so an auditor can see the mismatch (what actually ran vs what gate was credited).
  //   2. The confirmation stdout shows the effective gate_name so the operator sees it at record time.
  // This is the "glass-box" / explicit-override path: intentional, logged, auditable.
  const result = runCli([
    "record-host-verification",
    "--ticket", "FG-V419B-AUDIT-1",
    "--project-dir", projectDir,
    "--commit", "sha-audit-verify",
    "--command", "npm run typecheck",
    "--exit-code", "0",
    "--gate", "npm run test:all",
  ]);

  assert.equal(result.status, 0, `CLI must succeed\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);

  // Stdout must show the effective gate name so the operator sees the override immediately
  assert.ok(
    result.stdout.includes("npm run test:all"),
    `stdout must include effective gate 'npm run test:all' so override is operator-visible at record time\ngot: ${result.stdout}`
  );

  // DB must store BOTH the original command and the overridden gate_name as distinct values
  const dbPath = join(forgeHome, "forge.db");
  const db = new Database(dbPath, { readonly: true });
  const row = db.prepare(
    "SELECT command, gate_name FROM host_verifications WHERE ticket_id = ? AND commit_sha = ?"
  ).get("FG-V419B-AUDIT-1", "sha-audit-verify") as { command: string; gate_name: string } | undefined;
  db.close();

  assert.ok(row, "row must be persisted in DB");
  assert.equal(
    row!.command,
    "npm run typecheck",
    "command column must store the actual weak command that ran (not the overridden gate)"
  );
  assert.equal(
    row!.gate_name,
    "npm run test:all",
    "gate_name column must store the explicit --gate override value"
  );
  assert.notEqual(
    row!.command,
    row!.gate_name,
    "command and gate_name must differ — proving both are independently stored and the override is auditable"
  );
});
