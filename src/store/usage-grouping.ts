// FG-747: THE ONE usage `project`-dimension grouping/normalization contract.
//
// Usage grouped by "project" was actually grouped by CHECKOUT PATH: three readers
// (dashboard usageRollup, dashboard usageModelMix, CLI `forge usage show --by
// project`) each spelled `COALESCE(r.project_dir,'(unknown project)')`, so every
// implementation clone, per-task worktree, scratchpad, and ticket-shaped directory
// of ONE repository became its own usage bucket. Branch and workspace placement are
// execution details, not accounting projects — all Forge work must roll up to Forge.
//
// This module is the SINGLE contract all three readers now import, so they cannot
// drift on bucket identity, label, request count, or token totals (AC4). It keys the
// `project` dimension on the DURABLE `runs.project_identity` FG-663 captured at
// creation, normalizing a stored `pk-` project key to its canonical `repo-` evidence
// key through the project_identity registry — the SAME normalization FG-663
// scoping/presentation use (normalizeStoredIdentityToEvidenceKey), so a run's bucket
// and its scope membership never disagree (AC5).
//
// THE COUNTING INVARIANT (AC8). The registry normalization is a LEFT JOIN on
// project_identity's UNIQUE keys (project_key PRIMARY KEY), so it re-keys WHICH
// bucket a model_call lands in and NEVER drops or fans out a row. A NULL identity
// (a legacy pre-FG-663 run, or an orphan model_call whose task/run is gone) maps to
// ONE explicit UNATTRIBUTED_LEGACY sentinel bucket — never a path/name-derived
// project, never a NULL-named bucket (AC6).
//
// DEGRADES ON AN AGED STORE. A read-only handle may point at a store a peer forge
// has not migrated to the `runs.project_identity` column yet. Naming that column
// unconditionally would fail every project query, so the builder probes for it and,
// when absent, degrades to the legacy `COALESCE(r.project_dir,'(unknown project)')`
// bucket — the same additive-only, reader-tolerates-old-schema posture as
// hasRunsProjectIdentity / runsProjectIdentitySelect in the dashboard.

import type { Database as DatabaseInstance } from "better-sqlite3";

/** The bucket KEY every NULL-identity legacy run (and every orphan model_call whose
 *  run is gone) rolls up under. A deliberately un-key-like literal so it can never
 *  collide with a real `repo-`/`pk-` identity. It is the internal grouping key; its
 *  human label is UNATTRIBUTED_LEGACY_LABEL. */
export const UNATTRIBUTED_LEGACY_KEY = "__forge_unattributed_legacy__";

/** The human label the UNATTRIBUTED_LEGACY_KEY bucket renders as, in BOTH the
 *  dashboard and the CLI (AC6). */
export const UNATTRIBUTED_LEGACY_LABEL = "Unattributed legacy usage";

/** The legacy (identity-column-absent) project bucket, kept byte-identical to the
 *  pre-FG-747 spelling so an aged/peer store groups exactly as it did before. */
export const LEGACY_PROJECT_BUCKET_UNKNOWN = "(unknown project)";

/** Does the OPEN store carry the additive `runs.project_identity` column? Probed on
 *  the passed handle (never memoized): a read-only handle may point at a store a peer
 *  migrates in place under it, and PRAGMA reads the schema SQLite already holds for
 *  this connection. A store predating the `runs` table fails closed to false. */
export function hasRunsProjectIdentity(db: DatabaseInstance): boolean {
  try {
    return (db.prepare(`PRAGMA table_info(runs)`).all() as Array<{ name: string }>).some(
      (col) => col.name === "project_identity",
    );
  } catch {
    return false;
  }
}

/** A SQL literal, single-quote-escaped. Only ever applied to compile-time constants
 *  here (the sentinel / the legacy unknown label), never to caller data. */
function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** The extra JOIN alias used to reach the project_identity registry from the runs
 *  row. Distinct enough not to collide with a caller's own aliases. */
const REGISTRY_ALIAS = "forge_pgi";

export type ProjectGroupingSql = {
  /** The SELECT expression that yields the bucket KEY for the `project` dimension,
   *  aliased by the caller `AS bucket`. */
  bucketExpr: string;
  /** The JOIN the caller must splice in AFTER its `runs` join (empty on the degraded
   *  legacy path). It is a LEFT JOIN on the registry's PRIMARY KEY, so it re-keys a
   *  row without ever dropping or duplicating it. */
  join: string;
};

/** Build the `project`-dimension bucket-key SQL for a query whose `runs` table is
 *  aliased `runsAlias`. Both readers call this instead of hand-spelling the grouping
 *  expression, so they group identically (AC4). Degrades to the legacy project_dir
 *  bucket when the identity column is absent. */
export function projectGroupingSql(db: DatabaseInstance, runsAlias: string): ProjectGroupingSql {
  if (!hasRunsProjectIdentity(db)) {
    return {
      bucketExpr: `COALESCE(${runsAlias}.project_dir, ${sqlLiteral(LEGACY_PROJECT_BUCKET_UNKNOWN)})`,
      join: "",
    };
  }
  // COALESCE(pi.repo_evidence_key, r.project_identity): a stored `pk-` key normalizes
  // to its canonical `repo-` evidence key via the registry; a stored `repo-` key (no
  // registry row on project_key) and a `pk-` with no registry row both fall through
  // unchanged — a stable if ungrouped key beats a throw. A NULL/empty identity is the
  // single unattributed-legacy sentinel bucket.
  const identity = `${runsAlias}.project_identity`;
  const bucketExpr =
    `CASE WHEN ${identity} IS NULL OR ${identity} = '' THEN ${sqlLiteral(UNATTRIBUTED_LEGACY_KEY)} ` +
    `ELSE COALESCE(${REGISTRY_ALIAS}.repo_evidence_key, ${identity}) END`;
  const join = `LEFT JOIN project_identity ${REGISTRY_ALIAS} ON ${REGISTRY_ALIAS}.project_key = ${identity}`;
  return { bucketExpr, join };
}

/** The row-in-hand mirror of the SQL bucket-key expression, for a run's stored
 *  identity already in memory (tests, and any JS-side re-grouping). Returns the SAME
 *  key the SQL would produce: the sentinel for a NULL/empty identity, else the `pk-`
 *  normalized to its `repo-` evidence key (or the input unchanged when no registry
 *  row maps it). */
export function projectBucketKeyForRow(db: DatabaseInstance, storedIdentity: string | null | undefined): string {
  if (storedIdentity == null || storedIdentity === "") return UNATTRIBUTED_LEGACY_KEY;
  if (!storedIdentity.startsWith("pk-")) return storedIdentity;
  try {
    const row = db
      .prepare(`SELECT repo_evidence_key FROM project_identity WHERE project_key = ?`)
      .get(storedIdentity) as { repo_evidence_key: string } | undefined;
    return row?.repo_evidence_key ?? storedIdentity;
  } catch {
    // A store predating the registry table cannot normalize — the stored key is the
    // best stable answer, never a throw that would take the whole rollup down.
    return storedIdentity;
  }
}

/** Resolve a bucket KEY to the human label BOTH readers render (AC4). The sentinel
 *  renders its fixed label; a `repo-` evidence key resolves through the caller's
 *  project registry (all Forge checkouts share one evidence key -> one "Forge"
 *  label); an unmatched key (a `pk-` with no registry row, or a deleted-checkout
 *  evidence key with no live record) renders as itself — a stable, if raw, label.
 *
 *  The registry is passed IN (the dashboard's cached projectsForDashboard(), the
 *  CLI's listProjects()) rather than read here, so this module needs no dependency
 *  on the projects layer and each caller keeps its own caching. */
export function resolveUsageProjectLabel(
  key: string,
  registry: ReadonlyArray<{ key: string; label: string }>,
): string {
  if (key === UNATTRIBUTED_LEGACY_KEY) return UNATTRIBUTED_LEGACY_LABEL;
  const record = registry.find((project) => project.key === key);
  return record?.label ?? key;
}
