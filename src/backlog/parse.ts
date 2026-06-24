// forge backlog — legacy BACKLOG.md parser. Used only by backlog-migrate.
//
// Format expectations:
//   - First content: `# forge — backlog` (top-level heading) + intro paragraph
//   - Section headings: lines starting with `## ` (e.g. `## Active`)
//   - Ticket headings: `### #<id> — <title>` (em dash separator)
//   - Everything else is body content owned by whatever heading came before
//
// The parser keeps body content as raw markdown — no interpretation of
// inner structure (lists, code blocks, formatting).

import { type Backlog, type SectionName, type Ticket, SECTION_ORDER } from "./types.js";

const NOTES_HEADING = "## Notes for next session";
const TICKET_HEADING_RE = /^### #(\d+) — (.+)$/;
const SECTION_HEADING_RE = /^## (.+)$/;

const KNOWN_SECTION_NAMES = new Set<string>([...SECTION_ORDER, "Notes for next session"]);

function isKnownSectionHeading(line: string): boolean {
  const m = SECTION_HEADING_RE.exec(line);
  return m !== null && KNOWN_SECTION_NAMES.has(m[1]!);
}

export function parseBacklog(content: string): Backlog {
  const lines = content.split("\n");

  // 1. Find the Notes heading; everything before it is preamble.
  let notesStart = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === NOTES_HEADING) {
      notesStart = i;
      break;
    }
  }
  if (notesStart === -1) {
    throw new Error(`BACKLOG: '${NOTES_HEADING}' heading not found`);
  }
  // Preamble = lines 0..notesStart-1 joined back together. Preserve trailing
  // newline (these lines had \n between them in the original).
  const preamble = lines.slice(0, notesStart).join("\n");

  // 2. Find the first section heading after Notes (typically `## Active`).
  let firstSectionStart = -1;
  for (let i = notesStart + 1; i < lines.length; i++) {
    if (isKnownSectionHeading(lines[i]!) && lines[i] !== NOTES_HEADING) {
      firstSectionStart = i;
      break;
    }
  }
  // Notes body = lines between the Notes heading line and the first section
  // (exclusive of both). If no section follows, Notes runs to EOF.
  const notesEnd = firstSectionStart === -1 ? lines.length : firstSectionStart;
  const notes = lines.slice(notesStart + 1, notesEnd).join("\n");

  // 3. Walk sections. Each `## <Name>` opens a section; tickets inside are
  //    `### #<id> — <title>` blocks. Anything between a section heading and
  //    its first ticket heading is captured as sectionPrelude — preserves
  //    placeholder content like Done (archived)'s "(Nothing here yet...)".
  const sections: Map<SectionName, Ticket[]> = new Map();
  const sectionPrelude: Map<SectionName, string> = new Map();
  for (const name of SECTION_ORDER) {
    sections.set(name, []);
    sectionPrelude.set(name, "");
  }

  let cursor = firstSectionStart;
  while (cursor !== -1 && cursor < lines.length) {
    const headerLine = lines[cursor]!;
    const m = SECTION_HEADING_RE.exec(headerLine);
    if (!m) break;
    const sectionName = m[1]! as SectionName;
    if (!SECTION_ORDER.includes(sectionName)) {
      cursor = findNextSection(lines, cursor + 1);
      continue;
    }

    const sectionEnd = findNextSection(lines, cursor + 1);
    const sectionLines = lines.slice(cursor + 1, sectionEnd === -1 ? lines.length : sectionEnd);

    // Find the first ticket heading. Everything before it is prelude; after
    // it is tickets.
    let firstTicketIdx = -1;
    for (let i = 0; i < sectionLines.length; i++) {
      if (TICKET_HEADING_RE.test(sectionLines[i]!)) { firstTicketIdx = i; break; }
    }

    if (firstTicketIdx === -1) {
      // No tickets in this section — whole body is prelude. Preserve it.
      sectionPrelude.set(sectionName, sectionLines.join("\n"));
    } else {
      const preludeLines = sectionLines.slice(0, firstTicketIdx);
      sectionPrelude.set(sectionName, preludeLines.join("\n"));
      const ticketLines = sectionLines.slice(firstTicketIdx);
      const tickets = parseTicketsInSection(ticketLines, sectionName);
      sections.set(sectionName, tickets);
    }

    cursor = sectionEnd;
  }

  return { preamble, notes, sections, sectionPrelude };
}

function findNextSection(lines: string[], from: number): number {
  for (let i = from; i < lines.length; i++) {
    if (isKnownSectionHeading(lines[i]!)) return i;
  }
  return -1;
}

function parseTicketsInSection(sectionLines: string[], section: SectionName): Ticket[] {
  const tickets: Ticket[] = [];

  // Find each `### #N — ...` heading. Body for ticket N is everything from
  // the line *after* its heading up to (but not including) the next ticket
  // heading.
  const ticketStarts: number[] = [];
  for (let i = 0; i < sectionLines.length; i++) {
    if (TICKET_HEADING_RE.test(sectionLines[i]!)) ticketStarts.push(i);
  }

  for (let k = 0; k < ticketStarts.length; k++) {
    const headIdx = ticketStarts[k]!;
    const nextHeadIdx = ticketStarts[k + 1] ?? sectionLines.length;
    const headerLine = sectionLines[headIdx]!;
    const m = TICKET_HEADING_RE.exec(headerLine);
    if (!m) continue; // unreachable

    const id = parseInt(m[1]!, 10);
    const title = m[2]!;
    const bodyLines = sectionLines.slice(headIdx + 1, nextHeadIdx);
    const body = bodyLines.join("\n");

    tickets.push({ id, title, section, body });
  }

  return tickets;
}
