// FG-638 — the read surface at the real process boundary.
//
// Two things only a spawned CLI can prove, and both are operator-facing:
//
//   AGREEMENT. `forge review show --json` and `forge review show` are run as separate
//   processes against the same store, and the JSON's values must be present in the
//   human text. The exhaustive field classification lives in the unit tier
//   (fg638-review-show-parity.test.ts, which can see the projection); what this adds
//   is that both renderings survive serialization, argv parsing and a real on-disk
//   read — an operator switching between them gets one answer, not two.
//
//   THE LOOKUP REFUSALS. A missing review, an unknown finding id and an ambiguous
//   bare RF-n each have to exit NON-ZERO with a message naming what to do about it,
//   and write nothing. In-process assertions cannot see an exit code, and the
//   ambiguity path only exists because a bare RF-n is review-scoped — so it needs two
//   reviews in one real store to fire at all.
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
import { NODE_EXEC as tsx, BUILT_CLI_ENTRY as entry } from "../../integration-cli-spawn.js";

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

/** Every findings row, whole. The refusal tests compare this before and after. */
function allFindingRows(): unknown[] {
  const db = openStore();
  try {
    return db.prepare(`SELECT * FROM review_findings ORDER BY id`).all();
  } finally {
    db.close();
  }
}

function countDispositionEvents(): number {
  const db = openStore();
  try {
    return (
      db.prepare(`SELECT COUNT(*) AS n FROM events WHERE event_type = 'review.finding_dispositioned'`).get() as { n: number }
    ).n;
  } finally {
    db.close();
  }
}

// Review fields the human render must carry. Kept short and explicit here; the
// exhaustive classification (including the deliberate --json-only set) is unit-tier.
const REVIEW_FIELDS = ["id", "runId", "ticketId", "baseSha", "contractConfirmedSha", "candidateSha", "trustedRemoteSha", "reviewMode", "state"] as const;
const FINDING_FIELDS = ["id", "findingRef", "summary", "severity", "riskLens", "disposition"] as const;

before(() => {
  homeDir = mkdtempSync(join(tmpdir(), "forge-fg638-read-"));
  const db = openStore();
  db.exec(SCHEMA_SQL);
  db.prepare(`INSERT INTO runs (id, workflow, title, status, created_at, review_mode) VALUES (?, ?, ?, ?, ?, ?)`).run(
    "run-read",
    "feature",
    "read surface",
    "active",
    "2026-07-30T00:00:00Z",
    "evidence_led",
  );

  const insertReview = db.prepare(
    `INSERT INTO reviews (id, run_id, subject_task_id, ticket_id, base_sha, contract_confirmed_sha, candidate_sha,
                          trusted_remote_sha, contract_json, review_mode, state, created_at, updated_at)
     VALUES (?, 'run-read', 'task-read-subject', ?, 'basesha0000', 'confsha1111', 'candsha2222', 'remotesha33', ?, 'evidence_led', ?, ?, ?)`,
  );
  insertReview.run("review-read-a", "FG-638", JSON.stringify({ risk_lenses: ["wide", "security"], lens_scopes: { wide: ["src/"], security: ["src/util/creds.ts"] } }), "awaiting_disposition", "2026-07-30T00:00:00Z", "2026-07-30T00:00:00Z");
  // A SECOND review carrying its own RF-1 — the only way the bare-ref ambiguity
  // refusal can fire.
  insertReview.run("review-read-b", "FG-700", JSON.stringify({ risk_lenses: ["backend"], lens_scopes: { backend: ["src/store/"] } }), "discovering", "2026-07-30T00:01:00Z", "2026-07-30T00:01:00Z");

  const insertFinding = db.prepare(
    `INSERT INTO review_findings (id, review_id, ordinal, finding_ref, summary, severity, risk_lens, reachability,
                                  file, line, quoted_text, acceptance_ref, invariant_ref, sources_json, disposition,
                                  created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'untriaged', '2026-07-30T00:00:00Z', '2026-07-30T00:00:00Z')`,
  );
  insertFinding.run(
    "review-read-a/RF-1",
    "review-read-a",
    1,
    "RF-1",
    "unauthenticated write path on the admin route",
    "high",
    "security",
    "demonstrated",
    "src/routes/admin.ts",
    4242,
    "app.post('/admin'",
    "AC-7",
    "INV-14",
    JSON.stringify([{ redRole: "red-security", verdictId: "verdict-sec-1" }, { redRole: "red-wide", verdictId: "verdict-wide-2" }]),
  );
  insertFinding.run(
    "review-read-a/RF-2",
    "review-read-a",
    2,
    "RF-2",
    "a slow query on the dashboard poll",
    "low",
    "backend",
    "speculative",
    null,
    null,
    null,
    null,
    null,
    JSON.stringify([{ modelFindingId: "MODEL-SUPPLIED-77" }]),
  );
  insertFinding.run(
    "review-read-b/RF-1",
    "review-read-b",
    1,
    "RF-1",
    "the other review's first finding",
    "medium",
    "backend",
    null,
    null,
    null,
    null,
    null,
    null,
    "[]",
  );
  db.close();
});

after(() => {
  rmSync(homeDir, { recursive: true, force: true });
});

test("integ FG-638: `forge review show --json` and the human render agree, field by field, across two real processes", () => {
  const asJson = runForge(["review", "show", "review-read-a", "--json"]);
  assert.equal(asJson.status, 0, asJson.stderr);
  const human = runForge(["review", "show", "review-read-a"]);
  assert.equal(human.status, 0, human.stderr);

  const summary = JSON.parse(asJson.stdout) as {
    review: Record<string, unknown>;
    findings: Record<string, unknown>[];
    countsByDisposition: Record<string, number>;
    countsByResolution: Record<string, number>;
    riskLenses: string[];
    unsettledCount: number;
  };

  for (const field of REVIEW_FIELDS) {
    const value = summary.review[field];
    assert.ok(value !== undefined, `--json omitted review.${field}`);
    assert.ok(human.stdout.includes(String(value)), `the human render omits review.${field} (${String(value)}) that --json carries`);
  }

  assert.deepEqual(summary.findings.map((f) => f.findingRef), ["RF-1", "RF-2"], "both findings must reach the JSON surface, in ordinal order");
  for (const finding of summary.findings) {
    for (const field of FINDING_FIELDS) {
      const value = finding[field];
      if (value === undefined || value === null) continue;
      assert.ok(
        human.stdout.includes(String(value)),
        `the human render omits ${String(finding.findingRef)}.${field} (${String(value)}) that --json carries`,
      );
    }
  }

  // Provenance and the summary block survive both surfaces.
  assert.equal((summary.findings[0]?.sources as unknown[]).length, 2);
  assert.match(human.stdout, /sources: red-security \(verdict-sec-1\), red-wide \(verdict-wide-2\)/);
  assert.deepEqual(summary.riskLenses, ["wide", "security"]);
  for (const lens of summary.riskLenses) assert.ok(human.stdout.includes(lens));
  assert.deepEqual(summary.countsByDisposition, { untriaged: 2 });
  assert.match(human.stdout, /dispositions:\s+untriaged 2/);
  assert.equal(summary.unsettledCount, 2);
  assert.match(human.stdout, /unsettled findings: 2/);

  // The JSON surface is exactly one JSON document on stdout — pipeable, as the
  // store: banner convention requires (banners go to stderr).
  assert.doesNotThrow(() => JSON.parse(asJson.stdout));
});

test("integ FG-638: a review id that does not exist exits non-zero and names it", () => {
  const r = runForge(["review", "show", "review-does-not-exist"]);
  assert.notEqual(r.status, 0, "a missing review must not exit 0 with empty output");
  assert.match(`${r.stdout}${r.stderr}`, /review-does-not-exist/);
  assert.match(`${r.stdout}${r.stderr}`, /not found/i);
});

test("integ FG-638: an unknown finding id is refused by name, exits 1, and writes nothing", () => {
  const before = allFindingRows();
  const beforeEvents = countDispositionEvents();

  const r = runForge(["review", "disposition", "review-read-a/RF-99", "fix_now", "--rationale", "fix it"]);

  assert.equal(r.status, 1);
  assert.match(r.stderr, /no finding review-read-a\/RF-99/);
  assert.match(r.stderr, /Nothing was written/);
  assert.deepEqual(allFindingRows(), before, "a lookup refusal must leave every row untouched");
  assert.equal(countDispositionEvents(), beforeEvents);
});

test("integ FG-638: a bare RF-n matching two reviews refuses with both candidates and the fix, and writes nothing", () => {
  const before = allFindingRows();
  const beforeEvents = countDispositionEvents();

  const r = runForge(["review", "disposition", "RF-1", "fix_now", "--rationale", "fix it"]);

  assert.equal(r.status, 1);
  assert.match(r.stderr, /matches 2 findings/);
  // Both candidates named, so the operator can pick without another command.
  assert.match(r.stderr, /review-read-a\/RF-1/);
  assert.match(r.stderr, /review-read-b\/RF-1/);
  assert.match(r.stderr, /--review <review-id>/);
  assert.match(r.stderr, /Nothing was written/);
  assert.deepEqual(allFindingRows(), before, "an ambiguous ref must never be resolved by guessing");
  assert.equal(countDispositionEvents(), beforeEvents);

  // Scoped with --review, the same bare ref resolves — the ambiguity was the only
  // problem, and the refusal named the remedy that works.
  const scoped = runForge(["review", "disposition", "RF-1", "fix_now", "--rationale", "fix it", "--review", "review-read-b"]);
  assert.equal(scoped.status, 0, scoped.stderr);
  assert.match(scoped.stdout, /RF-1 \(review-read-b\/RF-1\): fix_now — decided by orchestrator/);
  assert.equal(countDispositionEvents(), beforeEvents + 1);
});

test("integ FG-638: an out-of-vocabulary decision is refused before any lookup, exits 1, and writes nothing", () => {
  const before = allFindingRows();
  const beforeEvents = countDispositionEvents();

  const r = runForge(["review", "disposition", "review-read-a/RF-1", "wont_fix", "--rationale", "we are not doing it"]);

  assert.equal(r.status, 1);
  assert.match(r.stderr, /decision must be one of/);
  assert.match(r.stderr, /Nothing was written/);
  assert.deepEqual(allFindingRows(), before);
  assert.equal(countDispositionEvents(), beforeEvents, "a rejected vocabulary word must not reach the event log either");
});
