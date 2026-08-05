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

import { randomBytes } from "node:crypto";
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
  /** FG-649: the checkout this review's stages act on, recorded at open and re-recorded
   *  when an operator overrides it with --project. The review row — not cwd, not the run —
   *  is the authority for which tree a stage reads and (since the coordinator commits the
   *  fix cycle) writes. Absent on a row written before FG-649. */
  workspaceDir?: string;
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
  workspace_dir: string | null;
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
    workspaceDir: row.workspace_dir ?? undefined,
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
  workspaceDir?: string;
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
                              candidate_sha, trusted_remote_sha, workspace_dir, contract_json,
                              lens_outcomes_json, stage_evidence_json, review_mode, state,
                              created_at, updated_at, settled_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
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
        r.workspaceDir ?? null,
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
        // FG-649: WHICH checkout this review's stages will act on, recorded by the same
        // transaction that creates the row — so the audit history shows the binding a
        // review was opened with, not only whatever it holds now.
        workspaceDir: r.workspaceDir,
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
  /** FG-649: patchable ON PURPOSE. An operator who legitimately moved the checkout
   *  supplies --project and the new binding is RECORDED on the review; it is never
   *  inferred from wherever the next invocation happens to run. */
  workspaceDir?: string;
  contract?: unknown;
  lensOutcomes?: unknown;
  stageEvidence?: StageEvidence;
};

/** The mutable-identity fields. Not a state transition, so no lifecycle event —
 *  a coordinator that advances the candidate emits its own transition around it.
 *
 *  FG-649 RF-4: ONLY THE PATCHED COLUMNS ARE WRITTEN. This used to be a read-modify-write
 *  that rebuilt EVERY mutable column from a snapshot read outside the write lock, so a
 *  caller patching one field wrote back its stale view of all the others. That is a real
 *  clobber now that `resolveReviewWorkspace` rebinds `workspace_dir` at the START of every
 *  stage-driving invocation: the rebind could land while another process was mid-stage and
 *  put back the candidate_sha, lens outcomes or stage record that process had just written.
 *  A narrow UPDATE lets SQLite keep the columns nobody patched, so the two writes commute. */
export function updateReview(id: string, patch: ReviewPatch): Review {
  const before = getReview(id);
  if (!before) throw new Error(`forge: no review ${id}`);

  const sets: string[] = [];
  const vals: unknown[] = [];
  const put = (column: string, value: unknown): void => {
    sets.push(`${column} = ?`);
    vals.push(value);
  };
  if (patch.baseSha !== undefined) put("base_sha", patch.baseSha);
  if (patch.contractConfirmedSha !== undefined) put("contract_confirmed_sha", patch.contractConfirmedSha);
  if (patch.candidateSha !== undefined) put("candidate_sha", patch.candidateSha);
  if (patch.trustedRemoteSha !== undefined) put("trusted_remote_sha", patch.trustedRemoteSha);
  if (patch.workspaceDir !== undefined) put("workspace_dir", patch.workspaceDir);
  if (patch.contract !== undefined) put("contract_json", JSON.stringify(patch.contract));
  if (patch.lensOutcomes !== undefined) put("lens_outcomes_json", JSON.stringify(patch.lensOutcomes));
  if (patch.stageEvidence !== undefined) put("stage_evidence_json", JSON.stringify(patch.stageEvidence));
  if (sets.length === 0) return before;

  writeTransaction(() => {
    getDb()
      .prepare(`UPDATE reviews SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`)
      .run(...(vals as never[]), nowIso(), id);
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

// ─── lens acceptance (FG-640) ───────────────────────────────────────────────

/** An operator's authorized acceptance of ONE named lens's missing evidence.
 *
 *  This is the THIRD route by which an absent lens clears — the other two being retrying the
 *  lens and amending the contract through its approving authority. It is stored in
 *  `lens_outcomes_json` beside the reviewer-authored outcomes because that is exactly what the
 *  rule requires: the acceptance ATTACHES TO THE NAMED LENS rather than pretending a review
 *  occurred. Its shape is deliberately not an outcome's — nothing that reads outcomes can
 *  mistake it for a review that happened, and `forge review show` renders it as its own line. */
export type LensAcceptance = {
  kind: "lens_acceptance";
  lens: string;
  /** WHAT WAS NOT REVIEWED, in the operator's words. Required: an acceptance that does not
   *  name the missing evidence is a blanket waiver, which is what `--force` already is. */
  missingEvidence: string;
  rationale: string;
  /** The sha the acceptance stands in for a review OF — the confirmed candidate discovery
   *  runs against. Bound there rather than to the moving candidate on purpose: an acceptance
   *  substitutes for one lens's discovery outcome, so it must live exactly as long as the
   *  outcomes beside it, and a re-confirmation at a new sha retires it with them. */
  candidateSha: string;
  acceptedBy: DecidedBy;
  acceptedAt: string;
};

export function isLensAcceptance(v: unknown): v is LensAcceptance {
  return typeof v === "object" && v !== null && (v as { kind?: unknown }).kind === "lens_acceptance";
}

// ─── agent protocol generation (FG-654) ─────────────────────────────────────

/** WHICH generation of the Forge-owned review protocol a dispatched agent ran under.
 *
 *  The TASK MANIFEST is authoritative (invariant 6: written once at dispatch, never
 *  recomputed); this is the ledger's INDEX of it, so "which protocol did this agent run
 *  under" is answerable from the review after the fact. Per DISPATCH, never per stage —
 *  `StageEvidence` is one record per stage while Stage 2b fans out five lens dispatches,
 *  which is the wrong cardinality for this fact. A review that spans a `forge upgrade`
 *  legitimately mixes generations; the mix is recorded and visible, not prevented.
 *
 *  It rides `lens_outcomes_json` for the same reason `lens_acceptance` does — that array
 *  already has per-dispatch cardinality — and its shape is deliberately not an outcome's,
 *  so nothing that reads outcomes can mistake it for a review that happened. */
export type AgentProtocolRecord = {
  kind: "agent_protocol";
  /** the dispatched role, e.g. `engineer` for the fix-batch fixer */
  role: string;
  sha256: string;
  taskId: string;
  /** what this dispatch was FOR — `fix_batch`, `recheck`, `docs`. Lens dispatches carry
   *  their stamp on the lens outcome itself, where the lens name is already the key. */
  stage: string;
  at: string;
};

export function isAgentProtocolRecord(v: unknown): v is AgentProtocolRecord {
  return typeof v === "object" && v !== null && (v as { kind?: unknown }).kind === "agent_protocol";
}

function lensRecordsOf(review: Review): unknown[] {
  return Array.isArray(review.lensOutcomes) ? (review.lensOutcomes as unknown[]) : [];
}

/** The protocol generations recorded for this review's non-lens dispatches. */
export function agentProtocolRecordsOf(review: Review): AgentProtocolRecord[] {
  return lensRecordsOf(review).filter(isAgentProtocolRecord);
}

/** Append one dispatch's protocol generation. Never overwrites: a second fix cycle after a
 *  `forge upgrade` adds a second record rather than editing the first, because the first
 *  is still the true statement about the dispatch it describes. */
export function recordAgentProtocol(
  reviewId: string,
  rec: Omit<AgentProtocolRecord, "kind" | "at">,
): void {
  const at = nowIso();
  // The READ is inside the transaction, not before it. `lens_outcomes_json` is a whole-column
  // read-modify-write shared by three writers now, and this one runs on a coordinator/background
  // path: reading the array outside the write lock and serializing it back inside would let a
  // concurrent `forge review accept-lens` (or another dispatch's record) land in the window and
  // be blindly overwritten — dropping a reviewer-authored outcome or an operator acceptance to
  // record an INDEX of one. writeTransaction is BEGIN IMMEDIATE, so taking the read here holds
  // the write lock across both halves.
  writeTransaction(() => {
    const review = getReview(reviewId);
    if (!review) return;
    // An unreadable outcomes array is left alone rather than overwritten — the same refusal
    // recordLensAcceptance makes. Losing reviewer-authored outcomes to record an index of
    // them would be a strictly worse trade.
    if (review.lensOutcomes !== undefined && !Array.isArray(review.lensOutcomes)) return;
    const records = [...lensRecordsOf(review), { kind: "agent_protocol", ...rec, at }];
    getDb()
      .prepare(`UPDATE reviews SET lens_outcomes_json = ?, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify(records), at, reviewId);
  });
}

/** The operator acceptances recorded against this review's lenses. */
export function lensAcceptancesOf(review: Review): LensAcceptance[] {
  return lensRecordsOf(review).filter(isLensAcceptance);
}

/** The reviewer-authored half of the same array. Every consumer that asks "did discovery
 *  happen" reads THIS, so an acceptance can never be counted as an outcome by accident. */
export function lensOutcomeRecordsOf(review: Review): unknown[] {
  // FG-654 adds a third record kind to the same array; it is filtered HERE so every
  // existing outcome consumer keeps seeing only outcomes without having to learn about it.
  return lensRecordsOf(review).filter((r) => !isLensAcceptance(r) && !isAgentProtocolRecord(r));
}

/** Replace the reviewer-authored OUTCOMES of `lens_outcomes_json`, preserving everything
 *  in the column that is not one — operator acceptances and agent_protocol receipts.
 *
 *  Discovery's writer, and the third participant in this column's read-modify-write. Its
 *  read is inside the write lock for the same reason the other two are, and here the window
 *  is the widest in the system: the caller awaits one CONTAINER PER LENS between deciding to
 *  run discovery and having outcomes to write, so an operator acceptance or a fix-batch
 *  protocol receipt landing in those minutes would be erased by a snapshot taken before the
 *  fan-out. What survives is read HERE, after the dispatches, under BEGIN IMMEDIATE. */
export function replaceLensOutcomes(reviewId: string, outcomes: unknown[]): Review {
  const at = nowIso();
  writeTransaction(() => {
    const fresh = getReview(reviewId);
    if (!fresh) return;
    const surviving = lensRecordsOf(fresh).filter((r) => isLensAcceptance(r) || isAgentProtocolRecord(r));
    getDb()
      .prepare(`UPDATE reviews SET lens_outcomes_json = ?, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify([...surviving, ...outcomes]), at, reviewId);
  });
  return getReview(reviewId) as Review;
}

export type LensAcceptanceRequest = {
  lens: string;
  missingEvidence: string;
  rationale: string;
  operator: boolean;
};

export type LensAcceptanceOutcome =
  | { ok: true; review: Review; acceptance: LensAcceptance }
  | { ok: false; refusal: string };

/** The lenses the review's contract selected, or undefined when there is no readable list. */
function selectedLensNames(review: Review): string[] | undefined {
  const contract = review.contract as { risk_lenses?: unknown } | undefined;
  return Array.isArray(contract?.risk_lenses) ? (contract.risk_lenses as unknown[]).map(String) : undefined;
}

/** Record an authorized acceptance of a named lens's missing evidence, or refuse and write
 *  NOTHING.
 *
 *  `--operator` is the FG-638 authority representation, and it is required here without
 *  exception: an acceptance narrows the discovery coverage the approved contract stated, which
 *  is a move of the review's own threat surface. Same trust model as a `forge gate` human
 *  decision — an explicit confirmation, not authenticated identity. */
export function recordLensAcceptance(reviewId: string, req: LensAcceptanceRequest): LensAcceptanceOutcome {
  const review = getReview(reviewId);
  if (!review) return { ok: false, refusal: `no review ${reviewId}` };

  if (!req.operator) {
    return {
      ok: false,
      refusal:
        `accepting the ${req.lens} lens's missing evidence narrows the discovery coverage the approved contract ` +
        `states, which requires operator authority. Re-run with --operator to record the decision as the ` +
        `operator's. Nothing was written.`,
    };
  }
  if (req.missingEvidence.trim() === "") {
    return {
      ok: false,
      refusal:
        `an acceptance must NAME the missing evidence — pass --missing-evidence "..." saying what the ` +
        `${req.lens} lens did not review. An unnamed acceptance is a blanket override, not evidence. ` +
        `Nothing was written.`,
    };
  }
  if (req.rationale.trim() === "") {
    return { ok: false, refusal: `an acceptance must record why: pass --rationale "...". Nothing was written.` };
  }

  // THE CONFIRMED CANDIDATE, with no fallback to the moving one. An acceptance substitutes for
  // one lens's discovery OUTCOME, and outcomes are recorded against the sha the contract was
  // confirmed at — so binding it to review.candidateSha before confirmation would write an
  // acceptance against a candidate discovery never ran on, and it would then read as current
  // for whatever the first confirmation happens to land on.
  const candidateSha = review.contractConfirmedSha;
  if (candidateSha === undefined) {
    return {
      ok: false,
      refusal:
        `review ${reviewId} has no CONFIRMED candidate to bind the acceptance to — its contract has not been ` +
        `confirmed against the final diff yet, and an acceptance is a decision about ONE candidate's missing ` +
        `review. Confirm the contract first, then accept the lens against the candidate discovery ran on. ` +
        `Nothing was written.`,
    };
  }

  const selected = selectedLensNames(review);
  if (selected === undefined) {
    return {
      ok: false,
      refusal:
        `review ${reviewId} carries no readable contract, so there is no selected lens to accept. ` +
        `Nothing was written.`,
    };
  }
  if (!selected.includes(req.lens)) {
    return {
      ok: false,
      refusal:
        `'${req.lens}' is not a lens this review's contract selected (${selected.join(", ")}) — there is no ` +
        `missing evidence to accept. Nothing was written.`,
    };
  }
  if (review.lensOutcomes !== undefined && !Array.isArray(review.lensOutcomes)) {
    return {
      ok: false,
      refusal:
        `review ${reviewId}'s recorded lens outcomes are not a list, so an acceptance cannot be appended ` +
        `without overwriting them. Nothing was written.`,
    };
  }

  const at = nowIso();
  const acceptance: LensAcceptance = {
    kind: "lens_acceptance",
    lens: req.lens,
    missingEvidence: req.missingEvidence,
    rationale: req.rationale,
    candidateSha,
    acceptedBy: "operator",
    acceptedAt: at,
  };
  // THE ARRAY IS BUILT FROM A READ TAKEN INSIDE THE WRITE LOCK. Everything above is
  // validation of the operator's request against a snapshot — none of it decides which
  // records survive. That decision is a whole-column read-modify-write on
  // `lens_outcomes_json`, which has three writers (this one, recordAgentProtocol, and
  // discovery's replaceLensOutcomes) in as many processes: building the replacement array
  // from the entry read would blindly overwrite an agent_protocol receipt or a discovery
  // outcome committed in the window between. writeTransaction is BEGIN IMMEDIATE, so the
  // read and the write are one atomic step.
  const refusal = writeTransaction<string | null>(() => {
    const fresh = getReview(reviewId);
    if (!fresh) return `review ${reviewId} disappeared before the acceptance could be written. Nothing was written.`;
    if (fresh.lensOutcomes !== undefined && !Array.isArray(fresh.lensOutcomes)) {
      return (
        `review ${reviewId}'s recorded lens outcomes are not a list, so an acceptance cannot be appended ` +
        `without overwriting them. Nothing was written.`
      );
    }
    getDb()
      .prepare(`UPDATE reviews SET lens_outcomes_json = ?, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify([...lensRecordsOf(fresh), acceptance]), at, reviewId);
    logEvent("review.lens_accepted", {
      runId: fresh.runId,
      taskId: fresh.subjectTaskId,
      payload: {
        reviewId,
        lens: req.lens,
        missingEvidence: req.missingEvidence,
        rationale: req.rationale,
        candidateSha,
        acceptedBy: acceptance.acceptedBy,
        acceptedAt: at,
      },
    });
    return null;
  });
  if (refusal !== null) return { ok: false, refusal };

  return { ok: true, review: getReview(reviewId) as Review, acceptance };
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

/** A NEW fix cycle ran over these findings, so any resolution recorded before it is a claim
 *  about the code as it stood BEFORE that cycle — and that is true whether or not the sha
 *  moved.
 *
 *  `invalidateResolutionsForCandidate` cannot see this case: it keys on the candidate
 *  changing, and a fixer that resolves its batch without committing (or reports it
 *  scope-changing) leaves the candidate exactly where it was. The stale `still_present` /
 *  `inconclusive` then survives at the current sha and holds the review at the disposition
 *  stop.
 *
 *  Selecting is split from clearing so `ingestFixBatchResults` can read the stale set before
 *  opening its transaction and clear it INSIDE the one that marks the batch ingested — see
 *  clearFixCycleResolutions. */
export function staleFixCycleResolutions(reviewId: string, findingIds: readonly string[]): ReviewFinding[] {
  if (!getReview(reviewId)) throw new Error(`forge: no review ${reviewId}`);
  return findingsForReview(reviewId).filter((f) => f.resolution !== undefined && findingIds.includes(f.id));
}

/** The clearing half, WITHOUT a transaction of its own, so the ingest can run it in the same
 *  transaction that marks the batch ingested.
 *
 *  That atomicity is the live-pilot fix. As two transactions, a coordinator that died between
 *  them left a batch marked `ingested` and a resolution recorded before it still on the row —
 *  a verdict about pre-fix code presented as a verdict on the cycle that just ran. Either
 *  both land or neither does. Cleared rather than downgraded, for the same reason as
 *  `invalidateResolutionsForCandidate`: nothing downstream may read a leftover evidence blob
 *  as if it still applied. */
export function clearFixCycleResolutions(
  reviewId: string,
  stale: readonly ReviewFinding[],
  fixBatchId: string,
): string[] {
  if (stale.length === 0) return [];
  const review = getReview(reviewId);
  if (!review) throw new Error(`forge: no review ${reviewId}`);

  const at = nowIso();
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
      fixBatchId,
      candidateSha: review.candidateSha ?? null,
      findingIds: stale.map((f) => f.id),
      why: "a new fix cycle ran over these findings; a resolution recorded before it is about pre-fix code",
    },
  });

  return stale.map((f) => f.id);
}

// ─── FG-655: the docs stage's durable dispatch binding ──────────────────────

/** ONE docs dispatch, bound to the review and the candidate it was dispatched FOR.
 *
 *  The coordinator does not mint task identity — the host does (src/v2/invoke.ts). This row
 *  is the coordinator's BINDING to that identity, created before the dispatch and completed
 *  from invoke's mint-time hook, which runs after the task row is durable and before
 *  anything can start a container. That ordering is the whole point: a binding written
 *  after the dispatch returns cannot survive a crash during it, and the crash is exactly the
 *  case a second documentation-maintainer must not be dispatched for.
 *
 *  `taskId`/`runId` are BOTH how the delivery is located: the task result lives under the
 *  run's task dir, and a review may hold no run id at dispatch time. */
export type DocsDispatch = {
  id: string;
  reviewId: string;
  candidateSha: string;
  state: "open" | "dispatched" | "retired";
  taskId?: string;
  runId?: string;
  createdAt: string;
  retiredAt?: string;
  retiredReason?: string;
};

type DocsDispatchRow = {
  id: string;
  review_id: string;
  candidate_sha: string;
  state: string;
  dispatch_task_id: string | null;
  dispatch_run_id: string | null;
  created_at: string;
  retired_at: string | null;
  retired_reason: string | null;
};

function rowToDocsDispatch(row: DocsDispatchRow): DocsDispatch {
  return {
    id: row.id,
    reviewId: row.review_id,
    candidateSha: row.candidate_sha,
    state: row.state as DocsDispatch["state"],
    ...(row.dispatch_task_id ? { taskId: row.dispatch_task_id } : {}),
    ...(row.dispatch_run_id ? { runId: row.dispatch_run_id } : {}),
    createdAt: row.created_at,
    ...(row.retired_at ? { retiredAt: row.retired_at } : {}),
    ...(row.retired_reason ? { retiredReason: row.retired_reason } : {}),
  };
}

export function getDocsDispatch(id: string): DocsDispatch | undefined {
  const row = getDb().prepare(`SELECT * FROM review_docs_dispatches WHERE id = ?`).get(id) as DocsDispatchRow | undefined;
  return row ? rowToDocsDispatch(row) : undefined;
}

/** THE LIVE BINDING FOR THIS REVIEW, or undefined. Deliberately keyed on the REVIEW rather
 *  than on (review, candidate): the candidate moves out from under a binding in the crash
 *  window between the candidate advance and the stage record, and a per-candidate read there
 *  would find nothing and dispatch a second docs agent over the coordinator's own commit.
 *  The row carries the candidate it was dispatched for, so the caller can still see the
 *  difference rather than having it hidden by the lookup. */
export function pendingDocsDispatch(reviewId: string): DocsDispatch | undefined {
  const row = getDb()
    .prepare(
      `SELECT * FROM review_docs_dispatches WHERE review_id = ? AND state != 'retired'
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(reviewId) as DocsDispatchRow | undefined;
  return row ? rowToDocsDispatch(row) : undefined;
}

/** CREATE BEFORE DISPATCH. Returns the live binding if one already exists — the caller's
 *  re-entry short-circuit is what normally prevents a second one, and this makes a caller
 *  that reached here twice idempotent rather than the owner of two bindings. */
export function openDocsDispatch(reviewId: string, candidateSha: string): DocsDispatch {
  const live = pendingDocsDispatch(reviewId);
  if (live !== undefined) return live;
  const review = getReview(reviewId);
  if (!review) throw new Error(`forge: no review ${reviewId}`);
  const id = `docs-dispatch-${randomBytes(3).toString("hex")}${randomBytes(3).toString("hex")}`;
  const at = nowIso();
  // No bespoke event type: the dispatch's own `task.created` is already on the timeline, and
  // the completed stage record names this binding id beside that task id — so the audit
  // trail is a join over facts that exist rather than a fourth restatement of them.
  // FG-655 RF-4: the read above and this insert are not one atomic step, so the DB holds the
  // invariant — idx_review_docs_dispatches_live is UNIQUE over the live rows of a review. A
  // concurrent process that won the race makes this throw, and the loser refuses HERE, before
  // it can start a container. Returning the winner's binding instead would be worse than the
  // race: the loser would dispatch a second maintainer onto it and overwrite its task id.
  try {
    getDb()
      .prepare(
        `INSERT INTO review_docs_dispatches (id, review_id, candidate_sha, state, dispatch_task_id, dispatch_run_id,
                                             created_at, retired_at, retired_reason)
         VALUES (?, ?, ?, 'open', NULL, NULL, ?, NULL, NULL)`,
      )
      .run(id, reviewId, candidateSha, at);
  } catch (err) {
    const raced = pendingDocsDispatch(reviewId);
    if (raced !== undefined) {
      throw new Error(
        `forge: review ${reviewId} already has a live docs dispatch ${raced.id} — a concurrent ` +
          `\`forge review continue\` opened it, so this pass starts NO second documentation-maintainer`,
      );
    }
    throw err;
  }
  return getDocsDispatch(id) as DocsDispatch;
}

/** Bind the HOST-MINTED identity. Called from invoke's mint-time hook, i.e. after the task
 *  row and its `task.created` event are durable and before any container write. */
export function markDocsDispatchDelivered(id: string, identity: { taskId: string; runId?: string }): DocsDispatch {
  const binding = getDocsDispatch(id);
  if (!binding) throw new Error(`forge: no docs dispatch ${id}`);
  const review = getReview(binding.reviewId);
  getDb()
    .prepare(`UPDATE review_docs_dispatches SET state = 'dispatched', dispatch_task_id = ?, dispatch_run_id = ? WHERE id = ?`)
    .run(identity.taskId, identity.runId ?? review?.runId ?? null, id);
  return getDocsDispatch(id) as DocsDispatch;
}

/** SPENT, not refused. A binding is retired when Stage 6 has completed, or when a clean tree
 *  at the candidate proves an unreadable delivery left nothing behind. A refusal retires
 *  nothing — that is what keeps "re-entry dispatches no second docs agent" true. */
export function retireDocsDispatch(id: string, reason: string): DocsDispatch {
  const binding = getDocsDispatch(id);
  if (!binding) throw new Error(`forge: no docs dispatch ${id}`);
  getDb()
    .prepare(`UPDATE review_docs_dispatches SET state = 'retired', retired_at = ?, retired_reason = ? WHERE id = ?`)
    .run(nowIso(), reason, id);
  return getDocsDispatch(id) as DocsDispatch;
}

// ─── read-surface projection ────────────────────────────────────────────────

export type ReviewSummary = {
  review: Review;
  findings: ReviewFinding[];
  countsByDisposition: Record<string, number>;
  countsByResolution: Record<string, number>;
  riskLenses: string[];
  /** The operator acceptances of a selected lens's missing evidence. Part of the summary
   *  rather than of the coordinator's per-lens surface: an accepted lens is a NARROWER review
   *  than the contract states, which is exactly what an operator reading the review needs to
   *  see next to the lens list. */
  lensAcceptances: LensAcceptance[];
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
    lensAcceptances: lensAcceptancesOf(review),
    unsettledCount: findings.filter(
      (f) =>
        f.disposition === "untriaged" ||
        f.disposition === "architecture_question" ||
        (f.disposition === "fix_now" && f.resolution !== "resolved"),
    ).length,
  };
}
