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
import { getReview, type ReviewFinding } from "./reviews.js";
import { newFixBatchId, nowIso } from "../util/ids.js";

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
 *  This is both halves of scenario #19 in one function: a fixer RETRY re-enters with the
 *  same findings at the same candidate and gets the same revision and hash back, while a
 *  CHANGED disposition set (or a moved candidate) supersedes and gets revision n+1 —
 *  never a mutated payload on the revision a container is bound to. */
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
};

export type FixIngestion =
  | { ok: true; records: FixBatchResultRecord[]; alreadyIngested: boolean }
  | { ok: false; refusal: string };

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

  const review = getReview(batch.reviewId);
  const at = nowIso();
  const before = fixBatchResults(batchId).filter((r) => r.taskId === taskId).length;

  writeTransaction(() => {
    const db = getDb();
    const insert = db.prepare(
      `INSERT OR IGNORE INTO fix_batch_results (batch_id, task_id, finding_id, result, summary,
                                                files_changed_json, evidence, interaction, evidence_path,
                                                evidence_sha256, ingested_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
  });

  return {
    ok: true,
    records: fixBatchResults(batchId).filter((r) => r.taskId === taskId),
    alreadyIngested: before > 0,
  };
}
