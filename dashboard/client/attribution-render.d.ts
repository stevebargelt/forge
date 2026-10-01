// FG-845: types for client/attribution-render.js.

export interface AttributionViewLike {
  mode: "suppress" | "allow";
  source: "project" | "host" | "default";
  file: string | null;
  reason?: string;
  host: { mode: "suppress" | "allow"; file: string } | null;
  hostFile: string;
  inheritsHost: boolean;
  checkout: string;
}
export interface Choice {
  value: string;
  label: string;
}
export const PROJECT_CHOICES: readonly Choice[];
export const HOST_CHOICES: readonly Choice[];
export function attributionTag(view: AttributionViewLike): { key: "fail_closed" | "project" | "host" | "default"; label: string };
export function attributionCommand(target: "project" | "host", choice: string): string;
export function attributionTargetFile(target: "project" | "host", view: AttributionViewLike): string;
export function currentProjectChoice(view: AttributionViewLike): "suppress" | "allow" | "inherit" | null;
export function currentHostChoice(view: AttributionViewLike): "suppress" | "allow" | null;
export function inheritCount(projects: ReadonlyArray<{ aiAttribution?: AttributionViewLike | null } | null | undefined> | null | undefined): { inherit: number; total: number };
export function confirmOutcome(
  post: () => Promise<{ status: number; body: { ok?: boolean; stdout?: string; error?: string } | null }>,
  command: string,
): Promise<{ ok: boolean; kind: "applied" | "refused" | "transport"; text: string }>;
export function segmentStep(values: readonly string[], current: string, key: string): string | null;
