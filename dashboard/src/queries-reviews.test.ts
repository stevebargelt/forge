// FG-638: the dashboard's read of the review ledger. Same harness as
// queries-verification.test.ts — a temp FORGE_HOME seeded with a hand-shaped
// fixture DB, then the read-only query.

import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpHome = mkdtempSync(join(tmpdir(), "forge-qreviews-"));
process.env.FORGE_HOME = tmpHome;

const { reviewLedger } = await import("./queries.js");

{
  const db = new Database(join(tmpHome, "forge.db"));
  db.exec(`
    CREATE TABLE runs (id TEXT PRIMARY KEY, workflow TEXT, title TEXT, status TEXT, created_at TEXT,
                       project_dir TEXT, review_mode TEXT);
    CREATE TABLE reviews (
      id TEXT PRIMARY KEY, run_id TEXT, subject_task_id TEXT, ticket_id TEXT, base_sha TEXT,
      contract_confirmed_sha TEXT, candidate_sha TEXT, trusted_remote_sha TEXT, contract_json TEXT,
      lens_outcomes_json TEXT, review_mode TEXT, state TEXT, created_at TEXT, updated_at TEXT, settled_at TEXT);
    CREATE TABLE review_findings (
      id TEXT PRIMARY KEY, review_id TEXT, ordinal INTEGER, finding_ref TEXT, fingerprint TEXT, summary TEXT,
      severity TEXT, risk_lens TEXT, finding_type TEXT, evidence TEXT, hypothesis TEXT, reachability TEXT,
      file TEXT, line INTEGER, quoted_text TEXT, acceptance_ref TEXT, invariant_ref TEXT, sources_json TEXT,
      disposition TEXT, disposition_rationale TEXT, disposition_evidence TEXT, decided_by TEXT, decided_at TEXT,
      decided_candidate_sha TEXT, duplicate_of TEXT, followup_ticket_id TEXT, resolution TEXT,
      resolution_evidence_kind TEXT, resolution_evidence TEXT, discovered_sha TEXT, resolved_sha TEXT,
      created_at TEXT, updated_at TEXT);

    INSERT INTO runs VALUES ('run-a','feature','A','active','2026-07-30T00:00:00Z','/proj/a','evidence_led');
    INSERT INTO runs VALUES ('run-b','feature','B','active','2026-07-30T00:00:00Z','/proj/b','evidence_led');

    INSERT INTO reviews VALUES ('review-a','run-a','task-a','FG-638','base0','conf0','cand0','rem0',
      '{"risk_lenses":["wide","security"]}', NULL, 'evidence_led','awaiting_disposition',
      '2026-07-30T00:00:00Z','2026-07-30T02:00:00Z', NULL);
    INSERT INTO reviews VALUES ('review-b','run-b','task-b','FG-700','base1','conf1','cand1','rem1',
      NULL, NULL, 'evidence_led','settled','2026-07-30T00:00:00Z','2026-07-30T01:00:00Z','2026-07-30T01:00:00Z');

    INSERT INTO review_findings (id, review_id, ordinal, finding_ref, summary, severity, risk_lens, reachability,
                                 file, line, quoted_text, invariant_ref, sources_json, disposition, decided_by,
                                 resolution, created_at, updated_at)
      VALUES ('review-a/RF-1','review-a',1,'RF-1','unauthenticated write','high','security','demonstrated',
              'src/store/db.ts',42,'db.exec(sql)','only forge publishes',
              '[{"redRole":"red-security","verdictId":"v1"},{"redRole":"red-wide","verdictId":"v2"}]',
              'untriaged', NULL, NULL, '2026-07-30T00:00:00Z','2026-07-30T00:00:00Z');
    INSERT INTO review_findings (id, review_id, ordinal, finding_ref, summary, severity, sources_json,
                                 disposition, decided_by, resolution, created_at, updated_at)
      VALUES ('review-a/RF-2','review-a',2,'RF-2','a nit','low','[]','fix_now','orchestrator','resolved',
              '2026-07-30T00:00:00Z','2026-07-30T00:00:00Z');
    INSERT INTO review_findings (id, review_id, ordinal, finding_ref, summary, sources_json, disposition,
                                 created_at, updated_at)
      VALUES ('review-b/RF-1','review-b',1,'RF-1','b finding','[]','accepted_risk',
              '2026-07-30T00:00:00Z','2026-07-30T00:00:00Z');
  `);
  db.close();
}

test("reviewLedger: reviews come back most-recently-updated first with their findings embedded", () => {
  const rows = reviewLedger();
  assert.deepEqual(rows.map((r) => r.id), ["review-a", "review-b"]);
  assert.deepEqual(rows[0]!.findings.map((f) => f.findingRef), ["RF-1", "RF-2"]);
  assert.equal(rows[1]!.findings.length, 1);
});

test("reviewLedger: the four SHAs, lenses and mode are projected for the summary block", () => {
  const [a] = reviewLedger();
  assert.equal(a!.baseSha, "base0");
  assert.equal(a!.contractConfirmedSha, "conf0");
  assert.equal(a!.candidateSha, "cand0");
  assert.equal(a!.trustedRemoteSha, "rem0");
  assert.deepEqual(a!.riskLenses, ["wide", "security"]);
  assert.equal(a!.reviewMode, "evidence_led");
  assert.equal(a!.state, "awaiting_disposition");
});

test("reviewLedger: counts by disposition and by resolution are computed per review", () => {
  const [a, b] = reviewLedger();
  assert.deepEqual(a!.countsByDisposition, { untriaged: 1, fix_now: 1 });
  assert.deepEqual(a!.countsByResolution, { unresolved: 1, resolved: 1 });
  assert.deepEqual(b!.countsByDisposition, { accepted_risk: 1 });
});

test("reviewLedger: every source survives to the read surface", () => {
  const [a] = reviewLedger();
  const rf1 = a!.findings[0]!;
  assert.equal(rf1.sources.length, 2);
  assert.deepEqual(rf1.sources.map((s) => s.redRole), ["red-security", "red-wide"]);
  assert.equal(rf1.invariantRef, "only forge publishes");
  assert.equal(rf1.line, 42);
});

test("reviewLedger: a project scope narrows through the owning run", () => {
  assert.deepEqual(reviewLedger("/proj/b").map((r) => r.id), ["review-b"]);
  assert.deepEqual(reviewLedger(["/proj/a", "/proj/b"]).map((r) => r.id), ["review-a", "review-b"]);
  assert.deepEqual(reviewLedger("/proj/nowhere"), []);
});

test("reviewLedger: the limit bounds reviews, not findings", () => {
  const rows = reviewLedger(undefined, 1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.findings.length, 2);
});
