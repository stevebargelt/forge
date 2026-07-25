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

import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
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
  LEGACY_BLOCKED_SOURCE,
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
};

export type ImportOptions = {
  // Injectable git runner so tests can force a specific repository evidence key
  // (e.g. two linked worktrees at different real paths sharing one evidence key).
  git?: GitRunner;
  // Fixed clock for deterministic tests.
  now?: string;
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

  let resolvedKey = "";
  let resolvedRung: 1 | 2 | 3 | 4 = 4;
  let persistToConfig = false;

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

        // The DB is a non-authoritative shadow this slice: import is
        // idempotent-ADDITIVE (every write above is an UPSERT), never destructive.
        // A ticket removed from ONE source's Markdown is deliberately NOT deleted —
        // with a single imported_from, cross-source pruning could destroy a ticket a
        // sibling linked worktree still owns. Aggressive removal reconciliation is
        // deferred to the authoritative-cutover slice; a stale row in an unread
        // shadow is harmless.

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
  };
}
