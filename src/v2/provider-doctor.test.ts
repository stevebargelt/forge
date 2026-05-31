// Provider auth probe tests (AWN-7). Env-controlled so they're deterministic
// regardless of the host's ~/.aws config: AWS_PROFILE forces the "aws present"
// signal true, so we never depend on whether ~/.aws/config exists on the box.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { probeAuth, doctorReport } from "./provider-doctor.js";

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

test("probeAuth(api): available iff ANTHROPIC_API_KEY set", () => {
  assert.equal(probeAuth("api").status, "unavailable");
  process.env.ANTHROPIC_API_KEY = "sk-x";
  assert.equal(probeAuth("api").status, "available");
});

test("probeAuth(bedrock): available when CLAUDE_CODE_USE_BEDROCK=1 + AWS present", () => {
  process.env.CLAUDE_CODE_USE_BEDROCK = "1";
  process.env.AWS_PROFILE = "test-profile";
  const p = probeAuth("bedrock");
  assert.equal(p.status, "available");
});

test("probeAuth(bedrock): unknown when AWS present but bedrock not switched on", () => {
  process.env.AWS_PROFILE = "test-profile"; // aws signal true, but no CLAUDE_CODE_USE_BEDROCK=1
  const p = probeAuth("bedrock");
  assert.equal(p.status, "unknown");
});

test("probeAuth(subscription): unknown with no cached OAuth hint", () => {
  // test-setup gives a fresh empty FORGE_HOME — no oauth-hint.json.
  const p = probeAuth("subscription");
  assert.equal(p.status, "unknown");
  assert.match(p.detail, /forge auth/);
});

test("doctorReport: returns all three anthropic auth modes in order", () => {
  const report = doctorReport();
  assert.deepEqual(report.map((r) => r.mode), ["subscription", "api", "bedrock"]);
});
