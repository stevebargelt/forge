import type { ProviderFailureAnalysis } from "./provider-failure.js";
import { requiresStructuredResult } from "./role-capabilities.js";

export type InferredResult = { contract: "inferred"; summary: string; status: "complete" };

/** FG-337: clean completion + captured assistant text + narrative role →
 *  synthesize an inferred result instead of hard-failing. Shared by the
 *  dispatch-time paths (invoke.ts, runNext.ts) and reconcile.ts's post-crash
 *  stdout-recovery attempt (FG-455) — same eligibility rule everywhere. */
export function inferredResultFrom(
  a: ProviderFailureAnalysis,
  role: string | undefined,
): InferredResult | undefined {
  if (a.modelError || !a.finalAssistantText) return undefined;
  if (role === undefined || requiresStructuredResult(role)) return undefined;
  return { contract: "inferred", summary: a.finalAssistantText, status: "complete" };
}
