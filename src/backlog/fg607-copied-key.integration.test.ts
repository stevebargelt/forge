// FG-607 (FG-496 Slice B) — the trust boundary on the seam's READ path.
//
// .forge/config.yml is git-tracked and freely copyable. A project carrying ANOTHER
// project's project_key must not be able to read — let alone WRITE — that
// project's tickets. The registry (the durable arbiter of which repository owns a
// key) is consulted before a committed key is trusted, and a mismatch REFUSES:
// no fall-through to another rung, no silent downgrade to markdown, no writes.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getDb } from "../store/db.js";
import { getIdSequence, ticketsForProject } from "../store/tickets.js";
import { authorityTestkitEnv, withAuthorityTestkit } from "./container-authority.testkit-spawn.js";

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, "..", "cli", "index.ts");
const localTsx = resolve(here, "..", "..", "node_modules", ".bin", "tsx");
const tsx = existsSync(localTsx) ? localTsx : "tsx";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "fg607-copied-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): void {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(res.status, 0, `git ${args.join(" ")} failed: ${res.stderr}`);
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

test("integ FG-607: a repository carrying ANOTHER project's project_key is refused, and writes nothing", () => {
  // Project A: a real db-mode project with one ticket.
  const projA = join(root, "A");
  initRepo(projA);
  const imported = forge(projA, ["backlog", "import", "--json"]);
  assert.equal(imported.status, 0, `import failed: ${imported.stderr}`);
  const keyA = (JSON.parse(imported.stdout) as { projectKey: string }).projectKey;
  assert.equal(forge(projA, ["backlog", "mode", "--set", "db", "--json"]).status, 0);
  assert.equal(forge(projA, ["backlog", "file", "A's own ticket"]).status, 0);

  getDb();
  const ticketsBefore = ticketsForProject(keyA).map((t) => t.ticketId);
  const seqBefore = getIdSequence(keyA, "FG");
  assert.equal(ticketsBefore.length, 1);

  // Project B: an unrelated repository that copied A's config (key and all).
  const projB = join(root, "B");
  initRepo(projB);
  mkdirSync(join(projB, ".forge"), { recursive: true });
  copyFileSync(join(projA, ".forge", "config.yml"), join(projB, ".forge", "config.yml"));
  const configB = readFileSync(join(projB, ".forge", "config.yml"), "utf8");
  assert.ok(configB.includes(keyA), "the copied config really carries A's key");

  // READ refuses, naming both the key and the owning repository.
  const listed = forge(projB, ["backlog", "list"]);
  assert.equal(listed.status, 1, `expected a refusal; stdout: ${listed.stdout} stderr: ${listed.stderr}`);
  assert.match(listed.stderr, new RegExp(keyA));
  assert.match(listed.stderr, /DIFFERENT repository/);
  assert.ok(!listed.stdout.includes("A's own ticket"), "B must not see A's tickets");

  // WRITE refuses too — and leaves A's store byte-identical.
  const filed = forge(projB, ["backlog", "file", "B stealing an id"]);
  assert.equal(filed.status, 1, `expected a refusal; stdout: ${filed.stdout} stderr: ${filed.stderr}`);
  assert.match(filed.stderr, /DIFFERENT repository/);

  getDb();
  assert.deepEqual(ticketsForProject(keyA).map((t) => t.ticketId), ticketsBefore, "no ticket written under A's key");
  assert.equal(getIdSequence(keyA, "FG"), seqBefore, "no id consumed from A's sequence");
  assert.equal(existsSync(join(projB, "backlog")), false, "the refusal wrote no Markdown either");
  assert.equal(readFileSync(join(projB, ".forge", "config.yml"), "utf8"), configB, "B's config untouched");
});
