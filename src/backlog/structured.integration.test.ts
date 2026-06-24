// Integration tests for structured backlog CLI operations (FG-312 phase 2).
// These exercise the full CLI (tsx entry point) against real fixture directories.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, "..", "cli", "index.ts");
const localTsx = resolve(here, "..", "..", "node_modules", ".bin", "tsx");
const tsx = existsSync(localTsx) ? localTsx : "tsx";

let projectDir: string;

function runForge(args: string[]) {
  return spawnSync(tsx, [entry, ...args], {
    cwd: projectDir,
    encoding: "utf8",
  });
}

function makeTicketFile(content: string): string {
  return content;
}

// Sets up a structured backlog fixture:
//   backlog/
//     ideas/   FG-10-improve-docs.md
//     epics/   FG-20-big-feature.md
//     stories/ FG-30-implement-thing.md
//     done/    FG-5-already-done.md
// Plus a .forge/config.yml with prefix: FG
function setupStructuredBacklog() {
  mkdirSync(join(projectDir, ".forge"), { recursive: true });
  writeFileSync(
    join(projectDir, ".forge", "config.yml"),
    "backlog:\n  prefix: FG\n",
  );

  const base = join(projectDir, "backlog");
  mkdirSync(join(base, "ideas"), { recursive: true });
  mkdirSync(join(base, "epics"), { recursive: true });
  mkdirSync(join(base, "stories"), { recursive: true });
  mkdirSync(join(base, "done"), { recursive: true });

  writeFileSync(
    join(base, "ideas", "FG-10-improve-docs.md"),
    makeTicketFile(
      "---\nid: FG-10\ntype: idea\nstatus: active\ntitle: Improve docs\ncreated: '2026-01-01'\n---\n\nWe should improve the documentation.\n",
    ),
  );

  writeFileSync(
    join(base, "epics", "FG-20-big-feature.md"),
    makeTicketFile(
      "---\nid: FG-20\ntype: epic\nstatus: active\ntitle: Big feature\ncreated: '2026-01-10'\n---\n\nThe big feature epic body.\n",
    ),
  );

  writeFileSync(
    join(base, "stories", "FG-30-implement-thing.md"),
    makeTicketFile(
      "---\nid: FG-30\ntype: story\nstatus: active\ntitle: Implement thing\ncreated: '2026-02-01'\n---\n\nThe story for implementing the thing.\n",
    ),
  );

  writeFileSync(
    join(base, "done", "FG-5-already-done.md"),
    makeTicketFile(
      "---\nid: FG-5\ntype: story\nstatus: done\ntitle: Already done\ncreated: '2025-12-01'\nclosed: '2026-01-05'\n---\n\nThis ticket was already completed.\n",
    ),
  );
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "forge-structured-integ-"));
  setupStructuredBacklog();
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

// ─── forge backlog list ───────────────────────────────────────────────────────

test("integ structured: backlog list --type epic returns only epics", () => {
  const res = runForge(["backlog", "list", "--type", "epic", "--project", projectDir]);
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  assert.match(res.stdout, /FG-20/);
  assert.match(res.stdout, /Big feature/);
  assert.doesNotMatch(res.stdout, /FG-10/, "ideas should not appear in epic filter");
  assert.doesNotMatch(res.stdout, /FG-30/, "stories should not appear in epic filter");
});

test("integ structured: backlog list --type story returns only stories", () => {
  const res = runForge(["backlog", "list", "--type", "story", "--project", projectDir]);
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  assert.match(res.stdout, /FG-30/);
  assert.match(res.stdout, /Implement thing/);
  assert.doesNotMatch(res.stdout, /FG-20/, "epics should not appear in story filter");
});

test("integ structured: backlog list with no filter returns all tickets", () => {
  const res = runForge(["backlog", "list", "--project", projectDir]);
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  // Should include tickets from ideas, epics, stories, and done
  assert.match(res.stdout, /FG-10/);
  assert.match(res.stdout, /FG-20/);
  assert.match(res.stdout, /FG-30/);
});

test("integ structured: backlog list --json returns valid JSON array", () => {
  const res = runForge(["backlog", "list", "--type", "epic", "--json", "--project", projectDir]);
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  let parsed: unknown;
  assert.doesNotThrow(() => { parsed = JSON.parse(res.stdout); }, "output must be valid JSON");
  assert.ok(Array.isArray(parsed), "output should be an array");
  const arr = parsed as Array<{ id: string; type: string; status: string; title: string }>;
  assert.equal(arr.length, 1);
  assert.equal(arr[0]!.id, "FG-20");
  assert.equal(arr[0]!.type, "epic");
});

test("integ structured: backlog list --status done returns only done tickets", () => {
  const res = runForge(["backlog", "list", "--status", "done", "--project", projectDir]);
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  assert.match(res.stdout, /FG-5/);
  assert.match(res.stdout, /Already done/);
  assert.doesNotMatch(res.stdout, /FG-30/, "active stories should not appear in done filter");
});

// ─── forge backlog show ───────────────────────────────────────────────────────

test("integ structured: backlog show FG-20 prints epic body", () => {
  const res = runForge(["backlog", "show", "FG-20", "--project", projectDir]);
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  assert.match(res.stdout, /FG-20/);
  assert.match(res.stdout, /Big feature/);
  assert.match(res.stdout, /epic/);
  assert.match(res.stdout, /big feature epic body/i);
});

test("integ structured: backlog show FG-30 prints story body", () => {
  const res = runForge(["backlog", "show", "FG-30", "--project", projectDir]);
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  assert.match(res.stdout, /FG-30/);
  assert.match(res.stdout, /Implement thing/);
  assert.match(res.stdout, /implementing the thing/i);
});

test("integ structured: backlog show FG-5 reads ticket from done/ directory", () => {
  const res = runForge(["backlog", "show", "FG-5", "--project", projectDir]);
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  assert.match(res.stdout, /FG-5/);
  assert.match(res.stdout, /Already done/);
});

test("integ structured: backlog show --json returns valid JSON with all fields", () => {
  const res = runForge(["backlog", "show", "FG-20", "--json", "--project", projectDir]);
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  let ticket: unknown;
  assert.doesNotThrow(() => { ticket = JSON.parse(res.stdout); });
  const t = ticket as Record<string, unknown>;
  assert.equal(t["id"], "FG-20");
  assert.equal(t["type"], "epic");
  assert.equal(t["status"], "active");
  assert.equal(t["title"], "Big feature");
  assert.ok(typeof t["body"] === "string");
});

test("integ structured: backlog show unknown id exits non-zero", () => {
  const res = runForge(["backlog", "show", "FG-999", "--project", projectDir]);
  assert.notEqual(res.status, 0, "must exit non-zero for missing ticket");
});

// ─── forge backlog file ───────────────────────────────────────────────────────

test("integ structured: backlog file creates new story with frontmatter", () => {
  const res = runForge(["backlog", "file", "New test ticket", "--project", projectDir]);
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  assert.match(res.stdout, /Created FG-/);

  // Verify the file landed in stories/
  const storiesDir = join(projectDir, "backlog", "stories");
  const files = readdirSync(storiesDir);
  const newFile = files.find((f) => f.includes("new-test-ticket"));
  assert.ok(newFile, `expected a file matching 'new-test-ticket' in stories/, got: ${files.join(", ")}`);
});

test("integ structured: backlog file creates file with valid frontmatter", () => {
  runForge(["backlog", "file", "Another ticket", "--project", projectDir]);

  const storiesDir = join(projectDir, "backlog", "stories");
  const files = readdirSync(storiesDir);
  const newFile = files.find((f) => f.includes("another-ticket"));
  assert.ok(newFile, "expected 'another-ticket' file in stories/");

  const content = readFileSync(join(storiesDir, newFile!), "utf8");
  assert.match(content, /^---\n/, "must start with YAML frontmatter delimiter");
  assert.match(content, /id: FG-/, "must contain id field");
  assert.match(content, /type: story/, "must have type: story by default");
  assert.match(content, /status: active/, "must have status: active");
  assert.match(content, /title: Another ticket/, "must contain the title");
  assert.match(content, /created:/, "must have a created date");
});

test("integ structured: backlog file --type epic creates file in epics/", () => {
  const res = runForge(["backlog", "file", "Epic ticket", "--type", "epic", "--project", projectDir]);
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);

  const epicsDir = join(projectDir, "backlog", "epics");
  const files = readdirSync(epicsDir);
  const newFile = files.find((f) => f.includes("epic-ticket"));
  assert.ok(newFile, `expected 'epic-ticket' file in epics/, got: ${files.join(", ")}`);
});

test("integ structured: backlog file auto-increments id beyond existing tickets", () => {
  // Existing tickets go up to FG-30; new one should be FG-31
  const res = runForge(["backlog", "file", "FG-31 check", "--project", projectDir]);
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  assert.match(res.stdout, /FG-31/);
});

test("integ structured: backlog file with --body sets ticket body", () => {
  const res = runForge([
    "backlog", "file", "Ticket with body",
    "--body", "This is the body text.",
    "--project", projectDir,
  ]);
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);

  const storiesDir = join(projectDir, "backlog", "stories");
  const files = readdirSync(storiesDir);
  const newFile = files.find((f) => f.includes("ticket-with-body"));
  assert.ok(newFile, "expected new file in stories/");

  const content = readFileSync(join(storiesDir, newFile!), "utf8");
  assert.match(content, /This is the body text\./);
});

// ─── forge backlog close ──────────────────────────────────────────────────────

test("integ structured: backlog close FG-30 moves story to done/", () => {
  const res = runForge(["backlog", "close", "FG-30", "--project", projectDir]);
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  assert.match(res.stdout, /Closed FG-30/);

  // File should now be in done/
  const doneDir = join(projectDir, "backlog", "done");
  const doneFiles = readdirSync(doneDir);
  const closed = doneFiles.find((f) => f.startsWith("FG-30-"));
  assert.ok(closed, `expected FG-30 in done/, found: ${doneFiles.join(", ")}`);

  // File should no longer be in stories/
  const storiesDir = join(projectDir, "backlog", "stories");
  if (existsSync(storiesDir)) {
    const stories = readdirSync(storiesDir);
    assert.ok(
      !stories.some((f) => f.startsWith("FG-30-")),
      "FG-30 should not remain in stories/ after close",
    );
  }
});

test("integ structured: backlog close sets status to done in frontmatter", () => {
  runForge(["backlog", "close", "FG-30", "--project", projectDir]);

  const doneDir = join(projectDir, "backlog", "done");
  const doneFiles = readdirSync(doneDir);
  const closed = doneFiles.find((f) => f.startsWith("FG-30-"));
  assert.ok(closed);

  const content = readFileSync(join(doneDir, closed!), "utf8");
  assert.match(content, /status: done/);
  assert.match(content, /closed:/);
});

test("integ structured: backlog close FG-20 moves epic to done/", () => {
  const res = runForge(["backlog", "close", "FG-20", "--project", projectDir]);
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);

  const doneDir = join(projectDir, "backlog", "done");
  const doneFiles = readdirSync(doneDir);
  const closed = doneFiles.find((f) => f.startsWith("FG-20-"));
  assert.ok(closed, `expected FG-20 in done/, found: ${doneFiles.join(", ")}`);

  const epicsDir = join(projectDir, "backlog", "epics");
  if (existsSync(epicsDir)) {
    const epics = readdirSync(epicsDir);
    assert.ok(
      !epics.some((f) => f.startsWith("FG-20-")),
      "FG-20 should not remain in epics/ after close",
    );
  }
});

test("integ structured: backlog close unknown id exits non-zero", () => {
  const res = runForge(["backlog", "close", "FG-999", "--project", projectDir]);
  assert.notEqual(res.status, 0, "must exit non-zero for missing ticket");
});

test("integ FG-399: backlog close --commit records sha in done ticket frontmatter", () => {
  const res = runForge(["backlog", "close", "FG-30", "--commit", "abc1234", "--project", projectDir]);
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);

  const doneDir = join(projectDir, "backlog", "done");
  const closed = readdirSync(doneDir).find((f) => f.startsWith("FG-30-"));
  assert.ok(closed, "FG-30 must be in done/");
  const content = readFileSync(join(doneDir, closed!), "utf8");
  assert.match(content, /closed_commit: abc1234/, "closed_commit must appear in frontmatter");
});

test("integ FG-399: backlog close without --commit emits no closed_commit field", () => {
  const res = runForge(["backlog", "close", "FG-30", "--project", projectDir]);
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);

  const doneDir = join(projectDir, "backlog", "done");
  const closed = readdirSync(doneDir).find((f) => f.startsWith("FG-30-"));
  assert.ok(closed, "FG-30 must be in done/");
  const content = readFileSync(join(doneDir, closed!), "utf8");
  assert.doesNotMatch(content, /closed_commit/, "closed_commit must not appear when --commit is omitted");
});

test("integ FG-399: show --json after close --commit round-trips closedCommit field", () => {
  const sha = "deadbeef9876";
  const closeRes = runForge(["backlog", "close", "FG-30", "--commit", sha, "--project", projectDir]);
  assert.equal(closeRes.status, 0, `close failed: ${closeRes.stderr}`);

  const showRes = runForge(["backlog", "show", "FG-30", "--json", "--project", projectDir]);
  assert.equal(showRes.status, 0, `show failed: ${showRes.stderr}`);
  const ticket = JSON.parse(showRes.stdout) as Record<string, unknown>;
  assert.equal(ticket["closedCommit"], sha, "closedCommit must survive the close->show round-trip");
  assert.equal(ticket["status"], "done");
});

test("integ FG-399: show --json on pre-existing done ticket with no closed_commit has no closedCommit field", () => {
  // FG-5 was written without a closed_commit field in setupStructuredBacklog()
  const showRes = runForge(["backlog", "show", "FG-5", "--json", "--project", projectDir]);
  assert.equal(showRes.status, 0, `show failed: ${showRes.stderr}`);
  const ticket = JSON.parse(showRes.stdout) as Record<string, unknown>;
  assert.equal(ticket["status"], "done");
  assert.ok(!("closedCommit" in ticket), "closedCommit must be absent from a ticket that was never closed with --commit");
});

// ─── forge backlog move ───────────────────────────────────────────────────────

test("integ structured: backlog move FG-30 epic moves story to epics/", () => {
  const res = runForge(["backlog", "move", "FG-30", "epic", "--project", projectDir]);
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  assert.match(res.stdout, /Moved FG-30.*epic/);

  const epicsDir = join(projectDir, "backlog", "epics");
  const epics = readdirSync(epicsDir);
  const moved = epics.find((f) => f.startsWith("FG-30-"));
  assert.ok(moved, `expected FG-30 in epics/, found: ${epics.join(", ")}`);
});

test("integ structured: backlog move FG-30 epic removes from stories/", () => {
  runForge(["backlog", "move", "FG-30", "epic", "--project", projectDir]);

  const storiesDir = join(projectDir, "backlog", "stories");
  if (existsSync(storiesDir)) {
    const stories = readdirSync(storiesDir);
    assert.ok(
      !stories.some((f) => f.startsWith("FG-30-")),
      "FG-30 should not remain in stories/ after move to epic",
    );
  }
});

test("integ structured: backlog move updates type in frontmatter", () => {
  runForge(["backlog", "move", "FG-30", "epic", "--project", projectDir]);

  const epicsDir = join(projectDir, "backlog", "epics");
  const epics = readdirSync(epicsDir);
  const moved = epics.find((f) => f.startsWith("FG-30-"));
  assert.ok(moved);

  const content = readFileSync(join(epicsDir, moved!), "utf8");
  assert.match(content, /type: epic/);
  assert.match(content, /status: active/);
});

test("integ structured: backlog move FG-20 story moves epic to stories/", () => {
  const res = runForge(["backlog", "move", "FG-20", "story", "--project", projectDir]);
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);

  const storiesDir = join(projectDir, "backlog", "stories");
  const stories = readdirSync(storiesDir);
  const moved = stories.find((f) => f.startsWith("FG-20-"));
  assert.ok(moved, `expected FG-20 in stories/, found: ${stories.join(", ")}`);
});

test("integ structured: backlog move FG-30 idea moves story to ideas/", () => {
  const res = runForge(["backlog", "move", "FG-30", "idea", "--project", projectDir]);
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);

  const ideasDir = join(projectDir, "backlog", "ideas");
  const ideas = readdirSync(ideasDir);
  const moved = ideas.find((f) => f.startsWith("FG-30-"));
  assert.ok(moved, `expected FG-30 in ideas/, found: ${ideas.join(", ")}`);
});

test("integ structured: backlog move unknown id exits non-zero", () => {
  const res = runForge(["backlog", "move", "FG-999", "epic", "--project", projectDir]);
  assert.notEqual(res.status, 0, "must exit non-zero for missing ticket");
});

// ─── close: idea type ────────────────────────────────────────────────────────

test("integ structured: backlog close FG-10 moves idea to done/", () => {
  const res = runForge(["backlog", "close", "FG-10", "--project", projectDir]);
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  assert.match(res.stdout, /Closed FG-10/);

  const doneDir = join(projectDir, "backlog", "done");
  const doneFiles = readdirSync(doneDir);
  const closed = doneFiles.find((f) => f.startsWith("FG-10-"));
  assert.ok(closed, `expected FG-10 in done/, found: ${doneFiles.join(", ")}`);

  const ideasDir = join(projectDir, "backlog", "ideas");
  if (existsSync(ideasDir)) {
    const ideas = readdirSync(ideasDir);
    assert.ok(
      !ideas.some((f) => f.startsWith("FG-10-")),
      "FG-10 should not remain in ideas/ after close",
    );
  }
});

// ─── duplicate-id (ghost active) detection via CLI ───────────────────────────

// Plants a ghost state: ticket exists in both an active dir and done/,
// simulating a partial failure from the old write-then-delete close path.
function plantGhostInteg(base: string, id: string, type: "stories" | "epics" | "ideas"): void {
  const activeContent = `---\nid: ${id}\ntype: story\nstatus: active\ntitle: Ghost ticket\n---\n\nGhost.\n`;
  const doneContent = `---\nid: ${id}\ntype: story\nstatus: done\ntitle: Ghost ticket\nclosed: '2026-06-24'\n---\n\nGhost.\n`;
  mkdirSync(join(base, type), { recursive: true });
  mkdirSync(join(base, "done"), { recursive: true });
  writeFileSync(join(base, type, `${id}-ghost-ticket.md`), activeContent);
  writeFileSync(join(base, "done", `${id}-ghost-ticket.md`), doneContent);
}

test("integ structured: backlog show prints ERROR on stderr for ghost active ticket", () => {
  plantGhostInteg(join(projectDir, "backlog"), "FG-99", "stories");
  const res = runForge(["backlog", "show", "FG-99", "--project", projectDir]);
  assert.equal(res.status, 0, `command should still succeed`);
  assert.match(res.stderr, /ERROR/i, "must print ERROR to stderr for ghost ticket");
  assert.match(res.stderr, /FG-99/, "stderr must name the ticket id");
});

test("integ structured: backlog show returns done copy for ghost active ticket", () => {
  plantGhostInteg(join(projectDir, "backlog"), "FG-98", "stories");
  const res = runForge(["backlog", "show", "FG-98", "--json", "--project", projectDir]);
  assert.equal(res.status, 0);
  const ticket = JSON.parse(res.stdout) as Record<string, unknown>;
  assert.equal(ticket["status"], "done", "done copy must be returned, not the ghost active");
});

test("integ structured: backlog list warns on stderr for ghost active ticket", () => {
  plantGhostInteg(join(projectDir, "backlog"), "FG-97", "stories");
  const res = runForge(["backlog", "list", "--project", projectDir]);
  assert.equal(res.status, 0);
  assert.match(res.stderr, /ERROR/i, "must warn on stderr for ghost ticket");
  assert.match(res.stderr, /FG-97/);
});

test("integ structured: backlog list shows done status for ghost active ticket", () => {
  plantGhostInteg(join(projectDir, "backlog"), "FG-96", "epics");
  const res = runForge(["backlog", "list", "--json", "--project", projectDir]);
  assert.equal(res.status, 0);
  const tickets = JSON.parse(res.stdout) as Array<{ id: string; status: string }>;
  const ghost = tickets.filter((t) => t.id === "FG-96");
  assert.equal(ghost.length, 1, "ghost ticket must appear exactly once");
  assert.equal(ghost[0]!.status, "done", "ghost ticket must be shown with done status");
});

// ─── FG-397: atomicity guarantee — close-then-access cross-step handoffs ─────

// Verifies the atomicity guarantee: after a close, immediately querying list
// or show must return the done copy and never see an active ghost.
test("integ FG-397: close story then list shows exactly one done copy, no active ghost", () => {
  const res = runForge(["backlog", "close", "FG-30", "--project", projectDir]);
  assert.equal(res.status, 0, `close failed: ${res.stderr}`);

  const list = runForge(["backlog", "list", "--json", "--project", projectDir]);
  assert.equal(list.status, 0, `list failed: ${list.stderr}`);
  const tickets = JSON.parse(list.stdout) as Array<{ id: string; status: string }>;
  const copies = tickets.filter((t) => t.id === "FG-30");
  assert.equal(copies.length, 1, "ticket must appear exactly once in list after close");
  assert.equal(copies[0]!.status, "done", "ticket must be shown with done status after close");
  assert.equal(list.stderr, "", "no duplicate-id warnings expected after atomic close");
});

test("integ FG-397: close story then show returns done status (atomicity)", () => {
  runForge(["backlog", "close", "FG-30", "--project", projectDir]);

  const show = runForge(["backlog", "show", "FG-30", "--json", "--project", projectDir]);
  assert.equal(show.status, 0, `show after close failed: ${show.stderr}`);
  const ticket = JSON.parse(show.stdout) as Record<string, unknown>;
  assert.equal(ticket["status"], "done", "show must return done status after close");
  assert.equal(show.stderr, "", "no ghost warning expected after atomic close");
});

test("integ FG-397: close epic then list shows exactly one done copy, no active ghost", () => {
  runForge(["backlog", "close", "FG-20", "--project", projectDir]);

  const list = runForge(["backlog", "list", "--json", "--project", projectDir]);
  assert.equal(list.status, 0);
  const tickets = JSON.parse(list.stdout) as Array<{ id: string; status: string }>;
  const copies = tickets.filter((t) => t.id === "FG-20");
  assert.equal(copies.length, 1, "epic must appear exactly once after close");
  assert.equal(copies[0]!.status, "done");
  assert.equal(list.stderr, "", "no ghost warning expected after atomic close");
});

test("integ FG-397: close idea then list shows exactly one done copy, no active ghost", () => {
  runForge(["backlog", "close", "FG-10", "--project", projectDir]);

  const list = runForge(["backlog", "list", "--json", "--project", projectDir]);
  assert.equal(list.status, 0);
  const tickets = JSON.parse(list.stdout) as Array<{ id: string; status: string }>;
  const copies = tickets.filter((t) => t.id === "FG-10");
  assert.equal(copies.length, 1, "idea must appear exactly once after close");
  assert.equal(copies[0]!.status, "done");
  assert.equal(list.stderr, "", "no ghost warning expected after atomic close");
});

test("integ FG-397: move story to epic leaves exactly one copy across all dirs", () => {
  runForge(["backlog", "move", "FG-30", "epic", "--project", projectDir]);

  const base = join(projectDir, "backlog");
  let count = 0;
  for (const sub of ["stories", "epics", "ideas", "done"]) {
    const d = join(base, sub);
    if (existsSync(d)) count += readdirSync(d).filter((f) => f.startsWith("FG-30-")).length;
  }
  assert.equal(count, 1, "exactly one copy must exist across all backlog dirs after move");
});

test("integ FG-397: move epic to story leaves exactly one copy across all dirs", () => {
  runForge(["backlog", "move", "FG-20", "story", "--project", projectDir]);

  const base = join(projectDir, "backlog");
  let count = 0;
  for (const sub of ["stories", "epics", "ideas", "done"]) {
    const d = join(base, sub);
    if (existsSync(d)) count += readdirSync(d).filter((f) => f.startsWith("FG-20-")).length;
  }
  assert.equal(count, 1, "exactly one copy must exist across all backlog dirs after move");
});

test("integ FG-397: move story to idea leaves exactly one copy across all dirs", () => {
  runForge(["backlog", "move", "FG-30", "idea", "--project", projectDir]);

  const base = join(projectDir, "backlog");
  let count = 0;
  for (const sub of ["stories", "epics", "ideas", "done"]) {
    const d = join(base, sub);
    if (existsSync(d)) count += readdirSync(d).filter((f) => f.startsWith("FG-30-")).length;
  }
  assert.equal(count, 1, "exactly one copy must exist across all backlog dirs after move");
});

// ─── FG-397: ghost detection in ideas/ directory via CLI ─────────────────────

test("integ FG-397: ghost in ideas dir — show prints ERROR to stderr", () => {
  plantGhostInteg(join(projectDir, "backlog"), "FG-95", "ideas");
  const res = runForge(["backlog", "show", "FG-95", "--project", projectDir]);
  assert.equal(res.status, 0, "command must succeed even with ghost");
  assert.match(res.stderr, /ERROR/i, "must print ERROR for ghost in ideas/");
  assert.match(res.stderr, /FG-95/);
});

test("integ FG-397: ghost in ideas dir — show returns done copy, not active ghost", () => {
  plantGhostInteg(join(projectDir, "backlog"), "FG-94", "ideas");
  const res = runForge(["backlog", "show", "FG-94", "--json", "--project", projectDir]);
  assert.equal(res.status, 0);
  const ticket = JSON.parse(res.stdout) as Record<string, unknown>;
  assert.equal(ticket["status"], "done", "done copy must win over ghost active in ideas/");
});

test("integ FG-397: ghost in ideas dir — list warns and returns done copy", () => {
  plantGhostInteg(join(projectDir, "backlog"), "FG-93", "ideas");
  const res = runForge(["backlog", "list", "--json", "--project", projectDir]);
  assert.equal(res.status, 0);
  assert.match(res.stderr, /ERROR/i, "list must warn on stderr for ghost in ideas/");
  assert.match(res.stderr, /FG-93/);
  const tickets = JSON.parse(res.stdout) as Array<{ id: string; status: string }>;
  const matches = tickets.filter((t) => t.id === "FG-93");
  assert.equal(matches.length, 1, "ghost in ideas/ must appear exactly once in list");
  assert.equal(matches[0]!.status, "done", "done copy must win for ghost in ideas/");
});
