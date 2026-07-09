// FG-487 review finding: the badge-class/detail-line/grouping decision logic
// in dashboard/client/main.js had zero rendering-layer test coverage — exactly
// where the ciOutcome.kind === "passed" bug (a value the producer never
// emits) and the never-set tier/checkContexts/reused fields hid behind a
// green suite. Mirrors verification-label.test.ts's pattern: import the
// plain client module directly with the node test runner.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  eventBadgeClass, verificationOutcomeClass, reviewLoopVerificationDetail, hostGateDetail,
  groupVerificationRows, verificationRowBadge, evidenceState,
} from "../client/verification-render.js";

test("verificationOutcomeClass: a successful review_loop.verification_finished payload (ok: true) gets the success class", () => {
  assert.equal(verificationOutcomeClass({ ok: true }), "status-complete");
});

test("verificationOutcomeClass: a failed review_loop.verification_finished payload (ok: false) gets the failed class", () => {
  assert.equal(verificationOutcomeClass({ ok: false }), "status-failed");
});

test("verificationOutcomeClass: never treats ciOutcome.kind === 'passed' as success — the producer never emits that value", () => {
  assert.equal(verificationOutcomeClass({ ciOutcome: { kind: "passed" } }), "status-pending");
});

test("verificationOutcomeClass: a campaign_item.host_gate_finished payload (exitCode) gets classed by exit code", () => {
  assert.equal(verificationOutcomeClass({ exitCode: 0 }), "status-complete");
  assert.equal(verificationOutcomeClass({ exitCode: 1 }), "status-failed");
});

test("verificationOutcomeClass: no recognizable field -> pending", () => {
  assert.equal(verificationOutcomeClass({}), "status-pending");
  assert.equal(verificationOutcomeClass(null), "status-pending");
});

test("eventBadgeClass: a successful verification_finished event gets the success class", () => {
  assert.equal(eventBadgeClass({ eventType: "review_loop.verification_finished", payload: { ok: true } }), "status-complete");
});

test("eventBadgeClass: a failed verification_finished event gets the failed class", () => {
  assert.equal(eventBadgeClass({ eventType: "review_loop.verification_finished", payload: { ok: false } }), "status-failed");
});

test("eventBadgeClass: a verification_started event is always running, regardless of payload", () => {
  assert.equal(eventBadgeClass({ eventType: "review_loop.verification_started", payload: { ok: false } }), "status-running");
});

test("reviewLoopVerificationDetail: ci_wait detail line shows the required check contexts", () => {
  const detail = reviewLoopVerificationDetail({
    mode: "ci_wait", round: 2, checkContexts: ["CI / test", "CI / test-extended"],
  });
  assert.match(detail, /CI \/ test, CI \/ test-extended/);
});

test("reviewLoopVerificationDetail: local detail line shows the command and tier", () => {
  const detail = reviewLoopVerificationDetail({
    mode: "local", round: 1, command: "npm run typecheck && npm run test", tier: "fast",
  });
  assert.match(detail, /npm run typecheck && npm run test/);
  assert.match(detail, /fast/);
});

test("reviewLoopVerificationDetail: reused evidence and ciOutcome kind are both surfaced", () => {
  const detail = reviewLoopVerificationDetail({
    mode: "ci_wait", reusedEvidence: "host_verifications row #1", ciOutcome: { kind: "reused_after_wait" },
  });
  assert.match(detail, /reused evidence/);
  assert.match(detail, /reused_after_wait/);
});

test("reviewLoopVerificationDetail: a local failure lists which steps failed", () => {
  const detail = reviewLoopVerificationDetail({
    mode: "local", steps: [{ name: "typecheck", ok: true }, { name: "test", ok: false }],
  });
  assert.match(detail, /failed: test/);
});

test("hostGateDetail: shows gate/command and exit code", () => {
  const detail = hostGateDetail({ gate: "npm run test:all", command: "npm run test:all", exitCode: 1 });
  assert.match(detail, /npm run test:all/);
  assert.match(detail, /exit 1/);
});

test("groupVerificationRows: splits review-loop verifications and campaign reconcile gates into separate buckets", () => {
  const rows = [
    { kind: "review_loop_verification", attemptId: "a1" },
    { kind: "campaign_reconcile_gate", attemptId: "a2" },
    { kind: "review_loop_verification", attemptId: "a3" },
  ];
  const { loop, gate } = groupVerificationRows(rows);
  assert.deepEqual(loop.map((r) => r.attemptId), ["a1", "a3"]);
  assert.deepEqual(gate.map((r) => r.attemptId), ["a2"]);
});

test("groupVerificationRows: null/undefined input yields two empty buckets, not a throw", () => {
  assert.deepEqual(groupVerificationRows(null), { loop: [], gate: [] });
  assert.deepEqual(groupVerificationRows(undefined), { loop: [], gate: [] });
});

test("verificationRowBadge: a stale row renders the stale label with the failed class", () => {
  const badge = verificationRowBadge({ kind: "review_loop_verification", mode: "local", stale: true });
  assert.equal(badge.class, "status-failed");
  assert.equal(badge.text, "stale · verifying");
});

test("verificationRowBadge: a fresh (non-stale) row renders the plain label with the running class", () => {
  const badge = verificationRowBadge({ kind: "review_loop_verification", mode: "ci_wait", stale: false });
  assert.equal(badge.class, "status-running");
  assert.equal(badge.text, "waiting-on-ci");
});

test("evidenceState: null rows (no lookup yet) -> prompt", () => {
  assert.equal(evidenceState(null), "prompt");
});

test("evidenceState: an empty rows array -> empty", () => {
  assert.equal(evidenceState([]), "empty");
});

test("evidenceState: a non-empty rows array -> rows", () => {
  assert.equal(evidenceState([{ id: 1 }]), "rows");
});
