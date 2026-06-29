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

// ── clean closeout ─────────────────────────────────────────────────────────────

test("evaluateDoneAudit: clean closeout → outcome pass, requestedAction null", () => {
  const result = evaluateDoneAudit(cleanInput());
  assert.equal(result.outcome, "pass");
  assert.equal(result.requestedAction, null);
  assert.equal(result.gaps.length, 0);

  const names = result.checks.map((c) => c.name);
  assert.ok(names.includes("ticket_closed"), "checks must include ticket_closed");
  assert.ok(names.includes("host_verification"), "checks must include host_verification");

  for (const check of result.checks.filter((c) => c.name !== "container_verification")) {
    assert.equal(check.status, "pass", `${check.name} must be pass in clean closeout`);
  }
});

// ── ticket not done ────────────────────────────────────────────────────────────

test("evaluateDoneAudit: completed item, ticket NOT done → fail (ticket_closed fail)", () => {
  const input = cleanInput();
  input.ticket!.status = "active";

  const result = evaluateDoneAudit(input);
  assert.equal(result.outcome, "fail");

  const ticketCheck = result.checks.find((c) => c.name === "ticket_closed");
  assert.ok(ticketCheck, "ticket_closed check must exist");
  assert.equal(ticketCheck!.status, "fail");

  assert.ok(result.gaps.some((g) => g.includes("active") || g.includes("not done")));
  assert.ok(result.requestedAction !== null);
});

// ── missing closed commit ──────────────────────────────────────────────────────

test("evaluateDoneAudit: done ticket WITHOUT closed_commit → fail", () => {
  const input = cleanInput();
  input.ticket!.closedCommit = undefined;
  // git facts depend on commit — mark unknown since no commit to check
  input.git.commitExists = null;
  input.git.pushed = null;

  const result = evaluateDoneAudit(input);
  assert.equal(result.outcome, "fail");

  const commitCheck = result.checks.find((c) => c.name === "closed_commit_present");
  assert.ok(commitCheck, "closed_commit_present check must exist");
  assert.equal(commitCheck!.status, "fail");
  assert.ok(result.gaps.some((g) => g.includes("closed commit") || g.includes("commit")));
});

// ── dirty git ─────────────────────────────────────────────────────────────────

test("evaluateDoneAudit: dirty git → fail with a concrete gap", () => {
  const input = cleanInput();
  input.git.dirty = true;

  const result = evaluateDoneAudit(input);
  assert.equal(result.outcome, "fail");

  const gitCheck = result.checks.find((c) => c.name === "clean_git");
  assert.ok(gitCheck, "clean_git check must exist");
  assert.equal(gitCheck!.status, "fail");

  assert.ok(
    result.gaps.some((g) => g.includes("dirty") || g.includes("uncommitted")),
    `expected 'dirty'/'uncommitted' in gaps, got: ${JSON.stringify(result.gaps)}`
  );
  assert.ok(
    result.requestedAction?.includes("commit or revert"),
    `requestedAction must mention 'commit or revert', got: ${result.requestedAction}`
  );
});

// ── missing host verification (unknown) ───────────────────────────────────────

test("evaluateDoneAudit: everything else pass, hostVerified null → outcome UNKNOWN (not pass)", () => {
  const input = cleanInput();
  input.verification.hostVerified = null;

  const result = evaluateDoneAudit(input);
  assert.equal(result.outcome, "unknown", "outcome must be unknown (not pass) when host verification missing");
  assert.notEqual(result.outcome, "pass", "must NOT be pass when host verification unrecorded");

  const hvCheck = result.checks.find((c) => c.name === "host_verification");
  assert.ok(hvCheck, "host_verification check must exist");
  assert.equal(hvCheck!.status, "unknown");

  assert.ok(
    result.gaps.some((g) => g.includes("host verification") || g.includes("typecheck")),
    `expected host-verification gap, got: ${JSON.stringify(result.gaps)}`
  );
  assert.ok(
    result.requestedAction?.includes("run host typecheck") && result.requestedAction.includes("re-audit"),
    `requestedAction must mention host typecheck + re-audit, got: ${result.requestedAction}`
  );
});

// ── container tests present but host verification missing → still unknown ─────

test("evaluateDoneAudit: container tests present but hostVerified null → still unknown", () => {
  const input = cleanInput();
  input.verification.hostVerified = null;
  input.verification.containerTestsRun = 20; // container tests present

  const result = evaluateDoneAudit(input);
  assert.equal(result.outcome, "unknown", "container tests must not satisfy host_verification");

  const hvCheck = result.checks.find((c) => c.name === "host_verification");
  assert.equal(hvCheck!.status, "unknown", "host_verification must remain unknown regardless of container tests");

  const containerCheck = result.checks.find((c) => c.name === "container_verification");
  assert.equal(containerCheck!.status, "pass", "container_verification should be pass when tests were run");
});

// ── deferral declared with no follow-up → fail ────────────────────────────────

test("evaluateDoneAudit: deferred scope declared in body with NO linked follow-up → fail", () => {
  const input = cleanInput();
  input.ticket!.body = "## Problem\nDone.\n\n## Deferred\nSome future work.\n";
  input.ticket!.related = [];

  const result = evaluateDoneAudit(input);
  assert.equal(result.outcome, "fail");

  const deferralCheck = result.checks.find((c) => c.name === "deferral_linked");
  assert.ok(deferralCheck, "deferral_linked check must exist");
  assert.equal(deferralCheck!.status, "fail");

  assert.ok(
    result.gaps.some((g) => g.includes("deferred scope") || g.includes("follow-up")),
    `expected deferral gap, got: ${JSON.stringify(result.gaps)}`
  );
  assert.ok(result.requestedAction?.includes("follow-up ticket"));
});

test("evaluateDoneAudit: deferred scope with FG-id named in section text → pass (related[] alone is not sufficient)", () => {
  const input = cleanInput();
  input.ticket!.body = "## Problem\nDone.\n\n## Deferred\nFollow-up tracked as FG-500.\n";
  input.ticket!.related = ["FG-500"];

  const result = evaluateDoneAudit(input);
  const deferralCheck = result.checks.find((c) => c.name === "deferral_linked");
  assert.ok(deferralCheck, "deferral_linked check must exist");
  assert.equal(deferralCheck!.status, "pass");
  assert.equal(result.outcome, "pass");
});

test("evaluateDoneAudit: deferred scope with NO FG-id in section text → fail, even when related[] is non-empty", () => {
  const input = cleanInput();
  input.ticket!.body = "## Problem\nDone.\n\n## Deferred\nSome future work without a named ticket.\n";
  input.ticket!.related = ["FG-500"]; // unrelated related[] must NOT satisfy deferral_linked

  const result = evaluateDoneAudit(input);
  const deferralCheck = result.checks.find((c) => c.name === "deferral_linked");
  assert.ok(deferralCheck, "deferral_linked check must exist");
  assert.equal(deferralCheck!.status, "fail", "related[] alone must not satisfy deferral_linked");
  assert.equal(result.outcome, "fail");
});

test("evaluateDoneAudit: deferred scope with FG-id in section text (not related) → pass", () => {
  const input = cleanInput();
  input.ticket!.body = "## Deferred\nFollow-up tracked in FG-501.\n";
  input.ticket!.related = [];

  const result = evaluateDoneAudit(input);
  const deferralCheck = result.checks.find((c) => c.name === "deferral_linked");
  assert.equal(deferralCheck!.status, "pass");
});

test("evaluateDoneAudit: no deferral declared → deferral_linked pass (n/a)", () => {
  const input = cleanInput();
  // no deferred section

  const result = evaluateDoneAudit(input);
  const deferralCheck = result.checks.find((c) => c.name === "deferral_linked");
  assert.ok(deferralCheck, "deferral_linked check must exist");
  assert.equal(deferralCheck!.status, "pass");
  assert.ok(deferralCheck!.detail?.includes("n/a"));
});

// ── acceptedException for host verification → pass ────────────────────────────

test("evaluateDoneAudit: acceptedException provided for host verification → host_verification pass", () => {
  const input = cleanInput();
  input.verification.hostVerified = null;
  input.verification.acceptedException = "library-only change; host suite not required";

  const result = evaluateDoneAudit(input);
  const hvCheck = result.checks.find((c) => c.name === "host_verification");
  assert.ok(hvCheck, "host_verification check must exist");
  assert.equal(hvCheck!.status, "pass");
  assert.ok(hvCheck!.detail?.includes("waiver"));

  // With waiver, overall outcome should be pass (all other clean)
  assert.equal(result.outcome, "pass");
  assert.equal(result.requestedAction, null);
});

// ── pushed check ──────────────────────────────────────────────────────────────

test("evaluateDoneAudit: commit not pushed → fail with gap naming the commit", () => {
  const input = cleanInput();
  input.git.pushed = false;

  const result = evaluateDoneAudit(input);
  assert.equal(result.outcome, "fail");

  const pushedCheck = result.checks.find((c) => c.name === "pushed");
  assert.equal(pushedCheck!.status, "fail");

  assert.ok(
    result.gaps.some((g) => g.includes("abc123def456") || g.includes("not pushed")),
    `expected commit hash in gap, got: ${JSON.stringify(result.gaps)}`
  );
  assert.ok(
    result.requestedAction?.includes("push abc123def456"),
    `requestedAction must mention push + commit, got: ${result.requestedAction}`
  );
});

// ── null ticket → unknown ──────────────────────────────────────────────────────

test("evaluateDoneAudit: null ticket → unknown outcome (not fail)", () => {
  const input = cleanInput();
  input.ticket = null;

  const result = evaluateDoneAudit(input);
  // ticket_closed and closed_commit_present are unknown; no fail → unknown outcome
  assert.equal(result.outcome, "unknown");
});

// ── deferred: inline marker ────────────────────────────────────────────────────

test("evaluateDoneAudit: 'deferred:' inline marker with no link → fail", () => {
  const input = cleanInput();
  input.ticket!.body = "## Goal\nDone.\n\ndeferred: some future work without a ticket\n";
  input.ticket!.related = [];

  const result = evaluateDoneAudit(input);
  const deferralCheck = result.checks.find((c) => c.name === "deferral_linked");
  assert.equal(deferralCheck!.status, "fail");
  assert.equal(result.outcome, "fail");
});

test("evaluateDoneAudit: 'deferred:' inline marker with FG ref → pass", () => {
  const input = cleanInput();
  input.ticket!.body = "deferred: FG-600 covers remaining scope\n";
  input.ticket!.related = [];

  const result = evaluateDoneAudit(input);
  const deferralCheck = result.checks.find((c) => c.name === "deferral_linked");
  assert.equal(deferralCheck!.status, "pass");
});

// ── container_verification informational ──────────────────────────────────────

test("evaluateDoneAudit: container_verification 0 (fail) does NOT cause overall fail when required checks all pass", () => {
  const input = cleanInput();
  input.verification.containerTestsRun = 0;

  const result = evaluateDoneAudit(input);
  // container_verification is informational — excluded from required checks
  const containerCheck = result.checks.find((c) => c.name === "container_verification");
  assert.equal(containerCheck!.status, "fail");

  // The overall outcome should still be pass because all required checks pass
  assert.equal(result.outcome, "pass", "container_verification fail must not affect outcome");
  assert.equal(result.requestedAction, null);
});
