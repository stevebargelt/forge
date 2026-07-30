// FG-608 (FG-496 Slice C) — the OPERATOR'S cutover flow, end to end, and the
// cross-worktree acceptance case reached through the REAL cutover verb.
//
// Why this file exists alongside fg608-migrate-atomic and fg607-cross-worktree:
//
//   - fg608-migrate-atomic proves migrate's TRANSACTION properties (flip / no
//     flip / dry-run writes nothing), but it verifies them by reading the store
//     in-process — it never runs `forge backlog list` or `forge backlog show`
//     afterwards. So "the mode row moved" is proven; "the operator's next command
//     now answers from the DB" is not.
//   - fg607-cross-worktree proves cross-worktree consistency, but it reaches db
//     mode via `backlog mode --set db`, which is the Slice B verb. The FG-608
//     acceptance bullet is "cross-worktree consistency test passes with a
//     project's mode = db" AFTER this slice's cutover, and migrate does strictly
//     more than mode --set (it imports and validates first). Nobody re-runs the
//     consistency case against a migrate-produced project.
//   - fg608-removal-reconciliation proves the multi-source prune rule, but its
//     own header states it INJECTS sourceId "to model two worktrees of one
//     project without materializing two real git checkouts". The durable source
//     identity is minted per checkout in the git ADMIN dir, and a linked worktree
//     is precisely the case where that admin dir is shared-but-distinct — which
//     an injected id cannot exercise at all.
//
// Everything here therefore runs the REAL `forge` CLI as a child process against
// REAL git checkouts (`git worktree add`, not two copies of a directory) and a
// real on-disk store. No injected identities, no in-process shortcuts.
//
// This file executes NO live cutover on the forge repo — every project it
// migrates is a throwaway temp checkout.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { authorityTestkitEnv, withAuthorityTestkit } from "./container-authority.testkit-spawn.js";

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, "..", "cli", "index.ts");
const localTsx = resolve(here, "..", "..", "node_modules", ".bin", "tsx");
const tsx = existsSync(localTsx) ? localTsx : "tsx";

let root: string;
let home: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "fg608-cutover-"));
  home = join(root, "home");
  mkdirSync(home, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

type ForgeResult = { status: number | null; stdout: string; stderr: string };

/** The real CLI, in a real child process, against this test's private store. */
function forge(projectDir: string, args: string[]): ForgeResult {
  const res = spawnSync(tsx, withAuthorityTestkit(entry, args), {
    cwd: projectDir,
    input: "",
    encoding: "utf8",
    env: { ...process.env, FORGE_HOME: home, FORGE_DB_PATH: join(home, "forge.db"), ...authorityTestkitEnv() },
  });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function forgeOk(projectDir: string, args: string[]): ForgeResult {
  const res = forge(projectDir, args);
  assert.equal(res.status, 0, `forge ${args.join(" ")} failed (${res.status}):\n${res.stdout}\n${res.stderr}`);
  return res;
}

function json<T>(res: ForgeResult): T {
  return JSON.parse(res.stdout) as T;
}

function git(cwd: string, args: string[]): string {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(res.status, 0, `git ${args.join(" ")} failed: ${res.stderr}`);
  return res.stdout;
}

function writeTicket(projectDir: string, id: string, fm: Record<string, string>, body: string): void {
  const dir = join(projectDir, "backlog", "stories");
  mkdirSync(dir, { recursive: true });
  const front = Object.entries({ id, ...fm }).map(([k, v]) => `${k}: ${v}`).join("\n");
  writeFileSync(join(dir, `${id}-slug.md`), `---\n${front}\n---\n\n${body}\n`);
}

function ticketPath(projectDir: string, id: string): string {
  return join(projectDir, "backlog", "stories", `${id}-slug.md`);
}

/** A real git checkout. No remote, so repository identity resolves on the
 *  git-common-dir rung — the evidence that groups LINKED WORKTREES together,
 *  which is exactly the grouping the multi-source rule depends on. */
function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  // test-setup.ts neutralizes GIT_CONFIG_GLOBAL, so identity must be explicit.
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
}

function commitAll(dir: string, message: string): void {
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", message]);
}

type MigrateJson = {
  dryRun: boolean;
  projectKey: string;
  modeBefore: string;
  modeAfter: string;
  markdownTicketCount: number;
  dbTicketCount: number;
  prunedTickets: string[];
};
type ListEntry = { id: string; type: string; status: string; title: string };
type ShowJson = { id: string; title: string; body: string; status: string };
type ImportJson = {
  projectKey: string;
  sourceId: string;
  ticketCount: number;
  prunedTickets: string[];
};

// ─── the operator's actual sequence ──────────────────────────────────────────

test("FG-608: the operator cutover sequence — dry-run, migrate, then list/show answer from the DB", () => {
  const projectDir = join(root, "proj");
  initRepo(projectDir);
  writeTicket(projectDir, "FG-1", { type: "story", status: "active", title: '"Alpha"' }, "alpha body");
  writeTicket(projectDir, "FG-2", { type: "story", status: "done", title: '"Bravo"' }, "bravo body");

  // BEFORE: Markdown is authoritative and says so on stderr. This is the
  // baseline the cutover has to move — asserting it here is what makes the
  // post-flip assertion evidence of a CHANGE rather than of a constant.
  const before = forgeOk(projectDir, ["backlog", "list", "--json"]);
  assert.match(before.stderr, /store: legacy markdown/, "pre-cutover reads are Markdown-sourced");
  assert.equal(json<ListEntry[]>(before).length, 2);

  // STEP 1 — the operator looks before they leap. --dry-run reports the plan and
  // must leave the project exactly as it found it.
  const dry = forgeOk(projectDir, ["backlog", "migrate", "--dry-run", "--json"]);
  const dryPlan = json<MigrateJson>(dry);
  assert.equal(dryPlan.dryRun, true);
  assert.equal(dryPlan.modeAfter, "markdown", "--dry-run does not flip");
  assert.equal(dryPlan.markdownTicketCount, 2, "the plan counts what would be imported");
  assert.equal(dryPlan.dbTicketCount, 0, "nothing has been imported yet");

  // The project is untouched: still Markdown-authoritative, still 2 tickets.
  const afterDry = forgeOk(projectDir, ["backlog", "list", "--json"]);
  assert.match(afterDry.stderr, /store: legacy markdown/, "--dry-run did not move authority");

  // STEP 2 — the real cutover.
  const migrated = forgeOk(projectDir, ["backlog", "migrate", "--json"]);
  const plan = json<MigrateJson>(migrated);
  assert.equal(plan.modeBefore, "markdown");
  assert.equal(plan.modeAfter, "db", "the flip happened");
  assert.equal(plan.dbTicketCount, 2, "the shadow equals the Markdown set at the flip");
  const projectKey = plan.projectKey;
  assert.match(projectKey, /^pk-/, "migrate minted and reported the project_key");

  // STEP 3 — THE POINT: the operator's next commands answer from the DB. This is
  // the half fg608-migrate-atomic does not reach, because it asserts through
  // getStorageMode() rather than through the CLI the operator actually types.
  const list = forgeOk(projectDir, ["backlog", "list", "--json"]);
  assert.match(
    list.stderr,
    new RegExp(`store: db \\(project_key=${projectKey}\\)`),
    "the store banner names the db store and the key",
  );
  const ids = json<ListEntry[]>(list).map((t) => t.id).sort();
  assert.deepEqual(ids, ["FG-1", "FG-2"], "both tickets survive the cutover");

  const shown = forgeOk(projectDir, ["backlog", "show", "FG-1", "--json"]);
  const ticket = json<ShowJson>(shown);
  assert.equal(ticket.id, "FG-1");
  assert.equal(ticket.title, "Alpha");
  assert.equal(ticket.body.trim(), "alpha body", "the body round-trips through the cutover");
  assert.equal(ticket.status, "active");

  // Status is carried across too — a done ticket does not come back active.
  const done = json<ShowJson>(forgeOk(projectDir, ["backlog", "show", "FG-2", "--json"]));
  assert.equal(done.status, "done");
});

// ─── the one-way freeze, observed rather than documented ─────────────────────

test("FG-608: after cutover backlog/*.md is a FROZEN snapshot — edits to it never reach a read", () => {
  const projectDir = join(root, "proj");
  initRepo(projectDir);
  writeTicket(projectDir, "FG-1", { type: "story", status: "active", title: '"Alpha"' }, "original body");
  forgeOk(projectDir, ["backlog", "migrate", "--json"]);

  // Edit the Markdown the way an operator with muscle memory would.
  const path = ticketPath(projectDir, "FG-1");
  writeFileSync(path, readFileSync(path, "utf8").replace("original body", "EDIT MADE IN FROZEN MARKDOWN"));

  const afterMarkdownEdit = json<ShowJson>(forgeOk(projectDir, ["backlog", "show", "FG-1", "--json"]));
  assert.equal(
    afterMarkdownEdit.body.trim(),
    "original body",
    "the frozen Markdown edit is invisible — the DB is authoritative",
  );

  // The inverse half: a DB edit IS visible, and does NOT write back to Markdown.
  // Both directions matter. Only asserting the first would also pass if reads
  // were broken outright.
  forgeOk(projectDir, ["backlog", "edit", "FG-1", "--body", "EDIT MADE IN THE DB"]);
  const afterDbEdit = json<ShowJson>(forgeOk(projectDir, ["backlog", "show", "FG-1", "--json"]));
  assert.equal(afterDbEdit.body.trim(), "EDIT MADE IN THE DB");
  assert.match(
    readFileSync(path, "utf8"),
    /EDIT MADE IN FROZEN MARKDOWN/,
    "no Markdown export: the db edit did not write back to the frozen file",
  );
});

// ─── acceptance: cross-worktree consistency with mode = db, via migrate ──────

test("FG-608 acceptance: a linked worktree sees the migrated project's tickets, not its own Markdown", () => {
  const main = join(root, "main");
  const sib = join(root, "sib");
  initRepo(main);
  writeTicket(main, "FG-1", { type: "story", status: "active", title: '"Alpha"' }, "alpha body");
  commitAll(main, "seed backlog");

  const projectKey = json<MigrateJson>(forgeOk(main, ["backlog", "migrate", "--json"])).projectKey;
  commitAll(main, "record project_key");

  // A REAL linked worktree — shared git common dir, separate working tree.
  git(main, ["worktree", "add", "-q", "-b", "sibling", sib]);
  assert.ok(existsSync(ticketPath(sib, "FG-1")), "the sibling checked out the frozen Markdown too");

  // Make the sibling's Markdown DISAGREE with the DB. If the sibling ever read
  // branch-local files, this is the value it would return, so the assertion
  // below can only pass by reading host-wide truth.
  const sibPath = ticketPath(sib, "FG-1");
  writeFileSync(sibPath, readFileSync(sibPath, "utf8").replace("alpha body", "STALE SIBLING MARKDOWN"));

  const sibList = forgeOk(sib, ["backlog", "list", "--json"]);
  assert.match(
    sibList.stderr,
    new RegExp(`store: db \\(project_key=${projectKey}\\)`),
    "the sibling resolves the SAME project_key and the same mode",
  );
  assert.deepEqual(json<ListEntry[]>(sibList).map((t) => t.id), ["FG-1"]);

  const sibShow = json<ShowJson>(forgeOk(sib, ["backlog", "show", "FG-1", "--json"]));
  assert.equal(sibShow.body.trim(), "alpha body", "the sibling read the DB, not its own divergent Markdown");

  // Consistency is bidirectional: a write from the sibling is authoritative for
  // the whole project, which is the property that makes one board out of many
  // checkouts.
  forgeOk(sib, ["backlog", "edit", "FG-1", "--body", "WRITTEN FROM THE SIBLING"]);
  const fromMain = json<ShowJson>(forgeOk(main, ["backlog", "show", "FG-1", "--json"]));
  assert.equal(fromMain.body.trim(), "WRITTEN FROM THE SIBLING", "main sees the sibling's edit");
});

// ─── acceptance: multi-worktree removal reconciliation, real worktrees ───────

test("FG-608 acceptance: a ticket is pruned only when absent from ALL real linked worktrees", () => {
  const main = join(root, "main");
  const sib = join(root, "sib");
  initRepo(main);
  writeTicket(main, "FG-1", { type: "story", status: "active", title: '"Keep"' }, "keep me");
  writeTicket(main, "FG-2", { type: "story", status: "active", title: '"Doomed"' }, "remove me");
  commitAll(main, "seed backlog");

  forgeOk(main, ["backlog", "migrate", "--json"]);
  commitAll(main, "record project_key");
  git(main, ["worktree", "add", "-q", "-b", "sibling", sib]);

  // Each checkout mints its OWN durable source id, in its own git admin dir.
  // This is the fact an injected sourceId assumes; here it is observed.
  const sibSource = json<ImportJson>(forgeOk(sib, ["backlog", "import", "--json"])).sourceId;
  const mainSource = json<ImportJson>(forgeOk(main, ["backlog", "import", "--json"])).sourceId;
  assert.notEqual(sibSource, mainSource, "linked worktrees are distinct sources, not one");

  // Remove FG-2 from the SIBLING only, and import from there. The sibling now
  // genuinely cannot see FG-2 — but main still holds it, so pruning would be
  // the destructive delete the acceptance criterion forbids.
  rmSync(ticketPath(sib, "FG-2"));
  const sibImport = json<ImportJson>(forgeOk(sib, ["backlog", "import", "--json"]));
  assert.equal(sibImport.sourceId, sibSource, "the source id is durable across imports, not re-minted");
  assert.deepEqual(sibImport.prunedTickets, [], "absent from ONE source is not absent from the project");
  assert.deepEqual(
    json<ListEntry[]>(forgeOk(sib, ["backlog", "list", "--json"])).map((t) => t.id).sort(),
    ["FG-1", "FG-2"],
    "FG-2 survives — the sibling lacking it is not evidence it was deleted",
  );

  // Now remove it from main too. It is absent from ALL live sources, so the
  // shadow must stop claiming it.
  rmSync(ticketPath(main, "FG-2"));
  const mainImport = json<ImportJson>(forgeOk(main, ["backlog", "import", "--json"]));
  assert.deepEqual(mainImport.prunedTickets, ["FG-2"], "absent from every source — now it prunes");
  assert.deepEqual(
    json<ListEntry[]>(forgeOk(main, ["backlog", "list", "--json"])).map((t) => t.id),
    ["FG-1"],
    "the shadow equals the current Markdown set INCLUDING the removal",
  );

  // The untouched ticket is never collateral damage.
  assert.equal(json<ShowJson>(forgeOk(sib, ["backlog", "show", "FG-1", "--json"])).body.trim(), "keep me");
});
