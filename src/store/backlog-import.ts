// FG-606 (FG-496 Slice A): the Markdown -> DB import orchestrator. Reads a
// project's backlog/*.md via the existing structured parser and populates the DB
// as a NON-authoritative shadow — Markdown stays the sole source of truth; nothing
// reads these rows for product behavior this slice.
//
// The registry CLAIM and the entire ticket/relation/blocker_evidence/event +
// id-sequence import run inside ONE writeTransaction (BEGIN IMMEDIATE, FG-548) —
// the only cross-process/cross-worktree serialization point (the project-dir FS
// backlog lock cannot serialize two linked worktrees). A losing concurrent
// claimant's INSERT hits the registry's two-directional uniqueness, the whole
// transaction rolls back (zero partial tickets, zero partial evidence), and it
// retries against the now-committed winner's mapping.

import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { writeTransaction } from "./db.js";
import { readBacklogConfig, writeProjectKey } from "../backlog/config.js";
import { listTickets, type StructuredTicket } from "../backlog/structured.js";
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
  pruneRemovedTickets,
  reconcileRelations,
  reconcileImportedBlockerEvidence,
  type DbTicketStatus,
  type TicketRelation,
  type TicketRow,
} from "./tickets.js";

const MAX_CLAIM_RETRIES = 8;
const LEGACY_BLOCKED_SOURCE = "import-legacy-blocked";

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
  // BEFORE any ticket is written, so a test can throw here and prove the whole
  // transaction rolls back atomically (zero partial tickets, zero partial evidence).
  __afterClaimBeforeTickets?: () => void;
};

// Map the structured file status to the DB's active/done/deferred vocabulary.
// Legacy 'blocked' becomes 'active' (the caller separately records a
// blocker_evidence row so the blocked FACT survives the Slice C cutover).
function mapStatus(status: StructuredTicket["status"]): DbTicketStatus {
  switch (status) {
    case "blocked":
      return "active";
    case "done":
      return "done";
    case "deferred":
      return "deferred";
    default:
      return "active";
  }
}

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

// Populate the DB shadow from a project's backlog/*.md. Idempotent: re-running
// UPSERTs and yields no duplicate rows / no drift. REFUSES (throws
// ProjectIdentityConflictError) rather than silently maintaining two backlogs
// when identities conflict.
export function importBacklog(projectDir: string, opts: ImportOptions = {}): ImportResult {
  // Validate + capture raw frontmatter BEFORE the transaction: a malformed file
  // aborts the whole atomic import with a precise, file-identified error and
  // writes zero rows.
  const rawFrontmatter = scanSourceFrontmatter(projectDir);
  const tickets = listTickets(projectDir); // FS read, outside the write transaction
  // Canonical source dir — the reconcile provenance key. realpath so re-imports
  // from the same worktree match, and two linked worktrees resolve distinctly.
  const importedFrom = realpathSync(projectDir);
  const evidence = computeRepositoryEvidence(projectDir, opts.git);
  const config = readBacklogConfig(projectDir);
  const now = opts.now ?? new Date().toISOString();

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

        // Test seam: force a failure between the claim and the ticket writes to
        // prove atomic rollback.
        opts.__afterClaimBeforeTickets?.();

        ensureStorageMode(resolved.projectKey, now);

        const prefixMax = new Map<string, number>();
        const desiredRelations: TicketRelation[] = [];
        const blockedIds: string[] = [];
        for (const t of tickets) {
          const dbStatus = mapStatus(t.status);
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
            desiredRelations.push(relation);
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
            blockedIds.push(t.id);
          }

          const parsed = parsePrefixSeq(t.id);
          if (parsed) {
            prefixMax.set(parsed.prefix, Math.max(prefixMax.get(parsed.prefix) ?? 0, parsed.seq));
          }
        }

        // Reconcile removals/renames WITHIN this same transaction so the shadow
        // EQUALS the current Markdown set — stale tickets/relations/evidence/events
        // for ids (or `related:` entries) no longer in the source are pruned. Other
        // projects' rows are untouched.
        const keepIds = tickets.map((t) => t.id);
        pruneRemovedTickets(resolved.projectKey, importedFrom, keepIds);
        reconcileRelations(resolved.projectKey, keepIds, desiredRelations);
        reconcileImportedBlockerEvidence(
          resolved.projectKey,
          keepIds,
          blockedIds,
          LEGACY_BLOCKED_SOURCE,
        );

        // next_seq means "the next id to allocate" (Slice B), so seed it at the
        // highest existing number PLUS ONE. bumpIdSequence stays monotonic — a
        // re-import never lowers it, so removing the highest ticket never reuses id.
        for (const [prefix, seq] of prefixMax) {
          bumpIdSequence(resolved.projectKey, prefix, seq + 1);
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

  // Side effect AFTER the durable commit (never inside the transaction): heal the
  // config with the minted/adopted key so the next worktree reads a committed key.
  if (persistToConfig) {
    writeProjectKey(projectDir, resolvedKey);
  }

  return {
    projectKey: resolvedKey,
    ticketCount: tickets.length,
    rung: resolvedRung,
    persistedConfig: persistToConfig,
  };
}
