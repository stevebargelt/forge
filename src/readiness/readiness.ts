// Mechanical readiness preflight for backlog items (FG-382).
//
// Scope: structural completeness only. This evaluator CANNOT verify that the
// latest operator instruction was reflected in the ticket body — that
// reconciliation is the ORCHESTRATOR's responsibility (prompt-level check,
// owned by FG-413). Do not add LLM/agent judgment here.

import type { StructuredTicket } from "../backlog/structured.js";

export type ReadinessOutcome = "ready" | "needs_refinement" | "blocked" | "exploratory";

export type ReadinessResult = {
  outcome: ReadinessOutcome;
  gaps: string[];
  // Concrete human-readable instruction list derived from gaps.
  // null when ready, or exploratory with sufficient context.
  // Does NOT cover operator-instruction reconciliation (orchestrator's job).
  refinementProposal: string | null;
};

const EXPLORATORY_MARKERS = /\b(spike|research|explore|exploration|exploratory|investigation)\b/i;

function isExploratory(ticket: StructuredTicket): boolean {
  if (ticket.type === "idea") return true;
  return EXPLORATORY_MARKERS.test(ticket.title) || EXPLORATORY_MARKERS.test(ticket.body);
}

function extractSections(body: string): Map<string, string> {
  const sections = new Map<string, string>();
  const lines = body.split("\n");
  let currentName: string | null = null;
  const currentLines: string[] = [];

  const flush = () => {
    if (currentName !== null) {
      sections.set(currentName.toLowerCase(), currentLines.join("\n").trim());
    }
  };

  for (const line of lines) {
    const m = line.match(/^#{1,3}\s+(.+)$/);
    if (m) {
      flush();
      currentLines.length = 0;
      currentName = m[1]!.trim();
    } else if (currentName !== null) {
      currentLines.push(line);
    }
  }
  flush();

  return sections;
}

function hasContent(s: string | undefined): boolean {
  return (s ?? "").trim().length > 0;
}

function hasBullet(s: string): boolean {
  return /^\s*[-*+] /m.test(s) || /^\s*\d+\. /m.test(s);
}

function findSection(sections: Map<string, string>, ...names: string[]): string | undefined {
  for (const name of names) {
    const val = sections.get(name.toLowerCase());
    if (val !== undefined) return val;
  }
  return undefined;
}

function buildRefinementProposal(gaps: string[]): string {
  return gaps
    .map((g) => {
      if (/problem/i.test(g)) return "Add a ## Problem section describing the issue or context.";
      if (/goal|expected behavior/i.test(g)) return "Add a ## Goal section (or ## Expected behavior) describing what success looks like.";
      if (/acceptance criteria/i.test(g)) return "Add an ## Acceptance Criteria section with testable bullet points.";
      return g;
    })
    .join(" ");
}

export function evaluateReadiness(ticket: StructuredTicket): ReadinessResult {
  if (ticket.status === "blocked") {
    return {
      outcome: "blocked",
      gaps: ["Ticket is marked blocked"],
      refinementProposal: "Resolve the blocker and unset the blocked status before implementation can begin.",
    };
  }

  const sections = extractSections(ticket.body);
  const problemContent = findSection(sections, "problem");
  const goalContent = findSection(sections, "goal", "expected behavior");
  const acContent = findSection(sections, "acceptance criteria");

  const hasProb = hasContent(problemContent);
  const hasGoal = hasContent(goalContent);
  const hasAC = acContent !== undefined && hasBullet(acContent);

  if (isExploratory(ticket)) {
    if (!hasProb && !hasGoal) {
      return {
        outcome: "exploratory",
        gaps: ["Missing both Problem and Goal sections — at least one is required for exploratory work"],
        refinementProposal:
          "Add a ## Problem section describing what is being investigated, or a ## Goal section describing the desired outcome of the exploration.",
      };
    }
    return { outcome: "exploratory", gaps: [], refinementProposal: null };
  }

  const gaps: string[] = [];
  if (!hasProb) gaps.push("Missing Problem section");
  if (!hasGoal) gaps.push("Missing Goal section (or Expected behavior)");
  if (!hasAC) {
    if (acContent === undefined) {
      gaps.push("Missing Acceptance Criteria section");
    } else {
      gaps.push("Acceptance Criteria section has no bullet points");
    }
  }

  if (gaps.length > 0) {
    return {
      outcome: "needs_refinement",
      gaps,
      refinementProposal: buildRefinementProposal(gaps),
    };
  }

  return { outcome: "ready", gaps: [], refinementProposal: null };
}
