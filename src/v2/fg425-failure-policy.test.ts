// FG-425 follow-on: the publisher's new failure kinds must reach operators as
// NAMED blockers with real remediation — and the pre-FG-425 advice that assumed
// "merge first, gate the target afterwards" must be gone.
//
// Two guarantees, one construction-level and one behavioural:
//
//   1. POLICY (retry-policy.ts) and BLOCKER_BY_FAILURE_KIND (campaign/policy.ts)
//      are both typed Record<FailureKind, …>. Adding a kind to FailureKind
//      without a policy entry is a COMPILE ERROR, not a silent fall-through to
//      "unrecognized failure kind '<x>'; re-dispatch" at the operator surface.
//      ALL_FAILURE_KINDS below is itself a Record<FailureKind, true>, so this
//      test file also stops compiling if a kind is added and not listed here —
//      the sweep tests below can never quietly stop covering a kind.
//
//   2. `forge retry` never advises resetting the publish target. Under FG-425 a
//      failed integration gate publishes NOTHING, so `git reset --hard HEAD~1`
//      in run.projectDir would discard whatever legitimately sits at the
//      target's HEAD — quite possibly a previous, correctly-validated
//      publication. That advice was recorded on integration_failed; this pins
//      that it stays dead.

import { test } from "node:test";
import assert from "node:assert/strict";
import { retryPolicy } from "./retry-policy.js";
import type { FailureKind } from "./failure-kind.js";
import { classifyFailureKind, isSharedBlocker } from "../campaign/policy.js";

const ALL_FAILURE_KINDS: Record<FailureKind, true> = {
  cancelled: true,
  orphaned: true,
  orphaned_work_may_persist: true,
  oom_killed: true,
  fanout_wave_orphaned: true,
  orphaned_needs_finalize: true,
  container_crash: true,
  idle_timeout: true,
  result_missing: true,
  result_malformed: true,
  work_not_persisted: true,
  merge_conflict: true,
  capture_failed: true,
  integration_failed: true,
  integration_gate_timeout: true,
  integration_gate_crashed: true,
  publish_base_churn: true,
  dirty_publish_target: true,
  publication_refused: true,
  lane_taken_over: true,
  auth_missing: true,
  auth_expired: true,
  auth_injection_failed: true,
  model_error: true,
  tool_error: true,
  red_blocked: true,
  gate_rejected: true,
  verification_environment_unavailable: true,
  pre_container_crash: true,
  backlog_authority_conflict: true,
  backlog_authority_unresolvable: true,
  backlog_ticket_unreadable: true,
  unknown: true,
};

const KINDS = Object.keys(ALL_FAILURE_KINDS) as FailureKind[];

const PUBLICATION_KINDS = [
  "dirty_publish_target",
  "publish_base_churn",
  "publication_refused",
  "lane_taken_over",
] as const;

// ── 1. no failure kind may reach an operator as "unrecognized" ──────────────

test("every FailureKind resolves to a named retry policy entry (none fall through to 'unrecognized')", () => {
  for (const kind of KINDS) {
    const d = retryPolicy(kind);
    assert.doesNotMatch(
      d.reason,
      /unrecognized failure kind/,
      `${kind} has no POLICY entry — it reaches operators as an unrecognized, blindly-retryable kind`,
    );
    assert.ok(d.reason.length > 0, `${kind} must carry a reason`);
  }
});

test("an unknown-to-this-build kind read off an old event still degrades safely at runtime", () => {
  const d = retryPolicy("some_kind_from_a_future_build");
  assert.equal(d.retryable, true);
  assert.match(d.reason, /unrecognized failure kind/);
});

// ── 2. the FG-425 publication kinds ────────────────────────────────────────

test("the four FG-425 publication kinds are named blockers with concrete remediation", () => {
  for (const kind of PUBLICATION_KINDS) {
    const d = retryPolicy(kind, "t-abc");
    assert.ok(d.advice, `${kind} must carry operator remediation advice`);
    assert.doesNotMatch(d.advice!, /<id>/, `${kind}'s advice must interpolate the task id`);
  }
});

test("dirty_publish_target is NOT blindly retryable — the operator must clear the target first", () => {
  const d = retryPolicy("dirty_publish_target");
  assert.equal(d.retryable, false);
  // AD-3's remediation, verbatim in spirit: forge never stashes/resets/cleans
  // operator-owned state, so the operator does.
  assert.match(d.advice!, /commit|stash|move|remove/i);
  // Both dirty shapes the publisher distinguishes (tracked dirt, untracked clobber).
  assert.match(d.advice!, /untracked/i);
});

test("publish_base_churn points at the external writer and does not silently loop", () => {
  const d = retryPolicy("publish_base_churn");
  assert.equal(d.retryable, false, "an external writer is still pushing; a blind retry just churns again");
  assert.match(d.reason, /external/i);
  assert.match(d.reason, /evidence/i);
  assert.match(d.advice!, /rebuild bound/i, "AD-1: do not respond by raising the bound");
});

test("publication_refused says what was refused and why, and reports the target unchanged", () => {
  const d = retryPolicy("publication_refused");
  assert.equal(d.retryable, false);
  assert.match(d.reason, /fast-forward|compare-and-swap/i);
  assert.match(d.reason, /nothing was published|target is unchanged/i);
});

test("lane_taken_over is retryable — a retry enqueues a NEW attempt (AD-7), nothing was published", () => {
  const d = retryPolicy("lane_taken_over");
  assert.equal(d.retryable, true);
  assert.match(d.reason, /nothing was published/i);
});

// ── 3. the data-loss trap: no advice may reset the publish target ───────────

test("integration_failed advice does NOT tell the operator to reset the publish target", () => {
  const d = retryPolicy("integration_failed");
  assert.equal(d.retryable, false);
  assert.ok(d.advice);
  assert.doesNotMatch(d.advice!, /reset --hard/);
  assert.doesNotMatch(d.advice!, /HEAD~1/);
  assert.match(d.advice!, /fix the break in code/i);
  assert.match(d.reason, /nothing was published|never modified/i);
});

test("NO retry advice anywhere resets, cleans, or checks out over the publish target", () => {
  for (const kind of KINDS) {
    const d = retryPolicy(kind);
    const text = `${d.reason} ${d.advice ?? ""}`;
    assert.doesNotMatch(text, /reset --hard|git clean -|checkout --force/, `${kind}'s guidance is destructive`);
    // Post-FG-425 there is no merge on the target to undo, on ANY failure path.
    assert.doesNotMatch(text, /undo the merge/, `${kind} still assumes the pre-FG-425 merge-then-gate order`);
  }
});

// ── 4. campaign classification of the four kinds ────────────────────────────

test("every FailureKind has an explicit campaign blocker classification", () => {
  for (const kind of KINDS) {
    assert.ok(classifyFailureKind(kind), `${kind} must classify`);
  }
  // The conservative default still holds at runtime for an unrecognized kind.
  assert.equal(classifyFailureKind("some_kind_from_a_future_build"), "campaign_system");
  assert.equal(classifyFailureKind(undefined), "campaign_system");
});

test("dirty_publish_target holds the campaign: the dirt is in the SHARED publish target", () => {
  // Every remaining item publishes into the same projectDir, so each would
  // validate a full candidate and be refused at exactly the same place. It is
  // git_state — an existing SHARED kind — not a per-item scope failure.
  assert.equal(classifyFailureKind("dirty_publish_target"), "git_state");
  assert.equal(isSharedBlocker("git_state"), true);
});

test("publish_base_churn and publication_refused hold the campaign (target-level contention)", () => {
  assert.equal(classifyFailureKind("publish_base_churn"), "git_state");
  assert.equal(classifyFailureKind("publication_refused"), "git_state");
});

test("lane_taken_over does NOT hold the campaign — it is the lane working, scoped to one item", () => {
  const kind = classifyFailureKind("lane_taken_over");
  assert.equal(kind, "scope");
  assert.equal(isSharedBlocker(kind), false);
});
