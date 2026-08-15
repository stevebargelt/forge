// FG-560 (step 1): model-policy schema_version detection gate.
//
// model-policy.yml is an operator-owned, versioned config surface. The dispatch
// loaders (loadModelPolicy / loadModelPolicyWithSource) must gate on schema_version
// BEFORE Zod validation and NEVER rewrite the file (loading is strictly read-only;
// `forge upgrade` is the sole migration authority):
//   - schema_version: 2  (current)   → validated policy returned, file unchanged
//   - no schema_version  (v1 legacy) → refuse dispatch naming `forge upgrade`
//   - schema_version: 1  (older)     → refuse dispatch naming `forge upgrade`
//   - schema_version: 99 (newer)     → fail loud naming `upgrade Forge`, no downgrade
// In every refusal case the file bytes must be byte-identical after the load.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadModelPolicy, loadModelPolicyWithSource } from "./loader.js";

// A minimal, otherwise-valid policy body (no schema_version line — callers below
// prepend the version they want to exercise). Mirrors the loader.test.ts fixture.
const POLICY_BODY = `on_unavailable: fail
model_profiles:
  claude-subscription:
    provider: anthropic
    auth: subscription
    map:
      review: { model: claude-sonnet-4-6, cost_tier: standard }
defaults:
  profile: claude-subscription
  activity: { review: claude-subscription }
`;

const V2_POLICY = `schema_version: 2\n${POLICY_BODY}`;
const V1_POLICY = POLICY_BODY; // v1 never declared schema_version
const V1_EXPLICIT_POLICY = `schema_version: 1\n${POLICY_BODY}`;
const FUTURE_POLICY = `schema_version: 99\n${POLICY_BODY}`;

let originalForgeHome: string | undefined;
let homeDir: string;
let policyPath: string;

beforeEach(() => {
  originalForgeHome = process.env.FORGE_HOME;
  homeDir = mkdtempSync(join(tmpdir(), "forge-fg560-"));
  process.env.FORGE_HOME = homeDir;
  policyPath = join(homeDir, "model-policy.yml");
});

afterEach(() => {
  if (originalForgeHome === undefined) delete process.env.FORGE_HOME;
  else process.env.FORGE_HOME = originalForgeHome;
  rmSync(homeDir, { recursive: true, force: true });
});

function writePolicy(body: string): Buffer {
  writeFileSync(policyPath, body);
  return readFileSync(policyPath); // snapshot raw bytes for byte-identity assertions
}

function assertBytesUnchanged(before: Buffer): void {
  const after = readFileSync(policyPath);
  assert.ok(before.equals(after), "loadModelPolicy must not modify the policy file bytes");
}

// ------------------------------------------------------------------
// loadModelPolicy
// ------------------------------------------------------------------

test("loadModelPolicy: a valid schema_version 2 file loads and validates unchanged", () => {
  const before = writePolicy(V2_POLICY);
  const policy = loadModelPolicy();
  assert.ok(policy, "expected a policy to be returned");
  assert.equal(policy!.schema_version, 2);
  assert.equal(policy!.defaults.profile, "claude-subscription");
  assertBytesUnchanged(before);
});

test("loadModelPolicy: a v1 file (no schema_version) refuses dispatch naming `forge upgrade`, bytes unchanged", () => {
  const before = writePolicy(V1_POLICY);
  let err: unknown;
  try {
    loadModelPolicy();
    assert.fail("expected loadModelPolicy to throw on a v1 policy");
  } catch (e) {
    err = e;
  }
  const msg = (err as Error).message;
  assert.match(msg, /forge upgrade/, "refusal must direct the operator to `forge upgrade`");
  assert.doesNotMatch(msg, /upgrade Forge/, "a v1 file is migratable, not an unsupported-newer version");
  assertBytesUnchanged(before);
});

test("loadModelPolicy: an explicit older schema_version 1 refuses naming `forge upgrade`, bytes unchanged", () => {
  const before = writePolicy(V1_EXPLICIT_POLICY);
  assert.throws(() => loadModelPolicy(), /forge upgrade/);
  assertBytesUnchanged(before);
});

test("loadModelPolicy: schema_version 99 fails loud naming `upgrade Forge` and never falls back to v1, bytes unchanged", () => {
  const before = writePolicy(FUTURE_POLICY);
  let err: unknown;
  try {
    loadModelPolicy();
    assert.fail("expected loadModelPolicy to throw on a newer-unknown schema_version");
  } catch (e) {
    err = e;
  }
  const msg = (err as Error).message;
  assert.match(msg, /upgrade Forge/, "a newer-unknown version must instruct the operator to upgrade Forge");
  assert.match(msg, /99/, "the offending version should be named");
  // Must NOT silently reinterpret as v1 / fall back to a legacy read.
  assertBytesUnchanged(before);
});

test("loadModelPolicy: a non-numeric schema_version fails loud without guessing", () => {
  const before = writePolicy(`schema_version: "two"\n${POLICY_BODY}`);
  assert.throws(() => loadModelPolicy(), /schema_version must be a positive integer/);
  assertBytesUnchanged(before);
});

test("loadModelPolicy: absent policy stays legacy (undefined), no throw", () => {
  // No file written at all → opt-in policy absent → undefined, behavior unchanged.
  assert.equal(loadModelPolicy(), undefined);
});

// ------------------------------------------------------------------
// loadModelPolicyWithSource — the provenance variant used by the dispatch path
// ------------------------------------------------------------------

test("loadModelPolicyWithSource: a v2 file returns { source: 'host', policy }", () => {
  const before = writePolicy(V2_POLICY);
  const result = loadModelPolicyWithSource();
  assert.equal(result.source, "host");
  assert.equal(result.policy?.schema_version, 2);
  assertBytesUnchanged(before);
});

test("loadModelPolicyWithSource: a v1 file refuses naming `forge upgrade`, bytes unchanged", () => {
  const before = writePolicy(V1_POLICY);
  assert.throws(() => loadModelPolicyWithSource(), /forge upgrade/);
  assertBytesUnchanged(before);
});

test("loadModelPolicyWithSource: schema_version 99 fails loud naming `upgrade Forge`, bytes unchanged", () => {
  const before = writePolicy(FUTURE_POLICY);
  assert.throws(() => loadModelPolicyWithSource(), /upgrade Forge/);
  assertBytesUnchanged(before);
});

// ------------------------------------------------------------------
// Project override honors the same gate.
// ------------------------------------------------------------------

test("loadModelPolicy: project override is version-gated too (v1 project file refuses)", () => {
  const projectDir = mkdtempSync(join(tmpdir(), "forge-fg560-proj-"));
  try {
    mkdirSync(join(projectDir, ".forge"), { recursive: true });
    const projPolicyPath = join(projectDir, ".forge", "model-policy.yml");
    writeFileSync(projPolicyPath, V1_POLICY);
    const before = readFileSync(projPolicyPath);
    assert.throws(() => loadModelPolicy({ projectDir }), /forge upgrade/);
    const after = readFileSync(projPolicyPath);
    assert.ok(before.equals(after), "project policy file must be left byte-identical");
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});
