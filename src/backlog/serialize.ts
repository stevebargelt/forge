// forge backlog — serializer.
//
// Inverse of parse. Joins preamble + Notes block + sections + tickets back
// into a single string.
//
// Roundtrip invariant: serialize(parse(original)) === original. The parser
// preserves whitespace inside bodies (including trailing blank lines), so
// the serializer just joins pieces together with no extra spacing logic.
//
// Wire format (matching the existing BACKLOG.md):
//   <preamble>\n
//   ## Notes for next session\n
//   <notes>\n
//   ## <Section>\n
//   <ticket headings + bodies for that section>
//   ## <Next Section>\n
//   ...
//
// Empty sections (no tickets) are omitted — keeps the file lean.

import { type Backlog, SECTION_ORDER } from "./types.js";

const NOTES_HEADING = "## Notes for next session";

export function serializeBacklog(b: Backlog): string {
  const parts: string[] = [];

  // Preamble already ends with its own \n in practice. We re-add the trailing
  // newline that was implicit in the split('\n') round-trip.
  parts.push(b.preamble);
  parts.push("\n");

  parts.push(NOTES_HEADING);
  parts.push("\n");
  parts.push(b.notes);

  // Emit each section: heading + optional prelude (placeholder text for
  // empty sections like "Done (archived)") + tickets. Sections with no
  // tickets AND no prelude are skipped to keep the file lean.
  for (const sectionName of SECTION_ORDER) {
    const tickets = b.sections.get(sectionName) ?? [];
    const prelude = b.sectionPrelude.get(sectionName) ?? "";
    if (tickets.length === 0 && prelude.length === 0) continue;

    parts.push("\n");
    parts.push(`## ${sectionName}`);
    parts.push("\n");
    if (prelude.length > 0) {
      parts.push(prelude);
    }
    for (const t of tickets) {
      // Bodies include their own trailing blank line; we just concatenate.
      parts.push("\n");
      parts.push(`### #${t.id} — ${t.title}`);
      parts.push("\n");
      parts.push(t.body);
    }
  }

  return parts.join("");
}
