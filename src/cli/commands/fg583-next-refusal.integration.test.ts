// FG-583 (FG-572 Child 5h) — `forge next` DISPATCH-CONSUMER refusal on a partial
// seed install.
//
// The brief requires the named, repairable partial-install state to propagate to
// the dispatch consumers with retry advice. next.ts:52-59 refuses a wave when
// inspectSeedInstall() reports `incomplete`, rather than dispatching under a
// mixed/torn generation no release shipped. This drives the REAL `forge next`
// CLI subprocess (commander parsing → real on-disk sqlite → the real seed gate),
// the same harness technique fg585-run-failed-cli uses, and proves:
//
//   1. an INCOMPLETE seed install → `forge next` refuses, names the state, gives
//      the `forge upgrade` retry advice, and exits non-zero (never dispatches);
//   2. a NO-GENERATION home (fresh / flat layout — HEALTHY, not partial) does NOT
//      trip the seed refusal — the wave gets PAST the seed gate (and fails later
//      for an unrelated reason). This guards that the gate keys on `incomplete`
//      ONLY, never on the ordinary pre-migration flat host.
//
// Uses a DISPOSABLE FORGE_HOME + its own sqlite DB; the real ~/.forge is NEVER
// touched. Auth env is stripped so oauth mode passes through without a hard
// cred block, letting the wave reach the seed gate.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { SCHEMA_SQL } from "../../store/schema.js";
import { applyMigrations } from "../../store/db.js";

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, "..", "index.ts");
const tsx = resolve(here, "..", "..", "..", "node_modules", ".bin", "tsx");

let forgeHome: string;
let projectDir: string;
let db: DatabaseInstance;

beforeEach(() => {
  forgeHome = mkdtempSync(join(tmpdir(), "forge-fg583-next-home-"));
  db = new Database(join(forgeHome, "forge.db"));
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  applyMigrations(db);
  projectDir = mkdtempSync(join(tmpdir(), "forge-fg583-next-project-"));
});

afterEach(() => {
  db.close();
  rmSync(forgeHome, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

function insertActiveRun(o: { id: string; workflow: string }): void {
  db.prepare(
    `INSERT INTO runs (id, workflow, title, status, created_at, completed_at, project_dir)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(o.id, o.workflow, "fg583 next-refusal fixture", "active", "2026-07-01T00:00:00Z", null, projectDir);
}

/** Plant a torn generation in the disposable home: a generation the seed pointer
 *  resolves to that never got its provenance manifest — the incomplete state the
 *  dispatch gate must refuse under. */
function plantTornGeneration(): void {
  const torn = join(forgeHome, "seed-generations", "gen-torn");
  mkdirSync(join(torn, "workflows"), { recursive: true });
  writeFileSync(join(torn, "workflows", "alpha.yml"), "name: alpha\n");
  symlinkSync(torn, join(forgeHome, "seed-current"));
}

function runNext(runId: string) {
  // Strip auth env so the subprocess resolves to oauth mode and passes cred
  // validation without a hard block (no volume probe result → falls through),
  // letting the wave actually reach the FG-583 seed gate.
  const env: NodeJS.ProcessEnv = { ...process.env, FORGE_HOME: forgeHome, NO_NOTIFY: "true" };
  delete env.ANTHROPIC_API_KEY;
  delete env.CLAUDE_CODE_USE_BEDROCK;
  delete env.AWS_PROFILE;
  return spawnSync(tsx, [entry, "next", runId, "--project", projectDir], { encoding: "utf8", env });
}

test("FG-583: forge next REFUSES to dispatch under an incomplete seed install, names it, advises forge upgrade, and exits non-zero", () => {
  const runId = "run-fg583-next-incomplete";
  insertActiveRun({ id: runId, workflow: "any-workflow" });
  plantTornGeneration();

  const r = runNext(runId);
  const out = `${r.stdout}\n${r.stderr}`;

  assert.match(out, /refusing to dispatch — the host seed install is incomplete/, "next must refuse under a partial install");
  assert.match(out, /no valid provenance manifest|mid-publish|torn/, "and name the incomplete-generation reason");
  assert.match(out, /forge upgrade/, "and give the republish retry advice");
  assert.notEqual(r.status, 0, "a refused wave exits non-zero");
  // It never got to workflow loading / dispatch — the refusal is a preflight gate.
  assert.doesNotMatch(out, /wave dispatched/, "nothing was dispatched");
});

test("FG-583: a no-generation home (fresh / flat layout) does NOT trip the seed refusal — the wave gets past the seed gate", () => {
  // No seed pointer planted → inspectSeedInstall() reports `no-generation`, which
  // is HEALTHY. The run names a workflow that does not resolve on the flat layout,
  // so the wave PASSES the seed gate and then fails at workflow load — proving the
  // gate keys on `incomplete` only, never on the ordinary flat host.
  const runId = "run-fg583-next-nogen";
  insertActiveRun({ id: runId, workflow: "fg583-absent-workflow" });

  const r = runNext(runId);
  const out = `${r.stdout}\n${r.stderr}`;

  assert.doesNotMatch(out, /the host seed install is incomplete/, "a no-generation host must NOT be refused as a partial install");
  // Got past the seed gate: the failure is the unresolved workflow, not the gate.
  assert.match(out, /fg583-absent-workflow|not found/, "the wave reached workflow resolution past the seed gate");
});
