// forge backlog — CLI over the structured backlog/ directory.
//
// Verbs:
//   forge backlog list [--status active|done|...] [--search <text>] [--json]
//   forge backlog show <id> [--json]
//   forge backlog file "<title>" [--body -|<text>] [--type <t>]
//   forge backlog close <id> [--commit <sha>]
//   forge backlog move <id> <type>
//   forge backlog edit <id> [--body -|<text>]
//   forge backlog retitle <id> "<new title>"
//   forge backlog notes [show|add|replace]
//   forge backlog config [--show]

import type { Command } from "commander";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readBacklogConfig } from "../../backlog/config.js";
import { importBacklog, BacklogImportError } from "../../store/backlog-import.js";
import {
  ProjectIdentityConflictError,
} from "../../store/project-registry.js";
import {
  closeTicket as closeStructuredTicket,
  generateSlug,
  listTickets as listStructuredTickets,
  moveTicket as moveStructuredTicket,
  readTicket,
  retitleTicket,
  ticketExists,
  withBacklogLock,
  writeTicket,
  TYPE_DIRS,
  type TicketType,
  type TicketStatus,
  type StructuredTicket,
} from "../../backlog/structured.js";

export function registerBacklog(program: Command): void {
  const backlog = program
    .command("backlog")
    .description("List, file, close, and move structured backlog/ tickets");

  // ----- list -----
  backlog
    .command("list")
    .description("List tickets, optionally filtered by status or search text")
    .option("--status <s>", "active | done | blocked | deferred")
    .option("--type <t>", "idea | epic | story")
    .option("--search <text>", "case-insensitive substring match against title + body")
    .option("--json", "emit JSON instead of human-readable summary")
    .option("--project <dir>", "project directory (default: cwd)")
    .action((opts: { status?: string; type?: string; search?: string; json?: boolean; project?: string }) => {
      const dir = resolve(opts.project ?? process.cwd());
      const tickets = listStructuredTickets(dir, {
        ...(opts.type ? { type: opts.type as TicketType } : {}),
        ...(opts.status ? { status: opts.status as TicketStatus } : {}),
        ...(opts.search ? { search: opts.search } : {}),
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
    });

  // ----- show -----
  backlog
    .command("show")
    .argument("<id>", "ticket id (e.g. FG-123)")
    .description("Print one ticket: heading + body")
    .option("--json", "emit JSON {id, type, status, title, body}")
    .option("--project <dir>", "project directory (default: cwd)")
    .action((idArg: string, opts: { json?: boolean; project?: string }) => {
      const dir = resolve(opts.project ?? process.cwd());
      const ticket = readTicket(dir, idArg);
      if (opts.json) {
        console.log(JSON.stringify(ticket, null, 2));
        return;
      }
      console.log(`### ${ticket.id} — ${ticket.title}`);
      console.log(`(${ticket.type}/${ticket.status})`);
      console.log("");
      console.log(ticket.body.trimEnd());
    });

  // ----- file (create a new ticket) -----
  backlog
    .command("file")
    .argument("<title>", "ticket title")
    .description("Create a new ticket. Body via --body <text> or --body - (stdin).")
    .option("--body <text>", "ticket body markdown — use '-' to read from stdin")
    .option("--type <t>", "idea | epic | story (default: story)", "story")
    .option("--project <dir>", "project directory (default: cwd)")
    .action((title: string, opts: { body?: string; type?: string; project?: string }) => {
      const dir = resolve(opts.project ?? process.cwd());
      const config = readBacklogConfig(dir);
      const prefix = config.prefix ?? "FG";
      // Read stdin before acquiring the lock (stdin reads must not block inside a critical section)
      const bodyRaw = readBodyArg(opts.body);
      const id = withBacklogLock(dir, () => {
        const existing = listStructuredTickets(dir);
        const nextNum = existing.reduce((max, t) => {
          const m = t.id.match(/^[A-Z]+-(\d+)$/);
          const n = m ? parseInt(m[1]!, 10) : 0;
          return Math.max(max, n);
        }, 0) + 1;
        const newId = `${prefix}-${nextNum}`;
        if (ticketExists(dir, newId)) {
          throw new Error(
            `Ticket ${newId} already exists on disk; refusing to create a duplicate (dedupe by id)`,
          );
        }
        const ticket: StructuredTicket = {
          id: newId,
          type: (opts.type as TicketType) ?? "story",
          status: "active",
          title,
          body: bodyRaw,
          created: new Date().toISOString().slice(0, 10),
        };
        writeTicket(dir, ticket);
        return newId;
      });
      const subdir = TYPE_DIRS[(opts.type as TicketType) ?? "story"];
      console.log(`Created ${id} in ${subdir}/${generateSlug(title)}: ${title}`);
    });

  // ----- close -----
  backlog
    .command("close")
    .argument("<id>", "ticket id (e.g. FG-123)")
    .description("Mark a ticket done and record the close date")
    .option("--commit <sha>", "commit hash to record")
    .option("--project <dir>", "project directory (default: cwd)")
    .action((idArg: string, opts: { commit?: string; project?: string }) => {
      const dir = resolve(opts.project ?? process.cwd());
      closeStructuredTicket(dir, idArg, opts.commit);
      console.log(`Closed ${idArg}`);
    });

  // ----- edit -----
  backlog
    .command("edit")
    .argument("<id>", "ticket id (e.g. FG-123)")
    .description("Edit an existing ticket's body")
    .option("--body <text>", "replacement body — use '-' to read from stdin")
    .option("--project <dir>", "project directory (default: cwd)")
    .action((idArg: string, opts: { body?: string; project?: string }) => {
      const dir = resolve(opts.project ?? process.cwd());
      const bodyRaw = readBodyArg(opts.body);
      const ticket = readTicket(dir, idArg);
      const updated = { ...ticket, body: bodyRaw };
      writeTicket(dir, updated);
      console.log(`Updated body of ${idArg}`);
    });

  // ----- retitle -----
  backlog
    .command("retitle")
    .argument("<id>", "ticket id (e.g. FG-123)")
    .argument("<title>", "new ticket title")
    .description("Change a ticket's title (frontmatter + heading) without moving its file")
    .option("--project <dir>", "project directory (default: cwd)")
    .action((idArg: string, title: string, opts: { project?: string }) => {
      const dir = resolve(opts.project ?? process.cwd());
      retitleTicket(dir, idArg, title);
      console.log(`Retitled ${idArg}`);
    });

  // ----- move -----
  backlog
    .command("move")
    .argument("<id>", "ticket id (e.g. FG-123)")
    .argument("<type>", "idea | epic | story")
    .description("Move a ticket to a different type directory")
    .option("--project <dir>", "project directory (default: cwd)")
    .action((idArg: string, typeArg: string, opts: { project?: string }) => {
      const dir = resolve(opts.project ?? process.cwd());
      moveStructuredTicket(dir, idArg, typeArg as TicketType);
      console.log(`Moved ${idArg} → ${typeArg}`);
    });

  // ----- import (FG-606) -----
  backlog
    .command("import")
    .description(
      "Populate the DB ticket shadow from backlog/*.md (non-authoritative; Markdown stays source of truth)",
    )
    .option("--project <dir>", "project directory (default: cwd)")
    .option("--json", "emit JSON result")
    .action((opts: { project?: string; json?: boolean }) => {
      const dir = resolve(opts.project ?? process.cwd());
      if (!existsSync(join(dir, "backlog"))) {
        throw new Error(`No backlog found in ${dir}. Expected a backlog/ directory.`);
      }
      try {
        const result = importBacklog(dir);
        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log(
          `Imported ${result.ticketCount} ticket(s) into project_key ${result.projectKey}` +
            (result.persistedConfig ? " (recorded project_key in .forge/config.yml)" : ""),
        );
      } catch (e) {
        if (e instanceof ProjectIdentityConflictError) {
          // Stop-and-surface: never silently maintain two DB backlogs. The refusal
          // is load-bearing operator-visible safety output — on --json emit a
          // structured, machine-readable conflict object (both conflicting
          // identities + the reason) instead of a bare message, with the same
          // non-zero exit.
          if (opts.json) {
            console.log(
              JSON.stringify(
                {
                  status: "conflict",
                  error: "ProjectIdentityConflict",
                  reason: e.message,
                  detail: e.detail,
                },
                null,
                2,
              ),
            );
          } else {
            process.stderr.write(e.message + "\n");
          }
          process.exitCode = 1;
          return;
        }
        if (e instanceof BacklogImportError) {
          // A precise, file-identified refusal (malformed source file). All-or-
          // nothing atomic — zero rows written. Same structured shape on --json.
          if (opts.json) {
            console.log(
              JSON.stringify(
                {
                  status: "error",
                  error: "BacklogImport",
                  reason: e.message,
                  detail: { file: e.file, field: e.field },
                },
                null,
                2,
              ),
            );
          } else {
            process.stderr.write(e.message + "\n");
          }
          process.exitCode = 1;
          return;
        }
        throw e;
      }
    });

  // ----- config -----
  backlog
    .command("config")
    .description("Show backlog configuration")
    .option("--show", "print current prefix and format")
    .option("--project <dir>", "project directory (default: cwd)")
    .action((opts: { show?: boolean; project?: string }) => {
      const dir = resolve(opts.project ?? process.cwd());
      if (!existsSync(join(dir, "backlog"))) {
        throw new Error(`No backlog found in ${dir}. Expected a backlog/ directory.`);
      }
      const config = readBacklogConfig(dir);
      console.log(`format: structured`);
      console.log(`prefix: ${config.prefix ?? "(none)"}`);
    });

  // ----- notes -----
  const notes = backlog
    .command("notes")
    .description("Read or append the notes-for-next-session block");

  notes
    .command("show")
    .description("Print the current notes")
    .option("--project <dir>", "project directory (default: cwd)")
    .action((opts: { project?: string }) => {
      const dir = resolve(opts.project ?? process.cwd());
      const notesPath = join(dir, "backlog", "notes.md");
      if (!existsSync(notesPath)) {
        process.stdout.write("(no notes)\n");
        return;
      }
      process.stdout.write(readFileSync(notesPath, "utf8"));
    });

  notes
    .command("add")
    .argument("[text]", "text to append; use '-' or omit to read from stdin")
    .description("Append a paragraph to the notes")
    .option("--project <dir>", "project directory (default: cwd)")
    .action((textArg: string | undefined, opts: { project?: string }) => {
      const dir = resolve(opts.project ?? process.cwd());
      const text = !textArg || textArg === "-" ? readFileSync(0, "utf8") : textArg;
      if (text.trim().length === 0) throw new Error("notes add: empty input");
      const notesPath = join(dir, "backlog", "notes.md");
      const existing = existsSync(notesPath) ? readFileSync(notesPath, "utf8") : "";
      const separator = existing.length > 0 && !existing.endsWith("\n\n") ? "\n" : "";
      writeFileSync(notesPath, existing + separator + text.trim() + "\n");
      console.log("Notes updated.");
    });

  notes
    .command("replace")
    .argument("[text]", "replacement text; use '-' or omit to read from stdin")
    .description("Replace the notes entirely")
    .option("--project <dir>", "project directory (default: cwd)")
    .action((textArg: string | undefined, opts: { project?: string }) => {
      const dir = resolve(opts.project ?? process.cwd());
      const text = !textArg || textArg === "-" ? readFileSync(0, "utf8") : textArg;
      if (text.trim().length === 0) throw new Error("notes replace: empty input");
      const notesPath = join(dir, "backlog", "notes.md");
      mkdirSync(join(dir, "backlog"), { recursive: true });
      writeFileSync(notesPath, text.endsWith("\n") ? text : text + "\n");
      console.log("Notes replaced.");
    });
}

function readBodyArg(body: string | undefined): string {
  if (!body) return "";
  if (body === "-") return readFileSync(0, "utf8");
  return body;
}
