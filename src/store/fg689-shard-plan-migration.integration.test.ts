// FG-689 — `reviews.shard_plan_json` against a REAL pre-change database, and the
// CROSS-PROCESS proof that this ticket's new writers of `lens_outcomes_json` do not lose
// each other's records.
//
// WHY THE MIGRATION HALF. `applyMigrations` runs on EVERY forge process's next DB open on
// this host, so a shard-plan column that is non-additive, non-nullable or non-idempotent
// breaks every already-installed forge — including the ones not running FG-689's code. The
// fg621-base-sha-migration.integration.test.ts precedent: build the pre-change shape on
// disk, open it through the production getDb() path, and assert the column lands, the rows
// survive, and a legacy row reads back `shardPlan === undefined` rather than null.
//
// WHY THE CONCURRENCY HALF, in a separate tier from the unit tests. better-sqlite3
// serializes transactions on ONE connection and SQLite treats BEGIN IMMEDIATE as BEGIN when
// no other connection exists — so the locking that makes a read-modify-write on
// `lens_outcomes_json` atomic is INERT in the unit tier, and a green single-process run is
// not evidence about it. Sharding is what makes this sharp: the column's record count goes
// from one-per-lens to lenses x shards, and its writers become concurrent with EACH OTHER
// (a shard outcome and a skip record land in the same window) rather than only with an
// operator verb. So two REAL OS processes are lined up on a file barrier against one DB.
//
// AND WHY THE MUTANT. A green race with no falsification cannot distinguish "the read is
// inside the write lock" from "the race never opened". The `mutant` driver mode takes its
// read OUTSIDE the lock — which is what these writers degenerate to if anyone moves the
// `getReview` call above `writeTransaction` — and is DEMONSTRATED to lose records first.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { getDb, applyMigrations, closeDb } from "./db.js";
import {
  getReview,
  insertReview,
  lensOutcomeRecordsOf,
  lensSkipRecordsOf,
  recordShardPlan,
  type ShardPlan,
} from "./reviews.js";
import { insertRun } from "./runs.js";
import { DB_PATH } from "../util/paths.js";

const STORE_DIR = dirname(fileURLToPath(import.meta.url));

// A PRE-FG-689 `reviews` table: production's shape at the commit before this ticket —
// FG-649's workspace_dir is present, shard_plan_json is not. This is exactly what a
// database written by any currently installed forge on the host looks like.
const LEGACY_DDL = `
CREATE TABLE runs (
  id              TEXT PRIMARY KEY,
  workflow        TEXT NOT NULL,
  title           TEXT NOT NULL,
  status          TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  completed_at    TEXT,
  metadata        TEXT,
  project_dir     TEXT,
  review_mode     TEXT NOT NULL DEFAULT 'legacy_verdict'
);
CREATE TABLE reviews (
  id                     TEXT PRIMARY KEY,
  run_id                 TEXT,
  subject_task_id        TEXT,
  ticket_id              TEXT,
  base_sha               TEXT,
  contract_confirmed_sha TEXT,
  candidate_sha          TEXT,
  trusted_remote_sha     TEXT,
  contract_json          TEXT,
  lens_outcomes_json     TEXT,
  workspace_dir          TEXT,
  stage_evidence_json    TEXT,
  review_mode            TEXT NOT NULL DEFAULT 'evidence_led',
  state                  TEXT NOT NULL DEFAULT 'confirming_contract',
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  settled_at             TEXT
);
`;

const LEGACY_RUN = "run-fg689-legacy";
const LEGACY_REVIEW = "review-fg689-legacy";
// A legacy review that already carries reviewer-authored outcomes and an operator
// acceptance. The interesting row: if the migration recreated the table rather than
// altering it, this column is what would silently go missing.
const LEGACY_OUTCOMES = [
  { lens: "wide", role: "red-wide", complete: true, outcome: "pass", authored: true, findings: [] },
  {
    kind: "lens_acceptance",
    lens: "backend",
    missingEvidence: "the store layer",
    rationale: "accepted before FG-689 existed",
    candidateSha: "conf222",
    acceptedBy: "operator",
    acceptedAt: "2026-08-01T00:00:00Z",
  },
];

const DERIVATION = {
  baseSha: "base000",
  candidateSha: "conf222",
  renderingId: "fg689-pinned-v1",
  budget: 600_000,
  unit: "characters",
  envelopes: {},
  budgetValidatedRuntime: "codex-subscription",
  scopesDigest: "scopes-aaa",
};

function columnNames(db: Database.Database, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((c) => c.name);
}

function countRows(db: Database.Database, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

before(() => {
  assert.equal(existsSync(DB_PATH), false, "the harness must hand us a fresh FORGE_HOME with no DB yet");

  const legacy = new Database(DB_PATH);
  legacy.pragma("foreign_keys = ON");
  legacy.exec(LEGACY_DDL);

  assert.ok(
    !columnNames(legacy, "reviews").includes("shard_plan_json"),
    "precondition: the legacy reviews table must NOT have shard_plan_json, or this file proves nothing",
  );

  legacy
    .prepare(`INSERT INTO runs (id, workflow, title, status, created_at, review_mode) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(LEGACY_RUN, "feature", "a review recorded before FG-689", "active", "2026-08-01T00:00:00Z", "evidence_led");

  legacy
    .prepare(
      `INSERT INTO reviews (id, run_id, ticket_id, base_sha, contract_confirmed_sha, candidate_sha, contract_json,
                            lens_outcomes_json, workspace_dir, review_mode, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      LEGACY_REVIEW,
      LEGACY_RUN,
      "FG-640",
      "base000",
      "conf222",
      "conf222",
      JSON.stringify({ threat_model: "t", risk_lenses: ["wide", "backend"] }),
      JSON.stringify(LEGACY_OUTCOMES),
      "/home/op/proj",
      "evidence_led",
      "awaiting_disposition",
      "2026-08-01T00:00:00Z",
      "2026-08-01T00:00:00Z",
    );

  assert.equal(legacy.pragma("user_version", { simple: true }), 0, "legacy store starts at user_version 0");
  legacy.close();
});

// ─── the migration ──────────────────────────────────────────────────────────

test("FG-689 migration: opening a pre-change DB adds shard_plan_json additively and loses no data", () => {
  const db = getDb(); // the production open path: SCHEMA_SQL + applyMigrations

  const cols = columnNames(db, "reviews");
  assert.ok(cols.includes("shard_plan_json"), "shard_plan_json must be added on the ordinary open path");
  assert.equal(cols.filter((c) => c === "shard_plan_json").length, 1, "exactly one shard_plan_json column");

  for (const expected of ["lens_outcomes_json", "stage_evidence_json", "workspace_dir", "contract_json"]) {
    assert.ok(cols.includes(expected), `${expected} must survive the migration`);
  }

  assert.equal(countRows(db, "reviews"), 1, "the migration must not drop or duplicate review rows");

  // Nullable: the column arrives NULL on every existing row. A NOT NULL add would have
  // thrown on a populated table; assert the VALUE, not just the shape.
  const row = db.prepare(`SELECT shard_plan_json, lens_outcomes_json FROM reviews WHERE id = ?`).get(LEGACY_REVIEW) as {
    shard_plan_json: string | null;
    lens_outcomes_json: string;
  };
  assert.equal(row.shard_plan_json, null, "nothing invents a plan for a review that never recorded one");
  assert.deepEqual(
    JSON.parse(row.lens_outcomes_json),
    LEGACY_OUTCOMES,
    "the table was ALTERED, not recreated — a legacy review's outcomes and acceptances survive untouched",
  );

  assert.equal(db.pragma("user_version", { simple: true }), 0, "no destructive boundary crossed — user_version stays 0");
});

test("FG-689 migration: a legacy row reads back with shardPlan undefined, not null", () => {
  getDb();
  const review = getReview(LEGACY_REVIEW);
  assert.ok(review, "the legacy row must still be readable");
  assert.equal(review!.shardPlan, undefined, "a pre-FG-689 row is owed nothing, and surfaces as undefined");
  // `undefined` specifically: every consumer reads optional fields with `?? ` / `if (x)`
  // semantics, and a null leaking through the row mapper is the shape that survives those
  // checks and fails later — here, as a gate reading an empty plan as "nothing expected".
  assert.ok(!("shardPlan" in review! && review!.shardPlan === null), "shardPlan must never surface as null");
  assert.equal(review!.workspaceDir, "/home/op/proj", "and the FG-649 binding it already carried is intact");
  assert.equal(lensOutcomeRecordsOf(review!).length, 1, "as are its reviewer-authored outcomes");
});

test("FG-689 migration: a recorded shard plan round-trips across a real close/reopen", () => {
  getDb();
  const plan: Omit<ShardPlan, "recordedAt"> = {
    derivation: { ...DERIVATION },
    digest: "digest-durable",
    fanoutWidth: 4,
    lenses: [
      {
        lens: "wide",
        shards: [
          { index: 1, of: 2, paths: ["src/a.ts"], chars: 400_000 },
          { index: 2, of: 2, paths: ["src/b.ts"], chars: 350_000 },
        ],
      },
    ],
    skipped: [{ lens: "backend", reason: "zero_in_scope_paths" }],
  };
  recordShardPlan(LEGACY_REVIEW, plan);

  // The point of a COLUMN rather than in-memory state: the containers have not started
  // yet, and the process that plans them may not be the process that assesses them.
  closeDb();
  const reopened = getReview(LEGACY_REVIEW)?.shardPlan as ShardPlan;
  assert.equal(reopened.digest, "digest-durable");
  assert.deepEqual(reopened.derivation, DERIVATION, "including the budget AND the unit it is expressed in");
  assert.equal(reopened.lenses[0]?.shards.length, 2);
  assert.deepEqual(reopened.skipped, [{ lens: "backend", reason: "zero_in_scope_paths" }]);
});

test("FG-689 migration: re-running applyMigrations on the already-migrated DB is a no-op", () => {
  const db = getDb();

  // Every forge process on the host re-runs this on its next open. Twice more.
  applyMigrations(db);
  applyMigrations(db);

  assert.equal(columnNames(db, "reviews").filter((c) => c === "shard_plan_json").length, 1);
  assert.equal(countRows(db, "reviews"), 1, "no row churn on re-migration");
  assert.equal(db.pragma("user_version", { simple: true }), 0, "still no user_version bump");
  assert.equal(getReview(LEGACY_REVIEW)?.shardPlan?.digest, "digest-durable", "no data loss on re-migration");
});

// ─── the cross-process write race on lens_outcomes_json ─────────────────────

const RACE_REVIEW = "review-fg689-race";
// Raise to hammer it: FG689_ROUNDS=200 npm run test:integration. The mutant below loses a
// record on essentially every round, so 40 barrier-synchronized rounds is far past the
// point where a false green is plausible.
const ROUNDS = Number(process.env["FG689_ROUNDS"] ?? 40);

function writeDriver(dir: string): string {
  const path = join(dir, "lens-outcomes-driver.mjs");
  writeFileSync(
    path,
    `
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDb } from ${JSON.stringify(join(STORE_DIR, "db.ts"))};
import {
  getReview,
  mergeLensOutcomesByShard,
  recordLensSkipped,
} from ${JSON.stringify(join(STORE_DIR, "reviews.ts"))};

const [side, other, barrierDir, rounds, mode, reviewId] = process.argv.slice(2);
const n = Number(rounds);

getDb();

function rendezvous(phase, i) {
  writeFileSync(join(barrierDir, side + "-" + phase + "-" + i), "");
  const deadline = Date.now() + 60_000;
  while (!existsSync(join(barrierDir, other + "-" + phase + "-" + i))) {
    if (Date.now() > deadline) throw new Error(side + ": barrier timeout at " + phase + " " + i);
  }
}

/** Side a writes one shard OUTCOME; side b writes one intentionally-skipped record. Two
 *  different writers of the same column, which is exactly the pairing sharding creates. */
function mine(i) {
  return side === "a"
    ? { kind: "outcome", value: { lens: "wide", role: "red-wide", complete: true, outcome: "pass",
        authored: true, findings: [], shard: { index: i + 1, of: n }, derivationDigest: "digest-race" } }
    : { kind: "skip", value: { lens: "frontend", reason: "zero_in_scope_paths",
        derivationDigest: "digest-" + i, candidateSha: "conf222" } };
}

for (let i = 0; i < n; i++) {
  const record = mine(i);
  if (mode === "mutant") {
    // THE MUTANT: the read taken OUTSIDE the write lock. Both sides snapshot, then both
    // write from their snapshot — so the loser's write erases the winner's record. This is
    // what the writers degenerate to if the getReview call moves above writeTransaction.
    const snapshot = getReview(reviewId).lensOutcomes ?? [];
    rendezvous("read", i);
    const payload = record.kind === "outcome"
      ? record.value
      : { kind: "lens_skipped", ...record.value, at: new Date(0).toISOString() };
    getDb()
      .prepare("UPDATE reviews SET lens_outcomes_json = ? WHERE id = ?")
      .run(JSON.stringify([...snapshot, payload]), reviewId);
  } else {
    // Rendezvous BEFORE the call, so both processes enter their read->write window together.
    rendezvous("go", i);
    if (record.kind === "outcome") mergeLensOutcomesByShard(reviewId, [record.value]);
    else recordLensSkipped(reviewId, record.value);
  }
}
process.stdout.write(JSON.stringify({ side, wrote: n }) + "\\n");
process.exit(0);
`,
  );
  return path;
}

function runDriver(
  driver: string,
  side: string,
  other: string,
  barrierDir: string,
  mode: string,
  reviewId: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", driver, side, other, barrierDir, String(ROUNDS), mode, reviewId],
      { env: process.env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("exit", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    child.on("error", reject);
  });
}

function seedRaceReview(id: string): void {
  getDb();
  insertRun({
    id: `run-${id}`,
    workflow: "feature",
    title: "fg689 race",
    status: "active",
    createdAt: "2026-08-06T00:00:00Z",
    reviewMode: "evidence_led",
  });
  insertReview({
    id,
    runId: `run-${id}`,
    reviewMode: "evidence_led",
    baseSha: "base000",
    contractConfirmedSha: "conf222",
    candidateSha: "conf222",
    contract: {
      threat_model: "t",
      risk_lenses: ["wide", "backend"],
      lens_scopes: { wide: ["src/"], backend: ["src/store/"] },
    },
    state: "discovering",
  });
}

async function race(reviewId: string, mode: string): Promise<void> {
  const workdir = mkdtempSync(join(tmpdir(), `fg689-${mode}-`));
  const barrierDir = mkdtempSync(join(tmpdir(), `fg689-${mode}-barrier-`));
  try {
    const driver = writeDriver(workdir);
    const [a, b] = await Promise.all([
      runDriver(driver, "a", "b", barrierDir, mode, reviewId),
      runDriver(driver, "b", "a", barrierDir, mode, reviewId),
    ]);
    for (const [side, res] of [
      ["a", a],
      ["b", b],
    ] as const) {
      assert.doesNotMatch(res.stderr, /database is locked|SQLITE_BUSY/, `driver ${side} hit SQLITE_BUSY:\n${res.stderr}`);
      assert.equal(res.code, 0, `driver ${side} exited ${res.code}:\n${res.stderr}`);
    }
  } finally {
    rmSync(workdir, { recursive: true, force: true });
    rmSync(barrierDir, { recursive: true, force: true });
  }
}

test(
  "FG-689: two REAL processes writing lens_outcomes_json in the same window both survive",
  { timeout: 600_000 },
  async () => {
    // FIRST, the falsification. A read taken outside the write lock loses records under
    // exactly this contention — so the green assertion below is about the lock, not about a
    // race that never opened.
    const mutantReview = `${RACE_REVIEW}-mutant`;
    seedRaceReview(mutantReview);
    await race(mutantReview, "mutant");
    closeDb();
    const mutant = getReview(mutantReview);
    const mutantTotal = lensOutcomeRecordsOf(mutant!).length + lensSkipRecordsOf(mutant!).length;
    assert.ok(
      mutantTotal < ROUNDS * 2,
      `the read-outside-the-lock mutant kept all ${ROUNDS * 2} records — the race window never opened, so ` +
        `the green case below would prove nothing`,
    );

    // NOW the real writers, on a fresh review, under the same barrier.
    seedRaceReview(RACE_REVIEW);
    await race(RACE_REVIEW, "real");
    closeDb();

    const review = getReview(RACE_REVIEW);
    const outcomes = lensOutcomeRecordsOf(review!) as Array<{ shard: { index: number } }>;
    const skips = lensSkipRecordsOf(review!);

    assert.equal(
      outcomes.length,
      ROUNDS,
      "every shard outcome survived — a skip landing in the window must not erase reviewer-authored evidence",
    );
    assert.equal(
      skips.length,
      ROUNDS,
      "and every skip survived — a shard outcome landing in the window must not erase an intentional skip",
    );
    assert.deepEqual(
      outcomes.map((o) => o.shard.index).sort((x, y) => x - y),
      Array.from({ length: ROUNDS }, (_, i) => i + 1),
      "each shard exactly once: the merge key is the shard's identity, so nothing is duplicated either",
    );
    assert.equal(new Set(skips.map((s) => s.derivationDigest)).size, ROUNDS);
  },
);
