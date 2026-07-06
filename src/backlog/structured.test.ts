import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  closeTicket,
  fillClosedCommit,
  generateSlug,
  readTicket,
  retitleTicket,
  ticketExists,
  writeTicket,
  listTickets,
  moveTicket,
  type StructuredTicket,
} from "./structured.js";

// Helper: redirect process.stderr.write to a buffer for the duration of fn()
function captureStderr(fn: () => void): string {
  const chunks: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const orig = process.stderr.write as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stderr as any).write = (chunk: unknown): boolean => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    fn();
  } finally {
    (process.stderr as unknown as { write: unknown }).write = orig;
  }
  return chunks.join("");
}

// ----- generateSlug -----

test("generateSlug: basic lowercase kebab", () => {
  assert.equal(generateSlug("Hello World"), "hello-world");
});

test("generateSlug: strips special characters", () => {
  assert.equal(generateSlug("Fix bug #42: the/path issue!"), "fix-bug-42-thepath-issue");
});

test("generateSlug: collapses multiple spaces/dashes", () => {
  assert.equal(generateSlug("  too   many   spaces  "), "too-many-spaces");
});

test("generateSlug: truncates at 50 chars", () => {
  const long = "a".repeat(60);
  assert.equal(generateSlug(long).length, 50);
});

test("generateSlug: no trailing dash after truncation", () => {
  const title = "a".repeat(49) + " b";
  const slug = generateSlug(title);
  assert.ok(!slug.endsWith("-"), `slug should not end with dash: ${slug}`);
});

test("generateSlug: empty string returns empty", () => {
  assert.equal(generateSlug(""), "");
});

// ----- file I/O helpers -----

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "forge-structured-test-"));
  mkdirSync(join(dir, "backlog"), { recursive: true });
  return dir;
}

function makeTicket(overrides: Partial<StructuredTicket> = {}): StructuredTicket {
  return {
    id: "FG-1",
    type: "story",
    status: "active",
    title: "Test ticket",
    body: "Some body content.",
    ...overrides,
  };
}

// ----- writeTicket / readTicket roundtrip -----

test("writeTicket writes to stories/ for active story", () => {
  const dir = makeTmpDir();
  const ticket = makeTicket();
  writeTicket(dir, ticket);
  const result = readTicket(dir, "FG-1");
  assert.equal(result.id, "FG-1");
  assert.equal(result.type, "story");
  assert.equal(result.status, "active");
  assert.equal(result.title, "Test ticket");
  assert.ok(result.body.includes("Some body content"));
});

test("writeTicket writes to done/ for done status", () => {
  const dir = makeTmpDir();
  const ticket = makeTicket({ status: "done" });
  writeTicket(dir, ticket);
  const result = readTicket(dir, "FG-1");
  assert.equal(result.status, "done");
});

test("writeTicket writes to ideas/ for idea type", () => {
  const dir = makeTmpDir();
  const ticket = makeTicket({ type: "idea" });
  writeTicket(dir, ticket);
  const result = readTicket(dir, "FG-1");
  assert.equal(result.type, "idea");
});

test("writeTicket writes to epics/ for epic type", () => {
  const dir = makeTmpDir();
  const ticket = makeTicket({ type: "epic" });
  writeTicket(dir, ticket);
  const result = readTicket(dir, "FG-1");
  assert.equal(result.type, "epic");
});

test("writeTicket roundtrips optional fields", () => {
  const dir = makeTmpDir();
  const ticket = makeTicket({
    related: ["FG-2", "FG-3"],
    created: "2026-01-01",
    epic: "FG-100",
  });
  writeTicket(dir, ticket);
  const result = readTicket(dir, "FG-1");
  assert.deepEqual(result.related, ["FG-2", "FG-3"]);
  assert.equal(result.created, "2026-01-01");
  assert.equal(result.epic, "FG-100");
});

test("readTicket throws for unknown id", () => {
  const dir = makeTmpDir();
  assert.throws(() => readTicket(dir, "FG-999"), /not found/i);
});

// ----- frontmatter parsing -----

test("parseTicketFile: rejects file missing frontmatter", () => {
  const dir = makeTmpDir();
  mkdirSync(join(dir, "backlog", "stories"), { recursive: true });
  writeFileSync(join(dir, "backlog", "stories", "FG-5-no-fm.md"), "# just a heading\n");
  assert.throws(() => readTicket(dir, "FG-5"), /frontmatter/i);
});

test("parseTicketFile: rejects unterminated frontmatter", () => {
  const dir = makeTmpDir();
  mkdirSync(join(dir, "backlog", "stories"), { recursive: true });
  writeFileSync(join(dir, "backlog", "stories", "FG-6-bad-fm.md"), "---\nid: FG-6\n");
  assert.throws(() => readTicket(dir, "FG-6"), /unterminated/i);
});

// ----- listTickets -----

test("listTickets returns all tickets when no filter", () => {
  const dir = makeTmpDir();
  writeTicket(dir, makeTicket({ id: "FG-1", type: "story" }));
  writeTicket(dir, makeTicket({ id: "FG-2", type: "epic" }));
  writeTicket(dir, makeTicket({ id: "FG-3", type: "idea" }));
  const all = listTickets(dir);
  assert.equal(all.length, 3);
});

test("listTickets filters by type", () => {
  const dir = makeTmpDir();
  writeTicket(dir, makeTicket({ id: "FG-1", type: "story" }));
  writeTicket(dir, makeTicket({ id: "FG-2", type: "epic" }));
  const stories = listTickets(dir, { type: "story" });
  assert.equal(stories.length, 1);
  assert.equal(stories[0]!.id, "FG-1");
});

test("listTickets filters by status=done", () => {
  const dir = makeTmpDir();
  writeTicket(dir, makeTicket({ id: "FG-1", status: "active" }));
  writeTicket(dir, makeTicket({ id: "FG-2", status: "done" }));
  const done = listTickets(dir, { status: "done" });
  assert.equal(done.length, 1);
  assert.equal(done[0]!.id, "FG-2");
});

test("listTickets returns empty array for empty backlog dir", () => {
  const dir = makeTmpDir();
  assert.deepEqual(listTickets(dir), []);
});

test("listTickets --search matches ticket by title substring (case-insensitive)", () => {
  const dir = makeTmpDir();
  writeTicket(dir, makeTicket({ id: "FG-1", title: "Implement OAuth login", body: "some body" }));
  writeTicket(dir, makeTicket({ id: "FG-2", title: "Fix typo in README", body: "other body" }));
  const results = listTickets(dir, { search: "oauth" });
  assert.equal(results.length, 1);
  assert.equal(results[0]!.id, "FG-1");
});

test("listTickets --search matches ticket by body substring (case-insensitive)", () => {
  const dir = makeTmpDir();
  writeTicket(dir, makeTicket({ id: "FG-1", title: "Feature A", body: "Depends on WidgetFactory refactor" }));
  writeTicket(dir, makeTicket({ id: "FG-2", title: "Feature B", body: "Unrelated content here" }));
  const results = listTickets(dir, { search: "widgetfactory" });
  assert.equal(results.length, 1);
  assert.equal(results[0]!.id, "FG-1");
});

test("listTickets --search returns zero tickets for nonsense string (exact bug reproduction)", () => {
  const dir = makeTmpDir();
  writeTicket(dir, makeTicket({ id: "FG-1", title: "Real ticket one", body: "Real body one" }));
  writeTicket(dir, makeTicket({ id: "FG-2", title: "Real ticket two", body: "Real body two" }));
  const results = listTickets(dir, { search: "definitely-not-a-real-ticket-string" });
  assert.equal(results.length, 0);
});

test("listTickets --search combines with --status filter", () => {
  const dir = makeTmpDir();
  writeTicket(dir, makeTicket({ id: "FG-1", title: "Auth feature", status: "active" }));
  writeTicket(dir, makeTicket({ id: "FG-2", title: "Auth refactor", status: "done" }));
  writeTicket(dir, makeTicket({ id: "FG-3", title: "Unrelated", status: "active" }));
  const results = listTickets(dir, { search: "auth", status: "active" });
  assert.equal(results.length, 1);
  assert.equal(results[0]!.id, "FG-1");
});

test("listTickets --search combines with --type filter", () => {
  const dir = makeTmpDir();
  writeTicket(dir, makeTicket({ id: "FG-1", type: "story", title: "Auth story" }));
  writeTicket(dir, makeTicket({ id: "FG-2", type: "epic", title: "Auth epic" }));
  writeTicket(dir, makeTicket({ id: "FG-3", type: "story", title: "Other story" }));
  const results = listTickets(dir, { search: "auth", type: "story" });
  assert.equal(results.length, 1);
  assert.equal(results[0]!.id, "FG-1");
});

// ----- moveTicket -----

test("moveTicket moves from stories to epics", () => {
  const dir = makeTmpDir();
  writeTicket(dir, makeTicket({ id: "FG-10", type: "story" }));
  moveTicket(dir, "FG-10", "epic");
  const moved = readTicket(dir, "FG-10");
  assert.equal(moved.type, "epic");
  assert.equal(moved.status, "active");
});

test("moveTicket removes file from original location", () => {
  const dir = makeTmpDir();
  writeTicket(dir, makeTicket({ id: "FG-11", type: "story" }));
  moveTicket(dir, "FG-11", "idea");
  // Should be findable in ideas, not in stories
  const storiesDir = join(dir, "backlog", "stories");
  const stories = readdirSync(storiesDir);
  assert.ok(!stories.some((f) => f.startsWith("FG-11")), "FG-11 should not remain in stories/");
});

test("moveTicket throws for unknown id", () => {
  const dir = makeTmpDir();
  assert.throws(() => moveTicket(dir, "FG-999", "epic"), /not found/i);
});

// ----- closeTicket -----

test("closeTicket moves story to done/ and sets status:done", () => {
  const dir = makeTmpDir();
  writeTicket(dir, makeTicket({ id: "FG-20", type: "story" }));
  closeTicket(dir, "FG-20");
  const result = readTicket(dir, "FG-20");
  assert.equal(result.status, "done");
  assert.ok(result.closed, "closed date should be set");
  const doneDir = join(dir, "backlog", "done");
  assert.ok(readdirSync(doneDir).some((f) => f.startsWith("FG-20-")), "FG-20 must be in done/");
  const storiesDir = join(dir, "backlog", "stories");
  assert.ok(!readdirSync(storiesDir).some((f) => f.startsWith("FG-20-")), "FG-20 must not remain in stories/");
});

test("closeTicket moves epic to done/ and removes from epics/", () => {
  const dir = makeTmpDir();
  writeTicket(dir, makeTicket({ id: "FG-21", type: "epic" }));
  closeTicket(dir, "FG-21");
  const result = readTicket(dir, "FG-21");
  assert.equal(result.status, "done");
  const doneDir = join(dir, "backlog", "done");
  assert.ok(readdirSync(doneDir).some((f) => f.startsWith("FG-21-")), "FG-21 must be in done/");
  const epicsDir = join(dir, "backlog", "epics");
  assert.ok(!readdirSync(epicsDir).some((f) => f.startsWith("FG-21-")), "FG-21 must not remain in epics/");
});

test("closeTicket moves idea to done/ and removes from ideas/", () => {
  const dir = makeTmpDir();
  writeTicket(dir, makeTicket({ id: "FG-22", type: "idea" }));
  closeTicket(dir, "FG-22");
  const result = readTicket(dir, "FG-22");
  assert.equal(result.status, "done");
  const doneDir = join(dir, "backlog", "done");
  assert.ok(readdirSync(doneDir).some((f) => f.startsWith("FG-22-")), "FG-22 must be in done/");
  const ideasDir = join(dir, "backlog", "ideas");
  assert.ok(!readdirSync(ideasDir).some((f) => f.startsWith("FG-22-")), "FG-22 must not remain in ideas/");
});

test("closeTicket leaves exactly one copy (no ghost active)", () => {
  const dir = makeTmpDir();
  writeTicket(dir, makeTicket({ id: "FG-23", type: "story" }));
  closeTicket(dir, "FG-23");
  // Count all .md files starting with FG-23 across all backlog dirs
  let count = 0;
  for (const sub of ["stories", "epics", "ideas", "done"]) {
    const d = join(dir, "backlog", sub);
    if (existsSync(d)) count += readdirSync(d).filter((f) => f.startsWith("FG-23-")).length;
  }
  assert.equal(count, 1, "exactly one copy must exist after close");
});

test("moveTicket leaves exactly one copy (no ghost active)", () => {
  const dir = makeTmpDir();
  writeTicket(dir, makeTicket({ id: "FG-24", type: "story" }));
  moveTicket(dir, "FG-24", "epic");
  let count = 0;
  for (const sub of ["stories", "epics", "ideas", "done"]) {
    const d = join(dir, "backlog", sub);
    if (existsSync(d)) count += readdirSync(d).filter((f) => f.startsWith("FG-24-")).length;
  }
  assert.equal(count, 1, "exactly one copy must exist after move");
});

test("closeTicket throws for unknown id", () => {
  const dir = makeTmpDir();
  assert.throws(() => closeTicket(dir, "FG-999"), /not found/i);
});

test("closeTicket records closedCommit when commit sha is provided", () => {
  const dir = makeTmpDir();
  writeTicket(dir, makeTicket({ id: "FG-30", type: "story" }));
  closeTicket(dir, "FG-30", "abc1234def5678");
  const result = readTicket(dir, "FG-30");
  assert.equal(result.status, "done");
  assert.equal(result.closedCommit, "abc1234def5678");
});

test("closeTicket does not emit closedCommit when no commit is provided", () => {
  const dir = makeTmpDir();
  writeTicket(dir, makeTicket({ id: "FG-31", type: "story" }));
  closeTicket(dir, "FG-31");
  const result = readTicket(dir, "FG-31");
  assert.equal(result.status, "done");
  assert.equal(result.closedCommit, undefined);
});

test("writeTicket/readTicket round-trips closedCommit field losslessly", () => {
  const dir = makeTmpDir();
  const ticket = makeTicket({ id: "FG-32", status: "done", closed: "2026-06-24", closedCommit: "deadbeef1234" });
  writeTicket(dir, ticket);
  const result = readTicket(dir, "FG-32");
  assert.equal(result.closedCommit, "deadbeef1234");
  assert.equal(result.closed, "2026-06-24");
});

test("readTicket parses pre-existing done ticket without closed_commit field", () => {
  const dir = makeTmpDir();
  const base = dir + "/backlog/done";
  mkdirSync(base, { recursive: true });
  const content = "---\nid: FG-33\ntype: story\nstatus: done\ntitle: Old done ticket\nclosed: '2026-01-01'\n---\n\nBody.\n";
  writeFileSync(base + "/FG-33-old-done-ticket.md", content);
  const result = readTicket(dir, "FG-33");
  assert.equal(result.status, "done");
  assert.equal(result.closed, "2026-01-01");
  assert.equal(result.closedCommit, undefined);
});

// ----- duplicate-id detection -----

// Simulates the ghost-active state that would result from a crash between
// the destination write and source removal in the old (non-atomic) close path.
function plantGhost(dir: string, id: string): void {
  const base = join(dir, "backlog");
  mkdirSync(join(base, "stories"), { recursive: true });
  mkdirSync(join(base, "done"), { recursive: true });
  const activeContent =
    `---\nid: ${id}\ntype: story\nstatus: active\ntitle: Ghost ticket\n---\n\nGhost body.\n`;
  const doneContent =
    `---\nid: ${id}\ntype: story\nstatus: done\ntitle: Ghost ticket\nclosed: '2026-06-24'\n---\n\nGhost body.\n`;
  writeFileSync(join(base, "stories", `${id}-ghost-ticket.md`), activeContent);
  writeFileSync(join(base, "done", `${id}-ghost-ticket.md`), doneContent);
}

test("readTicket: warns loudly on stderr when ghost active copy exists", () => {
  const dir = makeTmpDir();
  plantGhost(dir, "FG-50");
  const stderr = captureStderr(() => {
    readTicket(dir, "FG-50");
  });
  assert.match(stderr, /ERROR/i, "must print an ERROR to stderr");
  assert.match(stderr, /FG-50/, "error must name the ticket id");
  assert.match(stderr, /multiple|duplicate/i, "error must mention duplicate/multiple");
});

test("readTicket: returns done copy when ghost active copy exists", () => {
  const dir = makeTmpDir();
  plantGhost(dir, "FG-51");
  let result!: StructuredTicket;
  captureStderr(() => {
    result = readTicket(dir, "FG-51");
  });
  assert.equal(result.status, "done", "done copy must win over ghost active copy");
});

test("listTickets: warns loudly on stderr when ghost active copy exists", () => {
  const dir = makeTmpDir();
  plantGhost(dir, "FG-52");
  const stderr = captureStderr(() => {
    listTickets(dir);
  });
  assert.match(stderr, /ERROR/i, "must print an ERROR to stderr");
  assert.match(stderr, /FG-52/, "error must name the ticket id");
  assert.match(stderr, /duplicate/i, "error must mention duplicate");
});

test("listTickets: deduplicates ghost — returns exactly one entry and done copy wins", () => {
  const dir = makeTmpDir();
  plantGhost(dir, "FG-53");
  let tickets!: StructuredTicket[];
  captureStderr(() => {
    tickets = listTickets(dir);
  });
  const matches = tickets.filter((t) => t.id === "FG-53");
  assert.equal(matches.length, 1, "listTickets must return exactly one entry per id");
  assert.equal(matches[0]!.status, "done", "done copy must win in listTickets");
});

test("listTickets: ghost active is not returned when filtering status=active", () => {
  const dir = makeTmpDir();
  plantGhost(dir, "FG-54");
  // Also add a real active ticket so the list isn't empty
  writeTicket(dir, makeTicket({ id: "FG-55", type: "story", status: "active" }));
  let tickets!: StructuredTicket[];
  captureStderr(() => {
    tickets = listTickets(dir, { status: "active" });
  });
  assert.ok(!tickets.some((t) => t.id === "FG-54"), "ghost ticket FG-54 must not appear as active");
  assert.ok(tickets.some((t) => t.id === "FG-55"), "real active ticket FG-55 must be present");
});

// FG-403 regressions: listTickets must scan all dirs regardless of status filter

test("listTickets --status done: ghost duplicate emits warning AND returns done copy", () => {
  const dir = makeTmpDir();
  plantGhost(dir, "FG-70");
  let tickets!: StructuredTicket[];
  const stderr = captureStderr(() => {
    tickets = listTickets(dir, { status: "done" });
  });
  assert.match(stderr, /ERROR/i, "must print ERROR to stderr even with --status done");
  assert.match(stderr, /FG-70/, "error must name the ticket id");
  assert.match(stderr, /duplicate/i, "error must mention duplicate");
  const matches = tickets.filter((t) => t.id === "FG-70");
  assert.equal(matches.length, 1, "must return exactly one entry for the ghost id");
  assert.equal(matches[0]!.status, "done", "done copy must win");
});

test("listTickets --status done: returns status:done ticket stranded in active dir", () => {
  const dir = makeTmpDir();
  // Simulate partial-failure: done-content written to stories/ but renameSync never ran
  const base = join(dir, "backlog");
  mkdirSync(join(base, "stories"), { recursive: true });
  const strandedContent =
    `---\nid: FG-71\ntype: story\nstatus: done\ntitle: Stranded done ticket\nclosed: '2026-06-24'\n---\n\nBody.\n`;
  writeFileSync(join(base, "stories", "FG-71-stranded-done-ticket.md"), strandedContent);
  // No copy exists in done/
  const tickets = listTickets(dir, { status: "done" });
  const match = tickets.find((t) => t.id === "FG-71");
  assert.ok(match, "stranded status:done ticket must appear in --status done results");
  assert.equal(match!.status, "done");
});

test("listTickets: ghost for epic type reports correctly", () => {
  const dir = makeTmpDir();
  const base = join(dir, "backlog");
  mkdirSync(join(base, "epics"), { recursive: true });
  mkdirSync(join(base, "done"), { recursive: true });
  const activeContent = `---\nid: FG-60\ntype: epic\nstatus: active\ntitle: Epic ghost\n---\n\nBody.\n`;
  const doneContent = `---\nid: FG-60\ntype: epic\nstatus: done\ntitle: Epic ghost\nclosed: '2026-06-24'\n---\n\nBody.\n`;
  writeFileSync(join(base, "epics", "FG-60-epic-ghost.md"), activeContent);
  writeFileSync(join(base, "done", "FG-60-epic-ghost.md"), doneContent);
  let tickets!: StructuredTicket[];
  const stderr = captureStderr(() => {
    tickets = listTickets(dir);
  });
  assert.match(stderr, /ERROR/i);
  assert.match(stderr, /FG-60/);
  const matches = tickets.filter((t) => t.id === "FG-60");
  assert.equal(matches.length, 1);
  assert.equal(matches[0]!.status, "done");
});

// ----- moveTicket closed-field clearing (FG-409) -----

test("moveTicket reopening done ticket clears closed and closedCommit from parsed frontmatter", () => {
  const dir = makeTmpDir();
  writeTicket(dir, makeTicket({ id: "FG-409-a", type: "story" }));
  closeTicket(dir, "FG-409-a", "deadbeef1234");
  const doneResult = readTicket(dir, "FG-409-a");
  assert.equal(doneResult.status, "done");
  assert.ok(doneResult.closed, "closed must be set after closeTicket");
  assert.equal(doneResult.closedCommit, "deadbeef1234");

  moveTicket(dir, "FG-409-a", "story");
  const reopened = readTicket(dir, "FG-409-a");
  assert.equal(reopened.status, "active");
  assert.equal(reopened.closed, undefined, "closed must be absent after reopen");
  assert.equal(reopened.closedCommit, undefined, "closedCommit must be absent after reopen");
});

test("moveTicket reopening done ticket clears closed fields from raw file content", () => {
  const dir = makeTmpDir();
  writeTicket(dir, makeTicket({ id: "FG-409-b", type: "epic" }));
  closeTicket(dir, "FG-409-b", "cafebabe9876");
  moveTicket(dir, "FG-409-b", "story");

  const storiesDir = join(dir, "backlog", "stories");
  const files = readdirSync(storiesDir).filter((f) => f.startsWith("FG-409-b-"));
  assert.equal(files.length, 1, "exactly one file in stories/ after reopen");
  const raw = readFileSync(join(storiesDir, files[0]!), "utf8");
  assert.ok(!raw.includes("closed:"), "raw file must not contain closed: field");
  assert.ok(!raw.includes("closed_commit:"), "raw file must not contain closed_commit: field");
});

test("moveTicket active-to-active move does not add spurious close fields", () => {
  const dir = makeTmpDir();
  writeTicket(dir, makeTicket({ id: "FG-409-c", type: "story" }));
  moveTicket(dir, "FG-409-c", "epic");
  const result = readTicket(dir, "FG-409-c");
  assert.equal(result.status, "active");
  assert.equal(result.type, "epic");
  assert.equal(result.closed, undefined, "active ticket must have no closed field after active-to-active move");
  assert.equal(result.closedCommit, undefined, "active ticket must have no closedCommit after active-to-active move");
  const epicsDir = join(dir, "backlog", "epics");
  assert.ok(readdirSync(epicsDir).some((f) => f.startsWith("FG-409-c-")), "ticket must land in epics/");
});

test("moveTicket reopening done ticket lands in correct type dir and is single-location", () => {
  const dir = makeTmpDir();
  writeTicket(dir, makeTicket({ id: "FG-409-d", type: "story" }));
  closeTicket(dir, "FG-409-d");
  moveTicket(dir, "FG-409-d", "epic");

  let count = 0;
  for (const sub of ["stories", "epics", "ideas", "done"]) {
    const d = join(dir, "backlog", sub);
    if (existsSync(d)) count += readdirSync(d).filter((f) => f.startsWith("FG-409-d-")).length;
  }
  assert.equal(count, 1, "exactly one copy must exist after reopen");
  const epicsDir = join(dir, "backlog", "epics");
  assert.ok(readdirSync(epicsDir).some((f) => f.startsWith("FG-409-d-")), "ticket must be in epics/ not done/");
});

test("moveTicket idempotent re-move does not reintroduce close fields", () => {
  const dir = makeTmpDir();
  writeTicket(dir, makeTicket({ id: "FG-409-e", type: "story" }));
  closeTicket(dir, "FG-409-e", "abc123");
  moveTicket(dir, "FG-409-e", "epic");
  // Move again — story→epic is already done; re-move epic→story
  moveTicket(dir, "FG-409-e", "story");
  const result = readTicket(dir, "FG-409-e");
  assert.equal(result.status, "active");
  assert.equal(result.closed, undefined, "closed must remain absent after second move");
  assert.equal(result.closedCommit, undefined, "closedCommit must remain absent after second move");
  const storiesDir = join(dir, "backlog", "stories");
  const files = readdirSync(storiesDir).filter((f) => f.startsWith("FG-409-e-"));
  assert.equal(files.length, 1, "ticket must be single-location after second move");
  const raw = readFileSync(join(storiesDir, files[0]!), "utf8");
  assert.ok(!raw.includes("closed:"), "raw file must not contain closed: after re-move");
  assert.ok(!raw.includes("closed_commit:"), "raw file must not contain closed_commit: after re-move");
});

// ----- fillClosedCommit (FG-367) -----

test("fillClosedCommit: writes closedCommit without changing closed date", () => {
  const dir = makeTmpDir();
  writeTicket(dir, makeTicket({ id: "FG-500", type: "story", status: "done", closed: "2026-06-15" }));
  const fakeSha = "aabbccdd1122";

  const doneDir = join(dir, "backlog", "done");
  const filesBefore = readdirSync(doneDir).filter((f) => f.startsWith("FG-500-"));
  assert.equal(filesBefore.length, 1, "setup: exactly one FG-500 file must be in done/ before fillClosedCommit");

  fillClosedCommit(dir, "FG-500", fakeSha);

  const result = readTicket(dir, "FG-500");
  assert.equal(result.closedCommit, fakeSha, "closedCommit must be written");
  assert.equal(result.closed, "2026-06-15", "closed date must be unchanged");

  // Verify fillClosedCommit writes in-place: same file, same location, no duplication or move.
  const filesAfter = readdirSync(doneDir).filter((f) => f.startsWith("FG-500-"));
  assert.equal(filesAfter.length, 1, "ticket must remain as exactly one file in backlog/done/ after fillClosedCommit");
  assert.equal(filesAfter[0], filesBefore[0], "ticket filename in backlog/done/ must be unchanged — fillClosedCommit must write in-place");
});

test("fillClosedCommit: no-op when closedCommit already present (agent SHA wins)", () => {
  const dir = makeTmpDir();
  const originalSha = "original1234";
  writeTicket(dir, makeTicket({ id: "FG-501", type: "story", status: "done", closed: "2026-06-15", closedCommit: originalSha }));
  fillClosedCommit(dir, "FG-501", "different5678");
  const result = readTicket(dir, "FG-501");
  assert.equal(result.closedCommit, originalSha, "existing SHA must not be overwritten");
});

test("fillClosedCommit: no-op when ticket status is not done", () => {
  const dir = makeTmpDir();
  writeTicket(dir, makeTicket({ id: "FG-502", type: "story", status: "active" }));
  fillClosedCommit(dir, "FG-502", "shouldnotappear");
  const result = readTicket(dir, "FG-502");
  assert.equal(result.closedCommit, undefined, "active ticket must not have closedCommit written");
  assert.equal(result.status, "active", "ticket status must remain active");
});

test("fillClosedCommit: silently ignores missing ticket", () => {
  const dir = makeTmpDir();
  // Must not throw even when the ticket does not exist
  assert.doesNotThrow(() => fillClosedCommit(dir, "FG-NONEXISTENT", "anysha"));
});

// ----- FG-360: edit must never re-slug the filename -----

function countFilesForId(dir: string, id: string): number {
  let count = 0;
  for (const sub of ["stories", "epics", "ideas", "done"]) {
    const d = join(dir, "backlog", sub);
    if (existsSync(d)) count += readdirSync(d).filter((f) => f.startsWith(`${id}-`)).length;
  }
  return count;
}

test("writeTicket: body-only update on a ticket whose frontmatter title diverged from its slug does not create a second file", () => {
  const dir = makeTmpDir();
  writeTicket(dir, makeTicket({ id: "FG-600", title: "original title" }));
  const before = readTicket(dir, "FG-600");

  // Simulate title having drifted from the slug (e.g. hand-edited frontmatter),
  // then a body-only edit — the historical bug re-slugged from the new title.
  writeTicket(dir, { ...before, title: "a completely different title", body: "same body, new title" });

  assert.equal(countFilesForId(dir, "FG-600"), 1, "exactly one file must exist for FG-600");
  const result = readTicket(dir, "FG-600");
  assert.equal(result.body.trim(), "same body, new title");
});

test("writeTicket: resolved path for a diverged-title ticket is the original file, not a title-derived one", () => {
  const dir = makeTmpDir();
  writeTicket(dir, makeTicket({ id: "FG-601", title: "keep-this-slug" }));
  const originalFiles = readdirSync(join(dir, "backlog", "stories"));

  const ticket = readTicket(dir, "FG-601");
  writeTicket(dir, { ...ticket, title: "totally unrelated new title", body: "edited body" });

  const filesAfter = readdirSync(join(dir, "backlog", "stories"));
  assert.deepEqual(filesAfter, originalFiles, "filename must be unchanged by a title/body update via writeTicket");
});

test("retitleTicket: updates frontmatter title in the single existing file", () => {
  const dir = makeTmpDir();
  writeTicket(dir, makeTicket({ id: "FG-602", title: "old title" }));
  retitleTicket(dir, "FG-602", "new title");

  assert.equal(countFilesForId(dir, "FG-602"), 1, "exactly one file must exist for FG-602");
  const result = readTicket(dir, "FG-602");
  assert.equal(result.title, "new title");
});

test("retitleTicket: updates a heading in the body that echoes the old title", () => {
  const dir = makeTmpDir();
  writeTicket(dir, makeTicket({ id: "FG-603", title: "old title", body: "### old title\n\nSome details." }));
  retitleTicket(dir, "FG-603", "new title");

  const result = readTicket(dir, "FG-603");
  assert.equal(result.title, "new title");
  assert.match(result.body, /^### new title/);
  assert.doesNotMatch(result.body, /old title/);
});

test("retitleTicket: leaves body untouched when it has no title-echoing heading", () => {
  const dir = makeTmpDir();
  writeTicket(dir, makeTicket({ id: "FG-604", title: "old title", body: "Just some prose, no heading." }));
  retitleTicket(dir, "FG-604", "new title");

  const result = readTicket(dir, "FG-604");
  assert.equal(result.title, "new title");
  assert.equal(result.body.trim(), "Just some prose, no heading.");
});

test("retitleTicket: never renames the file (slug stays fixed)", () => {
  const dir = makeTmpDir();
  writeTicket(dir, makeTicket({ id: "FG-605", title: "keep-this-slug" }));
  const before = readdirSync(join(dir, "backlog", "stories"));
  retitleTicket(dir, "FG-605", "a wildly different title entirely");
  const after = readdirSync(join(dir, "backlog", "stories"));
  assert.deepEqual(after, before, "retitle must not change the filename");
});

test("retitleTicket: throws for unknown id", () => {
  const dir = makeTmpDir();
  assert.throws(() => retitleTicket(dir, "FG-999", "new title"), /not found/i);
});

test("ticketExists: true after writeTicket, false for unknown id", () => {
  const dir = makeTmpDir();
  writeTicket(dir, makeTicket({ id: "FG-606" }));
  assert.equal(ticketExists(dir, "FG-606"), true);
  assert.equal(ticketExists(dir, "FG-NOPE"), false);
});

test("writeTicket: guard scenario — writing to an id that already exists on disk updates in place rather than duplicating", () => {
  const dir = makeTmpDir();
  writeTicket(dir, makeTicket({ id: "FG-607", title: "first title" }));
  assert.ok(ticketExists(dir, "FG-607"));

  // A second writeTicket call for the same id (as edit performs) must land
  // on the existing file, never create a duplicate with a title-derived name.
  writeTicket(dir, makeTicket({ id: "FG-607", title: "second title", body: "updated" }));
  assert.equal(countFilesForId(dir, "FG-607"), 1, "no duplicate file may be created for an id that already exists");
});

test("listTickets: regression — never double-counts a ticket after a body-only edit with a diverged title", () => {
  const dir = makeTmpDir();
  writeTicket(dir, makeTicket({ id: "FG-608", title: "original title" }));
  const ticket = readTicket(dir, "FG-608");
  writeTicket(dir, { ...ticket, title: "diverged title", body: "edited" });

  const results = listTickets(dir).filter((t) => t.id === "FG-608");
  assert.equal(results.length, 1, "list must not double-count FG-608");
});
