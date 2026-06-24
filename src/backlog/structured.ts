import { existsSync, mkdirSync, rmdirSync, rmSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify as stringifyYaml, parse as parseYaml } from "yaml";

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

const TYPE_DIRS: Record<TicketType, string> = {
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

export function readTicket(projectDir: string, id: string): StructuredTicket {
  const found = findTicketFile(projectDir, id);
  if (!found) throw new Error(`Ticket ${id} not found`);
  const content = readFileSync(found.path, "utf8");
  const { frontmatter, body } = parseTicketFile(content);
  return { ...frontmatter, body };
}

export function writeTicket(projectDir: string, ticket: StructuredTicket): void {
  const base = backlogDir(projectDir);
  const subdir = subdirForTicket(ticket);
  const dir = join(base, subdir);
  mkdirSync(dir, { recursive: true });

  const slug = generateSlug(ticket.title);
  const filename = `${ticket.id}-${slug}.md`;
  const { body, ...fm } = ticket;
  writeFileSync(join(dir, filename), serializeTicket(fm, body));
}

export type ListFilter = {
  type?: TicketType;
  status?: TicketStatus;
  search?: string;
};

export function listTickets(projectDir: string, filters: ListFilter = {}): StructuredTicket[] {
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

export function closeTicket(projectDir: string, id: string, commit?: string): void {
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

export function moveTicket(projectDir: string, id: string, newType: TicketType): void {
  const found = findTicketFile(projectDir, id);
  if (!found) throw new Error(`Ticket ${id} not found`);

  const content = readFileSync(found.path, "utf8");
  const { frontmatter, body } = parseTicketFile(content);
  const updated: TicketFrontmatter = { ...frontmatter, type: newType, status: "active" };

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
