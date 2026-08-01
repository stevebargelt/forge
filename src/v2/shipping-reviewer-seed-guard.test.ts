// FG-421: Regression guard for shipping-reviewer operator-contract rubric.
//
// The reviewer must explicitly check whether operator-contract claims are
// enforced in the production call path and leave durable persisted evidence.
// Guard the seed so a future edit cannot quietly drop this rubric.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveAgentProtocol } from "./agent-protocol.js";
import { publishTestGeneration } from "./seed-generation.testkit.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
// FG-654: the rubric this file guards is the FORGE-OWNED protocol, which now lives in
// its own generation-published file rather than inside the operator's seed.
const seedPath = join(repoRoot, "seeds", "agent-protocols", "shipping-reviewer.md");
const operatorSeedPath = join(repoRoot, "seeds", "agents", "shipping-reviewer", "CLAUDE.md");

// ---------------------------------------------------------------------------
// 1. Operator-contract enforcement language is present
// ---------------------------------------------------------------------------

test("shipping-reviewer CLAUDE.md: contains operator-contract enforcement language", () => {
  const md = readFileSync(seedPath, "utf8").toLowerCase();

  const enforcementPhrases = [
    "operator-contract",
    "enforces the requirement",
    "rejected when the required element is absent",
  ];

  for (const phrase of enforcementPhrases) {
    assert.ok(
      md.includes(phrase),
      `shipping-reviewer CLAUDE.md must contain operator-contract enforcement language '${phrase}' (FG-421)`,
    );
  }
});

// ---------------------------------------------------------------------------
// 2. Persisted decision record is required (not docs/console-only)
// ---------------------------------------------------------------------------

test("shipping-reviewer CLAUDE.md: requires decision record to be persisted, not docs/console-only", () => {
  const md = readFileSync(seedPath, "utf8").toLowerCase();

  assert.ok(
    md.includes("durably persisted"),
    "shipping-reviewer CLAUDE.md must require durable persistence of the decision record (FG-421)",
  );

  assert.ok(
    md.includes("log line is not a persistent record") ||
      md.includes("not only mentioned in session notes"),
    "shipping-reviewer CLAUDE.md must explicitly state that docs/console/log output is not a persistent record (FG-421)",
  );
});

// ---------------------------------------------------------------------------
// 3. Both rejection path AND success path tests are required
// ---------------------------------------------------------------------------

test("shipping-reviewer CLAUDE.md: requires both missing-record-rejection and valid-record tests", () => {
  const md = readFileSync(seedPath, "utf8").toLowerCase();

  assert.ok(
    md.includes("rejection path") && md.includes("success path"),
    "shipping-reviewer CLAUDE.md must require both the rejection path (missing record → error) and success path (valid record → accepted) tests (FG-421)",
  );
});

// ---------------------------------------------------------------------------
// 4. FG-420 golden guard: force/rationale enforcement check is named
// ---------------------------------------------------------------------------

test("shipping-reviewer CLAUDE.md: names the --force/--rationale enforcement check (FG-420 shape)", () => {
  const md = readFileSync(seedPath, "utf8").toLowerCase();

  assert.ok(
    md.includes("--force") && md.includes("--rationale"),
    "shipping-reviewer CLAUDE.md must name the --force/--rationale enforcement check so the FG-420 failure shape cannot silently drop out (FG-421)",
  );

  assert.ok(
    md.includes("fg-420"),
    "shipping-reviewer CLAUDE.md must reference FG-420 as a named golden guard for the force/rationale pattern (FG-421)",
  );
});

// ---------------------------------------------------------------------------
// 5. Production-path tracing emphasis (not mapper/seed/docs-only)
// ---------------------------------------------------------------------------

test("shipping-reviewer CLAUDE.md: emphasizes production-path tracing for operator-contract checks", () => {
  const md = readFileSync(seedPath, "utf8").toLowerCase();

  assert.ok(
    md.includes("mapper-only, seed-only, or docs-only evidence does not confirm enforcement"),
    "shipping-reviewer CLAUDE.md must state that mapper/seed/docs-only evidence does not confirm operator-contract enforcement (FG-421)",
  );
});

// ---------------------------------------------------------------------------
// 6. Scope guard: check is bounded to operator-contract tickets
// ---------------------------------------------------------------------------

test("shipping-reviewer CLAUDE.md: scope guard limits check to operator-contract tickets", () => {
  const md = readFileSync(seedPath, "utf8").toLowerCase();

  assert.ok(
    md.includes("do not inspect every cli command on every run"),
    "shipping-reviewer CLAUDE.md must explicitly state the scope guard — do not inspect every CLI command on every run (FG-421)",
  );
});

// ---------------------------------------------------------------------------
// 7. Concept-level enforcement guard: runtime check + rejection on absence
//    (survivability guard for test 1's verbatim phrases — e.g. "enforces the
//    requirement" / "rejected when the required element is absent")
// ---------------------------------------------------------------------------

test("shipping-reviewer CLAUDE.md: enforcement concept guard — runtime check that rejects when required element absent", () => {
  const md = readFileSync(seedPath, "utf8").toLowerCase();

  // Concept: enforcement must happen at RUNTIME in the command/API path — not
  // merely documented. Check for the enforcement stem + context tokens.
  const hasRuntimeEnforcement =
    (md.includes("enforce") || md.includes("enforced") || md.includes("enforces")) &&
    (md.includes("runtime") ||
      md.includes("call path") ||
      md.includes("command") ||
      md.includes("api path"));

  assert.ok(
    hasRuntimeEnforcement,
    "shipping-reviewer CLAUDE.md must state enforcement is at runtime in the command/API path — concept guard, survives synonym rewrites of test 1 (FG-421)",
  );

  // Concept: calls are rejected/blocked when the required element is absent/missing.
  const hasRejectionOnAbsence =
    (md.includes("reject") || md.includes("error") || md.includes("blocks")) &&
    (md.includes("absent") || md.includes("missing"));

  assert.ok(
    hasRejectionOnAbsence,
    "shipping-reviewer CLAUDE.md must state that the call is rejected when the required element is absent — concept guard, survives synonym rewrites of test 1 (FG-421)",
  );
});

// ---------------------------------------------------------------------------
// 8. FG-420 golden guard concept: --force WITHOUT --rationale is REJECTED
//    Test 4 only checks co-presence of the flags; this guards the relationship
//    that --force alone (no --rationale) must be actively rejected.
// ---------------------------------------------------------------------------

test("shipping-reviewer CLAUDE.md: FG-420 concept guard — --force without --rationale is rejected, not just mentioned", () => {
  const md = readFileSync(seedPath, "utf8").toLowerCase();

  // The critical FG-420 concept: --force WITHOUT --rationale is REJECTED.
  // A seed that merely lists both flags but removes "without ... rejected"
  // would pass test 4 yet silently drop the FG-420 enforcement check.
  assert.ok(
    md.includes("without") &&
      (md.includes("--rationale") || md.includes("rationale")) &&
      (md.includes("rejected") || md.includes("reject")),
    "shipping-reviewer CLAUDE.md must guard that --force WITHOUT --rationale is REJECTED — the specific FG-420 failure shape (concept guard, FG-421)",
  );
});

// ---------------------------------------------------------------------------
// 9. Production-path tracing concept guard
//    (survivability guard for test 5's verbatim phrase — "mapper-only,
//    seed-only, or docs-only evidence does not confirm enforcement")
// ---------------------------------------------------------------------------

test("shipping-reviewer CLAUDE.md: production-path concept guard — seed/mapper/docs evidence does not confirm enforcement", () => {
  const md = readFileSync(seedPath, "utf8").toLowerCase();

  // Concept: evidence from seed, mapper, or docs alone is insufficient to
  // confirm operator-contract enforcement. Survives synonym rewrites of test 5.
  const hasInsufficientEvidence =
    (md.includes("seed") || md.includes("mapper") || md.includes("docs")) &&
    (md.includes("not confirm") ||
      md.includes("does not confirm") ||
      md.includes("not sufficient") ||
      md.includes("insufficient"));

  assert.ok(
    hasInsufficientEvidence,
    "shipping-reviewer CLAUDE.md must state that seed/mapper/docs evidence alone does not confirm enforcement — concept guard, survives synonym rewrites of test 5 (FG-421)",
  );
});

// ---------------------------------------------------------------------------
// 10. Scope guard concept: check is triggered by ticket language, not default
//     (survivability guard for test 6's verbatim phrase — "do not inspect
//     every cli command on every run")
// ---------------------------------------------------------------------------

test("shipping-reviewer CLAUDE.md: scope guard concept — check bounded to operator-contract tickets, not run by default", () => {
  const md = readFileSync(seedPath, "utf8").toLowerCase();

  // Concept: the operator-contract enforcement check is ONLY triggered when a
  // ticket/design explicitly makes operator-contract claims — not on every run.
  const hasBoundedScope =
    (md.includes("only when") || md.includes("apply this check") || md.includes("scope")) &&
    (md.includes("operator-contract") || md.includes("operator contract"));

  assert.ok(
    hasBoundedScope,
    "shipping-reviewer CLAUDE.md must bound the check to tickets making operator-contract claims — concept guard, survives synonym rewrites of test 6 (FG-421)",
  );
});

// ---------------------------------------------------------------------------
// FG-654. Every assertion above reads the REPO's protocol file. That is now the
// right unit: since FG-654 the protocol is forge-owned and published atomically,
// so a host either has these exact bytes or is refused by name — the repo-vs-
// installed gap that let a 40-lines-behind reviewer dispatch is closed by
// construction rather than by a guard. What the repo assertions cannot say is
// that the refusal actually fires, which is what these assert.
// ---------------------------------------------------------------------------

test("FG-654: the shipping-reviewer's protocol publishes into a generation and resolves", () => {
  const home = mkdtempSync(join(tmpdir(), "forge-fg654-shipping-"));
  const gen = publishTestGeneration(home, { assetsParent: home });
  const resolved = resolveAgentProtocol("shipping-reviewer", gen);
  assert.ok(resolved.ok, "after publish, dispatch must resolve the shipping-reviewer's protocol");
  if (resolved.ok) {
    assert.equal(resolved.text, readFileSync(seedPath, "utf8"), "the published bytes are the repo's bytes");
  }
  rmSync(home, { recursive: true, force: true });
});

test("FG-654: protocol bytes edited INSIDE the published generation refuse as tampered", () => {
  const home = mkdtempSync(join(tmpdir(), "forge-fg654-shipping-tamper-"));
  const gen = publishTestGeneration(home, { assetsParent: home });
  writeFileSync(
    join(gen.root, "agent-protocols", "shipping-reviewer.md"),
    `${readFileSync(seedPath, "utf8")}\n\nA LOCAL EDIT INSIDE THE FORGE-OWNED PROTOCOL\n`,
  );
  const resolved = resolveAgentProtocol("shipping-reviewer", gen);
  assert.equal(resolved.ok, false, "a hand-edited protocol inside the generation must be refused");
  if (!resolved.ok) assert.equal(resolved.reason, "protocol_tampered");
  rmSync(home, { recursive: true, force: true });
});

test("FG-654: the rubric this file guards lives in the FORGE-OWNED protocol, not the operator seed", () => {
  // If the operator-contract rubric ever moved into the operator's own file it would
  // become retained-forever prose no host is required to have, and this whole guard
  // would go back to pinning bytes that never reach a dispatched reviewer.
  const protocol = readFileSync(seedPath, "utf8").toLowerCase();
  assert.ok(protocol.includes("operator-contract") || protocol.includes("operator contract"));
  assert.ok(protocol.includes("done-audit") || protocol.includes("done audit"));
  const operator = readFileSync(operatorSeedPath, "utf8");
  assert.ok(
    !operator.includes("<!-- forge:agent-protocol-"),
    "the operator seed must carry no leftover protocol marker",
  );
});
