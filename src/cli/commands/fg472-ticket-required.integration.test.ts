// FG-472 integration tests: `forge new` fails BEFORE run creation when the
// selected workflow carries an authoritative shipping-reviewer red and no
// backlog ticket is supplied. Proves the full CLI path end to end (real
// subprocess, real sqlite db, real backlog files) rather than just the
// extracted helper functions — the acceptance criteria are framed in terms of
// "no run row, no container", so this asserts against the actual db.
//
// Covers:
//   (fg472-1) --ticket <real id> creates a run with metadata.ticketId set
//   (fg472-2) missing --ticket for an authoritative-shipping-reviewer workflow
//             fails before any run row is written
//   (fg472-3) --ticket <unknown id> fails before any run row is written
//   (fg472-4) --ticket and --meta ticketId disagreeing fails before any run
//             row is written
//   (fg472-5) a workflow with no authoritative shipping-reviewer needs no
//             ticket at all (unchanged behavior)

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { writeTicket } from "../../backlog/structured.js";
import { publishFlatAsGeneration } from "../../v2/seed-generation.testkit.js";

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, "..", "index.ts");
const tsx = resolve(here, "..", "..", "..", "node_modules", ".bin", "tsx");

const WORKFLOW_WITH_AUTHORITATIVE_SHIPPING_REVIEWER = `
name: fg472-feature-test
description: FG-472 test fixture — authoritative shipping-reviewer
steps:
  - id: build
    agent: engineer
    gate: verdict
    reds:
      - agent: shipping-reviewer
        authority: authoritative
`;

const WORKFLOW_WITHOUT_AUTHORITATIVE_SHIPPING_REVIEWER = `
name: fg472-nonfeature-test
description: FG-472 test fixture — no shipping-reviewer at all
steps:
  - id: build
    agent: engineer
    gate: auto
`;

let forgeHome: string;
let projectDir: string;

beforeEach(() => {
  forgeHome = mkdtempSync(join(tmpdir(), "forge-fg472-home-"));
  projectDir = mkdtempSync(join(tmpdir(), "forge-fg472-proj-"));

  mkdirSync(join(forgeHome, "workflows"), { recursive: true });
  writeFileSync(join(forgeHome, "workflows", "fg472-feature-test.yml"), WORKFLOW_WITH_AUTHORITATIVE_SHIPPING_REVIEWER);
  writeFileSync(join(forgeHome, "workflows", "fg472-nonfeature-test.yml"), WORKFLOW_WITHOUT_AUTHORITATIVE_SHIPPING_REVIEWER);
  publishFlatAsGeneration(forgeHome);

  writeTicket(projectDir, {
    id: "FG-123",
    type: "story",
    status: "active",
    title: "Real ticket",
    body: "",
    created: "2024-01-01",
  });
  writeTicket(projectDir, {
    id: "FG-456",
    type: "story",
    status: "active",
    title: "Another real ticket",
    body: "",
    created: "2024-01-02",
  });
});

afterEach(() => {
  rmSync(forgeHome, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

function runForge(args: string[]) {
  return spawnSync(tsx, [entry, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      FORGE_HOME: forgeHome,
      NO_NOTIFY: "true",
      ANTHROPIC_API_KEY: "sk-test-fg472",
      CLAUDE_CODE_USE_BEDROCK: "0",
    },
  });
}

function runRowCount(): number {
  const dbPath = join(forgeHome, "forge.db");
  if (!existsSync(dbPath)) return 0; // db is only created lazily on first write — absence means zero rows
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.prepare("SELECT COUNT(*) as n FROM runs").get() as { n: number };
    return row.n;
  } finally {
    db.close();
  }
}

function extractRunId(stdout: string): string {
  const match = stdout.match(/Created run (\S+)/);
  assert.ok(match, `expected "Created run <id>" in stdout: ${stdout}`);
  const runId = match?.[1];
  assert.ok(runId, `expected a captured run id in stdout: ${stdout}`);
  return runId;
}

function loadRun(runId: string): { metadata: string } {
  const db = new Database(join(forgeHome, "forge.db"), { readonly: true });
  try {
    return db.prepare("SELECT metadata FROM runs WHERE id = ?").get(runId) as { metadata: string };
  } finally {
    db.close();
  }
}

test("integ forge new: --ticket <real id> creates a run with metadata.ticketId set", () => {
  const result = runForge([
    "new", "fg472-feature-test", "fg472 real ticket",
    "--project", projectDir,
    "--ticket", "FG-123",
  ]);

  assert.equal(result.status, 0, `expected exit 0\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);

  const runId = extractRunId(result.stdout);

  assert.equal(runRowCount(), 1, "exactly one run row must be persisted");
  const run = loadRun(runId);
  const metadata = JSON.parse(run.metadata);
  assert.equal(metadata.ticketId, "FG-123");
});

test("integ forge new: missing --ticket for an authoritative-shipping-reviewer workflow fails before run creation", () => {
  const result = runForge([
    "new", "fg472-feature-test", "fg472 no ticket",
    "--project", projectDir,
  ]);

  assert.notEqual(result.status, 0, `expected non-zero exit\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  assert.match(
    result.stderr,
    /workflow 'fg472-feature-test' requires --ticket <id> because shipping-reviewer needs backlog acceptance criteria/,
  );
  assert.equal(runRowCount(), 0, "no run row may be written when --ticket is missing");
});

test("integ forge new: --ticket <unknown id> fails before run creation", () => {
  const result = runForge([
    "new", "fg472-feature-test", "fg472 unknown ticket",
    "--project", projectDir,
    "--ticket", "FG-999",
  ]);

  assert.notEqual(result.status, 0, `expected non-zero exit\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  assert.match(result.stderr, /--ticket FG-999 not found in backlog/);
  assert.equal(runRowCount(), 0, "no run row may be written for an unknown ticket");
});

test("integ forge new: --ticket and --meta ticketId disagreeing fails before run creation", () => {
  const result = runForge([
    "new", "fg472-feature-test", "fg472 disagreeing ticket",
    "--project", projectDir,
    "--ticket", "FG-123",
    "--meta", JSON.stringify({ ticketId: "FG-456" }),
  ]);

  assert.notEqual(result.status, 0, `expected non-zero exit\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  assert.match(result.stderr, /--ticket FG-123 conflicts with --meta ticketId FG-456/);
  assert.equal(runRowCount(), 0, "no run row may be written when --ticket and --meta ticketId disagree");
});

test("integ forge new: a workflow with no authoritative shipping-reviewer needs no ticket (unchanged behavior)", () => {
  const result = runForge([
    "new", "fg472-nonfeature-test", "fg472 no reviewer needed",
    "--project", projectDir,
  ]);

  assert.equal(result.status, 0, `expected exit 0\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  assert.equal(runRowCount(), 1, "exactly one run row must be persisted");

  const run = loadRun(extractRunId(result.stdout));
  const metadata = JSON.parse(run.metadata);
  assert.equal(metadata.ticketId, undefined, "ticketId must not be set when not supplied and not required");
});
