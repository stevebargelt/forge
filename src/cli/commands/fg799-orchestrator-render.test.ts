// FG-799 (AC4 + AC5): the ai_attribution block-conditional render, the upgrade
// re-render flip, and provider-set parity between the constraint file and the
// orchestrator template. Pure string functions over the two real repo seed files —
// stays in the fast unit tier.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyOrchestratorBlock, renderOrchestratorTemplate } from "./init.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const seedPath = resolve(repoRoot, "seeds", "orchestrator-template.md");
const constraintPath = resolve(repoRoot, "seeds", "constraints", "no-ai-attribution.md");

const SUPPRESS_BULLET = "Don't attribute work to an AI assistant";
const ALLOW_BULLET = "AI attribution is ALLOWED in this project";
const MARKER = "forge:if ai_attribution";

// ── AC4: render both modes ──────────────────────────────────────────────────

test("FG-799 (AC4): suppress render keeps the suppress bullet, drops the allow bullet and every marker", () => {
  const rendered = renderOrchestratorTemplate(readFileSync(seedPath, "utf8"), "suppress");
  assert.ok(rendered.includes(SUPPRESS_BULLET), "suppress bullet present");
  assert.ok(!rendered.includes(ALLOW_BULLET), "allow bullet dropped");
  assert.ok(!rendered.includes(MARKER), "if-markers stripped");
  assert.ok(!rendered.includes("forge:endif"), "endif-markers stripped");
});

test("FG-799 (AC4): allow render carries the allow notice and no suppression rule", () => {
  const rendered = renderOrchestratorTemplate(readFileSync(seedPath, "utf8"), "allow");
  assert.ok(rendered.includes(ALLOW_BULLET), "allow bullet present");
  assert.ok(!rendered.includes(SUPPRESS_BULLET), "suppress bullet dropped");
  assert.ok(!rendered.includes(MARKER), "if-markers stripped");
});

test("FG-799 (AC4): a template with no markers is returned byte-identical", () => {
  const plain = "# forge orchestrator\n\n- a bullet\n- another\n";
  assert.equal(renderOrchestratorTemplate(plain, "suppress"), plain);
  assert.equal(renderOrchestratorTemplate(plain, "allow"), plain);
});

// ── AC4: the upgrade re-render flips the installed block when the mode changes ──

test("FG-799 (AC4): re-rendering with the other mode FLIPS the installed block in place", () => {
  const seed = readFileSync(seedPath, "utf8");

  // Install suppress, then simulate `forge upgrade` after `ai_attribution: allow`.
  const suppressBlock = applyOrchestratorBlock("", renderOrchestratorTemplate(seed, "suppress")).content;
  assert.ok(suppressBlock.includes(SUPPRESS_BULLET));
  assert.ok(!suppressBlock.includes(ALLOW_BULLET));

  const flipped = applyOrchestratorBlock(suppressBlock, renderOrchestratorTemplate(seed, "allow"));
  assert.equal(flipped.action, "replaced", "the block is re-rendered, not appended");
  assert.ok(flipped.content.includes(ALLOW_BULLET), "allow notice now present");
  assert.ok(!flipped.content.includes(SUPPRESS_BULLET), "suppression rule gone");

  // Flipping back is symmetric and idempotent.
  const back = applyOrchestratorBlock(flipped.content, renderOrchestratorTemplate(seed, "suppress"));
  assert.equal(back.action, "replaced");
  assert.ok(back.content.includes(SUPPRESS_BULLET));
  const again = applyOrchestratorBlock(back.content, renderOrchestratorTemplate(seed, "suppress"));
  assert.equal(again.action, "unchanged", "re-render with the same mode is a no-op");
});

// ── AC5: provider-set parity between the constraint file and the template ──────

// The canonical widened provider vocabulary. A drift test extracts which of these
// each source names and asserts the two sets are equal — so the constraint text and
// the orchestrator prose can never name different providers.
const VOCAB = ["anthropic", "chatgpt", "claude", "codex", "copilot", "gemini", "openai"] as const;

function providersIn(text: string): string[] {
  const lower = text.toLowerCase();
  return VOCAB.filter((p) => lower.includes(p)).sort();
}

test("FG-799 (AC5): the constraint file and the template suppress block name the SAME provider set", () => {
  const constraint = readFileSync(constraintPath, "utf8");
  const seed = readFileSync(seedPath, "utf8");
  const suppressBlock = renderOrchestratorTemplate(seed, "suppress");

  const constraintProviders = providersIn(constraint);
  const templateProviders = providersIn(suppressBlock);

  assert.deepEqual(
    constraintProviders,
    templateProviders,
    "provider sets drift — the constraint file and orchestrator template must name identical providers",
  );
  // And that set is the full widened vocabulary (not accidentally the empty set).
  assert.deepEqual(constraintProviders, [...VOCAB]);
});
