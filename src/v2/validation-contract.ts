// FG-523 (F19): the tests_run contract, enforced at ingestion.
//
// Implementer seeds require `tests_run` on a `status: complete` result and the
// orchestrator's gate discipline treats a missing value as a reject — but the
// runner used to advance such a result silently. This module is the ONE place
// that decides whether a primary result satisfies the validation contract.
//
// Coverage: workflow PRIMARY results, via holdIfValidationContractFails
// (runNext.ts) — its only caller, run BEFORE reds dispatch so a held result can
// never be re-labelled blocked_by_red by an authoritative red fail. Nothing else
// re-enters a held task: gate.ts's advance IS the human override, `forge retry`
// only re-enters failed tasks, and reconcile never completes a workflow primary
// (it fails them unfinalized).
//
// Two further ingestion paths complete an implementer result WITHOUT going
// through finalizePrimary. FG-524 routes both through THIS evaluator — the one
// {held, reason} outcome — and differs only in the CALLER's response, never in
// the reading of the contract:
//   - Fanout implementer CHILDREN finalize via markTaskComplete, not
//     finalizePrimary. Each completed child is evaluated once here; if any child
//     is held, the fanout PARENT lands `awaiting_gate` with a reason naming the
//     offending child(ren), before the step's reds run. Recovery verb:
//     `forge gate <parentId> --advance` re-enters dispatch and runs the reds in
//     EITHER mode — that is the invariant the hold protects. What re-entry does with
//     the children's work is mode-dependent: in worktree mode their work lives only
//     on a captured, unpublished integration branch, so advance republishes the
//     retained children with the reds folded into the publisher's validation span;
//     in non-worktree mode the children wrote directly to projectDir, so there is
//     nothing to publish and advance runs the reds against projectDir and completes
//     in place (landing `blocked_by_red` if a red rejects). (FG-524)
//   - `forge invoke` ad-hoc completions call markTaskComplete directly
//     (invoke.ts). Policy is WARN, not hold: an implementer completion that fails
//     the contract still completes, but the evaluator's named reason is emitted
//     on the read surface the orchestrator consumes programmatically between
//     turns. WARN (not hold) because a held ad-hoc invoke has no workflow run to
//     advance through, so it would strand with no recovery verb; the earlier
//     "a human reads every invoke result" premise is stale under unattended
//     `forge launch run` (tmux-owned, detached). (was FG-525, absorbed into FG-524)
//
// Fail-safe direction: a held task lands `awaiting_gate` with a named reason.
// Over-holding is recoverable (forge gate --advance/--reject); a silent advance
// is not.
//
// Role membership mirrors role-capabilities.ts: there is no central role
// registry in the TS layer (roles are declared in seeds/agents/<name>/), so a
// closed Set behind the single evaluator is the smallest mechanism that keeps
// the rule in one place. Reds, test-engineer, docs, research, manual-qa,
// architect, tech-lead and prompt-author are NOT subject to this gate.
const IMPLEMENTER_ROLES = new Set([
  "engineer",
  "frontend-specialist",
  "backend-specialist",
  "security-advisor",
  "agentic-platform-builder",
]);

export type ValidationContractOutcome =
  | { held: true; reason: string }
  | { held: false; waiver?: string };

// The waiver field. Seeds today tell an implementer with no validation path to
// return status:"failed" — a complete result claiming no validation path must
// say so in this ONE field, or it is held.
export const WAIVER_FIELD = "no_validation_reason";

export function evaluateValidationContract(args: {
  role: string;
  result: unknown;
}): ValidationContractOutcome {
  if (!IMPLEMENTER_ROLES.has(args.role)) return { held: false };

  // A missing/unparseable result is an infra failure, handled by the dispatch
  // and persistence paths — never convert one into a validation hold.
  const result = args.result;
  if (result === null || typeof result !== "object" || Array.isArray(result)) return { held: false };

  const record = result as Record<string, unknown>;
  if (record["status"] !== "complete") return { held: false };

  const waiver = record[WAIVER_FIELD];
  if (typeof waiver === "string" && waiver.trim() !== "") return { held: false, waiver: waiver.trim() };

  const testsRun = record["tests_run"];
  if (typeof testsRun === "number" && Number.isFinite(testsRun) && testsRun > 0) return { held: false };

  const observed = testsRun === undefined ? "no tests_run" : `tests_run=${JSON.stringify(testsRun)}`;
  return {
    held: true,
    reason:
      `validation contract: ${args.role} returned status=complete with ${observed} ` +
      `and no ${WAIVER_FIELD} waiver — held for a gate decision`,
  };
}
