// FG-607 (FG-496 Slice B), the three ACs about what an OPERATOR observes:
//
//   "CLI clearly prints whether it read legacy Markdown or the DB"  — on EVERY
//   seam-touching invocation, on stderr so --json stdout stays machine-clean.
//   "git status stays clean after file/edit/close in db mode"       — including
//   retitle and move, which also rewrite a Markdown file in the default mode.
//   "Additive schema only; no user_version bump"                    — a full
//   db-mode CRUD cycle must not evolve the store.
//
// Real child processes so the assertions are about what the operator's terminal
// and `git status` actually show, not about what the library returns.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { authorityTestkitEnv, withAuthorityTestkit } from "./container-authority.testkit-spawn.js";

const here = dirname(fileURLToPath(import.meta.url));
import { NODE_EXEC as tsx, BUILT_CLI_ENTRY as entry } from "../integration-cli-spawn.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "fg607-banner-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function runGit(cwd: string, args: string[]): string {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(res.status, 0, `git ${args.join(" ")} failed: ${res.stderr}`);
  return res.stdout;
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
    // Each CLI child gets a private store. The DB-mode assertions below must
    // never read or mutate the operator's real ~/.forge/forge.db.
    env: { ...process.env, FORGE_HOME: join(root, "home"), ...authorityTestkitEnv() },
  });
}

function writeMarkdownTicket(projectDir: string, id: string, title: string): void {
  const dir = join(projectDir, "backlog", "stories");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${id}-slug.md`),
    `---\nid: ${id}\ntype: story\nstatus: active\ntitle: ${title}\n---\n\nbody\n`,
  );
}

function importAndFlip(projectDir: string): string {
  const imported = forge(projectDir, ["backlog", "import", "--json"]);
  assert.equal(imported.status, 0, `import failed: ${imported.stderr}`);
  const key = (JSON.parse(imported.stdout) as { projectKey: string }).projectKey;
  const flipped = forge(projectDir, ["backlog", "mode", "--set", "db", "--json"]);
  assert.equal(flipped.status, 0, `mode --set db failed: ${flipped.stderr}`);
  return key;
}

/** The banner lines the CLI wrote — everything on stderr that names a store. */
function bannerLines(stderr: string): string[] {
  return stderr.split("\n").filter((l) => l.startsWith("store:"));
}

// Every seam-touching verb, in the order an operator would use them, so a
// subcommand added to the skip-list by accident shows up as a missing banner
// rather than as silence nobody notices.
const SEAM_VERBS: Array<{ name: string; args: (id: string) => string[] }> = [
  { name: "list", args: () => ["backlog", "list"] },
  { name: "show", args: (id) => ["backlog", "show", id] },
  { name: "edit", args: (id) => ["backlog", "edit", id, "--body", "edited body"] },
  { name: "retitle", args: (id) => ["backlog", "retitle", id, "a new title"] },
  { name: "move", args: (id) => ["backlog", "move", id, "epic"] },
  { name: "close", args: (id) => ["backlog", "close", id, "--commit", "abc1234"] },
];

test("integ FG-607: every seam-touching `forge backlog` verb names the store it read (legacy markdown)", () => {
  const project = join(root, "markdown");
  initRepo(project);
  writeMarkdownTicket(project, "FG-1", "a ticket");

  const filed = forge(project, ["backlog", "file", "another ticket"]);
  assert.equal(filed.status, 0, filed.stderr);
  assert.deepEqual(bannerLines(filed.stderr), ["store: legacy markdown"]);

  for (const verb of SEAM_VERBS) {
    const res = forge(project, verb.args("FG-1"));
    assert.equal(res.status, 0, `${verb.name} failed: ${res.stderr}`);
    assert.deepEqual(
      bannerLines(res.stderr),
      ["store: legacy markdown"],
      `\`backlog ${verb.name}\` printed no store banner`,
    );
  }
});

test("integ FG-607: every seam-touching verb names the store it read (db), and flags a stale backlog/", () => {
  const project = join(root, "db");
  initRepo(project);
  writeMarkdownTicket(project, "FG-1", "a ticket");
  const key = importAndFlip(project);

  // backlog/ is still on disk here — git-tracked, and the cutover has not removed
  // it. The banner has to say so, because a reader who sees the directory and
  // reasonably assumes it is authoritative is exactly the split-truth confusion
  // FG-496 exists to end.
  const stale = `store: db (project_key=${key}) — backlog/ present but NOT authoritative`;
  for (const verb of SEAM_VERBS) {
    const res = forge(project, verb.args("FG-1"));
    assert.equal(res.status, 0, `${verb.name} failed: ${res.stderr}`);
    assert.deepEqual(bannerLines(res.stderr), [stale], `\`backlog ${verb.name}\` banner`);
  }

  // Post-cutover: no backlog/ directory, so no stale suffix.
  rmSync(join(project, "backlog"), { recursive: true, force: true });
  const after = forge(project, ["backlog", "list"]);
  assert.equal(after.status, 0, after.stderr);
  assert.deepEqual(bannerLines(after.stderr), [`store: db (project_key=${key})`]);
});

// The banner goes to stderr precisely so it cannot corrupt a --json consumer.
test("integ FG-607: the store banner never contaminates --json stdout", () => {
  const project = join(root, "json");
  initRepo(project);
  writeMarkdownTicket(project, "FG-1", "a ticket");
  const key = importAndFlip(project);

  const list = forge(project, ["backlog", "list", "--json"]);
  assert.equal(list.status, 0, list.stderr);
  assert.ok(bannerLines(list.stderr).length === 1, "the banner must still be printed, on stderr");
  assert.deepEqual(
    (JSON.parse(list.stdout) as { id: string }[]).map((t) => t.id),
    ["FG-1"],
    "stdout must parse as JSON with nothing prepended",
  );

  const show = forge(project, ["backlog", "show", "FG-1", "--json"]);
  assert.equal(show.status, 0, show.stderr);
  assert.equal((JSON.parse(show.stdout) as { id: string }).id, "FG-1");

  // The identity-REPAIR verbs deliberately skip the banner: their own refusals
  // are the operator-facing output, and on --json a banner-first resolution
  // could preempt the structured object.
  const mode = forge(project, ["backlog", "mode", "--json"]);
  assert.equal(mode.status, 0, mode.stderr);
  assert.deepEqual(bannerLines(mode.stderr), []);
  assert.equal((JSON.parse(mode.stdout) as { projectKey: string }).projectKey, key);

  const notes = forge(project, ["backlog", "notes", "show"]);
  assert.equal(notes.status, 0, notes.stderr);
  assert.deepEqual(bannerLines(notes.stderr), [], "`notes` never touches the seam, so it never resolves");
});

// The AC as an operator states it: in db mode, working on the backlog does not
// show up in `git status`. Covers retitle and move as well as file/edit/close —
// in markdown mode both rewrite (and move) a tracked file.
test("integ FG-607: a full db-mode CRUD cycle leaves git status completely clean", () => {
  const project = join(root, "clean");
  initRepo(project);
  writeMarkdownTicket(project, "FG-1", "a ticket");
  importAndFlip(project);

  // Commit the healed .forge/config.yml and the pre-existing backlog/ so the
  // baseline really is clean; everything after this must add nothing.
  runGit(project, ["add", "-A"]);
  runGit(project, ["commit", "-qm", "adopt db mode"]);
  assert.equal(runGit(project, ["status", "--porcelain"]), "", "baseline is not clean");

  const filed = forge(project, ["backlog", "file", "brand new", "--body", "v1"]);
  assert.equal(filed.status, 0, filed.stderr);
  const id = filed.stdout.match(/Created (\S+):/)![1]!;

  const beforeEdit = forge(project, ["backlog", "list", "--json"]);
  assert.equal(beforeEdit.status, 0, beforeEdit.stderr);
  assert.ok(
    (JSON.parse(beforeEdit.stdout) as { id: string }[]).some((ticket) => ticket.id === id),
    "list reads the ticket filed into the DB store",
  );

  for (const args of [
    ["backlog", "edit", id, "--body", "v2"],
    ["backlog", "retitle", id, "renamed in db mode"],
    ["backlog", "move", id, "epic"],
    ["backlog", "close", id, "--commit", "abc1234"],
  ]) {
    const res = forge(project, args);
    assert.equal(res.status, 0, `\`${args.join(" ")}\` failed: ${res.stderr}`);
  }

  assert.equal(
    runGit(project, ["status", "--porcelain"]),
    "",
    "db-mode CRUD dirtied the working tree",
  );

  // ...and the ticket really did change; a clean tree because nothing happened
  // would pass the assertion above for the wrong reason.
  const shown = forge(project, ["backlog", "show", id, "--json"]);
  assert.equal(shown.status, 0, shown.stderr);
  const ticket = JSON.parse(shown.stdout) as {
    type: string;
    status: string;
    title: string;
    body: string;
    closedCommit?: string;
  };
  assert.equal(ticket.type, "epic");
  assert.equal(ticket.status, "done");
  assert.equal(ticket.title, "renamed in db mode");
  assert.equal(ticket.body.trim(), "v2");
  assert.equal(ticket.closedCommit, "abc1234");

  const listed = forge(project, ["backlog", "list", "--status", "done", "--json"]);
  assert.equal(listed.status, 0, listed.stderr);
  assert.ok(
    (JSON.parse(listed.stdout) as { id: string; status: string }[]).some(
      (listedTicket) => listedTicket.id === id && listedTicket.status === "done",
    ),
    "list reflects the close written to the DB store",
  );
});

// Slice A added the tables; Slice B only writes to them. A schema that moved
// under a CRUD cycle would mean the seam is evolving the store at runtime, and a
// user_version bump would falsely tell an older binary it cannot read this store.
test("integ FG-607: db-mode CRUD is additive-only — no new objects, no user_version bump", () => {
  const project = join(root, "schema");
  initRepo(project);
  writeMarkdownTicket(project, "FG-1", "a ticket");
  importAndFlip(project);

  const snapshot = () => {
    const db = new Database(join(root, "home", "forge.db"), { readonly: true });
    try {
      const objects = (
        db
          .prepare(`SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`)
          .all() as { type: string; name: string }[]
      ).map((o) => `${o.type}:${o.name}`);
      return { objects, userVersion: db.pragma("user_version", { simple: true }) as number };
    } finally {
      db.close();
    }
  };

  const before = snapshot();
  assert.ok(before.objects.includes("table:tickets"), "Slice A's tables must already exist");
  assert.equal(before.userVersion, 0, "the store starts below the destructive boundary");

  const filed = forge(project, ["backlog", "file", "schema probe", "--body", "v1"]);
  assert.equal(filed.status, 0, filed.stderr);
  const id = filed.stdout.match(/Created (\S+):/)![1]!;
  for (const args of [
    ["backlog", "edit", id, "--body", "v2"],
    ["backlog", "retitle", id, "renamed"],
    ["backlog", "move", id, "idea"],
    ["backlog", "close", id],
    ["backlog", "list"],
  ]) {
    const res = forge(project, args);
    assert.equal(res.status, 0, `\`${args.join(" ")}\` failed: ${res.stderr}`);
  }

  const after = snapshot();
  assert.deepEqual(after.objects, before.objects, "db-mode CRUD created or dropped a schema object");
  assert.equal(after.userVersion, 0, "db-mode CRUD bumped user_version");
});
