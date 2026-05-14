// forge backlog — types.
//
// BACKLOG.md is parsed into a Backlog model: preamble + Notes block + a list
// of sections, each holding ordered Tickets. The body of every ticket and
// the Notes block are kept as raw markdown strings — the parser doesn't
// interpret the structure inside a ticket body (lists, code blocks, etc.).
// That keeps the parser small and lets humans freely edit body content.

export type SectionName = "Active" | "In progress" | "Done (recent)" | "Done (archived)";

export const SECTION_ORDER: SectionName[] = [
  "Active",
  "In progress",
  "Done (recent)",
  "Done (archived)",
];

export type Ticket = {
  /** Sticky ID without the leading `#`. */
  id: number;
  /** Heading text after "— " (em dash). */
  title: string;
  /** Which section this ticket lives in. */
  section: SectionName;
  /** Raw markdown body. Everything between the heading line and the next ticket
   *  or section header. Includes leading/trailing whitespace as-written so we
   *  can roundtrip the file byte-for-byte. */
  body: string;
};

export type Backlog = {
  /** Everything from the start of the file up to (but not including) the
   *  `## Notes for next session` heading. Includes the top-level `# forge —
   *  backlog` heading and the intro paragraph. */
  preamble: string;
  /** Raw markdown of the Notes section body (after the heading line, up to
   *  the next `## ` heading). */
  notes: string;
  /** Tickets keyed by section. Insertion order matches the file order. */
  sections: Map<SectionName, Ticket[]>;
  /** Optional markdown content that appears in a section after the section
   *  heading but before any tickets (or, for empty sections, the entire
   *  section body). Used to preserve placeholder text like "Done (archived)"
   *  having a "(Nothing here yet...)" note. Keyed by section name. */
  sectionPrelude: Map<SectionName, string>;
};
