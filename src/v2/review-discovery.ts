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
//    FG-689 SHARPENS THIS RULE RATHER THAN RELAXING IT. Once a lens's scope is too large for
//    one dispatch it is reviewed as several shards, and the debt is owed PER SHARD: one
//    surviving shard never satisfies a lens whose other shards crashed. See
//    `assessShardCompleteness`.
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
import type {
  FindingSource,
  LensAcceptance,
  LensSkipReason,
  LensSkipRecord,
  Observation,
  ShardPlan,
} from "../store/reviews.js";

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
  /** FG-689: WHICH shard of this lens's scope this dispatch reviewed. */
  shard?: ShardIdentity;
  /** FG-689: the partition identity the shard was cut under. */
  derivationDigest?: string;
  /** FG-689 RF-1: the host's measurement of the input it COMPOSED for this dispatch — the
   *  shard's diff plus the whole envelope around it, in the shard budget's unit. The budget
   *  bounds this number, not the diff bytes alone. */
  composedChars?: number;
  /** FG-689 RF-1: the runtime this dispatch actually resolved, read back off its task
   *  manifest. It is what makes "validated against <runtime>" an observation rather than a
   *  constant somebody wrote down. Absent when nothing was dispatched. */
  runtime?: string;
};

/** FG-689 RF-1: the dispatch seam MEASURED the input it assembled and it did not fit.
 *
 *  Named like `STALE_PROTOCOL_FAILURE_KIND` and for the same reason: this is a precondition
 *  refusal decided before any container started, not a container that died, and a reader who
 *  cannot tell those apart will go looking for a crash that never happened. */
export const COMPOSED_INPUT_OVER_BUDGET_FAILURE_KIND = "composed_input_exceeds_budget";

/** WHICH shard of a lens's scope a dispatch and its outcome are about.
 *
 *  `of` travels with `index` rather than living only on the plan so a single record read in
 *  isolation still says "1 of 3". A reviewer, an operator and a later reader of the ledger
 *  must never mistake a shard for the whole change, and a record that can only say "shard 1"
 *  invites exactly that reading. */
export type ShardIdentity = { index: number; of: number };

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
      /** FG-689: the shard of the lens's scope this outcome reviewed, and the partition it
       *  was cut under. Optional because a review planned before FG-689 has neither — an
       *  outcome carrying no shard identity satisfies no shard, which is the fail-closed
       *  direction. Carried on BOTH branches: a crash needs to say which shard crashed as
       *  much as an authored outcome needs to say which shard it covers. */
      shard?: ShardIdentity;
      derivationDigest?: string;
    }
  | {
      lens: RiskLens;
      role: string;
      complete: false;
      reason: LensIncompleteReason;
      detail: string;
      taskId?: string;
      protocol?: LensProtocolRecord;
      shard?: ShardIdentity;
      derivationDigest?: string;
    };

function classifyFailure(failureKind: string | undefined): LensIncompleteReason {
  if (failureKind === undefined) return "not_dispatched";
  // FG-654: matched on the exact literal the dispatch seam emits, before the loose
  // regexes below — a refusal is a precondition failure, not a container death.
  if (failureKind === STALE_PROTOCOL_FAILURE_KIND) return "stale_protocol";
  // FG-689 RF-1: measured over budget BEFORE anything started, so it is literally not
  // dispatched. Letting it fall through to the /crash/ default below would report a container
  // death for a container that was never created.
  if (failureKind === COMPOSED_INPUT_OVER_BUDGET_FAILURE_KIND) return "not_dispatched";
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
    // FG-689: carried through EVERY branch below, including the failures. A shard that
    // crashed is the shard the assessor has to name, so its identity cannot be a property
    // only successful outcomes keep.
    ...(dispatch.shard !== undefined ? { shard: dispatch.shard } : {}),
    ...(dispatch.derivationDigest !== undefined ? { derivationDigest: dispatch.derivationDigest } : {}),
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
    if (dispatch.failureKind === COMPOSED_INPUT_OVER_BUDGET_FAILURE_KIND) {
      return {
        ...base,
        complete: false,
        reason,
        detail:
          `the ${dispatch.lens} lens was REFUSED before any container started: the host MEASURED the input it ` +
          `composed for this shard and it exceeds the shard budget. The budget bounds the assembled input, not ` +
          `the diff bytes it contains, and nothing is truncated to make it fit — a reviewer handed part of its ` +
          `input authors an honest pass over a change it did not see` +
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

/** The acceptances a completeness assessment may consult, and the candidate they must be
 *  bound to. Both or neither: an acceptance recorded against a superseded candidate is a
 *  decision about a review of code that is no longer the one being assessed. */
export type AcceptedLenses = {
  acceptances?: readonly LensAcceptance[];
  candidateSha?: string;
};

// ─── FG-689: completeness is PER SHARD ──────────────────────────────────────
//
// THE RULE THE LENS-GRANULAR ASSESSOR COULD NOT EXPRESS, and why it is gone rather than kept
// beside this one. `assessDiscoveryCompleteness` iterated the selected lenses and accepted the
// FIRST complete outcome for a lens. That is right while a lens is one dispatch; the moment a
// lens is several, it means one surviving shard satisfies a lens whose other shards crashed —
// the review reads complete while most of the code in that lens's scope was never read by
// anyone. It is the same fail-open the whole evidence-led model exists to close, arriving
// through the partition rather than through a missing container, and no amount of care in the
// sharding code prevents it: the assessor has to owe an outcome PER SHARD.
//
// Leaving both assessors in the tree would have been the same hole with a longer fuse: two
// answers to "is discovery complete", and any call site that kept the old one — or any new one
// that picked it — would be the fail-open back. There is one assessor.
//
// So every shard the plan names owes a schema-valid reviewer-authored outcome, and ONE missing
// shard leaves the review incomplete exactly as one missing lens does today. There are three
// ways that debt is discharged and they are structurally distinct on purpose:
//
//   - an AUTHORED outcome for that shard under the current partition. Evidence.
//   - an operator ACCEPTANCE that names that shard (D16). Not evidence — a recorded decision
//     to proceed with a narrower review, reported separately so it never reads as one.
//   - for a lens the plan gave ZERO shards, a matching `lens_skipped` ledger record. Neither
//     evidence nor an absence: nothing was in scope, so nothing was owed. It is reported in
//     its own array and contributes no observation, which is what keeps it distinguishable at
//     the gate from a lens that produced nothing.
//
// And every durable decision here is bound to the PARTITION that produced it. A shard's
// identity is a function of the derivation, so an acceptance, a skip record or an outcome
// carrying a different `derivationDigest` describes a shard of a partition that no longer
// exists. Those are NAMED as superseded (D17) rather than silently dropped or silently
// honored — the same treatment `assessDiscoveryCompleteness` gives an acceptance whose
// candidate moved, for the same reason: the operator who decided something once has to be
// able to read that it no longer applies.

/** One shard (or one plan-skipped lens) with nothing to discharge its debt.
 *
 *  `lens` is a plain string rather than `RiskLens` because the plan is read back off the
 *  durable row: a plan naming something outside the vocabulary must be REPORTED, not narrowed
 *  away by a cast that makes it disappear from the refusal. */
export type ShardMiss = {
  lens: string;
  /** 1-based. Absent only for a lens the plan recorded as SKIPPED — it has no shards, so
   *  there is no shard to name; `reason` is `skip_unrecorded` there. */
  shard?: number;
  of?: number;
  reason: LensIncompleteReason | "no_outcome" | "skip_unrecorded";
  detail: string;
};

/** A durable decision that describes a partition other than the one being assessed. */
export type SupersededDecision = {
  kind: "outcome" | "acceptance" | "skip";
  lens: string;
  shard?: number;
  /** The partition the record was made under; absent when it carried none at all. */
  recordedDigest?: string;
  detail: string;
};

export type ShardCompleteness = {
  complete: boolean;
  missing: ShardMiss[];
  /** Shards cleared by an operator acceptance NAMING that shard. Reported rather than folded
   *  into completeness: an accepted shard is a narrower review than the contract states. */
  accepted: LensAcceptance[];
  /** Lenses the plan gave zero shards, with a matching ledger record. SATISFIED, and its own
   *  array — never `missing`, and never an outcome. */
  skipped: Array<{ lens: string; reason: LensSkipReason }>;
  /** Decisions bound to a partition that no longer exists, named rather than dropped (D17). */
  superseded: SupersededDecision[];
};

/** What a shard-granular assessment may consult. `skips` is the `lens_skipped` half of
 *  `lens_outcomes_json`, read through its own accessor so a skip can never arrive here as an
 *  outcome. */
export type ShardClearances = AcceptedLenses & {
  skips?: readonly LensSkipRecord[];
};

/** DOES THIS PLAN DESCRIBE THIS CONTRACT'S PANEL?
 *
 *  `assessShardCompleteness` iterates the PLAN, which is right — the plan is what discovery
 *  recorded as owed — and is exactly why this check has to exist beside it. A plan that does
 *  not name a selected lens owes nothing for it, so the assessor reports complete over a lens
 *  no reviewer ever read: the same shape as the empty-lens-list fail-open the gate's
 *  `contract_unreadable` condition already closes, arriving through a stale plan instead of an
 *  unparseable contract. The reverse (a plan naming a lens the contract no longer selects) is
 *  the same disagreement seen from the other side, and is refused rather than silently
 *  narrowed: which lenses are owed is the contract's answer, and a plan that disagrees with it
 *  is a plan for a panel that is not this one.
 *
 *  Both directions are one refusal because both have one remedy — re-run discovery, which
 *  re-plans from the contract in force and records the new partition. */
export function planCoversLenses(
  plan: ShardPlan,
  selectedLenses: readonly string[],
): { ok: true } | { ok: false; detail: string } {
  const named = new Set([...plan.lenses.map((l) => l.lens), ...plan.skipped.map((s) => s.lens)]);
  const unplanned = selectedLenses.filter((l) => !named.has(l));
  const unselected = [...named].filter((l) => !selectedLenses.includes(l));
  if (unplanned.length === 0 && unselected.length === 0) return { ok: true };
  return {
    ok: false,
    detail:
      [
        unplanned.length > 0
          ? `the contract selects ${unplanned.join(", ")}, which the recorded shard plan names neither as ` +
            `sharded nor as intentionally skipped — nothing is recorded as owed for ${unplanned.length === 1 ? "it" : "them"}, ` +
            `so an assessment against this plan would report a lens nobody reviewed as complete`
          : "",
        unselected.length > 0
          ? `the recorded shard plan names ${unselected.join(", ")}, which the contract does not select — the plan ` +
            `describes a panel that is not this review's`
          : "",
      ]
        .filter((s) => s !== "")
        .join("; ") + `. The plan is re-derived from the contract in force: re-run discovery.`,
  };
}

export function assessShardCompleteness(
  plan: ShardPlan,
  outcomes: readonly LensOutcome[],
  clearances: ShardClearances = {},
): ShardCompleteness {
  const missing: ShardMiss[] = [];
  const accepted: LensAcceptance[] = [];
  const skipped: ShardCompleteness["skipped"] = [];
  const superseded: SupersededDecision[] = [];

  const digest = plan.digest;
  const acceptances = clearances.acceptances ?? [];
  const skips = clearances.skips ?? [];

  for (const planned of plan.lenses) {
    const lens = planned.lens;
    const count = planned.shards.length;

    // A skip recorded for a lens THIS partition gives shards to is a decision about a
    // partition where the lens owned nothing. It cannot satisfy a shard, and dropping it
    // quietly would leave an operator reading a review as skipped that is now dispatched.
    for (const s of skips.filter((r) => r.lens === lens)) {
      superseded.push({
        kind: "skip",
        lens,
        recordedDigest: s.derivationDigest,
        detail:
          `the ${lens} lens is recorded as intentionally skipped under partition ${s.derivationDigest}, but the ` +
          `partition being assessed (${digest}) gives it ${count} shard(s) — the skip describes a different ` +
          `partition and satisfies none of them`,
      });
    }

    // An outcome with NO shard identity satisfies nothing here. It is a lens-granular record —
    // written before this review was partitioned, or by a path that did not carry the shard —
    // and honoring it would be the whole fail-open: one un-sharded outcome standing in for
    // every shard of the lens.
    for (const o of outcomes.filter((o) => o.lens === lens && o.shard === undefined)) {
      superseded.push({
        kind: "outcome",
        lens,
        detail:
          `an outcome for the ${lens} lens carries no shard identity, so it cannot say which of the ${count} ` +
          `shard(s) of this lens's scope was reviewed — it satisfies none of them`,
      });
    }

    for (const shard of planned.shards) {
      const label = `${lens} shard ${shard.index} of ${shard.of}`;
      const forShard = outcomes.filter((o) => o.lens === lens && o.shard?.index === shard.index);
      const current = forShard.filter((o) => o.derivationDigest === digest);

      for (const o of forShard.filter((o) => o.derivationDigest !== digest)) {
        superseded.push({
          kind: "outcome",
          lens,
          shard: shard.index,
          recordedDigest: o.derivationDigest,
          detail:
            `an outcome for ${label} was authored against partition ${o.derivationDigest ?? "(none recorded)"}, ` +
            `not the partition being assessed (${digest}) — it reviewed a different set of paths and does not ` +
            `satisfy this shard`,
        });
      }

      if (current.some((o) => o.complete)) continue;

      // FG-654's precedence, unchanged and checked BEFORE any acceptance: a stale-protocol
      // refusal is not a narrower review, so there is nothing for an operator to accept.
      const last = current[current.length - 1];
      if (last && !last.complete && last.reason === "stale_protocol") {
        missing.push({ lens, shard: shard.index, of: shard.of, reason: last.reason, detail: last.detail });
        continue;
      }

      // D16: only an acceptance NAMING this shard clears it. A shardless acceptance recorded
      // before the partition existed covers no shard in particular, and treating it as
      // covering all of them would clear shards that crashed and were never read.
      const forLens = acceptances.filter((a) => a.lens === lens);
      const named = forLens.filter((a) => a.shard === shard.index);
      const bound = named.filter(
        (a) =>
          a.derivationDigest === digest &&
          clearances.candidateSha !== undefined &&
          a.candidateSha === clearances.candidateSha,
      );
      const usable = bound[bound.length - 1];
      if (usable) {
        accepted.push(usable);
        continue;
      }

      const notes: string[] = [];
      for (const a of named.filter((a) => !bound.includes(a))) {
        const why =
          a.derivationDigest !== digest
            ? `it was made against partition ${a.derivationDigest ?? "(none recorded)"}, not ${digest}`
            : `it was made against candidate ${a.candidateSha}, which is not the candidate being assessed`;
        superseded.push({
          kind: "acceptance",
          lens,
          shard: shard.index,
          recordedDigest: a.derivationDigest,
          detail: `an authorized acceptance of ${label} exists but ${why} — accept it again against the current shard, or retry it`,
        });
        notes.push(`(an authorized acceptance of ${label} exists but ${why})`);
      }
      for (const a of forLens.filter((a) => a.shard === undefined)) {
        superseded.push({
          kind: "acceptance",
          lens,
          recordedDigest: a.derivationDigest,
          detail:
            `an authorized acceptance of the ${lens} lens names no shard, so it cannot clear ${label} — one ` +
            `acceptance covering every shard would clear shards that crashed and were never read`,
        });
        notes.push(`(an acceptance of the ${lens} lens exists but names no shard, so it clears none of them)`);
      }
      const staleNote = notes.length > 0 ? ` ${notes.join(" ")}` : "";

      const failed = current[current.length - 1];
      if (failed && !failed.complete) {
        missing.push({
          lens,
          shard: shard.index,
          of: shard.of,
          reason: failed.reason,
          detail: `${failed.detail}${staleNote}`,
        });
      } else {
        missing.push({
          lens,
          shard: shard.index,
          of: shard.of,
          reason: "no_outcome",
          detail: `${label} produced no outcome — it covers ${shard.paths.length} path(s) that no reviewer read${staleNote}`,
        });
      }
    }
  }

  // A lens the plan gave ZERO shards owes a matching ledger record and nothing else. The
  // record is required rather than inferred from the plan: the plan is what forge INTENDED,
  // the record is what it durably decided, and a skip nobody recorded is a lens that silently
  // vanished from the panel. Re-recording it is cheap; reading past its absence is not.
  for (const s of plan.skipped) {
    const forLens = skips.filter((r) => r.lens === s.lens);
    if (forLens.some((r) => r.derivationDigest === digest)) {
      skipped.push({ lens: s.lens, reason: s.reason });
      continue;
    }
    for (const r of forLens) {
      superseded.push({
        kind: "skip",
        lens: s.lens,
        recordedDigest: r.derivationDigest,
        detail:
          `the ${s.lens} lens's skip record was made under partition ${r.derivationDigest}, not the partition ` +
          `being assessed (${digest}) — a re-partition can legitimately give a lens paths, so the earlier skip ` +
          `is not a current decision about this one`,
      });
    }
    missing.push({
      lens: s.lens,
      reason: "skip_unrecorded",
      detail:
        `the plan records the ${s.lens} lens as intentionally skipped (${s.reason}), but the ledger carries no ` +
        `matching skip record for partition ${digest} — an unrecorded skip is a lens that left the panel with ` +
        `nothing saying so`,
    });
  }

  return { complete: missing.length === 0, missing, accepted, skipped, superseded };
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
