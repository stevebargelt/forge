// FG-395: the campaign presentation decisions, tested away from the DOM. The one
// the dashboard must never get wrong is the per-item git/PR evidence derivation:
// telling an operator a commit is "pushed" (or fabricating a PR link) when the
// report observed no such thing is the failure this file exists to prevent.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  campaignStatusBadgeClass,
  verdictBadgeClass,
  verdictLabel,
  itemLifecycleBadgeClass,
  shortSha,
  formatItemCounts,
  derivePushState,
  pushStateLabel,
  pushActionHint,
  gitEvidence,
  itemActionText,
} from "../client/campaigns-render.js";

test("campaign status badges map every status and fall back rather than render nothing", () => {
  assert.equal(campaignStatusBadgeClass("running"), "status-running");
  assert.equal(campaignStatusBadgeClass("complete"), "status-complete");
  assert.equal(campaignStatusBadgeClass("failed"), "status-failed");
  assert.equal(campaignStatusBadgeClass("paused"), "status-awaiting_gate");
  assert.equal(campaignStatusBadgeClass("something-new"), "status-pending");
});

test("verdict badge + label name the three verdicts and fall back", () => {
  assert.equal(verdictBadgeClass("all_shipped"), "status-complete");
  assert.equal(verdictBadgeClass("complete_with_issues"), "status-awaiting_gate");
  assert.equal(verdictBadgeClass("not_complete"), "status-pending");
  assert.equal(verdictLabel("all_shipped"), "all shipped");
  assert.equal(verdictLabel("complete_with_issues"), "complete with issues");
  assert.equal(verdictLabel("mystery"), "mystery");
});

test("item lifecycle badges resolve the campaign item states", () => {
  assert.equal(itemLifecycleBadgeClass("running"), "status-running");
  assert.equal(itemLifecycleBadgeClass("blocked_by_red"), "status-blocked_by_red");
  assert.equal(itemLifecycleBadgeClass("awaiting_recovery"), "status-awaiting_recovery");
  assert.equal(itemLifecycleBadgeClass("complete"), "status-complete");
  assert.equal(itemLifecycleBadgeClass("nonsense"), "status-pending");
});

test("shortSha truncates and names the empty commit", () => {
  assert.equal(shortSha("0123456789abcdef0123"), "0123456789ab");
  assert.equal(shortSha(null), "—");
});

test("formatItemCounts omits empty buckets and names the empty campaign", () => {
  assert.equal(formatItemCounts({ shipped: 2, blocked: 1, held: 0, skipped: 0, failed: 0, total: 3 }), "shipped 2 · blocked 1 · total 3");
  assert.equal(formatItemCounts({ shipped: 0, blocked: 0, held: 0, skipped: 0, failed: 0, total: 0 }), "no items");
  assert.equal(formatItemCounts(undefined), "no items");
});

test("derivePushState reads ONLY the done-audit pushed check and never invents 'pushed'", () => {
  const withPushed = (status: string, detail?: string) => ({ doneAuditState: { checks: [{ name: "pushed", status, ...(detail ? { detail } : {}) }] } });
  assert.equal(derivePushState(withPushed("pass")), "pushed");
  assert.equal(derivePushState(withPushed("fail")), "not_pushed");
  assert.equal(derivePushState(withPushed("unknown", "no remote configured; push/PR unavailable")), "no_remote");
  assert.equal(derivePushState(withPushed("unknown")), "unavailable");
  // No done-audit at all (a non-shipped item, or a report with no git facts) is
  // "unavailable" — NOT observed — never silently "pushed".
  assert.equal(derivePushState({}), "unavailable");
  assert.equal(derivePushState({ doneAuditState: { checks: [] } }), "unavailable");
  assert.equal(pushStateLabel(withPushed("fail")), "not pushed");
  assert.equal(pushStateLabel({}), "push state unavailable");
});

test("pushActionHint gives the operator the exact push/PR action, or none", () => {
  const noRemote = { doneAuditState: { checks: [{ name: "pushed", status: "unknown", detail: "no remote configured; push/PR unavailable" }] } };
  assert.equal(pushActionHint(noRemote), "no remote configured; push/PR unavailable");
  const notPushed = { commit: "abc123def456", doneAuditState: { checks: [{ name: "pushed", status: "fail" }] } };
  assert.equal(pushActionHint(notPushed), "push abc123def456");
  const notPushedNoCommit = { doneAuditState: { checks: [{ name: "pushed", status: "fail" }] } };
  assert.equal(pushActionHint(notPushedNoCommit), "push the commit");
  // A pushed or unobserved state carries no push action.
  assert.equal(pushActionHint({ doneAuditState: { checks: [{ name: "pushed", status: "pass" }] } }), null);
  assert.equal(pushActionHint({}), null);
});

test("gitEvidence renders the null/non-worktree case truthfully and never a fake PR link", () => {
  // A Forge-managed worktree run: branch + worktree present.
  const managed = gitEvidence({
    branch: "forge/FG-101",
    worktreePath: "/wt/FG-101",
    commit: "0123456789abcdef",
    prUrl: null,
    doneAuditState: { checks: [{ name: "pushed", status: "fail" }] },
  });
  assert.equal(managed.managed, true);
  assert.equal(managed.branch, "forge/FG-101");
  assert.equal(managed.worktreePath, "/wt/FG-101");
  assert.equal(managed.commitShort, "0123456789ab");
  assert.equal(managed.prUrl, null);
  assert.equal(managed.prLabel, "no PR");
  assert.equal(managed.pushState, "not_pushed");
  assert.equal(managed.pushActionHint, "push 0123456789abcdef");

  // A non-worktree run: NOT Forge-managed, no PR, push state unobserved.
  const bare = gitEvidence({ branch: null, worktreePath: null, commit: null, prUrl: null });
  assert.equal(bare.managed, false);
  assert.equal(bare.commitShort, null);
  assert.equal(bare.prLabel, "no PR");
  assert.equal(bare.pushState, "unavailable");
  assert.equal(bare.pushActionHint, null);
});

test("itemActionText prefers the requested human action, then hint, then reason", () => {
  assert.equal(itemActionText({ requestedHumanAction: "re-plan FG-102", reason: "scope" }), "re-plan FG-102");
  assert.equal(itemActionText({ hostVerificationReconcileHint: "run reconcile", reason: "scope" }), "run reconcile");
  assert.equal(itemActionText({ reason: "scope exceeded" }), "scope exceeded");
  assert.equal(itemActionText({}), null);
});
