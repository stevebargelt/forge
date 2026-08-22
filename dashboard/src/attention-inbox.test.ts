// FG-402: the inbox CONTRACT + pure helpers — severity ordering, dedup by precedence,
// sort (severity-known-first → ordinal → age-desc), and compose into the envelope.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  composeInbox,
  dedupeAttentionItems,
  kindPrecedence,
  severityRank,
  sortAttentionItems,
  type AttentionItem,
  type AttentionItemKind,
  type AttentionSeverity,
} from "./attention-inbox.js";

function item(over: Partial<AttentionItem> & { id: string; kind: AttentionItemKind }): AttentionItem {
  return {
    severity: "medium",
    startedAt: "2026-08-22T12:00:00.000Z",
    reason: "reason",
    requestedAction: "do the thing",
    openState: "open",
    source: "task",
    links: { runId: null, taskId: null, ticketId: null, campaignId: null, itemId: null, projectDir: null, projectLabel: null },
    ...over,
  };
}

describe("severityRank — known first, then ordinal", () => {
  test("high < medium < low < unknown", () => {
    const order: (AttentionSeverity | null)[] = ["high", "medium", "low", null];
    for (let i = 1; i < order.length; i++) {
      assert.ok(severityRank(order[i - 1]!) < severityRank(order[i]!), `${order[i - 1]} ranks before ${order[i]}`);
    }
  });
});

describe("sortAttentionItems", () => {
  test("severity-known items sort ahead of unknown-severity items", () => {
    const items = [
      item({ id: "a", kind: "waiting_gate", severity: null }),
      item({ id: "b", kind: "waiting_gate", severity: "low" }),
    ];
    const sorted = sortAttentionItems(items);
    assert.equal(sorted[0]!.id, "b");
    assert.equal(sorted[1]!.id, "a");
  });

  test("within a severity, older (larger age) sorts first", () => {
    const items = [
      item({ id: "newer", kind: "waiting_gate", severity: "high", startedAt: "2026-08-22T12:00:00.000Z" }),
      item({ id: "older", kind: "waiting_gate", severity: "high", startedAt: "2026-08-20T12:00:00.000Z" }),
    ];
    const sorted = sortAttentionItems(items);
    assert.equal(sorted[0]!.id, "older", "age-descending: the oldest attention item is first");
  });

  test("higher severity outranks age", () => {
    const sorted = sortAttentionItems([
      item({ id: "old-low", kind: "waiting_gate", severity: "low", startedAt: "2020-01-01T00:00:00.000Z" }),
      item({ id: "new-high", kind: "auth_setup", severity: "high", startedAt: "2026-08-22T12:00:00.000Z" }),
    ]);
    assert.equal(sorted[0]!.id, "new-high");
  });

  test("is pure — does not mutate its input", () => {
    const input = [item({ id: "a", kind: "waiting_gate", severity: null }), item({ id: "b", kind: "waiting_gate", severity: "high" })];
    const snapshot = input.map((i) => i.id);
    sortAttentionItems(input);
    assert.deepEqual(input.map((i) => i.id), snapshot);
  });
});

describe("dedupeAttentionItems — one blocker, one row, by kind precedence", () => {
  test("two attention reasons on the same run collapse to the highest-precedence kind", () => {
    const runLink = { runId: "run-1", taskId: null, ticketId: null, campaignId: null, itemId: null, projectDir: null, projectLabel: null };
    const collapsed = dedupeAttentionItems([
      item({ id: "gate", kind: "waiting_gate", links: { ...runLink } }),
      item({ id: "red", kind: "blocked_by_red_or_reviewer", links: { ...runLink } }),
    ]);
    assert.equal(collapsed.length, 1);
    assert.equal(collapsed[0]!.kind, "blocked_by_red_or_reviewer", "the review block outranks the gate wait");
  });

  test("items on different runs do NOT collapse", () => {
    const collapsed = dedupeAttentionItems([
      item({ id: "a", kind: "waiting_gate", links: { runId: "run-1", taskId: null, ticketId: null, campaignId: null, itemId: null, projectDir: null, projectLabel: null } }),
      item({ id: "b", kind: "waiting_gate", links: { runId: "run-2", taskId: null, ticketId: null, campaignId: null, itemId: null, projectDir: null, projectLabel: null } }),
    ]);
    assert.equal(collapsed.length, 2);
  });

  test("run-less items collapse only when they share an id", () => {
    const collapsed = dedupeAttentionItems([
      item({ id: "readiness:FG-1", kind: "missing_acceptance_or_readiness" }),
      item({ id: "readiness:FG-2", kind: "missing_acceptance_or_readiness" }),
    ]);
    assert.equal(collapsed.length, 2, "two distinct tickets stay two rows");
  });

  test("kindPrecedence orders hard blocks ahead of soft waits", () => {
    assert.ok(kindPrecedence("blocked_by_red_or_reviewer") < kindPrecedence("waiting_gate"));
    assert.ok(kindPrecedence("merge_conflict") < kindPrecedence("missing_acceptance_or_readiness"));
  });
});

describe("composeInbox", () => {
  test("flattens, dedupes, sorts, and reports empty honestly", () => {
    const envelope = composeInbox([[], []], {
      generatedAt: "2026-08-22T12:00:00.000Z",
      scope: { runId: null, projectDirs: null },
    });
    assert.equal(envelope.empty, true);
    assert.deepEqual(envelope.items, []);
    assert.deepEqual(envelope.degraded, []);
    assert.equal(envelope.generatedAt, "2026-08-22T12:00:00.000Z");
  });

  test("carries items, preserves scope + degraded, and is non-empty when items exist", () => {
    const envelope = composeInbox(
      [[item({ id: "a", kind: "auth_setup", severity: "high" })], [item({ id: "b", kind: "waiting_gate", severity: "medium" })]],
      { generatedAt: "t", scope: { runId: null, projectDirs: ["/proj"] }, degraded: ["failures"] },
    );
    assert.equal(envelope.empty, false);
    assert.equal(envelope.items.length, 2);
    assert.equal(envelope.items[0]!.kind, "auth_setup", "high severity first");
    assert.deepEqual(envelope.scope.projectDirs, ["/proj"]);
    assert.deepEqual(envelope.degraded, ["failures"]);
  });

  test("collapses cross-source duplicates on the same run", () => {
    const runLink = { runId: "run-x", taskId: null, ticketId: null, campaignId: null, itemId: null, projectDir: null, projectLabel: null };
    const envelope = composeInbox(
      [
        [item({ id: "task:t1", kind: "blocked_by_red_or_reviewer", links: { ...runLink } })],
        [item({ id: "review:r1", kind: "blocked_by_red_or_reviewer", links: { ...runLink } })],
      ],
      { generatedAt: "t", scope: { runId: null, projectDirs: null } },
    );
    assert.equal(envelope.items.length, 1, "one underlying run → one row");
  });
});
