export const ENVIRONMENT_UNAVAILABLE_CLASS: string;
export function isReadinessRefusal(p: Record<string, unknown> | null | undefined): boolean;
export function verificationOutcomeClass(p: Record<string, unknown> | null | undefined): string;
export function eventBadgeClass(e: { eventType: string; payload?: Record<string, unknown> | null }): string;
export function eventBadgeText(e: { eventType: string; payload?: Record<string, unknown> | null }): string;
/** FG-566: the readiness preflight's classified outcome as carried on
 *  review_loop.verification_finished. Absent (older events) or null (readiness
 *  never consulted) renders byte-identically to the pre-FG-566 detail line. */
export type ReviewLoopReadiness = {
  outcome?: "prepared" | "reused" | "refused" | "not_required";
  reason?: string | null;
  workspace?: string | null;
  command?: string | null;
  exitStatus?: number | null;
  stderrTail?: string | null;
  message?: string | null;
};
export type ReviewLoopVerificationPayload = Record<string, unknown> & {
  readiness?: ReviewLoopReadiness | null;
};
export function reviewLoopVerificationDetail(p: ReviewLoopVerificationPayload): string;
export function hostGateDetail(p: Record<string, unknown>): string;
export function groupVerificationRows<T extends { kind?: string }>(rows: T[] | null | undefined): { loop: T[]; gate: T[] };
export function verificationRowBadge(v: { kind?: string; mode?: string; stale?: boolean }): { class: string; text: string };
export function evidenceState<T>(rows: T[] | null): "prompt" | "empty" | "rows";
