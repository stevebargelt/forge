import type { HashScope } from "./view-routing.js";

export const BADGE_CAP: number;
export const BOTTOM_BAR_ITEMS: readonly string[];
export interface NavBadge {
  text: string;
  tone: "neutral" | "danger" | "unknown";
  partial: boolean;
  label: string;
}
export function homeBadge(load: unknown): NavBadge | null;
export function navHref(view: string, scope: Partial<HashScope> | null): string;
export interface NavModelGroup {
  id: string;
  label: string;
  items: { view: string; label: string; href: string; current: boolean }[];
}
export function scopedHref(hash: string, scope: Partial<HashScope> | null): string;
export function navModel(view: string, scope: Partial<HashScope> | null): NavModelGroup[];
export function checkoutScopeLabel(checkout: { exists?: boolean; branch?: string | null; projectDir: string }): string;
export function scopeSummary(
  scope: Partial<HashScope> | null,
  project: { label?: string; checkouts?: { exists?: boolean; branch?: string | null; projectDir: string }[] } | null,
): string;
