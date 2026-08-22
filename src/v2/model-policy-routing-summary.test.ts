// FG-346: the routing summary is computed from a RE-PARSED policy through the
// production resolver — not from the answers. Write a generated policy to a throwaway
// FORGE_HOME, load it via the production loader, and assert the summary names the
// concrete profile resolveModel actually returns (incl. research-skeptic → codex).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateModelPolicy } from "./model-policy-generator.js";
import { offerableChoices } from "./model-policy-choices.js";
import { loadModelPolicy } from "./loader.js";
import { computeRoutingSummary, renderRoutingSummary } from "./model-policy-routing-summary.js";
import type { AuthProbe } from "./provider-doctor.js";

const PROBES: AuthProbe[] = [
  { provider: "anthropic", mode: "subscription", status: "available", detail: "ok" },
  { provider: "openai", mode: "subscription", status: "available", detail: "ok" },
];

function withPolicy<T>(yaml: string, fn: () => T): T {
  const prev = process.env.FORGE_HOME;
  const dir = mkdtempSync(join(tmpdir(), "fg346-sum-"));
  process.env.FORGE_HOME = dir;
  try {
    writeFileSync(join(dir, "model-policy.yml"), yaml);
    return fn();
  } finally {
    if (prev === undefined) delete process.env.FORGE_HOME;
    else process.env.FORGE_HOME = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("computeRoutingSummary: lines are resolved by the production resolver from the parsed policy", () => {
  const choices = offerableChoices(PROBES);
  const pick = (n: string) => choices.find((c) => c.profileName === n)!.profileName;
  const { yaml } = generateModelPolicy({
    choices,
    defaultProfile: pick("anthropic-subscription-sonnet"),
    activity: {
      default: pick("anthropic-subscription-sonnet"),
      reasoning: pick("anthropic-subscription-opus"),
      review: pick("anthropic-subscription-haiku"),
      fast: pick("anthropic-subscription-haiku"),
    },
    rolePins: {
      "research-primary": pick("anthropic-subscription-sonnet"),
      "research-skeptic": pick("openai-subscription-codex"),
    },
  });

  const { lines, text } = withPolicy(yaml, () => {
    const policy = loadModelPolicy({});
    assert.ok(policy, "policy should load");
    const lines = computeRoutingSummary(policy!, {});
    return { lines, text: renderRoutingSummary(lines) };
  });

  const byLabel = Object.fromEntries(lines.map((l) => [l.label, l.profile]));
  assert.equal(byLabel["default work"], "anthropic-subscription-sonnet");
  assert.equal(byLabel["reasoning-heavy work"], "anthropic-subscription-opus");
  // A red role derives the review capability → resolves through defaults.activity.review.
  assert.equal(byLabel["review"], "anthropic-subscription-haiku");
  // The mixed-provider pin: research-skeptic → the OpenAI codex profile.
  assert.equal(byLabel["research skeptic"], "openai-subscription-codex");
  assert.equal(byLabel["research primary"], "anthropic-subscription-sonnet");

  assert.match(text, /^Forge model routing:/);
  assert.match(text, /research skeptic:\s+openai-subscription-codex/);
});
