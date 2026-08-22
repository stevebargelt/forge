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
    CREATE TABLE runs (id TEXT, project_dir TEXT, project_identity TEXT);
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
