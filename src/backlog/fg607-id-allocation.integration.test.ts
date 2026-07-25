// FG-607 (FG-496 Slice B): concurrent `forge backlog file` in db mode must
// allocate DISTINCT ids — no collision, no reuse.
//
// Why REAL child processes against a REAL on-disk DB: the in-memory harness
// cannot express this. src/store/db.ts documents that on a single-connection
// :memory: DB SQLite degenerates BEGIN IMMEDIATE to BEGIN, so the contention this
// AC is about does not exist there — and better-sqlite3 serializes transactions
// on one connection anyway. Two forge invocations (the real shape: two linked
// worktrees filing at once) are two connections to one file, which is exactly
// what the sequence bump inside the write transaction has to survive.
//
// Modeled on src/store/fg548-immediate-write-txn.integration.test.ts.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getDb } from "../store/db.js";
import { getIdSequence, ticketsForProject } from "../store/tickets.js";

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, "..", "cli", "index.ts");
const localTsx = resolve(here, "..", "..", "node_modules", ".bin", "tsx");
const tsx = existsSync(localTsx) ? localTsx : "tsx";

const CONCURRENT_FILES = Number(process.env["FG607_FILES"] ?? 6);

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "fg607-alloc-"));
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

function writeTicketFile(projectDir: string, id: string, status = "active"): void {
  const dir = join(projectDir, "backlog", "stories");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${id}-slug.md`),
    `---\nid: ${id}\ntype: story\nstatus: ${status}\ntitle: ${id} title\n---\n\nbody\n`,
  );
}

function forge(projectDir: string, args: string[]) {
  return spawnSync(tsx, [entry, ...args, "--project", projectDir], {
    cwd: projectDir,
    input: "",
    encoding: "utf8",
  });
}

function forgeAsync(projectDir: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((res) => {
    const child = spawn(tsx, [entry, ...args, "--project", projectDir], { cwd: projectDir });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += String(c)));
    child.stderr.on("data", (c) => (stderr += String(c)));
    child.stdin.end();
    child.on("close", (code) => res({ code: code ?? -1, stdout, stderr }));
  });
}

// One import (seeds the sequence past the Markdown high-water mark) + one flip to
// db mode. Returns the project_key.
function importAndFlip(projectDir: string): string {
  const imported = forge(projectDir, ["backlog", "import", "--json"]);
  assert.equal(imported.status, 0, `import failed: ${imported.stderr}`);
  const key = (JSON.parse(imported.stdout) as { projectKey: string }).projectKey;

  const flipped = forge(projectDir, ["backlog", "mode", "--set", "db", "--json"]);
  assert.equal(flipped.status, 0, `mode --set db failed: ${flipped.stderr}`);
  assert.equal((JSON.parse(flipped.stdout) as { mode: string }).mode, "db");
  return key;
}

test(`integ FG-607: ${CONCURRENT_FILES} concurrent \`backlog file\` calls allocate distinct, non-reused ids`, async () => {
  const project = join(root, "proj");
  initRepo(project);
  // A Markdown history the sequence must start PAST — id reuse would collide with
  // FG-4 (and with the ids Slice C will compare against).
  writeTicketFile(project, "FG-4");
  const key = importAndFlip(project);

  getDb();
  assert.equal(getIdSequence(key, "FG"), 5, "import seeds next_seq at the Markdown max + 1");

  const results = await Promise.all(
    Array.from({ length: CONCURRENT_FILES }, (_, i) =>
      forgeAsync(project, ["backlog", "file", `concurrent ${i}`, "--body", `body ${i}`]),
    ),
  );

  for (const r of results) {
    assert.equal(r.code, 0, `a concurrent file failed: ${r.stderr}`);
  }
  const ids = results.map((r) => {
    const m = r.stdout.match(/Created (\S+):/);
    assert.ok(m, `could not parse an id from: ${r.stdout}`);
    return m![1]!;
  });

  // The property: N files -> N DISTINCT ids, all above the Markdown high-water
  // mark, contiguous (nothing skipped, nothing reused).
  assert.equal(new Set(ids).size, CONCURRENT_FILES, `ids collided: ${ids.join(", ")}`);
  const nums = ids.map((id) => parseInt(id.slice(3), 10)).sort((a, b) => a - b);
  assert.deepEqual(
    nums,
    Array.from({ length: CONCURRENT_FILES }, (_, i) => 5 + i),
    `expected a contiguous run starting at FG-5; got ${ids.join(", ")}`,
  );

  assert.equal(getIdSequence(key, "FG"), 5 + CONCURRENT_FILES, "the sequence advanced exactly once per file");
  // The Markdown ticket was imported too, so the DB holds it plus every new file.
  assert.equal(ticketsForProject(key).length, CONCURRENT_FILES + 1);
  // Filing in db mode writes no files — the working tree stays clean apart from
  // the pre-existing untracked Markdown fixture.
  const porcelain = spawnSync("git", ["status", "--porcelain"], { cwd: project, encoding: "utf8" }).stdout;
  assert.equal(
    porcelain.split("\n").filter((l) => l.trim() && !l.includes("backlog/") && !l.includes(".forge/")).length,
    0,
    `unexpected working-tree changes:\n${porcelain}`,
  );
});

// AC: db mode without a prior import would mint ids duplicating the project's
// entire Markdown history, because the DB's collision check cannot see ids that
// exist only in backlog/*.md. The flip REFUSES and names the fix.
test("integ FG-607: `backlog mode --set db` refuses on an unseeded id sequence and names the import", () => {
  const project = join(root, "unseeded");
  initRepo(project);
  writeTicketFile(project, "FG-11");

  const res = forge(project, ["backlog", "mode", "--set", "db"]);
  assert.equal(res.status, 1, `expected a non-zero refusal; stdout: ${res.stdout} stderr: ${res.stderr}`);
  assert.match(res.stderr, /refusing to set db mode/);
  assert.match(res.stderr, /forge backlog import/);

  // The refusal leaves NOTHING behind: mode is untouched and the git-tracked
  // config was never healed.
  const shown = forge(project, ["backlog", "mode", "--json"]);
  assert.equal(shown.status, 0, shown.stderr);
  assert.equal((JSON.parse(shown.stdout) as { mode: string }).mode, "markdown");
  assert.equal(existsSync(join(project, ".forge", "config.yml")), false, "no config heal on a refused flip");

  // And the fix works: import, then flip.
  const key = importAndFlip(project);
  getDb();
  assert.equal(getIdSequence(key, "FG"), 12, "allocation continues past the Markdown history");
});

// A brand-new project with nothing in EITHER store still goes through import:
// import on an empty project is the BOOTSTRAP that seeds the sequence at 1. The
// flip itself never seeds — it cannot prove a project is empty from one
// checkout's filesystem (project_key spans clones and linked worktrees).
test("integ FG-607: an empty project bootstraps through import, then adopts db mode and files from FG-1", () => {
  const project = join(root, "empty");
  initRepo(project);

  // Without the import the flip refuses, exactly as it does with Markdown history.
  const premature = forge(project, ["backlog", "mode", "--set", "db"]);
  assert.equal(premature.status, 1, `expected a refusal before import; stdout: ${premature.stdout}`);
  assert.match(premature.stderr, /forge backlog import/);

  const imported = forge(project, ["backlog", "import", "--json"]);
  assert.equal(imported.status, 0, `import of a backlog-less project failed: ${imported.stderr}`);
  const key = (JSON.parse(imported.stdout) as { projectKey: string; ticketCount: number });
  assert.equal(key.ticketCount, 0);
  getDb();
  assert.equal(getIdSequence(key.projectKey, "FG"), 1, "import bootstraps the sequence at 1");

  const flipped = forge(project, ["backlog", "mode", "--set", "db", "--json"]);
  assert.equal(flipped.status, 0, `mode --set db failed: ${flipped.stderr}`);
  assert.equal((JSON.parse(flipped.stdout) as { mode: string }).mode, "db");

  const filed = forge(project, ["backlog", "file", "the first ticket"]);
  assert.equal(filed.status, 0, filed.stderr);
  assert.match(filed.stdout, /Created FG-1:/);
  assert.equal(existsSync(join(project, "backlog")), false, "db mode never creates backlog/");
});
