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
import { assertConfigWritable, readBacklogConfig, writeProjectKey } from "../../backlog/config.js";
import {
  clearBacklogStoreCache,
  describeBacklogStore,
  resolveBacklogStore,
} from "../../backlog/storage-mode.js";
import { importBacklog, requiredNextSeq, BacklogImportError } from "../../store/backlog-import.js";
import { writeTransaction } from "../../store/db.js";
import {
  computeRepositoryEvidence,
  ProjectIdentityClaimRaceError,
  ProjectIdentityConflictError,
  resolveAndClaimProjectKey,
} from "../../store/project-registry.js";
import {
  bumpIdSequence,
  ensureStorageMode,
  getIdSequence,
  getStorageMode,
  setStorageMode,
  ticketsForProject,
  type StorageMode,
} from "../../store/tickets.js";
import {
  closeTicket as closeStructuredTicket,
  fileNewTicket,
  generateSlug,
  listMarkdownTickets,
  listTickets as listStructuredTickets,
  moveTicket as moveStructuredTicket,
  readTicket,
  retitleTicket,
  writeTicket,
  TYPE_DIRS,
  type TicketType,
  type TicketStatus,
} from "../../backlog/structured.js";

export function registerBacklog(program: Command): void {
  const backlog = program
    .command("backlog")
    .description("List, file, close, and move structured backlog/ tickets");

  // FG-607: every invocation that reads a ticket store says which store it read.
  // stderr, so --json stdout stays machine-clean.
  //
  // Subcommands that never touch the seam are skipped rather than forced to
  // resolve: `notes` is pure backlog/notes.md and `config` is a pure config read,
  // and resolving for them would make a Markdown-only path pay for the resolver.
  //
  // `import` and `mode` are skipped for a different reason: they are the identity
  // REPAIR paths. Their own refusals (the identity ladder / the mode guards) are
  // the operator-facing output — a banner that resolved first would preempt them
  // with a less precise error and, on --json, with no structured object at all.
  const SKIP_BANNER = new Set(["config", "import", "mode"]);
  backlog.hook("preAction", (_thisCommand, actionCommand) => {
    if (actionCommand.parent?.name() === "notes") return;
    if (SKIP_BANNER.has(actionCommand.name())) return;
    const opts = actionCommand.opts() as { project?: string };
    const dir = resolve(opts.project ?? process.cwd());
    process.stderr.write(describeBacklogStore(resolveBacklogStore(dir)) + "\n");
  });

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
      // Read stdin before entering the critical section (a stdin read must not
      // block while the backlog lock / write transaction is held).
      const bodyRaw = readBodyArg(opts.body);
      const type = (opts.type as TicketType) ?? "story";
      const id = fileNewTicket(dir, { type, title, body: bodyRaw });
      if (resolveBacklogStore(dir).mode === "db") {
        console.log(`Created ${id}: ${title}`);
        return;
      }
      console.log(`Created ${id} in ${TYPE_DIRS[type]}/${generateSlug(title)}: ${title}`);
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
      // FG-607: no backlog/ requirement — in db mode a project legitimately has
      // no backlog directory, and importing an empty one is how a fresh project
      // claims its project_key before flipping to db mode.
      const dir = resolve(opts.project ?? process.cwd());
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
      const config = readBacklogConfig(dir);
      console.log(`format: structured`);
      console.log(`prefix: ${config.prefix ?? "(none)"}`);
    });

  // ----- mode (FG-607) -----
  backlog
    .command("mode")
    .description("Show or set which store is authoritative for this project's backlog (markdown | db)")
    .option("--set <mode>", "markdown | db")
    .option(
      "--allow-orphaned-tickets",
      "with --set markdown: flip even though db-mode tickets with no Markdown file would become unreachable",
    )
    .option("--project <dir>", "project directory (default: cwd)")
    .option("--json", "emit JSON result")
    .action((opts: { set?: string; allowOrphanedTickets?: boolean; project?: string; json?: boolean }) => {
      const dir = resolve(opts.project ?? process.cwd());

      if (opts.set !== undefined && opts.set !== "markdown" && opts.set !== "db") {
        throw new Error(`--set expects 'markdown' or 'db'; got '${opts.set}'`);
      }
      const set = opts.set;
      try {
        if (set === undefined) {
          // Resolution can REFUSE (a copied project_key owned by another
          // repository); it is caught below and reported like any other refusal.
          const store = resolveBacklogStore(dir);
          if (opts.json) {
            console.log(JSON.stringify(
              { mode: store.mode, projectKey: store.projectKey, staleMarkdown: store.staleMarkdown },
              null, 2,
            ));
            return;
          }
          console.log(`mode: ${store.mode}`);
          console.log(`project_key: ${store.projectKey ?? "(none)"}`);
          return;
        }
        const result = setBacklogMode(dir, set, {
          allowOrphanedTickets: opts.allowOrphanedTickets === true,
        });
        // A stale sequence that silently jumped forward is indistinguishable from
        // one that was right all along; say what moved and what forced it.
        for (const seq of result.advancedSequences) {
          process.stderr.write(
            `advanced id sequence for prefix '${seq.prefix}': ${seq.from ?? "(unseeded)"} -> ${seq.to} — ` +
              `${seq.prefix}-${seq.to - 1} already exists in backlog/ or the DB, so allocation would have ` +
              `minted ids this project has already used\n`,
          );
        }
        // The same list the refusal would have printed — the operator who used the
        // opt-out still sees exactly which tickets they stranded.
        if (result.orphanedTickets.length > 0) {
          process.stderr.write(
            `warning: ${result.orphanedTickets.length} db ticket(s) have no Markdown file and are now ` +
              `unreachable: ${describeIds(result.orphanedTickets)}\n`,
          );
        }
        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log(`mode: ${result.mode} (project_key=${result.projectKey})`);
      } catch (e) {
        if (e instanceof ModeSetRefusal || e instanceof ProjectIdentityConflictError) {
          if (opts.json) {
            console.log(JSON.stringify({ status: "error", reason: e.message }, null, 2));
          } else {
            process.stderr.write(e.message + "\n");
          }
          process.exitCode = 1;
          return;
        }
        throw e;
      }
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

// A refusal to flip a project into db mode. Operator-visible, non-zero exit —
// never a silent downgrade to markdown.
class ModeSetRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModeSetRefusal";
  }
}

const MAX_CLAIM_RETRIES = 8;

// An id sequence the flip found STALE and moved forward. Reported to the operator
// verbatim — the sequence silently jumping is how a duplicate id becomes
// invisible, so the flip never advances one without saying what it moved and why.
type AdvancedSequence = { prefix: string; from: number | null; to: number };

// `forge backlog mode --set` and `forge backlog import` are the ONLY places
// allowed to mint a project identity and heal .forge/config.yml — an operator is
// present and a dirty (git-tracked) config is expected here. The read-only seam
// must never do either.
function setBacklogMode(
  projectDir: string,
  mode: StorageMode,
  opts: { allowOrphanedTickets: boolean },
): {
  mode: StorageMode;
  projectKey: string;
  orphanedTickets: string[];
  advancedSequences: AdvancedSequence[];
} {
  const config = readBacklogConfig(projectDir);
  const prefix = config.prefix ?? "FG";
  const evidence = computeRepositoryEvidence(projectDir);
  const now = new Date().toISOString();

  // Same pre-flight as import: if we WILL heal config, fail closed before we
  // claim a registry identity.
  if (config.projectKey == null) assertConfigWritable(projectDir);

  // Filesystem reads, outside the transaction. BOTH directions need them now: the
  // markdown direction to spot db-only tickets it would strand, the db direction
  // to re-derive the Markdown high-water mark the sequence has to clear.
  const markdownIds = listMarkdownTickets(projectDir).map((t) => t.id);
  const backlogDirPresent = existsSync(join(projectDir, "backlog"));

  let projectKey = "";
  let orphanedTickets: string[] = [];
  let advancedSequences: AdvancedSequence[] = [];
  for (let attempt = 0; ; attempt++) {
    try {
      writeTransaction(() => {
        orphanedTickets = [];
        advancedSequences = [];
        const resolved = resolveAndClaimProjectKey({
          evidenceKey: evidence.key,
          evidenceSource: evidence.source,
          configKey: config.projectKey,
          createdAt: now,
        });
        projectKey = resolved.projectKey;

        // Both refusals below run BEFORE the config heal so a refused flip leaves
        // nothing behind at all — not even the config-only residual the import
        // path deliberately tolerates.

        // An unseeded sequence means this project never went through import.
        // Minting from 1 would duplicate every id that exists only in
        // backlog/*.md — the DB's collision check cannot see those, and a
        // single-checkout filesystem scan cannot prove the PROJECT is empty
        // (project_key spans every clone and linked worktree; backlog/ is
        // git-tracked and therefore per-branch). Refuse and name the one path
        // that seeds the sequence correctly.
        if (mode === "db") {
          const seeded = getIdSequence(projectKey, prefix);
          if (seeded === undefined) {
            throw new ModeSetRefusal(
              `forge: refusing to set db mode — no id sequence is seeded for prefix '${prefix}' under ` +
                `project_key '${projectKey}'. Run \`forge backlog import\` first so id allocation ` +
                `continues past the ids this project already has instead of duplicating them. A project ` +
                `with nothing in either store is bootstrapped the same way — import on an empty project ` +
                `seeds the sequence. (Storage mode unchanged.)`,
            );
          }

          const dbIds = ticketsForProject(projectKey).map((t) => t.ticketId);

          // A sequence EXISTING is not a sequence that is CURRENT. Markdown-mode
          // allocation reads backlog/ for max+1 and never bumps next_seq, so every
          // ticket filed after the import leaves the sequence behind — and the
          // first db-mode `backlog file` would then mint an id that already exists
          // as a backlog/*.md file, invisibly (the DB's collision check knows
          // nothing about Markdown). So re-derive the high-water mark HERE, at the
          // moment of the flip, over BOTH stores.
          //
          // Fail closed first on what this checkout cannot observe: with no
          // backlog/ directory at all we cannot see the project's Markdown ids,
          // and a project that demonstrably HAS tickets is not one where "nothing
          // here" may be read as "nothing anywhere". Only on the actual
          // markdown -> db TRANSITION: a project already in db mode allocates from
          // the sequence alone, so re-running the flip has nothing to verify (and
          // post-cutover it legitimately has no backlog/ at all).
          if (!backlogDirPresent && dbIds.length > 0 && getStorageMode(projectKey) !== "db") {
            throw new ModeSetRefusal(
              `forge: refusing to set db mode — this checkout has no backlog/ directory, so forge cannot ` +
                `verify that id allocation (next_seq=${seeded} for prefix '${prefix}') is above the ids the ` +
                `project's Markdown already uses. The project is not empty — ${dbIds.length} ticket(s) exist ` +
                `under project_key '${projectKey}' — and project_key spans every clone and linked worktree, ` +
                `so an absent backlog/ here proves nothing about them. Run the flip from a checkout that has ` +
                `backlog/ (re-run \`forge backlog import\` there first). (Storage mode unchanged.)`,
            );
          }

          for (const [p, next] of requiredNextSeq(markdownIds, dbIds, prefix)) {
            const current = getIdSequence(projectKey, p);
            if (current !== undefined && current >= next) continue;
            bumpIdSequence(projectKey, p, next);
            advancedSequences.push({ prefix: p, from: current ?? null, to: next });
          }
        }

        // Flipping BACK to markdown strands every ticket created while in db
        // mode: it stays in the DB, invisible, with nothing pointing at it.
        if (mode === "markdown") {
          const markdownIdSet = new Set(markdownIds);
          orphanedTickets = ticketsForProject(projectKey)
            .map((t) => t.ticketId)
            .filter((id) => !markdownIdSet.has(id));
          if (orphanedTickets.length > 0 && !opts.allowOrphanedTickets) {
            throw new ModeSetRefusal(
              `forge: refusing to set markdown mode — ${orphanedTickets.length} ticket(s) exist in the ` +
                `DB with no file in backlog/: ${describeIds(orphanedTickets)}. In markdown mode nothing ` +
                `reads them, so they would become unreachable. Write them out to backlog/*.md first, or ` +
                `pass --allow-orphaned-tickets to flip anyway. (Storage mode unchanged.)`,
            );
          }
        }

        if (resolved.persistToConfig) writeProjectKey(projectDir, resolved.projectKey);
        ensureStorageMode(projectKey, now);
        setStorageMode(projectKey, mode, now);
      });
      break;
    } catch (e) {
      if (e instanceof ProjectIdentityClaimRaceError && attempt < MAX_CLAIM_RETRIES) continue;
      throw e;
    }
  }

  clearBacklogStoreCache();
  return { mode, projectKey, orphanedTickets, advancedSequences };
}

// Cap the operator-facing id list so a 400-ticket project doesn't print a wall.
function describeIds(ids: string[]): string {
  if (ids.length <= 10) return ids.join(", ");
  return `${ids.slice(0, 10).join(", ")}, +${ids.length - 10} more`;
}

function readBodyArg(body: string | undefined): string {
  if (!body) return "";
  if (body === "-") return readFileSync(0, "utf8");
  return body;
}
