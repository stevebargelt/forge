// FG-638: the disposition CLI at the real process boundary.
//
// The unit tier drives the commander action in-process. This tier spawns the actual
// `forge` CLI against a real on-disk store, because the two claims that matter most
// are process-level: the authority refusal EXITS NON-ZERO, and it leaves the
// database exactly as it found it. An in-process assertion cannot see an exit code,
// and a mocked store cannot prove a file was not written.
//
// The child goes through the FG-645 authority testkit seam (docs/how-to-testing.md):
// without it, a spawned forge inherits this process's backlog-authority signals and
// every mutating verb refuses for the wrong reason.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SCHEMA_SQL } from "../../store/schema.js";
import { authorityTestkitEnv, withAuthorityTestkit } from "../../backlog/container-authority.testkit-spawn.js";

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, "..", "index.ts");
const localTsx = resolve(here, "..", "..", "..", "node_modules", ".bin", "tsx");
const tsx = existsSync(localTsx) ? localTsx : "tsx";

let homeDir: string;

function runForge(args: string[]) {
  return spawnSync(tsx, withAuthorityTestkit(entry, args), {
    cwd: homeDir,
    encoding: "utf8",
    env: { ...process.env, FORGE_HOME: homeDir, ...authorityTestkitEnv() },
  });
}

function openStore(): Database.Database {
  return new Database(join(homeDir, "forge.db"));
}

function findingRow(id: string): { disposition: string; decided_by: string | null; sources_json: string } {
  const db = openStore();
  try {
    return db.prepare(`SELECT disposition, decided_by, sources_json FROM review_findings WHERE id = ?`).get(id) as {
      disposition: string;
      decided_by: string | null;
      sources_json: string;
    };
  } finally {
    db.close();
  }
}

before(() => {
  homeDir = mkdtempSync(join(tmpdir(), "forge-fg638-cli-"));
  const db = openStore();
  db.exec(SCHEMA_SQL);
  db.prepare(
    `INSERT INTO runs (id, workflow, title, status, created_at, review_mode) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run("run-integ", "feature", "integ", "active", "2026-07-30T00:00:00Z", "evidence_led");
  db.prepare(
    `INSERT INTO reviews (id, run_id, ticket_id, base_sha, contract_confirmed_sha, candidate_sha,
                          trusted_remote_sha, contract_json, review_mode, state, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "review-integ",
    "run-integ",
    "FG-638",
    "base000",
    "conf222",
    "cand111",
    "rem333",
    JSON.stringify({ risk_lenses: ["security"] }),
    "evidence_led",
    "awaiting_disposition",
    "2026-07-30T00:00:00Z",
    "2026-07-30T00:00:00Z",
  );
  const insertFinding = db.prepare(
    `INSERT INTO review_findings (id, review_id, ordinal, finding_ref, summary, severity, risk_lens,
                                  sources_json, disposition, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'untriaged', ?, ?)`,
  );
  insertFinding.run(
    "review-integ/RF-1",
    "review-integ",
    1,
    "RF-1",
    "unauthenticated write path",
    "high",
    "security",
    JSON.stringify([{ redRole: "red-security", verdictId: "verdict-1" }]),
    "2026-07-30T00:00:00Z",
    "2026-07-30T00:00:00Z",
  );
  db.close();
});

after(() => {
  rmSync(homeDir, { recursive: true, force: true });
});

test("integ FG-638: `forge review show` renders the ledger from a real store", () => {
  const r = runForge(["review", "show", "review-integ"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Review review-integ/);
  assert.match(r.stdout, /candidate sha:\s+cand111/);
  assert.match(r.stdout, /RF-1 \[high\/security\] unauthenticated write path/);
  assert.match(r.stdout, /disposition: untriaged/);
});

test("integ FG-638: an authority-changing accepted_risk without --operator exits 1 and writes nothing", () => {
  const before = findingRow("review-integ/RF-1");
  const r = runForge([
    "review", "disposition", "review-integ/RF-1", "accepted_risk", "--rationale", "we accept it",
  ]);

  assert.equal(r.status, 1);
  assert.match(r.stderr, /requires operator authority/);
  assert.match(r.stderr, /Nothing was written/);
  assert.deepEqual(findingRow("review-integ/RF-1"), before, "the row must be untouched by a refusal");

  const db = openStore();
  const events = db
    .prepare(`SELECT COUNT(*) AS n FROM events WHERE event_type = 'review.finding_dispositioned'`)
    .get() as { n: number };
  db.close();
  assert.equal(events.n, 0);
});

test("integ FG-638: the same decision with --operator is recorded as the operator's", () => {
  const r = runForge([
    "review", "disposition", "RF-1", "accepted_risk",
    "--rationale", "the threat model excludes this", "--operator", "--review", "review-integ",
  ]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /accepted_risk — decided by operator/);

  const row = findingRow("review-integ/RF-1");
  assert.equal(row.disposition, "accepted_risk");
  assert.equal(row.decided_by, "operator");
});
