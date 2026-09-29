// FG-823: types for the pure dismiss/snooze helpers (attention-dismiss-render.js).

export type AttentionRowAction = "dismiss" | "snooze" | "undismiss";

export const SNOOZE_PRESETS: readonly string[];
export const ATTENTION_ACTIONS: readonly AttentionRowAction[];

export function attentionRoute(itemId: string, action: AttentionRowAction): string;
export function attentionCommand(itemId: string, action: AttentionRowAction, until?: string | null): string;
export function attentionRequest(
  itemId: string,
  action: AttentionRowAction,
  input?: { until?: string | null; rationale?: string },
): { ok: true; route: string; body: { until?: string; rationale?: string } } | { ok: false; error: string };
export function attentionResult(status: number, body: unknown, command: string): { ok: boolean; line: string; detail: string | null };
