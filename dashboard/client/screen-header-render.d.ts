export interface ScreenHeader {
  happening: string;
  needsYou: boolean;
  needs: string;
  todo: string;
  verb: string | null;
}
export function attentionForTask(load: unknown, taskId: string): Record<string, unknown> | null;
export function attentionForRun(load: unknown, runId: string): Record<string, unknown> | null;
export function taskHeader(detail: unknown, load: unknown, options?: { explain?: boolean }): ScreenHeader;
export function runHeader(graph: unknown, load: unknown): ScreenHeader;
export function ticketHeader(ticketId: string, ticket: { status: string } | null, runsLoad: { runs: unknown[] | null } | null): ScreenHeader;
export function reviewHeader(review: { id: string; state: string } | null, nextAction: string | null): ScreenHeader;
export function noteHeader(row: { label: string } | null): ScreenHeader;
export function runsIndexHeader(load: unknown): ScreenHeader;
export function listHeader(view: string): ScreenHeader | null;
export const LIST_HEADER_VIEWS: string[];
export function listScreenLine(view: string, runsLoad: unknown): ScreenHeader | null;
export function screenLineText(header: ScreenHeader | null): string;
