// FG-607 (FG-496 Slice B): db-mode seam writes are ATOMIC and CONTENDED-SAFE.
//
// The id-allocation test next door proves N concurrent `backlog file` calls hand
// out N distinct ids. This file covers the other half of the same hard
// constraint — what happens when a write inside the transaction FAILS, and what
// happens when concurrent processes mutate the store in ways that are not
// allocation.
//
// Real child processes against a REAL on-disk DB, for the reason src/store/db.ts
// documents: on a single-connection :memory: DB SQLite degenerates BEGIN
// IMMEDIATE to BEGIN, so neither the rollback boundary nor the contention this
// file is about exists in the in-memory unit harness.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getDb } from "../store/db.js";
import { getIdSequence, getTicket, ticketsForProject, upsertTicket } from "../store/tickets.js";
import { authorityTestkitEnv, withAuthorityTestkit } from "./container-authority.testkit-spawn.js";

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, "..", "cli", "index.ts");
const localTsx = resolve(here, "..", "..", "node_modules", ".bin", "tsx");
const tsx = existsSync(localTsx) ? localTsx : "tsx";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "fg607-atomic-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function runGit(cwd: string, args: string[]): void {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(res.status, 0, `git ${args.join(" ")} failed: ${res.stderr}`);
}

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  runGit(dir, ["init", "-q"]);
  runGit(dir, ["config", "user.email", "test@example.com"]);
  runGit(dir, ["config", "user.name", "Test"]);
  writeFileSync(join(dir, "README.md"), "seed\n");
  runGit(dir, ["add", "-A"]);
  runGit(dir, ["commit", "-qm", "init"]);
}

function forge(projectDir: string, args: string[]) {
  return spawnSync(tsx, withAuthorityTestkit(entry, [...args, "--project", projectDir]), {
    cwd: projectDir,
    input: "",
    encoding: "utf8",
    env: { ...process.env, ...authorityTestkitEnv() },
  });
}

function forgeAsync(
  projectDir: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((res) => {
    const child = spawn(tsx, withAuthorityTestkit(entry, [...args, "--project", projectDir]), {
      cwd: projectDir,
      env: { ...process.env, ...authorityTestkitEnv() },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += String(c)));
    child.stderr.on("data", (c) => (stderr += String(c)));
    child.stdin.end();
    child.on("close", (code) => res({ code: code ?? -1, stdout, stderr }));
  });
}

function writeMarkdownTicket(projectDir: string, id: string, title: string): void {
  const dir = join(projectDir, "backlog", "stories");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${id}-slug.md`),
    `---\nid: ${id}\ntype: story\nstatus: active\ntitle: ${title}\n---\n\nmarkdown body\n`,
  );
}

// Import (seeds the id sequence past the Markdown high-water mark) then flip.
function importAndFlip(projectDir: string): string {
  const imported = forge(projectDir, ["backlog", "import", "--json"]);
  assert.equal(imported.status, 0, `import failed: ${imported.stderr}`);
  const key = (JSON.parse(imported.stdout) as { projectKey: string }).projectKey;

  const flipped = forge(projectDir, ["backlog", "mode", "--set", "db", "--json"]);
  assert.equal(flipped.status, 0, `mode --set db failed: ${flipped.stderr}`);
  assert.equal((JSON.parse(flipped.stdout) as { mode: string }).mode, "db");
  return key;
}

function fileTicket(projectDir: string, title: string): string {
  const res = forge(projectDir, ["backlog", "file", title, "--body", `body of ${title}`]);
  assert.equal(res.status, 0, `file failed: ${res.stderr}`);
  const m = res.stdout.match(/Created (\S+):/);
  assert.ok(m, `could not parse an id from: ${res.stdout}`);
  return m![1]!;
}

// The hard constraint: id allocation happens INSIDE the write transaction. If the
// insert that follows it fails, the sequence bump must roll back with it —
// otherwise every failed `backlog file` silently burns an id, and a project's ids
// develop holes that nothing can explain after the fact.
test("integ FG-607: a `backlog file` that fails mid-transaction burns no id", () => {
  const project = join(root, "burn");
  initRepo(project);
  const key = importAndFlip(project);

  getDb();
  assert.equal(getIdSequence(key, "FG"), 1, "an empty project's import seeds the sequence at 1");

  // Plant the exact row allocation is about to collide with. This is the real
  // shape of the seam's own duplicate guard firing (fileNewTicket refuses rather
  // than clobbering), and the only way to make the insert fail after the
  // sequence has already been bumped.
  upsertTicket({
    projectKey: key,
    ticketId: "FG-1",
    type: "story",
    status: "active",
    title: "planted",
    body: "planted body",
    importedAt: new Date().toISOString(),
  });

  const res = forge(project, ["backlog", "file", "would collide with FG-1"]);
  assert.notEqual(res.status, 0, `expected a refusal; stdout: ${res.stdout} stderr: ${res.stderr}`);
  assert.match(res.stderr, /already exists/);

  assert.equal(
    getIdSequence(key, "FG"),
    1,
    "the allocation bump must roll back with the failed insert — a burned id is a hole nothing can explain later",
  );
  const rows = ticketsForProject(key);
  assert.equal(rows.length, 1, "the failed file wrote no row");
  assert.equal(rows[0]!.title, "planted", "the planted row was not clobbered");

  // And the id is still available: the next file gets FG-1... except FG-1 is
  // taken, so remove the planted row and prove allocation resumes at 1.
  getDb().prepare(`DELETE FROM tickets WHERE project_key = ? AND ticket_id = ?`).run(key, "FG-1");
  assert.equal(fileTicket(project, "the real first ticket"), "FG-1");
});

// A mutation that cannot find its ticket must write NOTHING — no ghost row, no
// sequence movement — and must not be rescued by a Markdown file, because the
// mode is authoritative.
test("integ FG-607: a failed db-mode mutation leaves the store untouched and never falls back to Markdown", () => {
  const project = join(root, "nofallback");
  initRepo(project);
  writeMarkdownTicket(project, "FG-1", "imported one");
  const key = importAndFlip(project);

  getDb();
  const seqBefore = getIdSequence(key, "FG");
  const rowsBefore = ticketsForProject(key).length;

  // FG-404 exists ONLY as Markdown. In db mode that is not a ticket.
  writeMarkdownTicket(project, "FG-404", "markdown only");

  for (const args of [
    ["backlog", "close", "FG-404"],
    ["backlog", "retitle", "FG-404", "renamed"],
    ["backlog", "move", "FG-404", "epic"],
    ["backlog", "edit", "FG-404", "--body", "new body"],
  ]) {
    const res = forge(project, args);
    assert.notEqual(
      res.status,
      0,
      `\`${args.join(" ")}\` must fail in db mode, not read the Markdown file; stdout: ${res.stdout}`,
    );
    assert.match(res.stderr, /Ticket FG-404 not found/);
  }

  assert.equal(getIdSequence(key, "FG"), seqBefore, "a failed mutation moved the id sequence");
  assert.equal(ticketsForProject(key).length, rowsBefore, "a failed mutation wrote a ghost row");
  assert.equal(getTicket(key, "FG-404"), undefined, "FG-404 was never a db ticket");
});

// BEGIN IMMEDIATE is what replaces the filesystem lock on the db path. Concurrent
// mutations from separate processes must therefore QUEUE, not collide: every
// invocation succeeds, none surfaces SQLITE_BUSY, and each ticket ends in one
// whole coherent state rather than a blend of two writers.
test("integ FG-607: concurrent db-mode mutations serialize — no SQLITE_BUSY, no half-applied ticket", async () => {
  const project = join(root, "contended");
  initRepo(project);
  const key = importAndFlip(project);

  const a = fileTicket(project, "alpha");
  const b = fileTicket(project, "bravo");
  const c = fileTicket(project, "charlie");

  const bodies = ["contended v0", "contended v1", "contended v2"];
  const results = await Promise.all([
    ...bodies.map((body) => forgeAsync(project, ["backlog", "edit", a, "--body", body])),
    forgeAsync(project, ["backlog", "retitle", b, "renamed under contention"]),
    forgeAsync(project, ["backlog", "close", c, "--commit", "deadbee"]),
    forgeAsync(project, ["backlog", "file", "filed under contention"]),
  ]);

  for (const r of results) {
    assert.equal(r.code, 0, `a concurrent mutation failed: ${r.stderr}`);
    assert.doesNotMatch(
      r.stderr,
      /SQLITE_BUSY|database is locked/i,
      `contention surfaced as a lock error instead of queueing: ${r.stderr}`,
    );
  }

  getDb();
  // The edited ticket holds exactly ONE of the three bodies — last writer wins,
  // which one is genuinely nondeterministic, but a blend would mean a write was
  // not atomic.
  const edited = getTicket(key, a);
  assert.ok(edited, `${a} disappeared under contention`);
  assert.ok(
    bodies.includes(edited!.body),
    `expected one whole body, got a value no single writer wrote: ${JSON.stringify(edited!.body)}`,
  );

  const retitled = getTicket(key, b);
  assert.equal(retitled?.title, "renamed under contention");

  const closed = getTicket(key, c);
  assert.equal(closed?.status, "done");
  assert.equal(closed?.closedCommit, "deadbee");

  // Three seeded + one filed under contention, and the concurrent file did not
  // reuse an existing id.
  const ids = ticketsForProject(key).map((t) => t.ticketId);
  assert.equal(ids.length, 4, `expected 4 tickets, got ${ids.join(", ")}`);
  assert.equal(new Set(ids).size, 4);
  assert.equal(getIdSequence(key, "FG"), 5, "exactly four ids were allocated in total");
});
