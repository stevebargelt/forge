// FG-638: the /api/reviews route end to end. Two properties matter here and
// neither is visible from the query layer alone: the scoped payload shape the
// client polls, and the refusal-to-die behavior on a store that predates the
// ledger tables — a dashboard panel must never take the page down.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_PORT = 18776;
const BASE = `http://127.0.0.1:${TEST_PORT}`;

const tmpHome = mkdtempSync(join(tmpdir(), "forge-reviews-rt-"));
process.env.FORGE_HOME = tmpHome;
process.env.PORT = String(TEST_PORT);
process.env.HOST = "127.0.0.1";

const db = new Database(join(tmpHome, "forge.db"));
db.exec(`
  CREATE TABLE runs (id TEXT PRIMARY KEY, title TEXT, workflow TEXT, project_dir TEXT, status TEXT, created_at TEXT, review_mode TEXT);
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

  INSERT INTO runs VALUES ('run-x','X','feature','/proj/x','active','2026-07-30T00:00:00Z','evidence_led');
  INSERT INTO reviews VALUES ('review-x','run-x','task-x','FG-638','base0','conf0','cand0','rem0',
    '{"risk_lenses":["security"]}', NULL, 'evidence_led','awaiting_disposition',
    '2026-07-30T00:00:00Z','2026-07-30T00:00:00Z', NULL);
  INSERT INTO review_findings (id, review_id, ordinal, finding_ref, summary, severity, risk_lens, sources_json,
                               disposition, created_at, updated_at)
    VALUES ('review-x/RF-1','review-x',1,'RF-1','unauthenticated write','high','security',
            '[{"redRole":"red-security","verdictId":"v1"}]','untriaged',
            '2026-07-30T00:00:00Z','2026-07-30T00:00:00Z');
`);
db.close();

const { server } = await import("./server.js");
after(() => {
  server.closeAllConnections?.();
  server.close();
});

test("integ GET /api/reviews returns the ledger with findings embedded", async () => {
  const res = await fetch(`${BASE}/api/reviews`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    reviews: { id: string; state: string; candidateSha: string; findings: { findingRef: string }[] }[];
  };
  assert.equal(body.reviews.length, 1);
  assert.equal(body.reviews[0]!.id, "review-x");
  assert.equal(body.reviews[0]!.state, "awaiting_disposition");
  assert.equal(body.reviews[0]!.candidateSha, "cand0");
  assert.deepEqual(body.reviews[0]!.findings.map((f) => f.findingRef), ["RF-1"]);
});

test("integ GET /api/reviews honors the project scope", async () => {
  const mine = (await (await fetch(`${BASE}/api/reviews?projectDir=/proj/x`)).json()) as { reviews: unknown[] };
  assert.equal(mine.reviews.length, 1);
  const other = (await (await fetch(`${BASE}/api/reviews?projectDir=/proj/other`)).json()) as { reviews: unknown[] };
  assert.equal(other.reviews.length, 0);
});
