// FG-607 (FG-496 Slice B): the DUAL-MODE backlog CRUD seam.
//
// Nearly every consumer in forge imports readTicket / ticketExists / writeTicket /
// listTickets / closeTicket / retitleTicket / moveTicket / fillClosedCommit from
// this one module, so a dual-mode implementation behind UNCHANGED signatures
// migrates them all at once. resolveBacklogStore decides which store is
// authoritative for the project; markdown (the default, unchanged this slice)
// delegates to the *Markdown helpers below, db operates on the host DB.
//
// The mode is AUTHORITATIVE. There is deliberately NO read-through blending and
// NO fallback from one store to the other: a ticket missing in db mode is a
// missing ticket, and raises exactly the error the Markdown path raises. Silent
// fallback is the split-truth bug FG-496 exists to kill.

import { existsSync, mkdirSync, rmdirSync, rmSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify as stringifyYaml, parse as parseYaml } from "yaml";
import { readBacklogConfig } from "./config.js";
import { resolveBacklogStore } from "./storage-mode.js";
import { writeTransaction } from "../store/db.js";
import {
  allocateTicketId,
  blockerEvidenceForTicket,
  deleteBlockerEvidence,
  deleteTicketRelations,
  getTicket,
  relationsForTicket,
  ticketsForProject,
  upsertBlockerEvidence,
  upsertSeamTicket,
  upsertTicketRelation,
  LEGACY_BLOCKED_SOURCE,
  isStatusBearingEvidenceSource,
  type BlockerEvidence,
  type DbTicketStatus,
  type TicketRow,
} from "../store/tickets.js";

export type TicketType = "idea" | "epic" | "story";
export type TicketStatus = "active" | "done" | "blocked" | "deferred";

export type TicketFrontmatter = {
  id: string;
  type: TicketType;
  status: TicketStatus;
  title: string;
  related?: string[];
  created?: string;
  closed?: string;
  closedCommit?: string;
  epic?: string;
};

export type StructuredTicket = TicketFrontmatter & {
  body: string;
};

export const TYPE_DIRS: Record<TicketType, string> = {
  idea: "ideas",
  epic: "epics",
  story: "stories",
};

const DONE_DIR = "done";

export function generateSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 50)
    .replace(/-$/, "");
}

function backlogDir(projectDir: string): string {
  return join(projectDir, "backlog");
}

function subdirForTicket(fm: Pick<TicketFrontmatter, "type" | "status">): string {
  if (fm.status === "done") return DONE_DIR;
  return TYPE_DIRS[fm.type];
}

function findTicketFile(projectDir: string, id: string): { path: string; subdir: string } | undefined {
  const base = backlogDir(projectDir);
  const dirs = ["ideas", "epics", "stories", DONE_DIR];
  const matches: Array<{ path: string; subdir: string }> = [];

  for (const dir of dirs) {
    const full = join(base, dir);
    if (!existsSync(full)) continue;
    const entries = readdirSync(full);
    const match = entries.find((e) => e.startsWith(`${id}-`) || e === `${id}.md`);
    if (match) matches.push({ path: join(full, match), subdir: dir });
  }

  if (matches.length > 1) {
    process.stderr.write(
      `ERROR: ticket ${id} exists in multiple backlog directories:\n` +
        matches.map((m) => `  ${m.path}`).join("\n") + "\n" +
        `This indicates a partial failure during a prior close/move. ` +
        `Remove the stale copy from the active directory.\n`,
    );
    // Prefer the done/ copy — it is the intended final state after a close
    const doneMatch = matches.find((m) => m.subdir === DONE_DIR);
    return doneMatch ?? matches[0];
  }

  return matches[0];
}

function parseTicketFile(content: string): { frontmatter: TicketFrontmatter; body: string } {
  if (!content.startsWith("---\n")) {
    throw new Error("ticket file must start with YAML frontmatter (---)")
  }
  const end = content.indexOf("\n---\n", 4);
  if (end === -1) throw new Error("unterminated YAML frontmatter");
  const yaml = content.slice(4, end);
  const body = content.slice(end + 5);
  const raw = parseYaml(yaml) as Record<string, unknown>;
  const frontmatter: TicketFrontmatter = {
    id: String(raw["id"]),
    type: raw["type"] as TicketType,
    status: raw["status"] as TicketStatus,
    title: String(raw["title"]),
    ...(raw["related"] ? { related: raw["related"] as string[] } : {}),
    ...(raw["created"] ? { created: String(raw["created"]) } : {}),
    ...(raw["closed"] ? { closed: String(raw["closed"]) } : {}),
    ...(raw["closed_commit"] ? { closedCommit: String(raw["closed_commit"]) } : {}),
    ...(raw["epic"] ? { epic: String(raw["epic"]) } : {}),
  };
  return { frontmatter, body: body.trimStart() };
}

function serializeTicket(fm: TicketFrontmatter, body: string): string {
  const yamlObj: Record<string, unknown> = {
    id: fm.id,
    type: fm.type,
    status: fm.status,
    title: fm.title,
  };
  if (fm.epic) yamlObj["epic"] = fm.epic;
  if (fm.related && fm.related.length > 0) yamlObj["related"] = fm.related;
  if (fm.created) yamlObj["created"] = fm.created;
  if (fm.closed) yamlObj["closed"] = fm.closed;
  if (fm.closedCommit) yamlObj["closed_commit"] = fm.closedCommit;
  const yaml = stringifyYaml(yamlObj, { lineWidth: 0 });
  const bodyStr = body.trim().length > 0 ? "\n" + body.trimStart() : "";
  return `---\n${yaml}---\n${bodyStr}`;
}

function readTicketMarkdown(projectDir: string, id: string): StructuredTicket {
  const found = findTicketFile(projectDir, id);
  if (!found) throw new Error(`Ticket ${id} not found`);
  const content = readFileSync(found.path, "utf8");
  const { frontmatter, body } = parseTicketFile(content);
  return { ...frontmatter, body };
}

// Returns true if a file for this id already exists anywhere in backlog/.
function ticketExistsMarkdown(projectDir: string, id: string): boolean {
  return findTicketFile(projectDir, id) !== undefined;
}

// Writing a ticket that already has a file on disk MUST write back to that
// same file — the slug is fixed at creation and is cosmetic. Recomputing a
// title-derived filename here is what caused edit (and retitle) to orphan
// the original file and create a second one sharing the same id (FG-360).
function writeTicketMarkdown(projectDir: string, ticket: StructuredTicket): void {
  const { body, ...fm } = ticket;
  const existing = findTicketFile(projectDir, ticket.id);
  if (existing) {
    // Write back to the existing file in place — the slug is fixed at
    // creation and this function never moves it. Genuine relocation (a real
    // type/status change) is moveTicket's job, not a side effect of edit.
    writeFileSync(existing.path, serializeTicket(fm, body));
    return;
  }

  const base = backlogDir(projectDir);
  const subdir = subdirForTicket(ticket);
  const dir = join(base, subdir);
  mkdirSync(dir, { recursive: true });

  const slug = generateSlug(ticket.title);
  const filename = `${ticket.id}-${slug}.md`;
  writeFileSync(join(dir, filename), serializeTicket(fm, body));
}

export type ListFilter = {
  type?: TicketType;
  status?: TicketStatus;
  search?: string;
};

// Exported for the Markdown -> DB import orchestrator ONLY. Import is a migration
// FROM the filesystem, so it must read Markdown regardless of the project's
// current storage mode — going through the dual-mode listTickets would make a
// re-import in db mode read the DB and import it into itself.
export function listMarkdownTickets(projectDir: string, filters: ListFilter = {}): StructuredTicket[] {
  return listTicketsMarkdown(projectDir, filters);
}

function listTicketsMarkdown(projectDir: string, filters: ListFilter = {}): StructuredTicket[] {
  const base = backlogDir(projectDir);
  // Always scan all structured dirs (active dirs first, done last) so that
  // dedup/ghost detection fires on every path, including --status done.
  // Filtering is applied post-scan from frontmatter, not from which dir was scanned.
  // NOTE: a cleaner crash-safety fix would be for atomicMoveFile to write into done/ first;
  // that is FG-397's responsibility and is not changed here.
  const dirsToScan = ["ideas", "epics", "stories", DONE_DIR];

  const searchLower = filters.search ? filters.search.toLowerCase() : undefined;

  // Collect into a Map keyed by ticket id to detect and deduplicate ghost copies.
  // Scan order is active dirs first, done last — when a duplicate is found the
  // done/ copy wins (it is the intended final state after a close operation).
  const seen = new Map<string, { ticket: StructuredTicket; subdir: string }>();

  for (const subdir of dirsToScan) {
    const dir = join(base, subdir);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith(".md")) continue;
      try {
        const content = readFileSync(join(dir, entry), "utf8");
        const { frontmatter, body } = parseTicketFile(content);
        const prev = seen.get(frontmatter.id);
        if (prev) {
          process.stderr.write(
            `ERROR: duplicate ticket id ${frontmatter.id} found in ${prev.subdir}/ and ${subdir}/\n` +
              `An active ghost may be shadowing the intended ticket. ` +
              `Remove the stale copy from the active directory.\n`,
          );
          // Prefer done/ copy — replace the earlier active copy
          if (subdir === DONE_DIR) {
            seen.set(frontmatter.id, { ticket: { ...frontmatter, body }, subdir });
          }
        } else {
          seen.set(frontmatter.id, { ticket: { ...frontmatter, body }, subdir });
        }
      } catch {
        // skip unparseable files
      }
    }
  }

  const results: StructuredTicket[] = [];
  for (const { ticket } of seen.values()) {
    if (filters.type && ticket.type !== filters.type) continue;
    if (filters.status && ticket.status !== filters.status) continue;
    if (searchLower) {
      const haystack = (ticket.title + " " + ticket.body).toLowerCase();
      if (!haystack.includes(searchLower)) continue;
    }
    results.push(ticket);
  }
  return results;
}

// Writes newContent to srcPath then atomically renames it to destPath so that
// at no point are two .md copies of the same ticket id visible in the scanned
// directories. Falls back to write-then-delete on cross-device (EXDEV) mounts.
function atomicMoveFile(srcPath: string, destPath: string, newContent: string): void {
  writeFileSync(srcPath, newContent);
  try {
    renameSync(srcPath, destPath);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "EXDEV") {
      // Cross-device: rename is impossible; brief two-copy window is unavoidable
      writeFileSync(destPath, newContent);
      unlinkSync(srcPath);
    } else {
      throw err;
    }
  }
}

function closeTicketMarkdown(projectDir: string, id: string, commit?: string): void {
  const found = findTicketFile(projectDir, id);
  if (!found) throw new Error(`Ticket ${id} not found`);

  const content = readFileSync(found.path, "utf8");
  const { frontmatter, body } = parseTicketFile(content);

  const updated: TicketFrontmatter = {
    ...frontmatter,
    status: "done",
    closed: new Date().toISOString().slice(0, 10),
    ...(commit ? { closedCommit: commit } : {}),
  };
  const newContent = serializeTicket(updated, body);

  const base = backlogDir(projectDir);
  const destDir = join(base, DONE_DIR);
  mkdirSync(destDir, { recursive: true });

  const slug = generateSlug(updated.title);
  const filename = `${updated.id}-${slug}.md`;
  const destPath = join(destDir, filename);

  if (found.path !== destPath) {
    atomicMoveFile(found.path, destPath, newContent);
  } else {
    writeFileSync(found.path, newContent);
  }
}

// ─── Backlog write lock ───────────────────────────────────────────────────────
// Guards the read-max-id → write-ticket critical section so that two concurrent
// `forge backlog file` invocations cannot both observe the same max id and
// allocate a duplicate ticket id.
//
// Mechanism: atomic directory create (mkdirSync without recursive — EEXIST if held).
// Directory creation is atomic on all POSIX filesystems including overlayfs/tmpfs,
// and eliminates the half-written-body window that plagued the O_EXCL file approach.
// Holder identity is written inside the directory after the mkdir; reclaim only when
// the marker file is parseable AND the holder is provably dead (ESRCH from kill -0).

const LOCK_DIR_NAME = ".backlog-write.lockdir";
const LOCK_POLL_MS = 50;        // retry interval while waiting
const LOCK_WAIT_MS = 10_000;    // give up after 10 s

type BacklogLockData = { pid: number; acquiredAtMs: number };

function backlogLockDir(projectDir: string): string {
  return join(backlogDir(projectDir), LOCK_DIR_NAME);
}

function backlogLockPidAlive(pid: number): boolean {
  if (pid <= 0) return false; // 0 / negative are not real process ids (0 = process group)
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // ESRCH → no such process. EPERM → exists but not ours (alive).
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readBacklogLockHolder(lockDir: string): BacklogLockData | null {
  try {
    return JSON.parse(readFileSync(join(lockDir, "holder"), "utf8")) as BacklogLockData;
  } catch {
    return null;
  }
}

function tryAcquireBacklogLock(lockDir: string): boolean {
  try {
    mkdirSync(lockDir); // no recursive — EEXIST if lock is held; atomic on all POSIX filesystems
    writeFileSync(join(lockDir, "holder"), JSON.stringify({ pid: process.pid, acquiredAtMs: Date.now() }));
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    return false;
  }
}

/** Run fn while holding a project-scoped backlog write lock.
 *  A lock held by a dead pid is reclaimed automatically.
 *  A live-pid lock that outlasts the wait window throws with a manual-recovery message. */
export function withBacklogLock<T>(projectDir: string, fn: () => T): T {
  mkdirSync(backlogDir(projectDir), { recursive: true });
  const lockDir = backlogLockDir(projectDir);
  const deadline = Date.now() + LOCK_WAIT_MS;

  for (;;) {
    if (tryAcquireBacklogLock(lockDir)) {
      try {
        return fn();
      } finally {
        // Only release if we still hold the lock (wasn't reclaimed while fn() ran)
        const held = readBacklogLockHolder(lockDir);
        if (held?.pid === process.pid) {
          try { unlinkSync(join(lockDir, "holder")); } catch { /* already gone */ }
          try { rmdirSync(lockDir); } catch { /* already gone */ }
        }
      }
    }

    // Lock directory exists — reclaim only if the holder pid is provably dead.
    // null = holder file not yet written (brief window between mkdir and writeFileSync) — keep waiting.
    const held = readBacklogLockHolder(lockDir);
    if (held !== null && !backlogLockPidAlive(held.pid)) {
      try { rmSync(lockDir, { recursive: true, force: true }); } catch { /* another waiter got here first */ }
      continue;
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `backlog lock held by live pid ${held?.pid ?? "unknown"} at ${lockDir} for longer than ${LOCK_WAIT_MS}ms; if this is stale, remove ${lockDir} manually`,
      );
    }

    // Short busy-wait before retrying (safe in a CLI process)
    const until = Date.now() + LOCK_POLL_MS;
    while (Date.now() < until) { /* spin */ }
  }
}

// Additive, best-effort gap-fill: writes closedCommit to an already-done ticket
// when the agent did not record it at close time. Never overwrites an existing
// SHA (agent SHA wins), never changes the file's status or closed date, never
// moves the file. Silently no-ops on missing ticket, non-done ticket, or any error.
function fillClosedCommitMarkdown(projectDir: string, id: string, commit: string): void {
  const found = findTicketFile(projectDir, id);
  if (!found) return;

  const content = readFileSync(found.path, "utf8");
  const { frontmatter, body } = parseTicketFile(content);

  if (frontmatter.status !== "done") return;
  if (frontmatter.closedCommit) return;

  const updated: TicketFrontmatter = { ...frontmatter, closedCommit: commit };
  writeFileSync(found.path, serializeTicket(updated, body));
}

// If the body's first non-blank line is a markdown heading that echoes the
// old title (e.g. "# old title" or "### FG-1 — old title"), swap in the new
// title text and leave the heading marker/prefix untouched. Bodies with no
// such heading are left alone — not every ticket carries one.
function retitleHeading(body: string, oldTitle: string, newTitle: string): string {
  const lines = body.split("\n");
  const idx = lines.findIndex((l) => l.trim().length > 0);
  if (idx === -1) return body;
  const match = lines[idx]!.match(/^(#{1,6}\s+)(.*)$/);
  if (!match) return body;
  const [, marker, text] = match;
  if (!text!.includes(oldTitle)) return body;
  lines[idx] = marker + text!.replace(oldTitle, newTitle);
  return lines.join("\n");
}

// Changes only the mutable title (frontmatter title: + any heading echoing
// it) in place. Never touches the filename — the slug is fixed at creation.
function retitleTicketMarkdown(projectDir: string, id: string, newTitle: string): void {
  const found = findTicketFile(projectDir, id);
  if (!found) throw new Error(`Ticket ${id} not found`);

  const content = readFileSync(found.path, "utf8");
  const { frontmatter, body } = parseTicketFile(content);
  const updatedBody = retitleHeading(body, frontmatter.title, newTitle);
  const updated: TicketFrontmatter = { ...frontmatter, title: newTitle };
  writeFileSync(found.path, serializeTicket(updated, updatedBody));
}

function moveTicketMarkdown(projectDir: string, id: string, newType: TicketType): void {
  const found = findTicketFile(projectDir, id);
  if (!found) throw new Error(`Ticket ${id} not found`);

  const content = readFileSync(found.path, "utf8");
  const { frontmatter, body } = parseTicketFile(content);
  const { closed: _closed, closedCommit: _closedCommit, ...restFrontmatter } = frontmatter;
  const updated: TicketFrontmatter = { ...restFrontmatter, type: newType, status: "active" };

  const base = backlogDir(projectDir);
  const newDir = join(base, TYPE_DIRS[newType]);
  mkdirSync(newDir, { recursive: true });

  const slug = generateSlug(updated.title);
  const filename = `${updated.id}-${slug}.md`;
  const newPath = join(newDir, filename);

  if (found.path !== newPath) {
    atomicMoveFile(found.path, newPath, serializeTicket(updated, body));
  } else {
    writeFileSync(found.path, serializeTicket(updated, body));
  }
}

// ─── DB store (FG-607) ───────────────────────────────────────────────────────
// The row <-> StructuredTicket mapping lives HERE and is shared with the import
// orchestrator (src/store/backlog-import.ts imports mapStatusToDb from this
// module) so the two writers into the tickets table can never drift.

// The DB status vocabulary is exactly active/done/deferred (a CHECK enforces it).
// Legacy 'blocked' maps to 'active' plus a blocker_evidence row, so the blocked
// FACT is durable; ticketStatusFromRow reconstructs it on the way out.
export function mapStatusToDb(status: TicketStatus): DbTicketStatus {
  switch (status) {
    case "active":
    case "blocked":
      return "active";
    case "done":
      return "done";
    case "deferred":
      return "deferred";
  }
}

// Frontmatter keys this seam owns. Everything else in the preserved JSON overflow
// column (keys the structured parser doesn't model) survives a read-modify-write
// untouched; the owned keys are rewritten wholesale so a dropped `closed:` really
// disappears instead of lingering as stale overflow.
const OWNED_FM_KEYS = ["id", "type", "status", "title", "epic", "related", "created", "closed", "closed_commit"];

function mergeFrontmatter(
  existing: Record<string, unknown> | null | undefined,
  fm: TicketFrontmatter,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...(existing ?? {}) };
  for (const k of OWNED_FM_KEYS) delete merged[k];
  merged["id"] = fm.id;
  merged["type"] = fm.type;
  merged["status"] = fm.status;
  merged["title"] = fm.title;
  if (fm.epic) merged["epic"] = fm.epic;
  if (fm.related && fm.related.length > 0) merged["related"] = fm.related;
  if (fm.created) merged["created"] = fm.created;
  if (fm.closed) merged["closed"] = fm.closed;
  if (fm.closedCommit) merged["closed_commit"] = fm.closedCommit;
  return merged;
}

function rowToStructured(row: TicketRow, related: string[], blocked: boolean): StructuredTicket {
  const status: TicketStatus = blocked && row.status === "active" ? "blocked" : row.status;
  return {
    id: row.ticketId,
    type: row.type as TicketType,
    status,
    title: row.title,
    ...(related.length > 0 ? { related } : {}),
    ...(row.created ? { created: row.created } : {}),
    ...(row.closed ? { closed: row.closed } : {}),
    ...(row.closedCommit ? { closedCommit: row.closedCommit } : {}),
    ...(row.epic ? { epic: row.epic } : {}),
    body: row.body,
  };
}

function relatedIds(projectKey: string, ticketId: string): string[] {
  return relationsForTicket(projectKey, ticketId)
    .filter((r) => r.relType === "related")
    .map((r) => r.relatedId);
}

// FG-609 surface (i) of four. The predicate is the canonical one from the
// zero-import leaf — the enriched dependency / campaign / run-derived kinds feed
// the operator queue projection and must NEVER flip a ticket to status 'blocked'.
function legacyBlockerEvidence(projectKey: string, ticketId: string): BlockerEvidence | undefined {
  return blockerEvidenceForTicket(projectKey, ticketId).find((b) =>
    isStatusBearingEvidenceSource(b.source),
  );
}

function isBlockedInDb(projectKey: string, ticketId: string): boolean {
  return legacyBlockerEvidence(projectKey, ticketId) !== undefined;
}

function hydrate(row: TicketRow): StructuredTicket {
  return rowToStructured(
    row,
    relatedIds(row.projectKey, row.ticketId),
    isBlockedInDb(row.projectKey, row.ticketId),
  );
}

// The single db write path — every mutating seam function funnels through it, so
// the blocked<->evidence symmetry and the related[] replace-set are implemented
// exactly once. MUST run inside the caller's writeTransaction.
function writeTicketRow(projectKey: string, ticket: StructuredTicket, now: string): void {
  const { body, ...fm } = ticket;
  const existing = getTicket(projectKey, ticket.id);
  const row: TicketRow = {
    projectKey,
    ticketId: ticket.id,
    type: ticket.type,
    status: mapStatusToDb(ticket.status),
    title: ticket.title,
    body,
    created: ticket.created ?? null,
    closed: ticket.closed ?? null,
    closedCommit: ticket.closedCommit ?? null,
    epic: ticket.epic ?? null,
    frontmatter: mergeFrontmatter(existing?.frontmatter, fm),
    // Only used when this INSERTs (imported_at is NOT NULL); upsertSeamTicket
    // leaves both provenance columns alone on update — a seam edit is not an
    // import, and clobbering them would break import's reconcile provenance.
    importedAt: now,
    importedFrom: null,
  };
  upsertSeamTicket(row);

  // Replace-set: the ticket's `related:` list is the whole truth, so a removed id
  // is really removed (import is additive-only; the seam is not).
  deleteTicketRelations(projectKey, ticket.id, "related");
  for (const relatedId of ticket.related ?? []) {
    upsertTicketRelation({ projectKey, ticketId: ticket.id, relatedId, relType: "related" });
  }

  // 'blocked' is not a stored status — it is active + durable blocker evidence.
  // Both directions matter: without the delete, unblocking a ticket would leave
  // the evidence row and it would read back as blocked forever.
  if (ticket.status === "blocked") {
    // created_at is "blocked since" — preserve it, like the reason, for as long as
    // the ticket STAYS blocked. ON CONFLICT overwrites both, so passing `now`
    // unconditionally would let an unrelated body edit reset when it became
    // blocked. A ticket blocked afresh has no row and stamps now.
    const existingEvidence = legacyBlockerEvidence(projectKey, ticket.id);
    upsertBlockerEvidence({
      projectKey,
      ticketId: ticket.id,
      reason: existingEvidence?.reason ?? "written through the backlog seam with status: blocked",
      source: LEGACY_BLOCKED_SOURCE,
      createdAt: existingEvidence?.createdAt ?? now,
    });
  } else {
    // SOURCE-SCOPED, and FG-609 does NOT widen it. Unblocking a ticket removes the
    // LEGACY row and nothing else: the enriched dependency / campaign / run-derived
    // rows are queue-projection facts with their own lifecycles, and a status edit
    // is not evidence that a dependency was resolved.
    deleteBlockerEvidence(projectKey, ticket.id, LEGACY_BLOCKED_SOURCE);
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function readTicketDb(projectKey: string, id: string): StructuredTicket {
  const row = getTicket(projectKey, id);
  // No Markdown fallback — the mode is authoritative.
  if (!row) throw new Error(`Ticket ${id} not found`);
  return hydrate(row);
}

// Human/most-recent-last ordering: prefix, then numeric sequence. Plain ticket_id
// ordering would put FG-10 before FG-2.
function compareTicketIds(a: string, b: string): number {
  const ma = a.match(/^([A-Za-z]+)-(\d+)$/);
  const mb = b.match(/^([A-Za-z]+)-(\d+)$/);
  if (ma && mb) {
    if (ma[1] !== mb[1]) return ma[1]!.localeCompare(mb[1]!);
    return parseInt(ma[2]!, 10) - parseInt(mb[2]!, 10);
  }
  return a.localeCompare(b);
}

function listTicketsDb(projectKey: string, filters: ListFilter): StructuredTicket[] {
  const searchLower = filters.search ? filters.search.toLowerCase() : undefined;
  const results: StructuredTicket[] = [];
  for (const row of ticketsForProject(projectKey)) {
    const ticket = hydrate(row);
    if (filters.type && ticket.type !== filters.type) continue;
    if (filters.status && ticket.status !== filters.status) continue;
    if (searchLower) {
      const haystack = (ticket.title + " " + ticket.body).toLowerCase();
      if (!haystack.includes(searchLower)) continue;
    }
    results.push(ticket);
  }
  return results.sort((a, b) => compareTicketIds(a.id, b.id));
}

// ─── dual-mode seam ──────────────────────────────────────────────────────────
// Unchanged signatures; the store decides. Every db write runs inside
// writeTransaction (BEGIN IMMEDIATE) — the cross-process serialization point that
// replaces withBacklogLock, which cannot serialize two linked worktrees anyway.

export function readTicket(projectDir: string, id: string): StructuredTicket {
  const store = resolveBacklogStore(projectDir);
  if (store.mode === "db") return readTicketDb(store.projectKey, id);
  return readTicketMarkdown(projectDir, id);
}

export function ticketExists(projectDir: string, id: string): boolean {
  const store = resolveBacklogStore(projectDir);
  if (store.mode === "db") return getTicket(store.projectKey, id) !== undefined;
  return ticketExistsMarkdown(projectDir, id);
}

export function writeTicket(projectDir: string, ticket: StructuredTicket): void {
  const store = resolveBacklogStore(projectDir);
  if (store.mode === "db") {
    const key = store.projectKey;
    writeTransaction(() => writeTicketRow(key, ticket, nowIso()));
    return;
  }
  writeTicketMarkdown(projectDir, ticket);
}

export function listTickets(projectDir: string, filters: ListFilter = {}): StructuredTicket[] {
  const store = resolveBacklogStore(projectDir);
  if (store.mode === "db") return listTicketsDb(store.projectKey, filters);
  return listTicketsMarkdown(projectDir, filters);
}

export function closeTicket(projectDir: string, id: string, commit?: string): void {
  const store = resolveBacklogStore(projectDir);
  if (store.mode === "db") {
    const key = store.projectKey;
    writeTransaction(() => {
      const ticket = readTicketDb(key, id);
      writeTicketRow(
        key,
        { ...ticket, status: "done", closed: today(), ...(commit ? { closedCommit: commit } : {}) },
        nowIso(),
      );
    });
    return;
  }
  closeTicketMarkdown(projectDir, id, commit);
}

export function retitleTicket(projectDir: string, id: string, newTitle: string): void {
  const store = resolveBacklogStore(projectDir);
  if (store.mode === "db") {
    const key = store.projectKey;
    writeTransaction(() => {
      const ticket = readTicketDb(key, id);
      writeTicketRow(
        key,
        { ...ticket, title: newTitle, body: retitleHeading(ticket.body, ticket.title, newTitle) },
        nowIso(),
      );
    });
    return;
  }
  retitleTicketMarkdown(projectDir, id, newTitle);
}

export function moveTicket(projectDir: string, id: string, newType: TicketType): void {
  const store = resolveBacklogStore(projectDir);
  if (store.mode === "db") {
    const key = store.projectKey;
    writeTransaction(() => {
      const ticket = readTicketDb(key, id);
      const { closed: _closed, closedCommit: _closedCommit, ...rest } = ticket;
      writeTicketRow(key, { ...rest, type: newType, status: "active" }, nowIso());
    });
    return;
  }
  moveTicketMarkdown(projectDir, id, newType);
}

export function fillClosedCommit(projectDir: string, id: string, commit: string): void {
  const store = resolveBacklogStore(projectDir);
  if (store.mode === "db") {
    const key = store.projectKey;
    writeTransaction(() => {
      const row = getTicket(key, id);
      // Same additive, best-effort contract as the Markdown path: silently
      // no-ops on a missing ticket, a non-done ticket, or an existing SHA.
      if (!row) return;
      if (row.status !== "done") return;
      if (row.closedCommit) return;
      writeTicketRow(key, { ...hydrate(row), closedCommit: commit }, nowIso());
    });
    return;
  }
  fillClosedCommitMarkdown(projectDir, id, commit);
}

export type NewTicketDraft = {
  type: TicketType;
  title: string;
  body: string;
  created?: string;
};

// Create a ticket with a freshly ALLOCATED id — the `forge backlog file` path.
//
// In db mode the allocation and the insert share ONE writeTransaction, so two
// concurrent files (including from two linked worktrees, which no filesystem lock
// can serialize) cannot collide or reuse an id. In markdown mode this is the
// read-max-id -> write critical section, guarded by the project-dir lock exactly
// as before.
export function fileNewTicket(projectDir: string, draft: NewTicketDraft): string {
  const store = resolveBacklogStore(projectDir);
  const prefix = readBacklogConfig(projectDir).prefix ?? "FG";
  const created = draft.created ?? today();

  if (store.mode === "db") {
    const key = store.projectKey;
    return writeTransaction(() => {
      const id = allocateTicketId(key, prefix);
      if (getTicket(key, id)) {
        throw new Error(`Ticket ${id} already exists; refusing to create a duplicate (dedupe by id)`);
      }
      writeTicketRow(
        key,
        { id, type: draft.type, status: "active", title: draft.title, body: draft.body, created },
        nowIso(),
      );
      return id;
    });
  }

  return withBacklogLock(projectDir, () => {
    const existing = listTicketsMarkdown(projectDir);
    const nextNum =
      existing.reduce((max, t) => {
        const m = t.id.match(/^[A-Z]+-(\d+)$/);
        return Math.max(max, m ? parseInt(m[1]!, 10) : 0);
      }, 0) + 1;
    const id = `${prefix}-${nextNum}`;
    if (ticketExistsMarkdown(projectDir, id)) {
      throw new Error(`Ticket ${id} already exists on disk; refusing to create a duplicate (dedupe by id)`);
    }
    writeTicketMarkdown(projectDir, {
      id,
      type: draft.type,
      status: "active",
      title: draft.title,
      body: draft.body,
      created,
    });
    return id;
  });
}
