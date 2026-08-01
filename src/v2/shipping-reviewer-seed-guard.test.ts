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
import { publishAgentProtocolRegions, readProtocolRegion, resolveAgentProtocol } from "./agent-protocol.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const seedPath = join(
  repoRoot,
  "seeds",
  "agents",
  "shipping-reviewer",
  "CLAUDE.md",
);

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
// FG-654. Every assertion above reads the REPO seed. They were all green on a
// host whose dispatched shipping-reviewer read a 40-lines-behind copy out of
// $FORGE_HOME — that gap is exactly how FG-654 shipped.
//
// A hermetic suite cannot assert the developer's real ~/.forge is current: the
// suite's $FORGE_HOME is provisioned by src/test-setup.ts copying these seeds,
// so `resolveAgentProtocol(role)` against it compares a byte-copy with its own
// source and is green on every host — including the reporting one. That is the
// blind spot, not a guard against it. What IS falsifiable is below: the
// publisher converges a home, and the resolver goes RED on installed drift with
// the repo seed untouched. `forge doctor` answers it for a real host.
// ---------------------------------------------------------------------------

test("FG-654: publishing converges a home's region, and the guard goes RED on installed drift", () => {
  const home = mkdtempSync(join(tmpdir(), "forge-fg654-shipping-"));
  publishAgentProtocolRegions({ forgeHome: home, seedsDir: join(repoRoot, "seeds") });
  assert.ok(resolveAgentProtocol("shipping-reviewer", { forgeHome: home }).ok, "after publish, dispatch must resolve");

  // The exact blind spot, exercised: the repo seed is never touched here.
  const installed = readFileSync(seedPath, "utf8");
  const read = readProtocolRegion(installed);
  assert.equal(read.kind, "fenced", "the repo seed must carry a balanced fence to mutate against");
  if (read.kind === "fenced") {
    writeFileSync(
      join(home, "agents", "shipping-reviewer", "CLAUDE.md"),
      installed.replace(read.region, `${read.region}\n\nA LOCAL EDIT INSIDE THE FORGE REGION`),
    );
  }
  const mutated = resolveAgentProtocol("shipping-reviewer", { forgeHome: home });
  assert.equal(mutated.ok, false, "a mutated INSTALLED region must be detected with a pristine repo seed");
  if (!mutated.ok) assert.equal(mutated.reason, "stale");

  // And the measured 2026-07-31 shape: a pre-FG-654 seed with no fence at all.
  writeFileSync(join(home, "agents", "shipping-reviewer", "CLAUDE.md"), "# shipping-reviewer\n\n40 lines behind\n");
  const unfenced = resolveAgentProtocol("shipping-reviewer", { forgeHome: home });
  assert.equal(unfenced.ok, false);
  if (!unfenced.ok) assert.equal(unfenced.reason, "installed_unfenced");
  rmSync(home, { recursive: true, force: true });
});

test("FG-654: the rubric this file guards lives INSIDE the Forge-owned region, so upgrade converges it", () => {
  const read = readProtocolRegion(readFileSync(seedPath, "utf8"));
  assert.equal(read.kind, "fenced");
  if (read.kind === "fenced") {
    const region = read.region.toLowerCase();
    // If the operator-contract rubric ever moved OUTSIDE the fence it would become
    // retained-forever operator prose, and this whole guard would go back to pinning
    // bytes no host is required to have.
    assert.ok(region.includes("operator-contract") || region.includes("operator contract"));
    assert.ok(region.includes("done-audit") || region.includes("done audit"));
  }
});
