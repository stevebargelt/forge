// FG-824: types for the status token map (client/status-tokens.js).

export type Tone = "ok" | "err" | "warn" | "info" | "magenta" | "neutral";
export type Vocabulary = "task" | "run" | "inbox" | "launch" | "claim" | "receipt" | "ticket" | "raci" | "marker";
export type StatusToken = { label: string; tone: Tone; class: string; known: boolean };

export const TONES: readonly Tone[];
export const VOCABULARY_NAMES: readonly Vocabulary[];
export function vocabularyValues(vocab: Vocabulary): string[];
export function unrecognizedLabel(value: unknown): string;
export function statusToken(vocab: Vocabulary, value: unknown): StatusToken;
export function statusClass(vocab: Vocabulary, value: unknown): string;
export function statusLabel(vocab: Vocabulary, value: unknown): string;
export function badgeClass(vocab: Vocabulary, value: unknown): string;
export function runMapStatusClass(status: unknown): string;
export function toneAccentClass(tone: unknown): string;
