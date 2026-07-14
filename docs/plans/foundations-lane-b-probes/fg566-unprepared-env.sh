#!/usr/bin/env bash
# FG-566 falsification probe #1 — an UNPREPARED VERIFICATION ENVIRONMENT is
# misclassified as a CODE failure.
#
# Claim under test (three parts, all by EXECUTION, not source-pattern match):
#   (a) A clone at a KNOWN-GREEN SHA, with no node_modules, makes runVerification
#       return ok:false — indistinguishable in shape from broken code.
#   (b) runReviewLoop therefore SHORT-CIRCUITS the reviewer (review-loop.ts:441
#       returns before the deps.review() call at :481) — review never happens.
#   (c) The round is CONSUMED and the FIXER is dispatched with the environment
#       error as if it were a code finding.
#
# The control arm is the load-bearing half: the SAME source, verified in a
# PREPARED environment, is green. So the ok:false in (a) is attributable to the
# environment alone.
#
# Rerun:  bash docs/plans/foundations-lane-b-probes/fg566-unprepared-env.sh
# Requires: this repo checkout (with its node_modules) as the HOST for tsx.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/fg566.XXXXXX")"
trap 'rm -rf "$SCRATCH"' EXIT

echo "=== runtime identity ==="
echo "node        : $(node --version)"
echo "NODE_MODULE_VERSION (ABI): $(node -p 'process.versions.modules')"
echo "platform    : $(node -p 'process.platform + " " + process.arch')"
echo "repo        : $REPO"
echo "repo HEAD   : $(git -C "$REPO" rev-parse HEAD)"
echo

echo "=== step 1: clone the repo at HEAD into a scratch dir, WITHOUT installing deps ==="
git clone --quiet --no-hardlinks --local "$REPO" "$SCRATCH/clone" 2>/dev/null
git -C "$SCRATCH/clone" checkout --quiet "$(git -C "$REPO" rev-parse HEAD)" 2>/dev/null
echo "clone HEAD  : $(git -C "$SCRATCH/clone" rev-parse HEAD)"
echo "same SHA as host repo? : $([ "$(git -C "$SCRATCH/clone" rev-parse HEAD)" = "$(git -C "$REPO" rev-parse HEAD)" ] && echo YES || echo NO)"
echo -n "node_modules present in clone? : "
[ -d "$SCRATCH/clone/node_modules" ] && echo "YES (probe invalid)" || echo "NO  <-- the unprepared environment"
echo -n "package.json present in clone? : "
[ -f "$SCRATCH/clone/package.json" ] && echo "YES (so the scripts ARE discoverable — this is not a 'no checks' case)" || echo "NO"
echo

# The driver imports the REAL runVerification + runReviewLoop from the REAL source
# and executes them. Nothing is stubbed except the reviewer/fixer, which are
# instrumented purely to OBSERVE whether they were dispatched.
cat > "$SCRATCH/driver.mjs" <<DRIVER_HEAD
import { runVerification, runReviewLoop } from "$REPO/src/v2/review-loop.ts";
DRIVER_HEAD
cat >> "$SCRATCH/driver.mjs" <<'DRIVER'

const CLONE = process.env.CLONE_DIR;
const REPO = process.env.REPO_DIR;

// The exact script map review-loop's local fallback would use (fast tier:
// typecheck + test; test:extended is CI's by default — FG-501 AC5).
const scripts = { typecheck: "tsc --noEmit", test: "npm run test:unit" };

console.log("=== step 2: runVerification in the UNPREPARED clone (no node_modules) ===");
const broken = runVerification(scripts, { cwd: CLONE });
console.log("verification.ok :", broken.ok);
for (const s of broken.steps) {
  const first = s.output.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 3).join(" | ");
  console.log(`  step ${s.name.padEnd(10)} ok=${String(s.ok).padEnd(5)} output: ${first.slice(0, 150)}`);
}
console.log();

console.log("=== step 3: CONTROL — runVerification on the SAME SHA in the PREPARED repo ===");
console.log("(typecheck only, to stay bounded; it is the same step that failed above)");
const control = runVerification({ typecheck: "tsc --noEmit" }, { cwd: REPO });
console.log("verification.ok :", control.ok);
for (const s of control.steps) console.log(`  step ${s.name.padEnd(10)} ok=${s.ok}`);
console.log();
console.log(">>> SAME SOURCE. Unprepared env => ok=" + broken.ok + " ; prepared env => ok=" + control.ok);
console.log(">>> The ok:false is attributable to the ENVIRONMENT, not the code.");
console.log();

console.log("=== step 4: drive the REAL runReviewLoop with that unprepared-env verification ===");
let reviewerDispatched = 0;
let fixerDispatched = 0;
let fixerSawFindings = [];

const outcome = await runReviewLoop(
  { maxRounds: 2, ticketId: "FG-566" },
  {
    verify: () => runVerification(scripts, { cwd: CLONE }),
    review: () => {
      reviewerDispatched += 1;
      return { ok: true, verdict: "pass", findings: [] };
    },
    fix: (findings) => {
      fixerDispatched += 1;
      fixerSawFindings = findings;
      return { ok: true, committedSha: "deadbeef" }; // pretend the fixer "fixed" it
    },
  },
);

console.log("stopReason              :", outcome.stopReason);
console.log("closeable               :", outcome.closeable);
console.log("ROUNDS CONSUMED         :", outcome.rounds.length, "of maxRounds=2");
console.log("REVIEWER dispatched     :", reviewerDispatched, reviewerDispatched === 0 ? "  <-- REVIEW NEVER HAPPENED" : "");
console.log("FIXER dispatched        :", fixerDispatched, fixerDispatched > 0 ? "  <-- the fixer got the ENVIRONMENT error as a code finding" : "");
console.log();
console.log("What the fixer was actually asked to fix:");
for (const f of fixerSawFindings) {
  console.log("  - " + f.summary.split("\n").slice(0, 2).join(" / ").slice(0, 180));
}
DRIVER

cd "$REPO"
if ! CLONE_DIR="$SCRATCH/clone" REPO_DIR="$REPO" node --import tsx "$SCRATCH/driver.mjs" 2>&1; then
  echo
  echo "!!! PROBE DRIVER FAILED — no conclusion is claimed. !!!"
  exit 1
fi

echo
echo "=== CONCLUSION ==="
cat <<'EOF'
An unprepared verification environment is INDISTINGUISHABLE from broken code at
the runVerification boundary (review-loop.ts:309-321 returns only {ok, steps} --
there is no environment-readiness channel). runReviewLoop's verification-first
short-circuit (review-loop.ts:441) therefore:
  - never dispatches the reviewer (:481 unreachable on this path),
  - hands the environment error to the FIXER as an unanchored code finding
    (verificationFindings, review-loop.ts:402-406),
  - and CONSUMES a bounded round.
Review that never happened reads as review that failed.
EOF
