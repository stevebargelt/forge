// FG-560 (step 6): EVIDENCE-BASED PROJECT DISCOVERY — the store reads.
//
// model-policy.yml became a versioned config surface; `forge upgrade` must be able
// to enumerate every policy Forge could migrate — the host policy AND every project
// Forge has a durable record of having run against. This module supplies the pure
// DB half of that: it reads the path evidence Forge already records and the durable
// project-identity registry, and returns raw rows. It NEVER stats the filesystem,
// classifies reachability, or looks for a policy file — that is the v2 layer's job
// (src/v2/model-policy-discovery.ts), kept separate so this stays a pure, testable,
// write-free read.
//
// STANDING CONTRACT (protected invariant): discovery is HISTORICAL and BEST-EFFORT.
// It enumerates only projects Forge has an evidence row for — it makes no claim of
// fleet completeness — and it reads without mutating or pruning a single registry
// row. Every statement here is a SELECT.
//
// Three tables carry a project directory that proves "Forge ran here": runs,
// campaigns and host_verifications. Each keeps the caller's `project_dir` bytes
// verbatim plus the FG-693 `project_dir_canonical` (PROVEN identity, or NULL). Only
// `runs` also carries `project_identity` — the SAME-PROJECT key (FG-663) that groups
// linked worktrees and disposable clones of one project; campaigns and
// host_verifications predate it and read back NULL here. The v2 layer uses that
// column to collapse linked worktrees to one logical project.

import { getDb } from "./db.js";

/** One grouped path-evidence row: a distinct (project_dir, canonical, identity)
 *  combination that appeared in a project-scoped table, with how many rows carried
 *  it and when it was most recently seen. `projectDirCanonical` is the PROVEN
 *  identity captured at write time (or NULL); `projectIdentity` is the durable
 *  same-project key (runs only; NULL for campaigns/host_verifications). */
export type ProjectPathEvidenceRow = {
  source: "runs" | "campaigns" | "host_verifications";
  /** The caller's spelling, VERBATIM — audit evidence, never rewritten. */
  projectDir: string;
  /** FG-693 proven filesystem identity captured at write time, or NULL. */
  projectDirCanonical: string | null;
  /** FG-663 durable same-project key (runs only), or NULL. */
  projectIdentity: string | null;
  /** MAX timestamp across the grouped rows (ISO). */
  lastSeenAt: string;
  /** How many table rows carried this exact combination. */
  evidenceCount: number;
};

/** A row from the durable project-identity registry (project_identity). The
 *  registry records which project_key a repository owns; it carries NO path, so a
 *  registered project with no run/campaign/gate evidence is "known but no path". */
export type RegisteredProjectRow = {
  projectKey: string;
  repoEvidenceKey: string;
  repoEvidenceSource: string;
  createdAt: string;
};

type EvidenceQueryRow = {
  projectDir: string;
  projectDirCanonical: string | null;
  projectIdentity: string | null;
  lastSeenAt: string;
  evidenceCount: number;
};

// runs carries all three identity facts. Grouping on the full triple keeps a
// checkout that was seen under two spellings, or with and without a proven
// canonical, as distinct evidence rows — the v2 layer merges them on proven
// identity; this read does not pre-decide that. project_dir_canonical and
// project_identity arrive by ALTER on existing stores (db.ts applyMigrations) and
// exist on every store getDb() returns, so selecting them here is always valid.
const RUNS_EVIDENCE_SQL = `
  SELECT
    project_dir            AS projectDir,
    project_dir_canonical  AS projectDirCanonical,
    project_identity       AS projectIdentity,
    MAX(created_at)        AS lastSeenAt,
    COUNT(*)               AS evidenceCount
  FROM runs
  WHERE project_dir IS NOT NULL AND project_dir != ''
  GROUP BY project_dir, project_dir_canonical, project_identity
`;

// campaigns and host_verifications predate project_identity — they have no such
// column — so a literal NULL stands in its place, and the v2 layer links them to a
// logical project by proven path instead. host_verifications timestamps its rows
// with recorded_at; the others with created_at.
const CAMPAIGNS_EVIDENCE_SQL = `
  SELECT
    project_dir            AS projectDir,
    project_dir_canonical  AS projectDirCanonical,
    NULL                   AS projectIdentity,
    MAX(created_at)        AS lastSeenAt,
    COUNT(*)               AS evidenceCount
  FROM campaigns
  WHERE project_dir IS NOT NULL AND project_dir != ''
  GROUP BY project_dir, project_dir_canonical
`;

const HOST_VERIFICATIONS_EVIDENCE_SQL = `
  SELECT
    project_dir            AS projectDir,
    project_dir_canonical  AS projectDirCanonical,
    NULL                   AS projectIdentity,
    MAX(recorded_at)       AS lastSeenAt,
    COUNT(*)               AS evidenceCount
  FROM host_verifications
  WHERE project_dir IS NOT NULL AND project_dir != ''
  GROUP BY project_dir, project_dir_canonical
`;

/** Read the DISTINCT project-directory evidence Forge recorded across runs,
 *  campaigns and host_verifications. Grouped per table; the v2 layer merges rows
 *  into logical projects on proven identity. A pure read — no filesystem touch, no
 *  write. Rows with a null/empty project_dir contribute nothing (there is no path
 *  to inspect). */
export function readProjectPathEvidence(): ProjectPathEvidenceRow[] {
  const db = getDb();
  const out: ProjectPathEvidenceRow[] = [];
  const collect = (sql: string, source: ProjectPathEvidenceRow["source"]): void => {
    const rows = db.prepare(sql).all() as EvidenceQueryRow[];
    for (const r of rows) {
      out.push({
        source,
        projectDir: r.projectDir,
        projectDirCanonical: r.projectDirCanonical ?? null,
        projectIdentity: r.projectIdentity ?? null,
        lastSeenAt: r.lastSeenAt,
        evidenceCount: r.evidenceCount,
      });
    }
  };
  collect(RUNS_EVIDENCE_SQL, "runs");
  collect(CAMPAIGNS_EVIDENCE_SQL, "campaigns");
  collect(HOST_VERIFICATIONS_EVIDENCE_SQL, "host_verifications");
  return out;
}

/** Read every row from the durable project-identity registry. A registered project
 *  whose key never appears in the path evidence above is "known but no path": Forge
 *  knows it exists but has no directory to inspect for a policy. A pure read — the
 *  registry is NEVER mutated or pruned by discovery. */
export function readRegisteredProjects(): RegisteredProjectRow[] {
  const rows = getDb()
    .prepare(
      `SELECT project_key, repo_evidence_key, repo_evidence_source, created_at
       FROM project_identity`,
    )
    .all() as {
    project_key: string;
    repo_evidence_key: string;
    repo_evidence_source: string;
    created_at: string;
  }[];
  return rows.map((r) => ({
    projectKey: r.project_key,
    repoEvidenceKey: r.repo_evidence_key,
    repoEvidenceSource: r.repo_evidence_source,
    createdAt: r.created_at,
  }));
}
