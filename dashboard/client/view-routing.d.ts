export type ScopeRequirement = "none" | "optional" | "project" | "checkout" | "object";
export interface Route {
  group: string;
  label: string;
  path: string;
  scope: ScopeRequirement;
  checkout?: boolean | "object";
  object: "none" | "optional" | "required";
  parent?: string;
  tabs?: string[];
  tabAliases?: Record<string, string>;
  params?: string[];
  paramValues?: Record<string, string[]>;
  objectParams?: string[];
  objectParamValues?: Record<string, string[]>;
  aliases: string[];
}
export interface HashScope {
  project: string | null;
  checkout: string | null;
}
export interface ParsedHash {
  view: string;
  group: string | null;
  id: string | null;
  tab: string | null;
  scope: HashScope;
  params: Record<string, string>;
  canonical: string;
  rewrite: boolean;
  notice: string | null;
}
export const GROUPS: readonly { id: string; label: string }[];
export const ROUTES: Readonly<Record<string, Route>>;
export const NAV_GROUPS: readonly { id: string; label: string; items: string[] }[];
export function groupOf(view: string): string | null;
export function navItemFor(view: string): string | null;
export function carriesCheckout(view: string, id?: string | null): boolean;
export function carriesScope(view: string, id?: string | null): boolean;
export function hashFor(location: { view: string; id?: string | null; tab?: string | null; scope?: Partial<HashScope> | null; params?: Record<string, string> | null }): string;
export function parseHash(hash?: string | null): ParsedHash;
