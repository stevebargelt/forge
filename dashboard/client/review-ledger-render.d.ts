export type ReviewLedgerSource = {
  verdictId?: string;
  redTaskId?: string;
  redRole?: string;
  authority?: string;
  modelFindingId?: string;
  note?: string;
};

export type ReviewLedgerFinding = {
  id: string;
  findingRef: string;
  summary: string;
  severity: string | null;
  riskLens: string | null;
  reachability: string | null;
  file: string | null;
  line: number | null;
  quotedText: string | null;
  disposition: string;
  resolution: string | null;
  sources: ReviewLedgerSource[];
};

export type ReviewLedgerEntry = {
  id: string;
  state: string;
  countsByDisposition: Record<string, number>;
  countsByResolution: Record<string, number>;
  findings: ReviewLedgerFinding[];
};

export function dispositionBadgeClass(disposition: string): string;
export function severityBadgeClass(severity: string | null | undefined): string;
export function reviewStateBadgeClass(state: string): string;
export function formatCounts(counts: Record<string, number> | null | undefined): string;
export function nextRequiredAction(
  review:
    | {
        state?: string;
        countsByDisposition?: Record<string, number>;
        findings?: { disposition?: string; resolution?: string | null }[];
      }
    | null
    | undefined,
): string;
export function sourceLabels(sources: ReviewLedgerSource[] | null | undefined): string[];
export function anchorText(
  finding: Partial<ReviewLedgerFinding> | null | undefined,
): string | null;
