export interface RoleTab {
  id: string;
  label: string;
}
export interface PromptSection {
  kind: string;
  id?: string;
  title: string;
  start: number;
  end: number;
}
export interface RoleInstructions {
  ok: boolean;
  prompt?: string;
  sections?: PromptSection[];
}
export const ROLE_TABS: readonly RoleTab[];
export function roleTabLabel(tab: string | null | undefined): string;
export function roleTabs(role: string, current: string): Array<RoleTab & { href: string; current: boolean }>;
export function tabCaption(detail: Record<string, unknown> | null | undefined, tab: string): string;
export function roleHeader(
  role: string,
  detail: { overview?: { recentTasks?: Array<{ status: string }> } } | null | undefined,
): { happening: string; needsYou: boolean; needs: string; todo: string; verb: string | null };
export function instructionSections(instructions: RoleInstructions | null | undefined): Array<{ kind: string; id: string | null; title: string; text: string }>;
export function percent(rate: number | null | undefined): string;
export function tokens(n: number | null | undefined): string;
export function relationLabel(relations: string[] | null | undefined): string;
export function shortSha(sha: string | null | undefined): string;
export function authLabel(auth: string | null | undefined): string;
export const HARNESS_COLUMNS: ReadonlyArray<readonly [string, string]>;
export function harnessRows(harness: { activities?: Array<Record<string, unknown>> } | null | undefined): Array<{ activity: string; isDefault: boolean; error: string | null; mappingSummary: string | null; cells: Record<string, string> }>;
export function skillSourceLabel(source: string | null | undefined): string;
export function skillChips(role: string, names: string[] | null | undefined): Array<{ name: string; href: string }>;
export function latestTaskCard(
  overview: { latestTask?: { taskId: string; runId: string; runTitle: string | null; status: string; createdAt: string } | null } | null | undefined,
  now?: number,
): { taskId: string; href: string; runHref: string; runLabel: string; token: { label: string; tone: string; class: string; known: boolean }; when: string; title: string } | null;
export const USAGE_PERIODS: readonly string[];
export const DEFAULT_USAGE_PERIOD: string;
export function usageWindow<W extends { since: string }>(usage: { windows?: W[] } | null | undefined, since: string): W | null;
export const ROLE_TAB_GROUPS: ReadonlyArray<{ id: string; label: string; tabs: readonly string[] }>;
export const SUBNAV_ICONS: Readonly<Record<string, readonly string[]>>;
export function roleSubnav(role: string, current: string): Array<{ id: string; label: string; items: Array<{ id: string; label: string; href: string; current: boolean; icon: readonly string[] }> }>;
export function roleMeta(detail: Record<string, any> | null | undefined, family: string): { runtime: string; model: string; family: string; mount: string };
export interface OverviewCard { link: { label: string; href: string }; rows: Array<[string, string, (string | null)?]> }
export function overviewCards(detail: Record<string, any>, family: string): {
  identity: OverviewCard;
  harness: OverviewCard;
  capabilities: OverviewCard;
  skills: { link: { label: string; href: string }; chips: Array<{ name: string; href: string }>; hostOnly: string[] };
};
export function recentTaskRows(overview: { recentTasks?: Array<Record<string, any>> } | null | undefined, now?: number): Array<{ taskId: string; href: string; title: string; meta: string; when: string }>;
