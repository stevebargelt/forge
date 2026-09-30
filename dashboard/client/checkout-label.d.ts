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
export function checkoutLabelForDir(
  dir: string | null | undefined,
  projects: readonly { checkouts?: readonly LabelledCheckout[] }[] | null | undefined,
  branch?: string | null,
): string;
export function checkoutOptions(
  project: { primaryCheckout?: string; checkouts?: readonly LabelledCheckout[] } | null | undefined,
  opts?: { showMissing?: boolean; selected?: string | null },
): { options: CheckoutOption[]; missingCount: number };
