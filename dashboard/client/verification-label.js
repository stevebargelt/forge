// Pure label-derivation for VerificationRow (main.js), split out so the
// mode/kind matching can be unit-tested with the node test runner — main.js
// itself only runs in-browser via esm.sh imports, with no rendering test
// harness in this project (FG-487 AC7).
//
// `mode` is emitted by src/cli/commands/review-loop.ts's verifyWithEvents as
// "local" | "ci_wait" (underscore — see that file). reviewLoopRunPhases in
// queries.ts already tolerates both "ci-wait" and "ci_wait"; this matches
// that tolerance so the two label sources never diverge again.
export function verificationRowLabel(v) {
  if (v.kind === "campaign_reconcile_gate") return "host gate";
  return v.mode === "ci-wait" || v.mode === "ci_wait" ? "waiting-on-ci" : "verifying";
}
