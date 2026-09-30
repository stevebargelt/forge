// FG-831: types for the shared checkout label rule (client/checkout-label.js).

export interface LabelledCheckout {
  projectDir: string;
  projectDirs?: readonly string[];
  branch?: string | null;
  exists?: boolean;
}
export interface CheckoutOption {
  projectDir: string;
  label: string;
  primary: boolean;
  missing: boolean;
}
export const MISSING_LABEL: "missing on disk";
export const PRUNE_VERB: "forge projects prune --missing";
export function dedupeCheckouts<T extends LabelledCheckout>(checkouts: readonly T[] | null | undefined): T[];
export function checkoutPathLabel(checkout: LabelledCheckout, all: readonly LabelledCheckout[]): string;
export function checkoutLabel(checkout: LabelledCheckout, all: readonly LabelledCheckout[]): string;
export function checkoutForDir<P extends { checkouts?: readonly LabelledCheckout[] }>(
  dir: string | null | undefined,
  projects: readonly P[] | null | undefined,
): { project: P; checkout: NonNullable<P["checkouts"]>[number] } | null;
export function checkoutLabelForDir(
  dir: string | null | undefined,
  projects: readonly { checkouts?: readonly LabelledCheckout[] }[] | null | undefined,
  branch?: string | null,
): string;
export function checkoutOptions(
  project: { primaryCheckout?: string; checkouts?: readonly LabelledCheckout[] } | null | undefined,
  opts?: { showMissing?: boolean; selected?: string | null },
): { options: CheckoutOption[]; missingCount: number };

export type CheckoutKind = "operator" | "run";
export interface KindedCheckout extends LabelledCheckout {
  kind?: CheckoutKind;
}
export interface ChooserProject {
  primaryCheckout?: string;
  checkouts?: readonly KindedCheckout[];
  checkoutCounts?: { operator: number; liveOperator: number; run: number };
}
export interface ChooserOption {
  projectDir: string;
  label: string;
  primary: boolean;
  path: string;
  selected: boolean;
}
export interface CheckoutChooser {
  mode: "none" | "label" | "menu";
  current: { projectDir: string; label: string; primary: boolean; run: boolean } | null;
  options: ChooserOption[];
  footer: string;
}
export const RUN_CHECKOUT_LABEL: "run checkout";
export function checkoutKindForDir(dir: string | null | undefined, project: ChooserProject | null | undefined): CheckoutKind | null;
export function knownCheckout(dir: string | null | undefined, project: ChooserProject | null | undefined): string | null;
export function displayPath(dir: string): string;
export function defaultCheckout(project: ChooserProject | null | undefined): string | null;
export function checkoutChooser(project: ChooserProject | null | undefined, selected?: string | null): CheckoutChooser;
