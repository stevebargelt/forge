// FG-386: the /api/shipping-audit route end to end. Two properties the query layer
// cannot show on its own: the scoped payload shape the client polls, and the
// refuse-to-die behavior — a project resolves through the dashboard's own registry
// (a real git checkout + project_identity), and a store predating the evidence
// tables must keep the page up rather than take it down.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_PORT = 18781;
const BASE = `http://127.0.0.1:${TEST_PORT}`;

const tmpHome = mkdtempSync(join(tmpdir(), "forge-shipaudit-rt-"));
process.env.FORGE_HOME = tmpHome;
process.env.FORGE_PROJECT_SCAN_ROOTS = mkdtempSync(join(tmpdir(), "forge-shipaudit-scan-"));
process.env.PORT = String(TEST_PORT);
process.env.HOST = "127.0.0.1";

const { getDb, writeTransaction } = await import("../../src/store/db.js");
const { repositoryCheckoutIdentity } = await import("../../src/util/repository-identity.js");

const PK = "pk-shipaudit-rt";
const AT = "2026-08-16T09:00:00Z";

function fixtureCheckout(): string {
  const dir = mkdtempSync(join(tmpdir(), "forge-shipaudit-co-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["remote", "add", "origin", "git@github.com:stevebargelt/fg386-shipaudit.git"], { cwd: dir, stdio: "ignore" });
  return dir;
}
const dir = fixtureCheckout();

{
  writeTransaction(() => {
    getDb()
      .prepare(`INSERT INTO project_identity (project_key, repo_evidence_key, repo_evidence_source, created_at) VALUES (?,?,?,?)`)
      .run(PK, repositoryCheckoutIdentity(dir).key, "remote", AT);
    getDb()
      .prepare(`INSERT INTO runs (id, workflow, title, status, created_at, project_dir) VALUES (?,?,?,?,?,?)`)
      .run("run-shipaudit", "feature", "shipaudit fixture", "complete", AT, dir);

    getDb()
      .prepare(
        `INSERT INTO tickets (project_key, ticket_id, type, status, title, body, body_hash, imported_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(PK, "FG-386", "story", "active", "shipping audit", "body", "h386", AT);
    getDb()
      .prepare(
        `INSERT INTO readiness_assessments (project_key, ticket_id, body_hash, outcome, gaps_json, refinement_proposal, revision, evaluated_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(PK, "FG-386", "h386", "ready", "[]", null, 1, AT);
    getDb()
      .prepare(
        `INSERT INTO reviews (id, run_id, subject_task_id, ticket_id, base_sha, contract_confirmed_sha, candidate_sha,
                              trusted_remote_sha, contract_json, review_mode, state, created_at, updated_at, settled_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run("review-386", "run-shipaudit", "task-386", "FG-386", "base", "conf", "sha-386", "remote",
        '{"risk_lenses":["wide"]}', "evidence_led", "settled", AT, "2026-08-16T10:00:00Z", "2026-08-16T10:00:00Z");
    getDb()
      .prepare(
        `INSERT INTO host_verifications (ticket_id, project_dir, commit_sha, gate_name, command, exit_code, source, recorded_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run("FG-386", dir, "sha-386", "test:all", "npm run test:all", 0, "ci", "2026-08-16T10:05:00Z");
  });
}

const { server } = await import("./server.js");
after(() => {
  server.closeAllConnections?.();
  server.close();
});

async function waitForServer(ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      await fetch(`${BASE}/`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 40));
    }
  }
  throw new Error(`server on ${TEST_PORT} did not start`);
}
await waitForServer();

type AuditRow = {
  ticketId: string;
  status: string;
  readiness: { status: string } | null;
  review: { status: string; state: string; candidateSha: string } | null;
  shippingChecks: Array<{ gateName: string; status: string; source: string }>;
};
type Audit = { projectKey: string | null; rows: AuditRow[]; degraded: string[]; error?: string };

test("integ GET /api/shipping-audit projects the scoped per-ticket audit", async () => {
  const res = await fetch(`${BASE}/api/shipping-audit?projectDir=${encodeURIComponent(dir)}`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as Audit;
  assert.equal(body.error, undefined, `audit read failed: ${body.error ?? ""}`);
  assert.equal(body.projectKey, PK);
  const row = body.rows.find((r) => r.ticketId === "FG-386");
  assert.ok(row, "FG-386 must be projected");
  assert.equal(row.status, "passed");
  assert.equal(row.readiness?.status, "passed");
  assert.equal(row.review?.status, "passed");
  assert.equal(row.review?.candidateSha, "sha-386");
  assert.equal(row.shippingChecks.length, 1);
  assert.equal(row.shippingChecks[0]!.status, "passed");
});

test("integ GET /api/shipping-audit refuses an unresolved project by name, never a cross-project read", async () => {
  const body = (await (await fetch(`${BASE}/api/shipping-audit?projectDir=/definitely/not/a/checkout`)).json()) as Audit;
  assert.equal(body.projectKey, null);
  assert.deepEqual(body.rows, []);
});
