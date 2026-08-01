// FG-578 (criterion 7): the INSTALLER and the DETECTOR cannot disagree about who
// owns a seed.
//
// The write policy lives in scripts/install-seeds.sh (the writer — FORCE is a
// published operator-facing contract that four documented entry points invoke
// directly, so a guard in the `forge upgrade` caller would protect one of them).
// The read policy lives in seed-drift.ts's SEED_SPECS, which has classified
// agents/constraints/raci as operator-authored + prose — "may carry local
// edits → warn, never auto-overwrite" — since FG-335. Those are the same fact
// stated in two languages, and the shell/TS boundary makes literal sharing
// impractical. So the agreement is a GATE, not a comment asking someone to
// remember.
//
// This is not hypothetical bookkeeping. Hand-maintained parallel lists drift,
// and the two ownership sets MUST stay identical; this gate catches any
// divergence. If they ever diverge, the failure is silent and exactly inverted
// — the detector warns "we would never overwrite this" about a file the
// installer just clobbered, or forge retains a file it tells the operator
// `forge upgrade` will refresh. Either way the operator is told a true-sounding
// thing about a host that is in the other state.
//
// asset-root-agreement.test.ts is the prior art: read the REAL artifact, don't
// re-declare it here — a test that restates both sides agrees with itself.
//
// SAFETY: read-only. This file parses the installer's source text and calls a
// pure function. It executes nothing and writes nothing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assetRoot } from "./asset-root.js";
import { authoredCategories, autoRefreshableCategories } from "./seed-drift.js";
import { COVERED_ROLES } from "./agent-protocol.js";
import { RISK_LENSES, lensRole } from "./review-contract.js";

const INSTALL_SCRIPT = join(assetRoot(), "scripts", "install-seeds.sh");

/** Read the installer's ONE greppable ownership declaration out of its source.
 *  Deliberately strict: an AUTHORED_EXEMPT that has been renamed, computed, or
 *  scattered back into per-call-site literals fails HERE rather than silently
 *  parsing to an empty set and letting every assertion below pass vacuously. */
export function parseAuthoredExempt(script: string): string[] {
  const m = /^AUTHORED_EXEMPT=\(([^)]*)\)\s*$/m.exec(script);
  assert.ok(m, "install-seeds.sh must carry ONE greppable `AUTHORED_EXEMPT=(...)` declaration");
  return m[1]!.trim().split(/\s+/).filter((s) => s.length > 0).sort();
}

test("FG-578: the installer's AUTHORED_EXEMPT is exactly seed-drift's non-auto-refreshable set", () => {
  const exempt = parseAuthoredExempt(readFileSync(INSTALL_SCRIPT, "utf8"));

  // The whole gate, in one line. Perturb EITHER side — drop `constraints` from
  // AUTHORED_EXEMPT in the shell, or reclassify `agents` as forge-owned in
  // SEED_SPECS — and this fails naming both sets.
  assert.deepEqual(
    exempt,
    authoredCategories(),
    "the installer's exempt set and the detector's warn-never-overwrite set are the same fact; they must be the same set",
  );

  // Guard against the vacuous pass: an empty declaration on both sides would
  // satisfy deepEqual while meaning "forge owns everything" — the pre-FG-578
  // behaviour, agreeing with itself.
  assert.deepEqual(exempt, ["agents", "constraints", "raci"], "the decided set (audit HIGH-2), pinned literally so silently emptying both sides fails");
});

test("FG-578: no category is both operator-authored and forge-refreshable", () => {
  // The two sets partition SEED_SPECS, so an overlap is a contradiction the
  // installer would have to resolve by guessing. `runtimes` in particular MUST
  // stay refreshable: a stale pi-apikey.yml silently rebinds the provider (#265),
  // which is the failure the drift detector was built for, and exempting it would
  // fix FG-578 by breaking FG-335.
  const authored = authoredCategories();
  const refreshable = autoRefreshableCategories();
  assert.deepEqual(authored.filter((c) => refreshable.includes(c)), [], "a category cannot be owned by both");
  assert.ok(refreshable.includes("runtimes"), "runtimes are forge-owned execution artifacts — FORCE must still refresh them");
  assert.ok(!authored.includes("runtimes"));
});

test("FG-578: the installer routes every seed category through the ownership policy, not around it", () => {
  const script = readFileSync(INSTALL_SCRIPT, "utf8");

  // The failure mode this catches: someone adds a category with a fresh copy of
  // the old `FORCE=1 || ! -e` predicate beside the policy rather than through it.
  // The exemption is then live for the categories that route through
  // seed_install_file and dead for the new one — and the gate above still passes,
  // because the DECLARATION is fine. Only the writer's shape can see this.
  //
  // model-policy.example.yml keeps its own predicate legitimately: it installs
  // under a deliberately non-ACTIVE name precisely so overwriting it can never
  // flip behaviour, which is the discipline the RACI escaped. It is the one
  // allowed instance, so it is named rather than pattern-matched around.
  const rawPredicates = script
    .split("\n")
    .filter((l) => /FORCE:-0/.test(l) && !/^\s*#/.test(l));
  assert.equal(rawPredicates.length, 2, `exactly two FORCE predicates may exist: seed_install_file's, and model-policy.example.yml's non-active-name install. Found:\n${rawPredicates.join("\n")}`);

  // The authored categories must be the ARGUMENT of a real install call, not just
  // a word in a comment: this is what makes the declaration load-bearing.
  for (const category of authoredCategories()) {
    assert.match(
      script,
      new RegExp(`(install_category|seed_install_file)[^\\n]*\\s${category}\\s*$`, "m"),
      `${category} must be installed THROUGH the ownership-aware writer`,
    );
  }
});

// ─── FG-654: the coverage agreement ─────────────────────────────────────────
//
// The protocol is no longer a region inside an operator seed — it is a forge-owned seed
// GENERATION category (seeds/agent-protocols/<role>.md), published by the same atomic
// mechanism as workflows and runtimes. The installer is therefore untouched by FG-654
// and `agents` is once again wholly operator-authored, whole-file, which the partition
// assertions above already hold. What still needs holding is COVERAGE: every role the
// review lifecycle actually dispatches must have a protocol, or it dispatches a reviewer
// that was never told the contract its output is judged by.

test("FG-654: every review-lifecycle dispatch role in the REAL dispatch sites is in COVERED_ROLES", () => {
  // Parsed out of the artifacts, not restated here — a hand-maintained registry is the
  // same defect class as a seed that drifts silently. The coordinator family dispatches
  // through review-wiring's `agentRole:` literals; the shipping-reviewer is a
  // workflow-declared red, a different family, and is named in runNext.
  const wiring = readFileSync(join(assetRoot(), "src", "cli", "commands", "review-wiring.ts"), "utf8");
  const dispatched = new Set<string>();
  for (const m of wiring.matchAll(/agentRole:\s*"([a-z0-9-]+)"/g)) dispatched.add(m[1]!);
  // The lens dispatch passes `agentRole: lensCtx.role` (the five lens roles, resolved
  // from review-contract's own map), so those come from the derived half.
  assert.ok(
    /agentRole:\s*lensCtx\.role/.test(wiring),
    "review-wiring must still dispatch lenses by their contract-resolved role — if this moved, the derived half of COVERED_ROLES is no longer anchored to a real dispatch site",
  );
  for (const lens of RISK_LENSES) dispatched.add(lensRole(lens));

  const runNext = readFileSync(join(assetRoot(), "src", "v2", "runNext.ts"), "utf8");
  assert.ok(
    /"shipping-reviewer"/.test(runNext),
    "runNext must still name the shipping-reviewer — it is the workflow-red dispatch family",
  );
  dispatched.add("shipping-reviewer");

  for (const role of dispatched) {
    assert.ok(
      COVERED_ROLES.includes(role),
      `${role} is dispatched by the review lifecycle but is NOT in COVERED_ROLES — it would run whatever protocol its seed happens to carry, unchecked and unrecorded`,
    );
  }
  // Guard against the vacuous pass.
  assert.ok(dispatched.size >= 9, `expected at least the nine covered roles, parsed ${dispatched.size}`);

  // And every one of them has a protocol in the release to be dispatched WITH.
  for (const role of COVERED_ROLES) {
    const path = join(assetRoot(), "seeds", "agent-protocols", `${role}.md`);
    assert.ok(existsSync(path), `${role}: this release carries no ${path}`);
    const text = readFileSync(path, "utf8");
    assert.ok(text.trim().length > 0, `${role}: its protocol file is empty`);
    assert.ok(text.startsWith("## "), `${role}: its protocol must start at a section heading`);
  }
});
