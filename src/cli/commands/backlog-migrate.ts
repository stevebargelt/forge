// forge backlog-migrate — one-way legacy import: migrate BACKLOG.md to structured backlog/ directory.
//
// This command is intentionally isolated from the normal backlog runtime paths.
// It is the ONLY place that reads a BACKLOG.md file for migration purposes.

import type { Command } from "commander";
import { existsSync, mkdirSync, readdirSync, renameSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { parseBacklog } from "../../backlog/parse.js";
import type { Backlog } from "../../backlog/types.js";
import { readBacklogConfig, writeBacklogConfig } from "../../backlog/config.js";
import { generateSlug, type TicketFrontmatter, type TicketType, type TicketStatus } from "../../backlog/structured.js";
import { stringify as stringifyYaml } from "yaml";

export function registerBacklogMigrate(program: Command): void {
  program
    .command("backlog-migrate")
    .description("one-way legacy import: migrate BACKLOG.md to structured backlog/ directory")
    .option("--dry-run", "print what would happen without writing any files")
    .option("--project <dir>", "project directory (default: cwd)")
    .action(async (opts: { dryRun?: boolean; project?: string }) => {
      const dir = resolve(opts.project ?? process.cwd());
      const dryRun = opts.dryRun ?? false;

      const backlogMd = join(dir, "BACKLOG.md");
      if (!existsSync(backlogMd)) {
        throw new Error(`BACKLOG.md not found at ${backlogMd}`);
      }
      if (existsSync(join(dir, "backlog"))) {
        throw new Error(
          "backlog/ directory already exists. Migration cannot run over an existing structured backlog. " +
          "If you have already migrated, no further action is needed. " +
          "To re-run migration from scratch, remove or rename the backlog/ directory first.",
        );
      }

      let config = readBacklogConfig(dir);
      let prefix = config.prefix;
      if (!prefix) {
        if (dryRun) {
          prefix = "FG";
          console.log("(dry-run) No prefix configured — would prompt. Using 'FG' for preview.");
        } else {
          prefix = await promptPrefix();
          writeBacklogConfig(dir, { prefix });
          console.log(`Wrote prefix '${prefix}' to .forge/config.yml`);
        }
      }

      const content = readFileSync(backlogMd, "utf8");
      const b: Backlog = parseBacklog(content);

      type MigrateEntry = {
        id: string;
        type: TicketType;
        status: TicketStatus;
        title: string;
        body: string;
        filename: string;
        subdir: string;
      };

      const entries: MigrateEntry[] = [];
      const seenNums = new Set<number>();
      const duplicates: number[] = [];

      for (const section of ["Active", "In progress", "Done (recent)", "Done (archived)"] as const) {
        const tickets = b.sections.get(section) ?? [];
        for (const t of tickets) {
          if (seenNums.has(t.id)) {
            duplicates.push(t.id);
          }
          seenNums.add(t.id);

          const ticketType: TicketType = t.title.includes("[EPIC]") ? "epic" : "story";
          const ticketStatus: TicketStatus =
            section === "Active" || section === "In progress" ? "active" : "done";

          const ticketId = `${prefix}-${t.id}`;
          const slug = generateSlug(t.title);
          const filename = `${ticketId}-${slug}.md`;
          const subdir = ticketStatus === "done" ? "done" : (ticketType === "epic" ? "epics" : "stories");

          entries.push({ id: ticketId, type: ticketType, status: ticketStatus, title: t.title, body: t.body.trim(), filename, subdir });
        }
      }

      if (duplicates.length > 0) {
        throw new Error(`Duplicate ticket numbers found: ${duplicates.map((n) => `#${n}`).join(", ")}. Aborting.`);
      }

      const notesContent = b.notes.trim();

      if (dryRun) {
        console.log(`\nDry-run migration preview (${entries.length} tickets):\n`);
        console.log(`  Would create: backlog/{ideas,epics,stories,done}/`);
        for (const e of entries) {
          console.log(`  Would write:  backlog/${e.subdir}/${e.filename}`);
        }
        if (notesContent.length > 0) {
          console.log(`  Would write:  backlog/notes.md`);
        }
        console.log(`  Would rename: BACKLOG.md → BACKLOG.md.old`);
        console.log(`\nTotal: ${entries.length} ticket(s)`);
        return;
      }

      for (const sub of ["ideas", "epics", "stories", "done"]) {
        mkdirSync(join(dir, "backlog", sub), { recursive: true });
      }

      for (const e of entries) {
        const fm: TicketFrontmatter = { id: e.id, type: e.type, status: e.status, title: e.title };
        writeFileSync(join(dir, "backlog", e.subdir, e.filename), serializeStructuredTicket(fm, e.body));
      }

      if (notesContent.length > 0) {
        writeFileSync(join(dir, "backlog", "notes.md"), notesContent + "\n");
      }

      const written = readdirSync(join(dir, "backlog", "stories")).length
        + readdirSync(join(dir, "backlog", "epics")).length
        + readdirSync(join(dir, "backlog", "done")).length;
      if (written !== entries.length) {
        throw new Error(`Validation failed: ${entries.length} tickets in, ${written} files out. BACKLOG.md left intact.`);
      }

      renameSync(backlogMd, join(dir, "BACKLOG.md.old"));

      console.log(`Migrated ${entries.length} ticket(s) to backlog/. BACKLOG.md → BACKLOG.md.old`);
    });
}

function serializeStructuredTicket(fm: TicketFrontmatter, body: string): string {
  const yamlObj: Record<string, unknown> = {
    id: fm.id,
    type: fm.type,
    status: fm.status,
    title: fm.title,
  };
  if (fm.epic) yamlObj["epic"] = fm.epic;
  if (fm.related && fm.related.length > 0) yamlObj["related"] = fm.related;
  if (fm.created) yamlObj["created"] = fm.created;
  if (fm.closed) yamlObj["closed"] = fm.closed;
  const yaml = stringifyYaml(yamlObj, { lineWidth: 0 });
  const bodyStr = body.trim().length > 0 ? "\n" + body.trimStart() : "";
  return `---\n${yaml}---\n${bodyStr}`;
}

function promptPrefix(): Promise<string> {
  return new Promise((resolve, reject) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question("Enter project prefix for ticket IDs (e.g. FG, PROJ): ", (answer) => {
      rl.close();
      const prefix = answer.trim().toUpperCase();
      if (!prefix || !/^[A-Z][A-Z0-9-]*$/.test(prefix)) {
        reject(new Error(`Invalid prefix '${answer.trim()}'. Must start with a letter, contain only A-Z, 0-9, or '-'.`));
        return;
      }
      resolve(prefix);
    });
  });
}
