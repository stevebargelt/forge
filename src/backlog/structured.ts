import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify as stringifyYaml, parse as parseYaml } from "yaml";

export type TicketType = "idea" | "epic" | "story";
export type TicketStatus = "active" | "done" | "blocked" | "deferred";

export type TicketFrontmatter = {
  id: string;
  type: TicketType;
  status: TicketStatus;
  title: string;
  related?: string[];
  created?: string;
  closed?: string;
  epic?: string;
};

export type StructuredTicket = TicketFrontmatter & {
  body: string;
};

const TYPE_DIRS: Record<TicketType, string> = {
  idea: "ideas",
  epic: "epics",
  story: "stories",
};

const DONE_DIR = "done";

export function generateSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 50)
    .replace(/-$/, "");
}

function backlogDir(projectDir: string): string {
  return join(projectDir, "backlog");
}

function subdirForTicket(fm: Pick<TicketFrontmatter, "type" | "status">): string {
  if (fm.status === "done") return DONE_DIR;
  return TYPE_DIRS[fm.type];
}

function findTicketFile(projectDir: string, id: string): { path: string; subdir: string } | undefined {
  const base = backlogDir(projectDir);
  const dirs = ["ideas", "epics", "stories", DONE_DIR];
  for (const dir of dirs) {
    const full = join(base, dir);
    if (!existsSync(full)) continue;
    const entries = readdirSync(full);
    const match = entries.find((e) => e.startsWith(`${id}-`) || e === `${id}.md`);
    if (match) return { path: join(full, match), subdir: dir };
  }
  return undefined;
}

function parseTicketFile(content: string): { frontmatter: TicketFrontmatter; body: string } {
  if (!content.startsWith("---\n")) {
    throw new Error("ticket file must start with YAML frontmatter (---)")
  }
  const end = content.indexOf("\n---\n", 4);
  if (end === -1) throw new Error("unterminated YAML frontmatter");
  const yaml = content.slice(4, end);
  const body = content.slice(end + 5);
  const raw = parseYaml(yaml) as Record<string, unknown>;
  const frontmatter: TicketFrontmatter = {
    id: String(raw["id"]),
    type: raw["type"] as TicketType,
    status: raw["status"] as TicketStatus,
    title: String(raw["title"]),
    ...(raw["related"] ? { related: raw["related"] as string[] } : {}),
    ...(raw["created"] ? { created: String(raw["created"]) } : {}),
    ...(raw["closed"] ? { closed: String(raw["closed"]) } : {}),
    ...(raw["epic"] ? { epic: String(raw["epic"]) } : {}),
  };
  return { frontmatter, body: body.trimStart() };
}

function serializeTicket(fm: TicketFrontmatter, body: string): string {
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

export function readTicket(projectDir: string, id: string): StructuredTicket {
  const found = findTicketFile(projectDir, id);
  if (!found) throw new Error(`Ticket ${id} not found`);
  const content = readFileSync(found.path, "utf8");
  const { frontmatter, body } = parseTicketFile(content);
  return { ...frontmatter, body };
}

export function writeTicket(projectDir: string, ticket: StructuredTicket): void {
  const base = backlogDir(projectDir);
  const subdir = subdirForTicket(ticket);
  const dir = join(base, subdir);
  mkdirSync(dir, { recursive: true });

  const slug = generateSlug(ticket.title);
  const filename = `${ticket.id}-${slug}.md`;
  const { body, ...fm } = ticket;
  writeFileSync(join(dir, filename), serializeTicket(fm, body));
}

export type ListFilter = {
  type?: TicketType;
  status?: TicketStatus;
};

export function listTickets(projectDir: string, filters: ListFilter = {}): StructuredTicket[] {
  const base = backlogDir(projectDir);
  const dirsToScan: string[] = [];

  if (filters.status === "done") {
    dirsToScan.push(DONE_DIR);
  } else if (filters.type) {
    dirsToScan.push(TYPE_DIRS[filters.type]);
    if (!filters.status) dirsToScan.push(DONE_DIR);
  } else {
    dirsToScan.push("ideas", "epics", "stories", DONE_DIR);
  }

  const results: StructuredTicket[] = [];
  for (const subdir of dirsToScan) {
    const dir = join(base, subdir);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith(".md")) continue;
      try {
        const content = readFileSync(join(dir, entry), "utf8");
        const { frontmatter, body } = parseTicketFile(content);
        if (filters.type && frontmatter.type !== filters.type) continue;
        if (filters.status && frontmatter.status !== filters.status) continue;
        results.push({ ...frontmatter, body });
      } catch {
        // skip unparseable files
      }
    }
  }
  return results;
}

export function moveTicket(projectDir: string, id: string, newType: TicketType): void {
  const found = findTicketFile(projectDir, id);
  if (!found) throw new Error(`Ticket ${id} not found`);

  const content = readFileSync(found.path, "utf8");
  const { frontmatter, body } = parseTicketFile(content);
  const updated: TicketFrontmatter = { ...frontmatter, type: newType, status: "active" };
  const base = backlogDir(projectDir);
  const newDir = join(base, TYPE_DIRS[newType]);
  mkdirSync(newDir, { recursive: true });

  const slug = generateSlug(updated.title);
  const filename = `${updated.id}-${slug}.md`;
  const newPath = join(newDir, filename);
  writeFileSync(newPath, serializeTicket(updated, body));
  if (found.path !== newPath) {
    unlinkSync(found.path);
  }
}
