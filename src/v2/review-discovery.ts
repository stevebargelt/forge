// FG-639 (evidence-led review, Change 2): Stage 2 discovery and Stage 3 normalization.
//
// TWO FAIL-CLOSED RULES LIVE HERE AND NEITHER IS NEGOTIABLE.
//
// 1. DISCOVERY IS COMPLETE ONLY WHEN EVERY SELECTED LENS HAS A SCHEMA-VALID,
//    REVIEWER-AUTHORED OUTCOME. An authored `inconclusive` IS an outcome — it is
//    evidence that must be dispositioned, and it normalizes into an untriaged
//    `lens_inconclusive` finding. A crash, a timeout, an OOM, a missing result.json, a
//    malformed one, or a SYNTHESIZED verdict is NOT an outcome. This carries FG-628's
//    artifact invariant into the new model: the difference between "a reviewer looked
//    and could not tell" and "no reviewer looked" is the difference the whole lifecycle
//    is built to preserve, and collapsing them is how an unreviewed panel reads clean.
//
// 2. DEDUPLICATION MERGES ONLY WHEN TWO OBSERVATIONS NAME THE SAME ANCHORED MECHANISM
//    AND THE SAME AFFECTED INVARIANT. Unanchored observations never merge — there is no
//    mechanism to compare. Every source survives the merge as provenance, and merging
//    changes NOTHING about severity or reachability: correlated reviewers are not an
//    independent review count, so agreement must not silently escalate a finding.
//    When in doubt, both rows are kept — false separation is cheaper than a silent merge.

import { z } from "zod";
import { RISK_LENSES, type RiskLens } from "./review-contract.js";
import { STALE_PROTOCOL_FAILURE_KIND } from "./agent-protocol.js";
import type { FindingSource, LensAcceptance, Observation } from "../store/reviews.js";

export const REACHABILITY = ["demonstrated", "supported", "speculative"] as const;
export type Reachability = (typeof REACHABILITY)[number];

export const LENS_OUTCOMES = ["pass", "fail", "inconclusive"] as const;
export type LensOutcomeValue = (typeof LENS_OUTCOMES)[number];

/** What the discovery prompt requires of EVERY finding. Each field is here because its
 *  absence is what made the old review model unfalsifiable: an unanchored claim with no
 *  reachability and no named invariant cannot be rechecked, and remediation presented as
 *  a decision rather than advice is how a reviewer silently redesigns the change. */
const DiscoveryFindingSchema = z
  .object({
    summary: z.string().trim().min(1),
    evidence: z.string().trim().min(1),
    severity: z.string().trim().min(1),
    risk_lens: z.enum(RISK_LENSES),
    reachability: z.enum(REACHABILITY),
    challenges_contract: z.boolean(),
    remediation_advice: z.string().trim().min(1),
    file: z.string().trim().min(1).optional(),
    line: z.number().int().positive().optional(),
    quoted_text: z.string().min(1).optional(),
    acceptance_ref: z.string().trim().min(1).optional(),
    invariant_ref: z.string().trim().min(1).optional(),
    finding_type: z.string().trim().min(1).optional(),
    hypothesis: z.string().trim().min(1).optional(),
    /** Whatever the reviewer called it. Provenance only — never the ledger id. */
    finding_id: z.string().trim().min(1).optional(),
  })
  .strict();

export type DiscoveryFinding = z.infer<typeof DiscoveryFindingSchema>;

/** The unknown ROOT keys a reviewer output carries, for the tolerate-and-record rule.
 *  Returns them sorted so the durable record is stable across runs. */
export function toleratedRootKeys(raw: unknown, known: readonly string[]): string[] {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return [];
  return Object.keys(raw)
    .filter((k) => !known.includes(k))
    .sort();
}

/** FG-650: the ROOT is tolerate-and-record, not strict. The harness output contract every
 *  agent composes REQUIRES result.json to carry `status`, so a strict root refused every
 *  honest reviewer outcome for a key the reviewer had no choice about. Unknown ROOT keys
 *  are stripped and their names recorded on the outcome — never silently swallowed.
 *  Nested strictness is unchanged: an unknown key inside a finding is still a refusal. */
const LENS_RESULT_ROOT_KEYS = ["outcome", "findings", "inconclusive_reason"] as const;

const LensResultSchema = z
  .object({
    outcome: z.enum(LENS_OUTCOMES),
    findings: z.array(DiscoveryFindingSchema).default([]),
    /** The reviewer's own words when it returns `inconclusive`. Required there: an
     *  authored inconclusive that says nothing is indistinguishable from a synthesized
     *  one, and the two must never be confusable. */
    inconclusive_reason: z.string().trim().min(1).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.outcome === "inconclusive" && v.inconclusive_reason === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["inconclusive_reason"],
        message: "an authored inconclusive must say why — otherwise it is indistinguishable from a synthesized one",
      });
    }
    if (v.outcome === "fail" && v.findings.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["findings"],
        message: "a fail outcome must carry at least one finding",
      });
    }
  });

/** How a lens dispatch came back, as the coordinator's wiring observed it. This is the
 *  raw shape; `assessLens` turns it into an outcome or a named completion failure. */
export type LensDispatch = {
  lens: RiskLens;
  role: string;
  /** false when the container crashed, timed out, was OOM-killed, or never ran. */
  dispatched: boolean;
  /** Set when the dispatch itself failed — `container_crash`, `idle_timeout`, … */
  failureKind?: string;
  /** FG-654: the dispatcher's own message for the failure, when it has one worth
   *  carrying into the outcome (a protocol refusal names both shas and the remedy). */
  detail?: string;
  /** The parsed result.json, or undefined when there was none. */
  result?: unknown;
  /** True when forge (not the reviewer) produced this verdict — the review-missing
   *  synthesis path. A synthesized outcome is NEVER completion. */
  synthesized?: boolean;
  taskId?: string;
  verdictId?: string;
  /** FG-654: the protocol generation the dispatched agent ran under, read back off its
   *  task manifest. The manifest is authoritative; this is the ledger's index of it. */
  protocol?: LensProtocolRecord;
};

/** FG-654. Deliberately per-DISPATCH, not per stage: `StageEvidence` is one record per
 *  stage while Stage 2b fans out five lens dispatches, so recording it there would be the
 *  wrong cardinality — a review that spans a `forge upgrade` legitimately mixes
 *  generations, and the mix is RECORDED and visible rather than averaged away. */
export type LensProtocolRecord = { role: string; sha256: string; taskId?: string };

// Invariant 17: this vocabulary only ever GROWS. FG-654 adds `stale_protocol` — the lens
// was refused at dispatch because the agent's installed Forge-owned review protocol was
// absent or behind this release. Without its own word it normalized to `no_outcome` /
// "never dispatched", which reads as a coordinator wiring bug AND is clearable by an
// operator lens acceptance — re-opening precisely the fail-open being closed here.
export const LENS_INCOMPLETE_REASONS = [
  "not_dispatched",
  "crashed",
  "timed_out",
  "missing_output",
  "malformed_output",
  "synthesized",
  "stale_protocol",
] as const;
export type LensIncompleteReason = (typeof LENS_INCOMPLETE_REASONS)[number];

export type LensOutcome =
  | {
      lens: RiskLens;
      role: string;
      complete: true;
      outcome: LensOutcomeValue;
      authored: true;
      inconclusiveReason?: string;
      findings: DiscoveryFinding[];
      /** Unknown ROOT keys the reviewer carried, stripped from the validated value and
       *  kept here so the tolerance is readable back off the persisted outcome. Absent
       *  when the output carried nothing extra. */
      toleratedRootKeys?: string[];
      taskId?: string;
      verdictId?: string;
      protocol?: LensProtocolRecord;
    }
  | {
      lens: RiskLens;
      role: string;
      complete: false;
      reason: LensIncompleteReason;
      detail: string;
      taskId?: string;
      protocol?: LensProtocolRecord;
    };

function classifyFailure(failureKind: string | undefined): LensIncompleteReason {
  if (failureKind === undefined) return "not_dispatched";
  // FG-654: matched on the exact literal the dispatch seam emits, before the loose
  // regexes below — a refusal is a precondition failure, not a container death.
  if (failureKind === STALE_PROTOCOL_FAILURE_KIND) return "stale_protocol";
  if (/timeout|idle/i.test(failureKind)) return "timed_out";
  if (/crash|oom|killed|signal/i.test(failureKind)) return "crashed";
  return "crashed";
}

/** One lens dispatch → one outcome, or one NAMED completion failure. Nothing here ever
 *  produces a pass, and nothing here ever produces an empty finding set as a stand-in
 *  for a review that did not happen. */
export function assessLens(dispatch: LensDispatch): LensOutcome {
  const base = {
    lens: dispatch.lens,
    role: dispatch.role,
    taskId: dispatch.taskId,
    ...(dispatch.protocol !== undefined ? { protocol: dispatch.protocol } : {}),
  };

  if (dispatch.synthesized === true) {
    return {
      ...base,
      complete: false,
      reason: "synthesized",
      detail:
        `the ${dispatch.lens} lens outcome was synthesized by forge, not authored by a reviewer — ` +
        `a synthesized verdict is not a completed discovery outcome`,
    };
  }
  if (!dispatch.dispatched) {
    const reason = classifyFailure(dispatch.failureKind);
    if (reason === "stale_protocol") {
      return {
        ...base,
        complete: false,
        reason,
        detail:
          `the ${dispatch.lens} lens was REFUSED at dispatch: ${dispatch.role}'s installed Forge-owned review ` +
          `protocol is absent or behind this release, so it was never told the contract its findings are judged ` +
          `by. This is not a narrower review — it is no review under an unstated contract, which is why an ` +
          `operator lens acceptance cannot clear it. Remedy: run \`forge upgrade\`, then retry the lens` +
          (dispatch.detail !== undefined ? ` (${dispatch.detail})` : ""),
      };
    }
    return {
      ...base,
      complete: false,
      reason,
      detail:
        `the ${dispatch.lens} lens did not produce a review ` +
        `(${dispatch.failureKind ?? "dispatch never completed"})`,
    };
  }
  if (dispatch.result === undefined || dispatch.result === null) {
    return {
      ...base,
      complete: false,
      reason: "missing_output",
      detail: `the ${dispatch.lens} lens produced no result.json`,
    };
  }

  const parsed = LensResultSchema.safeParse(dispatch.result);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    return {
      ...base,
      complete: false,
      reason: "malformed_output",
      detail: `the ${dispatch.lens} lens output did not validate: ${detail}`,
    };
  }

  const tolerated = toleratedRootKeys(dispatch.result, LENS_RESULT_ROOT_KEYS);
  return {
    ...base,
    complete: true,
    outcome: parsed.data.outcome,
    authored: true,
    inconclusiveReason: parsed.data.inconclusive_reason,
    findings: parsed.data.findings,
    ...(tolerated.length > 0 ? { toleratedRootKeys: tolerated } : {}),
    verdictId: dispatch.verdictId,
  };
}

export type DiscoveryCompleteness = {
  complete: boolean;
  /** Every selected lens with no schema-valid reviewer-authored outcome, and why. An
   *  absent lens is cleared only by retrying it, amending the contract through its
   *  approving authority, or an authorized acceptance that NAMES the lens — never by
   *  dispositioning some other finding. */
  missing: Array<{ lens: RiskLens; reason: LensIncompleteReason | "no_outcome"; detail: string }>;
  /** The lenses that have no authored outcome and are cleared by an operator acceptance of
   *  the named missing evidence — the third route, reported rather than silently folded into
   *  completeness, because an accepted lens is a narrower review than the contract states. */
  accepted: LensAcceptance[];
};

/** The acceptances a completeness assessment may consult, and the candidate they must be
 *  bound to. Both or neither: an acceptance recorded against a superseded candidate is a
 *  decision about a review of code that is no longer the one being assessed. */
export type AcceptedLenses = {
  acceptances?: readonly LensAcceptance[];
  candidateSha?: string;
};

export function assessDiscoveryCompleteness(
  selectedLenses: readonly RiskLens[],
  outcomes: readonly LensOutcome[],
  clearances: AcceptedLenses = {},
): DiscoveryCompleteness {
  const missing: DiscoveryCompleteness["missing"] = [];
  const accepted: LensAcceptance[] = [];
  for (const lens of selectedLenses) {
    const found = outcomes.filter((o) => o.lens === lens);
    const authored = found.find((o) => o.complete);
    if (authored) continue;

    // FG-654: a stale-protocol refusal is NOT acceptable-away, and it is checked BEFORE
    // any acceptance is consulted. The acceptance route exists so an operator can
    // knowingly accept a NARROWER review; a stale-protocol agent did not produce a
    // narrower review — it produced output under a contract nobody stated, or none at
    // all. Different facts, and collapsing them recreates the fail-open this closes.
    // The remedy is `forge upgrade` and then the lens, which is self-service.
    const last = found[found.length - 1];
    if (last && !last.complete && last.reason === "stale_protocol") {
      missing.push({ lens, reason: last.reason, detail: last.detail });
      continue;
    }

    const forLens = (clearances.acceptances ?? []).filter((a) => a.lens === lens);
    const bound = forLens.filter(
      (a) => clearances.candidateSha !== undefined && a.candidateSha === clearances.candidateSha,
    );
    const current = bound[bound.length - 1];
    if (current) {
      accepted.push(current);
      continue;
    }
    // A superseded acceptance is named in the refusal rather than dropped: the operator who
    // accepted this lens once needs to read that the candidate moved out from under it.
    const stale = forLens[forLens.length - 1];
    const staleNote =
      stale !== undefined
        ? ` (an authorized acceptance of this lens exists at ${stale.candidateSha}, which is not the ` +
          `candidate being assessed — accept it again at the current candidate or retry the lens)`
        : "";

    const failed = found[found.length - 1];
    if (failed && !failed.complete) {
      missing.push({ lens, reason: failed.reason, detail: `${failed.detail}${staleNote}` });
    } else {
      missing.push({ lens, reason: "no_outcome", detail: `the ${lens} lens was never dispatched${staleNote}` });
    }
  }
  return { complete: missing.length === 0, missing, accepted };
}

// ─── normalization + deduplication (Stage 3) ────────────────────────────────

/** A discovery finding plus where it came from, ready to normalize. */
export type DiscoveryObservation = {
  finding: DiscoveryFinding;
  source: FindingSource;
};

/** Collect the observations a completed lens panel produced, plus one
 *  `lens_inconclusive` observation per authored-inconclusive lens.
 *
 *  The normalized `lens_inconclusive` finding is what stops an authored inconclusive
 *  from evaporating: it enters the ledger untriaged like any other finding and has to be
 *  dispositioned by name. */
export function collectObservations(outcomes: readonly LensOutcome[]): DiscoveryObservation[] {
  const out: DiscoveryObservation[] = [];
  for (const o of outcomes) {
    if (!o.complete) continue;
    const source: FindingSource = {
      redRole: o.role,
      redTaskId: o.taskId,
      verdictId: o.verdictId,
    };
    for (const f of o.findings) {
      out.push({ finding: f, source: { ...source, modelFindingId: f.finding_id } });
    }
    if (o.outcome === "inconclusive") {
      out.push({
        finding: {
          summary: `${o.lens} lens returned inconclusive: ${o.inconclusiveReason ?? "(no reason recorded)"}`,
          evidence: o.inconclusiveReason ?? "(no reason recorded)",
          severity: "unknown",
          risk_lens: o.lens,
          reachability: "speculative",
          challenges_contract: false,
          remediation_advice: "advice: re-run the lens, amend the contract, or record an authorized acceptance",
          finding_type: "lens_inconclusive",
        },
        source: { ...source, note: "authored inconclusive normalized into a ledger finding" },
      });
    }
  }
  return out;
}

/** The mechanism two observations must SHARE to be the same finding: a real anchor. An
 *  observation with no file+line has no mechanism to compare, so it never merges.
 *
 *  When both sides quote text, the quotes must match too. Two distinct defects on one
 *  line are common (a bad guard and a bad log call), and the quote is the cheapest
 *  signal that separates them. */
function mechanismKey(f: DiscoveryFinding): string | undefined {
  if (f.file === undefined || f.line === undefined) return undefined;
  return `${f.file}:${f.line}`;
}

function quotesConflict(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  return norm(a) !== norm(b);
}

/** The affected invariant, as the finding names it. `invariant_ref` first, then
 *  `acceptance_ref`; two findings that name DIFFERENT invariants stay separate even at
 *  the same anchor, because they are claims about different promises. */
function invariantKey(f: DiscoveryFinding): string {
  return f.invariant_ref ?? f.acceptance_ref ?? "";
}

export type NormalizedObservation = Observation & {
  /** How many raw observations became this row. 1 for everything untouched by dedup.
   *  Provenance arithmetic ONLY: nothing reads this to escalate a finding. */
  mergedFrom: number;
};

export type NormalizationResult = {
  observations: NormalizedObservation[];
  merges: Array<{ mechanism: string; invariant: string; sources: number }>;
};

function toObservation(o: DiscoveryObservation, discoveredSha: string | undefined): NormalizedObservation {
  const f = o.finding;
  return {
    summary: f.summary,
    severity: f.severity,
    riskLens: f.risk_lens,
    findingType: f.finding_type,
    evidence: f.evidence,
    hypothesis: f.hypothesis,
    reachability: f.reachability,
    file: f.file,
    line: f.line,
    quotedText: f.quoted_text,
    acceptanceRef: f.acceptance_ref,
    invariantRef: f.invariant_ref,
    discoveredSha,
    sources: [o.source],
    mergedFrom: 1,
  };
}

/** Stage 3. Merge only same-mechanism + same-invariant observations; keep everything
 *  else separate; preserve every source.
 *
 *  The merged row keeps the FIRST observation's severity and reachability verbatim. That
 *  is the "correlated sources are not an independent review count" rule expressed as
 *  code: two reviewers agreeing produces one finding with two sources, not a more severe
 *  or more reachable finding. */
export function normalizeObservations(
  raw: readonly DiscoveryObservation[],
  opts: { discoveredSha?: string } = {},
): NormalizationResult {
  const observations: NormalizedObservation[] = [];
  const index = new Map<string, number>();
  const merges: NormalizationResult["merges"] = [];

  for (const o of raw) {
    const mech = mechanismKey(o.finding);
    if (mech === undefined) {
      observations.push(toObservation(o, opts.discoveredSha));
      continue;
    }
    const inv = invariantKey(o.finding);
    const key = `${mech} ${inv}`;
    const at = index.get(key);
    const existing = at !== undefined ? observations[at] : undefined;

    if (existing === undefined) {
      index.set(key, observations.length);
      observations.push(toObservation(o, opts.discoveredSha));
      continue;
    }

    // Same anchor and same invariant, but the two reviewers quoted different code —
    // keep both. Unsure means separate.
    if (quotesConflict(existing.quotedText, o.finding.quoted_text)) {
      observations.push(toObservation(o, opts.discoveredSha));
      continue;
    }

    existing.sources = [...existing.sources!, o.source];
    existing.mergedFrom += 1;
    existing.quotedText = existing.quotedText ?? o.finding.quoted_text;
    merges.push({ mechanism: mech, invariant: inv, sources: existing.sources.length });
  }

  return { observations, merges };
}
