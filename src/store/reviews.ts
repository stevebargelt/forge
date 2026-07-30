// FG-638 (evidence-led review lifecycle, Change 1): the durable review ledger.
//
// The rows here are CURRENT STATE; the events this module writes are the audit
// history. Both are required — a row alone cannot answer "when did this become a
// rejected_premise and who said so", and an event stream alone cannot answer "what
// is open right now" without a replay.
//
// Two boundaries this module holds and FG-639/FG-640 must not erode:
//   - the raw `verdicts` table is IMMUTABLE PROVENANCE. Ingestion reads it and
//     records what it read in sources_json; it never edits or deletes a verdict row.
//   - models never mint authoritative ids. An observation may arrive carrying an id
//     the reviewer invented; it is preserved as provenance inside the source record
//     and is never the finding's identity.
//
// Two things this module is NOT:
//   - it does not verify that disproving evidence actually disproves anything.
//     `rejected_premise` requires CANDIDATE-BOUND DISPROVING EVIDENCE; deciding
//     whether a replay's output contradicts the finding it is attached to is a
//     SEMANTIC judgement and belongs to FG-639's coordinator. What is enforced HERE
//     is STRUCTURE: the payload parses, and it carries every field its kind is
//     defined by. A structurally complete payload that argues the wrong thing is
//     FG-639's to catch; a payload that is a sentence where a replay's command and
//     output should be is caught here.
//   - it does not drive the lifecycle. Change 1 persists states and emits an event
//     per transition; the stage machine is FG-639's.

import { getDb, writeTransaction } from "./db.js";
import { getRun } from "./runs.js";
import { logEvent } from "./events.js";
import { nowIso } from "../util/ids.js";
import type { ReviewMode } from "../types/index.js";

export type { ReviewMode };

export const REVIEW_MODES: readonly ReviewMode[] = [
  "legacy_verdict",
  "legacy_review_loop",
  "evidence_led",
];

// The 11 lifecycle states. Change 1 persists them and emits an event per
// transition; the stage machine that DRIVES them is FG-639.
export const REVIEW_STATES = [
  "confirming_contract",
  "discovering",
  "awaiting_disposition",
  "fixing",
  "documenting",
  "verifying",
  "rechecking",
  "shipping_review",
  "settled",
  "blocked_environment",
  "failed",
] as const;
export type ReviewState = (typeof REVIEW_STATES)[number];

export const DISPOSITIONS = [
  "fix_now",
  "accepted_risk",
  "deferred",
  "rejected_premise",
  "duplicate",
  "architecture_question",
] as const;
export type Disposition = (typeof DISPOSITIONS)[number];
export type FindingDisposition = "untriaged" | Disposition;

// The evidence kinds `rejected_premise` accepts. A rationale is an argument; these
// are the three shapes of candidate-bound proof the PRD names.
export const DISPROVING_EVIDENCE_KINDS = [
  "replayed_command",
  "deterministic_reproduction",
  "anchored_contradiction",
] as const;
export type DisprovingEvidenceKind = (typeof DISPROVING_EVIDENCE_KINDS)[number];

/** What each kind IS, structurally. Each field is required and each is what makes the
 *  evidence candidate-bound proof rather than a restated opinion: a replay without its
 *  output is a claim that it was run, a reproduction without its observed result is a
 *  claim that it reproduced, and a contradiction without a file anchor is a claim that
 *  the code says something.
 *
 *  `line` is a line number; every other field is non-empty text. Semantics — does this
 *  output actually contradict THIS finding — is FG-639's (see the module header). */
type EvidenceField = { name: string; type: "text" | "line" };

const EVIDENCE_SHAPES: Record<DisprovingEvidenceKind, readonly EvidenceField[]> = {
  replayed_command: [
    { name: "command", type: "text" },
    { name: "output", type: "text" },
  ],
  deterministic_reproduction: [
    { name: "reproduction", type: "text" },
    { name: "result", type: "text" },
  ],
  anchored_contradiction: [
    { name: "file", type: "text" },
    { name: "line", type: "line" },
    { name: "fact", type: "text" },
  ],
};

export type DisprovingEvidence = Record<string, unknown>;

/** Parse `--evidence` as the JSON payload its kind requires. Returns the payload, or
 *  a refusal naming the fields that are missing and the shape that was expected.
 *
 *  The kind's fields are what is REQUIRED, not what is allowed: the payload comes back
 *  WHOLE, extra fields included. An operator who attaches the exit code alongside the
 *  command and its output submitted that as their proof, and a ledger that quietly kept
 *  the two fields it had names for would be showing a later reader something other than
 *  what was submitted. */
function parseDisprovingEvidence(
  kind: DisprovingEvidenceKind,
  raw: string,
): { ok: true; payload: DisprovingEvidence } | { ok: false; refusal: string } {
  const shape = EVIDENCE_SHAPES[kind];
  const names = shape.map((f) => f.name);
  const hasLine = shape.some((f) => f.type === "line");
  const wanted =
    `${kind} evidence must be a JSON object carrying ` +
    `${names.slice(0, -1).join(", ")} and ${names[names.length - 1] as string} ` +
    `(${hasLine ? "line is a line number, the rest are" : "each"} non-empty text)`;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, refusal: `${wanted}, not free text. Nothing was written.` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, refusal: `${wanted}, not a bare JSON value. Nothing was written.` };
  }

  const obj = parsed as DisprovingEvidence;
  const missing: string[] = [];
  for (const field of shape) {
    const v = obj[field.name];
    const ok = field.type === "line" ? typeof v === "number" && Number.isInteger(v) && v >= 1 : typeof v === "string" && v.trim() !== "";
    if (!ok) missing.push(field.name);
  }
  if (missing.length > 0) {
    return { ok: false, refusal: `${wanted}; missing or empty: ${missing.join(", ")}. Nothing was written.` };
  }
  return { ok: true, payload: obj };
}

export type DecidedBy = "operator" | "orchestrator";

/** One reviewer/verdict that produced an observation. Every source is kept — a
 *  deduplicated finding carries all of them, and `modelFindingId` is the id the
 *  reviewer used for itself, retained as provenance and never as identity. */
export type FindingSource = {
  verdictId?: string;
  redTaskId?: string;
  redRole?: string;
  authority?: string;
  modelFindingId?: string;
  note?: string;
};

/** FG-639: the lifecycle stages, in order. `reviews.state` says where a review IS;
 *  stage evidence says what it has already DONE and at which sha. Both are needed —
 *  `forge review continue` after a crash must resume the persisted NEXT stage without
 *  repeating a completed one, and a stage recorded against a superseded candidate is
 *  correctly not complete for the candidate that exists now. */
export const REVIEW_STAGES = [
  "verified_entry",
  "contract_confirmed",
  "discovery",
  "fix",
  "docs",
  "verified_final",
  "recheck",
  "shipping",
] as const;
export type ReviewStage = (typeof REVIEW_STAGES)[number];

export type StageRecord = {
  /** The sha the stage completed against. A stage is complete FOR A SHA, never in the
   *  abstract. */
  sha: string;
  at: string;
  detail?: string;
  /** Stage-specific durable detail — the batch id a fix stage consumed, the ids a recheck
   *  left unresolved, whether a stage was a legitimate no-op. */
  meta?: Record<string, unknown>;
};

export type StageEvidence = Partial<Record<ReviewStage, StageRecord>>;

export type Review = {
  id: string;
  runId?: string;
  subjectTaskId?: string;
  ticketId?: string;
  baseSha?: string;
  contractConfirmedSha?: string;
  candidateSha?: string;
  trustedRemoteSha?: string;
  contract?: unknown;
  lensOutcomes?: unknown;
  stageEvidence?: StageEvidence;
  reviewMode: ReviewMode;
  state: ReviewState;
  createdAt: string;
  updatedAt: string;
  settledAt?: string;
};

export type ReviewFinding = {
  id: string;
  reviewId: string;
  ordinal: number;
  findingRef: string;
  fingerprint?: string;
  summary: string;
  severity?: string;
  riskLens?: string;
  findingType?: string;
  evidence?: string;
  hypothesis?: string;
  reachability?: string;
  file?: string;
  line?: number;
  quotedText?: string;
  acceptanceRef?: string;
  invariantRef?: string;
  sources: FindingSource[];
  disposition: FindingDisposition;
  dispositionRationale?: string;
  dispositionEvidence?: string;
  decidedBy?: DecidedBy;
  decidedAt?: string;
  decidedCandidateSha?: string;
  duplicateOf?: string;
  followupTicketId?: string;
  resolution?: string;
  resolutionEvidenceKind?: string;
  resolutionEvidence?: string;
  discoveredSha?: string;
  resolvedSha?: string;
  createdAt: string;
  updatedAt: string;
};

type ReviewRow = {
  id: string;
  run_id: string | null;
  subject_task_id: string | null;
  ticket_id: string | null;
  base_sha: string | null;
  contract_confirmed_sha: string | null;
  candidate_sha: string | null;
  trusted_remote_sha: string | null;
  contract_json: string | null;
  lens_outcomes_json: string | null;
  stage_evidence_json: string | null;
  review_mode: string;
  state: string;
  created_at: string;
  updated_at: string;
  settled_at: string | null;
};

type FindingRow = {
  id: string;
  review_id: string;
  ordinal: number;
  finding_ref: string;
  fingerprint: string | null;
  summary: string;
  severity: string | null;
  risk_lens: string | null;
  finding_type: string | null;
  evidence: string | null;
  hypothesis: string | null;
  reachability: string | null;
  file: string | null;
  line: number | null;
  quoted_text: string | null;
  acceptance_ref: string | null;
  invariant_ref: string | null;
  sources_json: string;
  disposition: string;
  disposition_rationale: string | null;
  disposition_evidence: string | null;
  decided_by: string | null;
  decided_at: string | null;
  decided_candidate_sha: string | null;
  duplicate_of: string | null;
  followup_ticket_id: string | null;
  resolution: string | null;
  resolution_evidence_kind: string | null;
  resolution_evidence: string | null;
  discovered_sha: string | null;
  resolved_sha: string | null;
  created_at: string;
  updated_at: string;
};

function rowToReview(row: ReviewRow): Review {
  return {
    id: row.id,
    runId: row.run_id ?? undefined,
    subjectTaskId: row.subject_task_id ?? undefined,
    ticketId: row.ticket_id ?? undefined,
    baseSha: row.base_sha ?? undefined,
    contractConfirmedSha: row.contract_confirmed_sha ?? undefined,
    candidateSha: row.candidate_sha ?? undefined,
    trustedRemoteSha: row.trusted_remote_sha ?? undefined,
    contract: row.contract_json !== null ? (JSON.parse(row.contract_json) as unknown) : undefined,
    lensOutcomes: row.lens_outcomes_json !== null ? (JSON.parse(row.lens_outcomes_json) as unknown) : undefined,
    stageEvidence:
      row.stage_evidence_json !== null ? (JSON.parse(row.stage_evidence_json) as StageEvidence) : undefined,
    reviewMode: row.review_mode as ReviewMode,
    state: row.state as ReviewState,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    settledAt: row.settled_at ?? undefined,
  };
}

function rowToFinding(row: FindingRow): ReviewFinding {
  return {
    id: row.id,
    reviewId: row.review_id,
    ordinal: row.ordinal,
    findingRef: row.finding_ref,
    fingerprint: row.fingerprint ?? undefined,
    summary: row.summary,
    severity: row.severity ?? undefined,
    riskLens: row.risk_lens ?? undefined,
    findingType: row.finding_type ?? undefined,
    evidence: row.evidence ?? undefined,
    hypothesis: row.hypothesis ?? undefined,
    reachability: row.reachability ?? undefined,
    file: row.file ?? undefined,
    line: row.line ?? undefined,
    quotedText: row.quoted_text ?? undefined,
    acceptanceRef: row.acceptance_ref ?? undefined,
    invariantRef: row.invariant_ref ?? undefined,
    sources: JSON.parse(row.sources_json) as FindingSource[],
    disposition: row.disposition as FindingDisposition,
    dispositionRationale: row.disposition_rationale ?? undefined,
    dispositionEvidence: row.disposition_evidence ?? undefined,
    decidedBy: (row.decided_by ?? undefined) as DecidedBy | undefined,
    decidedAt: row.decided_at ?? undefined,
    decidedCandidateSha: row.decided_candidate_sha ?? undefined,
    duplicateOf: row.duplicate_of ?? undefined,
    followupTicketId: row.followup_ticket_id ?? undefined,
    resolution: row.resolution ?? undefined,
    resolutionEvidenceKind: row.resolution_evidence_kind ?? undefined,
    resolutionEvidence: row.resolution_evidence ?? undefined,
    discoveredSha: row.discovered_sha ?? undefined,
    resolvedSha: row.resolved_sha ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ─── reviews ────────────────────────────────────────────────────────────────

export type NewReview = {
  id: string;
  reviewMode: ReviewMode;
  runId?: string;
  subjectTaskId?: string;
  ticketId?: string;
  baseSha?: string;
  contractConfirmedSha?: string;
  candidateSha?: string;
  trustedRemoteSha?: string;
  contract?: unknown;
  lensOutcomes?: unknown;
  stageEvidence?: StageEvidence;
  state?: ReviewState;
};

/** The RUN row is the single source of authority-model truth, and this is where a
 *  review is made to agree with it — inside the caller's write transaction, so the
 *  run row and the review's denormalized copy move together or not at all.
 *
 *  The invariant has TWO halves and both are enforced here: a review that names a run
 *  names a run that EXISTS, and its review_mode EQUALS that run's. The first half is
 *  not pedantry — reconciliation against a missing run has nothing to compare, so a
 *  review naming a run row that is not there yet would be written with whatever mode
 *  the caller asked for and pair, permanently, with a run created later under another.
 *  A review with no runId at all is a different thing and stays legal: there is no run
 *  to disagree with.
 *
 *  A run that has never been marked (still carrying the column's legacy DEFAULT, with
 *  no ledger review of its own) ADOPTS the first review's mode: that is how an
 *  evidence-led review starts on a run created before anyone chose. A run that HAS
 *  been marked — explicitly, or implicitly by already owning a review — refuses a
 *  conflicting mode rather than letting the run and its ledger disagree.
 *
 *  Returns the run's authoritative mode; the review is inserted with THAT value. With
 *  the orphan refused and the conflict refused, a run/review pair whose modes disagree
 *  is unreachable through any writer — "the review's review_mode equals its run's"
 *  holds by construction rather than by the caller passing the right thing. */
function reconcileRunReviewMode(runId: string | undefined, attempted: ReviewMode): { mode: ReviewMode; adopted: boolean } {
  if (runId === undefined) return { mode: attempted, adopted: false };
  const run = getRun(runId);
  if (!run) {
    throw new Error(
      `forge: no such run ${runId} — a review cannot name a run that does not exist, or nothing reconciles ` +
        `its review_mode. Nothing was written.`,
    );
  }

  const runMode = run.reviewMode ?? "legacy_verdict";
  if (runMode === attempted) return { mode: runMode, adopted: false };

  const hasReview =
    getDb().prepare(`SELECT 1 AS ok FROM reviews WHERE run_id = ? LIMIT 1`).get(runId) !== undefined;
  if (runMode !== "legacy_verdict" || hasReview) {
    throw new Error(
      `forge: run ${runId} is ${runMode}; a review cannot be ${attempted} — exactly one review_mode per run. ` +
        `Nothing was written.`,
    );
  }

  getDb().prepare(`UPDATE runs SET review_mode = ? WHERE id = ?`).run(attempted, runId);
  return { mode: attempted, adopted: true };
}

export function insertReview(r: NewReview): Review {
  const at = nowIso();
  const state: ReviewState = r.state ?? "confirming_contract";
  writeTransaction(() => {
    const { mode, adopted } = reconcileRunReviewMode(r.runId, r.reviewMode);
    getDb()
      .prepare(
        `INSERT INTO reviews (id, run_id, subject_task_id, ticket_id, base_sha, contract_confirmed_sha,
                              candidate_sha, trusted_remote_sha, contract_json, lens_outcomes_json,
                              stage_evidence_json, review_mode, state, created_at, updated_at, settled_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        r.id,
        r.runId ?? null,
        r.subjectTaskId ?? null,
        r.ticketId ?? null,
        r.baseSha ?? null,
        r.contractConfirmedSha ?? null,
        r.candidateSha ?? null,
        r.trustedRemoteSha ?? null,
        r.contract !== undefined ? JSON.stringify(r.contract) : null,
        r.lensOutcomes !== undefined ? JSON.stringify(r.lensOutcomes) : null,
        r.stageEvidence !== undefined ? JSON.stringify(r.stageEvidence) : null,
        mode,
        state,
        at,
        at,
      );
    logEvent("review.created", {
      runId: r.runId,
      taskId: r.subjectTaskId,
      payload: {
        reviewId: r.id,
        reviewMode: mode,
        state,
        ticketId: r.ticketId,
        candidateSha: r.candidateSha,
        // The run row's authority model changed in THIS transaction — the audit
        // record of a never-marked run adopting its first review's mode.
        runReviewModeAdopted: adopted,
      },
    });
  });
  return getReview(r.id) as Review;
}

export function getReview(id: string): Review | undefined {
  const row = getDb().prepare(`SELECT * FROM reviews WHERE id = ?`).get(id) as ReviewRow | undefined;
  return row ? rowToReview(row) : undefined;
}

export function reviewsForRun(runId: string): Review[] {
  const rows = getDb()
    .prepare(`SELECT * FROM reviews WHERE run_id = ? ORDER BY created_at ASC, id ASC`)
    .all(runId) as ReviewRow[];
  return rows.map(rowToReview);
}

export function reviewsForTask(taskId: string): Review[] {
  const rows = getDb()
    .prepare(`SELECT * FROM reviews WHERE subject_task_id = ? ORDER BY created_at ASC, id ASC`)
    .all(taskId) as ReviewRow[];
  return rows.map(rowToReview);
}

/** Every state transition emits an event — that is the whole point of the append-only
 *  half of the ledger. A no-op transition (same state) still records, so a coordinator
 *  that re-enters a stage after a crash is visible rather than silent. */
export function setReviewState(id: string, state: ReviewState, opts: { reason?: string } = {}): Review {
  const before = getReview(id);
  if (!before) throw new Error(`forge: no review ${id}`);
  const at = nowIso();
  writeTransaction(() => {
    getDb()
      .prepare(`UPDATE reviews SET state = ?, updated_at = ?, settled_at = ? WHERE id = ?`)
      .run(state, at, state === "settled" ? at : (before.settledAt ?? null), id);
    logEvent("review.state_changed", {
      runId: before.runId,
      taskId: before.subjectTaskId,
      payload: { reviewId: id, from: before.state, to: state, reason: opts.reason, at },
    });
  });
  return getReview(id) as Review;
}

export type ReviewPatch = {
  baseSha?: string;
  contractConfirmedSha?: string;
  candidateSha?: string;
  trustedRemoteSha?: string;
  contract?: unknown;
  lensOutcomes?: unknown;
  stageEvidence?: StageEvidence;
};

/** The mutable-identity fields. Not a state transition, so no lifecycle event —
 *  a coordinator that advances the candidate emits its own transition around it. */
export function updateReview(id: string, patch: ReviewPatch): Review {
  const before = getReview(id);
  if (!before) throw new Error(`forge: no review ${id}`);
  const contract = patch.contract !== undefined ? patch.contract : before.contract;
  const lensOutcomes = patch.lensOutcomes !== undefined ? patch.lensOutcomes : before.lensOutcomes;
  const stageEvidence = patch.stageEvidence !== undefined ? patch.stageEvidence : before.stageEvidence;
  writeTransaction(() => {
    getDb()
      .prepare(
        `UPDATE reviews SET base_sha = ?, contract_confirmed_sha = ?, candidate_sha = ?,
                            trusted_remote_sha = ?, contract_json = ?, lens_outcomes_json = ?,
                            stage_evidence_json = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        patch.baseSha ?? before.baseSha ?? null,
        patch.contractConfirmedSha ?? before.contractConfirmedSha ?? null,
        patch.candidateSha ?? before.candidateSha ?? null,
        patch.trustedRemoteSha ?? before.trustedRemoteSha ?? null,
        contract !== undefined ? JSON.stringify(contract) : null,
        lensOutcomes !== undefined ? JSON.stringify(lensOutcomes) : null,
        stageEvidence !== undefined ? JSON.stringify(stageEvidence) : null,
        nowIso(),
        id,
      );
  });
  return getReview(id) as Review;
}

/** Record that a stage completed, at a sha. Emits an event — a completed stage is part of
 *  the audit history, not only a resume hint. */
export function recordStageEvidence(
  id: string,
  stage: ReviewStage,
  rec: Omit<StageRecord, "at"> & { at?: string },
): Review {
  const before = getReview(id);
  if (!before) throw new Error(`forge: no review ${id}`);
  const at = rec.at ?? nowIso();
  const evidence: StageEvidence = { ...(before.stageEvidence ?? {}), [stage]: { ...rec, at } };
  writeTransaction(() => {
    getDb()
      .prepare(`UPDATE reviews SET stage_evidence_json = ?, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify(evidence), at, id);
    logEvent("review.stage_completed", {
      runId: before.runId,
      taskId: before.subjectTaskId,
      payload: { reviewId: id, stage, sha: rec.sha, at, detail: rec.detail, meta: rec.meta },
    });
  });
  return getReview(id) as Review;
}

/** Is this stage complete for `sha`? A record at another sha is history, not completion —
 *  which is exactly how a docs phase that moved the candidate re-opens final verification
 *  and recheck without anyone having to remember to reset a flag. */
export function stageCompleteAt(review: Review, stage: ReviewStage, sha: string | undefined): boolean {
  const rec = review.stageEvidence?.[stage];
  if (rec === undefined || sha === undefined) return false;
  return rec.sha === sha;
}

// ─── findings ───────────────────────────────────────────────────────────────

/** A raw observation as a reviewer reported it. `modelFindingId` is whatever the
 *  model called it; it is recorded as provenance and never becomes the row's id. */
export type Observation = {
  summary: string;
  fingerprint?: string;
  severity?: string;
  riskLens?: string;
  findingType?: string;
  evidence?: string;
  hypothesis?: string;
  reachability?: string;
  file?: string;
  line?: number;
  quotedText?: string;
  acceptanceRef?: string;
  invariantRef?: string;
  discoveredSha?: string;
  modelFindingId?: string;
  sources?: FindingSource[];
};

/** Ingest raw observations as ledger findings with Forge-assigned stable ids.
 *
 *  NORMALIZATION AND DEDUPLICATION ARE NOT HERE. This is the persistence
 *  capability: N observations become N rows, each with a distinct stable id, each
 *  holding every source it arrived with. Deciding that two observations are the
 *  same mechanism is FG-639's policy, and it operates by writing one row with both
 *  sources — which this shape already supports. */
export function ingestFindings(reviewId: string, observations: Observation[]): ReviewFinding[] {
  const review = getReview(reviewId);
  if (!review) throw new Error(`forge: no review ${reviewId}`);
  const at = nowIso();
  const db = getDb();

  const ids: string[] = [];
  writeTransaction(() => {
    const maxRow = db
      .prepare(`SELECT COALESCE(MAX(ordinal), 0) AS n FROM review_findings WHERE review_id = ?`)
      .get(reviewId) as { n: number };
    let next = maxRow.n;
    for (const o of observations) {
      next += 1;
      const findingRef = `RF-${next}`;
      const id = `${reviewId}/${findingRef}`;
      const sources: FindingSource[] = [...(o.sources ?? [])];
      if (o.modelFindingId !== undefined) sources.push({ modelFindingId: o.modelFindingId });
      db.prepare(
        `INSERT INTO review_findings (id, review_id, ordinal, finding_ref, fingerprint, summary, severity,
                                      risk_lens, finding_type, evidence, hypothesis, reachability, file, line,
                                      quoted_text, acceptance_ref, invariant_ref, sources_json, disposition,
                                      discovered_sha, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'untriaged', ?, ?, ?)`,
      ).run(
        id,
        reviewId,
        next,
        findingRef,
        o.fingerprint ?? null,
        o.summary,
        o.severity ?? null,
        o.riskLens ?? null,
        o.findingType ?? null,
        o.evidence ?? null,
        o.hypothesis ?? null,
        o.reachability ?? null,
        o.file ?? null,
        o.line ?? null,
        o.quotedText ?? null,
        o.acceptanceRef ?? null,
        o.invariantRef ?? null,
        JSON.stringify(sources),
        o.discoveredSha ?? review.candidateSha ?? null,
        at,
        at,
      );
      logEvent("review.finding_ingested", {
        runId: review.runId,
        taskId: review.subjectTaskId,
        payload: {
          reviewId,
          findingId: id,
          findingRef,
          summary: o.summary,
          sourceCount: sources.length,
          // Recorded so "the model asked for id X and got id Y" is auditable.
          modelSuppliedId: o.modelFindingId ?? null,
        },
      });
      ids.push(id);
    }
  });

  return ids.map((id) => getFinding(id) as ReviewFinding);
}

export function getFinding(id: string): ReviewFinding | undefined {
  const row = getDb().prepare(`SELECT * FROM review_findings WHERE id = ?`).get(id) as FindingRow | undefined;
  return row ? rowToFinding(row) : undefined;
}

export function findingsForReview(reviewId: string): ReviewFinding[] {
  const rows = getDb()
    .prepare(`SELECT * FROM review_findings WHERE review_id = ? ORDER BY ordinal ASC`)
    .all(reviewId) as FindingRow[];
  return rows.map(rowToFinding);
}

export type FindingLookup =
  | { kind: "found"; finding: ReviewFinding }
  | { kind: "not_found" }
  | { kind: "ambiguous"; candidates: ReviewFinding[] };

/** Resolve what an operator typed. A full id (`review-abc/RF-2`) is exact; a bare
 *  `RF-2` is convenient but only unambiguous within one review, so a bare ref that
 *  matches several reviews reports the ambiguity rather than picking one. */
export function lookupFinding(ref: string, opts: { reviewId?: string } = {}): FindingLookup {
  const exact = getFinding(ref);
  if (exact) return { kind: "found", finding: exact };

  const rows = opts.reviewId
    ? (getDb()
        .prepare(`SELECT * FROM review_findings WHERE finding_ref = ? AND review_id = ?`)
        .all(ref, opts.reviewId) as FindingRow[])
    : (getDb().prepare(`SELECT * FROM review_findings WHERE finding_ref = ?`).all(ref) as FindingRow[]);

  if (rows.length === 0) return { kind: "not_found" };
  if (rows.length > 1) return { kind: "ambiguous", candidates: rows.map(rowToFinding) };
  return { kind: "found", finding: rowToFinding(rows[0] as FindingRow) };
}

// ─── disposition ────────────────────────────────────────────────────────────

/** Does this finding's `accepted_risk` need operator authority?
 *
 *  Derived from the finding's OWN durable fields, not from a caller-supplied claim:
 *  a caller who wants to avoid the operator requirement would otherwise just say the
 *  decision is routine. A finding that cites a protected invariant or an acceptance
 *  criterion, or that arrived through the security lens, or that names a
 *  data-integrity defect, is by construction one whose acceptance moves a stated
 *  threat model, acceptance criterion, security promise or data-integrity guarantee. */
export function acceptedRiskNeedsOperator(finding: ReviewFinding): boolean {
  return (
    finding.invariantRef !== undefined ||
    finding.acceptanceRef !== undefined ||
    finding.riskLens === "security" ||
    finding.findingType === "data_integrity"
  );
}

export type DispositionRequest = {
  decision: Disposition;
  rationale: string;
  operator: boolean;
  evidence?: string;
  evidenceKind?: string;
  duplicateOf?: string;
  followupTicketId?: string;
};

/** Everything the preconditions need that this module cannot derive from the two
 *  rows alone: whether the cited canonical finding exists, and whether the deferral
 *  destination is a ticket the store already knows. */
export type DispositionContext = {
  canonical?: ReviewFinding;
  destinationKnown: boolean;
};

export type DispositionCheck =
  | { ok: true; evidence: string | null }
  | { ok: false; refusal: string };

/** Every decision but `rejected_premise` stores `--evidence` as the operator typed it —
 *  it is a supporting note, not a payload with a defined shape. */
function passthroughEvidence(req: DispositionRequest): DispositionCheck {
  const raw = req.evidence ?? "";
  return { ok: true, evidence: raw.trim() === "" ? null : raw };
}

/** The per-value preconditions, as one pure function. Returns a refusal message naming
 *  what is missing, or — when the decision may be written — the exact blob it stores in
 *  `disposition_evidence`.
 *
 *  Handing the BLOB back rather than a bare "allowed" is what makes "a stored
 *  rejected_premise carries its structured detail" a fact about the types instead of a
 *  fact about two call sites agreeing. `--evidence` is parsed exactly once, here; the
 *  write path receives the result and has nothing left to re-parse, so there is no
 *  second parse whose failure could be cast away and stored as an empty detail. */
export function checkDisposition(
  finding: ReviewFinding,
  review: Review,
  req: DispositionRequest,
  ctx: DispositionContext,
): DispositionCheck {
  if (req.rationale.trim() === "") {
    return { ok: false, refusal: `a disposition must record why: pass --rationale "..."` };
  }

  switch (req.decision) {
    case "fix_now":
    case "architecture_question":
      return passthroughEvidence(req);

    case "accepted_risk":
      if (acceptedRiskNeedsOperator(finding) && !req.operator) {
        return {
          ok: false,
          refusal:
            `accepting the risk on ${finding.findingRef} changes a stated threat model, protected invariant, ` +
            `acceptance criterion, security promise or data-integrity guarantee ` +
            `(${describeAuthorityTrigger(finding)}), which requires operator authority. ` +
            `Re-run with --operator to record the decision as the operator's. Nothing was written.`,
        };
      }
      return passthroughEvidence(req);

    case "rejected_premise": {
      if (review.candidateSha === undefined) {
        return {
          ok: false,
          refusal:
            `rejected_premise needs candidate-bound disproving evidence, but review ${review.id} has no ` +
            `candidate sha to bind it to. Nothing was written.`,
        };
      }
      const raw = req.evidence ?? "";
      if (raw.trim() === "" || req.evidenceKind === undefined) {
        return {
          ok: false,
          refusal:
            `rejected_premise requires disproving evidence bound to the candidate, not a rationale alone: ` +
            `pass --evidence "..." --evidence-kind <${DISPROVING_EVIDENCE_KINDS.join(" | ")}>. Nothing was written.`,
        };
      }
      const kind = DISPROVING_EVIDENCE_KINDS.find((k) => k === req.evidenceKind);
      if (kind === undefined) {
        return {
          ok: false,
          refusal:
            `--evidence-kind must be one of ${DISPROVING_EVIDENCE_KINDS.join(", ")} ` +
            `(got '${req.evidenceKind}'). Nothing was written.`,
        };
      }
      const parsed = parseDisprovingEvidence(kind, raw);
      if (!parsed.ok) return { ok: false, refusal: parsed.refusal };
      // Stored STRUCTURED — a reader never has to re-guess what the text meant.
      return {
        ok: true,
        evidence: JSON.stringify({ kind, detail: parsed.payload, candidateSha: review.candidateSha }),
      };
    }

    case "deferred":
      if (req.followupTicketId === undefined || req.followupTicketId.trim() === "") {
        return {
          ok: false,
          refusal:
            `deferred requires a durable destination — pass --ticket <ticket-id> naming where the finding ` +
            `survives this review. Nothing was written.`,
        };
      }
      if (!ctx.destinationKnown && !req.operator) {
        return {
          ok: false,
          refusal:
            `deferred names ${req.followupTicketId}, which is not a ticket this store knows. Creating a new ` +
            `destination is an operator decision: re-run with --operator to authorize it. Nothing was written.`,
        };
      }
      return passthroughEvidence(req);

    case "duplicate":
      if (req.duplicateOf === undefined || req.duplicateOf.trim() === "") {
        return {
          ok: false,
          refusal:
            `duplicate must cite the canonical finding it duplicates — pass --duplicate-of <finding-id>. ` +
            `Nothing was written.`,
        };
      }
      if (!ctx.canonical) {
        return { ok: false, refusal: `no finding matches --duplicate-of ${req.duplicateOf}. Nothing was written.` };
      }
      if (ctx.canonical.id === finding.id) {
        return { ok: false, refusal: `a finding cannot duplicate itself (${finding.findingRef}). Nothing was written.` };
      }
      if (ctx.canonical.reviewId !== finding.reviewId) {
        return {
          ok: false,
          refusal:
            `canonical ${ctx.canonical.findingRef} belongs to review ${ctx.canonical.reviewId}, not ` +
            `${finding.reviewId} — a duplicate is scoped to one review. Nothing was written.`,
        };
      }
      return passthroughEvidence(req);

    default:
      // The union is exhausted above, so this arm is only reached by a word that
      // crossed an untyped boundary. It refuses by name rather than falling out of the
      // function as undefined — "not in the vocabulary" is a refusal, not an absence.
      return {
        ok: false,
        refusal:
          `'${String(req.decision)}' is not a disposition — expected one of ${DISPOSITIONS.join(", ")}. ` +
          `Nothing was written.`,
      };
  }
}

function describeAuthorityTrigger(finding: ReviewFinding): string {
  if (finding.invariantRef !== undefined) return `protected invariant ${finding.invariantRef}`;
  if (finding.acceptanceRef !== undefined) return `acceptance criterion ${finding.acceptanceRef}`;
  if (finding.riskLens === "security") return "security lens";
  return "data-integrity finding";
}

export type DispositionOutcome =
  | { ok: true; finding: ReviewFinding; absorbedInto?: ReviewFinding }
  | { ok: false; refusal: string };

/** Record a disposition, or refuse and write NOTHING.
 *
 *  `decided_by` is the settled authority representation: the flagged CLI invocation
 *  IS the operator act, exactly as a `forge gate` human decision is. It is an
 *  explicit confirmation under the single-user trust model, NOT authenticated
 *  identity (FG-597 / the FG-638 authority caveat). */
export function recordDisposition(findingId: string, req: DispositionRequest): DispositionOutcome {
  const finding = getFinding(findingId);
  if (!finding) return { ok: false, refusal: `no finding ${findingId}` };
  const review = getReview(finding.reviewId);
  if (!review) return { ok: false, refusal: `finding ${findingId} has no review ${finding.reviewId}` };

  const canonical = req.duplicateOf !== undefined ? resolveCanonical(req.duplicateOf, finding.reviewId) : undefined;
  const ctx: DispositionContext = {
    canonical,
    destinationKnown: req.followupTicketId !== undefined && ticketKnown(req.followupTicketId),
  };

  const checked = checkDisposition(finding, review, req, ctx);
  if (!checked.ok) return { ok: false, refusal: checked.refusal };

  const decidedBy: DecidedBy = req.operator ? "operator" : "orchestrator";
  const at = nowIso();
  const evidence = checked.evidence;

  writeTransaction(() => {
    const db = getDb();
    db.prepare(
      `UPDATE review_findings
          SET disposition = ?, disposition_rationale = ?, disposition_evidence = ?, decided_by = ?,
              decided_at = ?, decided_candidate_sha = ?, duplicate_of = ?, followup_ticket_id = ?, updated_at = ?
        WHERE id = ?`,
    ).run(
      req.decision,
      req.rationale,
      evidence,
      decidedBy,
      at,
      review.candidateSha ?? null,
      canonical?.id ?? null,
      req.followupTicketId ?? null,
      at,
      finding.id,
    );

    // The canonical row ABSORBS the duplicate's sources as provenance (operator
    // amendment 2026-07-28) — the whole reason a duplicate is safe to close is that
    // no reviewer's report is lost by closing it.
    if (canonical) {
      const merged = mergeSources(canonical.sources, finding.sources);
      db.prepare(`UPDATE review_findings SET sources_json = ?, updated_at = ? WHERE id = ?`).run(
        JSON.stringify(merged),
        at,
        canonical.id,
      );
    }

    logEvent("review.finding_dispositioned", {
      runId: review.runId,
      taskId: review.subjectTaskId,
      payload: {
        reviewId: review.id,
        findingId: finding.id,
        findingRef: finding.findingRef,
        disposition: req.decision,
        decidedBy,
        decidedAt: at,
        candidateSha: review.candidateSha ?? null,
        rationale: req.rationale,
        evidence,
        duplicateOf: canonical?.id ?? null,
        followupTicketId: req.followupTicketId ?? null,
      },
    });
  });

  return {
    ok: true,
    finding: getFinding(finding.id) as ReviewFinding,
    absorbedInto: canonical ? (getFinding(canonical.id) as ReviewFinding) : undefined,
  };
}

function resolveCanonical(ref: string, reviewId: string): ReviewFinding | undefined {
  const scoped = lookupFinding(ref, { reviewId });
  if (scoped.kind === "found") return scoped.finding;
  const global = lookupFinding(ref);
  return global.kind === "found" ? global.finding : undefined;
}

/** Source equality is structural: a re-ingested identical source is one source, two
 *  reviewers reporting the same mechanism are two. */
function mergeSources(into: FindingSource[], from: FindingSource[]): FindingSource[] {
  const seen = new Set(into.map((s) => JSON.stringify(s)));
  const merged = [...into];
  for (const s of from) {
    const key = JSON.stringify(s);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(s);
  }
  return merged;
}

/** Is this ticket id a destination the store already carries? Project-agnostic on
 *  purpose: a deferral names a durable place for the finding to live, and a ticket
 *  in this store is durable whichever project owns it. An unknown id is not refused
 *  outright — it needs operator authorization (the `deferred` precondition). */
function ticketKnown(ticketId: string): boolean {
  const row = getDb().prepare(`SELECT 1 AS ok FROM tickets WHERE ticket_id = ? LIMIT 1`).get(ticketId) as
    | { ok: number }
    | undefined;
  return row !== undefined;
}

// ─── resolution (FG-639) ────────────────────────────────────────────────────

export const RESOLUTIONS = ["resolved", "still_present", "inconclusive"] as const;
export type Resolution = (typeof RESOLUTIONS)[number];

export type ResolutionRecord = {
  resolution: Resolution;
  evidenceKind?: string;
  evidence?: string;
  /** The sha the recheck ran against. A resolution is candidate-BOUND: it means
   *  "proven at this sha", never "proven". */
  resolvedSha: string;
};

/** Record what the recheck established for one finding.
 *
 *  DISPOSITION IS NOT TOUCHED HERE. A `still_present` finding stays `fix_now` — the
 *  decision to fix it was correct and is still standing; what changed is that the fix is
 *  not proven. Overwriting the disposition would erase the decision and its authority,
 *  and `summarizeReview` already counts an unresolved `fix_now` as unsettled, so the
 *  review returns to disposition without the ledger forgetting anything. */
export function recordResolution(findingId: string, rec: ResolutionRecord): ReviewFinding {
  const finding = getFinding(findingId);
  if (!finding) throw new Error(`forge: no finding ${findingId}`);
  const review = getReview(finding.reviewId);
  const at = nowIso();
  writeTransaction(() => {
    getDb()
      .prepare(
        `UPDATE review_findings
            SET resolution = ?, resolution_evidence_kind = ?, resolution_evidence = ?, resolved_sha = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(rec.resolution, rec.evidenceKind ?? null, rec.evidence ?? null, rec.resolvedSha, at, findingId);
    logEvent("review.finding_resolution_recorded", {
      runId: review?.runId,
      taskId: review?.subjectTaskId,
      payload: {
        reviewId: finding.reviewId,
        findingId,
        findingRef: finding.findingRef,
        resolution: rec.resolution,
        evidenceKind: rec.evidenceKind ?? null,
        resolvedSha: rec.resolvedSha,
      },
    });
  });
  return getFinding(findingId) as ReviewFinding;
}

export type ResolutionInvalidation = {
  reviewId: string;
  fromSha?: string;
  toSha: string;
  invalidated: string[];
};

/** The candidate moved, so every resolution bound to the OLD candidate stops being
 *  evidence about the new one (PRD "Candidate changes out of band"; scenario #14).
 *
 *  Dispositions survive — they are decisions about findings, not claims about a tree.
 *  Resolutions do not: a `resolved` whose proof executed against a sha that is no longer
 *  the candidate is exactly the stale-evidence shape the lifecycle refuses. They are
 *  cleared rather than downgraded so that nothing downstream can read a leftover
 *  evidence blob as if it still applied. */
export function invalidateResolutionsForCandidate(reviewId: string, toSha: string): ResolutionInvalidation {
  const review = getReview(reviewId);
  if (!review) throw new Error(`forge: no review ${reviewId}`);
  const stale = findingsForReview(reviewId).filter(
    (f) => f.resolution !== undefined && f.resolvedSha !== undefined && f.resolvedSha !== toSha,
  );
  if (stale.length === 0) return { reviewId, fromSha: review.candidateSha, toSha, invalidated: [] };

  const at = nowIso();
  writeTransaction(() => {
    const db = getDb();
    const clear = db.prepare(
      `UPDATE review_findings
          SET resolution = NULL, resolution_evidence_kind = NULL, resolution_evidence = NULL,
              resolved_sha = NULL, updated_at = ?
        WHERE id = ?`,
    );
    for (const f of stale) clear.run(at, f.id);
    logEvent("review.resolutions_invalidated", {
      runId: review.runId,
      taskId: review.subjectTaskId,
      payload: {
        reviewId,
        fromSha: review.candidateSha ?? null,
        toSha,
        findingIds: stale.map((f) => f.id),
        why: "the candidate changed; candidate-bound resolution and shipping evidence no longer applies",
      },
    });
  });

  return { reviewId, fromSha: review.candidateSha, toSha, invalidated: stale.map((f) => f.id) };
}

// ─── read-surface projection ────────────────────────────────────────────────

export type ReviewSummary = {
  review: Review;
  findings: ReviewFinding[];
  countsByDisposition: Record<string, number>;
  countsByResolution: Record<string, number>;
  riskLenses: string[];
  /** Findings that are not settled under policy — an untriaged one, an open
   *  architecture question, or a `fix_now` whose fix is not PROVEN resolved.
   *  Counting only untriaged would report a review with unfixed accepted work as
   *  quiet, which is exactly the disposition-vs-resolution conflation the two
   *  separate columns exist to prevent. */
  unsettledCount: number;
};

/** The shape both `forge review show` and the dashboard render. One projection, so
 *  the two operator surfaces cannot drift into disagreeing about the same review. */
export function summarizeReview(reviewId: string): ReviewSummary | undefined {
  const review = getReview(reviewId);
  if (!review) return undefined;
  const findings = findingsForReview(reviewId);

  const countsByDisposition: Record<string, number> = {};
  const countsByResolution: Record<string, number> = {};
  for (const f of findings) {
    countsByDisposition[f.disposition] = (countsByDisposition[f.disposition] ?? 0) + 1;
    const r = f.resolution ?? "unresolved";
    countsByResolution[r] = (countsByResolution[r] ?? 0) + 1;
  }

  const contract = review.contract as { risk_lenses?: unknown } | undefined;
  const riskLenses = Array.isArray(contract?.risk_lenses) ? (contract.risk_lenses as unknown[]).map(String) : [];

  return {
    review,
    findings,
    countsByDisposition,
    countsByResolution,
    riskLenses,
    unsettledCount: findings.filter(
      (f) =>
        f.disposition === "untriaged" ||
        f.disposition === "architecture_question" ||
        (f.disposition === "fix_now" && f.resolution !== "resolved"),
    ).length,
  };
}
