import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateDoneAudit } from "./done-audit.js";
import type { DoneAuditInput } from "./done-audit.js";

function cleanInput(): DoneAuditInput {
  return {
    ticket: {
      status: "done",
      closedCommit: "abc123def456",
      body: "## Problem\nDone.\n\n## Goal\nShip it.\n\n## Acceptance Criteria\n- Done\n",
      related: [],
    },
    item: { lifecycleStatus: "complete", outcome: "shipped" },
    git: { dirty: false, commitExists: true, pushed: true },
    verification: {
      hostVerified: true,
      containerTestsRun: 12,
      acceptedException: null,
    },
  };
}

// ── Aggregation precedence: fail dominates unknown ────────────────────────────

test("aggregation: fail + unknown required checks → outcome=fail (fail dominates)", () => {
  const input = cleanInput();
  // ticket_closed → fail
  input.ticket!.status = "active";
  // host_verification → unknown
  input.verification.hostVerified = null;
  // Everything else: pass

  const result = evaluateDoneAudit(input);
  assert.equal(result.outcome, "fail", "outcome must be fail when any required check fails, even if others are unknown");

  const ticketCheck = result.checks.find((c) => c.name === "ticket_closed");
  const hvCheck = result.checks.find((c) => c.name === "host_verification");
  assert.equal(ticketCheck!.status, "fail");
  assert.equal(hvCheck!.status, "unknown");
  assert.notEqual(result.outcome, "unknown", "unknown must NOT dominate fail");
});

test("aggregation: all required pass + unknown → outcome=unknown (unknown does not become pass)", () => {
  const input = cleanInput();
  // host_verification → unknown; all others remain pass
  input.verification.hostVerified = null;
  input.verification.containerTestsRun = 5;

  const result = evaluateDoneAudit(input);
  assert.equal(result.outcome, "unknown", "outcome must be unknown when some required checks are unknown and none fail");
  assert.notEqual(result.outcome, "pass", "outcome must NOT be pass when any required check is unknown");

  const requiredChecks = result.checks.filter((c) => c.name !== "container_verification");
  const hasFail = requiredChecks.some((c) => c.status === "fail");
  const hasUnknown = requiredChecks.some((c) => c.status === "unknown");
  assert.equal(hasFail, false, "no required check should be fail in this scenario");
  assert.equal(hasUnknown, true, "at least one required check must be unknown");
});

test("aggregation: all required pass → outcome=pass (no unknowns, no fails)", () => {
  const input = cleanInput();
  // Explicitly verify all required checks are in pass state
  const result = evaluateDoneAudit(input);
  assert.equal(result.outcome, "pass");

  const requiredChecks = result.checks.filter((c) => c.name !== "container_verification");
  for (const check of requiredChecks) {
    assert.equal(check.status, "pass", `required check ${check.name} must be pass`);
  }
});

// ── container_verification: excluded from outcome aggregation (both directions) ─

test("container=fail (0 tests), all required pass, host verified → outcome=pass (container excluded)", () => {
  const input = cleanInput();
  // container_verification → fail
  input.verification.containerTestsRun = 0;
  // host_verification → pass (hostVerified=true from cleanInput)
  // all other required checks → pass

  const result = evaluateDoneAudit(input);
  const containerCheck = result.checks.find((c) => c.name === "container_verification");
  assert.equal(containerCheck!.status, "fail", "container_verification must be fail with 0 tests");
  assert.equal(result.outcome, "pass", "container fail must NEVER downgrade outcome when required checks all pass");
  assert.equal(result.requestedAction, null, "requestedAction must be null when outcome=pass despite container fail");
});

test("container=pass (tests run), host missing → outcome=unknown (container cannot satisfy host_verification)", () => {
  const input = cleanInput();
  // container_verification → pass
  input.verification.containerTestsRun = 30;
  // host_verification → unknown (container run must not stand in for host)
  input.verification.hostVerified = null;

  const result = evaluateDoneAudit(input);
  const containerCheck = result.checks.find((c) => c.name === "container_verification");
  const hvCheck = result.checks.find((c) => c.name === "host_verification");
  assert.equal(containerCheck!.status, "pass", "container_verification must be pass");
  assert.equal(hvCheck!.status, "unknown", "host_verification must remain unknown — container cannot satisfy it");
  assert.equal(result.outcome, "unknown", "outcome must be unknown when host_verification is unknown");
  assert.notEqual(result.outcome, "pass", "container pass must NOT elevate outcome to pass when host missing");
});

// ── host_verification: false → fail (not unknown) ────────────────────────────

test("hostVerified=false → host_verification=fail (not unknown), outcome=fail", () => {
  const input = cleanInput();
  // false explicitly means the check ran and failed — it is NOT the same as null (unrecorded)
  input.verification.hostVerified = false;

  const result = evaluateDoneAudit(input);
  const hvCheck = result.checks.find((c) => c.name === "host_verification");
  assert.ok(hvCheck, "host_verification check must exist");
  assert.equal(hvCheck!.status, "fail", "hostVerified=false must produce status=fail, not unknown");
  assert.notEqual(hvCheck!.status, "unknown", "hostVerified=false must NOT produce status=unknown");
  assert.equal(result.outcome, "fail");
  assert.ok(result.gaps.some((g) => g.includes("host verification")));
});

// ── deferral_linked: parser edges ─────────────────────────────────────────────

test("deferral_linked: '## Deferred scope' heading variant → pass when FG-id named in section text", () => {
  const input = cleanInput();
  input.ticket!.body = "## Problem\nDone.\n\n## Deferred scope\nFollow-up tracked as FG-700.\n";
  input.ticket!.related = [];

  const result = evaluateDoneAudit(input);
  const deferralCheck = result.checks.find((c) => c.name === "deferral_linked");
  assert.ok(deferralCheck, "deferral_linked check must exist");
  assert.equal(deferralCheck!.status, "pass", "'Deferred scope' heading must be recognized");
  assert.equal(result.outcome, "pass");
});

test("deferral_linked: '## Deferred scope' heading with no link → fail", () => {
  const input = cleanInput();
  input.ticket!.body = "## Deferred scope\nSome future work with no ticket yet.\n";
  input.ticket!.related = [];

  const result = evaluateDoneAudit(input);
  const deferralCheck = result.checks.find((c) => c.name === "deferral_linked");
  assert.equal(deferralCheck!.status, "fail");
  assert.equal(result.outcome, "fail");
});

test("deferral_linked: next heading terminates section — FG ref only after boundary → fail", () => {
  // The deferred section has no link; the FG reference appears in the NEXT section
  // The parser must stop collecting at the next heading, so the FG ref is out-of-scope.
  const input = cleanInput();
  input.ticket!.body = [
    "## Problem",
    "Done.",
    "",
    "## Deferred",
    "Some future work declared here, no link.",
    "",
    "## Implementation Notes",
    "See FG-800 for follow-up tracking.",
    "",
  ].join("\n");
  input.ticket!.related = [];

  const result = evaluateDoneAudit(input);
  const deferralCheck = result.checks.find((c) => c.name === "deferral_linked");
  assert.equal(
    deferralCheck!.status,
    "fail",
    "FG ref after the next heading boundary must NOT satisfy deferral_linked"
  );
  assert.equal(result.outcome, "fail");
});

test("deferral_linked: FG ref inside section, followed by another heading → pass", () => {
  // The FG ref IS in the deferred section; subsequent heading should not affect the result
  const input = cleanInput();
  input.ticket!.body = [
    "## Deferred",
    "Tracked via FG-900.",
    "",
    "## Notes",
    "Unrelated section.",
    "",
  ].join("\n");
  input.ticket!.related = [];

  const result = evaluateDoneAudit(input);
  const deferralCheck = result.checks.find((c) => c.name === "deferral_linked");
  assert.equal(deferralCheck!.status, "pass", "FG ref within the section must satisfy deferral_linked");
  assert.equal(result.outcome, "pass");
});

// ── requestedAction: per-check concrete action text ──────────────────────────

test("requestedAction: ticket_closed fail → includes 'mark the ticket as done'", () => {
  const input = cleanInput();
  input.ticket!.status = "active";

  const result = evaluateDoneAudit(input);
  assert.equal(result.outcome, "fail");
  assert.ok(
    result.requestedAction?.includes("mark the ticket as done"),
    `requestedAction must include 'mark the ticket as done', got: ${result.requestedAction}`
  );
});

test("requestedAction: closed_commit_present fail → includes 'record the closed commit'", () => {
  const input = cleanInput();
  input.ticket!.closedCommit = undefined;
  // Null out git facts that depend on commit — no commit to look up
  input.git.commitExists = null;
  input.git.pushed = null;

  const result = evaluateDoneAudit(input);
  assert.equal(result.outcome, "fail");
  assert.ok(
    result.requestedAction?.includes("record the closed commit"),
    `requestedAction must include 'record the closed commit', got: ${result.requestedAction}`
  );
});

test("requestedAction: commit_exists fail → includes 'verify the closed commit exists'", () => {
  const input = cleanInput();
  input.git.commitExists = false;

  const result = evaluateDoneAudit(input);
  assert.equal(result.outcome, "fail");
  const commitCheck = result.checks.find((c) => c.name === "commit_exists");
  assert.equal(commitCheck!.status, "fail");
  assert.ok(
    result.requestedAction?.includes("verify the closed commit exists"),
    `requestedAction must include 'verify the closed commit exists', got: ${result.requestedAction}`
  );
});

test("requestedAction: pushed=false without closedCommit → generic 'push the commit' (not hash)", () => {
  const input = cleanInput();
  // Remove the commit reference so there's no specific hash to name
  input.ticket!.closedCommit = undefined;
  input.git.commitExists = null;
  input.git.pushed = false;

  const result = evaluateDoneAudit(input);
  assert.equal(result.outcome, "fail");
  const pushedCheck = result.checks.find((c) => c.name === "pushed");
  assert.equal(pushedCheck!.status, "fail");
  assert.ok(
    result.requestedAction?.includes("push the commit"),
    `requestedAction must include 'push the commit', got: ${result.requestedAction}`
  );
  // Must NOT include a specific hash (there is none)
  assert.ok(
    !result.requestedAction?.includes("push abc123"),
    `requestedAction must not include a specific hash when closedCommit absent, got: ${result.requestedAction}`
  );
});

test("requestedAction: multiple non-pass checks → action string includes multiple steps", () => {
  const input = cleanInput();
  // dirty git → "commit or revert"
  input.git.dirty = true;
  // host not verified → "run host typecheck + full suite ... re-audit"
  input.verification.hostVerified = null;

  const result = evaluateDoneAudit(input);
  assert.equal(result.outcome, "fail");
  assert.ok(
    result.requestedAction?.includes("commit or revert"),
    `requestedAction must include dirty action, got: ${result.requestedAction}`
  );
  assert.ok(
    result.requestedAction?.includes("run host typecheck"),
    `requestedAction must include host action, got: ${result.requestedAction}`
  );
});

test("requestedAction: null ONLY when outcome=pass — unknown outcome has non-null action", () => {
  const input = cleanInput();
  // ticket=null → outcome=unknown
  input.ticket = null;

  const result = evaluateDoneAudit(input);
  assert.equal(result.outcome, "unknown");
  assert.notEqual(result.requestedAction, null, "requestedAction must be non-null for unknown outcome");
  assert.ok(
    typeof result.requestedAction === "string" && result.requestedAction.length > 0,
    `requestedAction must be a non-empty string for unknown outcome, got: ${result.requestedAction}`
  );
});
