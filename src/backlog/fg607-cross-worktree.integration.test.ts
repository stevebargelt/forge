// FG-607 (FG-496 Slice B) — the FG-495 headline shape, end to end through REAL
// git worktrees, the REAL `forge backlog` CLI, and the REAL shared on-disk store.
//
// Create a ticket in db mode in one worktree, then read it from a CLEAN secondary
// linked worktree that has NO Markdown file for it and NO project_key in its own
// .forge/config.yml. Forge must still find it, via the converging repository
// evidence in the registry — and neither working tree may be dirtied by the read,
// because the storage-mode resolver is a pure reader (it never heals config and
// never claims an identity).
//
// The secondary worktree is deliberately branched from the commit BEFORE the
// project_key was committed, which is the realistic split: .forge/config.yml is
// git-tracked and per-branch, so a sibling worktree legitimately has no key. If
// resolution short-circuited to 'markdown' on a missing key, the two worktrees
// would disagree about which store is authoritative — the split truth FG-496
// exists to kill.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getDb } from "../store/db.js";
import { getTicket } from "../store/tickets.js";
import { readBacklogConfig } from "./config.js";
import { authorityTestkitEnv, withAuthorityTestkit } from "./container-authority.testkit-spawn.js";

const here = dirname(fileURLToPath(import.meta.url));
import { NODE_EXEC as tsx, BUILT_CLI_ENTRY as entry } from "../integration-cli-spawn.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "fg607-wt-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(res.status, 0, `git ${args.join(" ")} failed: ${res.stderr}`);
  return res.stdout;
}

function forge(projectDir: string, args: string[]) {
  return spawnSync(tsx, withAuthorityTestkit(entry, [...args, "--project", projectDir]), {
    cwd: projectDir,
    input: "",
    encoding: "utf8",
    env: { ...process.env, ...authorityTestkitEnv() },
  });
}

function porcelain(dir: string): string {
  return git(dir, ["status", "--porcelain"]).trim();
}

// No remote — identity then resolves via the shared git-common-dir, which is
// exactly the evidence that groups linked worktrees.
function initRepo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  writeFileSync(join(dir, "README.md"), "seed\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "init"]);
  return git(dir, ["rev-parse", "HEAD"]).trim();
}

test("integ FG-607/FG-495: a db-mode ticket is readable from a clean secondary worktree with no Markdown and no committed key", () => {
  const main = join(root, "main");
  const wtB = join(root, "wtB");
  const baseSha = initRepo(main);

  // 1. Claim an identity and adopt db mode in the primary worktree. The project
  //    has NO backlog/ directory at all — db mode does not need one.
  const imported = forge(main, ["backlog", "import", "--json"]);
  assert.equal(imported.status, 0, `import failed: ${imported.stderr}`);
  const projectKey = (JSON.parse(imported.stdout) as { projectKey: string }).projectKey;

  const flipped = forge(main, ["backlog", "mode", "--set", "db", "--json"]);
  assert.equal(flipped.status, 0, `mode --set db failed: ${flipped.stderr}`);

  // 2. Commit the healed config — project_key is a durable COMMITTED field. This
  //    is also what makes main's working tree clean again.
  git(main, ["add", "-A"]);
  git(main, ["commit", "-qm", "record project_key"]);

  // 3. The secondary worktree branches from BEFORE that commit, so it genuinely
  //    has no .forge/config.yml and no project_key of its own.
  git(main, ["worktree", "add", "-q", "-b", "sibling", wtB, baseSha]);
  assert.equal(existsSync(join(wtB, ".forge", "config.yml")), false, "the sibling has no committed key");
  assert.equal(readBacklogConfig(wtB).projectKey, null);

  // 4. File a ticket in db mode from the primary worktree.
  const filed = forge(main, ["backlog", "file", "cross-worktree ticket", "--body", "the body"]);
  assert.equal(filed.status, 0, filed.stderr);
  const id = filed.stdout.match(/Created (\S+):/)![1]!;
  assert.equal(existsSync(join(main, "backlog")), false, "db mode wrote no Markdown");

  // 5. THE POINT: read it from the clean secondary worktree. No Markdown file
  //    exists there (none exists anywhere), and its config carries no key.
  const shown = forge(wtB, ["backlog", "show", id, "--json"]);
  assert.equal(shown.status, 0, `sibling worktree could not read the ticket: ${shown.stderr}`);
  const ticket = JSON.parse(shown.stdout) as { id: string; title: string; body: string; status: string };
  assert.equal(ticket.id, id);
  assert.equal(ticket.title, "cross-worktree ticket");
  assert.equal(ticket.body.trim(), "the body");
  assert.equal(ticket.status, "active");

  // Both worktrees resolve the SAME project_key and the SAME mode — the mode
  // lives in the DB under project_key, not in either worktree's files.
  const modeB = JSON.parse(forge(wtB, ["backlog", "mode", "--json"]).stdout) as {
    mode: string;
    projectKey: string;
  };
  assert.equal(modeB.mode, "db", "the sibling resolves db mode without any local config");
  assert.equal(modeB.projectKey, projectKey, "both worktrees resolve to ONE project_key");

  // The CLI says which store it read, on stderr, every invocation.
  assert.match(shown.stderr, new RegExp(`store: db \\(project_key=${projectKey}\\)`));

  // 6. git status is CLEAN in both worktrees. A read that healed config (or a
  //    write that touched backlog/) would show up right here.
  assert.equal(porcelain(main), "", `main worktree dirtied:\n${porcelain(main)}`);
  assert.equal(porcelain(wtB), "", `sibling worktree dirtied:\n${porcelain(wtB)}`);

  // Exactly one row, under one key.
  getDb();
  assert.equal(getTicket(projectKey, id)!.title, "cross-worktree ticket");
});

// FG-607 AC 2, the case a local-only short-circuit gets WRONG: the sibling
// worktree has BOTH no committed key AND a stale local backlog/ directory (it is
// branched from before the migration, and backlog/ is git-tracked). Answering
// 'markdown' because a backlog/ directory happens to be present would make two
// linked worktrees of ONE project disagree about which store is authoritative,
// and would serve stale Markdown as if it were the truth. The registry — which
// converges linked worktrees via git-common-dir — is the only authority.
test("integ FG-607 AC2: a sibling worktree with a STALE local backlog/ and no key still resolves db", () => {
  const main = join(root, "main");
  const wtB = join(root, "wtB");
  const baseSha = initRepo(main);

  const projectKey = (
    JSON.parse(forge(main, ["backlog", "import", "--json"]).stdout) as { projectKey: string }
  ).projectKey;
  assert.equal(forge(main, ["backlog", "mode", "--set", "db", "--json"]).status, 0);
  git(main, ["add", "-A"]);
  git(main, ["commit", "-qm", "record project_key"]);

  const filed = forge(main, ["backlog", "file", "the authoritative ticket", "--body", "from the db"]);
  assert.equal(filed.status, 0, filed.stderr);
  const id = filed.stdout.match(/Created (\S+):/)![1]!;

  git(main, ["worktree", "add", "-q", "-b", "sibling", wtB, baseSha]);
  assert.equal(readBacklogConfig(wtB).projectKey, null, "the sibling has no committed key");

  // The stale Markdown the sibling's branch still carries.
  mkdirSync(join(wtB, "backlog", "stories"), { recursive: true });
  writeFileSync(
    join(wtB, "backlog", "stories", "FG-STALE-slug.md"),
    `---\nid: FG-STALE\ntype: story\nstatus: active\ntitle: stale markdown ticket\n---\n\nold body\n`,
  );

  const modeB = JSON.parse(forge(wtB, ["backlog", "mode", "--json"]).stdout) as {
    mode: string;
    projectKey: string;
  };
  assert.equal(modeB.mode, "db", "a local backlog/ must not override the registry's answer");
  assert.equal(modeB.projectKey, projectKey, "both worktrees resolve to ONE project_key");

  // And it reads the DB, not the stale Markdown sitting right next to it.
  const listed = forge(wtB, ["backlog", "list", "--json"]);
  assert.equal(listed.status, 0, listed.stderr);
  assert.deepEqual((JSON.parse(listed.stdout) as { id: string }[]).map((t) => t.id), [id]);
});

test("integ FG-607: full CRUD from the sibling worktree stays in the DB and leaves both trees clean", () => {
  const main = join(root, "main");
  const wtB = join(root, "wtB");
  const baseSha = initRepo(main);

  const projectKey = (
    JSON.parse(forge(main, ["backlog", "import", "--json"]).stdout) as { projectKey: string }
  ).projectKey;
  assert.equal(forge(main, ["backlog", "mode", "--set", "db", "--json"]).status, 0);
  git(main, ["add", "-A"]);
  git(main, ["commit", "-qm", "record project_key"]);
  git(main, ["worktree", "add", "-q", "-b", "sibling", wtB, baseSha]);

  // file / edit / close, driven entirely from the worktree that has no key.
  const filed = forge(wtB, ["backlog", "file", "sibling-filed", "--body", "v1"]);
  assert.equal(filed.status, 0, filed.stderr);
  const id = filed.stdout.match(/Created (\S+):/)![1]!;

  assert.equal(forge(wtB, ["backlog", "edit", id, "--body", "v2"]).status, 0);
  assert.equal(forge(wtB, ["backlog", "close", id, "--commit", "abc1234"]).status, 0);

  // Visible from the OTHER worktree immediately — one store, not two.
  const listed = forge(main, ["backlog", "list", "--status", "done", "--json"]);
  assert.equal(listed.status, 0, listed.stderr);
  const rows = JSON.parse(listed.stdout) as Array<{ id: string; status: string }>;
  assert.deepEqual(rows.map((r) => r.id), [id]);

  getDb();
  const row = getTicket(projectKey, id)!;
  assert.equal(row.body, "v2");
  assert.equal(row.status, "done");
  assert.equal(row.closedCommit, "abc1234");

  assert.equal(existsSync(join(wtB, "backlog")), false, "no Markdown was written in db mode");
  assert.equal(porcelain(main), "", `main worktree dirtied:\n${porcelain(main)}`);
  assert.equal(porcelain(wtB), "", `sibling worktree dirtied:\n${porcelain(wtB)}`);
});
