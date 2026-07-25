// FG-607 (FG-496 Slice B) AC 1 — the cost guarantee, in the form that survives
// AC 2. Two distinct claims, and the difference between them is the whole point:
//
//   1. On a host with NO store at all (its own empty FORGE_HOME), a markdown
//      project resolves for FREE — no forge.db created, no git spawned. That is
//      the genuinely free path, and it is what a fresh machine or a throwaway
//      directory actually hits.
//   2. On a host that HAS a store, a config-key-absent project pays the registry
//      lookup — because only the registry can tell "never imported" apart from
//      "imported, but this branch predates the project_key commit", and answering
//      markdown on a local backlog/ directory instead is exactly the split truth
//      AC 2 forbids. What is guaranteed there is that the cost does not SCALE:
//      resolution is memoized, so a `list` over N tickets pays it ONCE, not N
//      times (the git-subprocess-per-readTicket storm was the real concern).
//
// Everything is asserted OBSERVABLY, from outside the process: the child runs
// with its own FORGE_HOME and with a `git` shim first on PATH that records every
// invocation to a log file. No call counting, no internal seams.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, "..", "cli", "index.ts");
const localTsx = resolve(here, "..", "..", "node_modules", ".bin", "tsx");
const tsx = existsSync(localTsx) ? localTsx : "tsx";

let root: string;
let home: string;
let gitLog: string;
let shimDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "fg607-cost-"));
  home = join(root, "forge-home");
  mkdirSync(home, { recursive: true });
  gitLog = join(root, "git-invocations.log");
  shimDir = join(root, "bin");
  mkdirSync(shimDir, { recursive: true });
  // Records the invocation, then fails — a resolver that spawns git leaves a
  // trace even though every git call site swallows errors.
  writeFileSync(join(shimDir, "git"), `#!/bin/sh\necho "git $@" >> ${gitLog}\nexit 1\n`);
  chmodSync(join(shimDir, "git"), 0o755);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function forge(projectDir: string, args: string[], opts?: { realGit?: boolean }) {
  const path = opts?.realGit ? (process.env["PATH"] ?? "") : `${shimDir}:${process.env["PATH"] ?? ""}`;
  return spawnSync(tsx, [entry, ...args, "--project", projectDir], {
    cwd: projectDir,
    input: "",
    encoding: "utf8",
    env: { ...process.env, FORGE_HOME: home, PATH: path },
  });
}

function gitInvocations(): number {
  return existsSync(gitLog) ? readFileSync(gitLog, "utf8").trimEnd().split("\n").length : 0;
}

function assertNothingExpensiveHappened(): void {
  assert.equal(existsSync(join(home, "forge.db")), false, "the shared DB was opened (forge.db was created)");
  assert.equal(
    existsSync(gitLog),
    false,
    existsSync(gitLog) ? `git was spawned:\n${readFileSync(gitLog, "utf8")}` : "",
  );
}

function writeMarkdownTicket(projectDir: string, id: string, title: string): void {
  const dir = join(projectDir, "backlog", "stories");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${id}-slug.md`),
    `---\nid: ${id}\ntype: story\nstatus: active\ntitle: ${title}\n---\n\nbody\n`,
  );
}

test("integ FG-607 AC1: `backlog list` on a never-imported markdown project opens no DB and spawns no git", () => {
  const project = join(root, "md-only");
  mkdirSync(project, { recursive: true });
  writeMarkdownTicket(project, "FG-1", "only in markdown");

  const res = forge(project, ["backlog", "list", "--json"]);
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  assert.deepEqual((JSON.parse(res.stdout) as { id: string }[]).map((t) => t.id), ["FG-1"]);
  assert.match(res.stderr, /store: legacy markdown/);
  assertNothingExpensiveHappened();
});

test("integ FG-607 AC1: reading a ticket on a never-imported markdown project stays free", () => {
  const project = join(root, "md-show");
  mkdirSync(project, { recursive: true });
  writeMarkdownTicket(project, "FG-7", "shown from markdown");

  const res = forge(project, ["backlog", "show", "FG-7", "--json"]);
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  assert.equal((JSON.parse(res.stdout) as { title: string }).title, "shown from markdown");
  assertNothingExpensiveHappened();
});

// Claim 2. Once the host HAS a store, a key-less project pays the registry lookup
// — accepted, because answering markdown off a local backlog/ directory is the
// split truth AC 2 forbids. What must hold is that the cost is paid ONCE per
// process, not once per seam call: the architect's concern was a git subprocess
// per readTicket/listTickets inside the campaign-planner / report / done-audit
// loops, and the resolver's memoization is what answers it. So drive the seam in
// a LOOP, the way those callers do, and check the cost is flat.
test("integ FG-607: with a store on the host, N seam calls cost the same as ONE (memoized)", () => {
  // A real store on this host, minted by an unrelated project's import.
  const other = join(root, "other");
  mkdirSync(other, { recursive: true });
  const imported = forge(other, ["backlog", "import", "--json"], { realGit: true });
  assert.equal(imported.status, 0, `import failed: ${imported.stderr}`);
  assert.equal(existsSync(join(home, "forge.db")), true, "the host must have a store for this test");

  const project = join(root, "md-loop");
  mkdirSync(project, { recursive: true });
  for (let i = 1; i <= 25; i++) writeMarkdownTicket(project, `FG-${i}`, `ticket ${i}`);

  // One process, `calls` readTicket()s through the real seam — the planner loop.
  function loopCost(calls: number): number {
    const driver = join(root, `driver-${calls}.ts`);
    const ids = Array.from({ length: calls }, (_, i) => `FG-${i + 1}`);
    writeFileSync(
      driver,
      `import { readTicket } from ${JSON.stringify(join(here, "structured.ts"))};\n` +
        `for (const id of ${JSON.stringify(ids)}) readTicket(${JSON.stringify(project)}, id);\n`,
    );
    rmSync(gitLog, { force: true });
    const res = spawnSync(tsx, [driver], {
      encoding: "utf8",
      env: { ...process.env, FORGE_HOME: home, PATH: `${shimDir}:${process.env["PATH"] ?? ""}` },
    });
    assert.equal(res.status, 0, `driver failed: ${res.stderr}`);
    return gitInvocations();
  }

  const one = loopCost(1);
  const many = loopCost(25);

  assert.ok(one > 0, "this path is expected to consult the registry — if it went free, retarget this test");
  assert.equal(many, one, `resolution is not memoized: 1 call cost ${one} git invocations, 25 cost ${many}`);
});

// `notes` never touches a ticket store, so it must not force resolution — not even
// for a project whose committed project_key makes resolution expensive.
test("integ FG-607: `backlog notes show` never forces store resolution", () => {
  const project = join(root, "notes");
  mkdirSync(join(project, "backlog"), { recursive: true });
  mkdirSync(join(project, ".forge"), { recursive: true });
  writeFileSync(join(project, ".forge", "config.yml"), "project_key: pk-expensive\nbacklog:\n  prefix: FG\n");
  writeFileSync(join(project, "backlog", "notes.md"), "handoff notes\n");

  const res = forge(project, ["backlog", "notes", "show"]);
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  assert.equal(res.stdout, "handoff notes\n");
  assert.doesNotMatch(res.stderr, /^store:/m, "notes must not resolve a store to print a banner");
  assertNothingExpensiveHappened();
});
