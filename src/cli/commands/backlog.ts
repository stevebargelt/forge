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
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { assertConfigWritable, readBacklogConfig, writeProjectKey } from "../../backlog/config.js";
import {
  clearBacklogStoreCache,
  describeBacklogStore,
  resolveBacklogStore,
} from "../../backlog/storage-mode.js";
import {
  importBacklog,
  requiredNextSeq,
  resolveSourceIdentity,
  BacklogImportError,
  RemovalReconciliationRefusal,
} from "../../store/backlog-import.js";
import { writeTransaction } from "../../store/db.js";
import {
  computeRepositoryEvidence,
  ProjectIdentityClaimRaceError,
  ProjectIdentityConflictError,
  reidentifyProject,
  resolveAndClaimProjectKey,
} from "../../store/project-registry.js";
import {
  bumpIdSequence,
  ensureStorageMode,
  forgetBacklogSource,
  getIdSequence,
  getStorageMode,
  getStorageModeRecord,
  liveBacklogSources,
  recordModeFlip,
  setStorageMode,
  ticketsForProject,
  type StorageMode,
} from "../../store/tickets.js";
import { describeStalePublications } from "../../backlog/snapshot.js";
import {
  containerListTickets,
  containerReadTicket,
  containerSnapshotMeta,
  describeRevisionDrift,
  hasContainerBacklogAuthority,
  refuseContainerMutation,
  ContainerAuthorityUnavailable,
  ContainerMutationRefused,
} from "../../backlog/container-authority.js";
import { listCampaigns } from "../../store/campaigns.js";
import { listRuns } from "../../store/runs.js";
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
  const SKIP_BANNER = new Set(["config", "import", "mode", "migrate", "reidentify", "forget-source"]);
  backlog.hook("preAction", (_thisCommand, actionCommand) => {
    if (actionCommand.parent?.name() === "notes") return;
    if (SKIP_BANNER.has(actionCommand.name())) return;
    // FG-608: under a mounted authority the banner names the MOUNT, and the host
    // resolver is never called — see container-authority.ts for why a fallback
    // here would silently answer from the shared oauth volume's forge.db.
    if (hasContainerBacklogAuthority()) {
      try {
        const meta = containerSnapshotMeta();
        process.stderr.write(
          `store: db snapshot (project_key=${meta.projectKey}, published ${meta.publishedAt}, ` +
            `read-only mount)\n`,
        );
      } catch (e) {
        process.stderr.write(`${(e as Error).message}\n`);
      }
      return;
    }
    const opts = actionCommand.opts() as { project?: string };
    const dir = resolve(opts.project ?? process.cwd());
    const store = resolveBacklogStore(dir);
    process.stderr.write(describeBacklogStore(store) + "\n");
    // An unpublished amendment must be visible to the operator AS STALE, never
    // indistinguishable from an up-to-date container.
    if (store.projectKey) {
      const stale = describeStalePublications(store.projectKey);
      if (stale) process.stderr.write(stale + "\n");
    }
  });

  // FG-608: every mutating verb refuses under a mounted authority. This is the
  // POLITE half only — the ENFORCEMENT half is the docker `:ro` directory mount,
  // because agents have passwordless root and can sudo past any CLI check. Both
  // halves are asserted separately in the container tests.
  const CONTAINER_MUTATION_VERBS = new Set(["file", "close", "edit", "retitle", "move", "import", "mode", "migrate", "reidentify", "forget-source"]);
  backlog.hook("preAction", (_thisCommand, actionCommand) => {
    if (!hasContainerBacklogAuthority()) return;
    if (actionCommand.parent?.name() === "notes") return;
    if (!CONTAINER_MUTATION_VERBS.has(actionCommand.name())) return;
    refuseContainerMutation(actionCommand.name());
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
      if (hasContainerBacklogAuthority()) {
        const mounted = containerListTickets({
          ...(opts.type ? { type: opts.type } : {}),
          ...(opts.status ? { status: opts.status } : {}),
          ...(opts.search ? { search: opts.search } : {}),
        });
        if (opts.json) {
          console.log(JSON.stringify(
            mounted.map((t) => ({ id: t.id, type: t.type, status: t.status, title: t.title, revision: t.revision })),
            null, 2,
          ));
          return;
        }
        if (mounted.length === 0) {
          console.log("(no matching tickets)");
          return;
        }
        for (const t of mounted) console.log(`  ${t.id}  [${t.type}/${t.status}]  ${t.title}`);
        return;
      }
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
      if (hasContainerBacklogAuthority()) {
        const live = containerReadTicket(idArg);
        const drift = describeRevisionDrift(live);
        if (opts.json) {
          // BOTH records, never one overwriting the other.
          console.log(JSON.stringify({ ...live, revisionDrift: drift }, null, 2));
          return;
        }
        console.log(`### ${live.id} — ${live.title}`);
        console.log(`(${live.type}/${live.status}, revision ${live.revision})`);
        console.log("");
        console.log(live.body.trimEnd());
        if (drift) process.stderr.write(drift + "\n");
        return;
      }
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

  // ----- migrate (FG-608): THE per-project authoritative cutover -----
  backlog
    .command("migrate")
    .description(
      "Cut this project over to the DB store: ONE atomic import -> validate -> flip. On ANY failure " +
        "Markdown stays authoritative and the mode is unchanged.",
    )
    .option("--dry-run", "report the plan without writing anything")
    .option("--force", "with the import step: overwrite db rows that diverged from their import basis")
    .option("--project <dir>", "project directory (default: cwd)")
    .option("--json", "emit JSON result")
    .action((opts: { dryRun?: boolean; force?: boolean; project?: string; json?: boolean }) => {
      const dir = resolve(opts.project ?? process.cwd());
      try {
        const result = migrateProject(dir, {
          dryRun: opts.dryRun === true,
          force: opts.force === true,
        });
        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        if (result.dryRun) {
          console.log(`DRY RUN — nothing was written.`);
          console.log(`project_key: ${result.projectKey}`);
          console.log(`current mode: ${result.modeBefore}`);
          console.log(`would import: ${result.markdownTicketCount} ticket(s) from backlog/*.md`);
          console.log(`would flip mode to: db`);
        } else {
          console.log(`Migrated ${result.projectKey} to db mode (${result.markdownTicketCount} ticket(s)).`);
          console.log(`flip recorded by forge revision: ${result.flippedByRevision}`);
        }
        for (const line of cutoverNotice(result)) process.stderr.write(line + "\n");
      } catch (e) {
        if (
          e instanceof MigrateRefusal ||
          e instanceof ModeSetRefusal ||
          e instanceof ProjectIdentityConflictError ||
          e instanceof BacklogImportError ||
          e instanceof RemovalReconciliationRefusal
        ) {
          if (opts.json) {
            console.log(JSON.stringify({ status: "error", error: e.name, reason: e.message }, null, 2));
          } else {
            process.stderr.write(e.message + "\n");
          }
          process.exitCode = 1;
          return;
        }
        throw e;
      }
    });

  // ----- reidentify (FG-608): the cutover PRECONDITION -----
  backlog
    .command("reidentify")
    .description(
      "Re-point the registry's repository evidence for a project_key at THIS checkout. " +
        "Operator-present repair for the source-dependent evidence key (e.g. after `git remote add origin`).",
    )
    .requiredOption("--confirm", "required: this is an operator assertion, never inferred")
    .option("--key <projectKey>", "the project_key to re-point (default: the key in .forge/config.yml)")
    .option("--project <dir>", "project directory (default: cwd)")
    .option("--json", "emit JSON result")
    .action((opts: { confirm?: boolean; key?: string; project?: string; json?: boolean }) => {
      const dir = resolve(opts.project ?? process.cwd());
      try {
        const result = reidentifyHere(dir, opts.key);
        clearBacklogStoreCache();
        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log(
          `Re-identified ${result.projectKey}: evidence ${result.previousEvidenceKey} -> ` +
            `${result.newEvidenceKey} (source: ${result.newEvidenceSource})`,
        );
      } catch (e) {
        if (e instanceof ProjectIdentityConflictError || e instanceof ModeSetRefusal) {
          if (opts.json) {
            console.log(JSON.stringify({ status: "error", error: e.name, reason: e.message }, null, 2));
          } else {
            process.stderr.write(e.message + "\n");
          }
          process.exitCode = 1;
          return;
        }
        throw e;
      }
    });

  // ----- forget-source (FG-608): release a permanently-removed source -----
  backlog
    .command("forget-source")
    .description(
      "Forget a backlog source that is permanently gone (a deleted clone / reaped worktree), so the " +
        "tickets only it still claimed become prunable on the next import.",
    )
    .option("--source <id>", "the source id to forget (default: this checkout's)")
    .option("--list", "list this project's live sources instead of forgetting one")
    .option("--project <dir>", "project directory (default: cwd)")
    .option("--json", "emit JSON result")
    .action((opts: { source?: string; list?: boolean; project?: string; json?: boolean }) => {
      const dir = resolve(opts.project ?? process.cwd());
      const store = resolveBacklogStore(dir);
      if (!store.projectKey) {
        process.stderr.write(
          `forge: this project has no project_key yet, so it has no registered backlog sources. ` +
            `Run \`forge backlog import\` first.\n`,
        );
        process.exitCode = 1;
        return;
      }
      const projectKey = store.projectKey;
      if (opts.list) {
        const sources = liveBacklogSources(projectKey);
        if (opts.json) {
          console.log(JSON.stringify(sources, null, 2));
          return;
        }
        if (sources.length === 0) console.log("(no live sources)");
        for (const s of sources) {
          console.log(`  ${s.sourceId}  last seen at ${s.lastPath ?? "(unknown)"} on ${s.lastScannedAt ?? "?"}`);
        }
        return;
      }
      const sourceId = opts.source ?? resolveSourceIdentity(dir);
      const forgotten = writeTransaction(() =>
        forgetBacklogSource(projectKey, sourceId, new Date().toISOString()),
      );
      if (!forgotten) {
        process.stderr.write(
          `forge: source '${sourceId}' is not a live source of project_key '${projectKey}' — nothing ` +
            `to forget. Use --list to see this project's sources.\n`,
        );
        process.exitCode = 1;
        return;
      }
      if (opts.json) {
        console.log(JSON.stringify({ projectKey, sourceId, forgotten: true }, null, 2));
        return;
      }
      console.log(`Forgot source ${sourceId} for ${projectKey}.`);
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
    .option(
      "--accept-frozen-markdown-loss",
      "with --set markdown after a DB-only edit: flip anyway, accepting that edits made since the cutover " +
        "are lost (backlog/*.md froze at the cutover and there is no Markdown export)",
    )
    .option("--project <dir>", "project directory (default: cwd)")
    .option("--json", "emit JSON result")
    .action((opts: {
      set?: string;
      allowOrphanedTickets?: boolean;
      acceptFrozenMarkdownLoss?: boolean;
      project?: string;
      json?: boolean;
    }) => {
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
          acceptFrozenMarkdownLoss: opts.acceptFrozenMarkdownLoss === true,
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

// FG-608: a refusal to run the cutover. Distinct from ModeSetRefusal so the CLI
// (and tests) can tell "migrate declined to start" from "the flip itself refused".
class MigrateRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrateRefusal";
  }
}

export type MigrateResult = {
  dryRun: boolean;
  projectKey: string;
  modeBefore: StorageMode;
  modeAfter: StorageMode;
  markdownTicketCount: number;
  dbTicketCount: number;
  skippedConflicts: string[];
  forcedOverwrites: string[];
  prunedTickets: string[];
  flippedByRevision: string;
};

/** The forge checkout that performed the flip. Recorded on the mode row and
 *  surfaced in the cutover UX because NOTHING IN THE DB CAN PREVENT an older
 *  binary from opening the migrated store: these migrations are additive, so
 *  user_version is untouched and assertSchemaVersionSupported never fires. An old
 *  forge will open this store happily and keep reading the frozen backlog/*.md.
 *  Naming which forge flipped it is the honest alternative to implying otherwise. */
function forgeRevision(): string {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: new URL("../../../", import.meta.url).pathname,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}

/** MANDATE 3 (operator clarification): migrate refuses ONLY when the TARGET
 *  project_key has active runs or a running campaign. Activity in an UNRELATED
 *  project never blocks a migration.
 *
 *  Why refuse at all: the mode is a host-side row read through a 3s-TTL cache
 *  (storage-mode.ts), and campaign guards re-resolve the store on every drive step
 *  (executor.ts, report.ts). Flipping mid-run therefore splits truth WITHIN one
 *  run — some steps read Markdown, later steps read the DB, and neither half is
 *  wrong on its own. */
function assertNoActivityForProject(projectKey: string): void {
  const blockers: string[] = [];
  for (const run of listRuns()) {
    if (run.status !== "active") continue;
    if (!run.projectDir) continue;
    if (!existsSync(run.projectDir)) continue;
    let key: string | null = null;
    try {
      key = resolveBacklogStore(run.projectDir).projectKey;
    } catch {
      // An unresolvable project dir cannot be shown to BE the target, and the
      // scope clarification is explicit that unrelated activity never blocks.
      continue;
    }
    if (key === projectKey) blockers.push(`run ${run.id} (${run.projectDir})`);
  }
  for (const campaign of listCampaigns("running")) {
    if (!campaign.projectDir) continue;
    if (!existsSync(campaign.projectDir)) continue;
    let key: string | null = null;
    try {
      key = resolveBacklogStore(campaign.projectDir).projectKey;
    } catch {
      continue;
    }
    if (key === projectKey) blockers.push(`campaign ${campaign.id} (${campaign.projectDir})`);
  }
  if (blockers.length > 0) {
    throw new MigrateRefusal(
      `forge: refusing to migrate project_key '${projectKey}' — it has in-flight work: ` +
        `${blockers.join(", ")}. The storage mode is read through a short-lived cache and campaign ` +
        `guards re-resolve the store on every drive step, so flipping now would split truth WITHIN ` +
        `one run: earlier steps read Markdown, later steps read the DB. Let this work finish (or ` +
        `abandon it) and re-run. Activity in OTHER projects does not block this. ` +
        `(Storage mode unchanged; Markdown remains authoritative.)`,
    );
  }
}

/** `forge backlog migrate` — ONE atomic import -> validate -> flip.
 *
 *  ATOMICITY, precisely: the three steps are sequenced so that any failure leaves
 *  Markdown authoritative and the mode UNFLIPPED. The flip is LAST and is the only
 *  irreversible-ish act; validate runs against the just-imported state and throws
 *  before it. The import's own transaction is all-or-nothing (backlog-import.ts),
 *  so a failed import writes zero rows. There is no half-migrated project.
 *
 *  --dry-run writes NOTHING AT ALL — not the import either. It reports the plan by
 *  reading Markdown and the current DB state, so an operator can inspect a cutover
 *  without committing a project_key. */
export function migrateProject(
  projectDir: string,
  opts: { dryRun: boolean; force: boolean },
): MigrateResult {
  const markdownIds = listMarkdownTickets(projectDir).map((t) => t.id);
  const before = resolveBacklogStore(projectDir);
  const revision = forgeRevision();

  if (opts.dryRun) {
    const projectKey = before.projectKey;
    return {
      dryRun: true,
      projectKey: projectKey ?? "(not yet claimed — import would mint one)",
      modeBefore: before.mode,
      modeAfter: before.mode,
      markdownTicketCount: markdownIds.length,
      dbTicketCount: projectKey ? ticketsForProject(projectKey).length : 0,
      skippedConflicts: [],
      forcedOverwrites: [],
      prunedTickets: [],
      flippedByRevision: revision,
    };
  }

  // STEP 0 — refuse over the TARGET's own in-flight work, before anything is
  // written. Only possible once we know the key, so it runs again after import for
  // a project that had none yet.
  if (before.projectKey) assertNoActivityForProject(before.projectKey);

  // STEP 1 — IMPORT. Throws (BacklogImportError / ProjectIdentityConflictError /
  // RemovalReconciliationRefusal) without flipping anything.
  const imported = importBacklog(projectDir, { force: opts.force });
  assertNoActivityForProject(imported.projectKey);

  // STEP 2 — VALIDATE: the shadow must equal the current Markdown set.
  const dbIds = ticketsForProject(imported.projectKey).map((t) => t.ticketId);
  const markdownSet = new Set(markdownIds);
  const dbSet = new Set(dbIds);
  const missingFromDb = markdownIds.filter((id) => !dbSet.has(id));
  const extraInDb = dbIds.filter((id) => !markdownSet.has(id));
  if (missingFromDb.length > 0 || extraInDb.length > 0 || imported.skippedConflicts.length > 0) {
    throw new MigrateRefusal(
      `forge: refusing to complete the cutover — after import the DB shadow does not equal this ` +
        `checkout's Markdown set.` +
        (missingFromDb.length > 0 ? ` In Markdown but not the DB: ${describeIds(missingFromDb)}.` : "") +
        (extraInDb.length > 0 ? ` In the DB but not Markdown: ${describeIds(extraInDb)}.` : "") +
        (imported.skippedConflicts.length > 0
          ? ` Skipped as import conflicts (a db edit diverged from its import basis): ` +
            `${describeIds(imported.skippedConflicts)} — resolve them, or re-run with --force to ` +
            `overwrite (which records before/after evidence).`
          : "") +
        ` Migration is atomic: the mode was NOT flipped and Markdown remains authoritative.`,
    );
  }

  // STEP 3 — FLIP. Last, and only if 1 and 2 succeeded.
  const flip = setBacklogMode(projectDir, "db", { allowOrphanedTickets: false });
  writeTransaction(() => recordModeFlip(flip.projectKey, new Date().toISOString(), revision));
  clearBacklogStoreCache();

  return {
    dryRun: false,
    projectKey: flip.projectKey,
    modeBefore: before.mode,
    modeAfter: "db",
    markdownTicketCount: markdownIds.length,
    dbTicketCount: dbIds.length,
    skippedConflicts: imported.skippedConflicts,
    forcedOverwrites: imported.forcedOverwrites,
    prunedTickets: imported.prunedTickets,
    flippedByRevision: revision,
  };
}

/** The cutover UX. States the ONE-WAY property in the operator's own terms — this
 *  is not decoration: Markdown EXPORT is out of scope for FG-496, so after the
 *  first DB-only edit backlog/*.md is a FROZEN SNAPSHOT and reverting would lose
 *  the edits made since. Per accepted default (d) the first DB-only edit is
 *  RECORDED, so `mode --set markdown` REFUSES afterward — the property is
 *  enforced, not merely documented. */
function cutoverNotice(result: MigrateResult): string[] {
  const lines = [
    `ONE-WAY CUTOVER — read this before you rely on it:`,
    `  * backlog/*.md is now a FROZEN SNAPSHOT. There is no Markdown export; nothing writes those`,
    `    files again. Clean rollback to markdown mode exists ONLY until the first DB-only edit.`,
    `  * That first DB-only edit is RECORDED. After it, \`forge backlog mode --set markdown\` REFUSES,`,
    `    because reverting would silently lose every edit made since the flip.`,
    `  * Nothing in the store can stop an OLDER forge binary from opening it: these migrations are`,
    `    additive, so user_version is untouched and the forward version gate never fires. An older`,
    `    forge on this host will keep reading the frozen backlog/*.md and will not see db edits.`,
    `    This flip was performed by forge revision ${result.flippedByRevision}.`,
  ];
  if (result.dryRun) lines.unshift(`(dry run — none of the following has happened yet)`);
  return lines;
}

function reidentifyHere(
  projectDir: string,
  assertedKey: string | undefined,
): { projectKey: string; previousEvidenceKey: string; newEvidenceKey: string; newEvidenceSource: string } {
  const config = readBacklogConfig(projectDir);
  const projectKey = assertedKey ?? config.projectKey;
  if (!projectKey) {
    throw new ModeSetRefusal(
      `forge: reidentify needs a project_key — this checkout's .forge/config.yml commits none. Pass ` +
        `--key <projectKey> to assert which project this repository is.`,
    );
  }
  const evidence = computeRepositoryEvidence(projectDir);
  return writeTransaction(() =>
    reidentifyProject({
      projectKey,
      evidenceKey: evidence.key,
      evidenceSource: evidence.source,
    }),
  );
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
  opts: { allowOrphanedTickets: boolean; acceptFrozenMarkdownLoss?: boolean },
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
          // FG-608 / accepted default (d): the one-way cutover property, ENFORCED.
          // Once a migrated project has made a DB-only edit, backlog/*.md is a
          // frozen snapshot (there is no Markdown export) and reverting would
          // silently discard every edit since. The first such edit is recorded at
          // write time, so this refusal does not depend on the operator
          // remembering. It is checked BEFORE the orphaned-ticket guard because it
          // is not the same question: a db edit to an EXISTING ticket leaves no
          // orphan at all and would sail past that check.
          const record = getStorageModeRecord(projectKey);
          if (record?.firstDbEditAt && !opts.acceptFrozenMarkdownLoss) {
            throw new ModeSetRefusal(
              `forge: refusing to set markdown mode — this project has made DB-only edits since it ` +
                `cut over (first on ${record.firstDbEditAt}, ticket ${record.firstDbEditTicket ?? "?"}). ` +
                `backlog/*.md froze at the cutover and there is no Markdown export, so reverting would ` +
                `silently discard every edit made since — including edits to tickets that still have a ` +
                `Markdown file, which the orphaned-ticket check cannot see. Clean rollback existed only ` +
                `BEFORE the first DB-only edit. If you have already reconciled backlog/*.md by hand and ` +
                `accept losing anything you missed, pass --accept-frozen-markdown-loss. ` +
                `(Storage mode unchanged.)`,
            );
          }
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
