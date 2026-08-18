// FG-607 (FG-496 Slice B) AC: "every existing structured.ts caller compiles and
// passes unchanged".
//
// The other FG-607 integration files drive `forge backlog`, which is the seam's
// own CLI. That is not enough to prove the AC: the point of putting dual-mode
// behind UNCHANGED signatures is that the ~17 OTHER modules importing
// readTicket / listTickets migrate for free. This file exercises two of them
// through their real commands, against a db-mode project with NO backlog/
// directory at all — the configuration where a consumer that still reached for
// the filesystem would fail loudly.
//
//   forge readiness <id>     -> readTicket   (src/cli/commands/readiness.ts)
//   forge campaign plan      -> listTickets  (src/campaign/planner.ts, via expandEpic)
//
// Markdown-mode controls run the same commands on a never-imported project, so a
// regression in the default path shows up here as well.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { authorityTestkitEnv, withAuthorityTestkit } from "./container-authority.testkit-spawn.js";

const here = dirname(fileURLToPath(import.meta.url));
import { NODE_EXEC as tsx, BUILT_CLI_ENTRY as entry } from "../integration-cli-spawn.js";

const READY_BODY =
  "## Problem\nSomething is broken.\n\n## Goal\nFix it.\n\n## Acceptance Criteria\n- The fix is covered by a test.\n";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "fg607-consumers-"));
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
  return spawnSync(tsx, withAuthorityTestkit(entry, args), {
    cwd: projectDir,
    input: "",
    encoding: "utf8",
    env: { ...process.env, ...authorityTestkitEnv() },
  });
}

type MarkdownTicket = {
  id: string;
  type?: "idea" | "epic" | "story";
  status?: string;
  title: string;
  epic?: string;
  body?: string;
};

function writeMarkdownTicket(projectDir: string, t: MarkdownTicket): void {
  const type = t.type ?? "story";
  const subdir = type === "idea" ? "ideas" : type === "epic" ? "epics" : "stories";
  const dir = join(projectDir, "backlog", subdir);
  mkdirSync(dir, { recursive: true });
  const fm = [
    `id: ${t.id}`,
    `type: ${type}`,
    `status: ${t.status ?? "active"}`,
    `title: ${t.title}`,
    ...(t.epic ? [`epic: ${t.epic}`] : []),
  ].join("\n");
  writeFileSync(join(dir, `${t.id}-slug.md`), `---\n${fm}\n---\n\n${t.body ?? READY_BODY}`);
}

function importAndFlip(projectDir: string): string {
  const imported = forge(projectDir, ["backlog", "import", "--json", "--project", projectDir]);
  assert.equal(imported.status, 0, `import failed: ${imported.stderr}`);
  const key = (JSON.parse(imported.stdout) as { projectKey: string }).projectKey;

  const flipped = forge(projectDir, ["backlog", "mode", "--set", "db", "--json", "--project", projectDir]);
  assert.equal(flipped.status, 0, `mode --set db failed: ${flipped.stderr}`);
  assert.equal((JSON.parse(flipped.stdout) as { mode: string }).mode, "db");
  return key;
}

type ReadinessJson = {
  ticketId: string;
  outcome: string;
  gaps: string[];
  refinementProposal: string | null;
};

function readiness(projectDir: string, id: string) {
  return forge(projectDir, ["readiness", id, "--json", "--project", projectDir]);
}

// The headline consumer check: a command that has never heard of storage modes
// reads a db-mode ticket out of a checkout with no backlog/ directory.
test("integ FG-607: `forge readiness` reads db-mode tickets from a project with no backlog/ directory", () => {
  const project = join(root, "readiness-db");
  initRepo(project);
  writeMarkdownTicket(project, { id: "FG-1", title: "seed so the sequence starts past it" });
  importAndFlip(project);

  // Post-cutover shape: the Markdown is gone entirely, the DB is the only store.
  rmSync(join(project, "backlog"), { recursive: true, force: true });
  assert.equal(existsSync(join(project, "backlog")), false);

  const filed = forge(project, ["backlog", "file", "db-only ticket", "--body", READY_BODY, "--project", project]);
  assert.equal(filed.status, 0, filed.stderr);
  const id = filed.stdout.match(/Created (\S+):/)![1]!;

  const res = readiness(project, id);
  assert.equal(res.status, 0, `readiness failed against a db-mode ticket: ${res.stderr}`);
  const parsed = JSON.parse(res.stdout) as ReadinessJson;
  assert.equal(parsed.ticketId, id);
  assert.equal(parsed.outcome, "ready");
  assert.deepEqual(parsed.gaps, []);
});

// `blocked` is not a stored status — it is `active` plus a blocker_evidence row,
// reconstructed at the seam. A consumer that branches on status is therefore the
// sharpest test of that reconstruction: if it leaked through as `active`,
// readiness would call a blocked ticket ready.
test("integ FG-607: a consumer branching on status sees `blocked` reconstructed from blocker evidence", () => {
  const project = join(root, "readiness-blocked");
  initRepo(project);
  writeMarkdownTicket(project, { id: "FG-1", title: "blocked story", status: "blocked" });
  importAndFlip(project);
  rmSync(join(project, "backlog"), { recursive: true, force: true });

  const res = readiness(project, "FG-1");
  assert.equal(res.status, 0, res.stderr);
  const parsed = JSON.parse(res.stdout) as ReadinessJson;
  assert.equal(
    parsed.outcome,
    "blocked",
    "the blocked FACT survived import into evidence but did not come back out of the seam",
  );
  assert.deepEqual(parsed.gaps, ["Ticket is marked blocked"]);
});

// The mode is authoritative for consumers too — not just for `forge backlog`.
test("integ FG-607: a consumer gets no Markdown fallback in db mode", () => {
  const project = join(root, "readiness-nofallback");
  initRepo(project);
  writeMarkdownTicket(project, { id: "FG-1", title: "imported" });
  importAndFlip(project);

  // Plant a ticket that exists ONLY on disk, after the import. In db mode it is
  // not a ticket, and a consumer must not be the thing that resurrects it.
  writeMarkdownTicket(project, { id: "FG-99", title: "markdown-only ghost" });

  const res = readiness(project, "FG-99");
  assert.notEqual(res.status, 0, `expected a not-found failure; stdout: ${res.stdout}`);
  assert.match(res.stderr, /Ticket FG-99 not found/);
});

// listTickets through a second consumer, again with no backlog/ directory. Epic
// expansion reads type, status and epic off every ticket, so this covers the
// column mapping the seam does on the way out as well as the store dispatch.
test("integ FG-607: `forge campaign plan --epic` expands a db-mode epic with no backlog/ directory", () => {
  const project = join(root, "campaign-db");
  initRepo(project);
  writeMarkdownTicket(project, { id: "FG-1", type: "epic", title: "the epic" });
  writeMarkdownTicket(project, { id: "FG-2", title: "first child", epic: "FG-1" });
  writeMarkdownTicket(project, { id: "FG-3", title: "second child", epic: "FG-1" });
  writeMarkdownTicket(project, { id: "FG-4", title: "closed child", status: "done", epic: "FG-1" });
  writeMarkdownTicket(project, { id: "FG-5", title: "unrelated story" });
  importAndFlip(project);
  rmSync(join(project, "backlog"), { recursive: true, force: true });

  const res = forge(project, [
    "campaign", "plan",
    "--epic", "FG-1",
    "--project", project,
    "--mode", "dry_run",
    "--default-lane", "ticketing_only",
    "--default-lane-rationale", "FG-607 consumer coverage; the lane is not what is under test",
    "--json",
  ]);
  assert.equal(res.status, 0, `campaign plan failed against a db-mode project: ${res.stderr}`);

  const plan = JSON.parse(res.stdout) as { orderedItems: { ticketId: string }[] };
  assert.deepEqual(
    plan.orderedItems.map((i) => i.ticketId),
    ["FG-2", "FG-3"],
    "epic expansion must see the db-mode children — and only the ACTIVE ones",
  );
});

// The default path is the one live projects are on. Same commands, a project that
// has never been imported: nothing about the dual-mode dispatch may change it.
test("integ FG-607: the same consumers behave identically on a never-imported markdown project", () => {
  const project = join(root, "markdown-control");
  initRepo(project);
  writeMarkdownTicket(project, { id: "FG-1", type: "epic", title: "the epic" });
  writeMarkdownTicket(project, { id: "FG-2", title: "first child", epic: "FG-1" });
  writeMarkdownTicket(project, { id: "FG-3", title: "second child", epic: "FG-1" });
  writeMarkdownTicket(project, { id: "FG-9", title: "blocked story", status: "blocked" });

  const ready = readiness(project, "FG-2");
  assert.equal(ready.status, 0, ready.stderr);
  assert.equal((JSON.parse(ready.stdout) as ReadinessJson).outcome, "ready");

  const blocked = readiness(project, "FG-9");
  assert.equal(blocked.status, 0, blocked.stderr);
  assert.equal((JSON.parse(blocked.stdout) as ReadinessJson).outcome, "blocked");

  const missing = readiness(project, "FG-404");
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /Ticket FG-404 not found/);

  const plan = forge(project, [
    "campaign", "plan",
    "--epic", "FG-1",
    "--project", project,
    "--mode", "dry_run",
    "--default-lane", "ticketing_only",
    "--default-lane-rationale", "FG-607 consumer coverage; the lane is not what is under test",
    "--json",
  ]);
  assert.equal(plan.status, 0, plan.stderr);
  assert.deepEqual(
    (JSON.parse(plan.stdout) as { orderedItems: { ticketId: string }[] }).orderedItems.map((i) => i.ticketId),
    ["FG-2", "FG-3"],
    "markdown-mode epic expansion is unchanged",
  );

  // Nothing here minted an identity or healed config — the markdown path stays
  // read-only over the project directory.
  assert.equal(existsSync(join(project, ".forge", "config.yml")), false);
});
