// FG-523 (F19): the tests_run contract, enforced at ingestion.
//
// Implementer seeds require `tests_run` on a `status: complete` result and the
// orchestrator's gate discipline treats a missing value as a reject — but the
// runner used to advance such a result silently. This module is the ONE place
// that decides whether a primary result satisfies the validation contract.
//
// Coverage: workflow PRIMARY results, via finalizePrimary (runNext.ts) — its
// only caller. Nothing else re-enters a held task: gate.ts's advance IS the
// human override, `forge retry` only re-enters failed tasks, and reconcile
// never completes a workflow primary (it fails them unfinalized).
//
// Two ingestion paths complete an implementer result WITHOUT this evaluator,
// both knowingly:
//   - `forge invoke` ad-hoc completions call markTaskComplete directly
//     (invoke.ts). Ungated for now — a human/orchestrator reads every invoke
//     result. Whether to gate it is FG-525.
//   - Fanout implementer CHILDREN finalize via markTaskComplete, not
//     finalizePrimary, so the contract does not see them. Deferred as FG-524.
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
