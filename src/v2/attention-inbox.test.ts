// FG-820: the server-computed `counts` on the inbox envelope, the core derivation's
// degraded/run-scope handling, and the `forge attention list` human render.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  composeInbox,
  deriveAttentionInbox,
  inboxCounts,
  renderAttentionInboxLines,
  type AttentionInboxReaders,
  type AttentionItem,
  type AttentionItemKind,
  type InboxScope,
} from "./attention-inbox.js";

const UNSCOPED: InboxScope = { runId: null, projectDirs: null };
const AT = "2026-09-28T12:00:00.000Z";

function item(over: Partial<AttentionItem> & { id: string; kind: AttentionItemKind }): AttentionItem {
  return {
    severity: "medium",
    startedAt: AT,
    reason: "reason",
    requestedAction: "do the thing",
    openState: "open",
    source: "task",
    links: { runId: null, taskId: null, ticketId: null, campaignId: null, itemId: null, projectDir: null, projectLabel: null },
    ...over,
  };
}

function withRun(runId: string, over: Partial<AttentionItem> & { id: string; kind: AttentionItemKind }): AttentionItem {
  const base = item(over);
  return { ...base, links: { ...base.links, runId } };
}

function readers(over: Partial<AttentionInboxReaders> = {}): AttentionInboxReaders {
  return {
    operatorWaits: () => ({ operatorWaits: [], ciWaits: [] }),
    failures: () => [],
    readiness: () => ({ items: [], degraded: [] }),
    staleVerifications: () => [],
    openKanbanConflicts: () => [],
    dismissals: () => [],
    ...over,
  };
}

function quietly<T>(fn: () => T): T {
  const original = console.error;
  console.error = () => {};
  try {
    return fn();
  } finally {
    console.error = original;
  }
}

describe("inboxCounts / composeInbox counts", () => {
  test("empty inbox counts zero and is the calm empty state", () => {
    const env = composeInbox([[], []], { generatedAt: AT, scope: UNSCOPED });
    assert.deepEqual(env.counts, { open: 0, high: 0 });
    assert.equal(env.empty, true);
  });

  test("open counts every item, high counts only severity high (null and low excluded)", () => {
    assert.deepEqual(
      inboxCounts([
        item({ id: "a", kind: "auth_setup", severity: "high" }),
        item({ id: "b", kind: "waiting_gate", severity: "medium" }),
        item({ id: "c", kind: "waiting_gate", severity: "low" }),
        item({ id: "d", kind: "waiting_gate", severity: null }),
        item({ id: "e", kind: "merge_conflict", severity: "high" }),
      ]),
      { open: 5, high: 2 },
    );
  });

  test("counts are taken AFTER dedup: two reasons on one run count as one open item", () => {
    const env = composeInbox(
      [
        [withRun("run-1", { id: "task:t1", kind: "blocked_by_red_or_reviewer", severity: "high" })],
        [withRun("run-1", { id: "review:r1", kind: "waiting_gate", severity: "high" })],
        [item({ id: "gap:1", kind: "missing_acceptance_or_readiness", severity: "medium" })],
      ],
      { generatedAt: AT, scope: UNSCOPED },
    );
    assert.equal(env.items.length, 2);
    assert.deepEqual(env.counts, { open: 2, high: 1 });
  });

  test("a degraded zero-item envelope counts zero but is NOT empty", () => {
    const env = composeInbox([[]], { generatedAt: AT, scope: UNSCOPED, degraded: ["failures"] });
    assert.deepEqual(env.counts, { open: 0, high: 0 });
    assert.equal(env.empty, false);
    assert.deepEqual(env.degraded, ["failures"]);
  });

  test("a degraded envelope with items counts only the items the healthy sources returned", () => {
    const env = composeInbox([[item({ id: "a", kind: "auth_setup", severity: "high" })]], {
      generatedAt: AT,
      scope: UNSCOPED,
      degraded: ["readiness"],
    });
    assert.deepEqual(env.counts, { open: 1, high: 1 });
    assert.equal(env.empty, false);
  });
});

describe("deriveAttentionInbox", () => {
  test("a throwing reader names itself in degraded and the rest still count", () => {
    const env = quietly(() =>
      deriveAttentionInbox(
        readers({
          failures: () => [item({ id: "task:t1", kind: "auth_setup", severity: "high" })],
          staleVerifications: () => {
            throw new Error("no such table: events");
          },
          openKanbanConflicts: () => {
            throw new Error("no such table: kanban_conflicts");
          },
        }),
        { generatedAt: AT, scope: UNSCOPED },
      ),
    );
    assert.deepEqual(env.degraded, ["verification", "kanban_conflicts"]);
    assert.deepEqual(env.counts, { open: 1, high: 1 });
    assert.equal(env.empty, false);
  });

  test("readiness sub-source markers pass through once each", () => {
    const env = deriveAttentionInbox(readers({ readiness: () => ({ items: [], degraded: ["review", "review"] }) }), {
      generatedAt: AT,
      scope: UNSCOPED,
    });
    assert.deepEqual(env.degraded, ["review"]);
    assert.deepEqual(env.counts, { open: 0, high: 0 });
  });

  test("every reader healthy and silent is the calm empty inbox", () => {
    const env = deriveAttentionInbox(readers(), { generatedAt: AT, scope: UNSCOPED });
    assert.equal(env.empty, true);
    assert.deepEqual(env.counts, { open: 0, high: 0 });
  });

  test("scope.runId narrows items to that run, and counts follow the narrowed items", () => {
    const env = deriveAttentionInbox(
      readers({
        failures: () => [
          withRun("run-a", { id: "task:a", kind: "auth_setup", severity: "high" }),
          withRun("run-b", { id: "task:b", kind: "merge_conflict", severity: "high" }),
          item({ id: "gap:1", kind: "missing_acceptance_or_readiness" }),
        ],
      }),
      { generatedAt: AT, scope: { runId: "run-a", projectDirs: null } },
    );
    assert.deepEqual(
      env.items.map((i) => i.id),
      ["task:a"],
    );
    assert.deepEqual(env.scope, { runId: "run-a", projectDirs: null });
    assert.deepEqual(env.counts, { open: 1, high: 1 });
  });
});

describe("renderAttentionInboxLines", () => {
  test("a table of kind/severity/reason/action with a totals footer from counts", () => {
    const env = composeInbox(
      [[item({ id: "a", kind: "auth_setup", severity: "high", reason: "auth\nmissing", requestedAction: "run forge auth" })]],
      { generatedAt: AT, scope: UNSCOPED },
    );
    const lines = renderAttentionInboxLines(env);
    assert.match(lines[0]!, /^KIND\s+SEVERITY\s+REASON\s+REQUESTED ACTION$/);
    assert.match(lines[1]!, /^auth_setup\s+high\s+auth missing\s+run forge auth$/);
    assert.equal(lines.at(-1), "1 open · 1 high");
  });

  test("empty and degraded footers say which they are", () => {
    assert.deepEqual(renderAttentionInboxLines(composeInbox([], { generatedAt: AT, scope: UNSCOPED })), [
      "No attention items — no action needed.",
      "",
      "0 open · 0 high",
    ]);
    const degraded = renderAttentionInboxLines(composeInbox([], { generatedAt: AT, scope: UNSCOPED, degraded: ["waits"] }));
    assert.equal(degraded[0], "No attention items read.");
    assert.equal(degraded.at(-1), "0 open · 0 high · degraded: waits (partial read)");
  });

  test("long reasons are clamped to one compact cell", () => {
    const env = composeInbox([[item({ id: "a", kind: "waiting_gate", reason: "x".repeat(200) })]], {
      generatedAt: AT,
      scope: UNSCOPED,
    });
    const row = renderAttentionInboxLines(env)[1]!;
    assert.ok(row.includes(`${"x".repeat(71)}…`));
    assert.ok(!row.includes("x".repeat(72)));
  });
});
