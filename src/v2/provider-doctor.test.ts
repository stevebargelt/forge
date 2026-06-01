// Provider auth probe tests (AWN-7). Env-controlled so they're deterministic
// regardless of the host's ~/.aws config: AWS_PROFILE forces the "aws present"
// signal true, so we never depend on whether ~/.aws/config exists on the box.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { probeAuth, doctorReport, checkResolvedAvailability } from "./provider-doctor.js";
import type { ModelResolution } from "./model-resolution.js";

// A policy-mode resolution pinned to api (probe is unavailable when no key set).
function apiResolution(onUnavailable: "fail" | "fallback"): ModelResolution {
  return {
    alias: "review",
    model: "m",
    profile: "claude-api",
    provider: "anthropic",
    auth: "api",
    costTier: "standard",
    resolvedBy: "defaults.profile",
    runtime: "claude-apikey",
    onUnavailable,
  };
}

let snap: Record<string, string | undefined>;

beforeEach(() => {
  snap = {
    CLAUDE_CODE_USE_BEDROCK: process.env.CLAUDE_CODE_USE_BEDROCK,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    AWS_PROFILE: process.env.AWS_PROFILE,
  };
  for (const k of Object.keys(snap)) delete process.env[k];
});

afterEach(() => {
  for (const [k, v] of Object.entries(snap)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

test("probeAuth(anthropic, api): available iff ANTHROPIC_API_KEY set", () => {
  assert.equal(probeAuth("anthropic", "api").status, "unavailable");
  process.env.ANTHROPIC_API_KEY = "sk-x";
  const p = probeAuth("anthropic", "api");
  assert.equal(p.status, "available");
  assert.equal(p.provider, "anthropic");
});

test("probeAuth(anthropic, bedrock): available when AWS present + CLAUDE_CODE_USE_BEDROCK=1", () => {
  process.env.CLAUDE_CODE_USE_BEDROCK = "1";
  process.env.AWS_PROFILE = "test-profile";
  const p = probeAuth("anthropic", "bedrock");
  assert.equal(p.status, "available");
});

test("probeAuth(anthropic, bedrock): available on AWS creds alone — a pinned profile doesn't need CLAUDE_CODE_USE_BEDROCK", () => {
  // The claude-bedrock runtime injects CLAUDE_CODE_USE_BEDROCK=1 itself; the host
  // env var is the auto-SELECTION signal, not an availability requirement.
  process.env.AWS_PROFILE = "test-profile"; // AWS creds present, no env var
  const p = probeAuth("anthropic", "bedrock");
  assert.equal(p.status, "available");
});

test("probeAuth(anthropic, subscription): unknown with no cached OAuth hint", () => {
  // test-setup gives a fresh empty FORGE_HOME — no oauth-hint.json.
  const p = probeAuth("anthropic", "subscription");
  assert.equal(p.status, "unknown");
  assert.match(p.detail, /forge auth/);
});

// Walk-prep (#226): the probe is provider-aware. An openai/api profile must NOT
// report available off ANTHROPIC_API_KEY — the auth vocabulary is shared but
// availability is provider-specific. Today openai is unprobeable → "unknown".
test("probeAuth: a non-anthropic provider does NOT borrow ANTHROPIC_API_KEY availability", () => {
  process.env.ANTHROPIC_API_KEY = "sk-x"; // would make anthropic/api available
  const p = probeAuth("openai", "api");
  assert.equal(p.status, "unknown", "openai/api must not read as available off an anthropic key");
  assert.equal(p.provider, "openai");
  assert.match(p.detail, /Walk/);
});

test("probeAuth: undefined provider → unknown (defensive)", () => {
  const p = probeAuth(undefined, "api");
  assert.equal(p.status, "unknown");
});

test("doctorReport: returns all three anthropic auth modes, each tagged with provider", () => {
  const report = doctorReport();
  assert.deepEqual(report.map((r) => r.mode), ["subscription", "api", "bedrock"]);
  assert.ok(report.every((r) => r.provider === "anthropic"));
});

test("checkResolvedAvailability: legacy resolution always ok (no policy gate)", () => {
  const legacy: ModelResolution = {
    alias: undefined, model: "x", profile: undefined, provider: undefined,
    auth: undefined, costTier: undefined, resolvedBy: "legacy", runtime: "claude",
    onUnavailable: "fail",
  };
  assert.deepEqual(checkResolvedAvailability(legacy), { ok: true });
});

test("checkResolvedAvailability: unavailable + on_unavailable=fail → fail loud", () => {
  // No ANTHROPIC_API_KEY (cleared in beforeEach) → api probe is unavailable.
  const r = checkResolvedAvailability(apiResolution("fail"));
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /unavailable/);
});

test("checkResolvedAvailability: unavailable + on_unavailable=fallback → fail loud (not implemented in Crawl)", () => {
  const r = checkResolvedAvailability(apiResolution("fallback"));
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /fallback is not implemented/);
});

test("checkResolvedAvailability: available auth proceeds", () => {
  process.env.ANTHROPIC_API_KEY = "sk-x"; // api now available
  assert.deepEqual(checkResolvedAvailability(apiResolution("fail")), { ok: true });
});
