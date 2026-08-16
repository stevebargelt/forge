// FG-386: the dashboard's shipping-audit projection. A temp FORGE_HOME whose
// forge.db carries the REAL schema (getDb execs SCHEMA_SQL), seeded with hand-shaped
// evidence rows, then the read-only projection over it. The point of the projection
// is that every AC state is DERIVED from persisted rows and absence is never green —
// so the fixture places one ticket in each state and the assertions read them back.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpHome = mkdtempSync(join(tmpdir(), "forge-shipaudit-"));
process.env.FORGE_HOME = tmpHome;

const { getDb, writeTransaction } = await import("../../src/store/db.js");
const {
  shippingAudit,
  rollupAuditStatus,
  readinessCellStatus,
  reviewCellStatus,
  shippingCheckStatus,
} = await import("./queries.js");

const PK = "pk-shipaudit";
const EVIDENCE_KEY = "repo-shipaudit-evidence";
// A SECOND project that shares a ticket_id with the first — the cross-project leak
// fixture (RF-2): its evidence must never surface in the first project's projection.
const PK2 = "pk-shipaudit-2";
const EVIDENCE_KEY2 = "repo-shipaudit-evidence-2";
const AT = "2026-08-16T09:00:00Z";

// ProjectRecord is resolved to project_key through project_identity, exactly as
// queueBoard does — the projection only reads `project.key`.
const PROJECT = { key: EVIDENCE_KEY } as unknown as Parameters<typeof shippingAudit>[0];

function ticket(id: string, bodyHash: string | null): void {
  getDb()
    .prepare(
      `INSERT INTO tickets (project_key, ticket_id, type, status, title, body, body_hash, imported_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    )
    .run(PK, id, "story", "active", `title ${id}`, "body", bodyHash, AT);
}

function readiness(id: string, bodyHash: string, outcome: string, gaps: string[]): void {
  getDb()
    .prepare(
      `INSERT INTO readiness_assessments (project_key, ticket_id, body_hash, outcome, gaps_json, refinement_proposal, revision, evaluated_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    )
    .run(PK, id, bodyHash, outcome, JSON.stringify(gaps), null, 1, AT);
}

function review(
  id: string,
  ticketId: string,
  state: string,
  candidateSha: string | null,
  contractJson: string | null,
  updatedAt: string,
): void {
  getDb()
    .prepare(
      `INSERT INTO reviews (id, run_id, subject_task_id, ticket_id, base_sha, contract_confirmed_sha, candidate_sha,
                            trusted_remote_sha, contract_json, review_mode, state, created_at, updated_at, settled_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(id, `run-${ticketId}`, `task-${ticketId}`, ticketId, "base", "conf", candidateSha, "remote", contractJson,
      "evidence_led", state, AT, updatedAt, state === "settled" ? updatedAt : null);
}

function finding(reviewId: string, ordinal: number, ref: string, over: Record<string, unknown> = {}): void {
  const row = {
    id: `${reviewId}/${ref}`,
    review_id: reviewId,
    ordinal,
    finding_ref: ref,
    summary: `summary ${ref}`,
    severity: "high",
    risk_lens: "security",
    reachability: "demonstrated",
    file: null,
    line: null,
    quoted_text: null,
    acceptance_ref: null,
    invariant_ref: null,
    sources_json: "[]",
    disposition: "untriaged",
    disposition_rationale: null,
    decided_by: null,
    duplicate_of: null,
    followup_ticket_id: null,
    resolution: null,
    resolution_evidence_kind: null,
    resolution_evidence: null,
    created_at: AT,
    updated_at: AT,
    ...over,
  };
  getDb()
    .prepare(
      `INSERT INTO review_findings (id, review_id, ordinal, finding_ref, summary, severity, risk_lens, reachability,
                                    file, line, quoted_text, acceptance_ref, invariant_ref, sources_json, disposition,
                                    disposition_rationale, decided_by, duplicate_of, followup_ticket_id, resolution,
                                    resolution_evidence_kind, resolution_evidence, created_at, updated_at)
       VALUES (@id,@review_id,@ordinal,@finding_ref,@summary,@severity,@risk_lens,@reachability,@file,@line,@quoted_text,
               @acceptance_ref,@invariant_ref,@sources_json,@disposition,@disposition_rationale,@decided_by,@duplicate_of,
               @followup_ticket_id,@resolution,@resolution_evidence_kind,@resolution_evidence,@created_at,@updated_at)`,
    )
    .run(row);
}

function hostCheck(ticketId: string, commitSha: string, gate: string, exit: number, source: string, recordedAt: string): void {
  getDb()
    .prepare(
      `INSERT INTO host_verifications (ticket_id, project_dir, commit_sha, gate_name, command, exit_code, source, recorded_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    )
    .run(ticketId, "/proj/shipaudit", commitSha, gate, `run ${gate}`, exit, source, recordedAt);
}

// A run stamped with the DURABLE project it belongs to (runs.project_identity), the
// key every evidence select is scoped through so a ticket_id shared across projects
// cannot leak evidence between them.
function run(id: string, projectIdentity: string): void {
  getDb()
    .prepare(`INSERT INTO runs (id, workflow, title, status, created_at, project_identity) VALUES (?,?,?,?,?,?)`)
    .run(id, "campaign", "title", "active", AT, projectIdentity);
}

function ticketIn(pk: string, id: string, bodyHash: string): void {
  getDb()
    .prepare(
      `INSERT INTO tickets (project_key, ticket_id, type, status, title, body, body_hash, imported_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    )
    .run(pk, id, "story", "active", `title ${id}`, "body", bodyHash, AT);
}

function reviewOnRun(id: string, runId: string, ticketId: string, candidateSha: string, updatedAt: string): void {
  getDb()
    .prepare(
      `INSERT INTO reviews (id, run_id, subject_task_id, ticket_id, base_sha, contract_confirmed_sha, candidate_sha,
                            trusted_remote_sha, contract_json, review_mode, state, created_at, updated_at, settled_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(id, runId, `task-${ticketId}`, ticketId, "base", "conf", candidateSha, "remote", null, "evidence_led", "settled", AT, updatedAt, updatedAt);
}

function hostCheckOnRun(ticketId: string, runId: string, commitSha: string, gate: string, exit: number, recordedAt: string): void {
  getDb()
    .prepare(
      `INSERT INTO host_verifications (ticket_id, project_dir, commit_sha, gate_name, command, exit_code, run_id, source, recorded_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    )
    .run(ticketId, "/proj/other", commitSha, gate, `run ${gate}`, exit, runId, "host", recordedAt);
}

{
  writeTransaction(() => {
    getDb()
      .prepare(`INSERT INTO project_identity (project_key, repo_evidence_key, repo_evidence_source, created_at) VALUES (?,?,?,?)`)
      .run(PK, EVIDENCE_KEY, "remote", AT);

    // FG-100 — readiness ready (fresh) + review settled + a green check → passed.
    ticket("FG-100", "h100");
    readiness("FG-100", "h100", "ready", []);
    review("review-100", "FG-100", "settled", "sha-100", '{"risk_lenses":["wide","security"]}', "2026-08-16T10:00:00Z");
    hostCheck("FG-100", "sha-100", "test:all", 0, "ci", "2026-08-16T10:05:00Z");

    // FG-101 — readiness needs_refinement (fresh), NO review → readiness failed,
    // review not_observed.
    ticket("FG-101", "h101");
    readiness("FG-101", "h101", "needs_refinement", ["add an acceptance criteria section"]);

    // FG-102 — readiness ready but the body moved (hash mismatch) → stale.
    ticket("FG-102", "h102-new");
    readiness("FG-102", "h102-old", "ready", []);

    // FG-103 — NO readiness; an in-flight review → readiness not_observed, review running.
    ticket("FG-103", "h103");
    review("review-103", "FG-103", "shipping_review", "sha-103", null, "2026-08-16T09:30:00Z");

    // FG-104 — review with an open architecture question → needs_human.
    ticket("FG-104", "h104");
    review("review-104", "FG-104", "shipping_review", "sha-104", null, "2026-08-16T09:31:00Z");
    finding("review-104", 1, "RF-1", { disposition: "architecture_question", severity: "medium" });

    // FG-105 — review's candidate differs from the latest recorded check commit →
    // superseded, marked stale.
    ticket("FG-105", "h105");
    review("review-105", "FG-105", "settled", "sha-105-old", null, "2026-08-16T09:00:00Z");
    hostCheck("FG-105", "sha-105-new", "typecheck", 0, "host", "2026-08-16T11:00:00Z");

    // FG-106 — settled review with a deferred finding → accepted deferral surfaced.
    ticket("FG-106", "h106");
    readiness("FG-106", "h106", "ready", []);
    review("review-106", "FG-106", "settled", "sha-106", null, "2026-08-16T09:10:00Z");
    finding("review-106", 1, "RF-1", {
      disposition: "deferred",
      followup_ticket_id: "FG-999",
      decided_by: "orchestrator",
      summary: "broader lifecycle cleanup",
    });

    // FG-107 — a known ticket without readiness, review, check, or campaign evidence.
    // It must still be represented as not_observed; silently omitting it makes the
    // dashboard indistinguishable from a green audit.
    ticket("FG-107", "h107");

    // FG-108 — readiness ready + a settled review + a FAILED mechanical check at the
    // review's own candidate. Both the readiness and review axes pass, but the failed
    // done-audit check must fold into the rollup and make the ROW failed — never green
    // (RF-1 / RF-4).
    ticket("FG-108", "h108");
    readiness("FG-108", "h108", "ready", []);
    review("review-108", "FG-108", "settled", "sha-108", null, "2026-08-16T09:20:00Z");
    hostCheck("FG-108", "sha-108", "test:all", 1, "host", "2026-08-16T09:25:00Z");

    // RF-2 cross-project isolation: a SECOND project owns a ticket with the SAME
    // ticket_id ("FG-XPROJ") plus a NEWER settled review and a FAILED mechanical check,
    // each tied to a run whose durable identity is the second project. When the first
    // project is projected, none of the second project's evidence may leak in — the
    // first project's own (older) review is the current one and its row has no checks.
    getDb()
      .prepare(`INSERT INTO project_identity (project_key, repo_evidence_key, repo_evidence_source, created_at) VALUES (?,?,?,?)`)
      .run(PK2, EVIDENCE_KEY2, "remote", AT);
    run("run-xproj-a", PK);
    run("run-xproj-b", PK2);

    ticketIn(PK, "FG-XPROJ", "hx");
    reviewOnRun("review-xproj-a", "run-xproj-a", "FG-XPROJ", "sha-xproj-a", "2026-08-16T09:00:00Z");

    ticketIn(PK2, "FG-XPROJ", "hx2");
    reviewOnRun("review-xproj-b", "run-xproj-b", "FG-XPROJ", "sha-xproj-b", "2026-08-16T12:00:00Z");
    hostCheckOnRun("FG-XPROJ", "run-xproj-b", "sha-xproj-b", "test:all", 1, "2026-08-16T12:05:00Z");
  });
}

test("shippingAudit: an unresolved / unselected project yields an empty projection, never a cross-project read", () => {
  assert.deepEqual(shippingAudit(null), { projectKey: null, rows: [], degraded: [] });
  assert.deepEqual(shippingAudit({ key: "unknown-evidence-key" } as never).rows, []);
});

test("shippingAudit: the projection is read-only and has no outbound-call primitive", () => {
  // `total_changes()` is connection-local and only increases for INSERT/UPDATE/
  // DELETE. A projection must leave it untouched even while joining every ledger.
  const before = (getDb().prepare("SELECT total_changes() AS changes").get() as { changes: number }).changes;
  shippingAudit(PROJECT);
  const after = (getDb().prepare("SELECT total_changes() AS changes").get() as { changes: number }).changes;
  assert.equal(after, before, "reading the audit must not mutate the ledger");

  // Keep the read surface from growing a provider, CI, git, or subprocess call.
  // It may only use the opened read-only SQLite handle and persisted rows.
  const source = readFileSync(new URL("./queries.ts", import.meta.url), "utf8");
  const projection = source.slice(source.indexOf("export function shippingAudit"), source.indexOf("// ── FG-679"));
  assert.doesNotMatch(projection, /\b(?:execFile|spawn|fetch|https?|git)\b/i, "the shipping projection must not make outbound calls");
});

test("shippingAudit: readiness ready + review settled + green check reads as passed on every axis", () => {
  const row = shippingAudit(PROJECT).rows.find((r) => r.ticketId === "FG-100")!;
  assert.ok(row);
  assert.equal(row.status, "passed");
  assert.equal(row.readiness?.status, "passed");
  assert.equal(row.readiness?.stale, false);
  assert.equal(row.review?.status, "passed");
  assert.equal(row.review?.state, "settled");
  assert.equal(row.shippingChecks.length, 1);
  assert.equal(row.shippingChecks[0]!.status, "passed");
  assert.equal(row.shippingChecks[0]!.source, "ci");
  assert.deepEqual(row.review?.riskLenses, ["wide", "security"]);
  assert.equal(row.links.commit, "sha-100");
});

test("shippingAudit: an absent axis renders not_observed, NEVER green", () => {
  const rows = shippingAudit(PROJECT).rows;
  const fg101 = rows.find((r) => r.ticketId === "FG-101")!;
  // readiness observed and failing; review absent → not_observed, and the rollup
  // is the failing readiness, not a pass.
  assert.equal(fg101.review, null);
  assert.equal(fg101.readiness?.status, "failed");
  assert.equal(fg101.status, "failed");

  const fg103 = rows.find((r) => r.ticketId === "FG-103")!;
  assert.equal(fg103.readiness, null);
  assert.equal(fg103.review?.status, "running");
  assert.equal(fg103.status, "running");
});

test("shippingAudit: a ticket with no recorded readiness or review renders not_observed, never a live pass", () => {
  const row = shippingAudit(PROJECT).rows.find((r) => r.ticketId === "FG-107");
  assert.ok(row, "a known ticket without audit evidence must remain visible to the operator");
  assert.equal(row.status, "not_observed");
  assert.equal(row.readiness, null);
  assert.equal(row.review, null);
  assert.deepEqual(row.shippingChecks, []);
});

test("shippingAudit: a moved ticket body makes its readiness assessment stale", () => {
  const row = shippingAudit(PROJECT).rows.find((r) => r.ticketId === "FG-102")!;
  assert.equal(row.readiness?.stale, true);
  assert.equal(row.readiness?.status, "stale");
  assert.equal(row.status, "stale");
});

test("shippingAudit: an open architecture question needs a human", () => {
  const row = shippingAudit(PROJECT).rows.find((r) => r.ticketId === "FG-104")!;
  assert.equal(row.review?.openArchitectureQuestions, 1);
  assert.equal(row.review?.status, "needs_human");
  assert.equal(row.status, "needs_human");
});

test("shippingAudit: a review whose candidate differs from the latest recorded check is superseded (stale)", () => {
  const row = shippingAudit(PROJECT).rows.find((r) => r.ticketId === "FG-105")!;
  assert.equal(row.review?.candidateSha, "sha-105-old");
  assert.equal(row.review?.stale, true);
  assert.equal(row.review?.status, "stale");
});

test("shippingAudit: accepted deferrals surface with their follow-up ticket, distinct from other findings", () => {
  const row = shippingAudit(PROJECT).rows.find((r) => r.ticketId === "FG-106")!;
  assert.equal(row.review?.acceptedDeferrals.length, 1);
  assert.equal(row.review?.acceptedDeferrals[0]!.followupTicketId, "FG-999");
  assert.equal(row.review?.acceptedDeferrals[0]!.decidedBy, "orchestrator");
  // The deferred finding is still a model finding (the two blocks share one review),
  // and mechanical checks (host_verifications) live in a different field entirely.
  assert.equal(row.review?.modelFindings.length, 1);
});

test("shippingAudit: rows are ordered most-attention-first and the limit bounds them", () => {
  const rows = shippingAudit(PROJECT).rows;
  // needs_human (FG-104) outranks failed (FG-101) outranks stale (FG-102/105)
  // outranks running (FG-103) outranks passed (FG-100/106).
  assert.equal(rows[0]!.ticketId, "FG-104");
  assert.equal(rows[0]!.status, "needs_human");
  assert.equal(shippingAudit(PROJECT, 2).rows.length, 2);
});

test("shippingAudit: a failed mechanical check makes a review-passed ticket failed, never green (RF-1/RF-4)", () => {
  const row = shippingAudit(PROJECT).rows.find((r) => r.ticketId === "FG-108")!;
  assert.ok(row);
  // Both derived axes pass on their own …
  assert.equal(row.readiness?.status, "passed");
  assert.equal(row.review?.status, "passed");
  // … but the persisted mechanical check FAILED, and that folds into the rollup.
  assert.equal(row.shippingChecks.length, 1);
  assert.equal(row.shippingChecks[0]!.status, "failed");
  assert.equal(row.status, "failed", "a failed done-audit check must never leave the row green");
});

test("shippingAudit: evidence never crosses projects — a shared ticket_id does not leak another project's review or checks (RF-2)", () => {
  const row = shippingAudit(PROJECT).rows.find((r) => r.ticketId === "FG-XPROJ")!;
  assert.ok(row, "the first project's own ticket must still be projected");
  // The SECOND project's review is newer, but it belongs to another project and must
  // not be selected as this ticket's current review.
  assert.equal(row.review?.id, "review-xproj-a");
  assert.equal(row.review?.candidateSha, "sha-xproj-a");
  // The second project's FAILED mechanical check must not leak in and turn this row red.
  assert.deepEqual(row.shippingChecks, []);
  assert.equal(row.status, "passed");

  // And the second project, projected on its own, sees ONLY its own evidence.
  const other = shippingAudit({ key: EVIDENCE_KEY2 } as never).rows.find((r) => r.ticketId === "FG-XPROJ")!;
  assert.equal(other.review?.id, "review-xproj-b");
  assert.equal(other.shippingChecks.length, 1);
  assert.equal(other.status, "failed");
});

test("shippingCheckStatus: a failed check dominates, all-pass passes, no checks is not_observed", () => {
  assert.equal(shippingCheckStatus([]), "not_observed");
  assert.equal(shippingCheckStatus([{ status: "passed" } as never]), "passed");
  assert.equal(shippingCheckStatus([{ status: "passed" } as never, { status: "failed" } as never]), "failed");
});

test("derive helpers: absence and staleness are never green; the rollup takes the most-attention axis", () => {
  assert.equal(rollupAuditStatus(["passed", "not_observed"]), "passed");
  assert.equal(rollupAuditStatus(["passed", "needs_human"]), "needs_human");
  assert.equal(rollupAuditStatus(["not_observed", "not_observed"]), "not_observed");
  assert.equal(rollupAuditStatus(["stale", "failed"]), "failed");

  assert.equal(readinessCellStatus("ready", false), "passed");
  assert.equal(readinessCellStatus("exploratory", false), "passed");
  assert.equal(readinessCellStatus("needs_refinement", false), "failed");
  assert.equal(readinessCellStatus("blocked", false), "needs_human");
  assert.equal(readinessCellStatus("ready", true), "stale");

  assert.equal(reviewCellStatus("settled", false, 0), "passed");
  assert.equal(reviewCellStatus("failed", false, 0), "failed");
  assert.equal(reviewCellStatus("blocked_environment", false, 0), "needs_human");
  assert.equal(reviewCellStatus("shipping_review", false, 0), "running");
  assert.equal(reviewCellStatus("settled", false, 1), "needs_human");
  assert.equal(reviewCellStatus("settled", true, 0), "stale");
});
