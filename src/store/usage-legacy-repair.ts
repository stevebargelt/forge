// FG-747: THE SAFE LEGACY USAGE-ATTRIBUTION REPAIR.
//
// Usage grouped by "project" keys on the durable runs.project_identity (see
// usage-grouping.ts). A run written before FG-663 added that column carries NULL,
// so it sits in the single "Unattributed legacy usage" bucket — truthful, but on an
// aged host that is hundreds of runs (the ticket cites 626 of 737 Forge-shaped rows
// predating the column, and `forge-fg356` alone at 80 runs / ~9.6k requests).
//
// This module backfills project_identity onto those NULL rows so they roll up to the
// project they truly belong to — but ONLY from durable, RETARGET-PROOF evidence. The
// two permitted sources (AC6):
//
//   (1) the workspace_purposes bridge — a NULL-identity run whose surviving canonical
//       checkout matches a workspace_purposes row carrying a recorded project_identity.
//       That row was written at creation/retention or by an operator classify; it is
//       keyed on the PROVEN canonical path (realpath), so it is durable and
//       retarget-proof.
//   (2) an explicit operator-supplied path -> identity mapping.
//
// NEVER inferred from a basename, ticket-shaped suffix, path prefix, branch, run
// title, age, or missing remote — every one of which the ticket forbids. A checkout
// with neither source stays UNRESOLVED and remains in the unattributed bucket.
//
// THE DRY-RUN mutates nothing and reports every source checkout/path, its proposed
// identity, the row/request/token counts it would move, the evidence basis, and every
// unresolved path (AC7). THE APPLY runs inside one writeTransaction (BEGIN IMMEDIATE):
// `UPDATE runs SET project_identity = ? WHERE project_identity IS NULL AND
// project_dir = ?` writes INTO the column the read path already groups on, so the
// repair is durable across checkout deletion and dashboard restart with no read-time
// git probe (AC9), preserves totals by construction (only project_identity changes —
// no model_call or run is deleted, AC8), and is idempotent (a re-run finds the rows
// no longer NULL). Each mapping writes one usage_legacy_repair_events audit row in the
// same transaction (AC8).

import type { Database as DatabaseInstance } from "better-sqlite3";
import { getDb, writeTransaction } from "./db.js";
import { provenPhysical } from "../util/path-identity.js";
import { workspacePurposesByCanonical } from "./workspace-purpose.js";
import { hasRunsProjectIdentity } from "./usage-grouping.js";
import { nowIso } from "../util/ids.js";

/** How a proposed attribution was justified — the only two permitted, durable
 *  sources. Rendered in the dry-run so every mapping's basis is auditable. */
export type LegacyRepairEvidence = "operator-mapping" | "workspace-purpose-bridge";

/** The aggregate model-call footprint of one checkout's NULL-identity runs. */
export type LegacyUsageCounts = {
  runCount: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
};

/** One checkout the repair CAN attribute, with its evidence and the footprint it
 *  would move. */
export type LegacyRepairMapping = LegacyUsageCounts & {
  /** The as-written project_dir the NULL-identity runs recorded — the exact string
   *  the UPDATE filters on. */
  sourcePath: string;
  /** The proven canonical path, when it still resolves; null when the checkout is
   *  gone (an operator mapping can still name it by its as-written path). */
  canonicalPath: string | null;
  /** The durable project identity these runs will be attributed to. */
  proposedIdentity: string;
  evidence: LegacyRepairEvidence;
};

/** One checkout the repair will NOT touch — no durable evidence and no operator
 *  mapping. It stays in the unattributed bucket (AC6). */
export type LegacyRepairUnresolved = LegacyUsageCounts & {
  sourcePath: string;
  canonicalPath: string | null;
};

export type LegacyRepairPlan = {
  mappings: LegacyRepairMapping[];
  unresolved: LegacyRepairUnresolved[];
  /** True when the store lacks runs.project_identity — nothing to repair, and the
   *  read path is on the degraded legacy bucket anyway. */
  identityColumnAbsent: boolean;
};

type CountsRow = {
  source_path: string;
  run_count: number;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
};

/** The per-checkout footprint of every NULL-identity run that has a non-empty
 *  project_dir. runs LEFT JOIN model_calls so a run with zero recorded model_calls
 *  still surfaces as a source path (its runCount matters for the report even when it
 *  moves no tokens). Grouped by the EXACT as-written project_dir — the string the
 *  UPDATE will filter on — so the report and the apply agree row-for-row. */
function legacyCountsByCheckout(db: DatabaseInstance): CountsRow[] {
  return db
    .prepare(
      `SELECT
         r.project_dir                              AS source_path,
         COUNT(DISTINCT r.id)                       AS run_count,
         COUNT(mc.request_id)                       AS requests,
         COALESCE(SUM(mc.input_tokens), 0)          AS input_tokens,
         COALESCE(SUM(mc.output_tokens), 0)         AS output_tokens,
         COALESCE(SUM(mc.cache_read_tokens), 0)     AS cache_read_tokens,
         COALESCE(SUM(mc.cache_creation_tokens), 0) AS cache_creation_tokens
       FROM runs r
       LEFT JOIN tasks t       ON t.run_id = r.id
       LEFT JOIN model_calls mc ON mc.task_id = t.id
       WHERE r.project_identity IS NULL
         AND r.project_dir IS NOT NULL
         AND r.project_dir != ''
       GROUP BY r.project_dir
       ORDER BY requests DESC, run_count DESC`,
    )
    .all() as CountsRow[];
}

function countsFromRow(row: CountsRow): LegacyUsageCounts {
  return {
    runCount: row.run_count,
    requests: row.requests,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheCreationTokens: row.cache_creation_tokens,
  };
}

/** Normalize an operator mapping keyed by any spelling into a lookup keyed by BOTH
 *  the as-written spelling and (when it resolves) the proven canonical path, so a map
 *  entry matches a checkout whether the operator named it as recorded or canonically. */
function indexOperatorMapping(mapping: ReadonlyMap<string, string>): Map<string, string> {
  const index = new Map<string, string>();
  for (const [rawPath, identity] of mapping) {
    if (!identity) continue;
    index.set(rawPath, identity);
    const canonical = provenPhysical(rawPath);
    if (canonical) index.set(canonical, identity);
  }
  return index;
}

/** Compute the repair plan WITHOUT mutating anything (AC7). `operatorMapping` is an
 *  optional explicit path -> identity map; the workspace_purposes bridge is always
 *  consulted. A checkout resolved by BOTH prefers the operator mapping (an explicit
 *  operator decision outranks recorded creation evidence). */
export function planLegacyRepair(operatorMapping?: ReadonlyMap<string, string>): LegacyRepairPlan {
  const db = getDb({ readOnly: true });
  if (!hasRunsProjectIdentity(db)) {
    return { mappings: [], unresolved: [], identityColumnAbsent: true };
  }
  const rows = legacyCountsByCheckout(db);
  const operatorIndex = indexOperatorMapping(operatorMapping ?? new Map());

  // Resolve the canonical path once per checkout, then bulk-load the workspace_purposes
  // owner for the canonical paths that resolve.
  const canonicalByPath = new Map<string, string | null>();
  for (const row of rows) {
    if (!canonicalByPath.has(row.source_path)) {
      canonicalByPath.set(row.source_path, provenPhysical(row.source_path));
    }
  }
  const canonicalPaths = [...canonicalByPath.values()].filter((p): p is string => p !== null);
  const purposes = workspacePurposesByCanonical(canonicalPaths);

  const mappings: LegacyRepairMapping[] = [];
  const unresolved: LegacyRepairUnresolved[] = [];
  for (const row of rows) {
    const counts = countsFromRow(row);
    const canonicalPath = canonicalByPath.get(row.source_path) ?? null;

    // (2) operator mapping first — by as-written spelling or canonical path.
    const operatorIdentity =
      operatorIndex.get(row.source_path) ?? (canonicalPath ? operatorIndex.get(canonicalPath) : undefined);
    if (operatorIdentity) {
      mappings.push({
        ...counts,
        sourcePath: row.source_path,
        canonicalPath,
        proposedIdentity: operatorIdentity,
        evidence: "operator-mapping",
      });
      continue;
    }

    // (1) workspace_purposes bridge — a recorded owner identity on the surviving
    // canonical checkout. Retarget-proof: the row is keyed on the proven canonical path.
    const purpose = canonicalPath ? purposes.get(canonicalPath) : undefined;
    if (purpose?.projectIdentity) {
      mappings.push({
        ...counts,
        sourcePath: row.source_path,
        canonicalPath,
        proposedIdentity: purpose.projectIdentity,
        evidence: "workspace-purpose-bridge",
      });
      continue;
    }

    unresolved.push({ ...counts, sourcePath: row.source_path, canonicalPath });
  }
  return { mappings, unresolved, identityColumnAbsent: false };
}

export type LegacyRepairApplyResult = {
  /** One entry per mapping actually applied (a mapping that matched no still-NULL row
   *  at apply time — e.g. a repeated apply — is skipped and not reported). */
  applied: Array<{ sourcePath: string; newIdentity: string; evidence: LegacyRepairEvidence; runsUpdated: number }>;
  runsUpdated: number;
};

/** Apply an operator-approved repair (AC8/AC9). Recomputes the plan from the same
 *  mapping INSIDE the write transaction (never trusting a plan computed earlier
 *  against a store that may have moved), then for each mapping:
 *    UPDATE runs SET project_identity = ? WHERE project_identity IS NULL AND project_dir = ?
 *  and writes one usage_legacy_repair_events audit row. Idempotent: a re-run updates
 *  zero rows because they are no longer NULL. `actor` is best-effort context recorded
 *  on the audit row — never fabricated; absent stays NULL. */
export function applyLegacyRepair(
  operatorMapping?: ReadonlyMap<string, string>,
  actor?: string | null,
): LegacyRepairApplyResult {
  const now = nowIso();
  return writeTransaction(() => {
    // Recompute against the CURRENT store so the counts on the audit row and the rows
    // the UPDATE touches are one consistent snapshot under the write lock.
    const plan = planLegacyRepairInTransaction(operatorMapping);
    const db = getDb();
    const update = db.prepare(
      `UPDATE runs SET project_identity = ? WHERE project_identity IS NULL AND project_dir = ?`,
    );
    const audit = db.prepare(
      `INSERT INTO usage_legacy_repair_events
         (source_path, prior_identity, new_identity, evidence, run_count, requests,
          input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, source, actor, at)
       VALUES (@source_path, NULL, @new_identity, @evidence, @run_count, @requests,
               @input_tokens, @output_tokens, @cache_read_tokens, @cache_creation_tokens, @source, @actor, @at)`,
    );
    const applied: LegacyRepairApplyResult["applied"] = [];
    let runsUpdated = 0;
    for (const mapping of plan.mappings) {
      const info = update.run(mapping.proposedIdentity, mapping.sourcePath);
      const changed = info.changes;
      if (changed === 0) continue; // already repaired — idempotent no-op
      runsUpdated += changed;
      audit.run({
        source_path: mapping.sourcePath,
        new_identity: mapping.proposedIdentity,
        evidence: mapping.evidence,
        run_count: mapping.runCount,
        requests: mapping.requests,
        input_tokens: mapping.inputTokens,
        output_tokens: mapping.outputTokens,
        cache_read_tokens: mapping.cacheReadTokens,
        cache_creation_tokens: mapping.cacheCreationTokens,
        source: mapping.evidence,
        actor: actor ?? null,
        at: now,
      });
      applied.push({
        sourcePath: mapping.sourcePath,
        newIdentity: mapping.proposedIdentity,
        evidence: mapping.evidence,
        runsUpdated: changed,
      });
    }
    return { applied, runsUpdated };
  });
}

/** planLegacyRepair against the WRITABLE handle already open inside the transaction.
 *  Same logic as planLegacyRepair but never re-opens a read-only handle (which inside
 *  a write transaction would deadlock/observe a different snapshot). */
function planLegacyRepairInTransaction(operatorMapping?: ReadonlyMap<string, string>): LegacyRepairPlan {
  const db = getDb();
  if (!hasRunsProjectIdentity(db)) {
    return { mappings: [], unresolved: [], identityColumnAbsent: true };
  }
  const rows = legacyCountsByCheckout(db);
  const operatorIndex = indexOperatorMapping(operatorMapping ?? new Map());
  const canonicalByPath = new Map<string, string | null>();
  for (const row of rows) {
    if (!canonicalByPath.has(row.source_path)) {
      canonicalByPath.set(row.source_path, provenPhysical(row.source_path));
    }
  }
  const canonicalPaths = [...canonicalByPath.values()].filter((p): p is string => p !== null);
  const purposes = workspacePurposesByCanonical(canonicalPaths);
  const mappings: LegacyRepairMapping[] = [];
  const unresolved: LegacyRepairUnresolved[] = [];
  for (const row of rows) {
    const counts = countsFromRow(row);
    const canonicalPath = canonicalByPath.get(row.source_path) ?? null;
    const operatorIdentity =
      operatorIndex.get(row.source_path) ?? (canonicalPath ? operatorIndex.get(canonicalPath) : undefined);
    if (operatorIdentity) {
      mappings.push({ ...counts, sourcePath: row.source_path, canonicalPath, proposedIdentity: operatorIdentity, evidence: "operator-mapping" });
      continue;
    }
    const purpose = canonicalPath ? purposes.get(canonicalPath) : undefined;
    if (purpose?.projectIdentity) {
      mappings.push({ ...counts, sourcePath: row.source_path, canonicalPath, proposedIdentity: purpose.projectIdentity, evidence: "workspace-purpose-bridge" });
      continue;
    }
    unresolved.push({ ...counts, sourcePath: row.source_path, canonicalPath });
  }
  return { mappings, unresolved, identityColumnAbsent: false };
}

export type LegacyRepairEventRow = {
  id: number;
  sourcePath: string;
  priorIdentity: string | null;
  newIdentity: string;
  evidence: string;
  runCount: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  source: string;
  actor: string | null;
  at: string;
};

/** The append-only repair history, oldest first. Shape-probe guarded: a store that
 *  predates the audit table reads back empty rather than throwing. */
export function legacyRepairHistory(): LegacyRepairEventRow[] {
  const db = getDb({ readOnly: true });
  try {
    const cols = db.prepare(`PRAGMA table_info(usage_legacy_repair_events)`).all() as Array<{ name: string }>;
    if (cols.length === 0) return [];
  } catch {
    return [];
  }
  const rows = db
    .prepare(
      `SELECT id, source_path, prior_identity, new_identity, evidence, run_count, requests,
              input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, source, actor, at
         FROM usage_legacy_repair_events ORDER BY at, id`,
    )
    .all() as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r.id as number,
    sourcePath: r.source_path as string,
    priorIdentity: (r.prior_identity as string | null) ?? null,
    newIdentity: r.new_identity as string,
    evidence: r.evidence as string,
    runCount: r.run_count as number,
    requests: r.requests as number,
    inputTokens: r.input_tokens as number,
    outputTokens: r.output_tokens as number,
    cacheReadTokens: r.cache_read_tokens as number,
    cacheCreationTokens: r.cache_creation_tokens as number,
    source: r.source as string,
    actor: (r.actor as string | null) ?? null,
    at: r.at as string,
  }));
}
