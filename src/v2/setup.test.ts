import { test } from "node:test";
import assert from "node:assert/strict";
import {
  planConfigProvision,
  modelPolicyStep,
  routingPolicyStep,
  reviewLoopReadiness,
  buildSetupReport,
} from "./setup.js";
import { buildReleaseReport, type ReleaseInputs } from "./release-doctor.js";

// ── planConfigProvision ──

test("#252 planConfigProvision: present → present; absent+seed → created; dry-run → would-create; no seed → no-seed", () => {
  assert.equal(planConfigProvision({ activePresent: true, seedPresent: true }), "present");
  assert.equal(planConfigProvision({ activePresent: false, seedPresent: true }), "created");
  assert.equal(planConfigProvision({ activePresent: false, seedPresent: true, dryRun: true }), "would-create");
  assert.equal(planConfigProvision({ activePresent: false, seedPresent: false }), "no-seed");
  // never overwrites a present config even in dry-run
  assert.equal(planConfigProvision({ activePresent: true, seedPresent: true, dryRun: true }), "present");
});

test("#252 modelPolicyStep: created → 'created' status; no-seed → fail with next", () => {
  assert.equal(modelPolicyStep("created").status, "created");
  assert.equal(modelPolicyStep("present").status, "ok");
  assert.equal(modelPolicyStep("would-create").status, "would-create");
  const noseed = modelPolicyStep("no-seed");
  assert.equal(noseed.status, "fail");
  assert.match(noseed.next ?? "", /forge upgrade/);
});

test("#252 routingPolicyStep: compiled-when-absent → created; compile fail → fail", () => {
  assert.equal(routingPolicyStep({ presentBefore: true, ensuredOk: true, detail: "" }).status, "ok");
  assert.equal(routingPolicyStep({ presentBefore: false, ensuredOk: true, detail: "" }).status, "created");
  const bad = routingPolicyStep({ presentBefore: false, ensuredOk: false, detail: "bad grammar" });
  assert.equal(bad.status, "fail");
  assert.match(bad.next ?? "", /forge route validate/);
});

// ── reviewLoopReadiness ──

function inputs(over: Partial<ReleaseInputs> = {}): ReleaseInputs {
  return {
    mode: "dev",
    image: { name: "agent-dev-worker:latest", present: true, recordedDigest: "d", currentInputDigest: "d" },
    clis: [{ command: "codex", present: true, neededBy: ["codex-subscription"] }],
    policy: { present: true, valid: true },
    profileAuth: [{ profile: "codex-subscription", provider: "openai", auth: "subscription", status: "available", detail: "cred present" }],
    routing: { present: true, ok: true, detail: "ok" },
    ...over,
  };
}

test("#252 reviewLoopReadiness: codex profile available + codex CLI present → ok (no agent run)", () => {
  const c = reviewLoopReadiness(inputs());
  assert.equal(c.status, "ok");
  assert.match(c.detail, /no agent run/);
});

test("#252 reviewLoopReadiness: profile not defined → warn naming the gap", () => {
  const c = reviewLoopReadiness(inputs({ profileAuth: [] }));
  assert.equal(c.status, "warn");
  assert.match(c.detail, /not defined in model-policy/);
});

test("#252 reviewLoopReadiness: codex CLI missing → warn", () => {
  const c = reviewLoopReadiness(inputs({ clis: [{ command: "codex", present: false, neededBy: ["codex-subscription"] }] }));
  assert.equal(c.status, "warn");
  assert.match(c.detail, /codex CLI missing/);
});

test("#252 reviewLoopReadiness: auth unavailable → warn (opt-in, never blocks)", () => {
  const c = reviewLoopReadiness(inputs({
    profileAuth: [{ profile: "codex-subscription", provider: "openai", auth: "subscription", status: "unavailable", detail: "no ~/.codex/auth.json" }],
  }));
  assert.equal(c.status, "warn");
  assert.match(c.detail, /auth unavailable/);
});

// ── buildSetupReport ──

test("#252 buildSetupReport: a fail in any surface → NOT ready; created/warn do not block", () => {
  const okRelease = buildReleaseReport(inputs());
  const ready = buildSetupReport([modelPolicyStep("created")], okRelease, reviewLoopReadiness(inputs()));
  assert.equal(ready.ready, true, "created + warn-free → ready");

  const badRelease = buildReleaseReport(inputs({ image: { name: "x", present: false } }));
  const notReady = buildSetupReport([modelPolicyStep("created")], badRelease, reviewLoopReadiness(inputs()));
  assert.equal(notReady.ready, false, "an image fail blocks readiness");

  // a warn-only review-loop gap (opt-in) does NOT flip ready
  const warnReview = buildSetupReport([modelPolicyStep("present")], okRelease, reviewLoopReadiness(inputs({ profileAuth: [] })));
  assert.equal(warnReview.ready, true);
});
