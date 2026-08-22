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
