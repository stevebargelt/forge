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
