// forge backlog — skeleton generator.
//
// Produces the starter BACKLOG.md that `forge init` writes when a project has
// none. Built from the Backlog model and run through the serializer so the
// skeleton is guaranteed to satisfy the parser (which throws if the
// `## Notes for next session` heading is missing) and to round-trip cleanly —
// no hand-maintained markdown that could drift from parse/serialize.

import { serializeBacklog } from "./serialize.js";
import { SECTION_ORDER, type Backlog, type SectionName, type Ticket } from "./types.js";

const PREAMBLE = [
  "# forge — backlog",
  "",
  "Canonical task list for this project. Numbers are sticky across sessions and referenced from commit messages (e.g. `fixes #3`, `partial #5`). New items get the next available sticky ID and never get renumbered.",
  "",
  "Manage this file with the `forge backlog` CLI (`list`, `show`, `file`, `close`, `move`, `notes`) rather than editing it by hand — same data, far less context to load.",
].join("\n");

const STARTER_NOTES =
  "_No sessions recorded yet. When you finish a session, run `forge backlog notes replace` (or `/handoff`) to leave the next session a narrative handoff here._\n";

const ACTIVE_PLACEHOLDER =
  "\n_No active tickets yet. File the first one with `forge backlog file \"<title>\"`._\n";

// The starter BACKLOG.md content for a project that doesn't have one yet.
export function skeletonBacklogContent(): string {
  const sections = new Map<SectionName, Ticket[]>();
  const sectionPrelude = new Map<SectionName, string>();
  for (const name of SECTION_ORDER) {
    sections.set(name, []);
    sectionPrelude.set(name, "");
  }
  // Give Active a placeholder so the section renders — the serializer omits
  // sections that have neither tickets nor prelude.
  sectionPrelude.set("Active", ACTIVE_PLACEHOLDER);

  const backlog: Backlog = {
    preamble: PREAMBLE,
    notes: STARTER_NOTES,
    sections,
    sectionPrelude,
  };
  return serializeBacklog(backlog);
}
