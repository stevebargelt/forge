// FG-638: the review-ledger presentation decisions, tested away from the DOM.
// "Next required action" is the one the dashboard must never get wrong — telling an
// operator a review needs nothing while an untriaged finding sits in it is the
// failure mode this file exists to prevent.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dispositionBadgeClass,
  severityBadgeClass,
  reviewStateBadgeClass,
  formatCounts,
  nextRequiredAction,
  sourceLabels,
  anchorText,
} from "../client/review-ledger-render.js";

test("disposition badges distinguish untriaged, blocking work, and settled decisions", () => {
  assert.equal(dispositionBadgeClass("untriaged"), "status-awaiting_gate");
  assert.equal(dispositionBadgeClass("fix_now"), "status-blocked_by_red");
  assert.equal(dispositionBadgeClass("architecture_question"), "status-awaiting_red");
  assert.equal(dispositionBadgeClass("rejected_premise"), "status-complete");
  assert.equal(dispositionBadgeClass("something-new"), "status-pending");
});

test("severity and review-state badges fall back rather than render nothing", () => {
  assert.equal(severityBadgeClass("HIGH"), "status-failed");
  assert.equal(severityBadgeClass(null), "status-pending");
  assert.equal(reviewStateBadgeClass("settled"), "status-complete");
  assert.equal(reviewStateBadgeClass("blocked_environment"), "status-environment_unavailable");
  assert.equal(reviewStateBadgeClass("discovering"), "status-running");
});

test("formatCounts is deterministic and names the empty case", () => {
  assert.equal(formatCounts({ untriaged: 1, fix_now: 2 }), "fix_now 2, untriaged 1");
  assert.equal(formatCounts({}), "—");
  assert.equal(formatCounts(undefined), "—");
});

test("nextRequiredAction puts untriaged findings ahead of everything else", () => {
  assert.match(
    nextRequiredAction({ state: "settled", countsByDisposition: { untriaged: 2 }, findings: [] }),
    /disposition 2 untriaged/,
  );
});

test("nextRequiredAction escalates an architecture question before fix work", () => {
  const review = {
    state: "fixing",
    countsByDisposition: { architecture_question: 1, fix_now: 1 },
    findings: [{ disposition: "fix_now", resolution: null }],
  };
  assert.match(nextRequiredAction(review), /settle 1 architecture question/);
});

test("nextRequiredAction counts fix_now findings that are not proven resolved", () => {
  const review = {
    state: "fixing",
    countsByDisposition: { fix_now: 2 },
    findings: [
      { disposition: "fix_now", resolution: "resolved" },
      { disposition: "fix_now", resolution: null },
    ],
  };
  assert.match(nextRequiredAction(review), /fix and recheck 1 finding/);
});

test("nextRequiredAction reports the stage when the ledger is clean", () => {
  assert.equal(nextRequiredAction({ state: "settled", countsByDisposition: {}, findings: [] }), "settled — no action");
  assert.equal(
    nextRequiredAction({ state: "shipping_review", countsByDisposition: {}, findings: [] }),
    "advance: shipping_review",
  );
});

test("sourceLabels never collapses two reviewers into one", () => {
  assert.deepEqual(
    sourceLabels([
      { redRole: "red-security", verdictId: "v1" },
      { redRole: "red-wide", verdictId: "v2" },
      { modelFindingId: "SEC-1" },
    ]),
    ["red-security (v1)", "red-wide (v2)", "model-supplied id"],
  );
  assert.deepEqual(sourceLabels(undefined), []);
});

test("anchorText renders file, line and quoted text, or nothing at all", () => {
  assert.equal(anchorText({ file: "a.ts", line: 4, quotedText: "x" }), 'a.ts:4 "x"');
  assert.equal(anchorText({ file: "a.ts" }), "a.ts");
  assert.equal(anchorText({}), null);
});
