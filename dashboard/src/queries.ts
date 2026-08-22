// Direct better-sqlite3 reads of ~/.forge/forge.db.
//
// Row types are re-exported from forge's @forge/types so the dashboard and
// forge share the same shape. The inline `as Array<{...}>` casts in each
// query function still hardcode snake_case column names — until forge
// introduces a single source of truth for the SQL schema, those casts are
// the remaining drift surface (column rename = runtime failure, not compile
// error). Documented in docs/SCHEMA-CONTRACT.md.

import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { Run, Task } from "@forge/types";
import { resolveProjectMeta, projectColorForKey } from "@forge/project-meta";
import { readBacklogConfig } from "@forge/backlog-config";
import { listProjects, sortProjects, operatorProjects, type ProjectRecord } from "@forge/projects";
import { repositoryCheckoutIdentity } from "@forge/repository-identity";
import { governanceView, type GovernanceView } from "@forge/governance";
import { LEGACY_BLOCKED_SOURCE, isStatusBearingEvidenceSource } from "@forge/blocked-source";
import {
  findReconcileCandidates,
  type LivenessProbe,
  type ReconcileClassification,
  type ReconcileReason,
} from "@forge/reconcile-candidate";
import {
  hasPlacementAuthority,
  launchObservationColumns,
  rowToLaunchObservation,
  type LaunchObservationRow,
  type LaunchPurpose,
} from "@forge/launch-observations";
// FG-576 step 11: the two records an interactive orchestrator has — the durable
// receipt (what was SELECTED) and the launcher-owned liveness record (whether the
// launcher is alive NOW) — plus the ONE parser for the remote-control URL's shape.
// All three imported rather than reimplemented; see the FG-576 section below.
import {
  loadHeartbeats,
  type InteractionState,
  type OrchestratorSession,
  type ProcessLiveness,
  type RecordSource,
  type SessionHealth,
} from "@forge/heartbeats";
import {
  ORCHESTRATOR_RECEIPT_COLUMNS,
  rowToOrchestratorReceipt,
  type CapabilityLimitation,
  type OrchestratorReceipt,
  type OrchestratorReceiptRow,
} from "@forge/orchestrator-receipts";
// FG-693: the ONE canonical filesystem-identity contract. Imported RELATIVELY
// rather than through an `@forge/*` alias only because adding a path alias means
// editing dashboard/tsconfig.json, which is outside this step's file boundary;
// the module is a zero-dependency leaf (node:fs + node:path), so nothing heavier
// is dragged into this typecheck than the alias would have pulled. Worth an alias
// in a follow-up.
import { identify, provenPhysical } from "../../src/util/path-identity.js";
// FG-747: the ONE usage `project`-dimension grouping/normalization contract, shared
// with the CLI so both group and label identically (AC4). Imported RELATIVELY for the
// same reason as path-identity above (adding a `@forge/*` alias would edit
// dashboard/tsconfig.json, outside this step's file boundary). Worth an alias in a
// follow-up.
import { projectGroupingSql, resolveUsageProjectLabel } from "../../src/store/usage-grouping.js";
import { findRemoteControlUrlInText } from "@forge/orchestrator-credential";
// The SAME loopback predicate that gates this surface's writes. Imported, never
// re-expressed: two definitions of "is this bind loopback" is one edit away from
// the read half and the write half disagreeing. queue-mutation.ts's only import
// from this module is `import type`, so nothing circular exists at runtime.
import { guardBindAddress } from "./queue-mutation.js";
// FG-679: the ONE shared derivation and the ONE human rendering of the launch status
// vocabulary, imported rather than reimplemented — `statusLine` is what keeps the four
// BD-4 facts four distinct facts on this surface too.
import {
  LAUNCH_OBSERVATION_FRESH_MS,
  deriveCurrentActivity,
  isLaunchId,
  observationIsFresh,
  statusLine,
  withRetentionDisposition,
  type CurrentActivity,
  type CurrentActivityScope,
  type CurrentActivityWithRetention,
} from "@forge/current-activity";
// FG-590: the ONE shared retention annotation `forge status` also uses — same function,
// so the two surfaces carry the disposition AND the resolved policy identically (FG-679).
import {
  resolveRetention,
  type RetentionPolicy,
} from "@forge/retention-policy";

export { type ProjectRecord };

/** Undefined means all projects, a string is an exact operational checkout,
 * and an array is the complete set of observed paths for one repository. */
export type ProjectScope = string | readonly string[] | undefined;

// ── FG-693: project scope is decided by filesystem IDENTITY, not by bytes ───
//
// An operating system routinely gives one directory many names — a symlinked
// parent, a system directory exposed under two prefixes, a relative spelling, a
// trailing separator. Until FG-693 every scope here was raw-string equality
// (`projectDir === scope` in process, `= ?` / `IN (…)` in SQL), so a scope
// entered under one spelling silently dropped every row recorded under another:
// the operator saw an EMPTY board for a project that was busy. That is the same
// write/read asymmetry the store layer just closed, one seam over.
//
// What replaces it, per src/util/path-identity.ts (the ONE contract). The
// operator's spellings are resolved to PROVEN identities, and rows are matched on
// the durable `project_dir_canonical` column — FG-693's additive column, carrying
// the identity PROVEN when the row was written, or NULL. `project_dir` keeps the
// bytes the caller wrote; it is audit evidence and presentation, and where an
// identity exists it decides nothing.
//
// THE PROJECTION IS THE ACTING ONE: an INDETERMINATE comparison is NOT a match, so
// a spelling that cannot be resolved never claims a row on a guess, and two
// spellings neither side can resolve are never asserted to name one tree. It is
// spelled as a set membership over PRE-PROVEN targets rather than as a
// `provenSameOnly` call per (row, target) pair — same three-valued rule, one
// syscall per distinct recorded spelling instead of one per comparison.
//
// THE DISPOSITION IS THE DISPLAY ONE. This surface LISTS; it authorizes nothing
// — no lifecycle transition, no cleanup, no gate attribution — so it takes the
// same split src/store/orchestrator-receipts.ts's `displayAttribution` makes for
// `forge show` (FG-693 step 6), and for the same reason: dropping a row a project
// can plausibly claim re-creates the exact FG-576 defect of a live orchestrator
// missing from the operator's board. Concretely, per asked spelling S:
//
//   S RESOLVES to physical P
//     · a row with a canonical identity matches iff that identity IS P. Bytes are
//       never consulted — a recorded spelling whose canonical identity is some
//       other tree belongs to that other tree, whatever it looks like.
//     · a NULL-canonical row (pre-FG-693, or written while its path was
//       unresolvable) matches iff its recorded spelling resolves to P TODAY.
//       That is read-time resolution, and it is deliberately NOT the stronger
//       retarget-proof rule the store's AUTHORITY reads take
//       (src/store/legacy-path-attribution.ts): that rule protects a PROOF, and
//       is right where a legacy row could otherwise satisfy a gate or authorize a
//       transition. Nothing here is protected by declining — being listed grants
//       no authority — while declining WOULD delete every aged row whose recorded
//       spelling goes through a symlinked prefix, which on a host that aliases
//       its temp root is the ordinary case rather than the exotic one.
//
//   S DOES NOT RESOLVE (routine here: checkouts are disposable and a scope can
//     name one that is already gone)
//     · nothing can be proven about it, so the only honest relation left is the
//       recorded bytes being the bytes we were handed. Exact equality, never
//       alias reasoning — verbatim the `unproven-target` arm of the receipt
//       read's display rule — and it preserves the pre-change behaviour for a
//       deleted checkout instead of blanking its history.
//
// A negative control falls out of the shape: two distinct physical directories
// never match each other, however much their lexical paths share, because the
// only cross-spelling relation available is equality of a RESOLVED physical path.
//
// THESE READS NEVER WRITE. A legacy spelling resolved here is not backfilled into
// the canonical column: this handle is READ-ONLY by design, and a read that
// sometimes writes would fail on exactly the aged stores this rule serves.
//
// PRESENTATION IS UNTOUCHED. Labels, basenames and `projectDir` in every payload
// still carry the operator's own spelling, byte for byte — identity decides what
// is shown, never how it is spelled.

/** FG-693's additive canonical-identity column, on every table keyed on a
 *  project directory. */
const CANONICAL_COLUMN = "project_dir_canonical";

/** The durable tables this surface scopes by project directory. */
type ScopedTable = "runs" | "host_verifications" | "orchestrator_receipts" | "campaigns";

type ScopeMatch = { clause: string; params: string[] };

const UNSCOPED: ScopeMatch = { clause: "", params: [] };
/** Nothing a row could match — the same clause the pre-change empty-array scope
 *  produced, and the honest answer for a scope with nothing behind it. */
const MATCHES_NOTHING: ScopeMatch = { clause: "AND 0 = 1", params: [] };

function sqlPlaceholders(count: number): string {
  return new Array(count).fill("?").join(",");
}

/** The operator's spellings, split by what the filesystem said about each — RESOLVED
 *  ONCE PER QUERY and then passed around.
 *
 *  Resolving it per ROW is what the pre-fix `scopeIncludes` did: it took the raw
 *  `ProjectScope` and re-walked the whole operator scope through the filesystem on
 *  every invocation, inside a loop over event rows. On the single-threaded dashboard
 *  event loop that is a synchronous realpath sweep per row, per request. */
type ScopeTargets = {
  /** PROVEN physical paths, deduplicated — two spellings of one checkout probe once,
   *  and each is ALREADY the filesystem's answer, so nothing re-resolves them. */
  physicals: ReadonlySet<string>;
  /** Spellings the filesystem would not confirm. Matched by recorded bytes ONLY. */
  unresolved: ReadonlySet<string>;
  /** One resolution per DISTINCT recorded spelling for the life of this scope object,
   *  so a legacy spelling shared by many rows (and by several tables in one query)
   *  costs one syscall rather than one per row. */
  recorded: Map<string, string | null>;
  /** FG-663: the durable project-identity keys this scope also matches on `runs`,
   *  independent of any path — the scoped project's `repo-` evidence key plus the
   *  `pk-` it maps to. Non-empty ONLY for a genuine project (array) scope; a string
   *  (exact-checkout) scope carries none so AC7 stays a pure path filter. This is
   *  the arm that keeps a run whose checkout was DELETED attributed to its project,
   *  because project_dir / project_dir_canonical can no longer resolve to anything. */
  identities: ReadonlySet<string>;
};

function resolveScopeTargets(scope: Exclude<ProjectScope, undefined>): ScopeTargets {
  // Two sets, deliberately: an unresolved SPELLING and a proven PHYSICAL path are
  // different kinds of thing, and deduplicating them in one namespace would be the
  // very conflation this contract exists to prevent.
  const physicals = new Set<string>();
  const unresolved = new Set<string>();
  for (const spelling of typeof scope === "string" ? [scope] : scope) {
    const identity = identify(spelling);
    if (identity.kind === "resolved") physicals.add(identity.physical);
    else unresolved.add(spelling);
  }
  // FG-663: only a project (array) scope carries a durable identity set. A string
  // scope is an exact operational checkout — AC7 — and is never widened by identity.
  const identities = typeof scope === "string" ? new Set<string>() : scopeProjectIdentities(scope);
  return { physicals, unresolved, recorded: new Map(), identities };
}

// FG-663: the identity keys a genuine PROJECT scope matches in addition to its
// paths. A project scope is the array resolveProjectScope() produces — exactly one
// project's observed member paths — so we recognize it structurally: the UNIQUE
// project whose registry `projectDirs` contains every path in the scope. A
// synthetic union spanning several projects, a set of raw spellings no project ever
// recorded, or an empty scope owns no single project and therefore widens NOTHING,
// which is what keeps the exact-checkout and multi-spelling scope cases path-only.
//
// The set is that one project's `repo-` evidence key (its ProjectRecord.key, what
// the dashboard registry and colors are built on) plus the `pk-` it maps to in the
// project_identity registry — the same project_key ↔ repo_evidence_key arbiter
// backlogTruthForProject reads. Runs captured a `pk-` OR a `repo-` at creation
// (src/store/runs.ts), so both spaces must be in the set for the identity arm to
// match every such run. Cross-project isolation is structural: only the one owning
// project's own keys are ever added. READ-ONLY — the registry is never written here.
// FG-663 (RF-2): the git-tracked project_key a project's live checkout declares in
// .forge/config.yml, or null. Read from the first member dir that yields one (a
// deleted checkout yields none). The SAME reader capture uses (readBacklogConfig),
// so read and write see one declared key.
function declaredProjectKey(projectDirs: readonly string[]): string | null {
  for (const dir of projectDirs) {
    const key = readBacklogConfig(dir).projectKey;
    if (key) return key;
  }
  return null;
}

/** The durable identity keys ONE project matches on `runs.project_identity`: its `repo-`
 *  evidence key, the `pk-` it maps to in the project_identity registry, and (for a
 *  pre-cutover clone whose evidence has no registry row) the git-tracked config key it
 *  declares. The declared key is added ONLY when it is unregistered or maps to THIS
 *  project's evidence, never widening into a different repository (FG-663 RF-2/RF-3).
 *  Reads the registry directly; the CALLER owns the try/catch degrade-to-paths policy. */
function projectIdentityKeys(project: ProjectRecord): Set<string> {
  const identities = new Set<string>([project.key]);
  const pk = db()
    .prepare(`SELECT project_key FROM project_identity WHERE repo_evidence_key = ?`)
    .get(project.key) as { project_key: string } | undefined;
  if (pk?.project_key) identities.add(pk.project_key);
  const declared = declaredProjectKey(project.projectDirs);
  if (declared) {
    const owner = db()
      .prepare(`SELECT repo_evidence_key FROM project_identity WHERE project_key = ?`)
      .get(declared) as { repo_evidence_key: string } | undefined;
    if (!owner || owner.repo_evidence_key === project.key) identities.add(declared);
  }
  return identities;
}

function scopeProjectIdentities(paths: readonly string[]): Set<string> {
  const identities = new Set<string>();
  if (paths.length === 0) return identities;
  try {
    const owning = projectsForDashboard().filter((project) =>
      paths.every((dir) => project.projectDirs.includes(dir)),
    );
    // Absolute paths belong to at most one project, so `owning` is 0 or 1; a scope
    // that names more than one project (or none) is not a single project's scope.
    if (owning.length !== 1) return identities;
    for (const id of projectIdentityKeys(owning[0]!)) identities.add(id);
  } catch {
    // The registry read is best-effort: a store a peer wrote before the
    // project_identity table existed, or a partial schema, degrades this scope to
    // its path arms alone rather than failing the whole query. Attribution of a
    // deleted-checkout run is lost in that degraded case, never mis-directed.
    return identities;
  }
  return identities;
}

/** The resolved form of a caller-supplied scope: `undefined` stays unscoped. */
function resolveScope(scope: ProjectScope): ScopeTargets | undefined {
  return scope === undefined ? undefined : resolveScopeTargets(scope);
}

// Whether the open store actually HAS the canonical column. The dashboard handle
// is read-only and runs no migrations (db.ts's policy), so it can be pointed at a
// store a peer forge has not migrated yet; naming a column that store lacks would
// fail every scoped query on it. Absent, every row of the table is the legacy
// population — which is exactly what it is.
//
// ONLY A PRESENT ANSWER IS CACHED, and the asymmetry is the whole point. The store
// evolves additive-only by policy (src/store/db.ts), so a column that EXISTS does not
// stop existing and a positive can be cached until the handle rotates. An ABSENT
// answer is a fact about a store that has not been migrated YET — and a peer forge
// migrating it in place is the ordinary case, since every forge process runs
// migrations on its next open. Cached for the life of the handle, that negative left
// a long-running dashboard permanently blind to the canonical column: it kept serving
// the legacy read path, which cannot reach a row whose recorded directory is gone.
//
// So a negative is re-probed. `PRAGMA table_info` reads the schema SQLite already
// holds in memory for this connection, and the callers that ask per ROW resolve their
// column shape ONCE per query instead (see inProgressVerifications), so this costs a
// handful of in-memory lookups per request rather than one per row.
const canonicalColumnCache = new Map<ScopedTable, boolean>();

function hasCanonicalColumn(table: ScopedTable): boolean {
  if (canonicalColumnCache.get(table) === true) return true;
  let present = false;
  try {
    const columns = db().prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    present = columns.some((column) => column.name === CANONICAL_COLUMN);
  } catch {
    present = false;
  }
  if (present) canonicalColumnCache.set(table, true);
  return present;
}

// FG-663: does the OPEN store carry the additive `runs.project_identity` column?
// This read-only handle may be pointed at an aged store a peer forge has not
// migrated yet, so naming the column unconditionally would fail every scoped run
// query on it. Deliberately un-memoized (matching runsProjectIdentitySelect): a
// cached `false` would leave the identity arm permanently dark the instant a peer
// applies the migration under this long-lived handle, and PRAGMA reads the schema
// SQLite already holds for this connection — cheap next to the polled query it
// guards. A store predating the `runs` table itself fails closed to `false`.
function hasRunsProjectIdentity(): boolean {
  try {
    return (db().prepare(`PRAGMA table_info(runs)`).all() as Array<{ name: string }>).some(
      (col) => col.name === "project_identity",
    );
  } catch {
    return false;
  }
}

/** Does this NULL-canonical row's recorded spelling resolve to one of the proven
 *  targets TODAY? The ACTING projection, so an unresolvable spelling is no match
 *  rather than a guess — expressed over targets that are ALREADY the filesystem's
 *  answer, so only the row's own spelling costs a syscall. `provenSameOnly(spelling,
 *  physical)` re-resolved each target once per candidate, which is roughly half the
 *  syscalls of the sweep and provably redundant: the contract's own guidance is to
 *  pre-identify when comparing one path against many. */
function legacySpellingResolvesToTarget(spelling: string, targets: ScopeTargets): boolean {
  if (targets.physicals.size === 0) return false;
  const physical = recordedPhysical(targets, spelling);
  return physical !== null && targets.physicals.has(physical);
}

// FG-693 (fix batch): the legacy sweep is bounded by CACHING it, never by capping it.
//
// The cap is not available: an unordered LIMIT is exactly the silent truncation this
// ticket exists to delete (see claimableLegacySpellings below), and a scoped read may
// not drop an in-scope row to defend its own cost. What IS available is that the
// answer barely moves. A recorded spelling's physical path is a property of the
// filesystem, not of the request, so resolving it once per SCOPE OBJECT — one per
// query, several per request, every request — pays the whole distinct-spelling
// population again on every scoped page load, on a single-threaded event loop.
//
// So the resolutions are memoized for the PROCESS, under a TTL. Steady state costs a
// scoped request no realpath at all; a cold or expired entry costs one syscall per
// distinct spelling, which is the population the scan already bounds itself by
// (DISTINCT over NULL-canonical rows: one entry per checkout an operator ever used).
//
// The TTL is what keeps this a cache and not a snapshot: a spelling that stops
// resolving, or starts resolving elsewhere, is observed within it. It is deliberately
// shorter than the dashboard's own poll cadence, so no rendered page is ever built
// from an answer older than the page before it — and the uncached code claimed no
// more than this either, since the filesystem can change between the syscall and the
// response being written.
const SCOPE_RESOLUTION_TTL_MS = 2_000;
/** Emptied rather than trimmed when it grows past this: dropping SOME entries would
 *  make which spelling stayed cached depend on insertion order, and a cache that is
 *  merely cold is always correct. */
const SCOPE_RESOLUTION_MAX_ENTRIES = 4_096;
const scopeResolutionCache = new Map<string, { physical: string | null; at: number }>();

function resolveRecordedSpelling(spelling: string): string | null {
  const now = Date.now();
  const hit = scopeResolutionCache.get(spelling);
  if (hit !== undefined && now - hit.at < SCOPE_RESOLUTION_TTL_MS) return hit.physical;
  const physical = provenPhysical(spelling);
  if (scopeResolutionCache.size >= SCOPE_RESOLUTION_MAX_ENTRIES) scopeResolutionCache.clear();
  scopeResolutionCache.set(spelling, { physical, at: now });
  return physical;
}

function recordedPhysical(targets: ScopeTargets, spelling: string): string | null {
  const memo = targets.recorded.get(spelling);
  if (memo !== undefined) return memo;
  const physical = resolveRecordedSpelling(spelling);
  targets.recorded.set(spelling, physical);
  return physical;
}

// A legacy scan reads the DISTINCT recorded spellings rather than the rows, so it
// costs one realpath per distinct spelling and not one per row — and, since
// FG-693's fix batch, one per distinct spelling PER QUERY rather than per table,
// because the resolutions are memoized on the scope object above.
//
// THERE IS DELIBERATELY NO CAP. The `LIMIT 2000` this replaces had no ORDER BY, so
// which spellings it kept was whatever SQLite happened to produce: on a store with
// more distinct legacy spellings than the cap, an in-scope row could silently
// disappear from a scoped view — which is the exact defect class FG-693 exists to
// remove, reintroduced as a performance defence. A bound that can drop a correct
// answer without saying so is not a bound, it is a silent truncation.
//
// What bounds the cost instead is the population itself. This reads DISTINCT
// project_dir over NULL-canonical rows only: it is the pre-FG-693 population plus
// any row whose path was genuinely unresolvable at write time, every writer of every
// scoped table now fills the canonical column (runs, host_verifications,
// orchestrator_receipts, campaigns, launch_observations), and DISTINCT collapses it
// to one row per checkout spelling ever recorded — tens, not thousands. So the set
// is self-extinguishing in the only sense that matters here: it cannot grow with
// traffic, only with the number of distinct checkouts an operator has ever used.
function claimableLegacySpellings(
  table: ScopedTable,
  targets: ScopeTargets,
  canonicalPresent: boolean,
): string[] {
  if (targets.physicals.size === 0) return [];
  const nullCanonical = canonicalPresent ? `${CANONICAL_COLUMN} IS NULL AND` : "";
  let spellings: Array<{ project_dir: string }>;
  try {
    spellings = db()
      .prepare(
        `SELECT DISTINCT project_dir FROM ${table}
          WHERE ${nullCanonical} project_dir IS NOT NULL AND project_dir != ''`,
      )
      .all() as Array<{ project_dir: string }>;
  } catch {
    // A store written by a peer that predates the table answers "none" — the TRUE
    // answer for it, and the same fail-quiet the receipt read already takes.
    return [];
  }
  return spellings
    .map((row) => row.project_dir)
    .filter((spelling) => legacySpellingResolvesToTarget(spelling, targets));
}

/** The scope predicate for one table, in SQL. `qualifier` is the table's alias in
 *  the statement (or the table name where it is unaliased). */
function scopeSql(table: ScopedTable, qualifier: string, scope: ProjectScope): ScopeMatch {
  if (scope === undefined) return UNSCOPED;
  const targets = resolveScopeTargets(scope);
  const physicals = [...targets.physicals];
  const unresolved = [...targets.unresolved];

  const canonicalPresent = hasCanonicalColumn(table);
  const canonical = `${qualifier}.${CANONICAL_COLUMN}`;
  const asWritten = `${qualifier}.project_dir`;
  const parts: string[] = [];
  const params: string[] = [];

  if (canonicalPresent && physicals.length > 0) {
    parts.push(`${canonical} IN (${sqlPlaceholders(physicals.length)})`);
    params.push(...physicals);
  }
  const legacy = claimableLegacySpellings(table, targets, canonicalPresent);
  if (legacy.length > 0) {
    parts.push(
      canonicalPresent
        ? `(${canonical} IS NULL AND ${asWritten} IN (${sqlPlaceholders(legacy.length)}))`
        : `${asWritten} IN (${sqlPlaceholders(legacy.length)})`,
    );
    params.push(...legacy);
  }
  // The unproven-target arm: recorded bytes, for a spelling that resolves to
  // nothing. It can only ever match rows whose stored path IS the string the
  // operator handed us, so it widens nothing an identity could have decided.
  if (unresolved.length > 0) {
    parts.push(`${asWritten} IN (${sqlPlaceholders(unresolved.length)})`);
    params.push(...unresolved);
  }
  // FG-663: the identity arm (AC5). Only `runs` carries a durable project_identity,
  // and only a genuine project scope populated the identity set (string scopes and
  // synthetic unions get an empty one — AC7 untouched). OR'd with the path arms, it
  // is what matches runs whose checkout is gone and whose project_dir /
  // project_dir_canonical therefore resolve to nothing on disk.
  if (table === "runs" && targets.identities.size > 0 && hasRunsProjectIdentity()) {
    const identities = [...targets.identities];
    parts.push(`${qualifier}.project_identity IN (${sqlPlaceholders(identities.length)})`);
    params.push(...identities);
  }

  if (parts.length === 0) return MATCHES_NOTHING;
  return { clause: `AND (${parts.join(" OR ")})`, params };
}

/** One row's project identity, as the columns record it. `identity` is FG-663's
 *  durable `runs.project_identity` — present on run rows, absent on rows from
 *  tables (campaigns) that carry no project identity of their own. */
type RowProjectIdentity = { projectDir: string | null; canonical: string | null; identity?: string | null };

/** The same decision as `scopeSql`, applied to a row already in hand — the
 *  in-process half, for the event-derived views that resolve their project
 *  through a second lookup and so have no single statement to put the clause in.
 *  Kept deliberately in step with `scopeSql`: same arms, same order.
 *
 *  Takes the ALREADY-RESOLVED scope, never the caller's raw one: this is called once
 *  per row inside a loop, and re-resolving the operator's whole scope from the
 *  filesystem there put a synchronous realpath sweep per row on the dashboard's
 *  single-threaded event loop. Set membership and a memoized per-spelling resolution
 *  are all a row costs now. */
function scopeIncludes(targets: ScopeTargets | undefined, row: RowProjectIdentity): boolean {
  if (targets === undefined) return true;
  // FG-663: a run carrying a durable project identity in the scoped project's
  // identity set matches even when its checkout is gone and no path arm resolves.
  // The set is non-empty only for a genuine project scope, so an exact-checkout
  // (AC7) scope — whose set is empty — is never widened here.
  if (row.identity != null && row.identity !== "" && targets.identities.has(row.identity)) return true;
  const projectDir = row.projectDir ?? "";
  if (row.canonical !== null && row.canonical !== "") {
    if (targets.physicals.has(row.canonical)) return true;
  } else if (projectDir !== "" && legacySpellingResolvesToTarget(projectDir, targets)) {
    return true;
  }
  return projectDir !== "" && targets.unresolved.has(projectDir);
}

// FG-616: resolved PER CALL, never snapshotted at module eval. ESM evaluates a
// static import before the importing module's body, so a module-eval snapshot
// binds whatever FORGE_HOME happened to be set at import time — the exact shape
// of the FG-607 store-path bug, where the dashboard read one host's store while
// the process had settled on another. Latent in the single-home production
// dashboard; not latent for a long-running process whose home is assigned after
// its imports, which is every integration harness that boots this server.
function forgeHome(): string {
  return process.env.FORGE_HOME ?? join(homedir(), ".forge");
}
function dbPath(): string {
  return join(forgeHome(), "forge.db");
}
function runsDir(): string {
  return join(forgeHome(), "runs");
}

// The handle is cached against the path it was opened on. A resolved path that
// no longer matches means the process now has a DIFFERENT store, and continuing
// to answer from the old connection is how a reader silently serves another
// host's tickets. Forge's own cache is keyed on dbGeneration(); this second,
// independent read-only handle is invisible to it, so it needs its own
// invalidation or a long-running dashboard would never observe a mode flip.
let _db: { path: string; handle: Database.Database } | null = null;
function db(): Database.Database {
  const path = dbPath();
  if (_db) {
    if (_db.path === path) return _db.handle;
    _db.handle.close();
    _db = null;
    // FG-693: the new store may have a different migration level, so the cached
    // answer to "does this table have the canonical column" belonged to the old
    // one. Dropped with the handle it was taken through.
    canonicalColumnCache.clear();
  }
  if (!existsSync(path)) {
    throw new Error(`forge DB not found at ${path}. Has forge run yet?`);
  }
  // WAL readers don't block writers (forge uses WAL); no contention.
  _db = { path, handle: new Database(path, { readonly: true }) };
  return _db.handle;
}

export type { Run, Task };

export type ActivityEntry = {
  taskId: string;
  runId: string;
  runTitle: string;
  workflow: string;
  projectDir: string | null;
  // Resolved at query time. label = basename(projectDir); color = .vscode
  // titleBar.activeBackground OR a deterministic hash fallback. Both null
  // when projectDir is null. See project-meta.ts.
  projectLabel: string | null;
  projectColor: string | null;
  checkoutBranch: string | null;
  checkoutName: string | null;
  agentRole: string;
  agentModel: string | null;
  // FG-560: the mapping-path provenance axis (durable resolution record, step 3).
  // "exact" = the activity was mapped directly; "default-fallback" = it fell through
  // to map.default. null in legacy mode (no policy). SEPARATE from resolvedBy.
  mappingPath: string | null;
  capabilitySource: string | null; // "explicit" | "role-derived" | null (legacy)
  phase: string;
  status: string;
  completedAt: string;
  /** Wall-clock run-time (started_at → completed_at) in ms; null if either is missing. */
  durationMs: number | null;
  result: unknown | null; // parsed JSON
  parentId: string | null;
};

/** Recent completed/failed agent outputs across all projects.
 *  Used for the activity feed. */
export function recentActivity(limit = 100, sinceIso?: string, scope?: ProjectScope): ActivityEntry[] {
  let sql = `
    SELECT t.id, t.run_id, t.parent_id, t.phase, t.agent_role, t.agent_model, t.status, t.result, t.started_at, t.completed_at${tasksModelProvenanceSelect()},
           r.title, r.workflow, r.project_dir${runsProjectIdentitySelect()}
    FROM tasks t
    JOIN runs r ON r.id = t.run_id
    WHERE t.completed_at IS NOT NULL
      AND t.status IN ('complete', 'failed', 'blocked_by_red', 'awaiting_gate')
  `;
  const params: unknown[] = [];
  if (sinceIso) {
    sql += ` AND t.completed_at > ?`;
    params.push(sinceIso);
  }
  const project = scopeSql("runs", "r", scope);
  sql += ` ${project.clause}`;
  params.push(...project.params);
  sql += ` ORDER BY t.completed_at DESC LIMIT ?`;
  params.push(limit);

  const rows = db().prepare(sql).all(...params) as Array<{
    id: string;
    run_id: string;
    parent_id: string | null;
    phase: string;
    agent_role: string;
    agent_model: string | null;
    // Optional: absent (not just null) on an unmigrated store, where the SELECT
    // omits the columns — mapped through `?? null` below so rendering is unchanged.
    resolved_mapping_path?: string | null;
    resolved_capability_source?: string | null;
    status: string;
    result: string | null;
    started_at: string | null;
    completed_at: string;
    title: string;
    workflow: string;
    project_dir: string | null;
    project_identity?: string | null;
  }>;

  return rows.map((r) => {
    const meta = projectPresentation(r.project_dir, r.project_identity);
    const durationMs = r.started_at
      ? Math.max(0, new Date(r.completed_at).getTime() - new Date(r.started_at).getTime())
      : null;
    return {
      taskId: r.id,
      runId: r.run_id,
      runTitle: r.title,
      workflow: r.workflow,
      projectDir: r.project_dir,
      projectLabel: meta?.label ?? null,
      projectColor: meta?.color ?? null,
      // Historical run rows do not capture branch. Never relabel an old run
      // with whichever branch this path happens to contain today.
      checkoutBranch: null,
      checkoutName: r.project_dir ? basename(r.project_dir) : null,
      agentRole: r.agent_role,
      agentModel: r.agent_model,
      mappingPath: r.resolved_mapping_path ?? null,
      capabilitySource: r.resolved_capability_source ?? null,
      phase: r.phase,
      status: r.status,
      completedAt: r.completed_at,
      durationMs,
      parentId: r.parent_id,
      result: r.result ? safeJsonParse(r.result) : null,
    };
  });
}

export type InFlightEntry = {
  runId: string;
  runTitle: string;
  workflow: string;
  projectDir: string | null;
  projectLabel: string | null;
  projectColor: string | null;
  checkoutBranch: string | null;
  checkoutName: string | null;
  taskId: string;
  agentRole: string;
  agentModel: string | null;
  // FG-560: mapping-path provenance (durable resolution record, step 3). null in
  // legacy mode. SEPARATE axis from the profile-selection provenance.
  mappingPath: string | null;
  capabilitySource: string | null;
  phase: string;
  status: string;
  startedAt: string | null;
  /** #290: non-null only when this running task's container is GONE — the DB row
   *  is stale and needs reconciliation. The dashboard badges it as a reconcile
   *  candidate instead of ordinary running. Null for healthy/non-running tasks.
   *  Read-only: derived from a docker + result.json probe, never reconciled here. */
  reconcile: { classification: ReconcileClassification; reason: ReconcileReason } | null;
  /** FG-576 (AC7/AC11): the interactive orchestrator this task belongs to, joined
   *  to the launcher-owned liveness record — so a session whose launcher was
   *  SIGKILLed stops rendering as active work. Reconciliation cannot answer this:
   *  it probes a CONTAINER, and an interactive orchestrator has none.
   *
   *  Null means NO RECEIPT, which is the pre-FG-576 `forge claude` row. Absence of
   *  a receipt is not evidence the session died, so those rows keep rendering as
   *  they do today. Never carries a credential. */
  orchestrator: OrchestratorLiveness | null;
};

/** Tasks currently running, awaiting gate, awaiting red, or blocked by red.
 *  Includes both primary tasks and red children.
 *
 *  Running tasks are additionally classified against container liveness (#290):
 *  a `running` row whose container is gone is annotated as a reconcile candidate
 *  so the dashboard stops faithfully showing stale `running`. The probe is
 *  injectable for tests; the classifier only docker-probes running+containerized
 *  tasks. Detection is read-only — the dashboard never calls reconcileRun. */
export function inFlight(scope?: ProjectScope, probe?: LivenessProbe): InFlightEntry[] {
  const project = scopeSql("runs", "r", scope);
  const rows = db().prepare(`
    SELECT t.id, t.run_id, t.phase, t.agent_role, t.agent_model, t.status, t.started_at${tasksModelProvenanceSelect()},
           r.title, r.workflow, r.project_dir${runsProjectIdentitySelect()}
    FROM tasks t
    JOIN runs r ON r.id = t.run_id
    WHERE t.status IN ('running', 'awaiting_gate', 'awaiting_red', 'blocked_by_red', 'awaiting_recovery')
      AND r.status = 'active'
      ${project.clause}
    ORDER BY t.started_at DESC NULLS LAST, t.created_at DESC
  `).all(...project.params) as Array<{
    id: string;
    run_id: string;
    phase: string;
    agent_role: string;
    agent_model: string | null;
    resolved_mapping_path?: string | null;
    resolved_capability_source?: string | null;
    status: string;
    started_at: string | null;
    title: string;
    workflow: string;
    project_dir: string | null;
    project_identity?: string | null;
  }>;

  // #290: classify running+containerized tasks by liveness once, map by taskId.
  // Only `reconcile_candidate` (container gone) becomes an annotation; alive,
  // liveness_unknown, and anomalous tasks render as ordinary running.
  //
  // FG-693: the scoped fan-out no longer re-derives the scope. It used to hand
  // each operator spelling to findReconcileCandidates, whose own filter is raw
  // `r.project_dir = ?` — so a scope spelled differently from the recorded path
  // annotated NOTHING, and a stale `running` row rendered as live work on exactly
  // the aliased spelling this ticket is about. The fan-out is now driven by the
  // RUNS THIS QUERY ALREADY SCOPED, which makes "scopes identically" structural
  // rather than asserted: there is only one scope decision, made above, and no
  // second raw-string comparison to disagree with it. It also probes the same
  // containers as before — every running task in an active run in scope is one of
  // these rows — so the docker cost is unchanged.
  const scopedRunIds = [...new Set(rows.map((r) => r.run_id))];
  const reconcileRows = scope === undefined
    ? findReconcileCandidates(db(), {}, probe)
    : scopedRunIds.flatMap((runId) => findReconcileCandidates(db(), { runId }, probe));
  const candidates = new Map(
    reconcileRows
      .filter((c) => c.classification === "reconcile_candidate")
      .map((c) => [c.taskId, { classification: c.classification, reason: c.reason }])
  );

  // FG-576 (AC7): only orchestrator rows are looked up — every other row is
  // container work, whose liveness is the docker probe above and not this one.
  const orchestrators = orchestratorLivenessByTask(
    rows.filter((r) => r.agent_role === "orchestrator").map((r) => r.id),
  );

  return rows.map((r) => {
    const meta = projectPresentation(r.project_dir, r.project_identity);
    return {
      runId: r.run_id,
      runTitle: r.title,
      workflow: r.workflow,
      projectDir: r.project_dir,
      projectLabel: meta?.label ?? null,
      projectColor: meta?.color ?? null,
      checkoutBranch: meta?.branch ?? null,
      checkoutName: r.project_dir ? basename(r.project_dir) : null,
      taskId: r.id,
      agentRole: r.agent_role,
      agentModel: r.agent_model,
      mappingPath: r.resolved_mapping_path ?? null,
      capabilitySource: r.resolved_capability_source ?? null,
      phase: r.phase,
      status: r.status,
      startedAt: r.started_at,
      reconcile: candidates.get(r.id) ?? null,
      orchestrator: orchestrators.get(r.id) ?? null,
    };
  });
}

/** Full task detail including container log tails + verdicts + gates. */
export type TaskDetail = {
  task: ActivityEntry;
  stdoutLog: string | null;  // bounded TAIL (last LOG_TAIL_BYTES), not the whole file
  stderrLog: string | null;
  stdoutBytes: number;       // true on-disk size, so the UI can label honestly
  stderrBytes: number;
  verdicts: VerdictRow[];
  gates: GateRow[];
  events: TaskEventEntry[];   // WALK-5: lifecycle timeline
  failureKind: string | null; // WALK-5: machine-readable failure kind, if failed
  idle: IdleInfo | null;      // WALK-5: live activity, running tasks only
  resultSizeBytes: number | null; // raw result JSON byte length; null if no result
};

// The dashboard polls running-task detail every 3s; reading whole multi-MB
// stream-json logs each tick would undo the bounded-tail discipline elsewhere.
// Read only the trailing window (most-recent activity); report the true size.
const LOG_TAIL_BYTES = 64 * 1024;

function readLogTail(path: string): { text: string | null; bytes: number } {
  let bytes: number;
  try { bytes = statSync(path).size; } catch { return { text: null, bytes: 0 }; }
  if (bytes === 0) return { text: "", bytes: 0 };
  const readBytes = Math.min(bytes, LOG_TAIL_BYTES);
  const buf = Buffer.alloc(readBytes);
  const fd = openSync(path, "r");
  try { readSync(fd, buf, 0, readBytes, bytes - readBytes); } finally { closeSync(fd); }
  return { text: buf.toString("utf8"), bytes };
}

export type TaskEventEntry = {
  eventType: string;
  payload: unknown;
  createdAt: string;
};

// Live idle state for a running task. Mirrors the CLI's computeIdleCountdown
// (WALK-1); inlined here to keep the dashboard's read path self-contained. The
// watchdog measures idle from the last stdout write, falling back to spawn time
// when no stdout has arrived — so a hung agent still counts down and expires.
export type IdleInfo = {
  hasOutput: boolean;
  idleMs: number;
  remainingMs: number;
  expired: boolean;
  idleTimeoutMs: number;
  measured: boolean;
};

// Matches src/v2/idle-watchdog.ts DEFAULT_IDLE_TIMEOUT_MS (15m) for the fallback
// when a task's manifest predates the recorded-timeout field.
const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60 * 1000;

function deriveFailureKind(events: TaskEventEntry[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (!e) continue;
    if (e.eventType === "task.completed") return null;
    if (e.eventType === "task.failed") {
      const p = e.payload as Record<string, unknown> | null;
      return p && typeof p["failure_kind"] === "string" ? (p["failure_kind"] as string) : null;
    }
  }
  return null;
}

function computeIdle(runId: string, taskId: string, status: string, startedAt: string | null): IdleInfo | null {
  if (status !== "running") return null;
  const dir = join(runsDir(), runId, taskId);
  let mtime: number | undefined;
  try { mtime = statSync(join(dir, "container.stdout.log")).mtimeMs; } catch { /* no output yet */ }
  let idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS;
  try {
    const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as { container?: { idleTimeoutMs?: unknown } };
    if (typeof m?.container?.idleTimeoutMs === "number") idleTimeoutMs = m.container.idleTimeoutMs;
  } catch { /* no/old manifest → default */ }
  const startedAtMs = startedAt ? new Date(startedAt).getTime() : undefined;
  const baseline = mtime ?? startedAtMs;
  const hasOutput = mtime !== undefined;
  if (baseline === undefined || Number.isNaN(baseline)) {
    return { hasOutput, idleMs: 0, remainingMs: idleTimeoutMs, expired: false, idleTimeoutMs, measured: false };
  }
  const idleMs = Math.max(0, Date.now() - baseline);
  const remainingMs = Math.max(0, idleTimeoutMs - idleMs);
  return { hasOutput, idleMs, remainingMs, expired: idleMs >= idleTimeoutMs, idleTimeoutMs, measured: true };
}

export type VerdictRow = {
  id: string;
  taskId: string;
  redTaskId: string;
  redRole: string;
  verdict: string;
  confidence: number;
  authority: string;
  findings: unknown;
};

export type GateRow = {
  id: string;
  taskId: string;
  decision: string;
  rationale: string | null;
  decidedAt: string;
  decidedBy: string;
};

export function taskDetail(taskId: string): TaskDetail | null {
  const taskRow = db().prepare(`
    SELECT t.id, t.run_id, t.parent_id, t.phase, t.agent_role, t.agent_model, t.status, t.result, t.completed_at,
           t.error, t.started_at${tasksModelProvenanceSelect()},
           r.title, r.workflow, r.project_dir${runsProjectIdentitySelect()}
    FROM tasks t
    JOIN runs r ON r.id = t.run_id
    WHERE t.id = ?
  `).get(taskId) as
    | {
        id: string;
        run_id: string;
        parent_id: string | null;
        phase: string;
        agent_role: string;
        agent_model: string | null;
        resolved_mapping_path?: string | null;
        resolved_capability_source?: string | null;
        status: string;
        result: string | null;
        completed_at: string | null;
        error: string | null;
        started_at: string | null;
        title: string;
        workflow: string;
        project_dir: string | null;
        project_identity?: string | null;
      }
    | undefined;
  if (!taskRow) return null;

  const taskMeta = projectPresentation(taskRow.project_dir, taskRow.project_identity);
  const task: ActivityEntry = {
    taskId: taskRow.id,
    runId: taskRow.run_id,
    runTitle: taskRow.title,
    workflow: taskRow.workflow,
    projectDir: taskRow.project_dir,
    projectLabel: taskMeta?.label ?? null,
    projectColor: taskMeta?.color ?? null,
    checkoutBranch: null,
    checkoutName: taskRow.project_dir ? basename(taskRow.project_dir) : null,
    agentRole: taskRow.agent_role,
    agentModel: taskRow.agent_model,
    mappingPath: taskRow.resolved_mapping_path ?? null,
    capabilitySource: taskRow.resolved_capability_source ?? null,
    phase: taskRow.phase,
    status: taskRow.status,
    completedAt: taskRow.completed_at ?? "",
    durationMs: taskRow.started_at && taskRow.completed_at
      ? Math.max(0, new Date(taskRow.completed_at).getTime() - new Date(taskRow.started_at).getTime())
      : null,
    parentId: taskRow.parent_id,
    result: taskRow.result ? safeJsonParse(taskRow.result) : null,
  };

  const stdoutPath = join(runsDir(), taskRow.run_id, taskId, "container.stdout.log");
  const stderrPath = join(runsDir(), taskRow.run_id, taskId, "container.stderr.log");
  const stdout = readLogTail(stdoutPath);
  const stderr = readLogTail(stderrPath);

  const verdicts = db().prepare(`
    SELECT id, task_id, red_task_id, red_role, verdict, confidence, authority, findings
    FROM verdicts WHERE task_id = ? ORDER BY created_at ASC
  `).all(taskId) as Array<{
    id: string;
    task_id: string;
    red_task_id: string;
    red_role: string;
    verdict: string;
    confidence: number;
    authority: string;
    findings: string;
  }>;

  const gates = db().prepare(`
    SELECT id, task_id, decision, rationale, decided_at, decided_by
    FROM gates WHERE task_id = ? ORDER BY decided_at ASC
  `).all(taskId) as Array<{
    id: string;
    task_id: string;
    decision: string;
    rationale: string | null;
    decided_at: string;
    decided_by: string;
  }>;

  // WALK-5: lifecycle timeline from the events table (write-only until Crawl).
  // FG-487: verification phase-boundary events are RUN-scoped (task_id is never
  // set — the loop's verification happens between tasks; reconcile gates have no
  // task at all), so a strict task_id match would never show them. Fold the
  // task's run's verification events into its timeline; they render with the
  // verification badge/detail helpers in the client.
  const eventRows = db().prepare(`
    SELECT event_type, payload, created_at
    FROM events
    WHERE task_id = ?
       OR (run_id = ? AND task_id IS NULL AND event_type IN (
            'review_loop.verification_started', 'review_loop.verification_finished',
            'campaign_item.host_gate_started', 'campaign_item.host_gate_finished',
            -- FG-566: the readiness preflight is emitted RUN-scoped from the review
            -- loop (the loop's verification happens between tasks, so there is no
            -- task_id to attach), and its refusal payload — workspace, command,
            -- exitStatus, stderrTail — is the ONLY place those facts exist. Omitted
            -- from this whitelist it had no dashboard surface at all: an operator
            -- saw a stopped loop and no reason for it.
            'host_readiness.ready', 'host_readiness.refused'))
    ORDER BY created_at ASC, id ASC
  `).all(taskId, taskRow.run_id) as Array<{ event_type: string; payload: string | null; created_at: string }>;
  const events: TaskEventEntry[] = eventRows.map((e) => ({
    eventType: e.event_type,
    payload: e.payload ? safeJsonParse(e.payload) : null,
    createdAt: e.created_at,
  }));
  const failureKind = deriveFailureKind(events);
  const idle = computeIdle(taskRow.run_id, taskId, taskRow.status, taskRow.started_at);

  const resultSizeBytes = taskRow.result ? Buffer.byteLength(taskRow.result, "utf8") : null;

  return {
    task,
    stdoutLog: stdout.text,
    stderrLog: stderr.text,
    stdoutBytes: stdout.bytes,
    stderrBytes: stderr.bytes,
    verdicts: verdicts.map((v) => ({
      id: v.id,
      taskId: v.task_id,
      redTaskId: v.red_task_id,
      redRole: v.red_role,
      verdict: v.verdict,
      confidence: v.confidence,
      authority: v.authority,
      findings: safeJsonParse(v.findings),
    })),
    gates: gates.map((g) => ({
      id: g.id,
      taskId: g.task_id,
      decision: g.decision,
      rationale: g.rationale,
      decidedAt: g.decided_at,
      decidedBy: g.decided_by,
    })),
    events,
    failureKind,
    idle,
    resultSizeBytes,
  };
}

function safeJsonParse(s: string): unknown {
  try { return JSON.parse(s); }
  catch { return s; }
}

export type GroupBy = "role" | "workflow" | "project" | "model" | "alias";

export type UsageRollupRow = {
  bucket: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  requests: number;
};

export type UsageTimeSeriesRow = {
  date: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  requests: number;
};

// RUN-3: operations metrics for the dashboard ops view. Mirrors the CLI's
// `forge metrics` (src/v2/metrics.ts) shape, computed via the dashboard's
// read-only db() to keep the dashboard self-contained. Distinct from usage
// (token/cost).
export type OpsMetrics = {
  runs: { total: number; active: number; terminal: number; clean: number; withFailures: number; successRate: number };
  taskCount: number;
  failureKinds: Array<{ kind: string; count: number }>;
  durations: Array<{ dimension: string; count: number; medianMs: number }>;
  counts: { idleKills: number; cancels: number; retries: number; redBlocks: number };
};

function opsCutoff(since: string): string | null {
  if (since === "all") return null;
  const m = since.match(/^(\d+)d$/);
  return m?.[1] ? new Date(Date.now() - parseInt(m[1], 10) * 86400_000).toISOString() : null;
}

function opsMedian(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? Math.round((s[mid - 1]! + s[mid]!) / 2) : s[mid]!;
}

export function opsMetrics(since: string, scope?: ProjectScope): OpsMetrics {
  const cutoff = opsCutoff(since);
  // FG-693: resolved ONCE for the whole roll-up, not once per sub-query. The scope
  // predicate now touches the filesystem (it resolves the operator's spellings) and
  // reads the legacy spellings, and the five sub-queries below share one window by
  // construction — recomputing it five times would also let a directory that
  // appeared or vanished mid-roll-up make the five disagree.
  const project = scopeSql("runs", "r", scope);
  // Window clause + params, applied to a `runs r` alias in each query.
  const win = (): { clause: string; params: unknown[] } => {
    const params: unknown[] = [];
    let clause = "";
    if (cutoff) { clause += " AND r.created_at >= ?"; params.push(cutoff); }
    clause += ` ${project.clause}`;
    params.push(...project.params);
    return { clause, params };
  };

  // Success rate is terminal-only: an active (in-flight) run has no outcome yet,
  // so counting it as clean would inflate the KPI while long work is running.
  // clean = completed with no failed top-level task.
  const rw = win();
  const runRows = db().prepare(`
    SELECT r.id, r.status AS status,
      (SELECT COUNT(*) FROM tasks t WHERE t.run_id = r.id AND t.parent_id IS NULL AND t.status = 'failed') AS failed
    FROM runs r WHERE 1 = 1 ${rw.clause}
  `).all(...rw.params) as Array<{ id: string; status: string; failed: number }>;
  const total = runRows.length;
  const terminalRows = runRows.filter(
    (r) => r.status === "complete" || r.status === "failed" || r.status === "abandoned",
  );
  const terminal = terminalRows.length;
  const active = total - terminal;
  const clean = terminalRows.filter((r) => r.status === "complete" && r.failed === 0).length;
  const withFailures = terminal - clean;

  const tw = win();
  const taskCount = (db().prepare(`
    SELECT COUNT(*) AS c FROM tasks t JOIN runs r ON r.id = t.run_id
    WHERE t.parent_id IS NULL ${tw.clause}
  `).get(...tw.params) as { c: number }).c;

  // Latest failure_kind per failed top-level task in the window.
  const fw = win();
  const failedKindRows = db().prepare(`
    SELECT e.payload AS payload
    FROM events e
    JOIN tasks t ON t.id = e.task_id
    JOIN runs  r ON r.id = t.run_id
    WHERE e.event_type = 'task.failed'
      AND t.parent_id IS NULL AND t.status = 'failed'
      AND e.created_at = (SELECT MAX(e2.created_at) FROM events e2 WHERE e2.task_id = e.task_id AND e2.event_type = 'task.failed')
      ${fw.clause}
  `).all(...fw.params) as Array<{ payload: string | null }>;
  const kindCounts = new Map<string, number>();
  for (const row of failedKindRows) {
    let kind = "unknown";
    try { const p = row.payload ? JSON.parse(row.payload) : null; if (p && typeof p.failure_kind === "string") kind = p.failure_kind; } catch { /* keep unknown */ }
    kindCounts.set(kind, (kindCounts.get(kind) ?? 0) + 1);
  }
  const failureKinds = [...kindCounts.entries()].map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count);

  // Median task duration by phase.
  const dw = win();
  const durRows = db().prepare(`
    SELECT t.phase AS phase, t.started_at AS started, t.completed_at AS completed
    FROM tasks t JOIN runs r ON r.id = t.run_id
    WHERE t.parent_id IS NULL AND t.started_at IS NOT NULL AND t.completed_at IS NOT NULL ${dw.clause}
  `).all(...dw.params) as Array<{ phase: string; started: string; completed: string }>;
  const byPhase = new Map<string, number[]>();
  for (const r of durRows) {
    const ms = new Date(r.completed).getTime() - new Date(r.started).getTime();
    if (ms >= 0) { const arr = byPhase.get(r.phase) ?? []; arr.push(ms); byPhase.set(r.phase, arr); }
  }
  const durations = [...byPhase.entries()].map(([dimension, arr]) => ({ dimension, count: arr.length, medianMs: opsMedian(arr) })).sort((a, b) => b.count - a.count);

  // Operational counts from the event stream.
  const cw = win();
  const countRows = db().prepare(`
    SELECT e.event_type AS et, COUNT(*) AS c
    FROM events e JOIN runs r ON r.id = e.run_id
    WHERE e.event_type IN ('task.cancelled','run.cancelled','task.retried','task.blocked_by_red') ${cw.clause}
    GROUP BY e.event_type
  `).all(...cw.params) as Array<{ et: string; c: number }>;
  const countOf = (t: string) => countRows.find((r) => r.et === t)?.c ?? 0;
  const counts = {
    idleKills: failureKinds.find((f) => f.kind === "idle_timeout")?.count ?? 0,
    cancels: countOf("task.cancelled") + countOf("run.cancelled"),
    retries: countOf("task.retried"),
    redBlocks: countOf("task.blocked_by_red"),
  };

  return {
    runs: { total, active, terminal, clean, withFailures, successRate: terminal > 0 ? clean / terminal : 0 },
    taskCount,
    failureKinds,
    durations,
    counts,
  };
}

// FG-648: average agent runtime over time, overall and by role. Distinct from
// opsMetrics's median-by-phase table, which is a single point-in-time roll-up:
// this one buckets the same durations over a window so a trend is visible.
export type AgentRuntimeWindow = "1d" | "7d" | "30d" | "90d" | "all";
export type AgentRuntimeResolution = "hour" | "day" | "week";

/** `averageMs` is null exactly when `sampleCount` is 0 — an empty bucket is
 *  reported as an observed gap, never fabricated as a zero-duration sample. */
export type AgentRuntimeBucket = {
  bucketStart: string;
  averageMs: number | null;
  sampleCount: number;
  partial: boolean;
};

export type AgentRuntimeRoleSeries = { role: string; buckets: AgentRuntimeBucket[] };
export type AgentRuntimeRoleSummary = { role: string; averageMs: number; sampleCount: number };

export type AgentRuntimeTrends = {
  window: AgentRuntimeWindow;
  resolution: AgentRuntimeResolution;
  bucketMs: number;
  rangeStart: string | null;
  rangeEnd: string;
  overall: AgentRuntimeBucket[];
  byRole: AgentRuntimeRoleSeries[];
  roleSummary: AgentRuntimeRoleSummary[];
};

export const AGENT_RUNTIME_WINDOWS = ["1d", "7d", "30d", "90d", "all"] as const;

export function isAgentRuntimeWindow(value: string): value is AgentRuntimeWindow {
  return (AGENT_RUNTIME_WINDOWS as readonly string[]).includes(value);
}

const AGENT_RUNTIME_RESOLUTION: Record<AgentRuntimeWindow, AgentRuntimeResolution> = {
  "1d": "hour",
  "7d": "day",
  "30d": "day",
  "90d": "week",
  all: "week",
};

const RESOLUTION_MS: Record<AgentRuntimeResolution, number> = {
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
};

// Buckets are aligned to UTC boundaries so the same observation always lands in
// the same bucket regardless of the reader's timezone. Epoch day 0 is a Thursday,
// hence the +3 to reach the preceding Monday.
function floorToResolution(ms: number, resolution: AgentRuntimeResolution): number {
  if (resolution === "week") {
    const dayIndex = Math.floor(ms / 86_400_000);
    return (dayIndex - ((dayIndex + 3) % 7)) * 86_400_000;
  }
  const step = RESOLUTION_MS[resolution];
  return Math.floor(ms / step) * step;
}

// FG-662: the events the process supervising a container logs at the instant it
// observed that container stop — the same set reconcile.ts calls
// `hasContainerExited`. Their timestamp is when the AGENT stopped, independent of
// whatever later rewrote completed_at. `container.killed` is deliberately NOT
// here: `forge cancel` logs it around a blind best-effort `docker kill`, so it
// records when an operator cancelled, not that an agent was still running.
const AGENT_OBSERVED_EXIT_EVENTS = [
  "container.exited",
  "container.idle_timeout",
  "container.dependency_provisioning_failed",
  "container.git_unavailable",
] as const;

// FG-662: failure kinds whose task.failed row is written by a process that was
// NOT supervising the agent's container — `forge cancel`, `forge gate --reject`,
// and the reconcile / ops-repair sweeps. For these completed_at records when the
// terminal was NOTICED, so completed_at − started_at is wall-clock-until-noticed
// rather than runtime. Every other kind is classified by the supervising process
// at the agent's own exit and keeps counting in full — idle_timeout above all.
const ADMINISTRATIVE_TERMINAL_KINDS = new Set([
  "cancelled",                            // cli/commands/cancel.ts
  "gate_rejected",                        // v2/gate.ts
  "orphaned",                             // v2/reconcile.ts, ops/repair.ts
  "orphaned_work_may_persist",            // v2/reconcile.ts
  "orphaned_needs_finalize",              // v2/reconcile.ts
  "fanout_wave_orphaned",                 // v2/reconcile.ts
  "oom_killed",                           // v2/reconcile.ts — the attached-exit oom_killed carries an exit event and never reaches here
  "pre_container_crash",                  // v2/reconcile.ts — no container ever ran
  "verification_environment_unavailable", // v2/reconcile.ts
]);

type AgentRuntimeRow = {
  role: string;
  started: string;
  completed: string;
  status: string;
  /** FG-690: the earliest attached-exit event of this attempt that start
   *  evidence authorizes — a `container.started` at or after the attempt's
   *  started_at and at or before the exit itself. Null when no exit on the
   *  attempt is authorized, which is NOT the same as having no exit at all. */
  agentExit: string | null;
  /** FG-690: 1 when the attempt carries an attached-exit event at all, whether
   *  or not one is authorized. It is what separates "a supervisor observed a
   *  stop here" — a row layer 1 must drop outright — from "nothing observed a
   *  stop", the pre-instrumentation row layer 2 still measures. 0/1 from
   *  SQLite's EXISTS. */
  attachedExit: number;
  /** FG-725: 1 when at least one task references this row as its `parent_id` —
   *  i.e. this row is a workflow fanout/coordinator PARENT, which orchestrates
   *  child tasks and runs no agent container of its own. 0/1 from SQLite's
   *  EXISTS. A genuine agent LEAF task has no children, so this is 0 for it. */
  hasChildren: number;
  /** FG-725: 1 when this row ever logged a `container.started` of its own — the
   *  evidence that an agent container actually existed for it at some point.
   *  Deliberately UNBOUNDED by started_at, unlike the FG-690 start-evidence
   *  lookup above: layer 1 asks "did the MEASURED attempt start a container";
   *  this asks the coarser "did this task EVER run one", which is all the
   *  coordinator discriminator needs. 0/1 from SQLite's EXISTS. */
  containerStarted: number;
  failedPayload: string | null;
  reconciledPayloads: string | null;
};

// group_concat separator for the task.reconciled payloads below. JSON.stringify
// escapes control characters, so a literal 0x1E can never occur inside one.
const RECONCILED_SEPARATOR = "\u001e";

function payloadObject(payload: string | null): Record<string, unknown> | null {
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload) as unknown;
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function failureKindOf(payload: string | null): string | null {
  const parsed = payloadObject(payload);
  return typeof parsed?.["failure_kind"] === "string" ? (parsed["failure_kind"] as string) : null;
}

/** FG-662: true when a process that was NOT supervising the agent's container
 *  moved this task INTO `complete` — reconcile's container-gone sweeps and
 *  `forge recover --continue`, which call markTaskComplete / markTaskRecovered
 *  with nowIso() and audit the transition on task.reconciled. This is the
 *  success-side twin of ADMINISTRATIVE_TERMINAL_KINDS, and layer 1 can never
 *  rescue these rows: reconcile's container-gone branch runs only BECAUSE no
 *  attached-exit event exists. Every audit row is inspected rather than only the
 *  latest, so a subsequent same-status one (complete_empty_result_backfilled,
 *  which writes a result and never touches completed_at) cannot mask the
 *  transition that rewrote it. */
function reconciledIntoComplete(payloads: string | null): boolean {
  if (!payloads) return false;
  return payloads.split(RECONCILED_SEPARATOR).some((payload) => {
    const parsed = payloadObject(payload);
    return parsed?.["to"] === "complete" && parsed["from"] !== "complete";
  });
}

/** FG-662: when the agent actually stopped, or null when nothing on the record
 *  says. An attached-exit event is the agent-observed end and wins over
 *  completed_at outright, because a cancel, a sweep or a gate rejection can
 *  rewrite completed_at long after the container died. With no such event — the
 *  measured attempt logged none, or every one it has predates its started_at
 *  (clock skew, a prior attempt's exit) — completed_at is the end only if the
 *  terminal was not written administratively, on either the failure side (an
 *  administrative failure_kind) or the success side (a sweep that completed the
 *  task); otherwise the row has no defensible end and contributes nothing.
 *
 *  FG-690: layer 1 additionally requires start evidence. An exit event says a
 *  supervising process saw something stop, NOT that an agent container ever
 *  existed: `runContainer` emits `container.exited` when `docker run` itself
 *  fails, so a failed start's whole wait — five hours, on the row that found
 *  this — was aggregated as agent execution. Without a `container.started` for
 *  the measured attempt the exit bounds a pre-container window, so the row is
 *  dropped outright rather than falling through to completed_at, which would
 *  hand back the very same interval. `container.dependency_provisioning_failed`
 *  from the FG-664 gate is excluded by exactly this rule and needs no case of
 *  its own: a gate refusal is decided before any container is created.
 *
 *  The evidence must PRECEDE the exit it authorizes, which is why the two are
 *  selected together rather than checked independently: `agentExit` is already
 *  the earliest AUTHORIZED exit, so a start recorded after an exit vouches for
 *  nothing, and an exit that no start precedes is passed over for the next one
 *  that a start does. `attachedExit` — an exit of any kind on this attempt — is
 *  what still drops the row instead of letting it fall to completed_at: an
 *  unauthorized exit and no exit at all are different records, and only the
 *  second is the pre-instrumentation history layer 2 exists to keep.
 *
 *  The requirement stops at layer 1. `container.started` only reached ~98%
 *  coverage from 2026-06 on, and the rows below it are the ones whose missing
 *  event is instrumentation age rather than evidence that nothing ran — layer 2
 *  keeps its existing administrative guards and is unchanged. */
function agentObservedEndMs(row: AgentRuntimeRow): number | null {
  // FG-725: a row that HAS children but never logged a container.started of its
  // own is a workflow fanout/coordinator PARENT — it coordinates child tasks and
  // runs no agent container, yet carries agent_role, started_at and completed_at
  // like any leaf. Such a parent emits no container.started and no attached-exit
  // event, so it reaches neither layer 1 (attachedExit === 0) nor an
  // administrative guard, and its completed_at — set days later when a gate
  // advance released a multi-day `awaiting_gate` wait — would otherwise be
  // returned here and charted in full as agent execution. This gate bounds the
  // layer-2 no-attached-exit fallback below: layer 2 exists to keep
  // pre-instrumentation LEAF rows (no children, a missing container.started that
  // is instrumentation age rather than proof nothing ran); a coordinator that has
  // children and never ran a container is not defensible legacy agent evidence.
  // Returning null drops the row outright — neither a sample nor a duration, in
  // the overall series or any per-role series, since the sole caller pushes an
  // observation only when this returns non-null. It takes precedence over every
  // branch below: a coordinator has no defensible agent end at all.
  if (row.hasChildren === 1 && row.containerStarted === 0) return null;
  if (row.attachedExit === 1) {
    if (row.agentExit === null) return null;
    const exitedMs = Date.parse(row.agentExit);
    if (Number.isFinite(exitedMs)) return exitedMs;
  }
  const kind = row.status === "failed" ? failureKindOf(row.failedPayload) : null;
  if (kind !== null && ADMINISTRATIVE_TERMINAL_KINDS.has(kind)) return null;
  if (reconciledIntoComplete(row.reconciledPayloads)) return null;
  const completedMs = Date.parse(row.completed);
  return Number.isFinite(completedMs) ? completedMs : null;
}

export function agentRuntimeTrends(
  window: AgentRuntimeWindow,
  scope?: ProjectScope,
  nowMs: number = Date.now(),
): AgentRuntimeTrends {
  const resolution = AGENT_RUNTIME_RESOLUTION[window];
  const bucketMs = RESOLUTION_MS[resolution];
  const floor = (ms: number) => floorToResolution(ms, resolution);

  // The window cutoff is the aligned start of the bucket the raw cutoff falls
  // in, so the leading bucket covers a whole period rather than a truncated one.
  const windowDays = window === "all" ? null : parseInt(window, 10);
  const cutoffStart = windowDays === null ? null : floor(nowMs - windowDays * 86_400_000);

  const params: unknown[] = [];
  let clause = "";
  if (cutoffStart !== null) {
    clause += " AND t.completed_at >= ?";
    params.push(new Date(cutoffStart).toISOString());
  }
  // Every window ends at now. A completed_at in the future (clock skew, a bad
  // backfill) is outside every window, so it is excluded here rather than left
  // to stretch the grid past the window the operator asked for — and excluding
  // it in SQL keeps the chart, the role summary and the sample note agreeing.
  clause += " AND t.completed_at <= ?";
  params.push(new Date(nowMs).toISOString());
  const project = scopeSql("runs", "r", scope);
  clause += ` ${project.clause}`;
  params.push(...project.params);

  // `t.phase IS 'session'` — SQLite's null-safe equality. With plain `=` a NULL
  // phase makes the whole NOT(...) NULL, which drops the row instead of keeping it.
  // FG-662: `agentExit`, `failedPayload` and `reconciledPayloads` are correlated
  // subqueries in the shape opsMetrics already uses for its failure-kind mix — the
  // earliest attached-exit event of the attempt being measured, the payload of its
  // latest task.failed, and every task.reconciled audit row it carries.
  // `markTaskRunning` re-dispatches a task IN PLACE: started_at moves to the new
  // attempt while the previous attempt's events stay on the stream, so each
  // subquery is bounded at or after started_at rather than taken globally —
  // a prior attempt's exit is not this attempt's end, and a prior attempt's
  // task.failed does not classify this attempt's terminal. Ordering on julianday
  // rather than the raw TEXT also drops an unparseable created_at (NULL, so the
  // comparison is never true) instead of letting it sort below — or, for a
  // latest-wins pick, above — a valid sibling and mask it.
  // FG-690: the start evidence layer 1 requires is correlated to the exit it
  // authorizes rather than selected beside it — bounded below by started_at, as
  // everything else here is, so a PRIOR attempt's container.started cannot vouch
  // for this one, and above by the candidate exit, so a start recorded AFTER an
  // exit cannot vouch for it either and a stale exit that lands after this
  // attempt's started_at is passed over for the next exit a start does precede.
  // Existence is all that is asked of the start event; the duration still runs
  // from started_at, never from the start. `attachedExit` is the separate
  // question of whether the attempt logged any exit at all — see
  // agentObservedEndMs for why an unauthorized exit must not fall to layer 2.
  const exitEvents = AGENT_OBSERVED_EXIT_EVENTS.map((e) => `'${e}'`).join(",");
  const rows = db().prepare(`
    SELECT t.agent_role AS role, t.started_at AS started, t.completed_at AS completed, t.status AS status,
      (SELECT x.created_at FROM events x
        WHERE x.task_id = t.id AND x.event_type IN (${exitEvents})
          AND julianday(x.created_at) >= julianday(t.started_at)
          AND EXISTS (SELECT 1 FROM events s
            WHERE s.task_id = t.id AND s.event_type = 'container.started'
              AND julianday(s.created_at) >= julianday(t.started_at)
              AND julianday(s.created_at) <= julianday(x.created_at))
        ORDER BY julianday(x.created_at), x.id LIMIT 1) AS agentExit,
      EXISTS (SELECT 1 FROM events e
        WHERE e.task_id = t.id AND e.event_type IN (${exitEvents})
          AND julianday(e.created_at) >= julianday(t.started_at)) AS attachedExit,
      -- FG-725: the coordinator-parent discriminator. hasChildren is the
      -- fanout signal -- a child sets parent_id to its parent's task id
      -- (schema.ts:138) -- and containerStarted is whether THIS attempt ran a
      -- container of its own. A row with children and no container of its own is
      -- the non-container coordinator agentObservedEndMs drops. Bounded below by
      -- started_at like every sibling subquery here: markTaskRunning
      -- re-dispatches in place, so a task that is a fanout parent this attempt
      -- but ran a real container in a PRIOR attempt would, taken globally, report
      -- containerStarted=1 off that stale start and slip the coordinator gate --
      -- reintroducing its multi-day gate wait as runtime. A genuine coordinator
      -- has no container.started in ANY attempt, so the bound does not affect it.
      EXISTS (SELECT 1 FROM tasks c WHERE c.parent_id = t.id) AS hasChildren,
      EXISTS (SELECT 1 FROM events cs
        WHERE cs.task_id = t.id AND cs.event_type = 'container.started'
          AND julianday(cs.created_at) >= julianday(t.started_at)) AS containerStarted,
      (SELECT f.payload FROM events f
        WHERE f.task_id = t.id AND f.event_type = 'task.failed'
          AND julianday(f.created_at) >= julianday(t.started_at)
        ORDER BY julianday(f.created_at) DESC, f.id DESC LIMIT 1) AS failedPayload,
      (SELECT group_concat(c.payload, char(30)) FROM events c
        WHERE c.task_id = t.id AND c.event_type = 'task.reconciled'
          AND julianday(c.created_at) >= julianday(t.started_at)) AS reconciledPayloads
    FROM tasks t JOIN runs r ON r.id = t.run_id
    WHERE t.agent_role IS NOT NULL
      AND t.started_at IS NOT NULL
      AND t.completed_at IS NOT NULL
      AND NOT (t.agent_role = 'orchestrator' AND t.phase IS 'session')
      ${clause}
  `).all(...params) as AgentRuntimeRow[];

  type Observation = { role: string; completedMs: number; durationMs: number };
  const observations: Observation[] = [];
  let earliest = Infinity;
  for (const row of rows) {
    const completedMs = Date.parse(row.completed);
    const startedMs = Date.parse(row.started);
    // FG-662: completed_at places the observation, so a row whose completed_at
    // PREDATES its started_at is not describing the attempt being measured —
    // markTaskRunning re-dispatches in place without clearing completed_at, so a
    // retry still in flight carries the previous attempt's terminal. Its own exit
    // event would hand that live attempt a positive duration, plotted into a
    // bucket the earlier attempt's completion owns.
    if (!(completedMs >= startedMs)) continue;
    // The observation still sits in the bucket its completed_at falls in; only the
    // DURATION comes off the agent-observed end.
    const endMs = agentObservedEndMs(row);
    if (endMs === null) continue;
    const durationMs = endMs - startedMs;
    if (!(durationMs >= 0)) continue;
    observations.push({ role: row.role, completedMs, durationMs });
    if (completedMs < earliest) earliest = completedMs;
  }

  // "all" has no fixed start: it begins at the earliest observation actually in
  // scope. With nothing in scope there is no range at all, and no grid to draw.
  const gridStart = cutoffStart ?? (observations.length > 0 ? floor(earliest) : null);
  const rangeEnd = new Date(nowMs).toISOString();
  if (gridStart === null) {
    return { window, resolution, bucketMs, rangeStart: null, rangeEnd, overall: [], byRole: [], roleSummary: [] };
  }

  // The grid ends at the bucket containing now — the same bucket the partial flag
  // sits on — so the trailing bucket is always the current one, in every window.
  const partialStart = floor(nowMs);
  const bucketStarts: number[] = [];
  for (let start = gridStart; start <= partialStart; start += bucketMs) bucketStarts.push(start);

  const series = (subset: Observation[]): AgentRuntimeBucket[] => {
    const sums = new Array<number>(bucketStarts.length).fill(0);
    const counts = new Array<number>(bucketStarts.length).fill(0);
    for (const obs of subset) {
      const index = Math.floor((obs.completedMs - gridStart) / bucketMs);
      if (index < 0 || index >= bucketStarts.length) continue;
      sums[index] = sums[index]! + obs.durationMs;
      counts[index] = counts[index]! + 1;
    }
    return bucketStarts.map((start, index) => ({
      bucketStart: new Date(start).toISOString(),
      averageMs: counts[index]! > 0 ? Math.round(sums[index]! / counts[index]!) : null,
      sampleCount: counts[index]!,
      partial: start === partialStart,
    }));
  };

  const byRoleObservations = new Map<string, Observation[]>();
  for (const obs of observations) {
    const bucket = byRoleObservations.get(obs.role) ?? [];
    bucket.push(obs);
    byRoleObservations.set(obs.role, bucket);
  }

  const roleSummary = [...byRoleObservations.entries()]
    .map(([role, subset]) => ({
      role,
      averageMs: Math.round(subset.reduce((total, obs) => total + obs.durationMs, 0) / subset.length),
      sampleCount: subset.length,
    }))
    .sort((a, b) => b.sampleCount - a.sampleCount || a.role.localeCompare(b.role));

  return {
    window,
    resolution,
    bucketMs,
    rangeStart: new Date(gridStart).toISOString(),
    rangeEnd,
    overall: series(observations),
    byRole: roleSummary.map(({ role }) => ({ role, buckets: series(byRoleObservations.get(role)!) })),
    roleSummary,
  };
}

// FG-683: completed-run throughput over time. The sibling metric of
// agentRuntimeTrends and deliberately its own function rather than a mode of it:
// that one observes agent TASKS and reports a mean duration, this one observes
// RUNS and reports a count. They share the window choices and the UTC-aligned
// bucket grid above, and nothing else.
export type CompletedRunsBucket = {
  bucketStart: string;
  /** Completed runs whose completed_at lands in this bucket. Always a number —
   *  zero completions is an observed throughput value, not the missing sample
   *  the duration metric reports as a null averageMs. */
  completedRuns: number;
  partial: boolean;
};

export type CompletedRunTrends = {
  window: AgentRuntimeWindow;
  resolution: AgentRuntimeResolution;
  bucketMs: number;
  rangeStart: string | null;
  rangeEnd: string;
  buckets: CompletedRunsBucket[];
  /** The sum of every bucket's count, the current partial bucket included. */
  totalCompletedRuns: number;
};

export function completedRunTrends(
  window: AgentRuntimeWindow,
  scope?: ProjectScope,
  nowMs: number = Date.now(),
): CompletedRunTrends {
  const resolution = AGENT_RUNTIME_RESOLUTION[window];
  const bucketMs = RESOLUTION_MS[resolution];
  const floor = (ms: number) => floorToResolution(ms, resolution);

  const windowDays = window === "all" ? null : parseInt(window, 10);
  const cutoffStart = windowDays === null ? null : floor(nowMs - windowDays * 86_400_000);

  const params: unknown[] = [];
  let clause = "";
  if (cutoffStart !== null) {
    clause += " AND r.completed_at >= ?";
    params.push(new Date(cutoffStart).toISOString());
  }
  clause += " AND r.completed_at <= ?";
  params.push(new Date(nowMs).toISOString());
  const project = scopeSql("runs", "r", scope);
  clause += ` ${project.clause}`;
  params.push(...project.params);

  // One row per RUN, and nothing joined to it. A run's tasks, retries, fanout
  // children, gates and host_verifications rows are all rows ABOUT the same
  // single completion, so any join to them multiplies this count by however many
  // the run happens to carry.
  // `r.workflow IS NOT 'orchestrator'` — SQLite's null-safe inequality. With plain
  // `!=` a NULL workflow makes the comparison NULL and drops a run that is not an
  // orchestrator session. What this excludes is the interactive orchestrator's own
  // instrumentation run (launch.ts writes it with workflow 'orchestrator'); every
  // workflow an operator actually runs — feature, invoke, review — counts.
  const rows = db().prepare(`
    SELECT r.completed_at AS completed
    FROM runs r
    WHERE r.status = 'complete'
      AND r.completed_at IS NOT NULL
      AND r.workflow IS NOT 'orchestrator'
      ${clause}
  `).all(...params) as Array<{ completed: string }>;

  const completions: number[] = [];
  let earliest = Infinity;
  for (const row of rows) {
    // An uninterpretable completed_at places no run in any bucket. The SQL range
    // comparison above is lexical and cannot be trusted to have dropped it.
    const completedMs = Date.parse(row.completed);
    if (!Number.isFinite(completedMs)) continue;
    completions.push(completedMs);
    if (completedMs < earliest) earliest = completedMs;
  }

  // "all" begins at the earliest completion actually in scope; with nothing in
  // scope there is no range and no grid, exactly as the duration metric reports it.
  const gridStart = cutoffStart ?? (completions.length > 0 ? floor(earliest) : null);
  const rangeEnd = new Date(nowMs).toISOString();
  if (gridStart === null) {
    return { window, resolution, bucketMs, rangeStart: null, rangeEnd, buckets: [], totalCompletedRuns: 0 };
  }

  const partialStart = floor(nowMs);
  const bucketStarts: number[] = [];
  for (let start = gridStart; start <= partialStart; start += bucketMs) bucketStarts.push(start);

  const counts = new Array<number>(bucketStarts.length).fill(0);
  for (const completedMs of completions) {
    const index = Math.floor((completedMs - gridStart) / bucketMs);
    if (index < 0 || index >= bucketStarts.length) continue;
    counts[index] = counts[index]! + 1;
  }

  const buckets = bucketStarts.map((start, index) => ({
    bucketStart: new Date(start).toISOString(),
    completedRuns: counts[index]!,
    partial: start === partialStart,
  }));

  return {
    window,
    resolution,
    bucketMs,
    rangeStart: new Date(gridStart).toISOString(),
    rangeEnd,
    buckets,
    // Summed from what is PLOTTED, so the stated total and the bars can never
    // disagree: a completion outside the grid is outside the total too.
    totalCompletedRuns: buckets.reduce((total, b) => total + b.completedRuns, 0),
  };
}

// FG-747: the project registry used to resolve a usage bucket KEY to its label —
// but ONLY for the project dimension AND only when the store carries the identity
// column (an aged/peer store on the degraded legacy path already buckets by
// project_dir path, so its buckets need no registry lookup). Gating on the column is
// also what keeps a minimal read-store — one that lacks project_dir_canonical, which
// listProjects()->uniqueProjectDirs() reads — from being touched here.
//
// Uses the UNFILTERED listProjects() (key -> label), the SAME registry the CLI's
// `forge usage show --by project` resolves against, so the two agree on every bucket's
// label including a project whose checkout is gone from disk (AC4). projectsForDashboard()
// would presentation-FILTER those out and diverge from the CLI. Best-effort: a registry
// read failure degrades to raw keys (label = key), never a thrown rollup.
function usageProjectLabelRegistry(groupBy: GroupBy): ReadonlyArray<{ key: string; label: string }> {
  if (groupBy !== "project" || !hasRunsProjectIdentity()) return [];
  try {
    return listProjects();
  } catch {
    return [];
  }
}

export function usageRollup(groupBy: GroupBy, since: string, scope?: ProjectScope, limit = 50): UsageRollupRow[] {
  // FG-747: the `project` dimension keys on the durable runs.project_identity through
  // the ONE shared grouping contract, so this and the CLI group and label identically
  // (AC4). The registry JOIN is LEFT on project_identity's PRIMARY KEY, so it re-keys a
  // row's bucket without ever dropping or fanning out a model_call (AC8). Other
  // dimensions are unchanged.
  const projectGrouping = projectGroupingSql(db(), "r");
  const groupExpr: Record<GroupBy, string> = {
    role:     "COALESCE(t.agent_role, '(unknown role)')",
    workflow: "COALESCE(r.workflow,   '(unknown workflow)')",
    project:  projectGrouping.bucketExpr,
    model:    "COALESCE(mc.model,     '(unknown model)')",
    alias:    "COALESCE(mc.alias,     '(no alias)')",
  };
  const groupingJoin = groupBy === "project" ? projectGrouping.join : "";
  const params: unknown[] = [];
  let sinceClause = "";
  if (since !== "all") {
    const m = since.match(/^(\d+)d$/);
    if (m?.[1]) {
      const cutoff = new Date(Date.now() - parseInt(m[1], 10) * 86400_000).toISOString();
      sinceClause = "AND mc.created_at >= ?";
      params.push(cutoff);
    }
  }
  const project = scopeSql("runs", "r", scope);
  const projectClause = project.clause;
  params.push(...project.params);
  params.push(limit);

  const sql = `
    SELECT
      ${groupExpr[groupBy]} AS bucket,
      SUM(mc.input_tokens)          AS in_tok,
      SUM(mc.output_tokens)         AS out_tok,
      SUM(mc.cache_read_tokens)     AS read_tok,
      SUM(mc.cache_creation_tokens) AS create_tok,
      COUNT(*) AS req_count
    FROM model_calls mc
    LEFT JOIN tasks t ON t.id = mc.task_id
    LEFT JOIN runs  r ON r.id = t.run_id
    ${groupingJoin}
    WHERE 1 = 1
      ${sinceClause}
      ${projectClause}
    GROUP BY bucket
    ORDER BY (SUM(mc.input_tokens) + SUM(mc.cache_creation_tokens) + SUM(mc.cache_read_tokens) + SUM(mc.output_tokens)) DESC
    LIMIT ?
  `;

  const rows = db().prepare(sql).all(...params) as Array<{
    bucket: string;
    in_tok: number;
    out_tok: number;
    read_tok: number;
    create_tok: number;
    req_count: number;
  }>;

  // For the project dimension the SQL bucket is the durable identity KEY; resolve it
  // to the same human label the CLI renders (all Forge checkouts -> "Forge"; the
  // sentinel -> "Unattributed legacy usage").
  const registry = usageProjectLabelRegistry(groupBy);
  return rows.map((r) => ({
    bucket: groupBy === "project" ? resolveUsageProjectLabel(r.bucket, registry) : r.bucket,
    inputTokens: r.in_tok ?? 0,
    outputTokens: r.out_tok ?? 0,
    cacheReadTokens: r.read_tok ?? 0,
    cacheCreationTokens: r.create_tok ?? 0,
    requests: r.req_count ?? 0,
  }));
}

export function usageTimeSeries(since = "30d", scope?: ProjectScope): UsageTimeSeriesRow[] {
  const params: unknown[] = [];
  let sinceClause = "";
  if (since !== "all") {
    const m = since.match(/^(\d+)d$/);
    if (m?.[1]) {
      const cutoff = new Date(Date.now() - parseInt(m[1], 10) * 86400_000).toISOString();
      sinceClause = "AND mc.created_at >= ?";
      params.push(cutoff);
    }
  }
  const project = scopeSql("runs", "r", scope);
  const projectClause = project.clause;
  params.push(...project.params);

  const sql = `
    SELECT
      date(mc.created_at) AS day,
      SUM(mc.input_tokens)          AS in_tok,
      SUM(mc.output_tokens)         AS out_tok,
      SUM(mc.cache_read_tokens)     AS read_tok,
      SUM(mc.cache_creation_tokens) AS create_tok,
      COUNT(*) AS req_count
    FROM model_calls mc
    LEFT JOIN tasks t ON t.id = mc.task_id
    LEFT JOIN runs  r ON r.id = t.run_id
    WHERE 1 = 1
      ${sinceClause}
      ${projectClause}
    GROUP BY day
    ORDER BY day ASC
  `;

  const rows = db().prepare(sql).all(...params) as Array<{
    day: string;
    in_tok: number;
    out_tok: number;
    read_tok: number;
    create_tok: number;
    req_count: number;
  }>;

  return rows.map((r) => ({
    date: r.day,
    inputTokens: r.in_tok ?? 0,
    outputTokens: r.out_tok ?? 0,
    cacheReadTokens: r.read_tok ?? 0,
    cacheCreationTokens: r.create_tok ?? 0,
    requests: r.req_count ?? 0,
  }));
}

export type ModelMixBucket = {
  bucket: string;
  models: Array<{ model: string; weightedTokens: number; requests: number }>;
};

export function usageModelMix(groupBy: GroupBy, since: string, scope?: ProjectScope): ModelMixBucket[] {
  // FG-747: same shared `project` grouping contract as usageRollup (AC4). Only the
  // project dimension changes; the LEFT-JOIN keeps the counted population identical.
  const projectGrouping = projectGroupingSql(db(), "r");
  const groupExpr: Record<GroupBy, string> = {
    role:     "COALESCE(t.agent_role, '(unknown role)')",
    workflow: "COALESCE(r.workflow,   '(unknown workflow)')",
    project:  projectGrouping.bucketExpr,
    model:    "COALESCE(mc.model,     '(unknown model)')",
    alias:    "COALESCE(mc.alias,     '(no alias)')",
  };
  const groupingJoin = groupBy === "project" ? projectGrouping.join : "";
  const params: unknown[] = [];
  let sinceClause = "";
  if (since !== "all") {
    const m = since.match(/^(\d+)d$/);
    if (m?.[1]) {
      const cutoff = new Date(Date.now() - parseInt(m[1], 10) * 86400_000).toISOString();
      sinceClause = "AND mc.created_at >= ?";
      params.push(cutoff);
    }
  }
  const project = scopeSql("runs", "r", scope);
  const projectClause = project.clause;
  params.push(...project.params);

  const sql = `
    SELECT
      ${groupExpr[groupBy]} AS bucket,
      mc.model,
      SUM(mc.input_tokens + 1.25*mc.cache_creation_tokens + 0.1*mc.cache_read_tokens + 5*mc.output_tokens) AS weighted,
      COUNT(*) AS requests
    FROM model_calls mc
    LEFT JOIN tasks t ON t.id = mc.task_id
    LEFT JOIN runs  r ON r.id = t.run_id
    ${groupingJoin}
    WHERE 1 = 1
      ${sinceClause}
      ${projectClause}
    GROUP BY bucket, mc.model
    ORDER BY bucket, weighted DESC
  `;

  const rows = db().prepare(sql).all(...params) as Array<{
    bucket: string;
    model: string;
    weighted: number;
    requests: number;
  }>;

  // Resolve the durable identity KEY to the same label the CLI renders (project
  // dimension only). Group by the durable KEY, never the resolved label: labels are
  // presentation metadata and are not unique, so two independent identities that share
  // a configured/fallback label must stay SEPARATE buckets (AC3/AC4).
  const registry = usageProjectLabelRegistry(groupBy);
  const label = (bucketKey: string): string =>
    groupBy === "project" ? resolveUsageProjectLabel(bucketKey, registry) : bucketKey;

  const map = new Map<string, ModelMixBucket>();
  for (const row of rows) {
    if (!map.has(row.bucket)) map.set(row.bucket, { bucket: label(row.bucket), models: [] });
    map.get(row.bucket)!.models.push({
      model: row.model ?? "(unknown model)",
      weightedTokens: row.weighted ?? 0,
      requests: row.requests ?? 0,
    });
  }
  return [...map.values()];
}

// #154: project registry for the dashboard Projects view.
// Delegates to the shared listProjects() (#152) so the dashboard sees the
// same union of DB-derived + filesystem-scanned projects as `forge projects
// list`, plus live-session counts from `~/.forge/orchestrators/` (#153).
//
// NB: this opens a second SQLite handle inside the dashboard process (the
// shared store/db.ts cache is per-module and separate from queries.ts's
// readonly handle above). On a fresh install with no DB, getDb() will create
// the schema; on a real install it's a no-op. Acceptable cost.
export function projectsForDashboard(): ProjectRecord[] {
  const now = Date.now();
  if (projectCache && now - projectCache.at < PROJECT_CACHE_MS) return projectCache.projects;
  const projects = presentationRegistry(sortProjects(listProjects(), "activity"));
  projectCache = { at: now, projects };
  return projects;
}

// FG-745: the OPERATOR-project membership projection, for the Projects grid. It is
// the FULL annotated set (projectsForDashboard, which every record already carries
// purpose/owner/classification/retentionReason through since listProjects annotates)
// with the shared operatorProjects() filter applied — the SAME membership `forge
// projects list` computes, so the CLI and GET /api/projects agree (AC7). It drops
// ONLY records recorded as an explicit artifact kind and keeps operator + (flagged)
// unclassified — the visible fail-safe; no path/name/age/run-count/remote heuristic
// decides visibility.
//
// CRITICAL (AC5): this is applied ONLY to the Projects grid. scopeSql / inFlight() /
// recentActivity() and resolveProjectScope() consume the UNFILTERED
// projectsForDashboard(), so an active artifact's runs and live session stay reachable
// in Current Activity and its scope still resolves — the Projects presentation filter
// never hides live work.
export function operatorProjectsForDashboard(): ProjectRecord[] {
  return operatorProjects(projectsForDashboard());
}

// FG-595: presentation-only view over the canonical ProjectRecord aggregate.
// A checkout is a stale artifact — a deleted scratchpad, a removed temp clone —
// only when it is simultaneously gone from disk (exists===false), carries no
// in-flight work (inFlightCount===0), and hosts no live session
// (liveSessions===0); those are suppressed so the Projects view and checkout
// scope controls stop surfacing dead paths. A present checkout (even if idle),
// or a missing one that still has active work or a live session, stays visible
// — the client labels a surviving missing checkout truthfully rather than as an
// unknown branch. The record's aggregate runCount/inFlightCount/liveSessions/
// lastRunAt and its full historical projectDirs array are passed through
// untouched, so canonical projectKey scope still queries every historical
// feed/usage/run record. A project is omitted only when no visible checkout
// remains after suppression.
export function presentationRegistry(projects: ProjectRecord[]): ProjectRecord[] {
  const out: ProjectRecord[] = [];
  for (const project of projects) {
    const checkouts = project.checkouts.filter(
      (checkout) => checkout.exists || checkout.inFlightCount > 0 || checkout.liveSessions > 0,
    );
    if (checkouts.length === 0) continue;
    out.push({ ...project, checkouts });
  }
  return out;
}

// Registry discovery executes bounded Git commands for every observed checkout.
// Keep it aligned with the dashboard's slow-poll cadence so one canonical
// selection fans out to feed/in-flight/usage/etc. without re-scanning between
// simultaneous requests. DB rows themselves are still queried on every call.
const PROJECT_CACHE_MS = 30_000;
let projectCache: { at: number; projects: ProjectRecord[] } | null = null;

/** Resolve HTTP selection into either one exact checkout or every observed
 * member path of a canonical repository. Unknown keys intentionally match
 * nothing instead of falling back to an unscoped cross-project query. */
export function resolveProjectScope(projectKey?: string, projectDir?: string): ProjectScope {
  if (projectDir) return projectDir;
  if (!projectKey) return undefined;
  const projects = projectsForDashboard();
  const selected = projects.find((project) => project.key === projectKey);
  if (!selected) return [];
  const dirs = new Set<string>(selected.projectDirs);
  // FG-745 (review RF-3 / AC5): a SEPARATELY-IDENTIFIED artifact — one whose repository
  // identity does not converge with its owner (e.g. a private no-remote clone) — is its
  // OWN ProjectRecord, suppressed from the Projects grid but with live work that must
  // still surface under its owner in Current Activity. Add every such artifact's member
  // paths to the owner's scope, matched on the DECLARED owner identity the artifact
  // carries (project_identity), never on a path/name/kind. Purpose-BLIND: the ownership
  // link adds the paths, so the suppression classification never enters run-scoping —
  // the invariant that suppression lives ONLY in the Projects projection.
  try {
    const ownerIdentities = projectIdentityKeys(selected);
    for (const project of projects) {
      if (project.key === projectKey) continue;
      const ownerId = project.owner?.projectIdentity;
      if (ownerId && ownerIdentities.has(ownerId)) {
        for (const dir of project.projectDirs) dirs.add(dir);
      }
    }
  } catch {
    // A registry read failure degrades to the selected project's own scope — never a
    // cross-project widening, the same fail-quiet the identity resolution takes.
  }
  return [...dirs];
}

// ─── backlog ticket truth (FG-608, FG-496 Slice C) ──────────────────────────
//
// Tickets are HOST-WIDE truth keyed by project_key, not branch-local files.
// Every checkout of one repository — canonical, feature branch, linked worktree,
// clone — answers with the SAME rows, because they all resolve to the same
// project_key. The dashboard's old canonical-main/master ticket-source
// resolution is gone with the branch concept it encoded.
//
// The project_key is DERIVED, never accepted. `backlogTruthForProject` takes a
// resolved ProjectRecord (the dashboard's own registry resolution) and looks its
// repository EVIDENCE key up in project_identity — the same durable arbiter
// src/store/project-registry.ts writes and src/backlog/storage-mode.ts reads.
// Taking a ProjectRecord rather than a key string is the point: a request
// parameter cannot be forged into one, so a client cannot name a project_key the
// dashboard's own resolution does not authorize. The dashboard stays a
// PER-PROJECT board (cross-project aggregation is FG-591, not here).
//
// A repository with no project_identity row has never been imported: it has no
// ticket truth at all, and that is reported as projectKey: null rather than
// papered over with a branch-local Markdown read. Same for a mismatched evidence
// key (a repo registered before it gained a remote) — the operator repair is
// host-side `forge backlog reidentify`, never a read-path fallback.

/** Reconstructed shape of `forge backlog list` — mirrors StructuredTicket in
 *  src/backlog/structured.ts so the dashboard and the CLI describe one ticket
 *  the same way. No checkoutDir/checkoutBranch: a ticket belongs to a project,
 *  not to a checkout. */
export type BacklogTicket = {
  id: string;
  type: string;
  status: string;
  title: string;
  body: string;
  epic?: string;
  created?: string;
  closed?: string;
  closedCommit?: string;
  related?: string[];
};

export type BacklogTruth = {
  /** null = this repository has no ticket truth (never imported / not registered). */
  projectKey: string | null;
  /** Which store is AUTHORITATIVE for those rows. `markdown` means the rows are
   *  an imported shadow the project has not cut over to yet; null when there is
   *  no project_key at all. */
  storageMode: "db" | "markdown" | null;
  tickets: BacklogTicket[];
};

const NO_TICKET_TRUTH: BacklogTruth = { projectKey: null, storageMode: null, tickets: [] };

// FG-609 surface (iii) of four. The DB status vocabulary is exactly
// active/done/deferred; legacy `blocked` is stored as active + a blocker_evidence
// row and reconstructed on the way out. The dashboard reconstructs it identically
// or it would render an unblocked-looking board the CLI disagrees with.
//
// This literal used to be a PRIVATE COPY here — the one exception to "hardcoded
// like every other column name", because it is not a column name but a VALUE two
// independent code paths must agree on, and each side's own tests wrote the string
// they read, so a drift in either copy stayed green on both suites. Slice D
// collapses it: the sole declaration is src/store/blocked-source.ts, a ZERO-IMPORT
// leaf reached through the @forge/blocked-source path alias. Routing it through
// src/store/tickets.ts instead was not an option — that module imports getDb, which
// would drag better-sqlite3 and the whole store handle into this typecheck.

/** Host-wide ticket truth for one resolved project. Throws if the store cannot
 *  be read — the caller decides what a failed read means to its payload. */
export function backlogTruthForProject(project: ProjectRecord): BacklogTruth {
  const identity = db()
    .prepare(`SELECT project_key FROM project_identity WHERE repo_evidence_key = ?`)
    .get(project.key) as { project_key: string } | undefined;
  if (!identity) return NO_TICKET_TRUTH;
  const projectKey = identity.project_key;

  const mode = db()
    .prepare(`SELECT mode FROM ticket_storage_mode WHERE project_key = ?`)
    .get(projectKey) as { mode: string } | undefined;

  const rows = db().prepare(`
    SELECT ticket_id, type, status, title, body, created, closed, closed_commit, epic
    FROM tickets WHERE project_key = ?
  `).all(projectKey) as Array<{
    ticket_id: string;
    type: string;
    status: string;
    title: string;
    body: string;
    created: string | null;
    closed: string | null;
    closed_commit: string | null;
    epic: string | null;
  }>;

  // Two set-wide queries instead of two per ticket: a board with several hundred
  // tickets is a normal size and this route is polled.
  const related = new Map<string, string[]>();
  for (const rel of db().prepare(`
    SELECT ticket_id, related_id FROM ticket_relations
    WHERE project_key = ? AND rel_type = 'related' ORDER BY related_id ASC
  `).all(projectKey) as Array<{ ticket_id: string; related_id: string }>) {
    const list = related.get(rel.ticket_id) ?? [];
    list.push(rel.related_id);
    related.set(rel.ticket_id, list);
  }

  const blocked = new Set(
    (db().prepare(`SELECT ticket_id FROM blocker_evidence WHERE project_key = ? AND source = ?`)
      .all(projectKey, LEGACY_BLOCKED_SOURCE) as Array<{ ticket_id: string }>).map((r) => r.ticket_id),
  );

  const tickets = rows.map((row): BacklogTicket => {
    const rel = related.get(row.ticket_id);
    return {
      id: row.ticket_id,
      type: row.type,
      status: blocked.has(row.ticket_id) && row.status === "active" ? "blocked" : row.status,
      title: row.title,
      body: row.body,
      ...(rel && rel.length > 0 ? { related: rel } : {}),
      ...(row.created ? { created: row.created } : {}),
      ...(row.closed ? { closed: row.closed } : {}),
      ...(row.closed_commit ? { closedCommit: row.closed_commit } : {}),
      ...(row.epic ? { epic: row.epic } : {}),
    };
  });
  tickets.sort((a, b) => compareTicketIds(a.id, b.id));

  return { projectKey, storageMode: mode?.mode === "db" ? "db" : "markdown", tickets };
}

/** Mirrors compareTicketIds in src/backlog/structured.ts:628 — FG-100 sorts
 *  before FG-99, which a lexical ORDER BY would invert. */
function compareTicketIds(a: string, b: string): number {
  const ma = a.match(/^([A-Za-z]+)-(\d+)$/);
  const mb = b.match(/^([A-Za-z]+)-(\d+)$/);
  if (ma && mb) {
    if (ma[1] !== mb[1]) return ma[1]!.localeCompare(mb[1]!);
    return parseInt(ma[2]!, 10) - parseInt(mb[2]!, 10);
  }
  return a.localeCompare(b);
}

type ProjectPresentation = { label: string; color: string; branch?: string };

const PROJECT_PRESENTATION_CACHE_MS = 5_000;
const projectPresentationCache = new Map<string, { at: number; value: ProjectPresentation | null }>();

// FG-663: normalize a run's STORED project identity — a `pk-` declared project
// key (from .forge/config.yml, FG-608) or a `repo-` resolved evidence key, both
// captured at creation in src/store/runs.ts — to the `repo-` evidence key the
// dashboard registry and project colors are keyed on. A `pk-` is mapped through
// the project_identity registry (the same project_key ↔ repo_evidence_key
// arbiter backlogTruthForProject/queueBoard read); a `repo-` is already in that
// space and is used directly. Falls back to the input unchanged when a `pk-` has
// no registry row yet — a stable if ungrouped key beats a throw. READ-ONLY: the
// registry is never written from this read path.
// FG-663: the dashboard reads ~/.forge/forge.db, whose additive `project_identity`
// column (src/store/schema.ts) may be ABSENT on an aged DB a peer has not migrated
// yet, or during a deploy window where this reader is ahead of the migration.
// SELECTing a column that does not exist is a hard SQLITE_ERROR, so the three
// presentation reads probe for it and, when absent, omit it and fall back to the
// legacy live-resolution path (projectPresentation with a NULL identity). This is
// the FG-568 additive-only, reader-tolerates-old-schema contract on the read side.
// Deliberately un-memoized: PRAGMA table_info on a tiny table is cheap next to the
// polled query it guards, and a cached `false` would go stale the instant a peer
// applies the migration under this long-lived read handle.
function runsProjectIdentitySelect(): string {
  return hasRunsProjectIdentity() ? ", r.project_identity" : "";
}

// FG-560: does the OPEN store carry the additive task provenance columns
// (resolved_mapping_path / resolved_capability_source, added in step 3)? Same
// posture as hasRunsProjectIdentity: this read-only handle may point at an aged
// store a peer forge has not migrated yet, so naming the columns unconditionally
// would fail every task query on it. Un-memoized — PRAGMA reads the schema already
// held for this connection, and a cached `false` would go stale the instant a peer
// applies the migration. A store predating the `tasks` table fails closed to false.
function hasTasksModelProvenance(): boolean {
  try {
    return (db().prepare(`PRAGMA table_info(tasks)`).all() as Array<{ name: string }>).some(
      (col) => col.name === "resolved_mapping_path",
    );
  } catch {
    return false;
  }
}

/** The SELECT fragment for the task provenance axes, or "" on an unmigrated store —
 *  so a legacy/aged store keeps rendering badges exactly as before (null provenance)
 *  rather than throwing at prepare time. */
function tasksModelProvenanceSelect(): string {
  return hasTasksModelProvenance() ? ", t.resolved_mapping_path, t.resolved_capability_source" : "";
}

function normalizeStoredIdentityToEvidenceKey(storedIdentity: string): string {
  if (!storedIdentity.startsWith("pk-")) return storedIdentity;
  const row = db()
    .prepare(`SELECT repo_evidence_key FROM project_identity WHERE project_key = ?`)
    .get(storedIdentity) as { repo_evidence_key: string } | undefined;
  return row?.repo_evidence_key ?? storedIdentity;
}

// FG-663: presentation for a run whose durable project identity was captured at
// creation. Label and color are resolved from that stored identity, NOT
// re-derived from project_dir (which may be gone), so a deleted checkout still
// shows its correct project and never renders "Unknown repository" (AC2/AC3).
// pk-/repo- rows of one project normalize to a single evidence key, so they
// group to one label and one color — stable with the live project because the
// live ProjectRecord's color is itself hashColor(evidence key). Branch is
// incidental checkout detail, read live only while the directory still exists.
function presentationFromIdentity(
  projectDir: string | null,
  storedIdentity: string,
): ProjectPresentation | null {
  const evidenceKey = normalizeStoredIdentityToEvidenceKey(storedIdentity);
  const live = projectDir ? repositoryCheckoutIdentity(projectDir) : null;
  const branch = live?.exists ? live.branch : undefined;
  // Prefer the live project record: its label+color ARE the grouped
  // presentation, so a deleted checkout renders identically to its still-present
  // siblings and no color churn is introduced.
  const record = projectsForDashboard().find((project) => project.key === evidenceKey);
  const base = record
    ? { label: record.label, color: record.color }
    : // FG-663 (RF-1): every checkout of this project is gone from disk, so there is
      // no live record. Identity is READ from the stored column and never
      // re-derived from a project_dir that may be gone: the label IS the stored
      // identity (normalized to its evidence key) and the color is keyed on that
      // same key. projectDir stays incidental (branch only, above) — a vanished
      // checkout can never yield a path-basename tag or "Unknown repository".
      { label: evidenceKey, color: projectColorForKey(evidenceKey) };
  return branch ? { ...base, branch } : base;
}

function projectPresentation(
  projectDir: string | null,
  storedIdentity?: string | null,
): ProjectPresentation | null {
  // FG-663: a run that captured its project identity at creation is presented
  // from that durable record, never re-derived from a project_dir that may be
  // gone. Legacy rows (NULL project_identity) keep the live filesystem path
  // below. Identity-keyed cache entries are namespaced so they never collide
  // with the absolute-path keys the legacy path uses.
  if (storedIdentity) {
    const now = Date.now();
    const cacheKey = `id:${storedIdentity}\0${projectDir ?? ""}`;
    const cached = projectPresentationCache.get(cacheKey);
    if (cached && now - cached.at < PROJECT_PRESENTATION_CACHE_MS) return cached.value;
    const value = presentationFromIdentity(projectDir, storedIdentity);
    projectPresentationCache.set(cacheKey, { at: now, value });
    return value;
  }
  if (!projectDir) return null;
  const now = Date.now();
  const cached = projectPresentationCache.get(projectDir);
  if (cached && now - cached.at < PROJECT_PRESENTATION_CACHE_MS) return cached.value;
  const identity = repositoryCheckoutIdentity(projectDir);
  if (!identity.exists) {
    const canonical = projectsForDashboard().find((project) => project.projectDirs.includes(projectDir));
    if (canonical) {
      const value = { label: canonical.label, color: canonical.color };
      projectPresentationCache.set(projectDir, { at: now, value });
      return value;
    }
  }
  const fallbackLabel = !identity.exists
    ? "Unknown repository"
    : identity.remoteName
    ? identity.remoteName.charAt(0).toUpperCase() + identity.remoteName.slice(1)
    : undefined;
  const meta = resolveProjectMeta(projectDir, { fallbackLabel, colorKey: identity.key });
  const value = meta ? {
    label: meta.label,
    color: meta.color,
    ...(identity.branch ? { branch: identity.branch } : {}),
  } : null;
  projectPresentationCache.set(projectDir, { at: now, value });
  return value;
}

// #285: read-only routing/governance read model for the dashboard panel. Backed
// by the SAME governanceView() core as `forge route governance --json`, so the
// dashboard can't drift from the CLI's view of routing. Augments it with the tail
// of the host RACI audit log so policy changes are visible without reading the
// file. Read-only: there is no write counterpart.
function auditLogPath(): string {
  return join(forgeHome(), "raci-audit.log");
}

export type RaciAuditEntry = {
  timestamp: string;
  action: string;
  current_raci: string;
  candidate: string;
  routes_added: string[];
  routes_removed: string[];
  routes_modified: string[];
  validation: { raci: boolean; route: boolean };
};

// FG-359: four-section WorkbenchPanel replaces the flat GovernancePanel.
// source=RACI file in force; derived=compiled policy health; effective=routes+diff;
// recorded=audit log. Backed by the same governanceView() core.

export type WorkbenchHealth =
  | "ok"
  | "uncompiled-override"
  | "stale-drift"
  | "compile-error"
  | "policy-not-found";

export type WorkbenchPanel = {
  source: { kind: "project" | "host"; raciPath: string };
  derived: {
    policyPath: string;
    health: WorkbenchHealth;
    findings?: Extract<GovernanceView, { ok: false }>["findings"];
    accountable?: string;
  };
  effective: {
    routes: Extract<GovernanceView, { ok: true }>["routes"];
    diff?: Extract<GovernanceView, { ok: true }>["diff"];
  } | null;
  recorded: { entries: RaciAuditEntry[] };
};

/** Tail of the host-global RACI audit log (newest first). Tolerates a missing
 *  file (no changes yet) and skips any unparseable line. */
function recentRaciAudit(limit: number): RaciAuditEntry[] {
  const path = auditLogPath();
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim() !== "");
  const out: RaciAuditEntry[] = [];
  for (const line of lines.slice(-limit)) {
    try {
      out.push(JSON.parse(line) as RaciAuditEntry);
    } catch {
      /* skip a corrupt line rather than fail the whole panel */
    }
  }
  return out.reverse();
}

export function routingGovernance(projectDir?: string): WorkbenchPanel {
  const view = governanceView({ projectDir });

  const raciPath =
    view.source === "project" && projectDir !== undefined
      ? join(projectDir, ".forge", "forge-raci.md")
      : join(forgeHome(), "forge-raci.md");

  let health: WorkbenchHealth;
  let findings: WorkbenchPanel["derived"]["findings"];
  let accountable: string | undefined;

  if (!view.ok) {
    findings = view.findings;
    const codes = view.findings.map((f) => f.code);
    if (codes.includes("override_not_compiled")) health = "uncompiled-override";
    else if (codes.includes("raci_compile_error")) health = "compile-error";
    else health = "policy-not-found";
  } else {
    accountable = view.accountable;
    if (view.drift && view.drift.length > 0) {
      findings = view.drift as WorkbenchPanel["derived"]["findings"];
      health = view.drift.some((f) => f.code === "raci_compile_error") ? "compile-error" : "stale-drift";
    } else {
      health = "ok";
    }
  }

  const effective = view.ok
    ? { routes: view.routes, ...(view.diff ? { diff: view.diff } : {}) }
    : null;

  return {
    source: { kind: view.source, raciPath },
    derived: {
      policyPath: view.path,
      health,
      ...(findings ? { findings } : {}),
      ...(accountable !== undefined ? { accountable } : {}),
    },
    effective,
    recorded: { entries: recentRaciAudit(8) },
  };
}

// ── FG-487: host-side verification visibility ──────────────────────────────
//
// Host verification (review-loop's CI-wait/local verification phases, campaign
// reconcile's real-exec gates) runs OUTSIDE the task/container lifecycle the
// rest of this file reads — minutes of host-side activity with no task row
// while it's in flight. The producing side (src/store/events.ts and its two
// emitters) writes durable start/finish event pairs keyed by a per-invocation
// `attemptId` (a crash-restarted round or CI-wait retry can legitimately
// produce two starts at the same round/ticket/sha identity — pairing MUST be
// by attemptId, never "latest unmatched start by key"). Everything below is
// derived at query time from `events` + `host_verifications` — no new
// lifecycle/state table (FG-477 constraint discipline).
//
// Event contract (documented fully in docs/SCHEMA-CONTRACT.md):
//   review_loop.verification_started  { attemptId, round, ticketId, sha, mode? }
//   review_loop.verification_finished { attemptId, ...outcome }
//   campaign_item.host_gate_started   { attemptId, campaignId?, itemId, ticketId, command|gate, testedSha, runId }
//   campaign_item.host_gate_finished  { attemptId, exitCode, ...outcome }
// Payload field READS below are deliberately tolerant (e.g. command ?? gate)
// since the producing side is a separate build step against the same contract
// doc — a single canonical key is documented, but a reasonable alias is not
// treated as a hard failure.

// Query-time staleness heuristic (NOT a watchdog/sweep) so a crashed forge
// process doesn't show as perpetually "in progress". Kept in sync BY HAND with
// the producing side's own timeouts — these are upper bounds, not the
// authoritative timeout values (which are env-overridable there).
// Mirrors src/cli/commands/review-loop.ts's DEFAULT_CI_WAIT_TIMEOUT_SECONDS.
const REVIEW_LOOP_VERIFICATION_STALE_MS = 20 * 60 * 1000;
// Mirrors src/campaign/reconcile-collect.ts's HOST_GATE_TIMEOUT_MS_DEFAULT.
const CAMPAIGN_HOST_GATE_STALE_MS = 10 * 60 * 1000;
// FG-487 incident fix: a past-cutoff unmatched start used to be dropped
// entirely, so a crashed/hung verification vanished instead of being flagged
// — the exact gap this ticket was filed over. Past-cutoff starts are now
// INCLUDED with stale: true, bounded by this lookback so ancient rows (a
// process that crashed days ago) don't accumulate forever.
const STALE_LOOKBACK_MS = 24 * 60 * 60 * 1000;

type VerificationEventRow = {
  run_id: string | null;
  task_id: string | null;
  event_type: string;
  payload: string | null;
  created_at: string;
};

// sinceMs bounds the scan to events created at/after that instant, pushed
// down into SQL so it can use idx_events_type_created (event_type, created_at)
// instead of a full-table scan — this is called 4x per dashboard poll tick
// (2x here, 2x from reviewLoopRunPhases below) by every open tab.
function readEventsByType(types: readonly string[], sinceMs?: number): VerificationEventRow[] {
  const placeholders = types.map(() => "?").join(",");
  const sinceClause = sinceMs !== undefined ? `AND created_at >= ?` : ``;
  const params: unknown[] = [...types];
  if (sinceMs !== undefined) params.push(new Date(sinceMs).toISOString());
  return db()
    .prepare(
      `SELECT run_id, task_id, event_type, payload, created_at
       FROM events WHERE event_type IN (${placeholders}) ${sinceClause}
       ORDER BY created_at ASC, id ASC`
    )
    .all(...params) as VerificationEventRow[];
}

/** FG-693: `campaigns` carries the canonical column and `createCampaign` fills it,
 *  so only pre-fix rows are NULL-canonical and they reach the legacy arm. Selected
 *  conditionally because this read-only handle may be pointed at a store that has
 *  not been migrated to the column yet. */
function campaignCanonicalSelect(qualifier: string): string {
  return hasCanonicalColumn("campaigns") ? `, ${qualifier}.${CANONICAL_COLUMN}` : "";
}

type CampaignProjectRow = { project_dir: string | null; project_dir_canonical?: string | null };

function campaignRowIdentity(row: CampaignProjectRow): RowProjectIdentity {
  return { projectDir: row.project_dir ?? null, canonical: row.project_dir_canonical ?? null };
}

type RunScopeInfo = { identity: RowProjectIdentity; status: string | null };

/** The column shape of THIS store, resolved once per query rather than once per row.
 *  Both lookups below run inside a loop, and asking the store its shape per row is
 *  the same class of waste as re-resolving the scope per row. */
type CanonicalShape = { runs: boolean; campaigns: boolean; runsIdentity: boolean };

function canonicalShape(): CanonicalShape {
  return {
    runs: hasCanonicalColumn("runs"),
    campaigns: hasCanonicalColumn("campaigns"),
    // FG-663: whether `runs` carries project_identity, resolved once per query so
    // runScopeInfo's per-row reads select it only when the store actually has it.
    runsIdentity: hasRunsProjectIdentity(),
  };
}

// FG-693: the run's canonical identity is read alongside its as-written spelling,
// so a scope decision here is the SAME decision `scopeSql` makes in SQL. Selected
// conditionally for the unmigrated-store reason above.
function runScopeInfo(runId: string | null, shape: CanonicalShape): RunScopeInfo | null {
  if (!runId) return null;
  const canonical = shape.runs ? `, ${CANONICAL_COLUMN}` : "";
  // FG-663: the run's durable project_identity travels with its path/canonical so
  // scopeIncludes makes the SAME decision here that scopeSql makes in SQL — a
  // review-loop verification on a run whose checkout is gone stays in project scope.
  const identity = shape.runsIdentity ? `, project_identity` : "";
  const row = db().prepare(`SELECT project_dir, status${canonical}${identity} FROM runs WHERE id = ?`).get(runId) as
    | { project_dir: string | null; status: string | null; project_dir_canonical?: string | null; project_identity?: string | null }
    | undefined;
  if (!row) return null;
  return {
    identity: {
      projectDir: row.project_dir ?? null,
      canonical: row.project_dir_canonical ?? null,
      identity: row.project_identity ?? null,
    },
    status: row.status ?? null,
  };
}

function campaignProjectIdentity(campaignId: string | null, shape: CanonicalShape): RowProjectIdentity {
  if (!campaignId) return { projectDir: null, canonical: null };
  const canonical = shape.campaigns ? `, ${CANONICAL_COLUMN}` : "";
  const row = db()
    .prepare(`SELECT project_dir${canonical} FROM campaigns WHERE id = ?`)
    .get(campaignId) as CampaignProjectRow | undefined;
  return row ? campaignRowIdentity(row) : { projectDir: null, canonical: null };
}

function parseEventPayload(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const p: unknown = JSON.parse(raw);
    return p !== null && typeof p === "object" ? (p as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function readAttemptId(payload: Record<string, unknown>): string | null {
  return typeof payload.attemptId === "string" ? payload.attemptId : null;
}

const VERIFICATION_START_TYPES = ["review_loop.verification_started", "campaign_item.host_gate_started"] as const;
const VERIFICATION_FINISH_TYPES = ["review_loop.verification_finished", "campaign_item.host_gate_finished"] as const;

export type InProgressVerification =
  | {
      kind: "review_loop_verification";
      attemptId: string;
      runId: string | null;
      ticketId: string | null;
      sha: string | null;
      mode: string | null;
      round: number | null;
      startedAt: string;
      stale: boolean;
    }
  | {
      kind: "campaign_reconcile_gate";
      attemptId: string;
      runId: string | null;
      campaignId: string | null;
      itemId: string | null;
      ticketId: string | null;
      command: string | null;
      testedSha: string | null;
      startedAt: string;
      stale: boolean;
    };

/** Every start event whose attemptId has no matching finish yet, minus any
 *  past its type's staleness cutoff. Pairing is by attemptId — never "latest
 *  unmatched start by key" — so a same-identity double-start (e.g. two starts
 *  at the same round/ticketId/sha with different attemptIds, only one
 *  finished) reports exactly the one attempt that's actually still open, not
 *  zero or two. */
export function inProgressVerifications(nowMs: number = Date.now(), scope?: ProjectScope): InProgressVerification[] {
  // A finish event for an attempt whose start survives the lookback cutoff is
  // itself always created at/after that start (finish can't precede its own
  // start), so bounding both reads by the same cutoff is safe — it can't drop
  // a finish that would otherwise unmatch a still-relevant start.
  const sinceMs = nowMs - STALE_LOOKBACK_MS;
  // FG-693: the operator's scope is resolved ONCE for the whole read. The loop below
  // asks about it per row, and resolving it there re-walked every scope spelling
  // through the filesystem once per event.
  const targets = resolveScope(scope);
  const shape = canonicalShape();
  const finishedAttemptIds = new Set<string>();
  for (const row of readEventsByType(VERIFICATION_FINISH_TYPES, sinceMs)) {
    const attemptId = readAttemptId(parseEventPayload(row.payload));
    if (attemptId) finishedAttemptIds.add(attemptId);
  }

  const out: InProgressVerification[] = [];
  for (const row of readEventsByType(VERIFICATION_START_TYPES, sinceMs)) {
    const payload = parseEventPayload(row.payload);
    const attemptId = readAttemptId(payload);
    if (!attemptId || finishedAttemptIds.has(attemptId)) continue;

    const ageMs = nowMs - new Date(row.created_at).getTime();
    if (ageMs > STALE_LOOKBACK_MS) continue;
    if (row.event_type === "review_loop.verification_started") {
      // FG-594: an unmatched start only counts as in-progress while its owning
      // run is still active. A terminal run (complete/failed/abandoned) or a
      // missing run means the verification is over — a finish event may have
      // been lost, but the run outcome is authoritative. Fail closed: no run
      // row, or any non-active status, drops the start.
      const runInfo = runScopeInfo(row.run_id, shape);
      if (!runInfo || runInfo.status !== "active") continue;
      // Repository scopes include every observed member checkout; exact-path
      // scopes retain the previous operational filtering semantics. The
      // loop's eager run row carries project_dir; campaign gates resolve via
      // their campaign row (item.runId is frequently null).
      // FG-693: the run row is decided by the same identity rule the run-scoped
      // SQL applies, so an aliased scope spelling keeps this verification visible.
      if (!scopeIncludes(targets, runInfo.identity)) continue;
      out.push({
        kind: "review_loop_verification",
        attemptId,
        runId: row.run_id,
        ticketId: typeof payload.ticketId === "string" ? payload.ticketId : null,
        sha: typeof payload.sha === "string" ? payload.sha : null,
        mode: typeof payload.mode === "string" ? payload.mode : null,
        round: typeof payload.round === "number" ? payload.round : null,
        startedAt: row.created_at,
        stale: ageMs > REVIEW_LOOP_VERIFICATION_STALE_MS,
      });
    } else {
      const campaignId = typeof payload.campaignId === "string" ? payload.campaignId : null;
      if (!scopeIncludes(targets, campaignProjectIdentity(campaignId, shape))) continue;
      out.push({
        kind: "campaign_reconcile_gate",
        attemptId,
        runId: row.run_id,
        campaignId,
        itemId: typeof payload.itemId === "string" ? payload.itemId : null,
        ticketId: typeof payload.ticketId === "string" ? payload.ticketId : null,
        command:
          typeof payload.command === "string" ? payload.command : typeof payload.gate === "string" ? payload.gate : null,
        testedSha: typeof payload.testedSha === "string" ? payload.testedSha : null,
        startedAt: row.created_at,
        stale: ageMs > CAMPAIGN_HOST_GATE_STALE_MS,
      });
    }
  }
  return out;
}

export type ReviewLoopPhase = "verifying" | "waiting-on-ci" | "reviewing" | "fixing";

export type ReviewLoopRunPhaseEntry = {
  runId: string;
  runTitle: string;
  workflow: string;
  projectDir: string | null;
  projectLabel: string | null;
  projectColor: string | null;
  checkoutBranch: string | null;
  checkoutName: string | null;
  phase: ReviewLoopPhase;
  phaseStartedAt: string;
  ticketId: string | null;
  round: number | null;
};

/** Review-loop runs currently mid-phase, including the launch-to-first-round
 *  window BEFORE any reviewer/fixer task row exists — the exact gap FG-487
 *  reports (a watcher can't tell "verifying" from "hung" because inFlight()'s
 *  task JOIN returns nothing for a run that has no task yet). A run counts as
 *  a "review-loop run" purely by having ever emitted a
 *  review_loop.verification_started event — no workflow-name assumption, so
 *  this stays correct even if the run's `workflow` column is a generic
 *  "invoke" sentinel. Phase per run is whichever is more recent: the latest
 *  running reviewer/fixer task, or the latest still-open verification start
 *  (same attemptId pairing as inProgressVerifications). */
export function reviewLoopRunPhases(nowMs: number = Date.now(), scope?: ProjectScope): ReviewLoopRunPhaseEntry[] {
  // Track the LATEST verification_started per run for its ticketId/round/mode
  // context (kept even once finished — a "reviewing"/"fixing" phase driven by
  // a task row still wants to display which ticket/round it belongs to), plus
  // separately whether that latest start is still open (unmatched by a finish
  // event) — that's what actually makes it a candidate phase on its own.
  // Same lookback bound as inProgressVerifications, for the same reason: a
  // review-loop run whose latest verification_started event is this old has
  // either long since finished or hung well past any phase worth displaying.
  const sinceMs = nowMs - STALE_LOOKBACK_MS;
  const finishedAttemptIds = new Set<string>();
  for (const row of readEventsByType(["review_loop.verification_finished"], sinceMs)) {
    const attemptId = readAttemptId(parseEventPayload(row.payload));
    if (attemptId) finishedAttemptIds.add(attemptId);
  }

  type LatestStart = { attemptId: string; ticketId: string | null; round: number | null; mode: string | null; startedAt: string; open: boolean };
  const latestStartByRun = new Map<string, LatestStart>();
  for (const row of readEventsByType(["review_loop.verification_started"], sinceMs)) {
    if (!row.run_id) continue;
    const payload = parseEventPayload(row.payload);
    const attemptId = readAttemptId(payload);
    if (!attemptId) continue;
    // rows are ASC by created_at — later rows overwrite earlier ones, so the
    // map ends up holding the latest start per run.
    latestStartByRun.set(row.run_id, {
      attemptId,
      ticketId: typeof payload.ticketId === "string" ? payload.ticketId : null,
      round: typeof payload.round === "number" ? payload.round : null,
      mode: typeof payload.mode === "string" ? payload.mode : null,
      startedAt: row.created_at,
      open: !finishedAttemptIds.has(attemptId),
    });
  }
  if (latestStartByRun.size === 0) return [];

  const project = scopeSql("runs", "r", scope);
  const runRows = db()
    .prepare(`SELECT id, title, workflow, project_dir FROM runs r WHERE r.status = 'active' ${project.clause}`)
    .all(...project.params) as Array<{ id: string; title: string; workflow: string; project_dir: string | null }>;
  const candidateRuns = runRows.filter((r) => latestStartByRun.has(r.id));
  if (candidateRuns.length === 0) return [];

  const runIdsPlaceholder = candidateRuns.map(() => "?").join(",");
  const taskRows = db()
    .prepare(
      `SELECT run_id, agent_role, started_at, created_at
       FROM tasks WHERE run_id IN (${runIdsPlaceholder}) AND status = 'running'
       ORDER BY COALESCE(started_at, created_at) DESC`
    )
    .all(...candidateRuns.map((r) => r.id)) as Array<{
    run_id: string;
    agent_role: string;
    started_at: string | null;
    created_at: string;
  }>;
  const latestTaskByRun = new Map<string, (typeof taskRows)[number]>();
  for (const t of taskRows) {
    if (!latestTaskByRun.has(t.run_id)) latestTaskByRun.set(t.run_id, t); // rows are DESC — first hit per run is the latest
  }

  const out: ReviewLoopRunPhaseEntry[] = [];
  for (const run of candidateRuns) {
    const task = latestTaskByRun.get(run.id);
    const start = latestStartByRun.get(run.id)!;
    const taskStartedAt = task ? task.started_at ?? task.created_at : null;

    let phase: ReviewLoopPhase | null = null;
    let phaseStartedAt: string | null = null;
    if (task && taskStartedAt && (!start.open || taskStartedAt > start.startedAt)) {
      phase = task.agent_role === "engineer" ? "fixing" : "reviewing";
      phaseStartedAt = taskStartedAt;
    } else if (start.open) {
      phase = start.mode === "ci-wait" || start.mode === "ci_wait" ? "waiting-on-ci" : "verifying";
      phaseStartedAt = start.startedAt;
    }
    if (!phase || !phaseStartedAt) continue;

    const meta = projectPresentation(run.project_dir);
    out.push({
      runId: run.id,
      runTitle: run.title,
      workflow: run.workflow,
      projectDir: run.project_dir,
      projectLabel: meta?.label ?? null,
      projectColor: meta?.color ?? null,
      checkoutBranch: meta?.branch ?? null,
      checkoutName: run.project_dir ? basename(run.project_dir) : null,
      phase,
      phaseStartedAt,
      ticketId: start.ticketId,
      round: start.round,
    });
  }
  return out;
}

// ── host_verifications evidence (dashboard read path) ───────────────────────
//
// The trust evidence FG-440/FG-483/FG-474 ship decisions rest on, rendered
// here rather than requiring sqlite access. Read via direct SQL against the
// dashboard's own read-only handle (this file's established convention —
// see the module header) rather than importing src/store/host-verifications.ts:
// that module's exported lookups (queryHostVerificationRows /
// queryHostVerificationRowsForGate) are single-gate/single-sha lookups built
// for the reuse-check call sites, not "everything recorded for this ticket",
// which is what an evidence VIEW needs.

export type HostVerificationEvidenceRow = {
  id: number;
  ticketId: string;
  projectDir: string;
  commitSha: string;
  gateName: string;
  command: string;
  exitCode: number;
  runId: string | null;
  recordedAt: string;
  source: "host" | "ci";
  ciUrl: string | null;
};

type HostVerificationDbRow = {
  id: number;
  ticket_id: string;
  project_dir: string;
  commit_sha: string;
  gate_name: string;
  command: string;
  exit_code: number;
  run_id: string | null;
  recorded_at: string;
  source: string;
  ci_url: string | null;
};

function rowToHostVerification(row: HostVerificationDbRow): HostVerificationEvidenceRow {
  return {
    id: row.id,
    ticketId: row.ticket_id,
    projectDir: row.project_dir,
    commitSha: row.commit_sha,
    gateName: row.gate_name,
    command: row.command,
    exitCode: row.exit_code,
    runId: row.run_id,
    recordedAt: row.recorded_at,
    source: row.source === "ci" ? "ci" : "host",
    ciUrl: row.ci_url,
  };
}

/** All host_verifications rows recorded for a ticket (optionally narrowed to
 *  one project_dir), most-recent-first. Unscoped by gate/sha — an evidence
 *  view shows everything recorded, not one gate lookup at a time. */
export function hostVerificationsForTicket(ticketId: string, scope?: ProjectScope, limit = 100): HostVerificationEvidenceRow[] {
  const project = scopeSql("host_verifications", "host_verifications", scope);
  const params: unknown[] = [ticketId];
  params.push(...project.params);
  params.push(limit);
  const rows = db()
    .prepare(`SELECT * FROM host_verifications WHERE ticket_id = ? ${project.clause} ORDER BY recorded_at DESC LIMIT ?`)
    .all(...params) as HostVerificationDbRow[];
  return rows.map(rowToHostVerification);
}

/** Same evidence, scoped by campaign item. host_verifications has no item_id
 *  column (FG-477: no new lifecycle/evidence table) — this resolves the
 *  item's ticketId and its campaign's project_dir via campaign_items →
 *  campaigns, then delegates to the ticket-scoped lookup. Returns [] for an
 *  unknown item id rather than throwing. */
export function hostVerificationsForCampaignItem(itemId: string, scope?: ProjectScope): HostVerificationEvidenceRow[] {
  const item = db()
    .prepare(
      `SELECT ci.ticket_id AS ticket_id, c.project_dir AS project_dir${campaignCanonicalSelect("c")}
       FROM campaign_items ci JOIN campaigns c ON c.id = ci.campaign_id
       WHERE ci.id = ?`
    )
    .get(itemId) as { ticket_id: string; project_dir: string | null; project_dir_canonical?: string | null } | undefined;
  if (!item) return [];
  // FG-693: the campaign's own project identity decides whether this item is in
  // scope, and the campaign's recorded spelling is then handed on as the scope for
  // the evidence lookup — where it is resolved again, so an aliased campaign
  // spelling still finds evidence recorded under the canonical one.
  if (!scopeIncludes(resolveScope(scope), campaignRowIdentity(item))) return [];
  return hostVerificationsForTicket(item.ticket_id, item.project_dir ?? undefined);
}

/** Unscoped, most-recent-first — the AC5 breadcrumb: a completed
 *  orchestrator-run bare gate (e.g. `npm run test:all` invoked directly, no
 *  review-loop/reconcile wrapper) has no in-flight window to catch, but its
 *  recorded row is still discoverable here after the fact. */
export function recentHostVerifications(limit = 50, scope?: ProjectScope): HostVerificationEvidenceRow[] {
  const project = scopeSql("host_verifications", "host_verifications", scope);
  const rows = db().prepare(`SELECT * FROM host_verifications WHERE 1 = 1 ${project.clause} ORDER BY recorded_at DESC LIMIT ?`)
    .all(...project.params, limit) as HostVerificationDbRow[];
  return rows.map(rowToHostVerification);
}

// ─── FG-638: the review ledger (read-only) ──────────────────────────────────
//
// The dashboard presents the review ledger as the managed object: a summary per
// review plus its findings rows. This is the first release, so it is READ-ONLY —
// disposition controls stay on the CLI until that surface is proven.
//
// Note the shape: findings are embedded in their review rather than fetched by a
// second round trip. A review's findings are the review, and a panel that renders
// a summary whose counts disagree with the rows below it is the exact failure this
// avoids — both come from one query pair, at one instant.

export type ReviewLedgerSource = {
  verdictId?: string;
  redTaskId?: string;
  redRole?: string;
  authority?: string;
  modelFindingId?: string;
  note?: string;
};

export type ReviewLedgerFinding = {
  id: string;
  findingRef: string;
  summary: string;
  severity: string | null;
  riskLens: string | null;
  reachability: string | null;
  file: string | null;
  line: number | null;
  quotedText: string | null;
  acceptanceRef: string | null;
  invariantRef: string | null;
  sources: ReviewLedgerSource[];
  disposition: string;
  dispositionRationale: string | null;
  decidedBy: string | null;
  duplicateOf: string | null;
  followupTicketId: string | null;
  resolution: string | null;
  resolutionEvidenceKind: string | null;
  resolutionEvidence: string | null;
};

export type ReviewLedgerEntry = {
  id: string;
  runId: string | null;
  subjectTaskId: string | null;
  ticketId: string | null;
  projectDir: string | null;
  baseSha: string | null;
  contractConfirmedSha: string | null;
  candidateSha: string | null;
  trustedRemoteSha: string | null;
  reviewMode: string;
  state: string;
  riskLenses: string[];
  createdAt: string;
  updatedAt: string;
  settledAt: string | null;
  countsByDisposition: Record<string, number>;
  countsByResolution: Record<string, number>;
  findings: ReviewLedgerFinding[];
};

type ReviewDbRow = {
  id: string;
  run_id: string | null;
  subject_task_id: string | null;
  ticket_id: string | null;
  project_dir: string | null;
  base_sha: string | null;
  contract_confirmed_sha: string | null;
  candidate_sha: string | null;
  trusted_remote_sha: string | null;
  contract_json: string | null;
  review_mode: string;
  state: string;
  created_at: string;
  updated_at: string;
  settled_at: string | null;
};

type ReviewFindingDbRow = {
  id: string;
  review_id: string;
  finding_ref: string;
  summary: string;
  severity: string | null;
  risk_lens: string | null;
  reachability: string | null;
  file: string | null;
  line: number | null;
  quoted_text: string | null;
  acceptance_ref: string | null;
  invariant_ref: string | null;
  sources_json: string;
  disposition: string;
  disposition_rationale: string | null;
  decided_by: string | null;
  duplicate_of: string | null;
  followup_ticket_id: string | null;
  resolution: string | null;
  resolution_evidence_kind: string | null;
  resolution_evidence: string | null;
};

function rowToReviewFinding(row: ReviewFindingDbRow): ReviewLedgerFinding {
  return {
    id: row.id,
    findingRef: row.finding_ref,
    summary: row.summary,
    severity: row.severity,
    riskLens: row.risk_lens,
    reachability: row.reachability,
    file: row.file,
    line: row.line,
    quotedText: row.quoted_text,
    acceptanceRef: row.acceptance_ref,
    invariantRef: row.invariant_ref,
    sources: JSON.parse(row.sources_json) as ReviewLedgerSource[],
    disposition: row.disposition,
    dispositionRationale: row.disposition_rationale,
    decidedBy: row.decided_by,
    duplicateOf: row.duplicate_of,
    followupTicketId: row.followup_ticket_id,
    resolution: row.resolution,
    resolutionEvidenceKind: row.resolution_evidence_kind,
    resolutionEvidence: row.resolution_evidence,
  };
}

function riskLensesOf(contractJson: string | null): string[] {
  if (contractJson === null) return [];
  const contract = JSON.parse(contractJson) as { risk_lenses?: unknown };
  return Array.isArray(contract.risk_lenses) ? contract.risk_lenses.map(String) : [];
}

/** Reviews (most recently touched first) with their findings, scoped through the
 *  owning run's project_dir. A review with no run is unscoped and always listed. */
export function reviewLedger(scope?: ProjectScope, limit = 25): ReviewLedgerEntry[] {
  const project = scopeSql("runs", "runs", scope);
  const reviews = db()
    .prepare(
      `SELECT reviews.*, runs.project_dir AS project_dir
         FROM reviews LEFT JOIN runs ON runs.id = reviews.run_id
        WHERE 1 = 1 ${project.clause}
        ORDER BY reviews.updated_at DESC, reviews.id DESC
        LIMIT ?`,
    )
    .all(...project.params, limit) as ReviewDbRow[];
  if (reviews.length === 0) return [];

  const placeholders = reviews.map(() => "?").join(", ");
  const findings = db()
    .prepare(`SELECT * FROM review_findings WHERE review_id IN (${placeholders}) ORDER BY review_id ASC, ordinal ASC`)
    .all(...reviews.map((r) => r.id)) as ReviewFindingDbRow[];

  return reviews.map((r) => {
    const own = findings.filter((f) => f.review_id === r.id).map(rowToReviewFinding);
    const countsByDisposition: Record<string, number> = {};
    const countsByResolution: Record<string, number> = {};
    for (const f of own) {
      countsByDisposition[f.disposition] = (countsByDisposition[f.disposition] ?? 0) + 1;
      const resolution = f.resolution ?? "unresolved";
      countsByResolution[resolution] = (countsByResolution[resolution] ?? 0) + 1;
    }
    return {
      id: r.id,
      runId: r.run_id,
      subjectTaskId: r.subject_task_id,
      ticketId: r.ticket_id,
      projectDir: r.project_dir,
      baseSha: r.base_sha,
      contractConfirmedSha: r.contract_confirmed_sha,
      candidateSha: r.candidate_sha,
      trustedRemoteSha: r.trusted_remote_sha,
      reviewMode: r.review_mode,
      state: r.state,
      riskLenses: riskLensesOf(r.contract_json),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      settledAt: r.settled_at,
      countsByDisposition,
      countsByResolution,
      findings: own,
    };
  });
}

// ─── FG-386: Shipping-audit projection (READ-ONLY) ──────────────────────────
//
// A projection of already-persisted FG-382/383/384 evidence, keyed by ticket. It
// invents no table, recomputes no assessment/audit, and makes NO outbound git/
// provider/CI call while serving — every value below is read from a row that some
// other subsystem already wrote.
//
// The three evidence sources it joins, all on (project_key, ticket_id):
//   - readiness_assessments (FG-382): the deterministic readiness evaluator's
//     stored outcome + gaps. STALE when its body_hash no longer matches the
//     ticket's stored body_hash — a pure column comparison, the same definition
//     src/store/queue.ts's readinessView uses, never a recompute.
//   - reviews + review_findings (FG-384/FG-640): the shipping-reviewer ledger —
//     the model-authored reviewer findings and the review's lifecycle state. Its
//     candidate_sha is the superseded/staleness key.
//   - host_verifications (FG-419/FG-487): the MECHANICAL shipping checks (typecheck/
//     suite/CI gate rows, exit_code 0 = pass) recorded per ticket+commit. These are
//     the persisted "done" mechanical checks; DoneAuditResult itself is computed
//     on-demand from host/git state (src/done-audit) and is deliberately NOT read
//     here — recomputing it would need exactly the outbound calls this projection
//     forbids.
//
// "current head" is not knowable without a git call, so a review is marked stale
// against the best PERSISTED proxy: the newest recorded mechanical-check commit for
// the ticket. When that commit differs from the review's candidate_sha, newer
// evidence exists at a different candidate and the review is superseded — surfaced
// stale, never as a live pass. Mechanical checks (readiness gaps + host_verifications)
// and model-authored reviewer findings are kept in distinct fields so the panel can
// render them visually distinct while sharing one row.

export type AuditCellStatus = "not_observed" | "running" | "passed" | "failed" | "needs_human" | "stale";

const AUDIT_STATUS_PRIORITY: Record<AuditCellStatus, number> = {
  needs_human: 5,
  failed: 4,
  stale: 3,
  running: 2,
  passed: 1,
  not_observed: 0,
};

/** The row-level rollup: the most attention-demanding axis wins, so a ticket whose
 *  readiness is green but whose review needs a human never reads as "passed". A row is
 *  GREEN only when the shipping REVIEW — the authoritative done gate (FG-372) — itself
 *  passed: when the review axis is anything but passed, a passed readiness or
 *  mechanical-check axis is demoted to not_observed so an incidental sub-check can never
 *  green a review-absent row. The row then rolls up to the most attention-demanding of
 *  the remaining present axes, else not_observed (absence is NEVER green). */
export function rollupAuditStatus(reviewStatus: AuditCellStatus, otherStatuses: AuditCellStatus[]): AuditCellStatus {
  const contributing =
    reviewStatus === "passed"
      ? [reviewStatus, ...otherStatuses]
      : [reviewStatus, ...otherStatuses.map((s) => (s === "passed" ? "not_observed" : s) as AuditCellStatus)];
  let best: AuditCellStatus = "not_observed";
  for (const s of contributing) if (AUDIT_STATUS_PRIORITY[s] > AUDIT_STATUS_PRIORITY[best]) best = s;
  return best;
}

/** Readiness axis. Stale (body moved) dominates so superseded evidence is never a
 *  live pass. `ready`/`exploratory` pass; `blocked` needs a human; `needs_refinement`
 *  and any unknown outcome surface as failed — a gap to close, never green. */
export function readinessCellStatus(outcome: string, stale: boolean): AuditCellStatus {
  if (stale) return "stale";
  if (outcome === "ready" || outcome === "exploratory") return "passed";
  if (outcome === "blocked") return "needs_human";
  return "failed";
}

/** Review axis. Superseded evidence is stale first of all; then an open architecture
 *  question or an environment-blocked review needs a human; a settled review passed;
 *  a failed review failed; anything still in flight is running. */
export function reviewCellStatus(state: string, stale: boolean, openArchitectureQuestions: number): AuditCellStatus {
  if (stale) return "stale";
  if (openArchitectureQuestions > 0) return "needs_human";
  if (state === "settled") return "passed";
  if (state === "failed") return "failed";
  if (state === "blocked_environment") return "needs_human";
  return "running";
}

export type ShippingCheck = {
  gateName: string;
  status: "passed" | "failed";
  source: "ci" | "host";
  commitSha: string;
  command: string;
  exitCode: number;
  recordedAt: string;
  ciUrl: string | null;
};

/** Mechanical shipping-check axis. A single FAILED persisted check dominates — a
 *  done-audit blocker is never green — all-pass reads passed, and no recorded checks
 *  is not_observed (absence is never green). Folded into the row rollup so a failed
 *  mechanical check can never leave a review-passed ticket showing green. */
export function shippingCheckStatus(checks: ShippingCheck[]): AuditCellStatus {
  if (checks.length === 0) return "not_observed";
  if (checks.some((c) => c.status === "failed")) return "failed";
  return "passed";
}

export type ShippingAuditReadiness = {
  outcome: string;
  status: AuditCellStatus;
  gaps: string[];
  refinementProposal: string | null;
  revision: number | null;
  evaluatedAt: string;
  stale: boolean;
};

export type ShippingAuditModelFinding = {
  findingRef: string;
  summary: string;
  severity: string | null;
  riskLens: string | null;
  reachability: string | null;
  disposition: string;
  resolution: string | null;
  file: string | null;
  line: number | null;
};

export type AcceptedDeferral = {
  findingRef: string;
  summary: string;
  followupTicketId: string | null;
  decidedBy: string | null;
};

export type ShippingAuditReview = {
  id: string;
  runId: string | null;
  subjectTaskId: string | null;
  state: string;
  status: AuditCellStatus;
  candidateSha: string | null;
  stale: boolean;
  riskLenses: string[];
  openArchitectureQuestions: number;
  unresolvedFixNow: number;
  modelFindings: ShippingAuditModelFinding[];
  acceptedDeferrals: AcceptedDeferral[];
};

export type ShippingAuditCampaign = {
  itemId: string;
  campaignId: string;
  lifecycleStatus: string;
  outcome: string | null;
  prUrl: string | null;
};

export type ShippingAuditRow = {
  ticketId: string;
  title: string | null;
  status: AuditCellStatus;
  readiness: ShippingAuditReadiness | null;
  review: ShippingAuditReview | null;
  shippingChecks: ShippingCheck[];
  campaign: ShippingAuditCampaign | null;
  runId: string | null;
  taskIds: string[];
  candidateSha: string | null;
  links: { ticketId: string; runId: string | null; subjectTaskId: string | null; commit: string | null };
};

export type ShippingAudit = {
  projectKey: string | null;
  rows: ShippingAuditRow[];
  degraded: string[];
};

/** A model-authored reviewer finding is the whole of review_findings — the ledger is
 *  the reds' findings. Mechanical checks live in host_verifications / readiness gaps,
 *  never here, which is what keeps the two visually separable in one row. */
function toModelFinding(f: ReviewLedgerFinding): ShippingAuditModelFinding {
  return {
    findingRef: f.findingRef,
    summary: f.summary,
    severity: f.severity,
    riskLens: f.riskLens,
    reachability: f.reachability,
    disposition: f.disposition,
    resolution: f.resolution,
    file: f.file,
    line: f.line,
  };
}

/** SQLite caps bound parameters (~999); a project's ticket set can in principle
 *  exceed that, so every IN-list read is chunked. */
function chunked<T>(items: readonly string[], read: (batch: string[]) => T[]): T[] {
  const out: T[] = [];
  for (let i = 0; i < items.length; i += 800) out.push(...read(items.slice(i, i + 800)));
  return out;
}

/** The shipping-audit projection for ONE project, keyed by ticket. Reads persisted
 *  rows only. `project` resolves to a project_key exactly as queueBoard does; a
 *  project with no proven identity (or none selected) yields an empty projection
 *  rather than a cross-project read. */
export function shippingAudit(project: ProjectRecord | null, limit = 200): ShippingAudit {
  const degraded: string[] = [];
  const identity = project
    ? (db()
        .prepare(`SELECT project_key FROM project_identity WHERE repo_evidence_key = ?`)
        .get(project.key) as { project_key: string } | undefined)
    : undefined;
  const projectKey = identity?.project_key ?? null;
  if (!projectKey) return { projectKey: null, rows: [], degraded };

  // Evidence rows (reviews / host_verifications / campaign_items) carry no project_key
  // of their own — they are keyed by ticket_id, which is unique only WITHIN a project.
  // Since ticket_id collides across projects, every evidence select is scoped through
  // its owning run's durable project identity (runs.project_identity, which holds this
  // project's pk- key or its repo- evidence key), and ONLY rows whose run resolves to
  // THIS project surface. A row with no run, or a run whose project was never captured,
  // is unattributable: admitting it would let another project's unscoped, newer evidence
  // win a shared ticket_id and cross into this projection (RF-1/RF-5). The projection
  // never crosses projects, so unattributable evidence is dropped rather than surfaced.
  const scopeKeys = [projectKey, project!.key];

  const ticketRows = tolerantRead(
    () =>
      db()
        .prepare(`SELECT ticket_id, title, body_hash, closed_commit FROM tickets WHERE project_key = ?`)
        .all(projectKey) as Array<{ ticket_id: string; title: string; body_hash: string | null; closed_commit: string | null }>,
    [],
    "tickets",
    degraded,
  );
  const ticketMeta = new Map(ticketRows.map((r) => [r.ticket_id, r]));
  const ticketIds = ticketRows.map((r) => r.ticket_id);
  if (ticketIds.length === 0) return { projectKey, rows: [], degraded };

  const readinessByTicket = new Map<
    string,
    { bodyHash: string; outcome: string; gaps: string[]; refinementProposal: string | null; revision: number | null; evaluatedAt: string }
  >();
  for (const row of tolerantRead(
    () =>
      db()
        .prepare(
          `SELECT ticket_id, body_hash, outcome, gaps_json, refinement_proposal, revision, evaluated_at
             FROM readiness_assessments WHERE project_key = ?`,
        )
        .all(projectKey) as Array<{
        ticket_id: string;
        body_hash: string;
        outcome: string;
        gaps_json: string;
        refinement_proposal: string | null;
        revision: number | null;
        evaluated_at: string;
      }>,
    [],
    "readiness_assessments",
    degraded,
  )) {
    readinessByTicket.set(row.ticket_id, {
      bodyHash: row.body_hash,
      outcome: row.outcome,
      gaps: (safeJsonParse(row.gaps_json) as string[] | undefined) ?? [],
      refinementProposal: row.refinement_proposal,
      revision: row.revision,
      evaluatedAt: row.evaluated_at,
    });
  }

  // Reviews for these tickets, newest first — the newest per ticket is the current
  // one; findings are pulled for that set.
  const reviewRows = tolerantRead(
    () =>
      chunked(ticketIds, (batch) =>
        db()
          .prepare(
            `SELECT reviews.* FROM reviews LEFT JOIN runs ON runs.id = reviews.run_id
              WHERE reviews.ticket_id IN (${batch.map(() => "?").join(", ")})
                AND runs.project_identity IN (?, ?)
              ORDER BY reviews.updated_at DESC, reviews.id DESC`,
          )
          .all(...batch, ...scopeKeys) as ReviewDbRow[],
      ),
    [],
    "reviews",
    degraded,
  );
  const currentReviewByTicket = new Map<string, ReviewDbRow>();
  for (const r of reviewRows) {
    if (r.ticket_id && !currentReviewByTicket.has(r.ticket_id)) currentReviewByTicket.set(r.ticket_id, r);
  }
  const currentReviewIds = [...currentReviewByTicket.values()].map((r) => r.id);
  const findingsByReview = new Map<string, ReviewLedgerFinding[]>();
  if (currentReviewIds.length > 0) {
    for (const f of tolerantRead(
      () =>
        chunked(currentReviewIds, (batch) =>
          db()
            .prepare(`SELECT * FROM review_findings WHERE review_id IN (${batch.map(() => "?").join(", ")}) ORDER BY review_id ASC, ordinal ASC`)
            .all(...batch) as ReviewFindingDbRow[],
        ),
      [],
      "review_findings",
      degraded,
    )) {
      const list = findingsByReview.get(f.review_id) ?? [];
      list.push(rowToReviewFinding(f));
      findingsByReview.set(f.review_id, list);
    }
  }

  // Mechanical shipping checks — most recent recorded first; the newest commit is
  // the persisted "head" proxy for review staleness.
  const checksByTicket = new Map<string, ShippingCheck[]>();
  const latestCheckCommitByTicket = new Map<string, string>();
  for (const row of tolerantRead(
    () =>
      chunked(ticketIds, (batch) =>
        db()
          .prepare(
            `SELECT host_verifications.ticket_id, host_verifications.commit_sha, host_verifications.gate_name,
                    host_verifications.command, host_verifications.exit_code, host_verifications.source,
                    host_verifications.ci_url, host_verifications.recorded_at
               FROM host_verifications LEFT JOIN runs ON runs.id = host_verifications.run_id
              WHERE host_verifications.ticket_id IN (${batch.map(() => "?").join(", ")})
                AND runs.project_identity IN (?, ?)
              ORDER BY host_verifications.recorded_at DESC, host_verifications.id DESC`,
          )
          .all(...batch, ...scopeKeys) as Array<{
          ticket_id: string;
          commit_sha: string;
          gate_name: string;
          command: string;
          exit_code: number;
          source: string;
          ci_url: string | null;
          recorded_at: string;
        }>,
      ),
    [],
    "host_verifications",
    degraded,
  )) {
    const list = checksByTicket.get(row.ticket_id) ?? [];
    list.push({
      gateName: row.gate_name,
      status: row.exit_code === 0 ? "passed" : "failed",
      source: row.source === "ci" ? "ci" : "host",
      commitSha: row.commit_sha,
      command: row.command,
      exitCode: row.exit_code,
      recordedAt: row.recorded_at,
      ciUrl: row.ci_url,
    });
    checksByTicket.set(row.ticket_id, list);
    if (!latestCheckCommitByTicket.has(row.ticket_id)) latestCheckCommitByTicket.set(row.ticket_id, row.commit_sha);
  }

  // Campaign item state (accepted-deferral / done outcome) for these tickets.
  const campaignByTicket = new Map<string, ShippingAuditCampaign>();
  for (const row of tolerantRead(
    () =>
      chunked(ticketIds, (batch) =>
        db()
          .prepare(
            `SELECT ci.id AS id, ci.campaign_id AS campaign_id, ci.ticket_id AS ticket_id,
                    ci.lifecycle_status AS lifecycle_status, ci.outcome AS outcome, ci.pr_url AS pr_url, ci.updated_at AS updated_at
               FROM campaign_items ci LEFT JOIN runs r ON r.id = ci.run_id
              WHERE ci.ticket_id IN (${batch.map(() => "?").join(", ")})
                AND r.project_identity IN (?, ?)
              ORDER BY ci.updated_at DESC`,
          )
          .all(...batch, ...scopeKeys) as Array<{
          id: string;
          campaign_id: string;
          ticket_id: string;
          lifecycle_status: string;
          outcome: string | null;
          pr_url: string | null;
        }>,
      ),
    [],
    "campaign_items",
    degraded,
  )) {
    if (!campaignByTicket.has(row.ticket_id)) {
      campaignByTicket.set(row.ticket_id, {
        itemId: row.id,
        campaignId: row.campaign_id,
        lifecycleStatus: row.lifecycle_status,
        outcome: row.outcome,
        prUrl: row.pr_url,
      });
    }
  }

  // The audit universe is the project's KNOWN tickets (left-joined with evidence), not
  // only the tickets that happen to carry a readiness/review/check/campaign row. A
  // known ticket with no evidence still yields a row: the rollup maps "all axes absent"
  // to not_observed, so absence renders not_observed — never green, and never silently
  // omitted (an omitted ticket is indistinguishable from a clean audit to an operator).
  const rows: ShippingAuditRow[] = [];
  for (const ticketId of ticketIds) {
    const meta = ticketMeta.get(ticketId);
    const rawReadiness = readinessByTicket.get(ticketId) ?? null;
    let readiness: ShippingAuditReadiness | null = null;
    if (rawReadiness) {
      const currentHash = meta?.body_hash ?? null;
      const stale = currentHash === null || currentHash !== rawReadiness.bodyHash;
      readiness = {
        outcome: rawReadiness.outcome,
        status: readinessCellStatus(rawReadiness.outcome, stale),
        gaps: rawReadiness.gaps,
        refinementProposal: rawReadiness.refinementProposal,
        revision: rawReadiness.revision,
        evaluatedAt: rawReadiness.evaluatedAt,
        stale,
      };
    }

    const rawReview = currentReviewByTicket.get(ticketId) ?? null;
    let review: ShippingAuditReview | null = null;
    if (rawReview) {
      const findings = findingsByReview.get(rawReview.id) ?? [];
      const openArchitectureQuestions = findings.filter((f) => f.disposition === "architecture_question").length;
      const unresolvedFixNow = findings.filter((f) => f.disposition === "fix_now" && f.resolution !== "resolved").length;
      // Staleness is a pure column comparison against the ticket's current head, read
      // straight off persisted columns (no repository call). The head proxy is the commit
      // that CLOSED the ticket when it is closed (tickets.closed_commit), else the newest
      // recorded mechanical-check commit. A settled review whose candidate_sha no longer
      // matches that head is superseded — surfaced stale, never a live pass (RF-3). A
      // review with NO candidate_sha cannot be shown to match any head, so any known head
      // makes it stale rather than green (RF-2/RF-6).
      const ticketHead = meta?.closed_commit ?? latestCheckCommitByTicket.get(ticketId) ?? null;
      const stale = ticketHead !== null && ticketHead !== rawReview.candidate_sha;
      review = {
        id: rawReview.id,
        runId: rawReview.run_id,
        subjectTaskId: rawReview.subject_task_id,
        state: rawReview.state,
        status: reviewCellStatus(rawReview.state, stale, openArchitectureQuestions),
        candidateSha: rawReview.candidate_sha,
        stale,
        riskLenses: riskLensesOf(rawReview.contract_json),
        openArchitectureQuestions,
        unresolvedFixNow,
        modelFindings: findings.map(toModelFinding),
        acceptedDeferrals: findings
          .filter((f) => f.disposition === "deferred")
          .map((f) => ({ findingRef: f.findingRef, summary: f.summary, followupTicketId: f.followupTicketId, decidedBy: f.decidedBy })),
      };
    }

    const shippingChecks = checksByTicket.get(ticketId) ?? [];
    const checkStatus = shippingCheckStatus(shippingChecks);
    const campaign = campaignByTicket.get(ticketId) ?? null;
    const candidateSha = review?.candidateSha ?? latestCheckCommitByTicket.get(ticketId) ?? null;
    const taskIds = review?.subjectTaskId ? [review.subjectTaskId] : [];

    rows.push({
      ticketId,
      title: meta?.title ?? null,
      status: rollupAuditStatus(review?.status ?? "not_observed", [readiness?.status ?? "not_observed", checkStatus]),
      readiness,
      review,
      shippingChecks,
      campaign,
      runId: review?.runId ?? null,
      taskIds,
      candidateSha,
      links: {
        ticketId,
        runId: review?.runId ?? null,
        subjectTaskId: review?.subjectTaskId ?? null,
        commit: candidateSha,
      },
    });
  }

  rows.sort((a, b) => {
    const byStatus = AUDIT_STATUS_PRIORITY[b.status] - AUDIT_STATUS_PRIORITY[a.status];
    return byStatus !== 0 ? byStatus : a.ticketId.localeCompare(b.ticketId);
  });
  return { projectKey, rows: rows.slice(0, limit), degraded };
}

// ── FG-679: Current activity — a READ-ONLY projection, and nothing else ──
//
// These entry points exist so the dashboard can answer "is something happening, or
// is this stuck?" from PERSISTED state alone. They are deliberately separate from
// `/api/in-flight`: that endpoint already `execFileSync`s `docker inspect` per
// running task through FG-290's reconcile-candidate annotation (a pre-existing,
// RECORDED exception — BD-13), so folding these in would make BD-7's
// no-outbound-call criterion unassertable. Nothing below shells out, probes tmux,
// calls `readLaunch`/`listLaunches`, or reaches for `projectPresentation` (which
// resolves its label through repositoryCheckoutIdentity → `execFileSync("git", …)`,
// the second recorded exception — BD-18). The new sections carry a weaker,
// basename-derived project label instead of acquiring a second subprocess.

export type { CurrentActivity };

function activityScope(scope: ProjectScope, runId?: string): CurrentActivityScope {
  if (runId !== undefined && runId !== "") return { runId };
  if (scope === undefined) return {};
  return { projectDirs: typeof scope === "string" ? [scope] : [...scope] };
}

/** The ONE shared derivation `forge status` also calls (BD-9). The dashboard adds
 *  no interpretation of its own — agreement is structural, not asserted.
 *
 *  FG-590: each host-launch row is annotated with `retentionDisposition` via the SHARED
 *  retention rule, so the dashboard labels a retained-for-investigation launch distinctly
 *  from an expired/leaked one with the SAME function `forge status` uses (agreement by
 *  construction, not two renderers). A running launch is live work, never a cleanup
 *  candidate → null. The policy is resolved from FORGE_* env over the code defaults (the
 *  dashboard is host-wide; the per-project config override is a `forge status` nicety). */
export function currentActivity(scope?: ProjectScope, runId?: string, nowMs: number = Date.now()): CurrentActivityWithRetention {
  const activity = deriveCurrentActivity(db(), { now: new Date(nowMs), scope: activityScope(scope, runId) });
  const policy = resolveRetention(undefined, process.env);
  return withRetentionDisposition(activity, policy, nowMs);
}

/** FG-590: exported so a consumer/test can resolve the active retention policy the same
 *  way this surface does. */
export function retentionPolicyForDashboard(): RetentionPolicy {
  return resolveRetention(undefined, process.env);
}

/** BD-10: launch detail addressed by IDENTITY. The id is validated against the same
 *  charset `launchDir` enforces BEFORE it can become a path, and the response
 *  deliberately carries NO host filesystem path — not the cwd, not the log path, not
 *  the project dir. The operator reaches the log through `/api/launches/:id/log`,
 *  which is likewise addressed by id. */
export type LaunchDetail = {
  launchId: string;
  name: string | null;
  command: string[];
  commandLine: string;
  startedAt: string;
  observedAt: string;
  statusLabel: string;
  state: string;
  observation: "fresh" | "unobserved";
  terminal: boolean;
  associationKind: string;
  /** FG-700: what the submitter DECLARED this launch is. Carried on the detail so the
   *  operator can see why a launch did or did not render as host verification. */
  purpose: LaunchPurpose;
  unassociated: boolean;
  runId: string | null;
  taskId: string | null;
  ticketId: string | null;
  campaignId: string | null;
  itemId: string | null;
  projectLabel: string | null;
};

export function launchDetail(launchId: string, nowMs: number = Date.now()): LaunchDetail | null {
  if (!isLaunchId(launchId)) return null;
  const row = db()
    // The column list is resolved against the store this handle opened: it is READ-ONLY
    // and runs no migrations, so `purpose` (FG-700) may not be there yet.
    .prepare(`SELECT ${launchObservationColumns(db())} FROM launch_observations WHERE launch_id = ?`)
    .get(launchId) as LaunchObservationRow | undefined;
  if (!row) return null;
  const obs = rowToLaunchObservation(row);
  const observedMs = Date.parse(obs.observedAt);
  // The SAME range predicate the shared derivation applies — a future-dated
  // observation is unusable, not maximally fresh.
  const fresh = observationIsFresh(Number.isFinite(observedMs) ? observedMs : null, nowMs, LAUNCH_OBSERVATION_FRESH_MS);
  // A terminal disposition is evidence that does not decay — it already happened.
  // Only a NON-terminal observation goes stale, and when it does it reads
  // `unobserved since <t>`: never `running`, never a fabricated terminal (BD-12).
  const stale = !obs.terminal && !fresh;
  return {
    launchId: obs.launchId,
    name: obs.name,
    command: obs.command,
    commandLine: obs.command.join(" "),
    startedAt: obs.startedAt,
    observedAt: obs.observedAt,
    statusLabel: stale ? `unobserved since ${obs.observedAt}` : statusLine(obs.status),
    state: stale ? "unknown" : obs.status.state,
    observation: stale ? "unobserved" : "fresh",
    terminal: obs.terminal,
    associationKind: obs.associationKind,
    purpose: obs.purpose,
    // The DECLARED submission ids, matching the shared derivation exactly:
    // `association_kind` names which channel resolved the project home (FG-684 AC4),
    // which is a different question from whether the launch was associated at all.
    unassociated: !hasPlacementAuthority(obs),
    runId: obs.runId,
    taskId: obs.taskId,
    ticketId: obs.ticketId,
    campaignId: obs.campaignId,
    itemId: obs.itemId,
    projectLabel: obs.projectDir === null ? null : basename(obs.projectDir),
  };
}

/** The launch log is UNBOUNDED host-command output, served by a process with no
 *  authentication (dashboard/src/server.ts binds an env-overridable address, defaulting
 *  to loopback). So the response is a BOUNDED TAIL by construction — id-only addressing
 *  constrains path traversal, not content volume, and only this bound constrains the
 *  latter. The bound matches the container-log surface's discipline; it is deliberately
 *  tighter than that surface's 64 KiB because a launch log is the operator's OWN shell
 *  environment (FG-626's reproduction is literally `forge launch run -- env`). */
export const LAUNCH_LOG_TAIL_BYTES = 16 * 1024;

/** What this response IS, stated in the response itself. There is no redactor here and
 *  there will not be one: docs/redaction.md establishes ALLOWLIST discipline for this
 *  codebase, and a denylist secret-scrubber over arbitrary command output would provide
 *  false assurance rather than safety. So the surface says plainly what it renders —
 *  raw stdout/stderr of a host command, in the operator's own environment — and a
 *  reader is never left to infer that something sanitized it. */
export const LAUNCH_LOG_CONTENT_NOTICE =
  "raw stdout/stderr of a host command, unredacted — it may contain environment variables, tokens or other secrets the command printed";

export type LaunchLogTail = {
  launchId: string;
  text: string;
  bytes: number;
  truncated: boolean;
  /** Always `raw`. A field rather than prose so a consumer must handle it. */
  content: "raw";
  notice: string;
  /** The tail bound in bytes, so a reader knows WHAT it is looking at without
   *  reverse-engineering it from `bytes` vs `text.length`. */
  maxBytes: number;
};

export function launchLogTail(launchId: string, maxBytes = LAUNCH_LOG_TAIL_BYTES): LaunchLogTail | null {
  if (!isLaunchId(launchId)) return null;
  // The id has no separator and no `..` (isLaunchId), so this can only ever name a
  // direct child of the launches dir. FORGE_HOME is resolved PER CALL (FG-616), never
  // snapshotted at module eval.
  const logPath = join(forgeHome(), "launches", launchId, "out.log");
  if (!existsSync(logPath)) return null;
  const size = statSync(logPath).size;
  const start = Math.max(0, size - maxBytes);
  const length = size - start;
  const buf = Buffer.alloc(length);
  const fd = openSync(logPath, "r");
  try {
    readSync(fd, buf, 0, length, start);
  } finally {
    closeSync(fd);
  }
  return {
    launchId,
    text: buf.toString("utf8"),
    bytes: size,
    truncated: start > 0,
    content: "raw",
    notice: LAUNCH_LOG_CONTENT_NOTICE,
    maxBytes,
  };
}

// ─── FG-591: the operator work queue board (GET /api/queue) ──────────────────
//
// THE FIVE VIEWS ARE PROJECTIONS OVER ORTHOGONAL DURABLE FIELDS, NOT FIVE
// COMPETING STATUSES. Exactly three durable facts are read per ticket — the
// lifecycle status (active | done | deferred), the nullable stack rank
// (tickets.priority_rank) and queue membership (queue_membership) — and
// everything else on a row is DERIVED on this read:
//   in progress — dispatch evidence with a non-terminal task, OR a live claim
//                 that has stamped its launch identity but whose first task has
//                 not spawned yet (see LAUNCHING below).
//   blocked     — blocker_evidence, by the SAME wide predicate the queue's own
//                 isQueueBlocked uses: status-bearing legacy evidence OR an
//                 enriched row whose queue_projection is 'blocked'.
//   done        — the lifecycle status, verbatim.
// Nothing here stores or writes any of it, and no column named in_progress or
// blocked exists to store.
//
// LAUNCHING — the window this projection would otherwise render as nothing.
// ticket_dispatch_evidence is written in exactly one place (src/v2/spawn.ts) when
// a spawned TASK carries a ticketId, so a queue-launched run only reads as in
// progress once its FIRST task spawns. Between the claim's launch stamp and that
// spawn a container is starting and the board would show an idle queue entry. So
// executionState carries `launching` beside `running`, from the RESERVATION's own
// launch_id — and the two stay distinguishable rather than collapsed.
//
// RESERVATION vs EXECUTION. queue_claims is authoritative for the reservation and
// the run/task record for the execution; they are read by SEPARATE queries and
// never joined in one, and neither is derived from the other. The payload keeps
// them as separate fields for the same reason.
//
// A SCHEDULING WAIT IS NOT A BLOCKER. "FG-123 is holding the worktree lane" is
// per-evaluation dispatcher scan evidence that evaporates when the active set
// changes; it lives in dispatcher_evaluations.scan_evidence and is read here as a
// `scheduling` wait on a row that stays in the QUEUED view. It is never
// blocker_evidence — that table is durable, per-ticket and partly container-visible,
// and a scheduling wait written there would silently reinterpret the ticket's status
// for every agent container.
//
// READ-ONLY, DIRECT SQL, NO OUTBOUND CALL. Same handle and same drift caveat as the
// rest of this file: column names are hardcoded here and the store modules own the
// writes. The literals that are VALUES rather than column names (the order-affecting
// queue event types, the terminal task statuses, the policy defaults, the content
// hash) are pinned against their single declarations by
// fg591-queue-projection.test.ts, because each side's own tests would otherwise write
// the string they read and drift stays green on both.

/** The order-affecting queue event types — the version a reorder is submitted
 *  against (D11). Mirrors QUEUE_ORDER_EVENT_TYPES in src/store/queue.ts, which
 *  cannot be imported here (it reaches getDb). Pinned by test. */
const QUEUE_ORDER_EVENT_TYPES = ["rank", "unrank", "enqueue", "dequeue", "reorder"] as const;

/** Mirrors TERMINAL_TASK_STATUSES in src/store/queue.ts: everything else —
 *  running, awaiting_gate, awaiting_red, blocked_by_red, awaiting_recovery — is
 *  work still in flight, which is what makes a ticket read as in progress. */
const TERMINAL_TASK_STATUSES = ["complete", "failed"] as const;

/** The queue projection value that means "this evidence blocks execution". The
 *  other value the column carries, 'not_ready', is a readiness hint and is
 *  deliberately not blocking. Mirrors QUEUE_BLOCKING_PROJECTION in queue.ts. */
const QUEUE_BLOCKING_PROJECTION = "blocked";

/** The readiness outcomes that permit an enqueue (QUEUEABLE_OUTCOMES in queue.ts).
 *  `exploratory` is deliberately included — a spike is queueable without ACs. */
const QUEUEABLE_READINESS_OUTCOMES = new Set(["ready", "exploratory"]);

/** dispatcher_policy defaults, mirroring src/store/dispatcher-policy.ts. `armed`
 *  is fail-closed: an absent row, a NULL column and an explicit 0 all read as
 *  false, so a store that has never seen an operator arm it never reads as armed. */
const DISPATCHER_POLICY_DEFAULTS = {
  maxActiveRuns: 1,
  capacityScope: "host" as "host" | "project",
  leaseTtlMs: 15 * 60_000,
  heartbeatMs: 5 * 60_000,
  defaultWorkflow: "feature",
};

/** The exclusive board columns. `backlog`, `queued`, `in_progress`, `blocked` and
 *  `done` are the five the ticket names; `executing_not_queued` is the sixth state
 *  the schema anticipated and the projection had no name for — an operator dequeue
 *  never releases a live claim (D4), so a dequeued item whose container is still
 *  running is a REAL, reachable state. Rendering it as a gap is how a live container
 *  becomes a phantom on the board. */
export const QUEUE_BOARD_VIEWS = [
  "backlog",
  "queued",
  "in_progress",
  "blocked",
  "done",
  "executing_not_queued",
] as const;

export type QueueBoardView = (typeof QUEUE_BOARD_VIEWS)[number];

/** running — a non-terminal task exists for this ticket. launching — the claim
 *  stamped its launch identity and no task has spawned yet. idle — neither. */
export type QueueExecutionState = "idle" | "launching" | "running";

/** WHY A QUEUED ITEM IS NOT RUNNING. The kinds are deliberately distinct: a
 *  genuine blocker and a temporary scheduling incompatibility are different facts
 *  with different durability, different owners and different operator actions. */
export type QueueWaitKind =
  /** Durable blocker evidence. The row is in the derived Blocked view. */
  | "blocker"
  /** TEMPORARY and self-clearing: the candidate cannot safely overlap the current
   *  active set. Stays QUEUED with the explanation. Never Blocked. */
  | "scheduling"
  /** The ceiling was full. `holders` on the capacity panel names who held the slots. */
  | "capacity"
  /** No assessment, a stale one, or an outcome outside ready|exploratory. */
  | "readiness"
  /** A queue member with no rank: the queue is ordered BY rank, so it has no position. */
  | "unranked"
  /** Ranked and a member, execution-ineligible by lifecycle (FG-609 D5). */
  | "deferred"
  /** A live claim held by someone — the reservation exists, the launch has not
   *  been stamped (or was released) yet. */
  | "claimed"
  /** Autonomous dispatch is disarmed. Queue membership is planning intent, and
   *  never execution authorization. */
  | "disarmed"
  /** No durable evaluation covers this ticket. Reported as such rather than
   *  guessed at — an unrecorded reason is not an answer. */
  | "not_evaluated";

export type QueueBoardWait = {
  kind: QueueWaitKind;
  /** Operator-readable, and concrete: the dispatcher's own reason string where
   *  there is one ("waiting for FG-123 to finish"), never a bare boolean. */
  reason: string;
  /** Where the answer came from, so a reader can tell a durable per-ticket fact
   *  from a per-evaluation observation that will evaporate. */
  source: "blocker_evidence" | "dispatcher_evaluation" | "queue_state" | "dispatcher_policy";
  /** When the dispatcher observed it (ISO). Null for a durable queue-state fact. */
  observedAt: string | null;
};

export type QueueBoardBlocker = {
  source: string;
  kind: string | null;
  reason: string | null;
  detail: string | null;
  queueProjection: string | null;
  createdAt: string | null;
  /** True when THIS row is what makes the queue projection blocked. */
  blocking: boolean;
};

export type QueueBoardReadiness = {
  outcome: string;
  gaps: string[];
  refinementProposal: string | null;
  revision: number | null;
  evaluatedAt: string;
  /** A body-hash mismatch against the ticket's CURRENT content. There is no other
   *  definition of stale, and a stale assessment is operator-actionable — the
   *  dispatcher never silently re-evaluates it (D7). */
  stale: boolean;
  /** The assessment permits an enqueue AND still describes the current revision. */
  queueable: boolean;
};

/** The RESERVATION half. Never joined to the execution half in one query. */
export type QueueBoardReservation = {
  claimId: string;
  owner: string;
  generation: number;
  ticketRevision: number;
  launchId: string | null;
  runId: string | null;
  leaseExpiresAtMs: number;
  heartbeatAtMs: number;
  /** The lease is strictly expired on the STORE clock — recoverable by takeover.
   *  An expired lease proves the owner stopped heartbeating; it proves NOTHING
   *  about the container, which is why the launch identity is durable. */
  leaseExpired: boolean;
  claimedAt: string;
};

export type QueueBoardRow = {
  ticketId: string;
  title: string;
  type: string;
  /** The lifecycle status verbatim (active | done | deferred). NOT a projection. */
  status: string;
  /** DURABLE FACT 1 — the one canonical stack rank. Null is a perfectly valid
   *  backlog item, not a deprioritized one. */
  rank: number | null;
  /** DURABLE FACT 2 — operator queue membership, orthogonal to rank and lifecycle. */
  queued: boolean;
  enqueuedAt: string | null;
  enqueuedBy: string | null;
  note: string | null;
  /** DERIVED. Never stored. */
  blocked: boolean;
  blockers: QueueBoardBlocker[];
  /** DERIVED. Never stored. */
  inProgress: boolean;
  executionState: QueueExecutionState;
  reservation: QueueBoardReservation | null;
  readiness: QueueBoardReadiness | null;
  /** The exclusive board column this row renders in. */
  view: QueueBoardView;
  /** Why it is not running, when it is not. Null for a row that IS running, is
   *  done, or is a plain backlog item the operator has not queued. */
  wait: QueueBoardWait | null;
  /** The dispatcher's own per-candidate verdict from the last evaluation that
   *  scanned this ticket — queue-claims' ScanReason vocabulary verbatim, never a
   *  second one. Null when the last evaluation did not reach this candidate. */
  scanReason: string | null;
  scanDetail: string | null;
};

export type QueueCapacityHolder = {
  claimId: string;
  projectKey: string;
  /** The registry label for that project, when the holder is resolvable to one.
   *  Null rather than a guess — but projectKey is always present, which is what
   *  makes a HOST-scoped refusal readable from a single project's board. */
  projectLabel: string | null;
  ticketId: string;
  owner: string;
  launchId: string | null;
  runId: string | null;
  /** False means ANOTHER project holds this slot. */
  thisProject: boolean;
};

export type QueueCapacity = {
  scope: "host" | "project";
  limit: number;
  /** REPORTED at read time from live claim rows. The ENFORCED count is taken
   *  inside claimNextEligible's write transaction and is the only one that bounds
   *  admission; this number is an observation of the same rows a moment later. */
  queueOwnedActive: number;
  holders: QueueCapacityHolder[];
  otherProjectHolders: number;
  /** THE STATED CAPACITY POLICY. The ceiling bounds QUEUE-OWNED runs only.
   *  Operator-initiated runs, campaign items and review loops carry no claim row,
   *  are structurally invisible to the enforced count, and are reported here
   *  beside it rather than subtracted from it — a dispatcher-side subtraction
   *  would read as a guarantee and be a guess. */
  notCounted: {
    /** Non-terminal tasks host-wide, counted independently of any claim row. */
    activeTasks: number;
    policy: string;
  };
  /** The last evaluation the ceiling actually refused, with the holder list AS IT
   *  WAS at refusal time — by the time an operator looks, the holder may have
   *  finished, and "who held the slot when I was refused" is the question. */
  lastRefusal: {
    evaluatedAt: string;
    scope: string | null;
    limit: number | null;
    used: number | null;
    holders: QueueCapacityHolder[];
  } | null;
};

/** The six answers that must stay DISTINGUISHABLE rather than collapsing into
 *  "nothing is running", plus the two honest unknowns. Every value is read from a
 *  durable record — the policy row, the lease row, the evaluation row — and never
 *  inferred from the absence of activity. */
export type DispatcherPanelState =
  | "dispatching"
  | "disarmed"
  | "no_capacity"
  | "no_eligible_work"
  | "incompatible_only"
  | "lost"
  | "stale_dispatcher"
  | "no_dispatcher"
  | "not_evaluated";

export type DispatcherPanel = {
  armed: boolean;
  /** False when NO host policy row has ever been written: every value below is a
   *  default rather than an operator choice, and the surface says so instead of
   *  presenting a default as a decision. */
  configured: boolean;
  maxActiveRuns: number;
  capacityScope: "host" | "project";
  leaseTtlMs: number;
  heartbeatMs: number;
  defaultWorkflow: string;
  updatedAt: string | null;
  updatedBy: string | null;
  lease: {
    owner: string;
    generation: number;
    leaseExpiresAtMs: number;
    heartbeatAtMs: number;
    host: string | null;
    pid: number | null;
    createdAt: string;
    updatedAt: string;
  } | null;
  /** The lease has not expired on the store clock — the owner is still authorized. */
  leaseLive: boolean;
  leaseExpired: boolean;
  /** How long since the owner was last actually ALIVE. "Nothing to do" and "the
   *  dispatcher died four hours ago" must be distinguishable, and only the
   *  heartbeat column can say so. */
  msSinceHeartbeatMs: number | null;
  lastEvaluation: {
    reason: string;
    detail: string | null;
    evaluatedAt: string;
    evaluatedAtMs: number;
    wakeKind: string | null;
    claimedTicketId: string | null;
    capacityScope: string | null;
    capacityLimit: number | null;
    capacityUsed: number | null;
    scannedCount: number | null;
  } | null;
  nextWatchdogAtMs: number | null;
  pendingWakes: number;
  state: DispatcherPanelState;
  stateDetail: string;
  /** Arming autonomous dispatch and setting the ceiling are CLI-only in this
   *  story (D2): an unauthenticated localhost POST that authorizes unattended
   *  container execution is a materially larger capability than the read surface
   *  this route is. Stated in the payload so the board renders an affordance
   *  rather than a disabled button. */
  controlSurface: "cli-only";
};

export type QueueBoard = {
  /** null = this repository has no ticket truth (never imported / not registered). */
  projectKey: string | null;
  storageMode: "db" | "markdown" | null;
  /** The operator queue is a DB-store concept; a markdown-mode project has none. */
  queueAvailable: boolean;
  unavailableReason: string | null;
  /** The version a reorder must carry (D11) — the id of the project's most recent
   *  order-affecting queue event, 0 for a queue that has never moved. */
  version: number;
  /** THE COMPLETE BACKLOG (AC1): every non-done ticket, ranked or not, deferred
   *  ones visible and marked execution-ineligible — plus the done tickets the
   *  queue has actually touched (ranked, a member, or claimed at some point), so
   *  the Done column has content without becoming the entire closed backlog. */
  rows: QueueBoardRow[];
  /** The exclusive partition of `rows` into board columns, in canonical order. */
  views: Record<QueueBoardView, string[]>;
  dispatcher: DispatcherPanel;
  capacity: QueueCapacity;
  nowMs: number;
  /** Named reads that could not be answered (a store whose last writable open
   *  predates these tables). Empty is the normal case; a non-empty entry means a
   *  section is UNKNOWN rather than empty. */
  degraded: string[];
};

/** A fresh, unshared empty column set. Returned by a function rather than held as
 *  a shared constant: a spread would copy the record and alias every array. */
function emptyBoardViews(): Record<QueueBoardView, string[]> {
  return { backlog: [], queued: [], in_progress: [], blocked: [], done: [], executing_not_queued: [] };
}

/** THE COLUMN, decided from the orthogonal facts alone.
 *
 *  Precedence, and why: lifecycle `done` first (a finished ticket is not waiting
 *  on anything); then execution, because a running container is the most urgent
 *  true statement about a row and is what makes the not-a-member-but-executing
 *  state visible at all; then blocked, which only applies to queue MEMBERS — a
 *  non-member blocked ticket stays in Backlog carrying `blocked: true`, because
 *  the Blocked column is the operator's queue seen through a blocker, not a view
 *  of every impeded ticket in the repository. */
export function classifyQueueBoardView(facts: {
  status: string;
  queued: boolean;
  blocked: boolean;
  executionState: QueueExecutionState;
}): QueueBoardView {
  if (facts.status === "done") return "done";
  if (facts.executionState !== "idle") return facts.queued ? "in_progress" : "executing_not_queued";
  if (facts.blocked && facts.queued) return "blocked";
  if (facts.queued) return "queued";
  return "backlog";
}

/** WHY THIS ITEM IS NOT RUNNING — pure over already-hydrated facts.
 *
 *  The ordering is durable-facts-first: what the store knows about the TICKET
 *  (lifecycle, membership, rank, blockers, readiness) is a better answer than what
 *  the dispatcher observed about a PASS, and it does not evaporate. Only when the
 *  ticket itself is fine do we fall through to the per-evaluation scan evidence,
 *  which is where a temporary scheduling incompatibility lives — and it produces a
 *  `scheduling` wait, never a blocker. */
export function deriveQueueWait(facts: {
  status: string;
  queued: boolean;
  rank: number | null;
  blocked: boolean;
  blockerReason: string | null;
  executionState: QueueExecutionState;
  reservation: { owner: string } | null;
  readiness: QueueBoardReadiness | null;
  armed: boolean;
  scan: { reason: string; detail: string | null } | null;
  evaluation: { reason: string; evaluatedAt: string; detail: string | null } | null;
}): QueueBoardWait | null {
  if (facts.status === "done") return null;
  if (facts.executionState !== "idle") return null;
  const observedAt = facts.evaluation?.evaluatedAt ?? null;

  if (facts.status === "deferred") {
    return {
      kind: "deferred",
      reason: "deferred — it keeps its rank, its membership and its history, and is execution-ineligible until it is reactivated.",
      source: "queue_state",
      observedAt: null,
    };
  }
  if (facts.blocked) {
    return {
      kind: "blocker",
      reason: facts.blockerReason ?? "blocker evidence is recorded against this ticket.",
      source: "blocker_evidence",
      observedAt: null,
    };
  }
  if (!facts.queued) return null;
  if (facts.reservation) {
    return {
      kind: "claimed",
      reason: `claimed by ${facts.reservation.owner}; the container has not stamped a launch yet.`,
      source: "queue_state",
      observedAt: null,
    };
  }
  if (facts.rank === null) {
    return {
      kind: "unranked",
      reason: "queued without a rank, so the queue has no position for it. Rank it to give it one.",
      source: "queue_state",
      observedAt: null,
    };
  }
  if (!facts.readiness || !facts.readiness.queueable) {
    const detail = !facts.readiness
      ? "no readiness assessment has been recorded."
      : facts.readiness.stale
        ? `the '${facts.readiness.outcome}' assessment describes an older revision — the ticket was edited after it was recorded.`
        : `it evaluates '${facts.readiness.outcome}'${facts.readiness.refinementProposal ? `: ${facts.readiness.refinementProposal}` : "."}`;
    return { kind: "readiness", reason: detail, source: "queue_state", observedAt: null };
  }

  if (facts.scan) {
    switch (facts.scan.reason) {
      case "incompatible":
        return {
          kind: "scheduling",
          // TEMPORARY and self-clearing. Rendered in the QUEUED column with this
          // explanation — mislabeling it Blocked is the defect the AC names.
          reason: facts.scan.detail ?? "it cannot safely overlap the current active set.",
          source: "dispatcher_evaluation",
          observedAt,
        };
      case "capacity":
        return {
          kind: "capacity",
          reason: facts.scan.detail ?? "the capacity ceiling was full when it was scanned.",
          source: "dispatcher_evaluation",
          observedAt,
        };
      case "already_claimed":
        return {
          kind: "claimed",
          reason: facts.scan.detail ?? "another dispatcher holds a live claim on it.",
          source: "dispatcher_evaluation",
          observedAt,
        };
      case "eligible":
        // It WAS selectable. If the pass still granted nothing, the pass-level
        // reason is the honest answer.
        if (facts.evaluation?.reason === "no_capacity") {
          return {
            kind: "capacity",
            reason: facts.evaluation.detail ?? "the capacity ceiling was full.",
            source: "dispatcher_evaluation",
            observedAt,
          };
        }
        return null;
      default:
        return {
          kind: "not_evaluated",
          reason: `the dispatcher passed it over as '${facts.scan.reason}'${facts.scan.detail ? `: ${facts.scan.detail}` : "."}`,
          source: "dispatcher_evaluation",
          observedAt,
        };
    }
  }

  if (!facts.armed) {
    return {
      kind: "disarmed",
      reason: "autonomous dispatch is disarmed — queue membership is planning intent, never execution authorization. Arm it with `forge queue dispatcher arm`.",
      source: "dispatcher_policy",
      observedAt: null,
    };
  }
  return {
    kind: "not_evaluated",
    reason: facts.evaluation
      ? `the last dispatcher evaluation (${facts.evaluation.reason}) did not reach this candidate.`
      : "no dispatcher evaluation has been recorded for this project yet.",
    source: "dispatcher_evaluation",
    observedAt,
  };
}

/** THE CONTENT BASIS, mirroring ticketContentHash in src/store/tickets.ts — the
 *  fallback for a row written before `tickets.body_hash` existed. A stamped
 *  body_hash is used as-is; this recomputes the identical value for one that is
 *  NULL, exactly as queue.ts's ticketBodyHash does. Pinned by test. */
function ticketContentHashLocal(t: {
  type: string;
  status: string;
  title: string;
  body: string;
  created: string | null;
  closed: string | null;
  closedCommit: string | null;
  epic: string | null;
}): string {
  const canonical = JSON.stringify([
    t.type,
    t.status,
    t.title,
    t.body,
    t.created ?? null,
    t.closed ?? null,
    t.closedCommit ?? null,
    t.epic ?? null,
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

/** A read whose TABLE or COLUMN does not exist on this store — a legitimate state
 *  (a read-only open never migrates one into existence), not a server fault. It is
 *  reported by name in `degraded` rather than silently answered as empty: an empty
 *  section and an unreadable one are different facts. Any other error propagates. */
function tolerantRead<T>(read: () => T, fallback: T, label: string, degraded: string[]): T {
  try {
    return read();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/no such table|no such column/i.test(message)) {
      const note = `${label}: ${message}`;
      // One entry per named read: two queries over the same missing table are one
      // unreadable section, not two.
      if (!degraded.includes(note)) degraded.push(note);
      return fallback;
    }
    throw err;
  }
}

/** The STORE's own clock, the same expression storeNowMs (src/store/publications.ts)
 *  evaluates. Lease expiry and heartbeat staleness are compared against it and never
 *  against this process's clock — two processes with skewed clocks must not disagree
 *  about whether a dispatcher is alive. */
function storeNowMsRead(): number {
  const row = db()
    .prepare(`SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS ms`)
    .get() as { ms: number };
  return row.ms;
}

type ClaimDbRow = {
  id: string;
  project_key: string;
  ticket_id: string;
  owner: string;
  generation: number;
  ticket_revision: number;
  lease_expires_at_ms: number;
  heartbeat_at_ms: number;
  launch_id: string | null;
  run_id: string | null;
  claimed_at: string;
};

const CLAIM_BOARD_COLUMNS = `id, project_key, ticket_id, owner, generation, ticket_revision,
  lease_expires_at_ms, heartbeat_at_ms, launch_id, run_id, claimed_at`;

/** THE BOARD. One project's queue as five projections over orthogonal durable
 *  fields, plus the dispatcher panel and the host-scoped capacity context.
 *
 *  `projects` is the dashboard's own registry, passed in rather than re-scanned, and
 *  used for ONE thing: naming which OTHER project holds a capacity slot. Under a
 *  host-scoped ceiling a per-project board cannot otherwise explain its own refusal. */
export function queueBoard(project: ProjectRecord | null, projects: readonly ProjectRecord[] = []): QueueBoard {
  const degraded: string[] = [];
  const nowMs = storeNowMsRead();

  const identity = project
    ? (db()
        .prepare(`SELECT project_key FROM project_identity WHERE repo_evidence_key = ?`)
        .get(project.key) as { project_key: string } | undefined)
    : undefined;
  const projectKey = identity?.project_key ?? null;

  const mode = projectKey
    ? (db().prepare(`SELECT mode FROM ticket_storage_mode WHERE project_key = ?`).get(projectKey) as
        | { mode: string }
        | undefined)
    : undefined;
  const storageMode: "db" | "markdown" | null = projectKey ? (mode?.mode === "db" ? "db" : "markdown") : null;

  // Every project's project_key ↔ repo evidence key, so a host-scope holder in
  // ANOTHER project can be named. Read once; the list is one row per registered
  // project.
  const labelByProjectKey = new Map<string, string>();
  for (const row of tolerantRead(
    () =>
      db().prepare(`SELECT project_key, repo_evidence_key FROM project_identity`).all() as Array<{
        project_key: string;
        repo_evidence_key: string;
      }>,
    [],
    "project_identity",
    degraded,
  )) {
    const record = projects.find((entry) => entry.key === row.repo_evidence_key);
    if (record) labelByProjectKey.set(row.project_key, record.label);
  }

  const policy = readDispatcherPolicy(projectKey, degraded);
  const capacity = readCapacity(projectKey, policy, labelByProjectKey, degraded);
  const lease = projectKey ? readDispatcherLease(projectKey, degraded) : null;
  const evaluation = projectKey ? readLatestEvaluation(projectKey, degraded) : null;
  const pendingWakes = projectKey
    ? tolerantRead(
        () =>
          (db()
            .prepare(`SELECT COUNT(*) AS n FROM dispatcher_wakes WHERE project_key = ? AND state = 'pending'`)
            .get(projectKey) as { n: number }).n,
        0,
        "dispatcher_wakes",
        degraded,
      )
    : 0;

  const dispatcher = dispatcherPanel(policy, lease, evaluation, pendingWakes, nowMs);

  if (!projectKey || storageMode !== "db") {
    return {
      projectKey,
      storageMode,
      queueAvailable: false,
      unavailableReason: !projectKey
        ? "this repository has no ticket truth in the host store — it has never been imported (`forge backlog migrate`)."
        : "the operator queue is a DB-store concept and this project's ticket truth is still Markdown. Cut it over with `forge backlog migrate`.",
      version: 0,
      rows: [],
      views: emptyBoardViews(),
      dispatcher,
      capacity,
      nowMs,
      degraded,
    };
  }

  const version = tolerantRead(
    () =>
      (db()
        .prepare(
          `SELECT MAX(id) AS version FROM queue_events
            WHERE project_key = ? AND event_type IN (${QUEUE_ORDER_EVENT_TYPES.map(() => "?").join(", ")})`,
        )
        .get(projectKey, ...QUEUE_ORDER_EVENT_TYPES) as { version: number | null } | undefined)?.version ?? 0,
    0,
    "queue_events",
    degraded,
  );

  const ticketRows = tolerantRead(
    () =>
      db()
        .prepare(
          `SELECT t.ticket_id, t.type, t.status, t.title, t.body, t.created, t.closed, t.closed_commit,
                  t.epic, t.priority_rank, t.revision, t.body_hash,
                  m.enqueued_at, m.enqueued_by, m.note
             FROM tickets t
             LEFT JOIN queue_membership m
               ON m.project_key = t.project_key AND m.ticket_id = t.ticket_id
            WHERE t.project_key = ?`,
        )
        .all(projectKey) as Array<{
        ticket_id: string;
        type: string;
        status: string;
        title: string;
        body: string;
        created: string | null;
        closed: string | null;
        closed_commit: string | null;
        epic: string | null;
        priority_rank: number | null;
        revision: number | null;
        body_hash: string | null;
        enqueued_at: string | null;
        enqueued_by: string | null;
        note: string | null;
      }>,
    [],
    "tickets/queue_membership",
    degraded,
  );

  // Set-wide reads rather than per-ticket ones: a board with several hundred
  // tickets is a normal size and this route is polled.
  const blockersByTicket = new Map<string, QueueBoardBlocker[]>();
  for (const row of tolerantRead(
    () =>
      db()
        .prepare(
          `SELECT ticket_id, source, kind, reason, detail, queue_projection, created_at
             FROM blocker_evidence WHERE project_key = ?`,
        )
        .all(projectKey) as Array<{
        ticket_id: string;
        source: string;
        kind: string | null;
        reason: string | null;
        detail: string | null;
        queue_projection: string | null;
        created_at: string | null;
      }>,
    [],
    "blocker_evidence",
    degraded,
  )) {
    const list = blockersByTicket.get(row.ticket_id) ?? [];
    list.push({
      source: row.source,
      kind: row.kind,
      reason: row.reason,
      detail: row.detail,
      queueProjection: row.queue_projection,
      createdAt: row.created_at,
      // The SAME wide predicate isQueueBlocked uses: status-bearing legacy
      // evidence OR an enriched row whose stored queue_projection blocks. The
      // narrow, container-visible ticket-status predicate is a different one and
      // enriched evidence never moves it.
      blocking:
        isStatusBearingEvidenceSource(row.source) || row.queue_projection === QUEUE_BLOCKING_PROJECTION,
    });
    blockersByTicket.set(row.ticket_id, list);
  }

  const readinessByTicket = new Map<
    string,
    { bodyHash: string; outcome: string; gaps: string[]; refinementProposal: string | null; revision: number | null; evaluatedAt: string }
  >();
  for (const row of tolerantRead(
    () =>
      db()
        .prepare(
          `SELECT ticket_id, body_hash, outcome, gaps_json, refinement_proposal, revision, evaluated_at
             FROM readiness_assessments WHERE project_key = ?`,
        )
        .all(projectKey) as Array<{
        ticket_id: string;
        body_hash: string;
        outcome: string;
        gaps_json: string;
        refinement_proposal: string | null;
        revision: number | null;
        evaluated_at: string;
      }>,
    [],
    "readiness_assessments",
    degraded,
  )) {
    readinessByTicket.set(row.ticket_id, {
      bodyHash: row.body_hash,
      outcome: row.outcome,
      gaps: (safeJsonParse(row.gaps_json) as string[] | undefined) ?? [],
      refinementProposal: row.refinement_proposal,
      revision: row.revision,
      evaluatedAt: row.evaluated_at,
    });
  }

  // THE EXECUTION HALF — dispatch evidence with a non-terminal task. Its own
  // query, never joined to the reservation half.
  const running = new Set(
    tolerantRead(
      () =>
        db()
          .prepare(
            `SELECT DISTINCT e.ticket_id
               FROM ticket_dispatch_evidence e
               JOIN tasks t ON t.id = e.task_id
              WHERE e.project_key = ?
                AND t.status NOT IN (${TERMINAL_TASK_STATUSES.map(() => "?").join(", ")})`,
          )
          .all(projectKey, ...TERMINAL_TASK_STATUSES) as Array<{ ticket_id: string }>,
      [],
      "ticket_dispatch_evidence",
      degraded,
    ).map((r) => r.ticket_id),
  );

  // THE RESERVATION HALF — live claims of THIS project. Its own query.
  const reservationByTicket = new Map<string, QueueBoardReservation>();
  for (const row of tolerantRead(
    () =>
      db()
        .prepare(`SELECT ${CLAIM_BOARD_COLUMNS} FROM queue_claims WHERE project_key = ? AND state = 'live'`)
        .all(projectKey) as ClaimDbRow[],
    [],
    "queue_claims",
    degraded,
  )) {
    reservationByTicket.set(row.ticket_id, {
      claimId: row.id,
      owner: row.owner,
      generation: row.generation,
      ticketRevision: row.ticket_revision,
      launchId: row.launch_id,
      runId: row.run_id,
      leaseExpiresAtMs: row.lease_expires_at_ms,
      heartbeatAtMs: row.heartbeat_at_ms,
      leaseExpired: row.lease_expires_at_ms < nowMs,
      claimedAt: row.claimed_at,
    });
  }

  // Every ticket the queue has EVER claimed, so a done one the queue actually ran
  // still has a place in the Done column.
  const everClaimed = new Set(
    tolerantRead(
      () =>
        db()
          .prepare(`SELECT DISTINCT ticket_id FROM queue_claims WHERE project_key = ?`)
          .all(projectKey) as Array<{ ticket_id: string }>,
      [],
      "queue_claims",
      degraded,
    ).map((r) => r.ticket_id),
  );

  const scanByTicket = new Map<string, { reason: string; detail: string | null }>();
  for (const entry of evaluation?.scanEvidence ?? []) {
    if (typeof entry?.ticketId === "string") {
      scanByTicket.set(entry.ticketId, { reason: String(entry.reason), detail: entry.detail ?? null });
    }
  }

  const rows: QueueBoardRow[] = [];
  for (const row of ticketRows) {
    const queued = row.enqueued_at !== null;
    const rank = row.priority_rank;
    if (row.status === "done" && !queued && rank === null && !everClaimed.has(row.ticket_id)) continue;

    const blockers = blockersByTicket.get(row.ticket_id) ?? [];
    const blocked = blockers.some((b) => b.blocking);
    const stored = readinessByTicket.get(row.ticket_id);
    const currentHash =
      row.body_hash ??
      ticketContentHashLocal({
        type: row.type,
        status: row.status,
        title: row.title,
        body: row.body,
        created: row.created,
        closed: row.closed,
        closedCommit: row.closed_commit,
        epic: row.epic,
      });
    const readiness: QueueBoardReadiness | null = stored
      ? {
          outcome: stored.outcome,
          gaps: stored.gaps,
          refinementProposal: stored.refinementProposal,
          revision: stored.revision,
          evaluatedAt: stored.evaluatedAt,
          stale: stored.bodyHash !== currentHash,
          queueable: stored.bodyHash === currentHash && QUEUEABLE_READINESS_OUTCOMES.has(stored.outcome),
        }
      : null;

    const reservation = reservationByTicket.get(row.ticket_id) ?? null;
    const inProgress = running.has(row.ticket_id);
    const executionState: QueueExecutionState = inProgress
      ? "running"
      : reservation && reservation.launchId !== null
        ? "launching"
        : "idle";
    const view = classifyQueueBoardView({ status: row.status, queued, blocked, executionState });
    const scan = scanByTicket.get(row.ticket_id) ?? null;
    const blockingReasons = blockers.filter((b) => b.blocking).map((b) => b.reason ?? b.source);

    rows.push({
      ticketId: row.ticket_id,
      title: row.title,
      type: row.type,
      status: row.status,
      rank,
      queued,
      enqueuedAt: row.enqueued_at,
      enqueuedBy: row.enqueued_by,
      note: row.note,
      blocked,
      blockers,
      inProgress,
      executionState,
      reservation,
      readiness,
      view,
      wait: deriveQueueWait({
        status: row.status,
        queued,
        rank,
        blocked,
        blockerReason: blockingReasons.length > 0 ? blockingReasons.join("; ") : null,
        executionState,
        reservation,
        readiness,
        armed: policy.armed,
        scan,
        evaluation: evaluation
          ? { reason: evaluation.reason, evaluatedAt: evaluation.evaluatedAt, detail: evaluation.detail }
          : null,
      }),
      scanReason: scan?.reason ?? null,
      scanDetail: scan?.detail ?? null,
    });
  }

  // CANONICAL ORDER, total: ranked first by rank then ticket id (the store's own
  // `ORDER BY priority_rank ASC, ticket_id ASC`), unranked after, by ticket id.
  rows.sort((a, b) => {
    if (a.rank !== null && b.rank !== null && a.rank !== b.rank) return a.rank - b.rank;
    if (a.rank !== null && b.rank === null) return -1;
    if (a.rank === null && b.rank !== null) return 1;
    return compareTicketIds(a.ticketId, b.ticketId);
  });

  const views = emptyBoardViews();
  for (const row of rows) views[row.view].push(row.ticketId);

  return {
    projectKey,
    storageMode,
    queueAvailable: true,
    unavailableReason: null,
    version,
    rows,
    views,
    dispatcher,
    capacity,
    nowMs,
    degraded,
  };
}

type BoardPolicy = {
  armed: boolean;
  configured: boolean;
  maxActiveRuns: number;
  capacityScope: "host" | "project";
  leaseTtlMs: number;
  heartbeatMs: number;
  defaultWorkflow: string;
  updatedAt: string | null;
  updatedBy: string | null;
};

/** ONE TABLE, TWO ROW SHAPES. The `host` row is the singleton carrying the ceiling
 *  and the cadences; an optional per-project row carries only default_workflow and
 *  NEVER a ceiling — two dispatchers holding different ceilings while enforcing
 *  against one shared count would make the effective ceiling whichever ran last. */
function readDispatcherPolicy(projectKey: string | null, degraded: string[]): BoardPolicy {
  const scopeKeys = projectKey === null ? ["host"] : ["host", projectKey];
  const rows = tolerantRead(
    () =>
      db()
        .prepare(
          `SELECT scope_key, armed, max_active_runs, capacity_scope, lease_ttl_ms, heartbeat_ms,
                  default_workflow, updated_at, updated_by
             FROM dispatcher_policy WHERE scope_key IN (${scopeKeys.map(() => "?").join(", ")})`,
        )
        .all(...scopeKeys) as Array<{
        scope_key: string;
        armed: number | null;
        max_active_runs: number | null;
        capacity_scope: string | null;
        lease_ttl_ms: number | null;
        heartbeat_ms: number | null;
        default_workflow: string | null;
        updated_at: string | null;
        updated_by: string | null;
      }>,
    [],
    "dispatcher_policy",
    degraded,
  );
  const host = rows.find((r) => r.scope_key === "host");
  const projectRow = projectKey ? rows.find((r) => r.scope_key === projectKey) : undefined;
  const scope = host?.capacity_scope === "project" ? "project" : DISPATCHER_POLICY_DEFAULTS.capacityScope;
  return {
    armed: host?.armed === 1,
    configured: host !== undefined,
    maxActiveRuns: host?.max_active_runs ?? DISPATCHER_POLICY_DEFAULTS.maxActiveRuns,
    capacityScope: scope,
    leaseTtlMs: host?.lease_ttl_ms ?? DISPATCHER_POLICY_DEFAULTS.leaseTtlMs,
    heartbeatMs: host?.heartbeat_ms ?? DISPATCHER_POLICY_DEFAULTS.heartbeatMs,
    defaultWorkflow:
      projectRow?.default_workflow ?? host?.default_workflow ?? DISPATCHER_POLICY_DEFAULTS.defaultWorkflow,
    updatedAt: host?.updated_at ?? null,
    updatedBy: host?.updated_by ?? null,
  };
}

type BoardLease = {
  owner: string;
  generation: number;
  leaseExpiresAtMs: number;
  heartbeatAtMs: number;
  host: string | null;
  pid: number | null;
  createdAt: string;
  updatedAt: string;
};

function readDispatcherLease(projectKey: string, degraded: string[]): BoardLease | null {
  const row = tolerantRead(
    () =>
      db()
        .prepare(
          `SELECT owner, generation, lease_expires_at_ms, heartbeat_at_ms, host, pid, created_at, updated_at
             FROM dispatcher_leases WHERE project_key = ?`,
        )
        .get(projectKey) as
        | {
            owner: string;
            generation: number;
            lease_expires_at_ms: number;
            heartbeat_at_ms: number;
            host: string | null;
            pid: number | null;
            created_at: string;
            updated_at: string;
          }
        | undefined,
    undefined,
    "dispatcher_leases",
    degraded,
  );
  if (!row) return null;
  return {
    owner: row.owner,
    generation: row.generation,
    leaseExpiresAtMs: row.lease_expires_at_ms,
    heartbeatAtMs: row.heartbeat_at_ms,
    host: row.host,
    pid: row.pid,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

type BoardEvaluation = {
  reason: string;
  detail: string | null;
  claimedTicketId: string | null;
  capacityScope: string | null;
  capacityLimit: number | null;
  capacityUsed: number | null;
  capacityHolders: Array<{ claimId: string; projectKey: string; ticketId: string; owner: string; launchId: string | null; runId: string | null }> | null;
  scanEvidence: Array<{ ticketId: string; rank: number | null; reason: string; detail: string | null }> | null;
  wakeKind: string | null;
  nextWatchdogAtMs: number | null;
  evaluatedAtMs: number;
  evaluatedAt: string;
};

const EVALUATION_BOARD_COLUMNS = `reason, detail, claimed_ticket_id, capacity_scope, capacity_limit,
  capacity_used, capacity_holders, scan_evidence, wake_kind, next_watchdog_at_ms, evaluated_at_ms, evaluated_at`;

type EvaluationBoardDbRow = {
  reason: string;
  detail: string | null;
  claimed_ticket_id: string | null;
  capacity_scope: string | null;
  capacity_limit: number | null;
  capacity_used: number | null;
  capacity_holders: string | null;
  scan_evidence: string | null;
  wake_kind: string | null;
  next_watchdog_at_ms: number | null;
  evaluated_at_ms: number;
  evaluated_at: string;
};

function toBoardEvaluation(row: EvaluationBoardDbRow): BoardEvaluation {
  return {
    reason: row.reason,
    detail: row.detail,
    claimedTicketId: row.claimed_ticket_id,
    capacityScope: row.capacity_scope,
    capacityLimit: row.capacity_limit,
    capacityUsed: row.capacity_used,
    capacityHolders: row.capacity_holders === null ? null : (safeJsonParse(row.capacity_holders) as BoardEvaluation["capacityHolders"]) ?? null,
    scanEvidence: row.scan_evidence === null ? null : (safeJsonParse(row.scan_evidence) as BoardEvaluation["scanEvidence"]) ?? null,
    wakeKind: row.wake_kind,
    nextWatchdogAtMs: row.next_watchdog_at_ms,
    evaluatedAtMs: row.evaluated_at_ms,
    evaluatedAt: row.evaluated_at,
  };
}

/** THE DURABLE ANSWER TO "WHY DID NOTHING START" — the latest evaluation pass,
 *  including the passes that granted nothing. That is the whole point of the row:
 *  an idle queue that leaves no record of why is the operator blindness this
 *  surface exists to close. */
function readLatestEvaluation(projectKey: string, degraded: string[]): BoardEvaluation | null {
  const row = tolerantRead(
    () =>
      db()
        .prepare(
          `SELECT ${EVALUATION_BOARD_COLUMNS} FROM dispatcher_evaluations
            WHERE project_key = ? ORDER BY id DESC LIMIT 1`,
        )
        .get(projectKey) as EvaluationBoardDbRow | undefined,
    undefined,
    "dispatcher_evaluations",
    degraded,
  );
  return row ? toBoardEvaluation(row) : null;
}

/** The latest pass the CEILING actually refused, whatever has happened since. */
function readLatestCapacityRefusal(projectKey: string, degraded: string[]): BoardEvaluation | null {
  const row = tolerantRead(
    () =>
      db()
        .prepare(
          `SELECT ${EVALUATION_BOARD_COLUMNS} FROM dispatcher_evaluations
            WHERE project_key = ? AND reason = 'no_capacity' ORDER BY id DESC LIMIT 1`,
        )
        .get(projectKey) as EvaluationBoardDbRow | undefined,
    undefined,
    "dispatcher_evaluations",
    degraded,
  );
  return row ? toBoardEvaluation(row) : null;
}

/** THE CAPACITY CONTEXT. The ceiling is HOST-scoped by default, so this reads the
 *  live claims of EVERY project and names the holder of each slot — without that,
 *  a refusal caused by another project's work is unreadable from this board
 *  ("my queue is stalled and nothing of mine is running"). */
function readCapacity(
  projectKey: string | null,
  policy: BoardPolicy,
  labelByProjectKey: Map<string, string>,
  degraded: string[],
): QueueCapacity {
  const scoped =
    policy.capacityScope === "host"
      ? tolerantRead(
          () => db().prepare(`SELECT ${CLAIM_BOARD_COLUMNS} FROM queue_claims WHERE state = 'live'`).all() as ClaimDbRow[],
          [],
          "queue_claims",
          degraded,
        )
      : projectKey
        ? tolerantRead(
            () =>
              db()
                .prepare(`SELECT ${CLAIM_BOARD_COLUMNS} FROM queue_claims WHERE project_key = ? AND state = 'live'`)
                .all(projectKey) as ClaimDbRow[],
            [],
            "queue_claims",
            degraded,
          )
        : [];

  const holders: QueueCapacityHolder[] = scoped.map((row) => ({
    claimId: row.id,
    projectKey: row.project_key,
    projectLabel: labelByProjectKey.get(row.project_key) ?? null,
    ticketId: row.ticket_id,
    owner: row.owner,
    launchId: row.launch_id,
    runId: row.run_id,
    thisProject: row.project_key === projectKey,
  }));

  // REPORTED, NEVER COUNTED. A separate query over the task record, deliberately
  // not joined to the claim ledger and deliberately not subtracted from the
  // ceiling: the only count that bounds admission is the one taken inside
  // claimNextEligible's write transaction, and it counts claims.
  const activeTasks = tolerantRead(
    () =>
      (db()
        .prepare(
          `SELECT COUNT(*) AS n FROM tasks WHERE status NOT IN (${TERMINAL_TASK_STATUSES.map(() => "?").join(", ")})`,
        )
        .get(...TERMINAL_TASK_STATUSES) as { n: number }).n,
    0,
    "tasks",
    degraded,
  );

  const refusal = projectKey ? readLatestCapacityRefusal(projectKey, degraded) : null;

  return {
    scope: policy.capacityScope,
    limit: policy.maxActiveRuns,
    queueOwnedActive: holders.length,
    holders,
    otherProjectHolders: holders.filter((h) => !h.thisProject).length,
    notCounted: {
      activeTasks,
      policy:
        "The ceiling is a hard bound on QUEUE-OWNED concurrent runs only, counted as live queue_claims " +
        "rows inside claimNextEligible's write transaction. Operator-initiated runs (`forge new`, " +
        "`forge invoke`), campaign items and review loops carry no claim row, are structurally invisible " +
        "to that count, and are reported here beside the ceiling rather than subtracted from it — a " +
        "dispatcher-side subtraction would read as a guarantee and be a guess.",
    },
    lastRefusal: refusal
      ? {
          evaluatedAt: refusal.evaluatedAt,
          scope: refusal.capacityScope,
          limit: refusal.capacityLimit,
          used: refusal.capacityUsed,
          holders: (refusal.capacityHolders ?? []).map((h) => ({
            claimId: h.claimId,
            projectKey: h.projectKey,
            projectLabel: labelByProjectKey.get(h.projectKey) ?? null,
            ticketId: h.ticketId,
            owner: h.owner,
            launchId: h.launchId ?? null,
            runId: h.runId ?? null,
            thisProject: h.projectKey === projectKey,
          })),
        }
      : null,
  };
}

/** THE PANEL, and the six distinguishable no-run answers.
 *
 *  A DEAD OR STALE DISPATCHER OUTRANKS THE LAST EVALUATION. An expired lease means
 *  nobody is looking at this queue at all, and the most recent evaluation — however
 *  reasonable it reads — describes a pass that happened before the owner stopped.
 *  Reporting "no eligible work" in that state is exactly how a correct-looking board
 *  hides a dead controller. */
function dispatcherPanel(
  policy: BoardPolicy,
  lease: BoardLease | null,
  evaluation: BoardEvaluation | null,
  pendingWakes: number,
  nowMs: number,
): DispatcherPanel {
  const leaseLive = lease !== null && lease.leaseExpiresAtMs >= nowMs;
  const leaseExpired = lease !== null && lease.leaseExpiresAtMs < nowMs;
  const msSinceHeartbeatMs = lease ? nowMs - lease.heartbeatAtMs : null;

  let state: DispatcherPanelState;
  let stateDetail: string;
  if (!policy.armed) {
    state = "disarmed";
    stateDetail =
      "autonomous dispatch is disarmed. Existing claims keep running and keep being heartbeated — " +
      "disarming is an admission test consulted before claiming, never a reaper.";
  } else if (lease === null) {
    state = "no_dispatcher";
    stateDetail =
      "dispatch is armed but no dispatcher holds a lease on this project — nothing is looking at this " +
      "queue. Start one with `forge queue dispatcher run`.";
  } else if (leaseExpired) {
    state = "stale_dispatcher";
    stateDetail =
      `the dispatcher lease held by ${lease.owner} expired ${formatMs(nowMs - lease.leaseExpiresAtMs)} ago ` +
      `(last heartbeat ${formatMs(msSinceHeartbeatMs ?? 0)} ago). A successor may take it over; until one ` +
      `does, nothing is evaluating this queue.`;
  } else if (!evaluation) {
    state = "not_evaluated";
    stateDetail = `${lease.owner} holds the lease but has recorded no evaluation yet.`;
  } else {
    switch (evaluation.reason) {
      case "granted":
        state = "dispatching";
        stateDetail = `last pass claimed ${evaluation.claimedTicketId ?? "a ticket"} at ${evaluation.evaluatedAt}.`;
        break;
      case "no_capacity":
        state = "no_capacity";
        stateDetail =
          `the ceiling was full at ${evaluation.evaluatedAt} — ${evaluation.capacityUsed ?? "?"}/` +
          `${evaluation.capacityLimit ?? policy.maxActiveRuns} live claims in ${evaluation.capacityScope ?? policy.capacityScope} scope` +
          (evaluation.capacityHolders && evaluation.capacityHolders.length > 0
            ? `, held by ${evaluation.capacityHolders.map((h) => `${h.ticketId} (${h.projectKey})`).join(", ")}.`
            : ".");
        break;
      case "incompatible_only":
        state = "incompatible_only";
        stateDetail =
          `every otherwise-eligible candidate was temporarily incompatible with the active set at ` +
          `${evaluation.evaluatedAt}. This is a scheduling wait and self-clears — the items stay queued.`;
        break;
      case "lost":
        state = "lost";
        stateDetail =
          `a claim attempt lost its re-validation at ${evaluation.evaluatedAt} — a concurrent dispatcher ` +
          `won, or a durable fact moved under the scan. Nothing was written.`;
        break;
      case "disabled":
        // The policy row says armed and the last recorded pass says disabled: the
        // pass predates the arm. Reported as the honest ordering, not as a state.
        state = "not_evaluated";
        stateDetail = `the last recorded pass (${evaluation.evaluatedAt}) ran while dispatch was disarmed; no pass has been recorded since it was armed.`;
        break;
      default:
        state = "no_eligible_work";
        stateDetail =
          `the last pass at ${evaluation.evaluatedAt} selected nothing: no queue member was ranked, ` +
          `active, unblocked, ready and unclaimed.`;
        break;
    }
  }

  return {
    armed: policy.armed,
    configured: policy.configured,
    maxActiveRuns: policy.maxActiveRuns,
    capacityScope: policy.capacityScope,
    leaseTtlMs: policy.leaseTtlMs,
    heartbeatMs: policy.heartbeatMs,
    defaultWorkflow: policy.defaultWorkflow,
    updatedAt: policy.updatedAt,
    updatedBy: policy.updatedBy,
    lease,
    leaseLive,
    leaseExpired,
    msSinceHeartbeatMs,
    lastEvaluation: evaluation
      ? {
          reason: evaluation.reason,
          detail: evaluation.detail,
          evaluatedAt: evaluation.evaluatedAt,
          evaluatedAtMs: evaluation.evaluatedAtMs,
          wakeKind: evaluation.wakeKind,
          claimedTicketId: evaluation.claimedTicketId,
          capacityScope: evaluation.capacityScope,
          capacityLimit: evaluation.capacityLimit,
          capacityUsed: evaluation.capacityUsed,
          scannedCount: evaluation.scanEvidence?.length ?? null,
        }
      : null,
    nextWatchdogAtMs: evaluation?.nextWatchdogAtMs ?? null,
    pendingWakes,
    state,
    stateDetail,
    controlSurface: "cli-only",
  };
}

function formatMs(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m`;
  return `${Math.round(minutes / 60)}h`;
}

// ─── FG-576 step 11 — INTERACTIVE ORCHESTRATORS, AND THE ONE CREDENTIAL ──────
//
// An interactive orchestrator has TWO records and they answer DIFFERENT questions:
//
//   the RECEIPT   (orchestrator_receipts)  what was SELECTED, and that a spawn was
//                                          CONFIRMED at the moment it was written.
//   the LIVENESS  (~/.forge/orchestrators) whether the owning launcher is alive NOW,
//                 record                   by process identity (pid + start fence).
//
// A surface may say RUNNING only where both agree. The receipt's own `running`
// column is a claim about a past moment, and `forge claude` marks its task complete
// only inside the child-exit handler — so a SIGKILL or a lost terminal leaves an
// "active" row forever. That is the phantom-orchestrator class AC7 closes, and it
// has to be closed on the SURFACE PROJECTION, not merely in the record file.
//
// `projectOrchestratorLiveness` below is the dashboard's copy of the decision
// `forge show` renders (src/cli/commands/show.ts, projectOrchestratorReceipt).
// Copied deliberately rather than imported: importing a CLI command module into the
// dashboard's serving path drags the whole command graph — including the WRITABLE
// store handle, whose open execs SCHEMA_SQL and every migration, which is exactly
// the mutation-from-a-read the dashboard's readonly handle exists to prevent.
// fg576-orchestrator-liveness.test.ts pins the two implementations against each
// other over the full receipt × liveness matrix, so "copied" cannot become
// "drifted": the dashboard and the CLI cannot disagree about whether an
// orchestrator is live.
//
// ─── THE REMOTE-CONTROL URL IS A LIVE CONTROL CREDENTIAL (FG-448, D13) ───────
//
// Anyone holding https://claude.ai/code/session_… can drive that session. This
// dashboard has NO AUTHENTICATION and an env-overridable bind address. So the URL:
//
//   * is served ONLY from the project-scoped read (`scopedOrchestratorView`), never
//     from the cross-project projection — `projectsForDashboard()` / `listProjects()`
//     assemble one payload spanning every project on the host, and a credential for
//     project A must never ride in a payload built for project B. That is why there
//     is no `url` anywhere on `OrchestratorEntry`: the prohibition is structural,
//     not a rule someone has to remember;
//   * is withheld entirely off a loopback bind, with NO opt-in — the write surface's
//     FORGE_DASHBOARD_ALLOW_REMOTE_MUTATIONS escape hatch is deliberately not read
//     here (D13). Reordering a queue behind the operator's own auth is a judgement
//     they get to make; handing a network peer control of a live session is not;
//   * is attached only where THIS HOST can prove the session is still live, so an
//     ended or crashed session yields nothing — never a stale credential;
//   * is never masked client-side. Masking is not a control. The value is ABSENT
//     from the JSON payload, so there is nothing to un-hide.

/** What a SURFACE may say about a receipt. Deliberately NOT the receipt's own state
 *  vocabulary: `running` here is a joined claim about the world, while the receipt's
 *  `running` is a claim about the moment it was written. */
export type OrchestratorPresentation =
  | "running"
  | "orphaned"
  | "unverified"
  | "pending"
  | "exited"
  | "spawn_failed"
  | "unrecognized";

export type OrchestratorLiveness = {
  presentation: OrchestratorPresentation;
  /** True ONLY when the owning launcher is provably alive by process identity. */
  running: boolean;
  /** The receipt's own state, verbatim. */
  recordedState: string;
  processLiveness: ProcessLiveness;
  interaction: InteractionState;
  /** AC7: never `healthy` without POSITIVE interaction evidence. */
  health: SessionHealth;
  livenessRecord: boolean;
  livenessSources: RecordSource[];
  interactionLastSeen: string | null;
};

/** Join a receipt to its launcher-owned liveness record. PURE — the caller supplies
 *  the session — so the whole matrix is testable without a filesystem, and so this
 *  can be asserted identical to `forge show`'s projection. */
export function projectOrchestratorLiveness(
  receipt: OrchestratorReceipt,
  session: OrchestratorSession | undefined,
): OrchestratorLiveness {
  const processLiveness: ProcessLiveness = session?.processLiveness ?? "unknown";
  const base = {
    // The stored bytes, so the surface reports what the receipt itself records even
    // once the read path has resolved it to `orphaned` on a dead launcher fence.
    recordedState: receipt.recordedState,
    processLiveness,
    interaction: (session?.interaction ?? "unknown") as InteractionState,
    // AC7: with no record at all there is no interaction evidence either, so the
    // health claim is `unknown`. Nothing on this path can produce `healthy`.
    health: (session?.health ?? "unknown") as SessionHealth,
    livenessRecord: session !== undefined,
    livenessSources: session?.sources ?? [],
    interactionLastSeen: session?.interactionLastSeen ?? null,
  };

  // A state this binary does not understand is reported verbatim, never
  // reinterpreted as one it knows — and never as running.
  if (!receipt.stateRecognized) return { ...base, presentation: "unrecognized", running: false };

  if (!receipt.claimsRunning) {
    const presentation: OrchestratorPresentation =
      receipt.state === "pending" ? "pending"
      : receipt.state === "spawn_failed" ? "spawn_failed"
      // D17: `orphaned` asserts LAUNCHER LOSS ONLY — never "the session exited".
      : receipt.state === "orphaned" ? "orphaned"
      : "exited";
    return { ...base, presentation, running: false };
  }

  // The receipt CLAIMS a confirmed spawn. Only the process fence decides whether
  // anything is behind it now.
  if (processLiveness === "alive") return { ...base, presentation: "running", running: true };
  if (processLiveness === "dead") return { ...base, presentation: "orphaned", running: false };
  // No usable fence (another host, an OS that supplied no start token, or no
  // liveness record at all). Liveness could not be PROVEN, so it is not running.
  return { ...base, presentation: "unverified", running: false };
}

/** One interactive orchestrator, liveness-joined, with the AC11 selection fields.
 *
 *  THERE IS NO `url` MEMBER AND THERE MUST NEVER BE ONE. This type is what every
 *  projection — including cross-project ones — is allowed to carry. The credential
 *  rides on `ScopedOrchestratorEntry`, which only the project-scoped read builds. */
export type OrchestratorEntry = OrchestratorLiveness & {
  receiptId: string;
  sessionKey: string;
  projectDir: string;
  projectLabel: string | null;
  projectColor: string | null;
  checkoutName: string | null;
  // AC11: what was selected, and why.
  resolvedProfile: string | null;
  runtime: string;
  provider: string;
  model: string | null;
  authMode: string | null;
  adapter: string;
  resolvedBy: string | null;
  sessionOperation: string;
  sessionTarget: string | null;
  identityStrength: string;
  identityBasis: string | null;
  carrierAcceptance: string;
  carrierGeneration: string | null;
  /** AC12: recorded limitations are SHOWN, never omitted and never invented. */
  limitations: CapabilityLimitation[];
  taskId: string | null;
  startedAt: string | null;
};

/** Read receipts through the dashboard's OWN read-only handle, reusing the store
 *  module's exported column list and row decoder so the two cannot drift.
 *
 *  A store written by a peer that predates the table answers "no receipts" — the
 *  TRUE answer for it. The read-only open never migrates a store into existence
 *  (db.ts's policy), so the query names a missing table rather than creating one. */
function readOrchestratorReceipts(where: string, params: unknown[]): OrchestratorReceipt[] {
  try {
    const rows = db()
      .prepare(`SELECT ${ORCHESTRATOR_RECEIPT_COLUMNS} FROM orchestrator_receipts ${where}`)
      .all(...params) as OrchestratorReceiptRow[];
    return rows.map(rowToOrchestratorReceipt);
  } catch {
    return [];
  }
}

// The liveness read walks ~/.forge/orchestrators and probes a process identity per
// record. Both are cheap and the record count is the number of live sessions, but
// this is a POLLED surface, so it is held for a beat. Deliberately far shorter than
// PROJECT_CACHE_MS: a crashed orchestrator must stop reading as live promptly, and
// the whole point of this projection is that it goes stale honestly and fast.
const ORCHESTRATOR_LIVENESS_CACHE_MS = 1_500;
let livenessCache: { at: number; sessions: Map<string, OrchestratorSession> } | null = null;

function cachedOrchestratorSessions(): Map<string, OrchestratorSession> {
  const now = Date.now();
  if (livenessCache && now - livenessCache.at < ORCHESTRATOR_LIVENESS_CACHE_MS) return livenessCache.sessions;
  // Never gcStale: the dashboard is a READER. Deleting a launcher record here would
  // erase the very evidence that a launcher died.
  const sessions = new Map(loadHeartbeats().map((session) => [session.sessionId, session] as const));
  livenessCache = { at: now, sessions };
  return sessions;
}

export type OrchestratorReadOptions = {
  /** Injected by tests so the receipt × liveness matrix can be exercised without
   *  a real ~/.forge/orchestrators. Production always reads the real records. */
  sessions?: Map<string, OrchestratorSession> | undefined;
};

/** The interactive orchestrators that have not reached a terminal state, joined to
 *  their liveness records. A CLOSED receipt is not here at all, which is what makes
 *  "after a receipt closes it is absent from every subsequent response" structural.
 *
 *  FG-693: the scope is decided by PROVEN identity against `project_dir_canonical`,
 *  like every other project-scoped read here — it no longer pre-canonicalizes the
 *  operator's spelling through `canonicalReceiptProjectDir` and then compares raw
 *  bytes against a column that mixed proven and unproven values. A registry- or
 *  request-supplied spelling of the same directory therefore still returns a project
 *  that has live orchestrators, and a NULL-canonical (pre-FG-693) receipt is reached
 *  through the shared retarget-proof rule rather than dropped.
 *
 *  Never carries a credential — see the type's own comment. */
export function orchestratorEntries(scope: ProjectScope, opts: OrchestratorReadOptions = {}): OrchestratorEntry[] {
  const project = scopeSql("orchestrator_receipts", "orchestrator_receipts", scope);
  const receipts = readOrchestratorReceipts(
    `WHERE state NOT IN ('exited', 'spawn_failed', 'orphaned') ${project.clause}
      ORDER BY created_at DESC, receipt_id DESC LIMIT 200`,
    project.params,
  );
  const sessions = opts.sessions ?? cachedOrchestratorSessions();
  return receipts.map((receipt) => {
    const meta = projectPresentation(receipt.projectDir);
    return {
      ...projectOrchestratorLiveness(receipt, sessions.get(receipt.sessionKey)),
      receiptId: receipt.receiptId,
      sessionKey: receipt.sessionKey,
      projectDir: receipt.projectDir,
      projectLabel: meta?.label ?? receipt.projectName ?? null,
      projectColor: meta?.color ?? null,
      checkoutName: receipt.projectDir ? basename(receipt.projectDir) : null,
      resolvedProfile: receipt.resolvedProfile,
      runtime: receipt.runtime,
      provider: receipt.provider,
      model: receipt.model,
      authMode: receipt.authMode,
      adapter: receipt.adapter,
      resolvedBy: receipt.resolvedBy,
      sessionOperation: receipt.sessionOperation,
      sessionTarget: receipt.sessionTarget,
      identityStrength: receipt.identityStrength,
      identityBasis: receipt.identityBasis,
      carrierAcceptance: receipt.carrier.acceptance,
      carrierGeneration: receipt.carrier.generation,
      limitations: receipt.limitations,
      taskId: receipt.taskId,
      startedAt: receipt.startedAt,
    };
  });
}

/** The liveness answer for each of these forge task ids, where one has an
 *  interactive orchestrator receipt bound to it. Absent from the map means NO
 *  receipt — a pre-FG-576 `forge claude` row — which is not evidence the session
 *  died, so callers must leave those rows exactly as they render today. */
export function orchestratorLivenessByTask(
  taskIds: readonly string[],
  opts: OrchestratorReadOptions = {},
): Map<string, OrchestratorLiveness> {
  const out = new Map<string, OrchestratorLiveness>();
  if (taskIds.length === 0) return out;
  const receipts = readOrchestratorReceipts(
    `WHERE task_id IN (${taskIds.map(() => "?").join(",")}) ORDER BY created_at ASC, receipt_id ASC`,
    [...taskIds],
  );
  const sessions = opts.sessions ?? cachedOrchestratorSessions();
  for (const receipt of receipts) {
    if (!receipt.taskId) continue;
    // ASC + overwrite: the NEWEST receipt for a task wins, so a relaunch under the
    // same task is judged by its current session, not its first one.
    out.set(receipt.taskId, projectOrchestratorLiveness(receipt, sessions.get(receipt.sessionKey)));
  }
  return out;
}

// ─── the credential ─────────────────────────────────────────────────────────

/** Written by the launcher (src/orchestrator/claude-session-state.ts). Matched
 *  exactly: a file that does not declare itself one of these is not read. */
const REMOTE_CONTROL_LINK_KIND = "forge-orchestrator-remote-control";

/** Same shape src/util/paths.ts's orchestratorRemoteControlDir() derives, resolved
 *  through the dashboard's OWN forgeHome() for the FG-616 reason every other path
 *  here is: a module-eval snapshot binds whichever FORGE_HOME happened to be set at
 *  import time, which for a long-running server is not necessarily its own. */
function remoteControlDir(): string {
  return join(forgeHome(), "orchestrators", "remote-control");
}

/** D13. Non-null is the REASON the credential is withheld; null means it may be
 *  served. The loopback test is `guardBindAddress`'s — one definition — but the
 *  write surface's opt-out is stripped before it is asked, because this ticket
 *  builds no opt-in for exposing a live control credential off loopback. */
export function remoteControlWithheldReason(env: NodeJS.ProcessEnv = process.env): string | null {
  const withoutMutationOptOut = { ...env };
  delete withoutMutationOptOut["FORGE_DASHBOARD_ALLOW_REMOTE_MUTATIONS"];
  if (guardBindAddress(withoutMutationOptOut) === null) return null;
  const host = env["HOST"] ?? "127.0.0.1";
  return (
    `this dashboard is bound to ${host}, not loopback. The remote-control URL is a LIVE SESSION CONTROL ` +
    `credential and this surface has no authentication, so it is never included in a response off loopback. ` +
    `There is no opt-in: bind to 127.0.0.1 to see it.`
  );
}

/**
 * The credential for ONE live orchestrator, or nothing.
 *
 * "Or nothing" covers every doubt, and each condition is POSITIVE evidence rather
 * than the absence of a problem:
 *   - the session is provably live on THIS host (the fence, not the receipt column);
 *   - the file is addressed by the receipt's own canonical session key, so it can
 *     never be an unrelated session's credential;
 *   - the file names THIS receipt and THIS project, so a leftover from a previous
 *     session on the same key is refused rather than served;
 *   - the value is a remote-control URL by the launcher's own parser, so a
 *     hand-edited file cannot put an arbitrary link into the operator's page.
 */
function remoteControlUrlFor(entry: OrchestratorEntry): string | null {
  if (!entry.running) return null;
  // The same charset the liveness namespace enforces on a session id: this becomes
  // a path segment, and `..` or a separator must never reach one.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(entry.sessionKey)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(remoteControlDir(), `${entry.sessionKey}.json`), "utf8"));
  } catch {
    // No file, an unreadable one, malformed JSON: no link and NO failure.
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (record["kind"] !== REMOTE_CONTROL_LINK_KIND) return null;
  if (record["receiptId"] !== entry.receiptId) return null;
  if (record["projectDir"] !== entry.projectDir) return null;
  const url = record["url"];
  if (typeof url !== "string" || findRemoteControlUrlInText(url) !== url) return null;
  return url;
}

/** An OrchestratorEntry that MAY carry the credential. Only `scopedOrchestratorView`
 *  produces one, and `remoteControlUrl` is absent — not null, not masked — whenever
 *  the credential is withheld. */
export type ScopedOrchestratorEntry = OrchestratorEntry & { remoteControlUrl?: string };

export type OrchestratorScopeView = {
  orchestrators: ScopedOrchestratorEntry[];
  /** AC7: only sessions whose launcher is provably alive. A crashed interactive
   *  orchestrator is listed (its receipt is evidence) but is not counted active. */
  activeCount: number;
  remoteControl: { available: boolean; withheldReason: string | null };
};

/**
 * The PROJECT-SCOPED orchestrator read — the only place a remote-control URL is
 * ever attached to a payload.
 *
 * An undefined scope answers EMPTY rather than "every project": an unscoped
 * credential read is precisely the cross-project leak FG-448 forbids, so the caller
 * has to have resolved a project first. Off loopback the rows still render (the
 * operator can still see WHAT is running and why) and every `remoteControlUrl` is
 * simply absent — no link, no error, HTTP 200.
 */
export function scopedOrchestratorView(
  scope: ProjectScope,
  env: NodeJS.ProcessEnv = process.env,
  opts: OrchestratorReadOptions = {},
): OrchestratorScopeView {
  const withheldReason = remoteControlWithheldReason(env);
  const entries = scope === undefined ? [] : orchestratorEntries(scope, opts);
  const orchestrators: ScopedOrchestratorEntry[] = entries.map((entry) => {
    if (withheldReason !== null) return entry;
    const url = remoteControlUrlFor(entry);
    return url === null ? entry : { ...entry, remoteControlUrl: url };
  });
  return {
    orchestrators,
    activeCount: orchestrators.filter((entry) => entry.running).length,
    remoteControl: { available: withheldReason === null, withheldReason },
  };
}
