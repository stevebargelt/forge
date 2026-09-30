// FG-835: types for the Models editor's state (client/models-editor-state.js).

import type { EditorState, Finding, GateAdapter, ProposeResponse } from "./raci-editor-state.js";

export declare const MODELS_EDIT_MODE: string;
export declare const HOST_TARGET: string;
export declare const MODEL_POLICY_GATE: GateAdapter;

export type ModelsScope = { project?: string | null; checkout?: string | null } | null;
export type PolicyTargetView = {
  kind: "host" | "project";
  path: string;
  exists?: boolean;
  sha256?: string | null;
  confirmKey: string;
  project: { key: string; label?: string; checkoutDir: string } | null;
};

export type OutlineEntry = { alias: string; line: number; model: string | null; at: { index: number; start: number; end: number; value: string } | null };
export type OutlineProfile = { name: string; line: number; provider: string | null; auth: string | null; runtime: string | null; entries: OutlineEntry[] };
export type OutlineOverride = { role: string; line: number; profile: string | null; at: { index: number; start: number; end: number } | null };
export type PolicyOutline = {
  ok: boolean;
  reason: string | null;
  schemaVersion?: string | null;
  profiles: OutlineProfile[];
  defaultProfile?: string | null;
  overrides: { style?: string; editable: boolean; reason?: string | null; entries: OutlineOverride[] };
};

export type RowState = {
  profile: string | null; provider: string | null; model: string | null; auth: string | null; runtime: string | null;
  costTier: string | null; outcome: string | null; dispatchable: boolean | null; error: string | null;
};
export type ResolutionRow = { key: string; role: string; activity: string; isDefault: boolean; state: RowState; tags: string[]; tag: string | null; was: string | null };

export declare function modelsEditorMode(params: Record<string, string> | null | undefined): "edit" | "view";
export declare function requestedTarget(params: Record<string, string> | null | undefined, scope: ModelsScope): "host" | "project" | null;
export declare function modelsEditorHash(scope: ModelsScope, opts?: { edit?: boolean; target?: string | null }): string;
export declare function modelPolicyReadUrl(target: "host" | "project", scope: ModelsScope): string;
export declare function roleHarnessHash(role: string, target: PolicyTargetView | null | undefined): string;
export declare function backupReadUrl(target: PolicyTargetView | null | undefined, name: string): string;

export declare function policyOutline(text: string): PolicyOutline;
export declare function yamlScalar(value: string): string;
export declare function setProfileModel(text: string, profile: string, alias: string, model: string): string | null;
export declare function setRoleOverride(text: string, role: string, profile: string | null): string | null;
export declare function lineOfPath(text: string, path: string[], exact?: boolean): number | null;
export declare function locatePolicyFinding(text: string, finding: { code?: string; message: string }): number | null;
export declare function policyFindings(result: any, text: string): Finding[];

export declare function openModelsEditor(read: any, start?: { text: string; origin: string } | null): EditorState;
export declare function quickEdit(state: EditorState, text: string | null): EditorState;
export declare function proposeBody(target: PolicyTargetView, text: string): Record<string, string>;
export declare function applyBody(state: EditorState, target: PolicyTargetView): Record<string, string>;
export declare function applyVerb(target: PolicyTargetView): string;
export declare function settleModelsApply(state: EditorState, response: ProposeResponse): EditorState;
export declare function modelsAppliedResult(body: Record<string, any>): { exitCode: number; verb: string | null; sha: string | null; output: string };

export declare function isUndispatchable(s: Partial<RowState> | null | undefined): boolean;
export declare function rowIsChange(row: any): boolean;
export declare function resolutionRows(current: any[] | null | undefined, lastGreen: { rows?: any[] | null } | null | undefined): ResolutionRow[];
export declare function sideText(s: Partial<RowState> | null | undefined): string;
export declare function proposalDiffRows(result: any): Array<{ key: string; label: string; before: string; after: string; becomesUndispatchable: boolean }>;
export declare function proposalSummary(result: any): { changed: number; newlyUndispatchable: number; preExisting: number; runtimeText: string; authText: string };
export declare function diffSummary(diff: any[] | null | undefined): string;
export declare function policyAuditRows(entries: Array<Record<string, any>> | null | undefined): Array<{ timestamp: string | null; who: string; actor: string | null; change: string; rationale: string | null; sha: string | null }>;
export declare function formatBytes(n: number): string;
export declare function backupRows(entries: Array<Record<string, any>> | null | undefined, maxBytes: number): Array<{ name: string; timestamp: string; sha: string; size: string; blocked: string | null }>;
export declare function modelChoices(outline: PolicyOutline | null | undefined, current: string | null, knownModels: string[] | null | undefined, inForce?: PolicyOutline | null, offered?: Iterable<string> | null): string[];
export declare function addableRoles(outline: PolicyOutline | null | undefined, rows: Array<{ role: string }> | null | undefined): string[];
export declare function policyFacts(read: any): { schemaVersion: string | null; profiles: number; roles: number };
