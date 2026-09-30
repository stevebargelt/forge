// FG-843: GET /api/projects states each checkout's kind — `operator` (the registry's own
// rows: the primary, a directory registered with `forge projects classify --purpose
// operator`) or `run` (a directory that exists only as a runs.project_dir) — and the
// counts, over the REAL server, store and git checkouts. Seeded: a registered primary, a
// second registered checkout, and three run-only directories, one of them deleted.
//
// Proves: the kinds and counts; the chooser's inputs (two live operator checkouts, primary
// first, the run checkouts only counted); run checkouts stay on the record so the project's
// runs from every checkout keep their scope and their FG-831 labels (Runs' cross-checkout
// view); and a run checkout still resolves as an exact scope (the Routing deep link).
//
// Run alone: cd dashboard && npx tsx --test src/fg843-checkout-kinds.integration.test.ts

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import Database from "better-sqlite3";
import { provenPhysical } from "../../src/util/path-identity.js";

const TEST_PORT = 18844;
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const testHome = provenPhysical(mkdtempSync(join(tmpdir(), "forge-fg843-kinds-")))!;
const forgeHome = join(testHome, ".forge");
const codeRoot = join(testHome, "code");
mkdirSync(forgeHome, { recursive: true });
mkdirSync(codeRoot, { recursive: true });
process.env.HOME = testHome;
process.env.FORGE_HOME = forgeHome;
process.env.FORGE_PROJECT_SCAN_ROOTS = join(testHome, "no-scan");
process.env.PORT = String(TEST_PORT);
process.env.HOST = "127.0.0.1";

const REMOTE = "git@github.com:acme/forge.git";

function checkout(dir: string, branch: string): string {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-b", branch], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["remote", "add", "origin", REMOTE], { cwd: dir, stdio: "ignore" });
  return provenPhysical(dir)!;
}

const primary = checkout(join(codeRoot, "forge"), "main");
const stable = checkout(join(codeRoot, "forge-stable"), "main");
const clone = checkout(join(codeRoot, "forge-fg801"), "feat/fg-801");
const worktree = checkout(join(forgeHome, "worktrees", "run-9", "forge"), "feat/fg-809");
// A deleted run-only directory of the primary (a scratchpad the registry recovers the
// repository of from the encoded source segment): a MISSING run checkout.
const gone = join(testHome, "claude-1", primary.replaceAll("/", "-"), "sess-a", "scratchpad", "wt-a");

let server: Server | undefined;

before(async () => {
  const { SCHEMA_SQL } = await import("../../src/store/schema.js");
  const { applyMigrations } = await import("../../src/store/db.js");
  const database = new Database(join(forgeHome, "forge.db"));
  database.exec(SCHEMA_SQL);
  applyMigrations(database);
  const insertRun = database.prepare("INSERT INTO runs (id,workflow,title,status,created_at,project_dir) VALUES (?,?,?,?,?,?)");
  insertRun.run("run-primary", "feature", "Primary run", "complete", "2026-09-28T10:00:00Z", primary);
  insertRun.run("run-stable", "feature", "Stable run", "complete", "2026-09-27T10:00:00Z", stable);
  insertRun.run("run-clone", "feature", "Clone run", "complete", "2026-09-26T10:00:00Z", clone);
  insertRun.run("run-worktree", "feature", "Worktree run", "complete", "2026-09-25T10:00:00Z", worktree);
  insertRun.run("run-gone", "feature", "Gone run", "complete", "2026-09-24T10:00:00Z", gone);
  database.close();

  // The registry's own rows: what `forge projects classify <dir> --purpose operator` writes.
  const { classifyWorkspacePurpose, recordWorkspacePurpose } = await import("../../src/store/workspace-purpose.js");
  classifyWorkspacePurpose({ path: primary, kind: "operator", actor: "fg843-test" });
  classifyWorkspacePurpose({ path: stable, kind: "operator", actor: "fg843-test" });
  // A Forge worktree records its artifact purpose at creation; it is still a run checkout.
  recordWorkspacePurpose({ path: worktree, kind: "worktree" });

  ({ server } = await import("./server.js"));
  for (let attempt = 0; attempt < 75; attempt += 1) {
    try {
      await fetch(`${BASE}/`);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  }
  throw new Error("dashboard test server did not start");
});

after(async () => {
  server?.closeAllConnections?.();
  await new Promise<void>((closed) => (server ? server.close(() => closed()) : closed()));
});

type Kinded = { projectDir: string; exists: boolean; kind: "operator" | "run"; projectDirs: string[]; branch?: string };
type Project = { key: string; primaryCheckout: string; checkouts: Kinded[]; checkoutCounts: { operator: number; liveOperator: number; run: number } };

async function forge(): Promise<Project> {
  const res = await fetch(`${BASE}/api/projects`);
  assert.equal(res.status, 200);
  const projects = (await res.json()) as Project[];
  const record = projects.find((p) => p.checkouts.some((c) => c.projectDir === primary));
  assert.ok(record, `the forge project is served: ${JSON.stringify(projects.map((p) => p.checkouts.map((c) => c.projectDir)))}`);
  return record;
}

test("FG-843: /api/projects states operator vs run per checkout, and the counts", async () => {
  const record = await forge();
  assert.equal(record.primaryCheckout, primary);
  const kinds = Object.fromEntries(record.checkouts.map((c) => [c.projectDir, c.kind]));
  assert.deepEqual(kinds, { [primary]: "operator", [stable]: "operator", [clone]: "run", [worktree]: "run", [gone]: "run" });
  assert.equal(record.checkouts.find((c) => c.projectDir === gone)?.exists, false, "the deleted run-only directory is carried, missing");
  assert.deepEqual(record.checkoutCounts, { operator: 2, liveOperator: 2, run: 3 });
});

test("FG-843: the chooser's inputs — two live operator checkouts, primary first; run checkouts only counted", async () => {
  const { checkoutChooser } = await import("../client/checkout-label.js");
  const record = await forge();
  const model = checkoutChooser(record, null);
  assert.equal(model.mode, "menu");
  assert.deepEqual(model.options.map((o) => [o.projectDir, o.primary]), [[primary, true], [stable, false]]);
  assert.deepEqual(model.options.map((o) => o.label), ["code/forge · main", "forge-stable · main"]);
  assert.equal(model.footer, "2 operator checkouts · 3 run checkouts are listed on their runs, not here");
  const deepLink = checkoutChooser(record, worktree);
  assert.equal(deepLink.current?.run, true, "a run checkout named by the hash reads run checkout");
  assert.equal(deepLink.current?.label, "run-9/forge · feat/fg-809");
});

test("FG-843: Runs keeps the cross-checkout listing, and each run checkout keeps its FG-831 label", async () => {
  const { checkoutLabelForDir } = await import("../client/checkout-label.js");
  const record = await forge();
  const res = await fetch(`${BASE}/api/runs?projectKey=${encodeURIComponent(record.key)}&limit=50`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { runs: Array<{ runId: string; projectDir: string }> };
  assert.deepEqual(body.runs.map((r) => r.runId).sort(), ["run-clone", "run-gone", "run-primary", "run-stable", "run-worktree"]);
  const labels = body.runs.map((r) => [r.runId, checkoutLabelForDir(r.projectDir, [record])]);
  assert.deepEqual(Object.fromEntries(labels), {
    "run-primary": "code/forge · main",
    "run-stable": "forge-stable · main",
    "run-clone": "forge-fg801 · feat/fg-801",
    "run-worktree": "run-9/forge · feat/fg-809",
    "run-gone": "wt-a · missing on disk",
  });
});

test("FG-843: a run checkout is still an exact scope — the Routing deep link reads that clone", async () => {
  const record = await forge();
  const res = await fetch(`${BASE}/api/governance?projectDir=${encodeURIComponent(clone)}`);
  assert.equal(res.status, 200);
  const q = new URLSearchParams({ projectKey: record.key, projectDir: clone, limit: "50" });
  const runs = (await (await fetch(`${BASE}/api/runs?${q}`)).json()) as { runs: Array<{ runId: string }> };
  assert.deepEqual(runs.runs.map((r) => r.runId), ["run-clone"]);
});
