// FG-639 (evidence-led review, Change 2 / PRD Appendix A): the durable FixBatch.
//
// A FIXBATCH IS IMMUTABLE AT A REVISION. Nothing in this module updates a batch's
// payload or its hash. A changed disposition set or a changed candidate produces the
// NEXT revision and marks the old one superseded, so a fixer that is already running
// keeps the one stable scope it was dispatched with — the operator changing their mind
// mid-flight cannot silently rewrite what a live container is working on.
//
// THE PAYLOAD HASH IS THE DELIVERY CONTRACT, not decoration. Forge materializes the
// payload into the task input mount and re-hashes THE FILE before the container starts.
// SQLite stays authoritative; the files are a verified snapshot of it. A snapshot that
// does not hash to the persisted value is a refusal, not a warning — the alternative is
// a fixer working from a payload nobody can later reconstruct.
//
// AGENTS NEVER WRITE HERE. The fixer writes result.json into its own task output area
// and the HOST ingests it. Ingestion requires exactly one result per expected finding id
// and refuses unknown, duplicate, or omitted ids: an omission that quietly meant
// "resolved" is the single failure mode the whole evidence-led lifecycle exists to
// remove. Delivery is at-least-once, so application is idempotent — the composite
// primary key is the idempotence key and a repeat ingest is a no-op.

import { createHash } from "node:crypto";
import { getDb, writeTransaction } from "./db.js";
import { logEvent } from "./events.js";
import {
  clearFixCycleResolutions,
  findingsForReview,
  getReview,
  staleFixCycleResolutions,
  type ReviewFinding,
} from "./reviews.js";
import { newFixBatchId, nowIso } from "../util/ids.js";
import { storeNowMs } from "./publications.js";
import { executedAssertionIdentityValid } from "../v2/review-evidence.js";

export const FIX_BATCH_STATES = ["open", "dispatched", "ingested", "superseded"] as const;
export type FixBatchState = (typeof FIX_BATCH_STATES)[number];

export const FIX_RESULTS = ["fixed", "scope_change", "not_fixed"] as const;
export type FixResult = (typeof FIX_RESULTS)[number];

/** The logical payload, exactly as the PRD names it. This object — not an assembled
 *  prose brief — is the authoritative handoff, and it is what the hash is over. */
export type FixBatchPayload = {
  fix_batch_id: string;
  revision: number;
  review_id: string;
  candidate_sha: string;
  findings: Array<{
    finding_id: string;
    finding_ref: string;
    summary: string;
    evidence: string;
    disposition_rationale: string;
    decided_at?: string;
    reachability?: string;
    risk_lens?: string;
    file?: string;
    line?: number;
    quoted_text?: string;
    acceptance_ref?: string;
    invariant_ref?: string;
  }>;
};

export type FixBatch = {
  id: string;
  reviewId: string;
  revision: number;
  candidateSha: string;
  supersedesBatchId?: string;
  payload: FixBatchPayload;
  payloadSha256: string;
  state: FixBatchState;
  dispatchTaskId?: string;
  createdAt: string;
};

type FixBatchRow = {
  id: string;
  review_id: string;
  revision: number;
  candidate_sha: string;
  supersedes_batch_id: string | null;
  payload_json: string;
  payload_sha256: string;
  state: string;
  dispatch_task_id: string | null;
  created_at: string;
};

function rowToBatch(row: FixBatchRow): FixBatch {
  return {
    id: row.id,
    reviewId: row.review_id,
    revision: row.revision,
    candidateSha: row.candidate_sha,
    supersedesBatchId: row.supersedes_batch_id ?? undefined,
    payload: JSON.parse(row.payload_json) as FixBatchPayload,
    payloadSha256: row.payload_sha256,
    state: row.state as FixBatchState,
    dispatchTaskId: row.dispatch_task_id ?? undefined,
    createdAt: row.created_at,
  };
}

/** The canonical serialization the hash is taken over. Stable by construction: the
 *  payload's own key order, written once here, is what both the DB row and the
 *  materialized file carry — so re-hashing the file cannot disagree with the row for a
 *  reason as silly as key ordering. */
export function serializeFixBatchPayload(payload: FixBatchPayload): string {
  return JSON.stringify(payload, null, 2);
}

export function hashFixBatchPayload(payload: FixBatchPayload): string {
  return createHash("sha256").update(serializeFixBatchPayload(payload), "utf8").digest("hex");
}

function payloadFindings(findings: readonly ReviewFinding[]): FixBatchPayload["findings"] {
  return findings.map((f) => ({
    finding_id: f.id,
    finding_ref: f.findingRef,
    summary: f.summary,
    evidence: f.evidence ?? "",
    disposition_rationale: f.dispositionRationale ?? "",
    decided_at: f.decidedAt,
    reachability: f.reachability,
    risk_lens: f.riskLens,
    file: f.file,
    line: f.line,
    quoted_text: f.quotedText,
    acceptance_ref: f.acceptanceRef,
    invariant_ref: f.invariantRef,
  }));
}

/** THE DECISION FINGERPRINT — the batch's scope identity, and the thing scenario #19
 *  turns on. It covers which findings are in the batch AND which decision put them there:
 *  the id, when it was decided, and the rationale that authorized it.
 *
 *  Why the decision and not just the ids. Two situations look identical if you compare
 *  ids alone, and they must not behave identically:
 *    - a fixer RETRY of unchanged work must reference the SAME revision and payload hash,
 *      never a fresh one, or the retry is a different scope than the attempt it retries;
 *    - a CHANGED disposition — even one that leaves the membership set alone — must create
 *      a NEW revision, because the fixer's instructions changed.
 *  Candidate sha is in the key for the same reason: a batch is candidate-bound, and a
 *  moved candidate invalidates it for further dispatch.
 *
 *  The one place this is coarse: re-recording the byte-identical disposition at the same
 *  millisecond reads as "no change". That is the right failure direction (it reuses the
 *  revision a container may be bound to rather than superseding it out from under one),
 *  and a genuine re-decision carries a new rationale. */
export function decisionFingerprint(candidateSha: string, findings: readonly ReviewFinding[]): string {
  const parts = findings.map((f) => `${f.id}@${f.decidedAt ?? ""}#${f.dispositionRationale ?? ""}`);
  return `${candidateSha}::${parts.join("|")}`;
}

/** The fingerprint a persisted batch was created under. Recorded in the payload, so it is
 *  read back from the immutable snapshot rather than recomputed from live rows that may
 *  have moved since. */
export function batchDecisionFingerprint(batch: FixBatch): string {
  const parts = batch.payload.findings.map((f) => `${f.finding_id}@${f.decided_at ?? ""}#${f.disposition_rationale}`);
  return `${batch.candidateSha}::${parts.join("|")}`;
}

export function getFixBatch(id: string): FixBatch | undefined {
  const row = getDb().prepare(`SELECT * FROM fix_batches WHERE id = ?`).get(id) as FixBatchRow | undefined;
  return row ? rowToBatch(row) : undefined;
}

export function fixBatchesForReview(reviewId: string): FixBatch[] {
  const rows = getDb()
    .prepare(`SELECT * FROM fix_batches WHERE review_id = ? ORDER BY revision ASC`)
    .all(reviewId) as FixBatchRow[];
  return rows.map(rowToBatch);
}

/** The current batch — the highest revision, superseded or not. */
export function latestFixBatch(reviewId: string): FixBatch | undefined {
  const rows = fixBatchesForReview(reviewId);
  return rows[rows.length - 1];
}

export type EnsureFixBatchOutcome = {
  batch: FixBatch;
  /** false when an existing revision already covers this exact scope — the retry case.
   *  A retry references the SAME revision and the SAME payload hash. */
  created: boolean;
};

/** Get the batch for this scope, creating the next revision only when the scope actually
 *  differs from the current one.
 *
 *  This is both halves of scenario #19 at the STORE boundary: a fixer RETRY re-enters with
 *  the same findings at the same candidate and gets the same revision and hash back, while a
 *  CHANGED disposition set (or a moved candidate) supersedes and gets revision n+1 — never
 *  a mutated payload on the revision a container is bound to. The coordinator permits that
 *  replacement only before Stage 5 completes; its review-wide guard prevents this helper
 *  from being called to start a second completed remediation cycle. */
export function ensureFixBatch(
  reviewId: string,
  candidateSha: string,
  findings: readonly ReviewFinding[],
): EnsureFixBatchOutcome {
  const review = getReview(reviewId);
  if (!review) throw new Error(`forge: no review ${reviewId}`);
  if (findings.length === 0) throw new Error(`forge: a fix batch needs at least one fix_now finding`);

  const current = latestFixBatch(reviewId);
  if (
    current &&
    current.state !== "superseded" &&
    batchDecisionFingerprint(current) === decisionFingerprint(candidateSha, findings)
  ) {
    return { batch: current, created: false };
  }

  const id = newFixBatchId();
  const revision = (current?.revision ?? 0) + 1;
  const payload: FixBatchPayload = {
    fix_batch_id: id,
    revision,
    review_id: reviewId,
    candidate_sha: candidateSha,
    findings: payloadFindings(findings),
  };
  const hash = hashFixBatchPayload(payload);
  const at = nowIso();

  writeTransaction(() => {
    const db = getDb();
    if (current) {
      db.prepare(`UPDATE fix_batches SET state = 'superseded' WHERE id = ?`).run(current.id);
    }
    db.prepare(
      `INSERT INTO fix_batches (id, review_id, revision, candidate_sha, supersedes_batch_id, payload_json,
                                payload_sha256, state, dispatch_task_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'open', NULL, ?)`,
    ).run(id, reviewId, revision, candidateSha, current?.id ?? null, serializeFixBatchPayload(payload), hash, at);

    logEvent("review.fix_batch_created", {
      runId: review.runId,
      taskId: review.subjectTaskId,
      payload: {
        reviewId,
        fixBatchId: id,
        revision,
        candidateSha,
        supersedes: current?.id ?? null,
        payloadSha256: hash,
        findingIds: findings.map((f) => f.id),
      },
    });
  });

  return { batch: getFixBatch(id) as FixBatch, created: true };
}

export function markFixBatchDispatched(id: string, taskId: string): FixBatch {
  const batch = getFixBatch(id);
  if (!batch) throw new Error(`forge: no fix batch ${id}`);
  const review = getReview(batch.reviewId);
  writeTransaction(() => {
    getDb()
      .prepare(`UPDATE fix_batches SET state = 'dispatched', dispatch_task_id = ? WHERE id = ?`)
      .run(taskId, id);
    logEvent("review.fix_batch_dispatched", {
      runId: review?.runId,
      taskId,
      payload: { reviewId: batch.reviewId, fixBatchId: id, revision: batch.revision, payloadSha256: batch.payloadSha256 },
    });
  });
  return getFixBatch(id) as FixBatch;
}

// ─── delivery snapshot ──────────────────────────────────────────────────────

/** The envelope written beside the payload in the task input mount, per Appendix A. */
export type FixBatchEnvelope = {
  kind: "review_fix_batch";
  schema_version: 1;
  fix_batch_id: string;
  revision: number;
  review_id: string;
  candidate_sha: string;
  payload_sha256: string;
};

export function fixBatchEnvelope(batch: FixBatch): FixBatchEnvelope {
  return {
    kind: "review_fix_batch",
    schema_version: 1,
    fix_batch_id: batch.id,
    revision: batch.revision,
    review_id: batch.reviewId,
    candidate_sha: batch.candidateSha,
    payload_sha256: batch.payloadSha256,
  };
}

/** The ONE rendering of the envelope. Materialization writes these bytes and
 *  verifyMaterializedEnvelope re-derives them from the row — two renderings would let the
 *  delivered envelope and the verified envelope drift apart while both looked verified. */
export function renderFixBatchEnvelope(batch: FixBatch): string {
  return JSON.stringify(fixBatchEnvelope(batch), null, 2);
}

export type PayloadVerification = { ok: true; sha256: string } | { ok: false; refusal: string };

/** Verify a MATERIALIZED payload against the persisted hash. Called before container
 *  start, on the bytes actually on disk — hashing the in-memory object again would only
 *  prove the object still hashes to itself. */
export function verifyMaterializedPayload(batch: FixBatch, materialized: string): PayloadVerification {
  const actual = createHash("sha256").update(materialized, "utf8").digest("hex");
  if (actual !== batch.payloadSha256) {
    return {
      ok: false,
      refusal:
        `fix batch ${batch.id} revision ${batch.revision}: the materialized payload hashes to ${actual}, not the ` +
        `persisted ${batch.payloadSha256} — refusing to start the fixer on an unverified delivery snapshot.`,
    };
  }
  return { ok: true, sha256: actual };
}

export type EnvelopeVerification = { ok: true } | { ok: false; refusal: string };

/** FG-639: verify a MATERIALIZED envelope the same way the payload is verified — against
 *  the DB row, not against the in-memory object that produced it. The envelope carries the
 *  batch identity the fixer reports back under (id, revision, payload hash), so trusting
 *  the disk copy would let a rewritten envelope point a real fixer at a different batch
 *  than the one the host will validate its result against. The comparison is byte-for-byte
 *  against a row-derived rendering, and it re-reads the row rather than taking the caller's
 *  FixBatch so "DB truth" means the store, not the argument. */
export function verifyMaterializedEnvelope(batchId: string, materialized: string): EnvelopeVerification {
  const batch = getFixBatch(batchId);
  if (!batch) {
    return {
      ok: false,
      refusal:
        `fix batch ${batchId}: no such batch in the store — refusing to start the fixer on a delivery ` +
        `snapshot with no persisted batch behind it.`,
    };
  }
  const expected = renderFixBatchEnvelope(batch);
  if (materialized !== expected) {
    return {
      ok: false,
      refusal:
        `fix batch ${batch.id} revision ${batch.revision}: the materialized envelope does not match the ` +
        `persisted batch (expected ${expected.length} bytes describing revision ${batch.revision} at payload ` +
        `sha256 ${batch.payloadSha256}) — refusing to start the fixer on an unverified delivery snapshot.`,
    };
  }
  return { ok: true };
}

// ─── result ingestion ───────────────────────────────────────────────────────

export type FixBatchResultRecord = {
  batchId: string;
  taskId: string;
  findingId: string;
  result: FixResult;
  summary?: string;
  filesChanged: string[];
  evidence?: string;
  interaction?: string;
  evidencePath?: string;
  evidenceSha256?: string;
  /** FG-710 Shape B: the candidate-bound executed-assertion identity the fixer named for a
   *  demonstrated `fixed` finding. Surfaced to the recheck so Stage 8 executes THIS assertion. */
  executedAssertion?: string;
  ingestedAt: string;
};

type ResultRow = {
  batch_id: string;
  task_id: string;
  finding_id: string;
  result: string;
  summary: string | null;
  files_changed_json: string;
  evidence: string | null;
  interaction: string | null;
  evidence_path: string | null;
  evidence_sha256: string | null;
  executed_assertion: string | null;
  ingested_at: string;
};

function rowToResult(row: ResultRow): FixBatchResultRecord {
  return {
    batchId: row.batch_id,
    taskId: row.task_id,
    findingId: row.finding_id,
    result: row.result as FixResult,
    summary: row.summary ?? undefined,
    filesChanged: JSON.parse(row.files_changed_json) as string[],
    evidence: row.evidence ?? undefined,
    interaction: row.interaction ?? undefined,
    evidencePath: row.evidence_path ?? undefined,
    evidenceSha256: row.evidence_sha256 ?? undefined,
    executedAssertion: row.executed_assertion ?? undefined,
    ingestedAt: row.ingested_at,
  };
}

export function fixBatchResults(batchId: string): FixBatchResultRecord[] {
  const rows = getDb()
    .prepare(`SELECT * FROM fix_batch_results WHERE batch_id = ? ORDER BY finding_id ASC, task_id ASC`)
    .all(batchId) as ResultRow[];
  return rows.map(rowToResult);
}

/** One per-finding entry as the fixer reported it, already shape-validated by the
 *  caller (src/v2/review-fixer.ts owns the schema; this module owns identity + storage). */
export type IncomingFixResult = {
  findingId: string;
  result: FixResult;
  summary?: string;
  filesChanged?: string[];
  evidence?: string;
  interaction?: string;
  evidencePath?: string;
  evidenceSha256?: string;
  executedAssertion?: string;
};

export type FixIngestion =
  | { ok: true; records: FixBatchResultRecord[]; alreadyIngested: boolean; invalidatedResolutions: string[] }
  /** `refusalKind` distinguishes the FG-710 Shape-B PRE-INGEST identity refusal (a demonstrated
   *  `fixed` finding naming no executed assertion) from the membership refusals, so the
   *  coordinator captures a durable refused-delivery record for it — the completed worktree
   *  edits are correct, only the result is evidence-incomplete. */
  | { ok: false; refusal: string; refusalKind?: "demonstrated_evidence_missing" };

/** The identity a fixer's result claims for ITSELF. Both halves are checked, because a
 *  batch id alone does not identify a scope: a batch is immutable AT A REVISION, so a
 *  result carrying the right id and the right finding ids can still be about a revision
 *  the fixer was never dispatched at. */
export type ClaimedBatchIdentity = { batchId: string; revision: number };

/** Ingest a fixer's results, host-side.
 *
 *  Five refusals, each naming what was wrong: a foreign batch id, a revision that is not
 *  the one the batch was dispatched at, a finding the batch never contained, the same
 *  finding reported twice, and an expected finding with no result at all. The omission arm
 *  is the load-bearing one — the PRD's "omission is never resolution" is only true if the
 *  host refuses the whole result rather than applying the ids that happened to be present.
 *
 *  The revision arm has a second half: recording under a PRIOR revision requires the
 *  delivering task to be that revision's own dispatched task. See the late-result comment. */
export function ingestFixBatchResults(
  batchId: string,
  taskId: string,
  claimed: ClaimedBatchIdentity,
  incoming: readonly IncomingFixResult[],
): FixIngestion {
  const batch = getFixBatch(batchId);
  if (!batch) return { ok: false, refusal: `no fix batch ${batchId}. Nothing was written.` };
  if (claimed.batchId !== batchId) {
    return {
      ok: false,
      refusal:
        `fixer result names fix batch ${claimed.batchId} but was dispatched for ${batchId} — batch identity ` +
        `mismatch. Nothing was written.`,
    };
  }
  if (claimed.revision !== batch.revision) {
    // A LATE RESULT, and the same semantics scenario #19 already gives one that arrives
    // under the superseded revision's own id: the work belongs to the revision the fixer
    // was bound to, so it is recorded THERE if that revision still exists, and it is never
    // credited to the scope it did not do. Crediting it as current is the whole defect —
    // a stale revision's result would close findings under a decision that has moved.
    //
    // AND THE DELIVERING TASK MUST *BE* THAT REVISION'S FIXER. Claiming an older revision
    // number is not proof of being the older fixer: without the task-id comparison, the
    // CURRENT dispatch can deliver under a prior revision and have its work recorded there,
    // which is the same misattribution in the other direction. A revision's results are its
    // own dispatched task's or nobody's.
    const bound = fixBatchesForReview(batch.reviewId).find((b) => b.revision === claimed.revision);
    const provenance =
      bound === undefined || bound.dispatchTaskId === taskId
        ? undefined
        : bound.dispatchTaskId === undefined
          ? `revision ${claimed.revision} (${bound.id}) was never dispatched, so no task can be delivering its result`
          : `task ${taskId} is not the task revision ${claimed.revision} (${bound.id}) was dispatched at ` +
            `(${bound.dispatchTaskId}) — a result is recorded against a revision only by that revision's own fixer`;
    const late =
      bound?.state === "superseded" && provenance === undefined
        ? ingestFixBatchResults(bound.id, taskId, { batchId: bound.id, revision: bound.revision }, incoming)
        : undefined;
    return {
      ok: false,
      refusal:
        `fixer result claims revision ${claimed.revision} of fix batch ${batchId}, which was dispatched at ` +
        `revision ${batch.revision} — revision mismatch. ` +
        (late?.ok === true
          ? `The result was recorded against the superseded revision ${claimed.revision} (${bound?.id}) it was ` +
            `bound to; nothing was credited to revision ${batch.revision}.`
          : bound === undefined
            ? `No revision ${claimed.revision} exists for review ${batch.reviewId}. Nothing was written.`
            : `It was not recordable against revision ${claimed.revision} (${bound.id}) either ` +
              `(${
                provenance ??
                (late === undefined ? `that revision is ${bound.state}, not superseded` : late.refusal)
              }). Nothing was credited to revision ${batch.revision}.`),
    };
  }

  const expected = batch.payload.findings.map((f) => f.finding_id);
  const expectedSet = new Set(expected);
  const seen = new Set<string>();

  for (const r of incoming) {
    if (!expectedSet.has(r.findingId)) {
      return {
        ok: false,
        refusal:
          `fixer result names ${r.findingId}, which is not in fix batch ${batchId} revision ${batch.revision} ` +
          `(expected ${expected.join(", ")}). Nothing was written.`,
      };
    }
    if (seen.has(r.findingId)) {
      return {
        ok: false,
        refusal: `fixer result reports ${r.findingId} more than once — exactly one result per finding. Nothing was written.`,
      };
    }
    seen.add(r.findingId);
  }

  const omitted = expected.filter((id) => !seen.has(id));
  if (omitted.length > 0) {
    return {
      ok: false,
      refusal:
        `fixer result omits ${omitted.join(", ")} — fix batch ${batchId} revision ${batch.revision} requires ` +
        `exactly one result per expected finding id. An omitted id is never a resolution. Nothing was written.`,
    };
  }

  // FG-710 Shape B: a `fixed` result on a DEMONSTRATED finding cannot complete the remediation
  // stage without the candidate-bound executed-assertion identity the FG-639 recheck binds. The
  // reachability lives in the immutable payload (the schema has none), and the identity-shape
  // check is the SAME one review-evidence.ts binds per-test identity through — not a second
  // parser. A missing or shape-invalid identity refuses BEFORE anything is written, and it is
  // named `demonstrated_evidence_missing` so the coordinator preserves the completed worktree
  // edits in a durable refused-delivery record rather than discarding correct code. This is
  // prevention before stage completion, never a "trust me it was fixed" escape hatch: the
  // recheck still executes the assertion and is the sole thing that can record `resolved`.
  const reachabilityOf = new Map(batch.payload.findings.map((f) => [f.finding_id, f.reachability]));
  const missingEvidence = incoming.filter(
    (r) =>
      r.result === "fixed" &&
      reachabilityOf.get(r.findingId) === "demonstrated" &&
      !executedAssertionIdentityValid(r.executedAssertion),
  );
  if (missingEvidence.length > 0) {
    const names = missingEvidence.map((r) => r.findingId).join(", ");
    return {
      ok: false,
      refusalKind: "demonstrated_evidence_missing",
      refusal:
        `fixer result marks ${names} 'fixed' on a demonstrated finding but names no candidate-bound executed ` +
        `assertion (executed_assertion) — a demonstrated finding is resolved only by a NAMED regression test the ` +
        `recheck can execute against ${batch.candidateSha}, so the remediation stage cannot complete without it. ` +
        `The completed worktree edits are preserved; supply the executed-assertion identity for the SAME edits and ` +
        `re-run. Nothing was written.`,
    };
  }

  const review = getReview(batch.reviewId);
  const at = nowIso();
  const before = fixBatchResults(batchId).filter((r) => r.taskId === taskId).length;

  // A FIX CYCLE RAN, SO THE VERDICTS FROM BEFORE IT ARE STALE — including when this fixer
  // committed nothing, which `invalidateResolutionsForCandidate` cannot see because it keys
  // on the sha moving. Cleared in the SAME transaction that marks the batch ingested, so no
  // crash can leave the two disagreeing.
  //
  // BUT ONLY FOR THE FINDINGS THIS CYCLE'S RECHECK WILL RE-EXAMINE. Stage 8's `expected` is
  // the `fix_now` set, so wiping the whole payload's resolutions cost real ledger data: a
  // finding an EARLIER cycle proved `resolved`, re-carried by this batch and reported
  // `scope_change` ("already fixed, cannot touch without changing scope"), had its proof
  // cleared and then — returned to disposition as an architecture question — was excluded
  // from every future recheck. Resolution NULL, nothing mechanical to re-establish it, and
  // Stage 9's findings_settled blocked on operator authority alone. A `scope_change` result
  // and a disposition that has moved off `fix_now` are exactly the two exclusions.
  const stillFixNow = new Set(
    findingsForReview(batch.reviewId)
      .filter((f) => f.disposition === "fix_now")
      .map((f) => f.id),
  );
  const stale = staleFixCycleResolutions(
    batch.reviewId,
    incoming.filter((r) => r.result !== "scope_change" && stillFixNow.has(r.findingId)).map((r) => r.findingId),
  );

  writeTransaction(() => {
    const db = getDb();
    const insert = db.prepare(
      `INSERT OR IGNORE INTO fix_batch_results (batch_id, task_id, finding_id, result, summary,
                                                files_changed_json, evidence, interaction, evidence_path,
                                                evidence_sha256, executed_assertion, ingested_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const r of incoming) {
      insert.run(
        batchId,
        taskId,
        r.findingId,
        r.result,
        r.summary ?? null,
        JSON.stringify(r.filesChanged ?? []),
        r.evidence ?? null,
        r.interaction ?? null,
        r.evidencePath ?? null,
        r.evidenceSha256 ?? null,
        r.executedAssertion ?? null,
        at,
      );
    }
    db.prepare(`UPDATE fix_batches SET state = 'ingested' WHERE id = ? AND state != 'superseded'`).run(batchId);
    logEvent("review.fix_batch_ingested", {
      runId: review?.runId,
      taskId,
      payload: {
        reviewId: batch.reviewId,
        fixBatchId: batchId,
        revision: batch.revision,
        payloadSha256: batch.payloadSha256,
        results: incoming.map((r) => ({ findingId: r.findingId, result: r.result })),
        // At-least-once delivery: a repeat ingest records that it was a repeat rather
        // than pretending it was the first.
        repeat: before > 0,
      },
    });
    clearFixCycleResolutions(batch.reviewId, stale, batchId);
  });

  return {
    ok: true,
    records: fixBatchResults(batchId).filter((r) => r.taskId === taskId),
    alreadyIngested: before > 0,
    invalidatedResolutions: stale.map((f) => f.id),
  };
}

// ─── FG-710: refused-delivery record (Shape A/AC4) ───────────────────────────

/** The cap on repair attempts against ONE batch/revision before the review PARKS for the
 *  operator. A repair re-emits a CORRECTED result.json for edits that already exist; two
 *  chances to get the shape right is generous, and looping past it is exactly what the FG-660
 *  one-batch bound forbids. */
export const MAX_FIX_REPAIR_ATTEMPTS = 2;

/** RF-1: how long a repair claim holds the `repairing` lease before a concurrent pass may treat
 *  the record as crash-stranded and re-drive it. Generously longer than a repair fixer's dispatch
 *  so a slow-but-LIVE repair is never mistaken for stranded — the repair only re-emits a corrected
 *  result.json for edits that already exist, so it is a short container, and the cost of erring long
 *  is only that a genuinely crashed repair waits this out before recovery. */
export const FIX_REPAIR_LEASE_MS = 30 * 60 * 1000;

export const REFUSED_DELIVERY_STATES = ["open", "repairing", "superseded"] as const;
export type RefusedDeliveryState = (typeof REFUSED_DELIVERY_STATES)[number];

export type RefusedFixDelivery = {
  batchId: string;
  revision: number;
  /** The raw result.json bytes the fixer emitted — so a repair sees what was refused. */
  rawResultBytes?: string;
  /** A re-appliable git-format patch of the completed workspace edits, INCLUDING untracked
   *  files, captured at refusal time. The crash-recovery source of truth: if the worktree was
   *  reset, the repair fixer re-applies from this. */
  diffPatch?: string;
  porcelainStatus?: string;
  /** Every refusal reason across every capture, in order — a repair is informed by all of them. */
  refusalReasons: string[];
  capturedAtCandidateSha: string;
  repairAttempts: number;
  state: RefusedDeliveryState;
  /** RF-1: the repair lease expiry (store-clock ms). Set when a pass claims open -> repairing;
   *  undefined on an aged row, a never-claimed record, or one reset back to `open`. A `repairing`
   *  record whose lease is in the future is a LIVE repair; one strictly past is crash-stranded. */
  leaseExpiresAtMs?: number;
  createdAt: string;
  updatedAt: string;
};

type RefusedDeliveryRow = {
  batch_id: string;
  revision: number;
  raw_result_bytes: string | null;
  diff_patch: string | null;
  porcelain_status: string | null;
  refusal_reasons_json: string;
  captured_at_candidate_sha: string;
  repair_attempts: number;
  state: string;
  lease_expires_at_ms: number | null;
  created_at: string;
  updated_at: string;
};

function rowToRefusedDelivery(row: RefusedDeliveryRow): RefusedFixDelivery {
  return {
    batchId: row.batch_id,
    revision: row.revision,
    rawResultBytes: row.raw_result_bytes ?? undefined,
    diffPatch: row.diff_patch ?? undefined,
    porcelainStatus: row.porcelain_status ?? undefined,
    refusalReasons: JSON.parse(row.refusal_reasons_json) as string[],
    capturedAtCandidateSha: row.captured_at_candidate_sha,
    repairAttempts: row.repair_attempts,
    state: row.state as RefusedDeliveryState,
    leaseExpiresAtMs: row.lease_expires_at_ms ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function refusedFixDelivery(batchId: string, revision: number): RefusedFixDelivery | undefined {
  const row = getDb()
    .prepare(`SELECT * FROM fix_batch_refused_deliveries WHERE batch_id = ? AND revision = ?`)
    .get(batchId, revision) as RefusedDeliveryRow | undefined;
  return row ? rowToRefusedDelivery(row) : undefined;
}

export type CaptureRefusedDeliveryInput = {
  batchId: string;
  revision: number;
  capturedAtCandidateSha: string;
  refusalReasons: string[];
  rawResultBytes?: string;
  diffPatch?: string;
  porcelainStatus?: string;
};

/** Write (or update) the durable refused-delivery record for a batch/revision, in ONE
 *  transaction. A first refusal INSERTs it `open` at 0 repair attempts; a later refusal (the
 *  repair itself refusing) UPDATEs the SAME row back to `open` and APPENDS its reasons —
 *  repair_attempts is owned by the dispatch CAS below, never reset here. This is the seam the
 *  coordinator's pre-ingest refusals feed, so completed workspace edits are preserved rather
 *  than discarded. */
export function captureRefusedFixDelivery(input: CaptureRefusedDeliveryInput): RefusedFixDelivery {
  const batch = getFixBatch(input.batchId);
  if (!batch) throw new Error(`forge: no fix batch ${input.batchId}`);
  const review = getReview(batch.reviewId);
  const at = nowIso();
  writeTransaction(() => {
    const db = getDb();
    const existing = refusedFixDelivery(input.batchId, input.revision);
    const reasons = [...(existing?.refusalReasons ?? []), ...input.refusalReasons];
    if (existing) {
      // RF-1: a fresh refusal returns the record to `open` and CLEARS the repair lease — the pass
      // that held `repairing` is done (it refused), so its lease must not outlive it and be read as
      // a live repair by the next continue. repair_attempts is owned by the claim CAS, untouched here.
      db.prepare(
        `UPDATE fix_batch_refused_deliveries
         SET raw_result_bytes = ?, diff_patch = ?, porcelain_status = ?, refusal_reasons_json = ?,
             captured_at_candidate_sha = ?, state = 'open', lease_expires_at_ms = NULL, updated_at = ?
         WHERE batch_id = ? AND revision = ?`,
      ).run(
        input.rawResultBytes ?? null,
        input.diffPatch ?? null,
        input.porcelainStatus ?? null,
        JSON.stringify(reasons),
        input.capturedAtCandidateSha,
        at,
        input.batchId,
        input.revision,
      );
    } else {
      db.prepare(
        `INSERT INTO fix_batch_refused_deliveries
           (batch_id, revision, raw_result_bytes, diff_patch, porcelain_status, refusal_reasons_json,
            captured_at_candidate_sha, repair_attempts, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'open', ?, ?)`,
      ).run(
        input.batchId,
        input.revision,
        input.rawResultBytes ?? null,
        input.diffPatch ?? null,
        input.porcelainStatus ?? null,
        JSON.stringify(reasons),
        input.capturedAtCandidateSha,
        at,
        at,
      );
    }
    logEvent("review.fix_delivery_refused", {
      runId: review?.runId,
      taskId: batch.dispatchTaskId,
      payload: {
        reviewId: batch.reviewId,
        fixBatchId: input.batchId,
        revision: input.revision,
        refusalReasons: input.refusalReasons,
        repeat: existing !== undefined,
      },
    });
  });
  return refusedFixDelivery(input.batchId, input.revision) as RefusedFixDelivery;
}

/** Compare-and-set `open` -> `repairing`, incrementing repair_attempts and STAMPING the repair
 *  lease (RF-1), so exactly ONE of two concurrent `forge review continue` processes dispatches a
 *  repair. Returns the claimed record when this caller won the transition, else undefined (already
 *  claimed, or not open). Mirrors markFixBatchDispatched's guarded write. */
export function claimRefusedFixDeliveryRepair(batchId: string, revision: number): RefusedFixDelivery | undefined {
  const batch = getFixBatch(batchId);
  if (!batch) throw new Error(`forge: no fix batch ${batchId}`);
  const review = getReview(batch.reviewId);
  let claimed = false;
  writeTransaction(() => {
    const leaseUntil = storeNowMs() + FIX_REPAIR_LEASE_MS;
    const res = getDb()
      .prepare(
        `UPDATE fix_batch_refused_deliveries
         SET state = 'repairing', repair_attempts = repair_attempts + 1, lease_expires_at_ms = ?, updated_at = ?
         WHERE batch_id = ? AND revision = ? AND state = 'open'`,
      )
      .run(leaseUntil, nowIso(), batchId, revision);
    claimed = res.changes === 1;
    if (claimed) {
      logEvent("review.fix_delivery_repair_claimed", {
        runId: review?.runId,
        taskId: batch.dispatchTaskId,
        payload: { reviewId: batch.reviewId, fixBatchId: batchId, revision },
      });
    }
  });
  return claimed ? refusedFixDelivery(batchId, revision) : undefined;
}

/** RF-1: reclaim a CRASH-STRANDED `repairing` record — one whose lease has strictly EXPIRED, or
 *  which carries no lease at all (an aged row). One guarded write renews the lease and keeps the
 *  record `repairing`, so exactly one of several concurrent continues wins the re-drive and the
 *  rest see a live lease and back off. A `repairing` record with a lease still in the FUTURE is a
 *  LIVE repair and is never reclaimed — returning undefined there is what stops a second concurrent
 *  repair from being dispatched over the same batch/worktree. repair_attempts is NOT incremented:
 *  the crashed attempt was already counted when it claimed; this recovers it, it is not a new one. */
export function reclaimStrandedFixDeliveryRepair(batchId: string, revision: number): RefusedFixDelivery | undefined {
  const batch = getFixBatch(batchId);
  if (!batch) throw new Error(`forge: no fix batch ${batchId}`);
  const review = getReview(batch.reviewId);
  let reclaimed = false;
  writeTransaction(() => {
    const now = storeNowMs();
    const res = getDb()
      .prepare(
        `UPDATE fix_batch_refused_deliveries
         SET lease_expires_at_ms = ?, updated_at = ?
         WHERE batch_id = ? AND revision = ? AND state = 'repairing'
           AND (lease_expires_at_ms IS NULL OR lease_expires_at_ms <= ?)`,
      )
      .run(now + FIX_REPAIR_LEASE_MS, nowIso(), batchId, revision, now);
    reclaimed = res.changes === 1;
    if (reclaimed) {
      logEvent("review.fix_delivery_repair_reclaimed", {
        runId: review?.runId,
        taskId: batch.dispatchTaskId,
        payload: { reviewId: batch.reviewId, fixBatchId: batchId, revision },
      });
    }
  });
  return reclaimed ? refusedFixDelivery(batchId, revision) : undefined;
}

/** Retire the refused-delivery record once a corrected result ingested and the cycle committed. */
export function supersedeRefusedFixDelivery(batchId: string, revision: number): void {
  const batch = getFixBatch(batchId);
  const review = batch ? getReview(batch.reviewId) : undefined;
  writeTransaction(() => {
    getDb()
      .prepare(
        `UPDATE fix_batch_refused_deliveries SET state = 'superseded', updated_at = ?
         WHERE batch_id = ? AND revision = ?`,
      )
      .run(nowIso(), batchId, revision);
    logEvent("review.fix_delivery_repair_superseded", {
      runId: review?.runId,
      taskId: batch?.dispatchTaskId,
      payload: { reviewId: batch?.reviewId, fixBatchId: batchId, revision },
    });
  });
}
