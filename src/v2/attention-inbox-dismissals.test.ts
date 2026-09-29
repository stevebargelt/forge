// FG-823: dismissal and snooze in the ONE inbox derivation — exclusion while a dismissal
// holds, resurfacing when the item's activity advances past it, snooze expiry, counts
// computed after exclusion, and lapses reported (for the writer to mark) rather than
// dropped or deleted.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  applyDismissals,
  composeInbox,
  deriveAttentionInbox,
  renderAttentionInboxLines,
  type AttentionInboxReaders,
  type AttentionItem,
  type AttentionItemKind,
  type InboxScope,
} from "./attention-inbox.js";
import type { AttentionDismissal } from "../store/attention-dismissals.js";

const UNSCOPED: InboxScope = { runId: null, projectDirs: null };
const STARTED = "2026-09-29T08:00:00.000Z";
const DISMISSED = "2026-09-29T09:00:00.000Z";
const NOW = "2026-09-29T09:30:00.000Z";

function item(id: string, kind: AttentionItemKind = "auth_setup", over: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id,
    kind,
    severity: "high",
    startedAt: STARTED,
    reason: `reason ${id}`,
    requestedAction: "act",
    openState: "open",
    source: "task",
    links: { runId: null, taskId: null, ticketId: null, campaignId: null, itemId: null, projectDir: null, projectLabel: null },
    ...over,
  };
}

function dismissal(itemKey: string, over: Partial<AttentionDismissal> = {}): AttentionDismissal {
  return {
    id: `d-${itemKey}`,
    itemKey,
    kind: "auth_setup",
    projectKey: null,
    runId: null,
    dismissedAt: DISMISSED,
    snoozeUntil: null,
    actor: "steve",
    rationale: "known flake",
    state: "active",
    settledAt: null,
    createdAt: DISMISSED,
    ...over,
  };
}

describe("applyDismissals", () => {
  test("a dismissal holds while the item's activity has not advanced past it", () => {
    const out = applyDismissals([item("task:a"), item("task:b")], [dismissal("task:a")], NOW);
    assert.deepEqual(out.kept.map((i) => i.id), ["task:b"]);
    assert.deepEqual(out.dismissed.map((d) => [d.item.id, d.dismissal.state, d.dismissal.actor]), [["task:a", "dismissed", "steve"]]);
    assert.deepEqual(out.lapsed, []);
  });

  test("activity equal to the dismissal instant still holds; an unknown startedAt cannot advance", () => {
    const out = applyDismissals(
      [item("task:a", "auth_setup", { startedAt: DISMISSED }), item("task:b", "auth_setup", { startedAt: null })],
      [dismissal("task:a"), dismissal("task:b")],
      NOW,
    );
    assert.deepEqual(out.kept, []);
    assert.equal(out.dismissed.length, 2);
  });

  test("new activity on the same source resurfaces the item and reports the row superseded", () => {
    const out = applyDismissals([item("task:a", "auth_setup", { startedAt: "2026-09-29T09:10:00.000Z" })], [dismissal("task:a")], NOW);
    assert.deepEqual(out.kept.map((i) => i.id), ["task:a"]);
    assert.deepEqual(out.dismissed, []);
    assert.deepEqual(out.lapsed, [{ id: "d-task:a", itemKey: "task:a", state: "superseded" }]);
  });

  test("a snooze holds until its instant, then reports itself expired and the item returns", () => {
    const snooze = dismissal("task:a", { snoozeUntil: "2026-09-29T10:00:00.000Z" });
    const before = applyDismissals([item("task:a")], [snooze], NOW);
    assert.deepEqual(before.dismissed.map((d) => [d.dismissal.state, d.dismissal.snoozeUntil]), [["snoozed", "2026-09-29T10:00:00.000Z"]]);
    const after = applyDismissals([item("task:a")], [snooze], "2026-09-29T10:00:00.000Z");
    assert.deepEqual(after.kept.map((i) => i.id), ["task:a"]);
    assert.deepEqual(after.lapsed, [{ id: "d-task:a", itemKey: "task:a", state: "expired" }]);
  });

  test("a snooze whose item is gone still expires; a dismissal whose item is gone is left alone", () => {
    const out = applyDismissals([], [dismissal("task:gone"), dismissal("task:snoozed", { snoozeUntil: "2026-09-29T09:00:00.000Z" })], NOW);
    assert.deepEqual(out.lapsed, [{ id: "d-task:snoozed", itemKey: "task:snoozed", state: "expired" }]);
  });

  test("it is pure: the input rows are never mutated or removed", () => {
    const rows = [dismissal("task:a")];
    const frozen = JSON.stringify(rows);
    applyDismissals([item("task:a", "auth_setup", { startedAt: "2026-09-29T09:10:00.000Z" })], rows, NOW);
    assert.equal(JSON.stringify(rows), frozen);
  });
});

describe("composeInbox with dismissals", () => {
  test("counts are computed after exclusion, and the held items go to `dismissed`, never `items`", () => {
    const env = composeInbox(
      [[item("task:a"), item("task:b", "waiting_gate", { severity: "medium" })]],
      { generatedAt: NOW, scope: UNSCOPED, dismissals: [dismissal("task:a")] },
    );
    assert.deepEqual(env.items.map((i) => i.id), ["task:b"]);
    assert.deepEqual(env.counts, { open: 1, high: 0 });
    assert.deepEqual(env.dismissed.map((d) => d.item.id), ["task:a"]);
  });

  test("an inbox whose every item is dismissed is empty — and still lists what it holds", () => {
    const env = composeInbox([[item("task:a")]], { generatedAt: NOW, scope: UNSCOPED, dismissals: [dismissal("task:a")] });
    assert.equal(env.empty, true);
    assert.deepEqual(env.counts, { open: 0, high: 0 });
    assert.equal(env.dismissed.length, 1);
  });

  test("exclusion runs after dedup: dismissing a run's row does not surface the row it absorbed", () => {
    const withRun = (id: string, kind: AttentionItemKind) => item(id, kind, { links: { ...item(id).links, runId: "run-1" } });
    const env = composeInbox(
      [[withRun("task:red", "blocked_by_red_or_reviewer"), withRun("wait:gate", "waiting_gate")]],
      { generatedAt: NOW, scope: UNSCOPED, dismissals: [dismissal("task:red")] },
    );
    assert.deepEqual(env.items, []);
    assert.deepEqual(env.dismissed.map((d) => d.item.id), ["task:red"]);
  });

  test("with no dismissals the envelope carries an empty dismissed section", () => {
    assert.deepEqual(composeInbox([[item("task:a")]], { generatedAt: NOW, scope: UNSCOPED }).dismissed, []);
  });
});

describe("deriveAttentionInbox dismissals reader", () => {
  const readers = (over: Partial<AttentionInboxReaders>): AttentionInboxReaders => ({
    operatorWaits: () => ({ operatorWaits: [], ciWaits: [] }),
    failures: () => [item("task:a"), item("task:b")],
    readiness: () => ({ items: [], degraded: [] }),
    staleVerifications: () => [],
    openKanbanConflicts: () => [],
    dismissals: () => [dismissal("task:a")],
    ...over,
  });

  test("the reader's rows are applied", () => {
    const env = deriveAttentionInbox(readers({}), { generatedAt: NOW, scope: UNSCOPED });
    assert.deepEqual(env.items.map((i) => i.id), ["task:b"]);
    assert.deepEqual(env.counts, { open: 1, high: 1 });
  });

  test("a failed dismissals read excludes nothing and names itself degraded", () => {
    const original = console.error;
    console.error = () => {};
    try {
      const env = deriveAttentionInbox(readers({ dismissals: () => { throw new Error("disk I/O error"); } }), { generatedAt: NOW, scope: UNSCOPED });
      assert.deepEqual(env.items.map((i) => i.id), ["task:a", "task:b"]);
      assert.deepEqual(env.degraded, ["dismissals"]);
      assert.deepEqual(env.dismissed, []);
    } finally {
      console.error = original;
    }
  });
});

describe("renderAttentionInboxLines", () => {
  const env = composeInbox([[item("task:a"), item("task:b")]], {
    generatedAt: NOW,
    scope: UNSCOPED,
    dismissals: [dismissal("task:a", { snoozeUntil: "2026-09-29T10:00:00.000Z" })],
  });

  test("by default the footer counts the held items and points at --include-dismissed", () => {
    const lines = renderAttentionInboxLines(env);
    assert.equal(lines.at(-1), "1 open · 1 high · 1 dismissed (--include-dismissed to list)");
    assert.ok(!lines.some((l) => l.startsWith("Dismissed")));
  });

  test("--include-dismissed lists each held item with its dismissal state", () => {
    const lines = renderAttentionInboxLines(env, { includeDismissed: true });
    const at = lines.indexOf("Dismissed (1):");
    assert.ok(at > 0);
    assert.match(lines[at + 1]!, /^task:a +auth_setup +snoozed until 2026-09-29T10:00:00.000Z +by steve +known flake$/);
    assert.equal(lines.at(-1), "1 open · 1 high");
  });
});
