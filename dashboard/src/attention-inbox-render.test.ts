// FG-402: the CLIENT render decisions + the view component. The load-bearing honesty
// property (mirrors FG-694's AC7): a failed/malformed read renders unavailable+Retry and
// NEVER the calm "no human action" empty copy.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { h } from "preact";
import {
  INBOX_EMPTY_LABEL,
  INBOX_UNAVAILABLE_LABEL,
  inboxItemBadge,
  inboxItemLink,
  inboxItemSummary,
  inboxFromBody,
  inboxPhase,
  inboxSeverityBadge,
  inboxView,
  isAttentionInboxPayload,
  isRenderableInboxItem,
} from "../client/attention-inbox-render.js";
import { AttentionInboxSection } from "../client/attention-inbox-view.js";
import type { AttentionItem, InboxEnvelope } from "../client/attention-inbox-render.js";

const NOW = new Date("2026-08-22T12:00:00.000Z").getTime();

type Vnode = { type: unknown; props: Record<string, unknown> } | string | number | null | undefined | boolean | Vnode[];

function textOf(node: Vnode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (typeof node === "string" || typeof node === "number") return String(node);
  const { type, props } = node;
  if (typeof type === "function") return textOf((type as (p: unknown) => Vnode)(props));
  return textOf(props.children as Vnode);
}

function makeItem(over: Partial<AttentionItem> & { id: string; kind: AttentionItem["kind"] }): AttentionItem {
  return {
    severity: "high",
    startedAt: "2026-08-22T11:00:00.000Z",
    reason: "reason",
    requestedAction: "do the thing",
    openState: "open",
    source: "task",
    links: { runId: null, taskId: null, ticketId: null, campaignId: null, itemId: null, projectDir: null, projectLabel: null },
    ...over,
  };
}

function envelope(items: AttentionItem[], over: Partial<InboxEnvelope> = {}): InboxEnvelope {
  return {
    generatedAt: "2026-08-22T12:00:00.000Z",
    scope: { runId: null, projectDirs: null },
    items,
    empty: items.length === 0,
    degraded: [],
    ...over,
  };
}

const ready = (items: AttentionItem[], over: Partial<InboxEnvelope> = {}) => ({ phase: "ready" as const, envelope: envelope(items, over) });

describe("inboxItemSummary — badge, severity, link per kind", () => {
  test("gate wait", () => {
    const s = inboxItemSummary(makeItem({ id: "wait:t1", kind: "waiting_gate", severity: "medium", links: { runId: "run-1", taskId: "t1", ticketId: "FG-100", campaignId: null, itemId: null, projectDir: null, projectLabel: "forge" } }));
    assert.equal(inboxItemBadge({ kind: "waiting_gate" }).label, "Waiting on gate");
    assert.equal(s.badgeClass, "inbox-kind-waiting_gate");
    assert.equal(s.severityLabel, "medium");
    assert.deepEqual(s.link, { hash: "#run-map/run-1", label: "Open run" });
  });

  test("reviewer/red block", () => {
    const s = inboxItemSummary(makeItem({ id: "review:r1", kind: "blocked_by_red_or_reviewer", links: { runId: "run-2", taskId: "t2", ticketId: "FG-200", campaignId: null, itemId: null, projectDir: null, projectLabel: null } }));
    assert.equal(s.badgeClass, "inbox-kind-blocked_by_red_or_reviewer");
    assert.equal(s.link!.hash, "#run-map/run-2");
  });

  test("missing acceptance criteria links to backlog", () => {
    const s = inboxItemSummary(makeItem({ id: "readiness:FG-9", kind: "missing_acceptance_or_readiness", severity: "medium", source: "readiness", links: { runId: null, taskId: null, ticketId: "FG-9", campaignId: null, itemId: null, projectDir: null, projectLabel: null } }));
    assert.deepEqual(s.link, { hash: "#backlog", label: "Open FG-9" });
  });

  test("auth/setup links to the control plane", () => {
    const s = inboxItemSummary(makeItem({ id: "task:t3", kind: "auth_setup" }));
    assert.deepEqual(s.link, { hash: "#control-plane", label: "Open control plane" });
  });

  test("campaign pause links to campaigns", () => {
    assert.deepEqual(inboxItemLink(makeItem({ id: "wait:i1", kind: "campaign_paused" })), { hash: "#campaigns", label: "Open campaigns" });
  });

  test("an unknown severity reads 'priority unknown', never fabricated", () => {
    assert.deepEqual(inboxSeverityBadge({ kind: "waiting_gate", severity: null }), { class: "inbox-sev-unknown", label: "priority unknown" });
  });
});

describe("inboxView — load states", () => {
  test("empty ready read renders the calm empty copy", () => {
    const view = inboxView(ready([]));
    assert.equal(view.phase, "ready");
    assert.equal(view.empty, true);
    assert.equal(view.message, INBOX_EMPTY_LABEL);
  });

  test("populated read carries item summaries", () => {
    const view = inboxView(ready([makeItem({ id: "task:t1", kind: "auth_setup" })]));
    assert.equal(view.empty, false);
    assert.equal(view.items.length, 1);
    assert.equal(view.items[0]!.badgeLabel, "Auth / setup");
  });

  test("a zero-item read with a degraded source is NOT the calm empty state", () => {
    const view = inboxView(ready([], { degraded: ["readiness"] }));
    assert.equal(view.phase, "ready");
    assert.equal(view.empty, false);
    assert.notEqual(view.message, INBOX_EMPTY_LABEL);
    assert.deepEqual(view.degraded, ["readiness"]);
  });

  test("an {error} body is unavailable, never an observed empty inbox", () => {
    assert.equal(isAttentionInboxPayload({ error: "old store" }), false);
    const load = inboxFromBody({ error: "old store" });
    assert.equal(inboxPhase(load), "unavailable");
    const view = inboxView(load);
    assert.equal(view.phase, "unavailable");
    assert.equal(view.empty, false);
    assert.notEqual(view.message, INBOX_EMPTY_LABEL);
    assert.equal(view.retry, true);
  });

  test("a malformed body (items with a null entry) is a FAILED read, never idle", () => {
    assert.equal(isRenderableInboxItem(null), false);
    assert.equal(isAttentionInboxPayload({ items: [null] }), false);
    assert.equal(inboxPhase(inboxFromBody({ items: [null] })), "unavailable");
  });

  test("an item missing its id (row key) rejects the whole payload", () => {
    assert.equal(isAttentionInboxPayload({ items: [{ kind: "waiting_gate" }] }), false);
  });

  // RF-2: an item that has only id+kind — no reason, requestedAction, or source — is
  // structurally incomplete. Accepting it renders a blank actionable row with its required
  // operator context silently blanked to ""; instead the whole read must resolve unavailable.
  test("a structurally incomplete item (id+kind only) is NOT renderable", () => {
    assert.equal(isRenderableInboxItem({ id: "x", kind: "auth_setup" }), false);
  });

  test("the finding's exact reproduction — {items:[{id,kind}]} — is a FAILED read, not a blank ready row", () => {
    const body = { items: [{ id: "x", kind: "auth_setup" }] };
    assert.equal(isAttentionInboxPayload(body), false);
    const load = inboxFromBody(body);
    assert.equal(inboxPhase(load), "unavailable");
    const view = inboxView(load);
    assert.equal(view.phase, "unavailable");
    assert.equal(view.empty, false);
    assert.notEqual(view.message, INBOX_EMPTY_LABEL);
  });

  test("an item missing only requestedAction/source still fails the read (each is required)", () => {
    assert.equal(isRenderableInboxItem({ id: "x", kind: "auth_setup", reason: "auth missing" }), false);
    assert.equal(
      isRenderableInboxItem({ id: "x", kind: "auth_setup", reason: "auth missing", requestedAction: "set it up" }),
      false,
    );
    assert.equal(
      isRenderableInboxItem({ id: "x", kind: "auth_setup", reason: "auth missing", requestedAction: "set it up", source: "task" }),
      true,
    );
  });
});

describe("AttentionInboxSection — rendered honesty", () => {
  test("the four item kinds render their badge, reason, action and link", () => {
    const items = [
      makeItem({ id: "wait:t1", kind: "waiting_gate", severity: "medium", reason: "human gate at step architect", requestedAction: "advance or reject the gate", links: { runId: "run-1", taskId: "t1", ticketId: "FG-100", campaignId: null, itemId: null, projectDir: null, projectLabel: "forge" } }),
      makeItem({ id: "task:t2", kind: "blocked_by_red_or_reviewer", reason: "a red review blocked this", requestedAction: "fix the finding", links: { runId: "run-2", taskId: "t2", ticketId: null, campaignId: null, itemId: null, projectDir: null, projectLabel: null } }),
      makeItem({ id: "readiness:FG-9", kind: "missing_acceptance_or_readiness", severity: "medium", reason: "acceptance criteria need refinement", requestedAction: "refine the ticket", source: "readiness", links: { runId: null, taskId: null, ticketId: "FG-9", campaignId: null, itemId: null, projectDir: null, projectLabel: null } }),
      makeItem({ id: "task:t4", kind: "auth_setup", reason: "auth was missing", requestedAction: "ensure the auth profile is set up" }),
    ];
    const text = textOf(h(AttentionInboxSection as never, { load: ready(items), now: NOW, onRetry: () => {} }) as unknown as Vnode);
    assert.match(text, /Waiting on gate/);
    assert.match(text, /Blocked by review/);
    assert.match(text, /Readiness gap/);
    assert.match(text, /Auth \/ setup/);
    assert.match(text, /advance or reject the gate/);
    assert.match(text, /acceptance criteria need refinement/);
    assert.match(text, /FG-100/);
  });

  test("the empty state renders 'No human action is currently needed'", () => {
    const text = textOf(h(AttentionInboxSection as never, { load: ready([]), now: NOW, onRetry: () => {} }) as unknown as Vnode);
    assert.match(text, new RegExp(INBOX_EMPTY_LABEL));
  });

  test("a partial-read failure (no items + degraded source) shows the warning, NOT the empty copy", () => {
    const load = ready([], { degraded: ["readiness"] });
    const text = textOf(h(AttentionInboxSection as never, { load, now: NOW, onRetry: () => {} }) as unknown as Vnode);
    assert.match(text, /Some sources could not be read: readiness\./);
    assert.doesNotMatch(text, new RegExp(INBOX_EMPTY_LABEL));
  });

  test("an unavailable read renders the unavailable banner, NOT the empty copy", () => {
    const load = inboxFromBody({ error: "old store" });
    const text = textOf(h(AttentionInboxSection as never, { load, now: NOW, onRetry: () => {} }) as unknown as Vnode);
    assert.match(text, new RegExp(INBOX_UNAVAILABLE_LABEL));
    assert.doesNotMatch(text, new RegExp(INBOX_EMPTY_LABEL));
  });
});
