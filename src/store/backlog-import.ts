// FG-606 (FG-496 Slice A): the Markdown -> DB import orchestrator. Reads a
// project's backlog/*.md via the existing structured parser and populates the DB
// as a NON-authoritative shadow — Markdown stays the sole source of truth; nothing
// reads these rows for product behavior this slice.
//
// The registry CLAIM, the guarded config heal, and the entire
// ticket/relation/blocker_evidence/event + id-sequence import run inside ONE
// writeTransaction (BEGIN IMMEDIATE, FG-548) — the only cross-process/cross-worktree
// serialization point (the project-dir FS backlog lock cannot serialize two linked
// worktrees). A losing concurrent claimant's INSERT hits the registry's
// two-directional uniqueness, the whole transaction rolls back (zero partial
// tickets, zero partial evidence), and it retries against the now-committed winner's
// mapping.
//
// Cross-store atomicity: the guarded config write (temp+rename) lands BEFORE the
// SQLite COMMIT (holding the write lock across one short atomic replacement). A
// config refusal rolls the transaction back → nothing persisted anywhere. The only
// possible residual — process death after the rename but before COMMIT — is
// CONFIG-ONLY (inert, portable, adopted on retry). We never leave an authoritative
// DB identity with a missing config identity.

import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join, resolve as resolvePath } from "node:path";
import { parse as parseYaml } from "yaml";
import { writeTransaction } from "./db.js";
import { assertConfigWritable, readBacklogConfig, writeProjectKey } from "../backlog/config.js";
import { listMarkdownTickets, mapStatusToDb, type StructuredTicket } from "../backlog/structured.js";
import type { GitRunner } from "../util/github-url.js";
import {
  computeRepositoryEvidence,
  resolveAndClaimProjectKey,
  ProjectIdentityClaimRaceError,
} from "./project-registry.js";
import {
  upsertTicket,
  upsertTicketRelation,
  upsertTicketEvent,
  upsertBlockerEvidence,
  ensureStorageMode,
  bumpIdSequence,
  ticketsForProject,
  getTicket,
  ticketContentHash,
  upsertBacklogSource,
  liveBacklogSources,
  replaceSourceMembership,
  claimedMembers,
  allMembership,
  membershipKey,
  deleteTicketRow,
  deleteTicketRelation,
  allRelationsForProject,
  allBlockerEvidenceForProject,
  deleteBlockerEvidence,
  LEGACY_BLOCKED_SOURCE,
  type MembershipKind,
  type TicketRelation,
  type TicketRow,
} from "./tickets.js";

const MAX_CLAIM_RETRIES = 8;

// The backlog subdirectories a ticket file can live in, scanned in the same order
// listTickets uses so a duplicate id resolves to the done/ copy (done wins).
const SOURCE_DIRS = ["ideas", "epics", "stories", "done"];
const REQUIRED_FRONTMATTER = ["id", "type", "status", "title"] as const;

// A precise, file-identified import failure — the whole import is all-or-nothing
// atomic (thrown BEFORE the write transaction), so zero rows are written. Names
// the offending file and the missing field instead of surfacing an opaque
// low-level constraint error from deep inside the transaction.
export class BacklogImportError extends Error {
  constructor(
    message: string,
    readonly file: string,
    readonly field: string,
  ) {
    super(message);
    this.name = "BacklogImportError";
  }
}

export type ImportResult = {
  projectKey: string;
  ticketCount: number;
  // Which ladder rung resolved the identity — for logging/tests.
  rung: 1 | 2 | 3 | 4;
  // True when the import minted/adopted a key and healed .forge/config.yml.
  persistedConfig: boolean;
  // FG-608: the durable source identity this import scanned under.
  sourceId: string;
  // FG-608 conflict rule: ids whose DB row had been edited since its import basis
  // and were therefore LEFT AS IS (Markdown never silently clobbers a newer DB
  // edit). Each also has a conflict event in ticket_events.
  skippedConflicts: string[];
  // Ids a `--force` import overwrote despite divergence. The event carries
  // before/after evidence.
  forcedOverwrites: string[];
  // FG-608 removal reconciliation: what this import actually pruned.
  prunedTickets: string[];
  prunedRelations: string[];
  prunedBlockerEvidence: string[];
};

// FG-608: prune refused. Keeping the ticket is the correct failure direction, so
// this is thrown BEFORE any deletion and the whole import transaction rolls back.
export class RemovalReconciliationRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemovalReconciliationRefusal";
  }
}

export type ImportOptions = {
  // Injectable git runner so tests can force a specific repository evidence key
  // (e.g. two linked worktrees at different real paths sharing one evidence key).
  git?: GitRunner;
  // Fixed clock for deterministic tests.
  now?: string;
  // FG-608: overwrite a DB row that diverged from its import basis. Default false —
  // the conflict rule SKIPS and records instead. A forced overwrite records
  // before/after evidence in the conflict event.
  force?: boolean;
  // FG-608: the durable source identity to scan under. Production resolves it from
  // the checkout (resolveSourceIdentity); tests pass it to model two worktrees of
  // one project without materializing two real git checkouts.
  sourceId?: string;
  // Test seam ONLY: invoked inside the transaction AFTER the registry claim and
  // BEFORE the config heal / any ticket is written, so a test can throw here and
  // prove the whole transaction rolls back atomically — zero partial tickets, zero
  // partial evidence, AND no config heal (config is written strictly after this).
  __afterClaimBeforeTickets?: () => void;
  // Test seam ONLY: invoked inside the transaction AFTER the guarded config heal
  // has persisted (temp+rename) but BEFORE the SQLite commit, so a test can throw
  // here and prove the deliberately-preferred residual: a committed project_key in
  // config with ZERO DB rows (inert, portable, adopted on retry).
  __afterConfigBeforeCommit?: () => void;
};

// The full valid source-status vocabulary. An import refuses (at the pre-write
// scan seam) any ticket whose status is outside this set rather than silently
// coercing it — see scanSourceFrontmatter and mapStatus.
const VALID_SOURCE_STATUSES = new Set<string>(["active", "done", "blocked", "deferred"]);

// FG-607: the file-status -> DB-status mapping now lives in the seam
// (backlog/structured.ts) and is SHARED with it. There are two writers into the
// tickets table; a second private copy of this mapping would drift silently.
// Legacy 'blocked' becomes 'active' (the caller separately records a
// blocker_evidence row so the blocked FACT survives the Slice C cutover).
// Exhaustive over the valid set — never coerces an unknown status to active;
// scanSourceFrontmatter rejects unrecognized statuses before any write.

// Scan the backlog source files ONCE to (a) validate required frontmatter before
// any write, and (b) capture the FULL raw frontmatter per ticket id so nothing —
// including keys the structured parser doesn't recognize — is dropped on import.
// Files without parseable frontmatter are skipped, exactly as listTickets skips
// them; a file WITH frontmatter but missing a required field is a hard,
// file-identified error (all-or-nothing atomic). Keyed by id; later dirs (done/)
// win, mirroring listTickets' dedup.
function scanSourceFrontmatter(projectDir: string): Map<string, Record<string, unknown>> {
  const base = join(projectDir, "backlog");
  const byId = new Map<string, Record<string, unknown>>();
  for (const subdir of SOURCE_DIRS) {
    const dir = join(base, subdir);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith(".md")) continue;
      const content = readFileSync(join(dir, entry), "utf8");
      if (!content.startsWith("---\n")) continue; // no frontmatter — listTickets skips it too
      const end = content.indexOf("\n---\n", 4);
      if (end === -1) continue; // unterminated frontmatter — skipped by listTickets
      let fm: Record<string, unknown>;
      try {
        fm = (parseYaml(content.slice(4, end)) as Record<string, unknown> | null) ?? {};
      } catch {
        continue; // unparseable YAML — skipped by listTickets
      }
      const relPath = `backlog/${subdir}/${entry}`;
      for (const field of REQUIRED_FRONTMATTER) {
        const v = fm[field];
        if (v === undefined || v === null || (typeof v === "string" && v.trim() === "")) {
          throw new BacklogImportError(
            `forge: refusing import — backlog file '${relPath}' is missing required frontmatter ` +
              `field '${field}'. Every ticket needs id, type, status, and title. Fix the file and ` +
              `re-import (no tickets were written).`,
            relPath,
            field,
          );
        }
      }
      // Fail closed on an unrecognized status rather than silently coercing it to
      // active (which would erase the real source state). Same all-or-nothing
      // atomic contract as the missing-field refusal above — zero rows written.
      const status = String(fm["status"]);
      if (!VALID_SOURCE_STATUSES.has(status)) {
        throw new BacklogImportError(
          `forge: refusing import — ticket ${String(fm["id"])} (backlog file '${relPath}') has ` +
            `unrecognized status '${status}' — expected active/done/deferred/blocked. Fix the file ` +
            `and re-import (no tickets were written).`,
          relPath,
          "status",
        );
      }
      byId.set(String(fm["id"]), fm);
    }
  }
  return byId;
}

// The full raw frontmatter preserved as JSON so nothing the Markdown carries is
// lost on import. Falls back to the structured fields when a raw capture is
// unavailable (should not happen for a well-formed file).
function frontmatterOf(t: StructuredTicket, raw: Record<string, unknown> | undefined): Record<string, unknown> {
  if (raw) return raw;
  const { body: _body, ...fm } = t;
  return fm;
}

function parsePrefixSeq(ticketId: string): { prefix: string; seq: number } | undefined {
  const m = ticketId.match(/^([A-Za-z]+)-(\d+)$/);
  if (!m) return undefined;
  return { prefix: m[1]!, seq: parseInt(m[2]!, 10) };
}

// FG-607: the ONE definition of "the lowest next_seq that cannot collide", shared
// by both writers of ticket_id_sequence — this import (which SEEDS it) and
// `forge backlog mode --set db` (which GUARDS it). While they scanned
// independently they drifted: import seeded from one checkout's backlog/ at one
// moment, the flip only checked that a row existed, and every id filed in
// markdown mode in between got minted a second time.
//
// It observes both stores BY ID, never by directory: `markdownIds` is what the
// caller's checkout can see right now, `dbIds` is what the project's DB holds.
// It cannot see a sibling worktree's branch content — a caller that needs
// CURRENCY must fail closed on what it could not observe (see setBacklogMode).
export function requiredNextSeq(
  markdownIds: string[],
  dbIds: string[],
  configuredPrefix: string,
): Map<string, number> {
  // The configured prefix carries a floor of 1: a project with nothing in either
  // store still needs an allocatable sequence, and import is its bootstrap.
  const required = new Map<string, number>([[configuredPrefix, 1]]);
  for (const id of [...markdownIds, ...dbIds]) {
    const parsed = parsePrefixSeq(id);
    if (!parsed) continue;
    required.set(parsed.prefix, Math.max(required.get(parsed.prefix) ?? 0, parsed.seq + 1));
  }
  return required;
}

// ─── FG-608: DURABLE SOURCE IDENTITY (accepted default (b)) ──────────────────
//
// A "source" is one physical checkout that can supply Markdown for a project_key.
// Removal reconciliation prunes a ticket only when NO LIVE SOURCE claims it, so
// the identity of a source has to survive the things that move a checkout around.
//
// It is deliberately NOT the realpath. `imported_from` is realpathSync(projectDir)
// and FG-345/FG-621 transient clones live under ~/.forge/worktrees/** and are
// reaper-deleted, so a path-derived id both COLLIDES (two clones of one repo at
// two paths are two sources, but a git-dir-derived id would call them one) and
// EVAPORATES (a moved or reaped checkout looks like a brand-new source, and its
// old membership pins every ticket forever).
//
// Instead: mint a random id ONCE per physical checkout and persist it inside that
// checkout's own git ADMIN directory (`git rev-parse --absolute-git-dir`) —
//   * never git-tracked (it is inside .git, not the worktree), so it cannot dirty
//     `git status` and cannot be copied between repos by a commit;
//   * moves WITH the checkout, so a relocated repo keeps its identity;
//   * dies with the checkout, so a reaped clone's file is gone (its membership is
//     released by the operator `forge backlog forget-source` verb);
//   * distinct per linked worktree, because a linked worktree's absolute git dir
//     is <repo>/.git/worktrees/<name>, not the common dir.
//
// A non-git directory has no admin dir to hide the file in; fall back to the
// realpath, which for a non-repo directory is as durable as anything available.
const SOURCE_ID_FILE = "forge-source-id";

export function resolveSourceIdentity(projectDir: string): string {
  const canonicalDir = realpathSync(resolvePath(projectDir));
  let gitDir = "";
  try {
    const out = execFileSync("git", ["rev-parse", "--absolute-git-dir", "--show-toplevel"], {
      cwd: projectDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const [absoluteGitDir, topLevel] = out.split("\n");
    // Only adopt the git identity when THIS directory is the checkout root. A
    // directory that merely sits INSIDE some enclosing repository is not that
    // repository's backlog source — treating it as one would give two unrelated
    // project directories a single source identity and let one's removals prune
    // the other's tickets.
    if (absoluteGitDir && topLevel && realpathSync(topLevel) === canonicalDir) {
      gitDir = absoluteGitDir;
    }
  } catch {
    gitDir = "";
  }
  if (!gitDir) return `path:${canonicalDir}`;
  const idPath = join(gitDir, SOURCE_ID_FILE);
  if (existsSync(idPath)) {
    const existing = readFileSync(idPath, "utf8").trim();
    if (existing) return existing;
  }
  const minted = `src-${randomBytes(12).toString("hex")}`;
  try {
    writeFileSync(idPath, minted + "\n");
  } catch {
    // A read-only or otherwise unwritable admin dir (a red agent's :ro mount)
    // cannot persist an identity. Fall back to the canonical path rather than
    // minting a fresh random id on every call — an id that changed per invocation
    // would register a new "source" each time and pin every ticket forever.
    return `path:${canonicalDir}`;
  }
  return minted;
}

// The relation/blocker membership member_key encodings. Kept in ONE place so the
// record side and the prune side cannot disagree about what a member is.
function relationMemberKey(relatedId: string, relType: string): string {
  return `${relatedId} ${relType}`;
}

type MembershipSnapshot = { ticketId: string; memberKey: string }[];

// FG-608 REMOVAL RECONCILIATION.
//
// Prune authority belongs to the SET OF LIVE SOURCES, not to the checkout running
// the import. This import may add its OWN membership and remove its OWN
// membership; a row leaves the product tables only when NO live source claims it.
// Absence of a source is NOT evidence of absence of a ticket.
//
// FAIL-CLOSED, three ways:
//   1. Zero live sources -> REFUSE outright. With nothing claiming anything, every
//      row looks prunable, and "delete the whole project's backlog" is never the
//      right reading of "I could not observe any source".
//   2. Only members SOME source has been recorded as holding are candidates. A row
//      no membership has ever mentioned (a pre-FG-608 row, imported before this
//      substrate existed) is NEVER pruned — we cannot know which sources hold it,
//      and keeping it is the correct failure direction.
//   3. A member any OTHER live source still claims is kept, even though this
//      source dropped it. That is the multi-worktree case, stated directly.
// Exported so the fail-closed guard can be exercised DIRECTLY. The zero-live-
// sources condition is unreachable through importBacklog (an import registers its
// own source before reconciling), so a test that drove it through the CLI would be
// asserting a re-implementation of the guard rather than the guard. This is the
// product function; the test calls it.
export function reconcileRemovals(
  projectKey: string,
  sourceId: string,
  // The prune CANDIDATE set, snapshotted before this import replaced its own
  // membership. Never derived inside this function: by the time it runs, the
  // evidence that a member was ever claimed has already been overwritten.
  previous: Record<MembershipKind, MembershipSnapshot>,
): { prunedTickets: string[]; prunedRelations: string[]; prunedBlockerEvidence: string[] } {
  const live = liveBacklogSources(projectKey);
  if (live.length === 0) {
    throw new RemovalReconciliationRefusal(
      `forge: refusing removal reconciliation for project_key '${projectKey}' — no live backlog source ` +
        `is registered, so nothing can be shown to have been removed rather than merely unobserved. ` +
        `Keeping every ticket is the safe direction. (Nothing was deleted.)`,
    );
  }

  const stillClaimed = {
    ticket: claimedMembers(projectKey, "ticket"),
    relation: claimedMembers(projectKey, "relation"),
    blocker_evidence: claimedMembers(projectKey, "blocker_evidence"),
  };

  // Relations and blocker evidence FIRST: pruning a ticket cascades them away, and
  // reporting a relation as "pruned" that actually vanished with its ticket would
  // overstate what this reconciliation decided.
  const prunedRelations: string[] = [];
  const existingRelations = new Set(
    allRelationsForProject(projectKey).map((r) => membershipKey(r.ticketId, relationMemberKey(r.relatedId, r.relType))),
  );
  for (const m of previous.relation) {
    const key = membershipKey(m.ticketId, m.memberKey);
    if (stillClaimed.relation.has(key)) continue;
    if (!existingRelations.has(key)) continue;
    const [relatedId, relType] = m.memberKey.split(" ");
    if (!relatedId || !relType) continue;
    deleteTicketRelation(projectKey, m.ticketId, relatedId, relType);
    prunedRelations.push(`${m.ticketId}->${relatedId}(${relType})`);
  }

  // The blocker_evidence INVERSE DELETION the ticket calls out by name. Import
  // upserts evidence for a `blocked` source ticket but had no deletion when a
  // later import supplied active/done/deferred — so structured.ts reconstructed
  // the row as blocked forever and readiness.ts held it back from dispatch. With
  // per-source membership the inverse is decidable AND multi-worktree-safe:
  // evidence recorded from one source is not dropped because a sibling worktree's
  // Markdown lacks the blocked marker.
  const prunedBlockerEvidence: string[] = [];
  const existingEvidence = new Set(
    allBlockerEvidenceForProject(projectKey).map((b) => membershipKey(b.ticketId, b.source)),
  );
  for (const m of previous.blocker_evidence) {
    const key = membershipKey(m.ticketId, m.memberKey);
    if (stillClaimed.blocker_evidence.has(key)) continue;
    if (!existingEvidence.has(key)) continue;
    deleteBlockerEvidence(projectKey, m.ticketId, m.memberKey);
    prunedBlockerEvidence.push(`${m.ticketId}(${m.memberKey})`);
  }

  const prunedTickets: string[] = [];
  const existingTickets = new Set(ticketsForProject(projectKey).map((t) => t.ticketId));
  for (const m of previous.ticket) {
    const key = membershipKey(m.ticketId, m.memberKey);
    if (stillClaimed.ticket.has(key)) continue;
    if (!existingTickets.has(m.ticketId)) continue;
    deleteTicketRow(projectKey, m.ticketId);
    prunedTickets.push(m.ticketId);
  }

  return { prunedTickets, prunedRelations, prunedBlockerEvidence };
}

// FG-608 IMPORT CONFLICT RULE.
//
// "The DB row was edited since its import basis" is decided by the CONTENT basis,
// not the counter: upsertTicket (import) sets body_hash == import_basis_hash;
// upsertSeamTicket (a db-mode edit) moves body_hash and leaves import_basis_hash
// alone. So body_hash != import_basis_hash means, exactly, "edited since import".
//
// Three cases that are NOT conflicts, each for a stated reason:
//   * no existing row                  — nothing to clobber.
//   * body_hash IS NULL                — a pre-FG-608 row that predates the basis
//                                        columns. It carries no evidence either
//                                        way, so treat the import as the basis
//                                        and backfill rather than jam every
//                                        migrated project on its next import.
//   * incoming content == current row  — Markdown already agrees with the DB edit.
//                                        Writing is a no-op, so there is nothing
//                                        for Markdown to clobber.
//
// import_basis_hash NULL with body_hash SET *is* a conflict: that row was created
// by the seam and never imported, so an incoming Markdown file with the same id is
// a genuine collision, not a re-import.
function detectImportConflict(
  existing: TicketRow | undefined,
  incomingHash: string,
): { conflict: boolean; reason: string } {
  if (!existing) return { conflict: false, reason: "new" };
  if (existing.bodyHash == null) return { conflict: false, reason: "pre-basis row" };
  if (existing.bodyHash === incomingHash) return { conflict: false, reason: "content already agrees" };
  if (existing.importBasisHash == null) {
    return { conflict: true, reason: "row was created in the DB and never imported" };
  }
  if (existing.bodyHash !== existing.importBasisHash) {
    return { conflict: true, reason: "row was edited in the DB since its import basis" };
  }
  return { conflict: false, reason: "row is unchanged since its import basis" };
}

// Populate the DB shadow from a project's backlog/*.md. Idempotent: re-running
// UPSERTs and yields no duplicate rows / no drift. REFUSES (throws
// ProjectIdentityConflictError) rather than silently maintaining two backlogs
// when identities conflict.
export function importBacklog(projectDir: string, opts: ImportOptions = {}): ImportResult {
  // Validate + capture raw frontmatter BEFORE the transaction: a malformed file
  // aborts the whole atomic import with a precise, file-identified error and
  // writes zero rows.
  const rawFrontmatter = scanSourceFrontmatter(projectDir);
  // Always the MARKDOWN reader: import is a migration from the filesystem, so it
  // must not follow a project that has already flipped to db mode.
  const tickets = listMarkdownTickets(projectDir); // FS read, outside the write transaction
  // Canonical source dir (realpath), recorded as provenance on each ticket row.
  // Harmless metadata this slice — no longer drives any deletion.
  const importedFrom = realpathSync(projectDir);
  const evidence = computeRepositoryEvidence(projectDir, opts.git);
  const config = readBacklogConfig(projectDir);
  const now = opts.now ?? new Date().toISOString();

  // When config lacks a key we WILL heal it (ladder rungs 2/4) with a guarded
  // atomic write inside the transaction. Pre-flight that guarded path NOW, before
  // any mutation: a symlink/containment refusal must abort BEFORE we claim a
  // registry identity — so a config refusal can never strand an authoritative DB
  // identity with no durable config identity. (The guard is re-checked at write
  // time for TOCTOU; here it fails closed with zero side effects.)
  if (config.projectKey == null) {
    assertConfigWritable(projectDir);
  }

  // FG-608: the durable source identity this scan is attributed to. Resolved
  // OUTSIDE the transaction (it can mint a file inside the checkout's git admin
  // dir) so no filesystem write happens under the write lock.
  const sourceId = opts.sourceId ?? resolveSourceIdentity(projectDir);

  let resolvedKey = "";
  let resolvedRung: 1 | 2 | 3 | 4 = 4;
  let persistToConfig = false;
  let skippedConflicts: string[] = [];
  let forcedOverwrites: string[] = [];
  let prunedTickets: string[] = [];
  let prunedRelations: string[] = [];
  let prunedBlockerEvidence: string[] = [];

  for (let attempt = 0; ; attempt++) {
    try {
      writeTransaction(() => {
        const resolved = resolveAndClaimProjectKey({
          evidenceKey: evidence.key,
          evidenceSource: evidence.source,
          configKey: config.projectKey,
          createdAt: now,
        });
        resolvedKey = resolved.projectKey;
        resolvedRung = resolved.rung;
        persistToConfig = resolved.persistToConfig;

        // Test seam: force a failure between the claim and the config heal to prove
        // the whole transaction (registry + config + tickets) rolls back atomically.
        opts.__afterClaimBeforeTickets?.();

        // Guarded, ATOMIC config heal BEFORE the ticket writes and BEFORE the commit
        // (rungs 2/4 only). Its symlink/containment refusal THROWS here → the whole
        // transaction rolls back → zero DB changes. If instead the process dies AFTER
        // this rename but before COMMIT, the residual is CONFIG-ONLY (inert, portable,
        // safely re-claimed on retry) — the deliberately-preferred direction. We never
        // leave an authoritative DB identity with a missing config identity.
        if (resolved.persistToConfig) {
          writeProjectKey(projectDir, resolved.projectKey);
        }

        // Test seam: force a failure after the config heal but before the commit to
        // prove the preferred config-only residual.
        opts.__afterConfigBeforeCommit?.();

        ensureStorageMode(resolved.projectKey, now);

        skippedConflicts = [];
        forcedOverwrites = [];

        // FG-608: snapshot the prune CANDIDATE set BEFORE this source's membership
        // is replaced. Candidates are everything ANY source (live or forgotten) has
        // ever been recorded as holding — see allMembership for why "what THIS
        // source used to claim" is too narrow across imports.
        const previous = {
          ticket: allMembership(resolved.projectKey, "ticket"),
          relation: allMembership(resolved.projectKey, "relation"),
          blocker_evidence: allMembership(resolved.projectKey, "blocker_evidence"),
        };

        upsertBacklogSource(resolved.projectKey, sourceId, importedFrom, now);

        const ticketMembers: MembershipSnapshot = [];
        const relationMembers: MembershipSnapshot = [];
        const evidenceMembers: MembershipSnapshot = [];

        for (const t of tickets) {
          const dbStatus = mapStatusToDb(t.status);
          const row: TicketRow = {
            projectKey: resolved.projectKey,
            ticketId: t.id,
            type: t.type,
            status: dbStatus,
            title: t.title,
            body: t.body,
            created: t.created ?? null,
            closed: t.closed ?? null,
            closedCommit: t.closedCommit ?? null,
            epic: t.epic ?? null,
            frontmatter: frontmatterOf(t, rawFrontmatter.get(t.id)),
            importedAt: now,
            importedFrom,
          };

          // MEMBERSHIP is recorded for every ticket this source's Markdown carries,
          // conflict or not: the source genuinely claims the id, and dropping the
          // claim on a conflict would make a skipped ticket look prunable.
          ticketMembers.push({ ticketId: t.id, memberKey: "" });
          for (const related of t.related ?? []) {
            relationMembers.push({ ticketId: t.id, memberKey: relationMemberKey(related, "related") });
          }
          if (t.status === "blocked") {
            evidenceMembers.push({ ticketId: t.id, memberKey: LEGACY_BLOCKED_SOURCE });
          }

          const existing = getTicket(resolved.projectKey, t.id);
          const incomingHash = ticketContentHash({
            type: row.type,
            status: row.status,
            title: row.title,
            body: row.body,
            created: row.created,
            closed: row.closed,
            closedCommit: row.closedCommit,
            epic: row.epic,
          });
          const conflict = detectImportConflict(existing, incomingHash);

          if (conflict.conflict && !opts.force) {
            // SKIP + record. Markdown never silently clobbers a newer DB edit.
            // Deliberately NOT an abort: one diverged ticket must not block the
            // import of the other 400.
            skippedConflicts.push(t.id);
            upsertTicketEvent({
              eventKey: `import-conflict:${resolved.projectKey}:${t.id}:${incomingHash.slice(0, 16)}`,
              projectKey: resolved.projectKey,
              ticketId: t.id,
              eventType: "import_conflict",
              payload: {
                resolution: "skipped",
                reason: conflict.reason,
                sourceId,
                importedFrom,
                dbRevision: existing?.revision ?? null,
                dbBodyHash: existing?.bodyHash ?? null,
                dbImportBasisHash: existing?.importBasisHash ?? null,
                markdownBodyHash: incomingHash,
              },
              createdAt: now,
            });
            continue;
          }

          if (conflict.conflict) {
            // --force, explicitly supplied. Record BEFORE/AFTER evidence: a forced
            // overwrite destroys a db edit, so the event has to carry enough to
            // reconstruct what was lost, not merely note that it happened.
            forcedOverwrites.push(t.id);
            upsertTicketEvent({
              eventKey: `import-conflict:${resolved.projectKey}:${t.id}:${incomingHash.slice(0, 16)}`,
              projectKey: resolved.projectKey,
              ticketId: t.id,
              eventType: "import_conflict",
              payload: {
                resolution: "forced",
                reason: conflict.reason,
                sourceId,
                importedFrom,
                before: existing
                  ? {
                      revision: existing.revision ?? null,
                      bodyHash: existing.bodyHash ?? null,
                      importBasisHash: existing.importBasisHash ?? null,
                      type: existing.type,
                      status: existing.status,
                      title: existing.title,
                      body: existing.body,
                    }
                  : null,
                after: {
                  bodyHash: incomingHash,
                  type: row.type,
                  status: row.status,
                  title: row.title,
                  body: row.body,
                },
              },
              createdAt: now,
            });
          }

          upsertTicket(row);

          // Deterministic "imported" event key -> idempotent re-import.
          upsertTicketEvent({
            eventKey: `import:${resolved.projectKey}:${t.id}`,
            projectKey: resolved.projectKey,
            ticketId: t.id,
            eventType: "imported",
            payload: { fileStatus: t.status },
            createdAt: now,
          });

          for (const related of t.related ?? []) {
            const relation: TicketRelation = {
              projectKey: resolved.projectKey,
              ticketId: t.id,
              relatedId: related,
              relType: "related",
            };
            upsertTicketRelation(relation);
          }

          // Legacy blocked -> active + a durable blocker_evidence row (never a
          // plain active ticket). Natural-key idempotent.
          if (t.status === "blocked") {
            upsertBlockerEvidence({
              projectKey: resolved.projectKey,
              ticketId: t.id,
              reason: "imported from legacy Markdown status: blocked",
              source: LEGACY_BLOCKED_SOURCE,
              createdAt: now,
            });
          }
        }

        // This source's membership is now exactly what its Markdown carries.
        replaceSourceMembership(resolved.projectKey, sourceId, "ticket", ticketMembers, now);
        replaceSourceMembership(resolved.projectKey, sourceId, "relation", relationMembers, now);
        replaceSourceMembership(resolved.projectKey, sourceId, "blocker_evidence", evidenceMembers, now);

        // FG-608 (inherited from FG-606, which deliberately deferred it here): the
        // shadow now equals the current Markdown set INCLUDING removals. Slice A's
        // import was append-only because a single `imported_from` could not tell
        // "removed from the project" from "absent from THIS worktree"; per-source
        // membership can, so the prune is finally safe — and still fails closed.
        const pruned = reconcileRemovals(resolved.projectKey, sourceId, previous);
        prunedTickets = pruned.prunedTickets;
        prunedRelations = pruned.prunedRelations;
        prunedBlockerEvidence = pruned.prunedBlockerEvidence;

        // next_seq means "the next id to allocate" (Slice B). Seed it from the
        // SAME observation `mode --set db` re-checks at the flip — this checkout's
        // Markdown ids AND the project's DB rows (which may already hold ids a
        // SIBLING checkout imported that this one's backlog/ does not carry).
        // bumpIdSequence stays monotonic, so a re-import from a subset checkout
        // never lowers the sequence. The configured prefix's floor of 1 is import's
        // bootstrap for a project with nothing in either store — `mode --set db`
        // refuses on an unseeded sequence, so without it an empty project could
        // never adopt db mode.
        for (const [prefix, next] of requiredNextSeq(
          tickets.map((t) => t.id),
          ticketsForProject(resolved.projectKey).map((t) => t.ticketId),
          config.prefix ?? "FG",
        )) {
          bumpIdSequence(resolved.projectKey, prefix, next);
        }
      });
      break;
    } catch (e) {
      if (e instanceof ProjectIdentityClaimRaceError && attempt < MAX_CLAIM_RETRIES) {
        continue; // winner's mapping is now committed; re-resolve adopts it
      }
      throw e;
    }
  }

  return {
    projectKey: resolvedKey,
    ticketCount: tickets.length,
    rung: resolvedRung,
    persistedConfig: persistToConfig,
    sourceId,
    skippedConflicts,
    forcedOverwrites,
    prunedTickets,
    prunedRelations,
    prunedBlockerEvidence,
  };
}
