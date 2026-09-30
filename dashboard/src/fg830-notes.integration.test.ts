// FG-830: the Notes view's read — GET /api/backlog's `notesByCheckout` — over the real
// server and real checkouts. One entry per checkout with a non-empty `backlog/notes.md`,
// each carrying the file's mtime as `modifiedAt` (the view's fallback session date);
// a checkout scope narrows it to that checkout; the route stays GET-only.
//
// Run alone: cd dashboard && npx tsx --test src/fg830-notes.integration.test.ts

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, realpathSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { applyMigrations } from "../../src/store/db.js";
import { SCHEMA_SQL } from "../../src/store/schema.js";
import { repositoryCheckoutIdentity } from "../../src/util/repository-identity.js";
import { noteRows } from "../client/notes-render.js";

const TEST_PORT = 18838;
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const testHome = realpathSync(mkdtempSync(join(tmpdir(), "forge-fg830-notes-")));
const forgeHome = join(testHome, ".forge");
const reposRoot = join(testHome, "checkouts");
mkdirSync(forgeHome, { recursive: true });
mkdirSync(reposRoot, { recursive: true });

process.env.HOME = testHome;
process.env.FORGE_HOME = forgeHome;
process.env.FORGE_PROJECT_SCAN_ROOTS = reposRoot;
process.env.PORT = String(TEST_PORT);
process.env.HOST = "127.0.0.1";

const REMOTE = "git@github.com:stevebargelt/forge.git";
const PROJECT_KEY = "pk-fg830";
const MTIME = new Date("2026-09-20T10:00:00.000Z");

function checkout(name: string, branch: string, notes: string | null): string {
  const dir = join(reposRoot, name);
  mkdirSync(join(dir, "backlog"), { recursive: true });
  execFileSync("git", ["init", "-b", branch], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["remote", "add", "origin", REMOTE], { cwd: dir, stdio: "ignore" });
  if (notes !== null) {
    writeFileSync(join(dir, "backlog", "notes.md"), notes);
    utimesSync(join(dir, "backlog", "notes.md"), MTIME, MTIME);
  }
  return dir;
}

const dated = checkout("forge", "main", "**Last session ended 2026-08-13.**\n\nMain handoff.\n");
const undated = checkout("forge-fg830", "feat/fg-830", "# Feature handoff\n\nNo session line.\n");
const blank = checkout("forge-blank", "feat/blank", "  \n");
const none = checkout("forge-none", "feat/none", null);

{
  const database = new Database(join(forgeHome, "forge.db"));
  database.exec(SCHEMA_SQL);
  applyMigrations(database);
  const insertRun = database.prepare("INSERT INTO runs (id,workflow,title,status,created_at,project_dir) VALUES (?,?,?,?,?,?)");
  const insertTask = database.prepare(
    "INSERT INTO tasks (id,run_id,phase,agent_role,status,task_package,result,created_at,started_at,completed_at) VALUES (?,?,?,?,?,'{}','{}',?,?,?)",
  );
  [dated, undated, blank, none].forEach((dir, i) => {
    const at = `2026-09-${10 + i}T10:00:00Z`;
    insertRun.run(`run-${i}`, "feature", `Run ${i}`, "complete", at, dir);
    insertTask.run(`task-${i}`, `run-${i}`, "engineer", "engineer", "complete", at, at, at);
  });
  database
    .prepare("INSERT INTO project_identity (project_key, repo_evidence_key, repo_evidence_source, created_at) VALUES (?,?,?,?)")
    .run(PROJECT_KEY, repositoryCheckoutIdentity(dated).key, "remote", "2026-09-01T00:00:00Z");
  database.close();
}

// FG-817's invariant-21 rig: install after the fixture has created real Git checkouts.
// A no-project Notes read has no checkout to resolve, so it must not shell out to inspect one.
const rig = mkdtempSync(join(tmpdir(), "forge-fg830-no-project-"));
const callLog = join(rig, "calls.log");
const originalPath = process.env.PATH;
writeFileSync(callLog, "");
mkdirSync(join(rig, "bin"));
for (const bin of ["docker", "git", "gh", "tmux", "forge", "forge-dev", "aws"]) {
  writeFileSync(join(rig, "bin", bin), `#!/bin/sh\necho "${bin} $*" >> "${callLog}"\nexit 0\n`);
  chmodSync(join(rig, "bin", bin), 0o755);
}
const { server } = await import("./server.js");
after(() => {
  server.closeAllConnections?.();
  server.close();
});

for (let attempt = 0; attempt < 75; attempt += 1) {
  try {
    await fetch(`${BASE}/`);
    break;
  } catch {
    if (attempt === 74) throw new Error("dashboard test server did not start");
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

type NotesEntry = { checkoutDir: string; checkoutBranch: string | null; notes: string; modifiedAt: string | null };
type Projects = Array<{ key: string; primaryCheckout?: string; checkouts: Array<{ projectDir: string; branch?: string | null; exists?: boolean }> }>;

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  assert.equal(res.status, 200, `GET ${path}`);
  return res.json() as Promise<T>;
}

function real(dir: string): string {
  return realpathSync(dir);
}

test("FG-830: a project's notes are one entry per checkout with a non-empty note, each with its file mtime", async () => {
  const projects = await getJson<Projects>("/api/projects");
  const project = projects.find((p) => p.checkouts.some((c) => real(c.projectDir) === real(dated)));
  assert.ok(project, "the fixture checkouts register as one project");
  const body = await getJson<{ notes: string; notesByCheckout: NotesEntry[] }>(`/api/backlog?projectKey=${encodeURIComponent(project.key)}`);
  const byDir = new Map(body.notesByCheckout.map((entry) => [real(entry.checkoutDir), entry]));
  assert.deepEqual([...byDir.keys()].sort(), [real(dated), real(undated)].sort(), "a blank note and a missing note have no entry");
  for (const dir of [dated, undated]) {
    const entry = byDir.get(real(dir))!;
    assert.equal(entry.modifiedAt, statSync(join(dir, "backlog", "notes.md")).mtime.toISOString());
    assert.equal(entry.modifiedAt, MTIME.toISOString());
  }
  assert.equal(byDir.get(real(undated))!.checkoutBranch, "feat/fg-830");
  assert.equal(body.notes, "", "a multi-checkout project has no single `notes`");

  // The same payload through the view's rule: newest session first — the undated note
  // falls back to its 2026-09-20 mtime and so sorts above the 2026-08-13 session line.
  const rows = noteRows(body, { project: project.key }, projects);
  assert.deepEqual(rows.map((r) => [real(r.checkoutDir), r.session.source]), [[real(undated), "modified"], [real(dated), "note"]]);
  assert.equal(new Set(rows.map((r) => r.label)).size, 2);
});

test("FG-830: an exact checkout scope reads that checkout's note alone", async () => {
  const body = await getJson<{ notes: string; notesByCheckout: NotesEntry[] }>(`/api/backlog?projectDir=${encodeURIComponent(dated)}`);
  assert.deepEqual(body.notesByCheckout.map((e) => real(e.checkoutDir)), [real(dated)]);
  assert.match(body.notes, /Last session ended 2026-08-13/);
  assert.equal(body.notesByCheckout[0]!.modifiedAt, MTIME.toISOString());
});

test("FG-830: the read is GET-only — a POST is refused and writes nothing", async () => {
  const before = statSync(join(dated, "backlog", "notes.md")).mtimeMs;
  for (const path of [`/api/backlog?projectDir=${encodeURIComponent(dated)}`, "/api/notes"]) {
    const res = await fetch(`${BASE}${path}`, { method: "POST", body: "{}" });
    assert.equal(res.status, 405, `POST ${path}`);
  }
  assert.equal(statSync(join(dated, "backlog", "notes.md")).mtimeMs, before);
});

test("FG-830: an unscoped Notes read is empty and never starts a subprocess", async () => {
  writeFileSync(callLog, "");
  process.env.PATH = `${join(rig, "bin")}:${originalPath ?? ""}`;
  try {
    const body = await getJson<{ notes: string; notesByCheckout?: NotesEntry[]; tickets: unknown[]; ticketsProjectKey: null }>("/api/backlog");
    assert.equal(body.notes, "");
    assert.ok(body.notesByCheckout === undefined || body.notesByCheckout.length === 0);
    assert.deepEqual(body.tickets, []);
    assert.equal(body.ticketsProjectKey, null);
    assert.equal(readFileSync(callLog, "utf8"), "", "an unscoped read must not probe git or any other subprocess");
  } finally {
    process.env.PATH = originalPath;
  }
});
