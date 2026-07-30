// FG-607 (FG-496 Slice B): the `forge backlog mode --set` guards, through the REAL
// CLI against the REAL on-disk store.
//
// Both directions of the flip can lose data, and both refuse:
//   - `--set db` on an unseeded id sequence would mint ids duplicating history the
//     DB cannot see (a single checkout's backlog/ is git-tracked and per-branch,
//     and project_key spans every clone and linked worktree — "empty here" never
//     means "empty for this project"). Only `forge backlog import` seeds it.
//   - `--set markdown` while db-only tickets exist would leave them in the DB,
//     invisible, with nothing pointing at them. The refusal names them; the
//     operator who means it passes --allow-orphaned-tickets and gets the same list
//     as a warning.
// The negative path is the point: a refusal must leave NO state behind.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getDb } from "../store/db.js";
import { getIdSequence, getStorageMode, ticketsForProject } from "../store/tickets.js";
import { authorityTestkitEnv, withAuthorityTestkit } from "./container-authority.testkit-spawn.js";

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, "..", "cli", "index.ts");
const localTsx = resolve(here, "..", "..", "node_modules", ".bin", "tsx");
const tsx = existsSync(localTsx) ? localTsx : "tsx";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "fg607-flip-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(res.status, 0, `git ${args.join(" ")} failed: ${res.stderr}`);
  return res.stdout;
}

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  writeFileSync(join(dir, "README.md"), "seed\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "init"]);
}

function forge(projectDir: string, args: string[]) {
  return spawnSync(tsx, withAuthorityTestkit(entry, [...args, "--project", projectDir]), {
    cwd: projectDir,
    input: "",
    encoding: "utf8",
    env: { ...process.env, ...authorityTestkitEnv() },
  });
}

function writeMarkdownTicket(projectDir: string, id: string): void {
  const dir = join(projectDir, "backlog", "stories");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${id}-slug.md`),
    `---\nid: ${id}\ntype: story\nstatus: active\ntitle: ${id} title\n---\n\nbody\n`,
  );
}

function fileTicket(projectDir: string, title: string): string {
  const res = forge(projectDir, ["backlog", "file", title]);
  assert.equal(res.status, 0, res.stderr);
  // db mode prints "Created FG-3: title"; markdown mode "Created FG-3 in stories/…".
  return res.stdout.match(/^Created ([A-Z]+-\d+)/m)![1]!;
}

function markdownIdsOnDisk(projectDir: string): string[] {
  const dir = join(projectDir, "backlog", "stories");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).map((f) => f.match(/^([A-Z]+-\d+)/)![1]!);
}

function shownMode(projectDir: string): { mode: string; projectKey: string | null } {
  const res = forge(projectDir, ["backlog", "mode", "--json"]);
  assert.equal(res.status, 0, res.stderr);
  return JSON.parse(res.stdout) as { mode: string; projectKey: string | null };
}

// Import, flip to db, file two tickets that exist ONLY in the DB.
function projectWithDbOnlyTickets(): { project: string; projectKey: string; dbOnly: string[] } {
  const project = join(root, "proj");
  initRepo(project);
  writeMarkdownTicket(project, "FG-1");

  const imported = forge(project, ["backlog", "import", "--json"]);
  assert.equal(imported.status, 0, `import failed: ${imported.stderr}`);
  const projectKey = (JSON.parse(imported.stdout) as { projectKey: string }).projectKey;
  assert.equal(forge(project, ["backlog", "mode", "--set", "db", "--json"]).status, 0);

  const dbOnly = [fileTicket(project, "db-only one"), fileTicket(project, "db-only two")];
  return { project, projectKey, dbOnly };
}

// FG-608 changed the PRECEDENCE here, not the FG-607 guard. Filing a ticket in db
// mode is itself a DB-ONLY EDIT, and FG-608 records the first one so
// `mode --set markdown` can refuse afterward (accepted default (d): the one-way
// cutover property is ENFORCED, not documented). That refusal is broader and fires
// first — it also covers db edits to tickets that DO have a Markdown file, which
// the orphan check cannot see. The FG-607 orphan refusal below is unchanged and
// still reachable; it is simply behind the newer, stricter one.
test("integ FG-608/FG-607: `mode --set markdown` REFUSES after a db-only edit, and writes nothing", () => {
  const { project, projectKey, dbOnly } = projectWithDbOnlyTickets();

  const res = forge(project, ["backlog", "mode", "--set", "markdown"]);
  assert.equal(res.status, 1, `expected a refusal; stdout: ${res.stdout} stderr: ${res.stderr}`);
  assert.match(res.stderr, /refusing to set markdown mode/);
  assert.match(res.stderr, /DB-only edits since it cut over/, "the FG-608 refusal fires first");
  assert.match(res.stderr, /--accept-frozen-markdown-loss/, "and names its own opt-out");

  // NO state written: the mode is untouched and every ticket is still there.
  assert.equal(shownMode(project).mode, "db", "a refused flip must not change the mode");
  getDb();
  assert.equal(getStorageMode(projectKey), "db");
  assert.equal(ticketsForProject(projectKey).length, 3);

  // Behind the FG-608 refusal, the FG-607 ORPHAN refusal is unchanged: accept the
  // frozen-Markdown loss and the orphan guard is what stops the flip next.
  const orphanRefusal = forge(project, [
    "backlog", "mode", "--set", "markdown", "--accept-frozen-markdown-loss",
  ]);
  assert.equal(orphanRefusal.status, 1, orphanRefusal.stderr);
  assert.match(orphanRefusal.stderr, /unreachable/);
  assert.match(orphanRefusal.stderr, /--allow-orphaned-tickets/);
  for (const id of dbOnly) {
    assert.ok(orphanRefusal.stderr.includes(id), `the refusal must name ${id}: ${orphanRefusal.stderr}`);
  }
  assert.ok(!orphanRefusal.stderr.includes("FG-1 "), "a ticket that IS in Markdown is not orphaned");
  assert.equal(shownMode(project).mode, "db", "still refused, still unchanged");
});

test("integ FG-607: --allow-orphaned-tickets flips anyway and warns with the same list", () => {
  const { project, dbOnly } = projectWithDbOnlyTickets();

  // Both opt-outs are required and they are deliberately SEPARATE flags: one
  // accepts stranding db-only tickets, the other accepts losing db edits to
  // tickets that still have a Markdown file. Neither implies the other.
  const res = forge(project, [
    "backlog", "mode", "--set", "markdown",
    "--allow-orphaned-tickets", "--accept-frozen-markdown-loss", "--json",
  ]);
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  assert.equal((JSON.parse(res.stdout) as { mode: string }).mode, "markdown");
  assert.match(res.stderr, /unreachable/);
  for (const id of dbOnly) {
    assert.ok(res.stderr.includes(id), `the warning must name ${id}: ${res.stderr}`);
  }

  assert.equal(shownMode(project).mode, "markdown");
  // The Markdown ticket is what the project reads now — the db-only ones are gone
  // from view, exactly as the warning said.
  const listed = JSON.parse(forge(project, ["backlog", "list", "--json"]).stdout) as { id: string }[];
  assert.deepEqual(listed.map((t) => t.id), ["FG-1"]);
});

// Nothing to orphan -> no refusal and no warning. The guard must not become
// operator friction on the ordinary flip back.
test("integ FG-607: `mode --set markdown` flips cleanly when every db ticket has a Markdown file", () => {
  const project = join(root, "clean");
  initRepo(project);
  writeMarkdownTicket(project, "FG-1");
  assert.equal(forge(project, ["backlog", "import", "--json"]).status, 0);
  assert.equal(forge(project, ["backlog", "mode", "--set", "db", "--json"]).status, 0);

  const res = forge(project, ["backlog", "mode", "--set", "markdown", "--json"]);
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  assert.equal((JSON.parse(res.stdout) as { mode: string }).mode, "markdown");
  assert.doesNotMatch(res.stderr, /unreachable/);
  assert.equal(shownMode(project).mode, "markdown");
});

// F9, the documented cutover path: a sequence that EXISTS is not a sequence that
// is CURRENT. Markdown-mode allocation reads backlog/ for max+1 and never bumps
// next_seq, so every ticket filed between the import and the flip leaves it
// behind — and the first db-mode `file` would mint an id that already exists as a
// backlog/*.md file, invisibly (the DB's collision check cannot see Markdown).
test("integ FG-607: a ticket filed in markdown mode AFTER the import is not minted a second time in db mode", () => {
  const project = join(root, "stale-seq");
  initRepo(project);
  writeMarkdownTicket(project, "FG-1");

  const imported = forge(project, ["backlog", "import", "--json"]);
  assert.equal(imported.status, 0, `import failed: ${imported.stderr}`);
  const projectKey = (JSON.parse(imported.stdout) as { projectKey: string }).projectKey;
  getDb();
  assert.equal(getIdSequence(projectKey, "FG"), 2, "import seeds past the Markdown it saw");

  const beforeCutover = fileTicket(project, "filed while still in markdown mode");
  assert.equal(beforeCutover, "FG-2");
  assert.equal(getIdSequence(projectKey, "FG"), 2, "markdown allocation left next_seq behind");

  const flipped = forge(project, ["backlog", "mode", "--set", "db", "--json"]);
  assert.equal(flipped.status, 0, `mode --set db failed: ${flipped.stderr}`);
  // Never silently: the operator is told what moved and why.
  assert.match(flipped.stderr, /advanced id sequence for prefix 'FG': 2 -> 3/);
  assert.deepEqual(
    (JSON.parse(flipped.stdout) as { advancedSequences: unknown[] }).advancedSequences,
    [{ prefix: "FG", from: 2, to: 3 }],
  );

  const afterCutover = fileTicket(project, "filed after the cutover");
  assert.equal(afterCutover, "FG-3");
  assert.ok(
    !markdownIdsOnDisk(project).includes(afterCutover),
    `db mode minted ${afterCutover}, which already exists as a backlog/*.md file`,
  );
});

// F10: import seeds from ONE checkout at ONE moment. When that checkout's backlog/
// is a strict SUBSET of the project's tickets (a linked worktree on an older
// branch — backlog/ is git-tracked, project_key spans every worktree), the seeded
// sequence sits BELOW ids that really exist. The flip re-derives it in the
// checkout it runs in rather than trusting the seed.
test("integ FG-607: a flip after an import from a SUBSET checkout seeds above the true high-water mark", () => {
  const full = join(root, "full");
  const subset = join(root, "subset");
  initRepo(full);

  writeMarkdownTicket(full, "FG-3");
  git(full, ["add", "-A"]);
  git(full, ["commit", "-qm", "FG-3"]);
  const subsetSha = git(full, ["rev-parse", "HEAD"]).trim();

  writeMarkdownTicket(full, "FG-4");
  writeMarkdownTicket(full, "FG-40");
  git(full, ["add", "-A"]);
  git(full, ["commit", "-qm", "the rest of the backlog"]);

  // The sibling worktree carries FG-3 only.
  git(full, ["worktree", "add", "-q", "-b", "subset", subset, subsetSha]);
  assert.deepEqual(markdownIdsOnDisk(subset), ["FG-3"]);

  const imported = forge(subset, ["backlog", "import", "--json"]);
  assert.equal(imported.status, 0, `import failed: ${imported.stderr}`);
  const projectKey = (JSON.parse(imported.stdout) as { projectKey: string }).projectKey;
  getDb();
  assert.equal(getIdSequence(projectKey, "FG"), 4, "the subset import seeded BELOW FG-40");

  const flipped = forge(full, ["backlog", "mode", "--set", "db", "--json"]);
  assert.equal(flipped.status, 0, `mode --set db failed: ${flipped.stderr}`);
  assert.match(flipped.stderr, /advanced id sequence for prefix 'FG': 4 -> 41/);
  assert.equal(getIdSequence(projectKey, "FG"), 41, "the flip seeded above every id it can see");

  const filed = fileTicket(full, "after the cutover");
  assert.equal(filed, "FG-41");
  assert.ok(
    !markdownIdsOnDisk(full).includes(filed),
    `db mode minted ${filed}, which already exists as a backlog/*.md file`,
  );
});

// The single-checkout limitation is inherent — forge cannot read a sibling
// worktree's branch content. Where the guard cannot OBSERVE the Markdown side at
// all, it fails closed and says so; "no backlog/ here" is never read as "no
// tickets anywhere" for a project that demonstrably has some.
test("integ FG-607: `mode --set db` refuses when this checkout has no backlog/ but the project has tickets", () => {
  const project = join(root, "unverifiable");
  initRepo(project);
  writeMarkdownTicket(project, "FG-7");

  const imported = forge(project, ["backlog", "import", "--json"]);
  assert.equal(imported.status, 0, `import failed: ${imported.stderr}`);
  const projectKey = (JSON.parse(imported.stdout) as { projectKey: string }).projectKey;

  // The checkout no longer carries backlog/ (a branch that predates it, here
  // simply removed) — its Markdown ids are now unobservable.
  rmSync(join(project, "backlog"), { recursive: true, force: true });

  const res = forge(project, ["backlog", "mode", "--set", "db"]);
  assert.equal(res.status, 1, `expected a refusal; stdout: ${res.stdout} stderr: ${res.stderr}`);
  assert.match(res.stderr, /refusing to set db mode/);
  assert.match(res.stderr, /no backlog\/ directory/);
  assert.match(res.stderr, /cannot verify/);

  assert.equal(shownMode(project).mode, "markdown", "a refused flip must not change the mode");
  getDb();
  assert.equal(getStorageMode(projectKey), "markdown");
});

// F2: the flip must never seed the sequence from a single checkout's filesystem.
// backlog/ is git-tracked (per-branch) and project_key spans clones and linked
// worktrees, so an empty local backlog/ does NOT prove the project has no ids.
test("integ FG-607: `mode --set db` refuses on an unseeded sequence even with an empty local backlog/", () => {
  const project = join(root, "empty-here");
  initRepo(project);
  mkdirSync(join(project, "backlog", "stories"), { recursive: true });

  const res = forge(project, ["backlog", "mode", "--set", "db"]);
  assert.equal(res.status, 1, `expected a refusal; stdout: ${res.stdout} stderr: ${res.stderr}`);
  assert.match(res.stderr, /refusing to set db mode/);
  assert.match(res.stderr, /forge backlog import/);

  // Nothing behind: no mode record, no healed (git-tracked) config.
  assert.equal(shownMode(project).mode, "markdown");
  assert.equal(existsSync(join(project, ".forge", "config.yml")), false, "no config heal on a refused flip");
  const porcelain = spawnSync("git", ["status", "--porcelain"], { cwd: project, encoding: "utf8" }).stdout;
  assert.ok(!porcelain.includes(".forge"), `the refused flip dirtied .forge:\n${porcelain}`);
});
