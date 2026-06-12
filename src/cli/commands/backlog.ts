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
import { existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { readBacklogConfig } from "../../backlog/config.js";
import { readBacklog, writeBacklog } from "../../backlog/io.js";
import { addTicket, appendNotes, closeTicket, findTicket, listTickets, maxTicketId, moveTicket, setNotes } from "../../backlog/ops.js";
import { type SectionName, SECTION_ORDER, type Ticket } from "../../backlog/types.js";
import {
  generateSlug,
  listTickets as listStructuredTickets,
  moveTicket as moveStructuredTicket,
  readTicket,
  writeTicket,
  type TicketType,
  type TicketStatus,
  type StructuredTicket,
} from "../../backlog/structured.js";

export type BacklogFormat = "legacy" | "structured";

export function detectBacklogFormat(projectDir: string): BacklogFormat {
  if (existsSync(join(projectDir, "backlog"))) return "structured";
  if (existsSync(join(projectDir, "BACKLOG.md"))) return "legacy";
  throw new Error(`No backlog found in ${projectDir}. Expected a backlog/ directory or BACKLOG.md.`);
}

export function registerBacklog(program: Command): void {
  const backlog = program
    .command("backlog")
    .description("List, file, close, and move BACKLOG.md tickets without reading the whole file");

  // ----- list -----
  backlog
    .command("list")
    .description("List tickets, optionally filtered by status or search text")
    .option("--status <s>", "active | done | blocked | deferred | Active | 'In progress' | 'Done (recent)' | 'Done (archived)'")
    .option("--type <t>", "(structured) idea | epic | story")
    .option("--search <text>", "case-insensitive substring match against title + body")
    .option("--json", "emit JSON instead of human-readable summary")
    .option("--project <dir>", "project directory (default: cwd)")
    .action((opts: { status?: string; type?: string; search?: string; json?: boolean; project?: string }) => {
      const dir = resolve(opts.project ?? process.cwd());
      const format = detectBacklogFormat(dir);

      if (format === "structured") {
        const tickets = listStructuredTickets(dir, {
          ...(opts.type ? { type: opts.type as TicketType } : {}),
          ...(opts.status ? { status: opts.status as TicketStatus } : {}),
        });
        if (opts.json) {
          console.log(JSON.stringify(
            tickets.map((t) => ({ id: t.id, type: t.type, status: t.status, title: t.title })),
            null, 2,
          ));
          return;
        }
        if (tickets.length === 0) {
          console.log("(no matching tickets)");
          return;
        }
        for (const t of tickets) {
          console.log(`  ${t.id}  [${t.type}/${t.status}]  ${t.title}`);
        }
        return;
      }

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
    .argument("<id>", "sticky ticket id (with or without # prefix, or FG-NNN)")
    .description("Print one ticket: heading + body")
    .option("--json", "emit JSON {id, title, section, body}")
    .option("--project <dir>", "project directory (default: cwd)")
    .action((idArg: string, opts: { json?: boolean; project?: string }) => {
      const dir = resolve(opts.project ?? process.cwd());
      const format = detectBacklogFormat(dir);

      if (format === "structured") {
        const ticket = readTicket(dir, idArg);
        if (opts.json) {
          console.log(JSON.stringify(ticket, null, 2));
          return;
        }
        console.log(`### ${ticket.id} — ${ticket.title}`);
        console.log(`(${ticket.type}/${ticket.status})`);
        console.log("");
        console.log(ticket.body.trimEnd());
        return;
      }

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
    .option("--type <t>", "(structured) idea | epic | story (default: story)", "story")
    .option("--project <dir>", "project directory (default: cwd)")
    .action((title: string, opts: { body?: string; section?: string; type?: string; project?: string }) => {
      const dir = resolve(opts.project ?? process.cwd());
      const format = detectBacklogFormat(dir);

      if (format === "structured") {
        const config = readBacklogConfig(dir);
        const prefix = config.prefix ?? "FG";
        const existing = listStructuredTickets(dir);
        const nextNum = existing.reduce((max, t) => {
          const m = t.id.match(/^[A-Z]+-(\d+)$/);
          const n = m ? parseInt(m[1]!, 10) : 0;
          return Math.max(max, n);
        }, 0) + 1;
        const id = `${prefix}-${nextNum}`;
        const bodyRaw = readBodyArg(opts.body);
        const ticket: StructuredTicket = {
          id,
          type: (opts.type as TicketType) ?? "story",
          status: "active",
          title,
          body: bodyRaw,
          created: new Date().toISOString().slice(0, 10),
        };
        writeTicket(dir, ticket);
        console.log(`Created ${id} in stories/${generateSlug(title)}: ${title}`);
        return;
      }

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
    .argument("<id>", "sticky ticket id (or FG-NNN for structured)")
    .description("Move a ticket to Done (recent) and prepend a Closed line")
    .option("--commit <sha>", "commit hash recorded in the Closed line")
    .option("--project <dir>", "project directory (default: cwd)")
    .action((idArg: string, opts: { commit?: string; project?: string }) => {
      const dir = resolve(opts.project ?? process.cwd());
      const format = detectBacklogFormat(dir);

      if (format === "structured") {
        const ticket = readTicket(dir, idArg);
        const updated: StructuredTicket = {
          ...ticket,
          status: "done",
          closed: new Date().toISOString().slice(0, 10),
        };
        writeTicket(dir, updated);
        // Remove original active file (it may be in a type subdir)
        for (const sub of ["stories", "epics", "ideas"]) {
          const d = join(dir, "backlog", sub);
          if (!existsSync(d)) continue;
          for (const f of readdirSync(d)) {
            if (f.startsWith(`${idArg}-`)) unlinkSync(join(d, f));
          }
        }
        console.log(`Closed ${idArg}`);
        return;
      }

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
    .argument("<id>", "sticky ticket id (or FG-NNN for structured)")
    .argument("<section>", "legacy: Active | 'In progress' | 'Done (recent)' | 'Done (archived)'; structured: idea | epic | story")
    .description("Relocate a ticket to a different section (legacy) or type directory (structured)")
    .option("--project <dir>", "project directory (default: cwd)")
    .action((idArg: string, sectionArg: string, opts: { project?: string }) => {
      const dir = resolve(opts.project ?? process.cwd());
      const format = detectBacklogFormat(dir);

      if (format === "structured") {
        moveStructuredTicket(dir, idArg, sectionArg as TicketType);
        console.log(`Moved ${idArg} → ${sectionArg}`);
        return;
      }

      const id = parseTicketId(idArg);
      const section = validateSection(sectionArg);
      const b = readBacklog(dir);
      const next = moveTicket(b, id, section);
      writeBacklog(dir, next);
      console.log(`Moved #${id} → ${section}`);
    });

  // ----- config -----
  backlog
    .command("config")
    .description("Show backlog configuration")
    .option("--show", "print current prefix and format")
    .option("--project <dir>", "project directory (default: cwd)")
    .action((opts: { show?: boolean; project?: string }) => {
      const dir = resolve(opts.project ?? process.cwd());
      const config = readBacklogConfig(dir);
      const format = detectBacklogFormat(dir);
      console.log(`format: ${format}`);
      console.log(`prefix: ${config.prefix ?? "(none)"}`);
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
    .argument("[text]", "replacement text; use '-' or omit to read from stdin")
    .description("Replace the Notes block entirely")
    .option("--project <dir>", "project directory (default: cwd)")
    .action((textArg: string | undefined, opts: { project?: string }) => {
      const dir = resolve(opts.project ?? process.cwd());
      const text = !textArg || textArg === "-" ? readFileSync(0, "utf8") : textArg;
      if (text.trim().length === 0) throw new Error("notes replace: empty input");
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
