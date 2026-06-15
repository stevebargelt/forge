// forge backlog — operations layer.
//
// Pure functions over the Backlog model. The CLI commands wrap these; tests
// hit these directly with synthetic backlogs.
//
// Read ops never mutate. Write ops return a new Backlog (new sections Map
// + Tickets); the original is untouched. Persistence is the caller's job.

import { type Backlog, type SectionName, type Ticket, SECTION_ORDER } from "./types.js";

// ----- read -----

export type ListFilter = {
  /** Limit to one section, or a status alias. */
  status?: "active" | "done" | SectionName;
  /** Substring search across title + body. Case-insensitive. */
  search?: string;
};

export function listTickets(b: Backlog, filter: ListFilter = {}): Ticket[] {
  const wanted = sectionsForFilter(filter.status);
  const out: Ticket[] = [];
  for (const name of wanted) {
    for (const t of b.sections.get(name) ?? []) {
      if (filter.search && !ticketMatches(t, filter.search)) continue;
      out.push(t);
    }
  }
  return out;
}

function sectionsForFilter(status?: ListFilter["status"]): SectionName[] {
  if (!status) return [...SECTION_ORDER];
  if (status === "active") return ["Active", "In progress"];
  if (status === "done") return ["Done (recent)", "Done (archived)"];
  return [status];
}

function ticketMatches(t: Ticket, query: string): boolean {
  const q = query.toLowerCase();
  return t.title.toLowerCase().includes(q) || t.body.toLowerCase().includes(q);
}

export function findTicket(b: Backlog, id: number): Ticket | undefined {
  for (const tickets of b.sections.values()) {
    const hit = tickets.find((t) => t.id === id);
    if (hit) return hit;
  }
  return undefined;
}

/** Highest sticky ID currently in use across all sections. Used to pick the
 *  next id for `forge backlog file`. */
export function maxTicketId(b: Backlog): number {
  let max = 0;
  for (const tickets of b.sections.values()) {
    for (const t of tickets) if (t.id > max) max = t.id;
  }
  return max;
}

// ----- write -----

/** Append a new ticket to a section. Returns a new Backlog. */
export function addTicket(b: Backlog, ticket: Ticket): Backlog {
  const nextSections = cloneSections(b.sections);
  const list = [...(nextSections.get(ticket.section) ?? []), ticket];
  nextSections.set(ticket.section, list);
  return { ...b, sections: nextSections };
}

/** Move a ticket to a different section. The ticket keeps its body. Throws
 *  if the ticket is not found. Returns a new Backlog. */
export function moveTicket(b: Backlog, id: number, to: SectionName): Backlog {
  const current = findTicket(b, id);
  if (!current) throw new Error(`Ticket #${id} not found`);
  if (current.section === to) return b;

  const nextSections = cloneSections(b.sections);
  // Remove from old section.
  const fromList = (nextSections.get(current.section) ?? []).filter((t) => t.id !== id);
  nextSections.set(current.section, fromList);
  // Add to new section (at the top — Done items go to the top of "Done
  // (recent)" per the existing convention).
  const toList = [{ ...current, section: to }, ...(nextSections.get(to) ?? [])];
  nextSections.set(to, toList);

  return { ...b, sections: nextSections };
}

/** Convenience: close a ticket = move to Done (recent), optionally prepending
 *  a "Closed: <date>" line + commit hash note to the body. Returns a new Backlog. */
export function closeTicket(b: Backlog, id: number, opts: { commitSha?: string; date?: string } = {}): Backlog {
  const moved = moveTicket(b, id, "Done (recent)");
  // Decorate the moved ticket's body with a closed-line if not already present.
  const target = findTicket(moved, id)!;
  const date = opts.date ?? new Date().toISOString().slice(0, 10);
  const commitNote = opts.commitSha ? ` Commit \`${opts.commitSha}\`.` : "";
  const closedLine = `**Closed:** ${date}.${commitNote}\n\n`;
  // Only prepend if the body doesn't already start with "**Closed:**".
  const newBody = target.body.startsWith("**Closed:**")
    ? target.body
    : closedLine + target.body;
  return replaceTicket(moved, id, { ...target, body: newBody });
}

/** Replace a ticket in-place (same id). Returns a new Backlog. */
function replaceTicket(b: Backlog, id: number, updated: Ticket): Backlog {
  const nextSections = cloneSections(b.sections);
  const list = (nextSections.get(updated.section) ?? []).map((t) => (t.id === id ? updated : t));
  nextSections.set(updated.section, list);
  return { ...b, sections: nextSections };
}

/** Replace a ticket's body in-place. Returns a new Backlog. */
export function updateTicketBody(b: Backlog, id: number, body: string): Backlog {
  const ticket = findTicket(b, id);
  if (!ticket) throw new Error(`Ticket #${id} not found`);
  return replaceTicket(b, id, { ...ticket, body });
}

/** Replace the Notes block. Returns a new Backlog. */
export function setNotes(b: Backlog, notes: string): Backlog {
  return { ...b, notes };
}

/** Append text to the existing Notes block. Adds a separating blank line
 *  if the existing notes don't already end with one. */
export function appendNotes(b: Backlog, entry: string): Backlog {
  const existing = b.notes;
  const sep = existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
  return { ...b, notes: existing + sep + entry + (entry.endsWith("\n") ? "" : "\n") };
}

function cloneSections(m: Map<SectionName, Ticket[]>): Map<SectionName, Ticket[]> {
  const out = new Map<SectionName, Ticket[]>();
  for (const [k, v] of m) out.set(k, [...v]);
  return out;
}
