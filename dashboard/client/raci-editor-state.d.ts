// FG-834: types for the Edit RACI state machine (client/raci-editor-state.js).

export declare const DRY_RUN_DEBOUNCE_MS: number;
export declare const RACI_EDIT_MODE: string;
export declare const RACI_SECTIONS: ReadonlyArray<{ id: string; label: string; pattern: RegExp }>;

export type Finding = { code: string; route?: string | null; message: string; line: number | null };
export type ProposeResponse = { status: number; body: Record<string, any> };
export type RouteMap = Record<string, Record<string, any>>;

export interface EditorState {
  mode: "editing" | "proposed" | "applied";
  origin: string;
  baseText: string;
  draft: string;
  dryRun: { seq: number; pending: boolean; text: string | null; ok: boolean | null; findings: Finding[]; error: string | null };
  lastGreen: { text: string; routes?: RouteMap | null; routeChanges?: any; rows?: any[] } | null;
  proposal: { text: string; sha: string; expiresAt: string | null; verb: string | null; result: any } | null;
  proposing: boolean;
  proposeError: { message: string; refusal: string | null; findings: Finding[] } | null;
  confirmKey: string;
  rationale: string;
  applying: boolean;
  applyError: { message: string; refusal: string | null; exitCode: number | null } | null;
  applied?: AppliedResult;
}
export type AppliedResult = { exitCode: number; verb: string | null; sha: string | null; output: string };
export type Readiness = { enabled: boolean; reason: string | null };

export declare function raciEditorMode(params: Record<string, string> | null | undefined): "edit" | "view";
export declare function raciEditorHash(scope: { project?: string | null; checkout?: string | null } | null, edit: boolean): string;
export declare function sectionLine(text: string, sectionId: string, afterLine?: number): number | null;
export declare function lineOfOffset(text: string, offset: number): number;
export declare function offsetOfLine(text: string, line: number): number;
export declare function locateFinding(text: string, finding: { code?: string; route?: string | null; message: string }): number | null;
export declare function gateFindings(result: any, text: string): Finding[];
export declare function openEditor(read: any, origin?: "source" | "host"): EditorState;
export declare function isDirty(state: EditorState | null): boolean;
export declare function editDraft(state: EditorState, text: string): EditorState;
export declare function replaceDraft(state: EditorState, text: string, origin: string): EditorState;
export declare function beginDryRun(state: EditorState, seq: number): EditorState;
export interface GateAdapter {
  isVerdict(result: any): boolean;
  findings(result: any, text: string): Finding[];
  green(text: string, result: any): any;
}
export declare const RACI_GATE: GateAdapter;
export declare function settleDryRun(state: EditorState, seq: number, text: string, response: ProposeResponse, gate?: GateAdapter): EditorState;
export declare function failDryRun(state: EditorState, seq: number, reason: string): EditorState;
export declare function beginPropose(state: EditorState): EditorState;
export declare function settlePropose(state: EditorState, text: string, response: ProposeResponse, gate?: GateAdapter): EditorState;
export declare function failPropose(state: EditorState, reason: string): EditorState;
export declare function setConfirmKey(state: EditorState, value: string): EditorState;
export declare function setRationale(state: EditorState, value: string): EditorState;
export declare function confirmKeyMatches(typed: unknown, key: unknown): boolean;
export declare function minutesLeft(expiresAt: string | null | undefined, now?: number): number | null;
export declare function proposalExpired(expiresAt: string | null | undefined, now?: number): boolean;
export declare function proposalLive(state: EditorState | null): boolean;
export declare function proposeReadiness(state: EditorState): Readiness;
export declare function applyReadiness(state: EditorState, projectKey: string, now?: number, keyNoun?: string): Readiness;
export declare function applyBody(state: EditorState, project: { key: string; checkoutDir: string }): Record<string, string>;
export declare function beginApply(state: EditorState): EditorState;
export declare function settleApply(state: EditorState, response: ProposeResponse): EditorState;
export declare function failApply(state: EditorState, reason: string): EditorState;
export declare function appliedResult(body: Record<string, any>): AppliedResult;
export declare function effectiveRows(current: RouteMap | null, candidate: RouteMap | null): Array<{ key: string; route: Record<string, any>; tag: "added" | "changed" | "removed" | null; wasResponsible: string | null }>;
export declare function visibleRows<T extends { tag: string | null }>(rows: T[], head?: number): { shown: T[]; hidden: number };
export declare function routeChangeCounts(changes: any): { added: number; changed: number; removed: number };
export declare function forceRuleCheck(result: any, routes: RouteMap | null | undefined): { ok: boolean; text: string };
export declare function diffLines(raciDiff: string | null | undefined): Array<{ text: string; kind: "add" | "del" | "ctx" }>;
export declare function auditRows(entries: Array<Record<string, any>> | null | undefined): Array<{ timestamp: string | null; who: string; action: string; change: string; rationale: string | null; sha: string | null }>;

export interface DryRunner {
  schedule(text: string): void;
  now(text: string): Promise<void>;
  cancel(): void;
}
export declare function createDryRunner(options: {
  post: (text: string, signal: AbortSignal) => Promise<ProposeResponse>;
  onStart: (seq: number, text: string) => void;
  onSettle: (seq: number, text: string, response: ProposeResponse) => void;
  onFail: (seq: number, text: string, reason: string) => void;
  delayMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: any) => void;
}): DryRunner;
