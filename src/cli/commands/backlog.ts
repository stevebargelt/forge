// forge backlog — thin CLI over BACKLOG.md.
//
// The point: callers (orchestrator, dashboard, agents) hit this CLI instead
// of reading + parsing 1700 lines of markdown. Orchestrator session start
// drops from ~57k tokens to ~2k.
//
// Verbs:
//   forge backlog list [--status active|done|<section>] [--search <text>] [--json]
//   forge backlog show <id> [--json]
//   forge backlog file "<title>" [--body -|<text>] [--section <name>]
//   forge backlog close <id> [--commit <sha>]
//   forge backlog move <id> <section>
//   forge backlog notes [show|add]
//
// Storage today: BACKLOG.md at the project root. Future: SQLite-backed.
// Callers never need to know.

import type { Command } from "commander";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readBacklog, writeBacklog } from "../../backlog/io.js";
import { addTicket, appendNotes, closeTicket, findTicket, listTickets, maxTicketId, moveTicket, setNotes } from "../../backlog/ops.js";
import { type SectionName, SECTION_ORDER, type Ticket } from "../../backlog/types.js";

export function registerBacklog(program: Command): void {
  const backlog = program
    .command("backlog")
    .description("List, file, close, and move BACKLOG.md tickets without reading the whole file");

  // ----- list -----
  backlog
    .command("list")
    .description("List tickets, optionally filtered by status or search text")
    .option("--status <s>", "active | done | Active | 'In progress' | 'Done (recent)' | 'Done (archived)'")
    .option("--search <text>", "case-insensitive substring match against title + body")
    .option("--json", "emit JSON instead of human-readable summary")
    .option("--project <dir>", "project directory (default: cwd)")
    .action((opts: { status?: string; search?: string; json?: boolean; project?: string }) => {
      const dir = resolve(opts.project ?? process.cwd());
      const b = readBacklog(dir);
      const tickets = listTickets(b, {
        status: normalizeStatus(opts.status),
        ...(opts.search ? { search: opts.search } : {}),
      });

      if (opts.json) {
        console.log(JSON.stringify(
          tickets.map((t) => ({ id: t.id, title: t.title, section: t.section })),
          null, 2,
        ));
        return;
      }

      if (tickets.length === 0) {
        console.log("(no matching tickets)");
        return;
      }

      // Group by section for readability.
      const bySection = new Map<SectionName, Ticket[]>();
      for (const t of tickets) {
        const arr = bySection.get(t.section) ?? [];
        arr.push(t);
        bySection.set(t.section, arr);
      }
      for (const name of SECTION_ORDER) {
        const arr = bySection.get(name) ?? [];
        if (arr.length === 0) continue;
        console.log(`${name}:`);
        for (const t of arr) {
          console.log(`  #${t.id}  ${t.title}`);
        }
      }
    });

  // ----- show -----
  backlog
    .command("show")
    .argument("<id>", "sticky ticket id (with or without # prefix)")
    .description("Print one ticket: heading + body")
    .option("--json", "emit JSON {id, title, section, body}")
    .option("--project <dir>", "project directory (default: cwd)")
    .action((idArg: string, opts: { json?: boolean; project?: string }) => {
      const dir = resolve(opts.project ?? process.cwd());
      const id = parseTicketId(idArg);
      const b = readBacklog(dir);
      const ticket = findTicket(b, id);
      if (!ticket) throw new Error(`Ticket #${id} not found`);

      if (opts.json) {
        console.log(JSON.stringify(ticket, null, 2));
        return;
      }
      console.log(`### #${ticket.id} — ${ticket.title}`);
      console.log(`(${ticket.section})`);
      console.log("");
      console.log(ticket.body.trimEnd());
    });

  // ----- file (create a new ticket) -----
  backlog
    .command("file")
    .argument("<title>", "ticket title")
    .description("Create a new ticket in Active (or --section). Body via --body <text> or --body - (stdin).")
    .option("--body <text>", "ticket body markdown — use '-' to read from stdin")
    .option("--section <name>", "target section (default: Active)", "Active")
    .option("--project <dir>", "project directory (default: cwd)")
    .action((title: string, opts: { body?: string; section?: string; project?: string }) => {
      const dir = resolve(opts.project ?? process.cwd());
      const section = validateSection(opts.section ?? "Active");
      const bodyRaw = readBodyArg(opts.body);
      const body = bodyRaw.length > 0 ? ensureBodyTrailingBlank(bodyRaw) : "";

      const b = readBacklog(dir);
      const id = maxTicketId(b) + 1;
      const ticket: Ticket = { id, title, section, body };
      const next = addTicket(b, ticket);
      writeBacklog(dir, next);

      console.log(`Created #${id} in ${section}: ${title}`);
    });

  // ----- close -----
  backlog
    .command("close")
    .argument("<id>", "sticky ticket id")
    .description("Move a ticket to Done (recent) and prepend a Closed line")
    .option("--commit <sha>", "commit hash recorded in the Closed line")
    .option("--project <dir>", "project directory (default: cwd)")
    .action((idArg: string, opts: { commit?: string; project?: string }) => {
      const dir = resolve(opts.project ?? process.cwd());
      const id = parseTicketId(idArg);
      const b = readBacklog(dir);
      if (!findTicket(b, id)) throw new Error(`Ticket #${id} not found`);
      const next = closeTicket(b, id, opts.commit ? { commitSha: opts.commit } : {});
      writeBacklog(dir, next);
      console.log(`Closed #${id}${opts.commit ? ` (${opts.commit})` : ""}`);
    });

  // ----- move -----
  backlog
    .command("move")
    .argument("<id>", "sticky ticket id")
    .argument("<section>", "target section: Active | 'In progress' | 'Done (recent)' | 'Done (archived)'")
    .description("Relocate a ticket to a different section")
    .option("--project <dir>", "project directory (default: cwd)")
    .action((idArg: string, sectionArg: string, opts: { project?: string }) => {
      const dir = resolve(opts.project ?? process.cwd());
      const id = parseTicketId(idArg);
      const section = validateSection(sectionArg);
      const b = readBacklog(dir);
      const next = moveTicket(b, id, section);
      writeBacklog(dir, next);
      console.log(`Moved #${id} → ${section}`);
    });

  // ----- notes -----
  const notes = backlog
    .command("notes")
    .description("Read or append the Notes-for-next-session block");

  notes
    .command("show")
    .description("Print the current Notes block")
    .option("--project <dir>", "project directory (default: cwd)")
    .action((opts: { project?: string }) => {
      const dir = resolve(opts.project ?? process.cwd());
      const b = readBacklog(dir);
      process.stdout.write(b.notes);
    });

  notes
    .command("add")
    .argument("[text]", "text to append; use '-' or omit to read from stdin")
    .description("Append a paragraph to the Notes block")
    .option("--project <dir>", "project directory (default: cwd)")
    .action((textArg: string | undefined, opts: { project?: string }) => {
      const dir = resolve(opts.project ?? process.cwd());
      const text = !textArg || textArg === "-" ? readFileSync(0, "utf8") : textArg;
      if (text.trim().length === 0) throw new Error("notes add: empty input");
      const b = readBacklog(dir);
      const next = appendNotes(b, text.trim());
      writeBacklog(dir, next);
      console.log("Notes updated.");
    });

  notes
    .command("replace")
    .description("Replace the Notes block entirely (reads from stdin)")
    .option("--project <dir>", "project directory (default: cwd)")
    .action((opts: { project?: string }) => {
      const dir = resolve(opts.project ?? process.cwd());
      const text = readFileSync(0, "utf8");
      const b = readBacklog(dir);
      const next = setNotes(b, text.endsWith("\n") ? text : text + "\n");
      writeBacklog(dir, next);
      console.log("Notes replaced.");
    });
}

function parseTicketId(arg: string): number {
  const cleaned = arg.startsWith("#") ? arg.slice(1) : arg;
  const n = parseInt(cleaned, 10);
  if (Number.isNaN(n) || n <= 0) throw new Error(`invalid ticket id: ${arg}`);
  return n;
}

function normalizeStatus(status: string | undefined): "active" | "done" | SectionName | undefined {
  if (!status) return undefined;
  if (status === "active" || status === "done") return status;
  return validateSection(status);
}

function validateSection(name: string): SectionName {
  if (!SECTION_ORDER.includes(name as SectionName)) {
    throw new Error(`unknown section '${name}'. Valid: ${SECTION_ORDER.join(", ")}`);
  }
  return name as SectionName;
}

function readBodyArg(body: string | undefined): string {
  if (!body) return "";
  if (body === "-") return readFileSync(0, "utf8");
  return body;
}

/** Tickets in the file have bodies that end with at least one blank line —
 *  this is what makes the next `### #N` heading look right. Make sure the
 *  body we're inserting ends that way. */
function ensureBodyTrailingBlank(body: string): string {
  const trimmedTrailing = body.replace(/\n+$/, "");
  return trimmedTrailing + "\n\n";
}
