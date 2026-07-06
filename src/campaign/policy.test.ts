import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SHARED_BLOCKER_KINDS,
  isSharedBlocker,
  classifyFailureKind,
  relationToBlocked,
  evaluateContinuePolicy,
} from "./policy.js";
import type { BlockerKind } from "../types/index.js";

// ── classifyFailureKind ────────────────────────────────────────────────────────

test("classifyFailureKind: auth failures → auth (SHARED)", () => {
  assert.equal(classifyFailureKind("auth_missing"), "auth");
  assert.equal(classifyFailureKind("auth_expired"), "auth");
  assert.equal(classifyFailureKind("auth_injection_failed"), "auth");
});

test("classifyFailureKind: infra failures → infrastructure (SHARED)", () => {
  assert.equal(classifyFailureKind("container_crash"), "infrastructure");
  assert.equal(classifyFailureKind("orphaned"), "infrastructure");
  assert.equal(classifyFailureKind("idle_timeout"), "infrastructure");
  assert.equal(classifyFailureKind("result_missing"), "infrastructure");
  assert.equal(classifyFailureKind("result_malformed"), "infrastructure");
  assert.equal(classifyFailureKind("work_not_persisted"), "infrastructure");
});

test("classifyFailureKind: merge_conflict → merge_conflict (SHARED)", () => {
  assert.equal(classifyFailureKind("merge_conflict"), "merge_conflict");
});

test("classifyFailureKind: cancelled/unknown → campaign_system (SHARED)", () => {
  assert.equal(classifyFailureKind("cancelled"), "campaign_system");
  assert.equal(classifyFailureKind("unknown"), "campaign_system");
});

test("classifyFailureKind: agent-ran failures → scope (LOCAL)", () => {
  assert.equal(classifyFailureKind("model_error"), "scope");
  assert.equal(classifyFailureKind("tool_error"), "scope");
  assert.equal(classifyFailureKind("red_blocked"), "scope");
  assert.equal(classifyFailureKind("gate_rejected"), "scope");
});

// FG-426: the integration gate (FG-357) catching a broken merged tree is a
// scoped, operator-fixable item failure — not a campaign-wide system fault —
// so it must classify like gate_rejected, not fall through to campaign_system.
test("FG-426: classifyFailureKind: integration_failed → scope (LOCAL), not campaign_system", () => {
  assert.equal(classifyFailureKind("integration_failed"), "scope");
  assert.equal(isSharedBlocker(classifyFailureKind("integration_failed")), false);
});

test("FG-426: evaluateContinuePolicy for integration_failed is not hold_campaign", () => {
  const kind = classifyFailureKind("integration_failed");
  assert.equal(evaluateContinuePolicy(kind, "independent", "sequential"), "continue_allowed");
  assert.equal(evaluateContinuePolicy(kind, "dependent", "sequential"), "hold_dependents");
});

test("classifyFailureKind: undefined (no terminal event) → campaign_system (SHARED — conservative, cannot confirm LOCAL)", () => {
  assert.equal(classifyFailureKind(undefined), "campaign_system");
});

test("classifyFailureKind: unknown future string → campaign_system (conservative SHARED)", () => {
  assert.equal(classifyFailureKind("some_future_kind"), "campaign_system");
});

// FG-455 p4: oom_killed may hold persisted work (same posture as
// orphaned_work_may_persist) — a blind campaign-continue could clobber it, so
// this must be an explicit campaign_system case, not an implicit default fallthrough.
test("classifyFailureKind: oom_killed → campaign_system (explicit, SHARED — may hold persisted work)", () => {
  assert.equal(classifyFailureKind("oom_killed"), "campaign_system");
});

// ── SHARED_BLOCKER_KINDS set ──────────────────────────────────────────────────

test("SHARED_BLOCKER_KINDS contains exactly the seven shared kinds", () => {
  assert.ok(SHARED_BLOCKER_KINDS.has("auth"));
  assert.ok(SHARED_BLOCKER_KINDS.has("infrastructure"));
  assert.ok(SHARED_BLOCKER_KINDS.has("git_state"));
  assert.ok(SHARED_BLOCKER_KINDS.has("dependency"));
  assert.ok(SHARED_BLOCKER_KINDS.has("merge_conflict"));
  assert.ok(SHARED_BLOCKER_KINDS.has("campaign_system"));
  assert.ok(SHARED_BLOCKER_KINDS.has("lane_escalation"));
  assert.equal(SHARED_BLOCKER_KINDS.size, 7);
});

// FG-442: an item outgrowing its lane invalidates the approved plan basis for
// the whole campaign — scoping this hold-dependents-only would under-pause.
test("FG-442: lane_escalation is a SHARED blocker (isSharedBlocker true)", () => {
  assert.equal(isSharedBlocker("lane_escalation"), true);
});

test("FG-442: evaluateContinuePolicy('lane_escalation', ...) is always hold_campaign, regardless of relation/mode", () => {
  for (const rel of ["dependent", "independent", "unknown"] as const) {
    for (const mode of ["pilot", "sequential"]) {
      assert.equal(evaluateContinuePolicy("lane_escalation", rel, mode), "hold_campaign");
    }
  }
});

test("isSharedBlocker: scope and other LOCAL kinds return false", () => {
  assert.equal(isSharedBlocker("scope"), false);
  assert.equal(isSharedBlocker("readiness"), false);
  assert.equal(isSharedBlocker("tests"), false);
  assert.equal(isSharedBlocker("human_decision"), false);
});

// ── relationToBlocked ─────────────────────────────────────────────────────────

test("relationToBlocked: DEPENDENT when blocked.related includes later.id", () => {
  const blocked = { id: "FG-1", related: ["FG-2", "FG-3"] };
  const later = { id: "FG-2" };
  assert.equal(relationToBlocked(blocked, later), "dependent");
});

test("relationToBlocked: DEPENDENT when later.related includes blocked.id (symmetric)", () => {
  const blocked = { id: "FG-1" };
  const later = { id: "FG-2", related: ["FG-1"] };
  assert.equal(relationToBlocked(blocked, later), "dependent");
});

test("relationToBlocked: INDEPENDENT when blocked has non-empty related, no link to later", () => {
  const blocked = { id: "FG-1", related: ["FG-3", "FG-4"] };
  const later = { id: "FG-2" };
  assert.equal(relationToBlocked(blocked, later), "independent");
});

test("relationToBlocked: INDEPENDENT even if later has related, as long as blocked has non-empty related with no link", () => {
  const blocked = { id: "FG-1", related: ["FG-3"] };
  const later = { id: "FG-2", related: ["FG-5"] };
  assert.equal(relationToBlocked(blocked, later), "independent");
});

test("relationToBlocked: UNKNOWN when blocked has no related field", () => {
  const blocked = { id: "FG-1" };
  const later = { id: "FG-2" };
  assert.equal(relationToBlocked(blocked, later), "unknown");
});

test("relationToBlocked: UNKNOWN when blocked has empty related array", () => {
  const blocked = { id: "FG-1", related: [] };
  const later = { id: "FG-2" };
  assert.equal(relationToBlocked(blocked, later), "unknown");
});

test("relationToBlocked: later.related includes blocked.id → DEPENDENT (but blocked has no related → still DEPENDENT via symmetric check)", () => {
  const blocked = { id: "FG-1" };
  const later = { id: "FG-2", related: ["FG-1"] };
  // symmetric check fires before UNKNOWN check
  assert.equal(relationToBlocked(blocked, later), "dependent");
});

// ── evaluateContinuePolicy — full table ──────────────────────────────────────

const SHARED_KINDS: BlockerKind[] = ["auth", "infrastructure", "git_state", "dependency", "merge_conflict", "campaign_system", "lane_escalation"];
const LOCAL_KINDS: BlockerKind[] = ["scope", "readiness", "tests", "human_decision"];

test("evaluateContinuePolicy: ALL SHARED kinds → hold_campaign (regardless of relation/mode)", () => {
  for (const kind of SHARED_KINDS) {
    for (const rel of ["dependent", "independent", "unknown"] as const) {
      for (const mode of ["pilot", "sequential"]) {
        const policy = evaluateContinuePolicy(kind, rel, mode);
        assert.equal(policy, "hold_campaign", `SHARED kind=${kind}, rel=${rel}, mode=${mode} → must be hold_campaign`);
      }
    }
  }
});

test("evaluateContinuePolicy: LOCAL + dependent → hold_dependents (ALWAYS, even pilot)", () => {
  for (const kind of LOCAL_KINDS) {
    assert.equal(evaluateContinuePolicy(kind, "dependent", "pilot"), "hold_dependents");
    assert.equal(evaluateContinuePolicy(kind, "dependent", "sequential"), "hold_dependents");
  }
});

test("evaluateContinuePolicy: LOCAL + unknown + sequential → hold_dependents", () => {
  for (const kind of LOCAL_KINDS) {
    assert.equal(evaluateContinuePolicy(kind, "unknown", "sequential"), "hold_dependents");
  }
});

test("evaluateContinuePolicy: LOCAL + unknown + pilot → continue_allowed", () => {
  for (const kind of LOCAL_KINDS) {
    assert.equal(evaluateContinuePolicy(kind, "unknown", "pilot"), "continue_allowed");
  }
});

test("evaluateContinuePolicy: LOCAL + independent → continue_allowed (any mode)", () => {
  for (const kind of LOCAL_KINDS) {
    assert.equal(evaluateContinuePolicy(kind, "independent", "pilot"), "continue_allowed");
    assert.equal(evaluateContinuePolicy(kind, "independent", "sequential"), "continue_allowed");
  }
});
