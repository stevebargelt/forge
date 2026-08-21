// FG-588 — the compact, read-only orientation snapshot.
//
// THE DEFECT THIS CLOSES. `/orient` grew seven unconditional reads — full handoff
// notes, every active ticket title, thirty arbitrary done tickets, ten recent
// runs, and complete `ops check --json` evidence — injecting ~39 KB (~10k tokens)
// before the orchestrator reasons at all, though its report uses a fraction. Worse
// than wasteful: `done | head -30` cannot tell a closed ticket outside the newest
// thirty from an absent one, so stale-reference reconciliation was quietly wrong.
//
// THE FIX. ONE Forge-owned, bounded, read-only projection supplies exactly what
// ordinary orientation needs; the orchestrator drills in (`forge backlog show`,
// `forge ops check --json`) only for the identities this snapshot marks. Every
// bounded field that cannot be represented completely carries explicit truncation
// metadata — nothing is silently dropped.
//
// SCOPE. This module SHAPES the data; it never mutates. It sends no notification,
// writes no milestone event, reconciles no task, and edits no note or project
// file. The projection core (projectOrientSnapshot) is a pure function over
// already-read inputs so its bounds are unit-testable without a store; the wiring
// (buildOrientSnapshot) does the read-only store/filesystem reads and degrades
// every source independently rather than crashing a fresh host.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Incident, IncidentKind, IncidentSeverity } from "../types/index.js";
import { listTickets, readTicket, ticketExists, type TicketStatus } from "../backlog/structured.js";
import { readBacklogConfig } from "../backlog/config.js";
import { runOpsCheck } from "../ops/detect.js";
import { storeExists } from "../store/db.js";
import { listProjects, findProject } from "../util/projects.js";

export const ORIENT_SNAPSHOT_SCHEMA = "forge.orient.snapshot" as const;
export const ORIENT_SNAPSHOT_VERSION = 1 as const;

/** The compact identity set for active tickets. Reconciling a `Picked up next`
 *  ref is done EXACTLY via referencedTickets, so this list is informational (the
 *  report's "top N by sticky number"); capping it keeps the snapshot bounded even
 *  as the active set grows, and `truncated` says when it was cut. */
export const ACTIVE_TICKET_IDS_CAP = 100;

/** The bounded highest-severity incident identities. Full evidence/action prose is
 *  never carried — the orchestrator fetches it via `forge ops check --json` only
 *  when it is about to act. */
export const OPS_HIGHEST_CAP = 6;

/** The concrete bound on a forward handoff field. An overlong field is represented
 *  as an explicit truncated state (text prefix + fullLength), never injected
 *  wholesale — the bounded-notes contract this ticket establishes. */
export const HANDOFF_FIELD_MAX_CHARS = 500;

/** The concrete bound on a referenced ticket's title. A referenced ticket carries a
 *  title (unlike an active-id row), so one ticket with a pathological title could
 *  otherwise push the whole snapshot past its byte budget with no notice. Over-limit
 *  titles are truncated with explicit `titleTruncated` + `titleFullLength` metadata —
 *  the same never-silent-truncation contract the handoff fields hold. */
export const REFERENCED_TICKET_TITLE_MAX_CHARS = 200;

/** A forward handoff field, bounded. `truncated` + `fullLength` make an over-limit
 *  field an explicit state rather than a silent cut. */
export type OrientBoundedField = {
  text: string;
  truncated: boolean;
  /** Length of the untruncated (trimmed) field, so the reader knows what was cut. */
  fullLength: number;
};

/** The EXACT resolution of a `Picked up next` ticket ref, before the snapshot bounds
 *  its title. `missing` means no such ticket exists — so a closed ticket of any age is
 *  never confused with an absent one (the `done | head -30` defect). `unreadable` means
 *  the ticket EXISTS but could not be read: an error state that must never be conflated
 *  with an actually-absent ticket. */
export type OrientResolvedTicket = {
  id: string;
  status: TicketStatus | "missing" | "unreadable";
  title: string | null;
};

/** A referenced ticket as it appears in the snapshot: the exact resolution with its
 *  title bounded. `titleTruncated` + `titleFullLength` make an over-limit title an
 *  explicit state rather than a silent cut. */
export type OrientTicketRef = OrientResolvedTicket & {
  titleTruncated: boolean;
  /** Length of the untruncated (resolved) title, 0 when the title is null. */
  titleFullLength: number;
};

/** The bounded incident projection: identity only. Full `evidence` and
 *  `recommendedAction` prose are deliberately absent. */
export type OrientOpsIdentity = {
  severity: IncidentSeverity;
  kind: IncidentKind;
  runId: string;
  taskId: string | null;
};

export type OrientSnapshot = {
  schema: typeof ORIENT_SNAPSHOT_SCHEMA;
  version: typeof ORIENT_SNAPSHOT_VERSION;
  project: {
    key: string | null;
    name: string;
    path: string;
    /** ISO timestamp of the last run, or null when the project has no runs yet. */
    lastActivity: string | null;
    liveSessions: number;
    inFlight: number;
  };
  handoff: {
    present: boolean;
    whereWeLeftOff: OrientBoundedField | null;
    pickedUpNext: OrientBoundedField | null;
    /** FG-550's optional memory-invalidation flag, carried compactly when handoff
     *  wrote it. This snapshot transports the signal; it runs no memory audit. */
    invalidatedMemories: OrientBoundedField | null;
    /** Present but with no `Picked up next` section — a stale handoff. */
    stale: boolean;
  };
  activeTickets: {
    count: number;
    ids: string[];
    /** count > ids.length — the identity set was capped. */
    truncated: boolean;
  };
  referencedTickets: OrientTicketRef[];
  ops: {
    total: number;
    bySeverity: { high: number; medium: number; low: number };
    highestSeverity: OrientOpsIdentity[];
    /** total > highestSeverity.length — more incidents than the bounded set shows. */
    truncated: boolean;
  };
};

export type OrientSnapshotInputs = {
  project: OrientSnapshot["project"];
  /** Raw contents of backlog/notes.md, or null when there are none. */
  notesText: string | null;
  /** Every active ticket id (sticky), unbounded — the projection sorts and caps. */
  activeIds: string[];
  /** Exact resolver for a referenced ticket id. Injected so the projection stays
   *  pure and testable without a store; the projection bounds the returned title. */
  resolveTicket: (id: string) => OrientResolvedTicket;
  incidents: readonly Incident[];
  /** Backlog id prefix (e.g. "FG"), for normalizing bare `#N` refs. */
  prefix: string;
};

const SEVERITY_RANK: Record<IncidentSeverity, number> = { high: 3, medium: 2, low: 1 };

/** The forward handoff headings this snapshot extracts, by field. Matched
 *  case-insensitively on the label; the content runs to the next bold heading or
 *  the end of the notes. */
const HANDOFF_HEADINGS = {
  whereWeLeftOff: "Where we left off",
  pickedUpNext: "Picked up next",
  invalidatedMemories: "Memories this session may have invalidated",
} as const;

/** Every heading the block can carry — a field's content stops at the next one so a
 *  later section never bleeds into an earlier field. */
const ALL_HANDOFF_HEADINGS = [
  "Where we left off",
  "Picked up next",
  "External state to remember",
  "Decisions worth not relitigating",
  "Memories this session may have invalidated",
  "Shipped (for reference)",
] as const;

function boundField(raw: string | undefined): OrientBoundedField | null {
  const text = (raw ?? "").trim();
  if (!text) return null;
  const fullLength = text.length;
  if (fullLength <= HANDOFF_FIELD_MAX_CHARS) return { text, truncated: false, fullLength };
  return { text: text.slice(0, HANDOFF_FIELD_MAX_CHARS), truncated: true, fullLength };
}

/** Bound a resolved ticket's title to the snapshot budget. A null title (missing or
 *  unreadable) stays null with no truncation; an over-limit title is cut to the cap
 *  and flagged, so a single referenced ticket can never silently push the snapshot
 *  past its byte bound. */
function boundTicketRef(resolved: OrientResolvedTicket): OrientTicketRef {
  const { title } = resolved;
  if (title === null) return { ...resolved, title: null, titleTruncated: false, titleFullLength: 0 };
  const titleFullLength = title.length;
  if (titleFullLength <= REFERENCED_TICKET_TITLE_MAX_CHARS) {
    return { ...resolved, title, titleTruncated: false, titleFullLength };
  }
  return { ...resolved, title: title.slice(0, REFERENCED_TICKET_TITLE_MAX_CHARS), titleTruncated: true, titleFullLength };
}

/** Extract one heading's content from the notes block. Returns the text after the
 *  `**Heading:**` marker up to the next known heading (or EOF), or undefined when
 *  the heading is absent. Case-insensitive on the label; tolerant of the content
 *  being inline after the colon or on the following lines. */
export function extractHandoffField(notesText: string, heading: string): string | undefined {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // The label, optionally bolded, followed by a colon. Everything after it, up to
  // the next known heading, is the content.
  const start = new RegExp(`\\*{0,2}${escaped}\\*{0,2}\\s*:\\s*\\*{0,2}\\s*`, "i").exec(notesText);
  if (!start) return undefined;
  const from = start.index + start[0].length;
  const rest = notesText.slice(from);

  let end = rest.length;
  for (const other of ALL_HANDOFF_HEADINGS) {
    if (other === heading) continue;
    const esc = other.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m = new RegExp(`\\*{0,2}${esc}\\*{0,2}\\s*:`, "i").exec(rest);
    if (m && m.index < end) end = m.index;
  }
  return rest.slice(0, end).trim();
}

/** Extract the backlog refs from a `Picked up next` block, in first-seen order,
 *  deduped. Handles both prefixed ids (`FG-588`) and bare sticky numbers (`#588`),
 *  the latter normalized to `${prefix}-588`. */
export function extractTicketRefs(pickedUpNext: string, prefix: string): string[] {
  const seen = new Set<string>();
  const refs: string[] = [];
  const push = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    refs.push(id);
  };
  // Prefixed ids first (FG-588, ABC-12), so `#`-suffixed matches inside them do not
  // double-count.
  for (const m of pickedUpNext.matchAll(/\b([A-Za-z]{1,6}-\d+)\b/g)) push(m[1]!.toUpperCase());
  for (const m of pickedUpNext.matchAll(/#(\d+)\b/g)) push(`${prefix}-${m[1]}`);
  return refs;
}

function stickyNumber(id: string): number {
  const m = /(\d+)\s*$/.exec(id);
  return m ? parseInt(m[1]!, 10) : -1;
}

/** The pure projection: already-read inputs → the bounded snapshot. No I/O, no
 *  mutation of the inputs. */
export function projectOrientSnapshot(inputs: OrientSnapshotInputs): OrientSnapshot {
  const notesText = inputs.notesText ?? "";
  const present = notesText.trim().length > 0 && notesText.trim() !== "(no notes)";

  const pickedUpNextRaw = present ? extractHandoffField(notesText, HANDOFF_HEADINGS.pickedUpNext) : undefined;
  const whereWeLeftOff = present ? boundField(extractHandoffField(notesText, HANDOFF_HEADINGS.whereWeLeftOff)) : null;
  const pickedUpNext = boundField(pickedUpNextRaw);
  const invalidatedMemories = present
    ? boundField(extractHandoffField(notesText, HANDOFF_HEADINGS.invalidatedMemories))
    : null;

  // A present handoff with no forward pointer is stale — the same signal the report
  // surfaces under "Needs attention".
  const stale = present && pickedUpNext === null;

  // Reconcile the forward pointer EXACTLY: resolve every referenced ticket to its
  // real status/title regardless of age. The active-id list below is capped and
  // never the basis for reconciliation.
  const refs = pickedUpNextRaw ? extractTicketRefs(pickedUpNextRaw, inputs.prefix) : [];
  const referencedTickets = refs.map((id) => boundTicketRef(inputs.resolveTicket(id)));

  const sortedActive = [...inputs.activeIds].sort((a, b) => stickyNumber(b) - stickyNumber(a));
  const ids = sortedActive.slice(0, ACTIVE_TICKET_IDS_CAP);

  const bySeverity = { high: 0, medium: 0, low: 0 };
  for (const inc of inputs.incidents) bySeverity[inc.severity]++;
  const rankedIncidents = [...inputs.incidents].sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
  const highestSeverity: OrientOpsIdentity[] = rankedIncidents.slice(0, OPS_HIGHEST_CAP).map((inc) => ({
    severity: inc.severity,
    kind: inc.kind,
    runId: inc.runId,
    taskId: inc.taskId,
  }));

  return {
    schema: ORIENT_SNAPSHOT_SCHEMA,
    version: ORIENT_SNAPSHOT_VERSION,
    project: inputs.project,
    handoff: { present, whereWeLeftOff, pickedUpNext, invalidatedMemories, stale },
    activeTickets: { count: inputs.activeIds.length, ids, truncated: inputs.activeIds.length > ids.length },
    referencedTickets,
    ops: {
      total: inputs.incidents.length,
      bySeverity,
      highestSeverity,
      truncated: inputs.incidents.length > highestSeverity.length,
    },
  };
}

// ─── wiring: the read-only store/filesystem reads, each degraded independently ──

function readNotes(projectDir: string): string | null {
  const notesPath = join(projectDir, "backlog", "notes.md");
  if (!existsSync(notesPath)) return null;
  try {
    return readFileSync(notesPath, "utf8");
  } catch {
    return null;
  }
}

function safePrefix(projectDir: string): string {
  try {
    return readBacklogConfig(projectDir).prefix ?? "FG";
  } catch {
    return "FG";
  }
}

function safeActiveIds(projectDir: string): string[] {
  if (!storeExists()) return [];
  try {
    return listTickets(projectDir, { status: "active" }).map((t) => t.id);
  } catch {
    return [];
  }
}

function safeIncidents(projectDir: string): Incident[] {
  if (!storeExists()) return [];
  try {
    return runOpsCheck({ projectDir });
  } catch {
    return [];
  }
}

/** Resolve a referenced ticket, distinguishing three outcomes the caller must never
 *  conflate: an actually-absent ticket is `missing`; a ticket that exists but whose
 *  read fails (or whose very existence can't be determined) is `unreadable` — an error
 *  state, NOT missing; anything else is its real status/title. Pure over its injected
 *  probes so the branch logic is testable without a store. */
export function resolveTicketRef(
  id: string,
  exists: () => boolean,
  read: () => { status: TicketStatus; title: string | null },
): OrientResolvedTicket {
  let present: boolean;
  try {
    present = exists();
  } catch {
    return { id, status: "unreadable", title: null };
  }
  if (!present) return { id, status: "missing", title: null };
  try {
    const t = read();
    return { id, status: t.status, title: t.title };
  } catch {
    return { id, status: "unreadable", title: null };
  }
}

function safeResolveTicket(projectDir: string, id: string): OrientResolvedTicket {
  return resolveTicketRef(
    id,
    () => ticketExists(projectDir, id),
    () => readTicket(projectDir, id),
  );
}

function resolveProjectFacts(projectDir: string): OrientSnapshot["project"] {
  const fallback: OrientSnapshot["project"] = {
    key: null,
    name: basename(projectDir),
    path: projectDir,
    lastActivity: null,
    liveSessions: 0,
    inFlight: 0,
  };
  try {
    const match = findProject(projectDir, listProjects());
    if (!match) return fallback;
    return {
      key: match.key,
      name: match.label,
      path: match.projectDir,
      lastActivity: match.lastRunAt ?? null,
      liveSessions: match.liveSessions,
      inFlight: match.inFlightCount,
    };
  } catch {
    return fallback;
  }
}

function basename(p: string): string {
  const parts = p.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || p;
}

/** Assemble the snapshot for a project by doing the read-only reads and handing
 *  them to the pure projection. Never throws for a caller: every source degrades to
 *  an empty/absent value rather than crashing orientation. */
export function buildOrientSnapshot(projectDir: string): OrientSnapshot {
  const prefix = safePrefix(projectDir);
  return projectOrientSnapshot({
    project: resolveProjectFacts(projectDir),
    notesText: readNotes(projectDir),
    activeIds: safeActiveIds(projectDir),
    resolveTicket: (id) => safeResolveTicket(projectDir, id),
    incidents: safeIncidents(projectDir),
    prefix,
  });
}
