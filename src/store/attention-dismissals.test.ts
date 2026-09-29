// FG-823: the attention_dismissals accessor — its vocabulary, the one-active-row index,
// the paired events rows, and that settling marks rows rather than deleting them. Real
// store code against an in-memory SQLite DB; the fresh-vs-migrated parity for the table
// lives in fg608-migration-parity.test.ts beside every other table's.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "./db.js";
import {
  ATTENTION_DISMISSAL_STATES,
  AttentionDismissalConflict,
  activeAttentionDismissals,
  attentionDismissalHistory,
  clearAttentionDismissal,
  isAttentionItemKey,
  parseSnoozeUntil,
  recordAttentionDismissal,
  settleAttentionDismissals,
  type RecordDismissalInput,
} from "./attention-dismissals.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
});

const AT = "2026-09-29T09:00:00.000Z";

function input(over: Partial<RecordDismissalInput> = {}): RecordDismissalInput {
  return { itemKey: "task:task-1", kind: "auth_setup", projectKey: "pk", runId: "run-1", actor: "steve", rationale: "known", snoozeUntil: null, at: AT, ...over };
}

function events(): Array<{ event_type: string; run_id: string | null; payload: Record<string, unknown> }> {
  return (db.prepare(`SELECT event_type, run_id, payload FROM events ORDER BY id`).all() as Array<{ event_type: string; run_id: string | null; payload: string }>)
    .map((e) => ({ ...e, payload: JSON.parse(e.payload) as Record<string, unknown> }));
}

function rowCount(): number {
  return (db.prepare(`SELECT COUNT(*) AS c FROM attention_dismissals`).get() as { c: number }).c;
}

describe("vocabulary", () => {
  test("the row states are a closed list the accessor owns", () => {
    assert.deepEqual([...ATTENTION_DISMISSAL_STATES], ["active", "superseded", "expired", "cleared"]);
  });

  test("an item key is a source prefix and an id — never a flag, whitespace or a control byte", () => {
    for (const ok of ["task:task-1", "wait:gate:run-1:task-2", "ci-wait:ciwait-abc", "kanban_conflict:c1", "readiness:FG-12"]) {
      assert.equal(isAttentionItemKey(ok), true, ok);
    }
    for (const bad of ["-rf", "--force", "task:", "task: x", "TASK:x", "task:a\nb", "", "nocolon"]) {
      assert.equal(isAttentionItemKey(bad), false, JSON.stringify(bad));
    }
  });

  test("--until takes a duration or a future ISO instant within a year", () => {
    const now = Date.parse(AT);
    assert.deepEqual(parseSnoozeUntil("1h", now), { ok: true, until: "2026-09-29T10:00:00.000Z" });
    assert.deepEqual(parseSnoozeUntil("4h", now), { ok: true, until: "2026-09-29T13:00:00.000Z" });
    assert.deepEqual(parseSnoozeUntil("1d", now), { ok: true, until: "2026-09-30T09:00:00.000Z" });
    assert.deepEqual(parseSnoozeUntil("2026-10-01T00:00:00Z", now), { ok: true, until: "2026-10-01T00:00:00.000Z" });
    for (const bad of ["0h", "1y", "soon", "2026-09-29T08:00:00Z", "2028-01-01T00:00:00Z", "-1h"]) {
      assert.equal(parseSnoozeUntil(bad, now).ok, false, bad);
    }
  });
});

describe("writes", () => {
  test("a dismissal writes the row and its attention.dismissed event together", () => {
    const row = recordAttentionDismissal(input());
    assert.equal(row.state, "active");
    assert.deepEqual(activeAttentionDismissals().map((r) => r.id), [row.id]);
    const [event] = events();
    assert.equal(event!.event_type, "attention.dismissed");
    assert.equal(event!.run_id, "run-1");
    assert.equal(event!.payload["itemKey"], "task:task-1");
    assert.equal(event!.payload["actor"], "steve");
    assert.equal(event!.payload["rationale"], "known");
  });

  test("a snooze is recorded as attention.snoozed with its re-arm instant", () => {
    recordAttentionDismissal(input({ snoozeUntil: "2026-09-29T10:00:00.000Z", rationale: null }));
    const [event] = events();
    assert.equal(event!.event_type, "attention.snoozed");
    assert.equal(event!.payload["snoozeUntil"], "2026-09-29T10:00:00.000Z");
  });

  test("a second live row for the same item is refused — by the accessor, and by the partial unique index beneath it", () => {
    recordAttentionDismissal(input());
    assert.throws(() => recordAttentionDismissal(input({ snoozeUntil: "2026-09-29T10:00:00.000Z" })), AttentionDismissalConflict);
    assert.equal(rowCount(), 1);
    assert.equal(events().length, 1, "a refused write records no event");
    assert.throws(
      () =>
        db.prepare(
          `INSERT INTO attention_dismissals (id, item_key, kind, dismissed_at, actor, state, created_at) VALUES ('raw', 'task:task-1', 'auth_setup', ?, 'x', 'active', ?)`,
        ).run(AT, AT),
      /UNIQUE constraint failed/,
    );
    db.prepare(
      `INSERT INTO attention_dismissals (id, item_key, kind, dismissed_at, actor, state, created_at) VALUES ('old', 'task:task-1', 'auth_setup', ?, 'x', 'cleared', ?)`,
    ).run(AT, AT);
    assert.equal(rowCount(), 2, "the index is partial: settled rows for the item are unconstrained");
  });

  test("undismiss clears the active row (kept, marked cleared) and records attention.undismissed", () => {
    const row = recordAttentionDismissal(input());
    const cleared = clearAttentionDismissal("task:task-1", "dashboard", "2026-09-29T09:05:00.000Z");
    assert.equal(cleared!.id, row.id);
    assert.equal(cleared!.state, "cleared");
    assert.deepEqual(activeAttentionDismissals(), []);
    assert.deepEqual(attentionDismissalHistory("task:task-1").map((r) => [r.state, r.settledAt]), [["cleared", "2026-09-29T09:05:00.000Z"]]);
    assert.equal(events()[1]!.event_type, "attention.undismissed");
    assert.equal(events()[1]!.payload["clearedBy"], "dashboard");
    assert.equal(clearAttentionDismissal("task:task-1", "dashboard", AT), null, "nothing active is nothing to clear");
    recordAttentionDismissal(input({ at: "2026-09-29T09:10:00.000Z" }));
    assert.equal(rowCount(), 2, "once cleared, the item can be dismissed again");
  });

  test("settling marks superseded/expired rows, never deletes them, and is a no-op on replay", () => {
    const a = recordAttentionDismissal(input());
    const b = recordAttentionDismissal(input({ itemKey: "wait:gate:x", snoozeUntil: "2026-09-29T10:00:00.000Z" }));
    const lapses = [{ id: a.id, state: "superseded" as const }, { id: b.id, state: "expired" as const }];
    assert.equal(settleAttentionDismissals(lapses, "2026-09-29T11:00:00.000Z"), 2);
    assert.equal(settleAttentionDismissals(lapses, "2026-09-29T12:00:00.000Z"), 0);
    assert.equal(rowCount(), 2);
    assert.deepEqual(attentionDismissalHistory("task:task-1").map((r) => r.state), ["superseded"]);
    assert.deepEqual(attentionDismissalHistory("wait:gate:x").map((r) => r.state), ["expired"]);
    assert.deepEqual(events().map((e) => e.event_type), ["attention.dismissed", "attention.snoozed", "attention.dismissal_superseded", "attention.snooze_expired"]);
  });

  test("a resurfaced item is re-dismissed in one transaction: the lapse is settled first", () => {
    const first = recordAttentionDismissal(input());
    const second = recordAttentionDismissal(input({ at: "2026-09-29T10:00:00.000Z" }), [{ id: first.id, state: "superseded" }]);
    assert.deepEqual(attentionDismissalHistory("task:task-1").map((r) => [r.id, r.state]), [[first.id, "superseded"], [second.id, "active"]]);
  });
});

test("a read-only store that predates the table reads as no dismissals", () => {
  const aged = new Database(":memory:");
  aged.exec(`CREATE TABLE runs (id TEXT PRIMARY KEY)`);
  assert.deepEqual(activeAttentionDismissals(aged), []);
  aged.close();
});
