// FG-487 review finding: the badge-class/detail-line/grouping decision logic
// in dashboard/client/main.js had zero rendering-layer test coverage — exactly
// where the ciOutcome.kind === "passed" bug (a value the producer never
// emits) and the never-set tier/checkContexts/reused fields hid behind a
// green suite. Mirrors verification-label.test.ts's pattern: import the
// plain client module directly with the node test runner.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  eventBadgeClass, eventBadgeText, verificationOutcomeClass, reviewLoopVerificationDetail, hostGateDetail,
  verificationRowBadge,
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

// ─── FG-566: the BADGE is what distinguishes the two, not a muted detail span ──
//
// The producer sets `ok: false` on a readiness refusal (nothing ran, so it is
// literally true), which made the refusal badge byte-identical to the badge for a
// genuine failed verification. The badge IS the scan affordance: an operator
// triaging a run looks at colour and label, and a distinction that survives only
// in a secondary detail line does not distinguish anything.

test("verificationOutcomeClass (FG-566): a readiness REFUSAL is classed as an environment fault, NOT as a failed verification", () => {
  const refusal = { ok: false, readiness: { outcome: "refused", reason: "setup_failed" } };
  assert.equal(verificationOutcomeClass(refusal), "status-environment_unavailable");
  // The load-bearing assertion: the two badges are not the same badge.
  assert.notEqual(verificationOutcomeClass(refusal), verificationOutcomeClass({ ok: false }));
});

test("verificationOutcomeClass (FG-566): a genuine failed verification keeps the failure class — refusals must not swallow real failures", () => {
  assert.equal(verificationOutcomeClass({ ok: false }), "status-failed");
  assert.equal(verificationOutcomeClass({ ok: false, readiness: null }), "status-failed");
  assert.equal(verificationOutcomeClass({ ok: false, readiness: { outcome: "prepared" } }), "status-failed");
  assert.equal(verificationOutcomeClass({ ok: true, readiness: { outcome: "reused" } }), "status-complete");
  // Legacy (no readiness field at all) is untouched, byte for byte.
  assert.equal(verificationOutcomeClass({ exitCode: 1 }), "status-failed");
});

test("eventBadgeClass (FG-566): the refusal badge on the timeline differs from the failed-verification badge", () => {
  assert.equal(
    eventBadgeClass({ eventType: "review_loop.verification_finished", payload: { ok: false, readiness: { outcome: "refused", reason: "self_host_workspace" } } }),
    "status-environment_unavailable",
  );
});

test("eventBadgeText (FG-566): the badge LABEL names the environment refusal; every other event is unchanged", () => {
  assert.equal(
    eventBadgeText({ eventType: "review_loop.verification_finished", payload: { ok: false, readiness: { outcome: "refused", reason: "setup_timed_out" } } }),
    "review_loop.verification_finished · environment",
  );
  assert.equal(eventBadgeText({ eventType: "review_loop.verification_finished", payload: { ok: false } }), "review_loop.verification_finished");
  assert.equal(eventBadgeText({ eventType: "task.completed", payload: null }), "task.completed");
});

test("eventBadgeClass (FG-566): the readiness events themselves are terminal badges, never the dim in-flight grey", () => {
  assert.equal(eventBadgeClass({ eventType: "host_readiness.refused", payload: { reason: "setup_failed" } }), "status-failed");
  assert.equal(eventBadgeClass({ eventType: "host_readiness.ready", payload: { reused: false } }), "status-complete");
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

// ─── FG-425: the publisher's TERMINAL events must not render as in-flight ─────
//
// publication.published / .refused / .parked matched NONE of the classifier's
// generic patterns ("published" contains no "complete"; "refused" and "parked"
// contain no "failed"), so all three fell through to status-pending — the same dim
// grey as an event that is still running. An operator could not tell a publication
// that landed from one that is stuck, which is the one distinction that matters
// when a run is sitting on the publish step.

test("eventBadgeClass (FG-425): publication.published is a SUCCESS badge, not the dim in-flight one", () => {
  assert.equal(eventBadgeClass({ eventType: "publication.published", payload: {} }), "status-complete");
});

test("eventBadgeClass (FG-425): publication.refused (non-fast-forward) is a FAILURE badge", () => {
  assert.equal(eventBadgeClass({ eventType: "publication.refused", payload: {} }), "status-failed");
});

test("eventBadgeClass (FG-425): publication.parked (publish_base_churn / dirty_publish_target) is a FAILURE badge", () => {
  assert.equal(
    eventBadgeClass({ eventType: "publication.parked", payload: { reason: "publish_base_churn" } }),
    "status-failed",
  );
  assert.equal(
    eventBadgeClass({ eventType: "publication.parked", payload: { reason: "dirty_publish_target" } }),
    "status-failed",
  );
});

test("eventBadgeClass (FG-425): none of the publisher's terminal events renders as status-pending", () => {
  for (const eventType of ["publication.published", "publication.refused", "publication.parked"]) {
    assert.notEqual(
      eventBadgeClass({ eventType, payload: {} }),
      "status-pending",
      `${eventType} is TERMINAL — rendering it as pending makes a landed publication look like a stuck one`,
    );
  }
});

test("eventBadgeClass (FG-425): integration.published reads its PAYLOAD — the event fires whatever the outcome was", () => {
  // The run-level event is emitted for every outcome, so the name alone says nothing.
  assert.equal(
    eventBadgeClass({ eventType: "integration.published", payload: { outcome: "published" } }),
    "status-complete",
  );
  assert.equal(
    eventBadgeClass({ eventType: "integration.published", payload: { outcome: "parked" } }),
    "status-failed",
  );
  assert.equal(
    eventBadgeClass({ eventType: "integration.published", payload: { outcome: "validation_failed" } }),
    "status-failed",
  );
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

// ─── FG-566: the readiness preflight on the operator surface ─────────────────
//
// review_loop.verification_finished now carries `readiness: { outcome, reason? }
// | null`. A preparation REFUSAL means forge never ran the reviewed code at all
// — no round consumed, no reviewer, no fixer. Rendering it through the ordinary
// "mode · round · command" detail line reproduces, on the operator surface, the
// exact misclassification this ticket exists to eliminate: an environment fault
// reported as a verdict on the code.

// The pre-change output, captured verbatim from the shipped renderer before the
// readiness field existed. The legacy tests below assert against these literals
// rather than against a recomputed value, so a regression in the untouched path
// cannot be hidden by both sides moving together.
const LEGACY_LOCAL_PASS = "local · round 1 · npm run typecheck && npm run test · fast";
const LEGACY_LOCAL_FAIL = "local · round 2 · npm run typecheck && npm run test · fast · failed: test";
const LEGACY_CI_WAIT = "ci_wait · round 1 · CI / test, CI / test-extended";

test("reviewLoopVerificationDetail (FG-566 LEGACY): a payload with NO readiness field renders byte-identically to the pre-change output", () => {
  // Every event emitted before FG-566 landed is this shape. It must not shift by
  // a single character — the timeline re-renders historical runs.
  assert.equal(
    reviewLoopVerificationDetail({
      attemptId: "a1", round: 1, ticketId: "FG-566", sha: "abc", mode: "local", ok: true,
      reusedEvidence: null, ciOutcome: null, checkContexts: null,
      command: "npm run typecheck && npm run test", tier: "fast",
      steps: [{ name: "typecheck", ok: true }, { name: "test", ok: true }],
    }),
    LEGACY_LOCAL_PASS,
  );
  assert.equal(
    reviewLoopVerificationDetail({
      mode: "local", round: 2, command: "npm run typecheck && npm run test", tier: "fast",
      steps: [{ name: "typecheck", ok: true }, { name: "test", ok: false }],
    }),
    LEGACY_LOCAL_FAIL,
  );
  assert.equal(
    reviewLoopVerificationDetail({ mode: "ci_wait", round: 1, checkContexts: ["CI / test", "CI / test-extended"] }),
    LEGACY_CI_WAIT,
  );
});

test("reviewLoopVerificationDetail (FG-566): readiness: null — never consulted, CI reuse won — renders byte-identically to legacy", () => {
  assert.equal(
    reviewLoopVerificationDetail({ mode: "ci_wait", round: 1, checkContexts: ["CI / test", "CI / test-extended"], readiness: null }),
    LEGACY_CI_WAIT,
  );
});

test("reviewLoopVerificationDetail (FG-566): readiness not_required renders byte-identically to legacy — nothing to prepare is not news", () => {
  assert.equal(
    reviewLoopVerificationDetail({
      mode: "local", round: 1, command: "npm run typecheck && npm run test", tier: "fast",
      steps: [{ name: "typecheck", ok: true }, { name: "test", ok: true }],
      readiness: { outcome: "not_required" },
    }),
    LEGACY_LOCAL_PASS,
  );
});

test("reviewLoopVerificationDetail (FG-566): readiness prepared notes the preparation ALONGSIDE the existing command/tier detail", () => {
  const detail = reviewLoopVerificationDetail({
    mode: "local", round: 1, command: "npm run typecheck && npm run test", tier: "fast",
    steps: [{ name: "typecheck", ok: true }, { name: "test", ok: true }],
    readiness: { outcome: "prepared" },
  });
  assert.match(detail, /deps prepared/);
  // The ordinary detail is not replaced — a successful preparation is a note on
  // a normal verification, not a different kind of event.
  assert.match(detail, /npm run typecheck && npm run test/);
  assert.match(detail, /fast/);
  assert.match(detail, /^local · round 1/);
});

test("reviewLoopVerificationDetail (FG-566): readiness reused is distinguishable from CI evidence reuse", () => {
  const detail = reviewLoopVerificationDetail({
    mode: "local", round: 3, command: "npm run typecheck && npm run test", tier: "fast",
    readiness: { outcome: "reused" },
  });
  assert.match(detail, /deps ready \(reused\)/);
  // "reused evidence" is the CI/host_verifications reuse marker — a different
  // fact. The two must not read as the same thing on one line.
  assert.doesNotMatch(detail, /reused evidence/);
});

test("reviewLoopVerificationDetail (FG-566): a REFUSAL names the reason and states no round was consumed and no reviewer or fixer ran", () => {
  const detail = reviewLoopVerificationDetail({
    mode: "local", round: 1, ok: false, command: "npm ci", tier: null, steps: [],
    readiness: {
      outcome: "refused", reason: "setup_failed", workspace: "/tmp/clone",
      command: "npm ci", exitStatus: 1, stderrTail: "ENOENT",
    },
  });
  assert.match(detail, /setup_failed/);
  assert.match(detail, /verification_environment_unavailable/);
  assert.match(detail, /no round consumed/);
  assert.match(detail, /neither reviewer nor fixer ran/);
  assert.match(detail, /npm ci/);
});

test("reviewLoopVerificationDetail (FG-566): a REFUSAL is visually distinct from the ordinary failed-verification detail line", () => {
  const refused = reviewLoopVerificationDetail({
    mode: "local", round: 2, ok: false, command: "npm ci", steps: [],
    readiness: { outcome: "refused", reason: "runtime_abi_mismatch" },
  });
  const ordinaryFailure = reviewLoopVerificationDetail({
    mode: "local", round: 2, ok: false, command: "npm run typecheck && npm run test", tier: "fast",
    steps: [{ name: "typecheck", ok: true }, { name: "test", ok: false }],
  });
  // The ordinary line opens with the mode; the refusal opens with a marker and
  // the classification token, so the two never read as the same kind of fact.
  assert.match(ordinaryFailure, /^local · /);
  assert.doesNotMatch(refused, /^local · /);
  assert.match(refused, /^⚠ /);
  assert.notEqual(refused, ordinaryFailure);
  // The refusal must NOT claim a verification step failed — nothing ran.
  assert.doesNotMatch(refused, /failed: /);
});

test("reviewLoopVerificationDetail (FG-566): a refusal with no reason still renders a classified line rather than throwing", () => {
  const detail = reviewLoopVerificationDetail({ mode: "local", round: 1, readiness: { outcome: "refused" } });
  assert.match(detail, /verification_environment_unavailable: unclassified/);
  assert.match(detail, /no round consumed/);
});

test("eventBadgeClass (FG-566): host_readiness.refused is a FAILURE badge, not the dim in-flight one", () => {
  assert.equal(
    eventBadgeClass({ eventType: "host_readiness.refused", payload: { reason: "setup_failed" } }),
    "status-failed",
  );
});

test("eventBadgeClass (FG-566): host_readiness.ready is a SUCCESS badge", () => {
  assert.equal(eventBadgeClass({ eventType: "host_readiness.ready", payload: { reused: false } }), "status-complete");
});

test("eventBadgeClass (FG-566): neither host_readiness event renders as status-pending — both are TERMINAL", () => {
  for (const eventType of ["host_readiness.ready", "host_readiness.refused"]) {
    assert.notEqual(eventBadgeClass({ eventType, payload: {} }), "status-pending", `${eventType} is TERMINAL`);
  }
});

test("hostGateDetail: shows gate/command and exit code", () => {
  const detail = hostGateDetail({ gate: "npm run test:all", command: "npm run test:all", exitCode: 1 });
  assert.match(detail, /npm run test:all/);
  assert.match(detail, /exit 1/);
});

test("hostGateDetail: identical gate+command renders the command ONCE, not duplicated", () => {
  const detail = hostGateDetail({ gate: "npm run test:all", command: "npm run test:all", exitCode: 0 });
  assert.equal(detail.match(/npm run test:all/g)?.length, 1, `command must not render twice: "${detail}"`);
});

test("hostGateDetail: a distinct gate label still renders alongside the command", () => {
  const detail = hostGateDetail({ gate: "unit-gate", command: "npm run test", exitCode: 0 });
  assert.match(detail, /unit-gate/);
  assert.match(detail, /npm run test/);
});

// FG-746: groupVerificationRows and evidenceState were retired with the standalone
// Verification tab (their only consumer). verificationRowBadge survives — it still
// styles the live-verification rows Current Activity renders.
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
