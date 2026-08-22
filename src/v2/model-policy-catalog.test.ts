// FG-346: the catalog is the owned drift surface — assert it against the ON-DISK
// seed (seeds/model-policy.example.yml) and the seeds/agents/ directory so a seed
// rename or a stale model id fails loudly here rather than at dispatch.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  familiesFor,
  modelIdForFamily,
  costTierForFamily,
  isRuntimeFronted,
  runtimeForProvider,
  knownAgentRoles,
  isKnownRole,
} from "./model-policy-catalog.js";

test("familiesFor: anthropic/subscription offers opus, sonnet, haiku", () => {
  assert.deepEqual(familiesFor("anthropic", "subscription").sort(), ["haiku", "opus", "sonnet"]);
});

test("familiesFor: anthropic/bedrock has no opus (not exposed on Bedrock)", () => {
  const fams = familiesFor("anthropic", "bedrock");
  assert.ok(!fams.includes("opus"), "bedrock must not offer opus");
  assert.deepEqual(fams.sort(), ["haiku", "sonnet"]);
});

test("familiesFor: openai/subscription is a single codex family; groq/api is kimi", () => {
  assert.deepEqual(familiesFor("openai", "subscription"), ["codex"]);
  assert.deepEqual(familiesFor("groq", "api"), ["kimi"]);
});

test("modelIdForFamily: concrete ids come from the installed seed", () => {
  assert.equal(modelIdForFamily("anthropic", "subscription", "opus"), "claude-opus-5");
  assert.equal(modelIdForFamily("anthropic", "subscription", "sonnet"), "claude-sonnet-4-6");
  assert.equal(modelIdForFamily("anthropic", "subscription", "haiku"), "claude-haiku-4-5");
  // openai codex → a gpt-5.6-* id from the seed's codex-subscription default.
  const codex = modelIdForFamily("openai", "subscription", "codex");
  assert.ok(codex && codex.startsWith("gpt-5.6-"), `expected a gpt-5.6-* codex id, got ${codex}`);
  assert.equal(modelIdForFamily("groq", "api", "kimi"), "moonshotai/kimi-k2-instruct");
});

test("modelIdForFamily: unknown provider/auth/family → undefined", () => {
  assert.equal(modelIdForFamily("anthropic", "subscription", "sonnett"), undefined);
  assert.equal(modelIdForFamily("nope", "subscription", "opus"), undefined);
  assert.equal(modelIdForFamily("anthropic", "bedrock", "opus"), undefined);
});

test("costTierForFamily: opus premium, haiku cheap, unknown standard", () => {
  assert.equal(costTierForFamily("opus"), "premium");
  assert.equal(costTierForFamily("haiku"), "cheap");
  assert.equal(costTierForFamily("mystery"), "standard");
});

test("runtime-fronted: groq carries the seed runtime, anthropic does not", () => {
  assert.equal(isRuntimeFronted("groq"), true);
  assert.equal(isRuntimeFronted("anthropic"), false);
  assert.equal(runtimeForProvider("groq"), "pi-apikey");
  assert.equal(runtimeForProvider("anthropic"), undefined);
});

test("knownAgentRoles: sourced from seeds/agents/, includes the notable roles", () => {
  const roles = knownAgentRoles();
  for (const r of ["research-primary", "research-skeptic", "engineer", "red-wide", "red-security"]) {
    assert.ok(roles.includes(r), `expected role '${r}' in seeds/agents/`);
  }
});

test("isKnownRole: real role true, typo false", () => {
  assert.equal(isKnownRole("research-skeptic"), true);
  assert.equal(isKnownRole("reserch-skpetic"), false);
});
