// FG-823: the client half of dismiss/snooze, as data — the request each choice sends, the
// command previewed before Confirm, the `dismissed` section's validation (a malformed one
// is a failed read, never a quietly-empty disclosure), and the held-item summary.

import { test } from "node:test";
import assert from "node:assert/strict";
import { SNOOZE_PRESETS, attentionCommand, attentionRequest, attentionResult, attentionRoute } from "../client/attention-dismiss-render.js";
import { INBOX_EMPTY_LABEL, dismissedSummary, inboxFromBody, inboxHeldLabel, inboxView, isAttentionInboxPayload } from "../client/attention-inbox-render.js";

const ITEM = {
  id: "task:task-1",
  kind: "auth_setup",
  severity: "high",
  startedAt: "2026-09-29T08:00:00.000Z",
  reason: "auth expired",
  requestedAction: "refresh the session",
  openState: "open",
  source: "task",
  links: { runId: "run-1", taskId: "task-1", ticketId: null, campaignId: null, itemId: null, projectDir: null, projectLabel: null },
};

const HELD = {
  item: ITEM,
  dismissal: { itemKey: "task:task-1", state: "snoozed", dismissedAt: "2026-09-29T09:00:00.000Z", snoozeUntil: "2026-09-29T13:00:00.000Z", actor: "dashboard", rationale: "after lunch" },
};

function envelope(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { generatedAt: "t", scope: { runId: null, projectDirs: null }, items: [], empty: true, degraded: [], counts: { open: 0, high: 0 }, dismissed: [HELD], ...over };
}

test("FG-823: each choice builds its route and body; the item id is path-encoded", () => {
  assert.deepEqual([...SNOOZE_PRESETS], ["1h", "4h", "1d"]);
  assert.equal(attentionRoute("wait:gate:r/1", "dismiss"), "/api/attention/wait%3Agate%3Ar%2F1/dismiss");
  assert.deepEqual(attentionRequest("task:t", "dismiss"), { ok: true, route: "/api/attention/task%3At/dismiss", body: {} });
  assert.deepEqual(attentionRequest("task:t", "dismiss", { rationale: "known" }).ok && attentionRequest("task:t", "dismiss", { rationale: "known" }), {
    ok: true, route: "/api/attention/task%3At/dismiss", body: { rationale: "known" },
  });
  assert.deepEqual(attentionRequest("task:t", "snooze", { until: "4h" }), { ok: true, route: "/api/attention/task%3At/snooze", body: { until: "4h" } });
  assert.deepEqual(attentionRequest("task:t", "snooze", { until: " 2026-10-01T09:00:00Z " }).ok, true);
  assert.deepEqual(attentionRequest("task:t", "undismiss", { rationale: "ignored" }), { ok: true, route: "/api/attention/task%3At/undismiss", body: {} });
});

test("FG-823: a snooze needs a length — a preset or an ISO time — before it can be sent", () => {
  assert.equal(attentionRequest("task:t", "snooze").ok, false);
  assert.equal(attentionRequest("task:t", "snooze", { until: "tomorrow" }).ok, false);
  assert.equal(attentionRequest("task:t", "snooze", { until: "3h" }).ok, false, "only the presets are offered as durations");
});

test("FG-823: the preview is the command the route runs", () => {
  assert.equal(attentionCommand("task:t", "dismiss"), "forge attention dismiss task:t");
  assert.equal(attentionCommand("task:t", "snooze"), "forge attention snooze task:t --until <until>");
  assert.equal(attentionCommand("task:t", "snooze", "1d"), "forge attention snooze task:t --until 1d");
  assert.equal(attentionCommand("task:t", "undismiss"), "forge attention undismiss task:t");
});

test("FG-823: the verb's result reads back exit status, refusal and output", () => {
  assert.deepEqual(attentionResult(200, { ok: true, exitCode: 0, stdout: "dismissed task:t" }, "forge attention dismiss task:t"), {
    ok: true, line: "forge attention dismiss task:t exited 0", detail: "dismissed task:t",
  });
  assert.deepEqual(attentionResult(409, { ok: false, exitCode: 1, error: "already dismissed" }, "c"), { ok: false, line: "c exited 1", detail: "already dismissed" });
  assert.deepEqual(attentionResult(403, { ok: false, error: "bound to 0.0.0.0" }, "c"), { ok: false, line: "c was refused (HTTP 403)", detail: "bound to 0.0.0.0" });
});

test("FG-823: the dismissed section is validated like items; absent reads as none held", () => {
  assert.equal(isAttentionInboxPayload(envelope()), true);
  const { dismissed: _gone, ...older } = envelope();
  assert.equal(isAttentionInboxPayload(older), true, "a server predating FG-823 is still readable");
  for (const bad of [null, [null], [{ item: ITEM }], [{ item: {}, dismissal: HELD.dismissal }], [{ item: ITEM, dismissal: { ...HELD.dismissal, state: "hidden" } }]]) {
    assert.equal(isAttentionInboxPayload(envelope({ dismissed: bad })), false, JSON.stringify(bad));
  }
});

test("FG-823: the view carries held items for the disclosure, never in `items`, and an all-held inbox names its held count", () => {
  const view = inboxView(inboxFromBody(envelope()));
  assert.equal(view.phase, "ready");
  assert.deepEqual(view.items, []);
  assert.equal(view.empty, true);
  assert.equal(view.message, "No open items — 1 held (dismissed or snoozed)");
  assert.equal(view.message, inboxHeldLabel(1));
  assert.notEqual(view.message, INBOX_EMPTY_LABEL, "held items still want the operator: never the calm no-action copy");
  assert.equal(inboxView(inboxFromBody(envelope({ dismissed: [] }))).message, INBOX_EMPTY_LABEL);
  assert.equal(view.dismissed.length, 1);
  const summary = dismissedSummary(HELD as never);
  assert.equal(summary.id, "task:task-1");
  assert.equal(summary.holdState, "snoozed");
  assert.equal(summary.holdLabel, "Snoozed by dashboard until 2026-09-29T13:00:00.000Z — or until it shows new activity");
  assert.equal(summary.rationale, "after lunch");
  const dismissed = dismissedSummary({ ...HELD, dismissal: { ...HELD.dismissal, state: "dismissed", snoozeUntil: null, rationale: null } } as never);
  assert.equal(dismissed.holdLabel, "Dismissed by dashboard — returns when it shows new activity");
  assert.equal(dismissed.rationale, null);
});
