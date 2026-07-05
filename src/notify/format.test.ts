import { test } from "node:test";
import assert from "node:assert/strict";
import { formatRunNotification, formatGateNotification, formatDuration, subscribeRequestBody, subscribeConfirmedBody, unsubscribeBody } from "./format.js";
import type { Run } from "../types/index.js";

const RUN: Run = {
  id: "run-add-login-7c2a91",
  workflow: "feature",
  title: "add login",
  status: "complete",
  createdAt: "2026-05-25T12:00:00Z",
};

test("formatRunNotification: a clean completion is explicitly non-actionable (FG-464 'no action')", () => {
  const out = formatRunNotification(RUN, "complete", 14 * 60 * 1000 + 23 * 1000);
  assert.equal(out, 'forge: run-add-login-7c2a91 [complete] feature "add login" — 14m23s · no action');
});

test("formatRunNotification: failed state carries the inspect-failure action label (FG-464)", () => {
  const out = formatRunNotification({ ...RUN, status: "abandoned" }, "failed", 5 * 1000);
  assert.equal(out, 'forge: run-add-login-7c2a91 [failed] feature "add login" — 5s · inspect failure: failed');
});

test("formatRunNotification: folds failure_kind + inspect action + forge show into the completion notification (WALK-4 / FG-464)", () => {
  const out = formatRunNotification(RUN, "complete", 5 * 60 * 1000, { taskId: "task-engineer-abc123", failureKind: "result_malformed" });
  assert.equal(out, 'forge: run-add-login-7c2a91 [complete] feature "add login" — 5m0s · inspect failure: result_malformed → forge show task-engineer-abc123');
});

test("formatRunNotification: failure without a known kind still carries the inspect action + forge show command", () => {
  const out = formatRunNotification(RUN, "complete", undefined, { taskId: "task-x-1" });
  assert.equal(out, 'forge: run-add-login-7c2a91 [complete] feature "add login" — inspect failure: failed → forge show task-x-1');
});

test("formatRunNotification: blocked_by_red carries the review-red action label (FG-464)", () => {
  const out = formatRunNotification(RUN, "blocked_by_red", 60 * 1000);
  assert.equal(out, 'forge: run-add-login-7c2a91 [blocked_by_red] feature "add login" — 1m0s · review red');
});

test("formatRunNotification: blocked_by_red with the blocked task points at forge show (FG-464)", () => {
  const out = formatRunNotification(RUN, "blocked_by_red", 60 * 1000, { taskId: "task-red-wide-9f2" });
  assert.equal(out, 'forge: run-add-login-7c2a91 [blocked_by_red] feature "add login" — 1m0s · review red → forge show task-red-wide-9f2');
});

test("formatRunNotification: campaign/ticket context from run.metadata is surfaced (FG-464)", () => {
  const out = formatRunNotification({ ...RUN, metadata: { ticketId: "FG-462", campaignId: "camp-3a1b" } }, "complete", 8 * 60 * 1000);
  assert.equal(out, 'forge: FG-462 campaign camp-3a1b run-add-login-7c2a91 [complete] feature "add login" — 8m0s · no action');
});

test("formatRunNotification: project name AND all three context fields (ticket/campaign/item) render together (FG-464)", () => {
  // The real campaign path has a projectDir plus ticketId/campaignId/itemId on
  // run.metadata — exercise all three, the exact shape a campaign run produces.
  const out = formatRunNotification(
    { ...RUN, projectDir: "/Users/x/code/myapp", metadata: { ticketId: "FG-462", campaignId: "camp-3a1b", itemId: "citem-9f2" } },
    "complete", 8 * 60 * 1000,
  );
  assert.equal(out, 'forge: myapp: FG-462 campaign camp-3a1b item citem-9f2 run-add-login-7c2a91 [complete] feature "add login" — 8m0s · no action');
  assert.ok(out.length <= 160);
});

test("formatRunNotification: itemId renders even when it is the only context field available (FG-464 — item is a required part of the AC)", () => {
  const out = formatRunNotification({ ...RUN, metadata: { itemId: "citem-9f2" } }, "complete", 1000);
  assert.equal(out, 'forge: item citem-9f2 run-add-login-7c2a91 [complete] feature "add login" — 1s · no action');
});

test("formatRunNotification: omits duration but still states the action when not provided", () => {
  const out = formatRunNotification(RUN, "complete");
  assert.equal(out, 'forge: run-add-login-7c2a91 [complete] feature "add login" — no action');
});

test("formatRunNotification: truncates a long title to keep the SMS under 160 chars", () => {
  const longTitle = "a".repeat(300);
  const out = formatRunNotification({ ...RUN, title: longTitle }, "complete", 1000);
  assert.ok(out.length <= 160, `expected length <= 160, got ${out.length}`);
  assert.ok(out.endsWith('..." — 1s · no action'), `expected truncation marker, got: ${out}`);
  assert.ok(out.startsWith("forge: run-add-login-7c2a91 [complete] feature "));
});

test("formatRunNotification: handles a title containing double quotes without breaking the format", () => {
  const out = formatRunNotification(
    { ...RUN, title: 'add "OAuth" login' },
    "complete",
    1000,
  );
  // Double quotes inside the title get downgraded to singles so the outer quoting stays clean.
  assert.equal(out, `forge: run-add-login-7c2a91 [complete] feature "add 'OAuth' login" — 1s · no action`);
});

test("formatGateNotification: awaiting_gate carries the actionable forge gate command", () => {
  const out = formatGateNotification(RUN, "task-plan-ddc707", "plan");
  assert.match(out, /forge gate task-plan-ddc707/);
  assert.match(out, /plan gate/);
  assert.match(out, /"add login"/);
});

test("formatGateNotification: truncates a long title but keeps the command intact under 160 chars", () => {
  const longTitle = "x".repeat(300);
  const out = formatGateNotification({ ...RUN, title: longTitle }, "task-plan-ddc707", "plan");
  assert.ok(out.length <= 160, `expected <=160, got ${out.length}`);
  assert.match(out, /forge gate task-plan-ddc707$/); // the action survives truncation
  assert.match(out, /\.\.\."/); // title got ellipsized
});

test("formatRunNotification: leads with the project name when the run has a projectDir", () => {
  const out = formatRunNotification({ ...RUN, projectDir: "/Users/x/code/wnba-led-scoreboard" }, "complete", 1000);
  assert.equal(out, 'forge: wnba-led-scoreboard: run-add-login-7c2a91 [complete] feature "add login" — 1s · no action');
});

test("formatGateNotification: leads with the project name when the run has a projectDir", () => {
  const out = formatGateNotification({ ...RUN, projectDir: "/Users/x/code/wnba-led-scoreboard" }, "task-build-2ea3ee", "build");
  assert.match(out, /^forge: wnba-led-scoreboard: feature /);
  assert.match(out, /forge gate task-build-2ea3ee$/);
});

test("formatGateNotification: carries all three context fields (ticket/campaign/item) from run.metadata (FG-464 — the most actionable push must not drop them)", () => {
  const out = formatGateNotification(
    { ...RUN, projectDir: "/Users/x/code/myapp", metadata: { ticketId: "FG-462", campaignId: "camp-3a1b", itemId: "citem-9f2" } },
    "task-build-2ea3ee", "build",
  );
  // context sits after the project name, before the workflow — same order as run transitions
  assert.equal(out, 'forge: myapp: FG-462 campaign camp-3a1b item citem-9f2 feature "add login" — build gate: forge gate task-build-2ea3ee');
  assert.ok(out.length <= 160);
  assert.match(out, /forge gate task-build-2ea3ee$/, "the action survives");
});

test("formatGateNotification: the forge gate command survives even when project + full context overflow the budget (FG-464 truncation protection)", () => {
  // Realistic-worst case: a long project path plus all three context fields makes
  // the prefix huge. The title drops and the prefix is trimmed, but the actionable
  // `forge gate <task>` suffix must remain WHOLE and the output stays ≤ 160.
  const out = formatGateNotification(
    {
      ...RUN,
      title: "z".repeat(200),
      projectDir: "/Users/x/code/" + "a-very-long-monorepo-package-name".repeat(4),
      metadata: { ticketId: "FG-462", campaignId: "campaign-abcdef123456", itemId: "citem-abcdef123456" },
    },
    "task-red-wide-deadbeef", "verify",
  );
  assert.ok(out.length <= 160, `expected ≤160, got ${out.length}: ${out}`);
  assert.ok(out.endsWith("forge gate task-red-wide-deadbeef"), `the gate command must survive whole, got: ${out}`);
});

test("formatGateNotification: no metadata → no context segment (degrades cleanly)", () => {
  const out = formatGateNotification(RUN, "task-x-1", "plan");
  assert.equal(out, 'forge: feature "add login" — plan gate: forge gate task-x-1');
});

test("formatDuration: sub-minute returns just seconds", () => {
  assert.equal(formatDuration(500), "0s");
  assert.equal(formatDuration(45 * 1000), "45s");
});

test("formatDuration: under an hour returns MmSs", () => {
  assert.equal(formatDuration(60 * 1000), "1m0s");
  assert.equal(formatDuration(14 * 60 * 1000 + 23 * 1000), "14m23s");
});

test("formatDuration: an hour or more returns HhMmSs", () => {
  assert.equal(formatDuration(60 * 60 * 1000), "1h0m0s");
  assert.equal(formatDuration(2 * 60 * 60 * 1000 + 5 * 60 * 1000 + 30 * 1000), "2h5m30s");
});

test("formatDuration: clamps negative input to 0", () => {
  assert.equal(formatDuration(-1000), "0s");
});

test("subscribeRequestBody: includes code and STOP guidance; fits in one SMS segment", () => {
  const body = subscribeRequestBody("4827");
  assert.match(body, /forge notify confirm 4827/);
  assert.match(body, /Reply STOP to opt out/);
  assert.ok(body.length <= 160, `body too long: ${body.length}`);
});

test("subscribeConfirmedBody: includes STOP guidance; fits in one SMS segment", () => {
  const body = subscribeConfirmedBody();
  assert.match(body, /subscribed/);
  assert.match(body, /Reply STOP to opt out/);
  assert.ok(body.length <= 160);
});

test("unsubscribeBody: confirms unsubscribe; fits in one SMS segment", () => {
  const body = unsubscribeBody();
  assert.match(body, /unsubscribed/);
  assert.ok(body.length <= 160);
});
