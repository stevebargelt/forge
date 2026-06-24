import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  generateSlug,
  readTicket,
  writeTicket,
  listTickets,
  moveTicket,
  type StructuredTicket,
} from "./structured.js";

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
