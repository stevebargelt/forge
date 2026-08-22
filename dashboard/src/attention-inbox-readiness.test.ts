// FG-402 / RF-1: the readiness+review mapper reports a source-read FAILURE by name in
// `degraded` rather than swallowing it to an empty items array. The load-bearing property:
// a store that cannot answer a source (missing tables, or any read error) must degrade
// that source explicitly, so the inbox never renders a failed read as a calm empty
// "no action needed" state.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { readinessAttentionItems } from "./attention-inbox-readiness.js";

// The full, healthy set of tables both sub-reads touch — created empty, so a clean read
// finds nothing to act on and reports NO degradation.
function seedHealthyEmpty(db: Database.Database): void {
  db.exec(`
    CREATE TABLE tickets (project_key TEXT, ticket_id TEXT, status TEXT, body_hash TEXT, title TEXT);
    CREATE TABLE readiness_assessments (project_key TEXT, ticket_id TEXT, body_hash TEXT, outcome TEXT, gaps_json TEXT, evaluated_at TEXT);
    CREATE TABLE runs (id TEXT, project_dir TEXT, project_identity TEXT, status TEXT);
    CREATE TABLE reviews (id TEXT, run_id TEXT, subject_task_id TEXT, ticket_id TEXT, state TEXT, updated_at TEXT);
    CREATE TABLE review_findings (id TEXT, review_id TEXT, disposition TEXT, resolution TEXT);
  `);
}

describe("readinessAttentionItems — a source-read failure degrades by name, never to empty", () => {
  test("a store missing BOTH sources' tables degrades each by name, not a healthy empty", () => {
    const db = new Database(":memory:");
    const result = readinessAttentionItems(db, undefined, 0);
    assert.deepEqual(result.items, []);
    assert.deepEqual(
      [...result.degraded].sort(),
      ["readiness", "review"],
      "a total read failure must NAME both failed sources, never swallow to an undegraded empty",
    );
    db.close();
  });

  test("a store missing ONLY the reviews table degrades 'review' alone, not the whole mapper", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE tickets (project_key TEXT, ticket_id TEXT, status TEXT, body_hash TEXT, title TEXT);
      CREATE TABLE readiness_assessments (project_key TEXT, ticket_id TEXT, body_hash TEXT, outcome TEXT, gaps_json TEXT, evaluated_at TEXT);
    `);
    const result = readinessAttentionItems(db, undefined, 0);
    assert.deepEqual(result.items, []);
    assert.deepEqual(result.degraded, ["review"], "the readiness sub-read succeeds; only the review sub-read degrades");
    db.close();
  });

  test("a clean read with nothing to act on reports NO degradation (empty ≠ degraded)", () => {
    const db = new Database(":memory:");
    seedHealthyEmpty(db);
    const result = readinessAttentionItems(db, undefined, 0);
    assert.deepEqual(result.items, []);
    assert.deepEqual(result.degraded, [], "a successful empty read must NOT report degradation");
    db.close();
  });
});

// RF-1: the review source is bounded to live work — an OPEN review with an unresolved
// fix_now finding surfaces ONLY while its parent RUN is active. Once the run completes (or
// the review has no run at all), the item disappears with no stored resolution flag, so a
// review left in an open state on a finished run never lingers as false live work.
describe("readinessAttentionItems — a review item is bounded to its run being active (RF-1)", () => {
  function seedReviewWithFinding(db: Database.Database, runStatus: string | null): void {
    seedHealthyEmpty(db);
    if (runStatus !== null) {
      db.prepare("INSERT INTO runs (id, project_dir, project_identity, status) VALUES (?, ?, ?, ?)").run(
        "run-1",
        "/repo",
        "/repo",
        runStatus,
      );
    }
    db.prepare(
      "INSERT INTO reviews (id, run_id, subject_task_id, ticket_id, state, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("rev-1", runStatus === null ? null : "run-1", "task-1", "FG-1", "awaiting_disposition", "2026-08-22T00:00:00Z");
    db.prepare("INSERT INTO review_findings (id, review_id, disposition, resolution) VALUES (?, ?, ?, ?)").run(
      "f-1",
      "rev-1",
      "fix_now",
      null,
    );
  }

  test("an open fix_now review on an ACTIVE run surfaces as an inbox item", () => {
    const db = new Database(":memory:");
    seedReviewWithFinding(db, "active");
    const result = readinessAttentionItems(db, undefined, 0);
    assert.equal(result.items.length, 1, "an open review on a live run is live work");
    assert.equal(result.items[0]!.id, "review:rev-1");
    assert.deepEqual(result.degraded, []);
    db.close();
  });

  test("the SAME open review on a COMPLETED run no longer surfaces", () => {
    const db = new Database(":memory:");
    seedReviewWithFinding(db, "complete");
    const result = readinessAttentionItems(db, undefined, 0);
    assert.deepEqual(result.items, [], "a review whose run has completed is not live work");
    assert.deepEqual(result.degraded, [], "an out-of-scope run is a filter, not a read failure");
    db.close();
  });

  test("an open review with NO run at all carries no liveness signal and does not surface", () => {
    const db = new Database(":memory:");
    seedReviewWithFinding(db, null);
    const result = readinessAttentionItems(db, undefined, 0);
    assert.deepEqual(result.items, []);
    db.close();
  });
});

// FG-402 (CI dashboard_browser, PR #303): the readiness staleness filter matches
// ra.body_hash = t.body_hash to drop superseded assessments — but tickets.body_hash is a
// migration-added column absent from a minimal store (the browser-tier fixture seeds
// tickets WITHOUT it). Naming t.body_hash there throws `SqliteError: no such column`, which
// used to fail the readiness read and cascade into the Home browser tests. The staleness
// predicate is now guarded by hasColumn(db, "tickets", "body_hash").
describe("readinessAttentionItems — the staleness filter is guarded when tickets lacks body_hash (FG-402)", () => {
  // The healthy-empty schema minus tickets.body_hash — the browser-tier shape.
  function seedNoBodyHash(db: Database.Database): void {
    db.exec(`
      CREATE TABLE tickets (project_key TEXT, ticket_id TEXT, status TEXT, title TEXT);
      CREATE TABLE readiness_assessments (project_key TEXT, ticket_id TEXT, body_hash TEXT, outcome TEXT, gaps_json TEXT, evaluated_at TEXT);
      CREATE TABLE runs (id TEXT, project_dir TEXT, project_identity TEXT, status TEXT);
      CREATE TABLE reviews (id TEXT, run_id TEXT, subject_task_id TEXT, ticket_id TEXT, state TEXT, updated_at TEXT);
      CREATE TABLE review_findings (id TEXT, review_id TEXT, disposition TEXT, resolution TEXT);
    `);
  }

  test("a tickets table WITHOUT body_hash does not throw and returns the readiness item", () => {
    const db = new Database(":memory:");
    seedNoBodyHash(db);
    db.prepare("INSERT INTO tickets (project_key, ticket_id, status, title) VALUES (?, ?, ?, ?)").run(
      "pk",
      "FG-9",
      "active",
      "needs work",
    );
    db.prepare(
      "INSERT INTO readiness_assessments (project_key, ticket_id, body_hash, outcome, gaps_json, evaluated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("pk", "FG-9", "h-any", "needs_refinement", null, "2026-08-22T00:00:00Z");

    // Against the unguarded `ra.body_hash = t.body_hash` query this throws SqliteError and
    // degrades; with the hasColumn guard the staleness predicate is omitted and the item surfaces.
    const result = readinessAttentionItems(db, undefined, 0);
    assert.deepEqual(result.degraded, [], "a store without body_hash must NOT be a read failure");
    assert.equal(result.items.length, 1, "the assessment is treated as current when body_hash is absent");
    assert.equal(result.items[0]!.id, "readiness:FG-9");
    db.close();
  });

  test("WITH body_hash present, the staleness match still filters superseded assessments", () => {
    const db = new Database(":memory:");
    seedHealthyEmpty(db);
    // Current: assessment body_hash matches the ticket's — surfaces.
    db.prepare("INSERT INTO tickets (project_key, ticket_id, status, body_hash, title) VALUES (?, ?, ?, ?, ?)").run(
      "pk",
      "FG-current",
      "active",
      "h-current",
      "current",
    );
    db.prepare(
      "INSERT INTO readiness_assessments (project_key, ticket_id, body_hash, outcome, gaps_json, evaluated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("pk", "FG-current", "h-current", "needs_refinement", null, "2026-08-22T00:00:00Z");
    // Stale: the ticket has been edited since the assessment — its hash no longer matches, so
    // the assessment is superseded evidence and must be filtered out.
    db.prepare("INSERT INTO tickets (project_key, ticket_id, status, body_hash, title) VALUES (?, ?, ?, ?, ?)").run(
      "pk",
      "FG-stale",
      "active",
      "h-new",
      "stale",
    );
    db.prepare(
      "INSERT INTO readiness_assessments (project_key, ticket_id, body_hash, outcome, gaps_json, evaluated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("pk", "FG-stale", "h-old", "blocked", null, "2026-08-22T00:00:00Z");

    const result = readinessAttentionItems(db, undefined, 0);
    assert.deepEqual(result.degraded, []);
    assert.deepEqual(
      result.items.map((i) => i.id),
      ["readiness:FG-current"],
      "the current assessment surfaces; the superseded (stale body_hash) one is filtered",
    );
    db.close();
  });
});
