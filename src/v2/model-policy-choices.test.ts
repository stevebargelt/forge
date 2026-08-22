// FG-346: choices preserve provider-doctor's three-valued status — offer available
// AND unknown (tagged with the next-action), hide only unavailable.

import { test } from "node:test";
import assert from "node:assert/strict";
import { offerableChoices } from "./model-policy-choices.js";
import type { AuthProbe } from "./provider-doctor.js";

const mixed: AuthProbe[] = [
  { provider: "anthropic", mode: "subscription", status: "available", detail: "OAuth volume has credentials" },
  { provider: "openai", mode: "subscription", status: "unknown", detail: "no ~/.codex/auth.json — run `codex login`" },
  { provider: "groq", mode: "api", status: "unavailable", detail: "GROQ_API_KEY not set" },
];

test("offerableChoices: available + unknown offered, unavailable hidden", () => {
  const choices = offerableChoices(mixed);
  const names = choices.map((c) => c.profileName);
  // anthropic subscription expands to opus/sonnet/haiku, all available.
  assert.ok(names.includes("anthropic-subscription-opus"));
  assert.ok(names.includes("anthropic-subscription-sonnet"));
  assert.ok(names.includes("anthropic-subscription-haiku"));
  // openai subscription (unknown) carried through, tagged with the next action verbatim.
  const codex = choices.find((c) => c.profileName === "openai-subscription-codex");
  assert.ok(codex, "openai-subscription-codex should be offered despite unknown status");
  assert.equal(codex!.status, "unknown");
  assert.equal(codex!.nextAction, "no ~/.codex/auth.json — run `codex login`");
  // groq is unavailable → every groq choice excluded.
  assert.ok(!names.some((n) => n.startsWith("groq-")), "no groq choice should be offered");
});

test("offerableChoices: available choices carry a concrete seed-derived model id and no nextAction", () => {
  const sonnet = offerableChoices(mixed).find((c) => c.profileName === "anthropic-subscription-sonnet");
  assert.ok(sonnet);
  assert.equal(sonnet!.model, "claude-sonnet-4-6");
  assert.equal(sonnet!.status, "available");
  assert.equal(sonnet!.nextAction, undefined);
});

test("offerableChoices: all-unavailable yields an empty set", () => {
  const allDown: AuthProbe[] = [
    { provider: "anthropic", mode: "subscription", status: "unavailable", detail: "x" },
    { provider: "openai", mode: "subscription", status: "unavailable", detail: "x" },
    { provider: "groq", mode: "api", status: "unavailable", detail: "x" },
  ];
  assert.deepEqual(offerableChoices(allDown), []);
});
