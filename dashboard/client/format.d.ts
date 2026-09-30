// FG-824: types for the shared formatters (client/format.js).

export const MONO_CLASS: string;
export function formatDuration(ms: number | null | undefined): string | null;
export function shortSha(sha: string | null | undefined, length?: number): string;
export function shortId(id: string | null | undefined, max?: number): string;
export function idDisplay(value: string | null | undefined, kind?: "id" | "sha"): { text: string; title: string; class: string };
export function formatTokens(n: number | null | undefined): string;
export function formatRelativeTime(iso: string | number | null | undefined, now?: number): string;
export function formatTimestamp(iso: string | number | null | undefined, fallback?: string): string;
export function formatClock(iso: string | number | null | undefined, options?: Intl.DateTimeFormatOptions, fallback?: string): string;
export function timestampDisplay(iso: string | number | null | undefined, now?: number): { text: string; title: string; class: string };
export function formatUtcMinute(iso: string | number | null | undefined, fallback?: string): string;
