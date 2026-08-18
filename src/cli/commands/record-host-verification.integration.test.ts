import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const here = dirname(fileURLToPath(import.meta.url));
import { NODE_EXEC as tsx, BUILT_CLI_ENTRY as entry } from "../../integration-cli-spawn.js";

let forgeHome: string;
let projectDir: string;

beforeEach(() => {
  forgeHome = mkdtempSync(join(tmpdir(), "forge-rhv-cli-home-"));
  projectDir = mkdtempSync(join(tmpdir(), "forge-rhv-cli-proj-"));
});

afterEach(() => {
  rmSync(forgeHome, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

function runForge(args: string[]) {
  return spawnSync(tsx, [entry, ...args], {
    encoding: "utf8",
    env: { ...process.env, FORGE_HOME: forgeHome, NO_NOTIFY: "true" },
  });
}

// ── successful invocations ────────────────────────────────────────────────────

test("integ record-host-verification: exit 0 for valid pass invocation (exit-code=0)", () => {
  const result = runForge([
    "record-host-verification",
    "--ticket", "FG-419",
    "--project-dir", projectDir,
    "--commit", "abc12345",
    "--command", "npm run test:all",
    "--exit-code", "0",
  ]);

  assert.equal(result.status, 0, `expected exit 0\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  assert.ok(result.stdout.includes("pass"), `stdout must mention 'pass', got: ${result.stdout}`);
  assert.ok(result.stdout.includes("FG-419"), `stdout must mention ticket id, got: ${result.stdout}`);
  assert.ok(result.stdout.includes("abc12345".slice(0, 8)), `stdout must include commit prefix, got: ${result.stdout}`);
});

test("integ record-host-verification: exit 0 and stdout mentions fail for non-zero exit code", () => {
  const result = runForge([
    "record-host-verification",
    "--ticket", "FG-419",
    "--project-dir", projectDir,
    "--commit", "deadbeef",
    "--command", "npm run test:all",
    "--exit-code", "1",
  ]);

  assert.equal(result.status, 0, `expected exit 0\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  assert.ok(result.stdout.includes("fail"), `stdout must mention 'fail', got: ${result.stdout}`);
  assert.ok(result.stdout.includes("exit 1"), `stdout must mention exit code, got: ${result.stdout}`);
});

test("integ record-host-verification: stdout includes gate name", () => {
  const result = runForge([
    "record-host-verification",
    "--ticket", "FG-TEST",
    "--project-dir", projectDir,
    "--commit", "cafebabe",
    "--command", "npm run test:all",
    "--exit-code", "0",
    "--gate", "npm run test:all",
  ]);

  assert.equal(result.status, 0, `exit 0 expected\nstderr: ${result.stderr}`);
  assert.ok(result.stdout.includes("npm run test:all"), `stdout must include gate name, got: ${result.stdout}`);
});

// ── DB persistence ────────────────────────────────────────────────────────────

test("integ record-host-verification: row persisted to forge.db with correct fields (exit-code=0)", () => {
  const result = runForge([
    "record-host-verification",
    "--ticket", "FG-PERSIST-1",
    "--project-dir", projectDir,
    "--commit", "sha-persist-abc",
    "--command", "npm run test:all",
    "--exit-code", "0",
  ]);

  assert.equal(result.status, 0, `exit 0 expected\nstderr: ${result.stderr}`);

  const dbPath = join(forgeHome, "forge.db");
  const db = new Database(dbPath, { readonly: true });
  const row = db.prepare(
    "SELECT * FROM host_verifications WHERE ticket_id = ? AND commit_sha = ?"
  ).get("FG-PERSIST-1", "sha-persist-abc") as Record<string, unknown> | undefined;
  db.close();

  assert.ok(row, "row must be persisted to host_verifications");
  assert.equal(row["ticket_id"], "FG-PERSIST-1");
  assert.equal(row["project_dir"], projectDir);
  assert.equal(row["commit_sha"], "sha-persist-abc");
  assert.equal(row["gate_name"], "npm run test:all");
  assert.equal(row["command"], "npm run test:all");
  assert.equal(row["exit_code"], 0);
  assert.equal(row["run_id"], null, "run_id must be null when --run-id not passed");
  assert.ok(typeof row["recorded_at"] === "string" && row["recorded_at"].length > 0, "recorded_at must be set");
});

test("integ record-host-verification: fail row persisted with correct exit_code", () => {
  const result = runForge([
    "record-host-verification",
    "--ticket", "FG-PERSIST-2",
    "--project-dir", projectDir,
    "--commit", "sha-fail-abc",
    "--command", "npm run test:all",
    "--exit-code", "2",
  ]);

  assert.equal(result.status, 0, `exit 0 expected\nstderr: ${result.stderr}`);

  const dbPath = join(forgeHome, "forge.db");
  const db = new Database(dbPath, { readonly: true });
  const row = db.prepare(
    "SELECT exit_code FROM host_verifications WHERE ticket_id = ? AND commit_sha = ?"
  ).get("FG-PERSIST-2", "sha-fail-abc") as { exit_code: number } | undefined;
  db.close();

  assert.ok(row, "row must be persisted");
  assert.equal(row!.exit_code, 2);
});

test("integ record-host-verification: --gate override persisted to DB", () => {
  const result = runForge([
    "record-host-verification",
    "--ticket", "FG-GATE-1",
    "--project-dir", projectDir,
    "--commit", "sha-gate-abc",
    "--command", "make check",
    "--exit-code", "0",
    "--gate", "make check",
  ]);

  assert.equal(result.status, 0, `exit 0 expected\nstderr: ${result.stderr}`);

  const dbPath = join(forgeHome, "forge.db");
  const db = new Database(dbPath, { readonly: true });
  const row = db.prepare(
    "SELECT gate_name FROM host_verifications WHERE ticket_id = ? AND gate_name = ?"
  ).get("FG-GATE-1", "make check") as { gate_name: string } | undefined;
  db.close();

  assert.ok(row, "row with custom gate must be persisted");
  assert.equal(row!.gate_name, "make check");
});

test("integ record-host-verification: gate_name equals command when --gate not specified", () => {
  const result = runForge([
    "record-host-verification",
    "--ticket", "FG-DEFGATE-1",
    "--project-dir", projectDir,
    "--commit", "sha-defgate-abc",
    "--command", "npm run test:all",
    "--exit-code", "0",
  ]);

  assert.equal(result.status, 0, `exit 0 expected\nstderr: ${result.stderr}`);

  const dbPath = join(forgeHome, "forge.db");
  const db = new Database(dbPath, { readonly: true });
  const row = db.prepare(
    "SELECT gate_name, run_id FROM host_verifications WHERE ticket_id = ? AND commit_sha = ?"
  ).get("FG-DEFGATE-1", "sha-defgate-abc") as { gate_name: string; run_id: string | null } | undefined;
  db.close();

  assert.ok(row, "row must be persisted");
  assert.equal(row!.gate_name, "npm run test:all", "gate_name must equal command when --gate not specified");
  assert.equal(row!.run_id, null, "run_id must be null when --run-id not specified");
});

test("integ record-host-verification: weaker command without --gate records gate_name equal to command (not required gate)", () => {
  // Regression: before the fix, --gate defaulted to "npm run test:all" unconditionally,
  // so --command "npm run typecheck" (no --gate) would spoof the required gate.
  const result = runForge([
    "record-host-verification",
    "--ticket", "FG-SPOOF-1",
    "--project-dir", projectDir,
    "--commit", "sha-spoof-abc",
    "--command", "npm run typecheck",
    "--exit-code", "0",
  ]);

  assert.equal(result.status, 0, `exit 0 expected\nstderr: ${result.stderr}`);

  const dbPath = join(forgeHome, "forge.db");
  const db = new Database(dbPath, { readonly: true });
  const row = db.prepare(
    "SELECT gate_name, command FROM host_verifications WHERE ticket_id = ? AND commit_sha = ?"
  ).get("FG-SPOOF-1", "sha-spoof-abc") as { gate_name: string; command: string } | undefined;
  db.close();

  assert.ok(row, "row must be persisted");
  assert.equal(row!.gate_name, "npm run typecheck", "gate_name must be the command, not the required gate");
  assert.equal(row!.command, "npm run typecheck", "command must be persisted exactly as given");
});

test("integ record-host-verification: multiple calls for same ticket/commit produce multiple rows", () => {
  runForge([
    "record-host-verification",
    "--ticket", "FG-MULTI-1",
    "--project-dir", projectDir,
    "--commit", "sha-multi-abc",
    "--command", "npm run test:all",
    "--exit-code", "1",
  ]);
  const result = runForge([
    "record-host-verification",
    "--ticket", "FG-MULTI-1",
    "--project-dir", projectDir,
    "--commit", "sha-multi-abc",
    "--command", "npm run test:all",
    "--exit-code", "0",
  ]);

  assert.equal(result.status, 0, `second call exit 0 expected\nstderr: ${result.stderr}`);

  const dbPath = join(forgeHome, "forge.db");
  const db = new Database(dbPath, { readonly: true });
  const rows = db.prepare(
    "SELECT exit_code FROM host_verifications WHERE ticket_id = ? AND commit_sha = ? ORDER BY recorded_at ASC"
  ).all("FG-MULTI-1", "sha-multi-abc") as { exit_code: number }[];
  db.close();

  assert.equal(rows.length, 2, "both rows must be persisted");
  assert.equal(rows[0]!.exit_code, 1, "first row must be the fail");
  assert.equal(rows[1]!.exit_code, 0, "second row must be the pass");
});

// ── missing required flags ────────────────────────────────────────────────────

test("integ record-host-verification: missing --ticket → non-zero exit", () => {
  const result = runForge([
    "record-host-verification",
    "--project-dir", projectDir,
    "--commit", "abc123",
    "--command", "npm run test:all",
    "--exit-code", "0",
  ]);

  assert.notEqual(result.status, 0, `must exit non-zero when --ticket is missing; got: ${result.status}`);
});

test("integ record-host-verification: missing --project-dir → non-zero exit", () => {
  const result = runForge([
    "record-host-verification",
    "--ticket", "FG-419",
    "--commit", "abc123",
    "--command", "npm run test:all",
    "--exit-code", "0",
  ]);

  assert.notEqual(result.status, 0, `must exit non-zero when --project-dir is missing; got: ${result.status}`);
});

test("integ record-host-verification: missing --commit → non-zero exit", () => {
  const result = runForge([
    "record-host-verification",
    "--ticket", "FG-419",
    "--project-dir", projectDir,
    "--command", "npm run test:all",
    "--exit-code", "0",
  ]);

  assert.notEqual(result.status, 0, `must exit non-zero when --commit is missing; got: ${result.status}`);
});

test("integ record-host-verification: missing --command → non-zero exit", () => {
  const result = runForge([
    "record-host-verification",
    "--ticket", "FG-419",
    "--project-dir", projectDir,
    "--commit", "abc123",
    "--exit-code", "0",
  ]);

  assert.notEqual(result.status, 0, `must exit non-zero when --command is missing; got: ${result.status}`);
});

test("integ record-host-verification: missing --exit-code → non-zero exit", () => {
  const result = runForge([
    "record-host-verification",
    "--ticket", "FG-419",
    "--project-dir", projectDir,
    "--commit", "abc123",
    "--command", "npm run test:all",
  ]);

  assert.notEqual(result.status, 0, `must exit non-zero when --exit-code is missing; got: ${result.status}`);
});

test("integ record-host-verification: non-integer --exit-code → non-zero exit", () => {
  const result = runForge([
    "record-host-verification",
    "--ticket", "FG-419",
    "--project-dir", projectDir,
    "--commit", "abc123",
    "--command", "npm run test:all",
    "--exit-code", "not-a-number",
  ]);

  assert.notEqual(result.status, 0, `must exit non-zero for non-integer --exit-code; got: ${result.status}`);
});
