import { test } from "node:test";
import assert from "node:assert/strict";
import { applyOrchestratorBlock } from "./init.js";

const TEMPLATE = `<!-- forge:orchestrator-start -->
# forge orchestrator
You are the orchestrator.
<!-- forge:orchestrator-end -->`;

const TEMPLATE_V2 = `<!-- forge:orchestrator-start -->
# forge orchestrator (v2)
Different body.
<!-- forge:orchestrator-end -->`;

test("applyOrchestratorBlock: appends to empty CLAUDE.md", () => {
  const out = applyOrchestratorBlock("", TEMPLATE);
  assert.equal(out, TEMPLATE + "\n");
});

test("applyOrchestratorBlock: appends with separator when CLAUDE.md has content", () => {
  const existing = "# my project\n\nSome notes.\n";
  const out = applyOrchestratorBlock(existing, TEMPLATE);
  assert.ok(out.startsWith("# my project"));
  assert.ok(out.includes("Some notes."));
  assert.ok(out.includes("<!-- forge:orchestrator-start -->"));
  assert.ok(out.includes("<!-- forge:orchestrator-end -->"));
});

test("applyOrchestratorBlock: replaces existing block in place", () => {
  const before = `# my project\n\nSome notes.\n\n${TEMPLATE}\n\n## After section\n\nMore content.\n`;
  const out = applyOrchestratorBlock(before, TEMPLATE_V2);
  assert.ok(out.includes("# my project"));
  assert.ok(out.includes("Some notes."));
  assert.ok(out.includes("# forge orchestrator (v2)"));
  assert.ok(!out.includes("# forge orchestrator\n"));  // old block gone
  assert.ok(out.includes("## After section"));
  assert.ok(out.includes("More content."));
});

test("applyOrchestratorBlock: idempotent — replacing block with same content yields same text", () => {
  const once = applyOrchestratorBlock("# project\n\nbody.\n", TEMPLATE);
  const twice = applyOrchestratorBlock(once, TEMPLATE);
  assert.equal(once, twice);
});

test("applyOrchestratorBlock: unbalanced markers throws (only start marker)", () => {
  const corrupt = "<!-- forge:orchestrator-start -->\nbody";
  assert.throws(
    () => applyOrchestratorBlock(corrupt, TEMPLATE),
    /unbalanced/i
  );
});

test("applyOrchestratorBlock: unbalanced markers throws (only end marker)", () => {
  const corrupt = "body\n<!-- forge:orchestrator-end -->\n";
  assert.throws(
    () => applyOrchestratorBlock(corrupt, TEMPLATE),
    /unbalanced/i
  );
});

test("applyOrchestratorBlock: preserves content before AND after the block on update", () => {
  const before = [
    "# project",
    "",
    "## Setup",
    "Some setup notes.",
    "",
    TEMPLATE,
    "",
    "## Conventions",
    "Use ts not js.",
    "",
  ].join("\n");

  const out = applyOrchestratorBlock(before, TEMPLATE_V2);
  assert.ok(out.includes("# project"));
  assert.ok(out.includes("## Setup"));
  assert.ok(out.includes("Some setup notes."));
  assert.ok(out.includes("## Conventions"));
  assert.ok(out.includes("Use ts not js."));
  assert.ok(out.includes("# forge orchestrator (v2)"));
});
