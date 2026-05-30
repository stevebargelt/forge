// AWN-5: review quality protocol. Makes red/review findings comparable and
// grounded. Two pure concerns, both consumed by the orchestrator (and surfaced
// in forge show):
//   1. gradeFindings — reject malformed findings, downgrade low-evidence ones, so
//      a confident-sounding but unsupported finding can't carry high severity.
//   2. summarizeFindings — cluster findings across multiple reviewers into
//      convergent (≥2 reviewers agree) vs unique, so the orchestrator can weigh
//      corroboration.
//
// Complements #147 validate-findings (which drops findings whose source citation
// does not verify). This layer handles the orthogonal axis: evidence STRENGTH and
// cross-reviewer CORROBORATION.

import type { Finding } from "../types/index.js";

const SEVERITY_ORDER = ["low", "medium", "high"] as const;
type Severity = (typeof SEVERITY_ORDER)[number];

// A per-finding confidence at or below this, with no evidence and no source
// anchor, marks the finding as too weak to carry its claimed severity.
const WEAK_CONFIDENCE = 0.5;

function downOne(sev: Severity): Severity {
  const i = SEVERITY_ORDER.indexOf(sev);
  return SEVERITY_ORDER[Math.max(0, i - 1)]!;
}

export type GradedFinding = {
  finding: Finding;        // possibly with adjusted severity
  downgraded: boolean;
  note?: string;
};

export type GradeResult = {
  graded: GradedFinding[];
  rejected: Array<{ finding: Finding; reason: string }>;
};

function hasEvidence(f: Finding): boolean {
  return typeof f.evidence === "string" && f.evidence.trim().length > 0;
}
function hasAnchor(f: Finding): boolean {
  return !!f.file && typeof f.line === "number";
}

/** Grade a reviewer's findings: reject the malformed (no summary), downgrade the
 *  low-evidence (no evidence AND no source anchor AND weak/absent confidence). */
export function gradeFindings(findings: Finding[]): GradeResult {
  const graded: GradedFinding[] = [];
  const rejected: Array<{ finding: Finding; reason: string }> = [];
  for (const f of findings ?? []) {
    if (!f || typeof f.summary !== "string" || f.summary.trim().length === 0) {
      rejected.push({ finding: f, reason: "malformed: missing summary" });
      continue;
    }
    const sev: Severity = (SEVERITY_ORDER as readonly string[]).includes(f.severity) ? (f.severity as Severity) : "low";
    const weakConfidence = typeof f.confidence !== "number" || f.confidence <= WEAK_CONFIDENCE;
    const unsupported = !hasEvidence(f) && !hasAnchor(f);
    if (unsupported && weakConfidence && sev !== "low") {
      graded.push({
        finding: { ...f, severity: downOne(sev) },
        downgraded: true,
        note: `downgraded ${sev}→${downOne(sev)}: no evidence, no source anchor, confidence ${typeof f.confidence === "number" ? f.confidence : "absent"}`,
      });
    } else {
      graded.push({ finding: sev === f.severity ? f : { ...f, severity: sev }, downgraded: false });
    }
  }
  return { graded, rejected };
}

// ── convergent vs unique across reviewers ──

export type ReviewerFindings = { redRole: string; findings: Finding[] };

export type FindingCluster = {
  key: string;
  reviewers: string[];          // distinct reviewers that raised it
  count: number;                // distinct-reviewer count
  convergent: boolean;          // ≥2 distinct reviewers
  maxSeverity: Severity;
  exemplar: Finding;            // a representative finding for display
};

// Dedup key: anchored findings cluster by file:line; otherwise by a normalized
// summary prefix (lowercased, alphanumerics, first 8 words) so paraphrases of the
// same issue group together.
export function findingKey(f: Finding): string {
  if (f.file && typeof f.line === "number") return `${f.file}:${f.line}`;
  const norm = (f.summary ?? "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  return "sum:" + norm.split(" ").slice(0, 8).join(" ");
}

/** Collect each red's findings for a run into ReviewerFindings[] (one entry per
 *  verdict that carried findings). Generic over the verdict getter for testing. */
export function gatherRunReviews(
  taskIds: string[],
  getVerdicts: (taskId: string) => Array<{ redRole: string; findings: Finding[] }>,
): ReviewerFindings[] {
  const reviews: ReviewerFindings[] = [];
  for (const id of taskIds) {
    for (const v of getVerdicts(id)) {
      if (Array.isArray(v.findings) && v.findings.length > 0) {
        reviews.push({ redRole: v.redRole, findings: v.findings });
      }
    }
  }
  return reviews;
}

/** Cluster findings across reviewers into convergent (≥2 reviewers) vs unique. */
export function summarizeFindings(reviews: ReviewerFindings[]): { convergent: FindingCluster[]; unique: FindingCluster[] } {
  const byKey = new Map<string, { reviewers: Set<string>; findings: Finding[] }>();
  for (const r of reviews ?? []) {
    for (const f of r.findings ?? []) {
      if (!f || typeof f.summary !== "string") continue;
      const k = findingKey(f);
      const entry = byKey.get(k) ?? { reviewers: new Set<string>(), findings: [] };
      entry.reviewers.add(r.redRole);
      entry.findings.push(f);
      byKey.set(k, entry);
    }
  }
  const clusters: FindingCluster[] = [...byKey.entries()].map(([key, e]) => {
    const maxSeverity = e.findings.reduce<Severity>((acc, f) => {
      const s: Severity = (SEVERITY_ORDER as readonly string[]).includes(f.severity) ? (f.severity as Severity) : "low";
      return SEVERITY_ORDER.indexOf(s) > SEVERITY_ORDER.indexOf(acc) ? s : acc;
    }, "low");
    return {
      key,
      reviewers: [...e.reviewers],
      count: e.reviewers.size,
      convergent: e.reviewers.size >= 2,
      maxSeverity,
      exemplar: e.findings[0]!,
    };
  });
  // Highest-corroboration, highest-severity first.
  const sevRank = (c: FindingCluster) => SEVERITY_ORDER.indexOf(c.maxSeverity);
  clusters.sort((a, b) => b.count - a.count || sevRank(b) - sevRank(a));
  return {
    convergent: clusters.filter((c) => c.convergent),
    unique: clusters.filter((c) => !c.convergent),
  };
}
