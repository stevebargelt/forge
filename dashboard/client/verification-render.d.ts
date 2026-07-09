export function verificationOutcomeClass(p: Record<string, unknown> | null | undefined): string;
export function eventBadgeClass(e: { eventType: string; payload?: Record<string, unknown> | null }): string;
export function reviewLoopVerificationDetail(p: Record<string, unknown>): string;
export function hostGateDetail(p: Record<string, unknown>): string;
export function groupVerificationRows<T extends { kind?: string }>(rows: T[] | null | undefined): { loop: T[]; gate: T[] };
export function verificationRowBadge(v: { kind?: string; mode?: string; stale?: boolean }): { class: string; text: string };
export function evidenceState<T>(rows: T[] | null): "prompt" | "empty" | "rows";
