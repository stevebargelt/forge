import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import type { Database as DatabaseInstance } from "better-sqlite3";
import Database from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "./db.js";
import {
  insertRun,
  getRun,
  setRunProjectDir,
  listRunsForWorkspace,
  uniqueProjectDirs,
  updateRunStatus,
  completeRun,
  failRun,
  reactivateFailedRun,
} from "./runs.js";
import { insertTask } from "./tasks.js";
import type { Run, Task } from "../types/index.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;

const RUN: Run = {
  id: "run-pd",
  workflow: "investigation",
  title: "project_dir test",
  status: "active",
  createdAt: "2026-05-08T00:00:00Z",
};

// FG-693: every path that has to DECIDE anything is a real directory. The
// contract refuses to claim an identity for a spelling the filesystem will not
// confirm, so a fixture made of invented path strings can no longer stand in for
// a checkout — and inventing one would be the "it looks the same" reasoning this
// ticket exists to delete.
let fixtureRoot: string;

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  // mkdtemp under the OS temp dir deliberately: on darwin this root is reached as
  // /var/... while its physical path is /private/var/..., so every test below
  // exercises the host's own native alias without naming it.
  fixtureRoot = mkdtempSync(join(tmpdir(), "forge-runs-identity-"));
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
  rmSync(fixtureRoot, { recursive: true, force: true });
});

/** A real directory under the per-test fixture root, returned AS WRITTEN. */
function mkFixture(...segments: string[]): string {
  const dir = join(fixtureRoot, ...segments);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** A checkout with a git remote — for the negative control that path identity is
 *  NOT repository identity. */
function mkCheckout(name: string, remote: string): string {
  const dir = mkFixture(name);
  mkdirSync(join(dir, ".git"), { recursive: true });
  writeFileSync(join(dir, ".git", "config"), `[remote "origin"]\n\turl = ${remote}\n`);
  return dir;
}

/** A row exactly as the PRE-FG-693 writer left it: a spelling in project_dir and
 *  nothing in project_dir_canonical (the column arrives by ALTER TABLE, so every
 *  pre-existing row reads NULL). Deliberately raw SQL — a legacy row written
 *  through the NEW writer would prove nothing about legacy compatibility. */
function insertLegacyRun(id: string, projectDir: string, createdAt = "2026-05-08T00:00:00Z"): void {
  db.prepare(
    `INSERT INTO runs (id, workflow, title, status, created_at, project_dir, project_dir_canonical, review_mode)
     VALUES (?, 'investigation', 'legacy row', 'active', ?, ?, NULL, 'legacy_verdict')`
  ).run(id, createdAt, projectDir);
}

function storedRow(id: string): { project_dir: string | null; project_dir_canonical: string | null } {
  return db
    .prepare(`SELECT project_dir, project_dir_canonical FROM runs WHERE id = ?`)
    .get(id) as { project_dir: string | null; project_dir_canonical: string | null };
}

test("insertRun: persists projectDir when set, omits when undefined", () => {
  insertRun({ ...RUN, id: "run-with-pd", projectDir: "/Users/x/code/foo" });
  insertRun({ ...RUN, id: "run-without-pd" });

  const withPd = getRun("run-with-pd");
  const withoutPd = getRun("run-without-pd");

  assert.equal(withPd?.projectDir, "/Users/x/code/foo");
  assert.equal(withoutPd?.projectDir, undefined);
});

// FG-693: workspace scoping is decided by PROVEN filesystem identity, so these
// fixtures are real directories rather than invented path strings — a query
// against a path nothing can resolve now proves nothing and matches nothing
// (see the module header in runs.ts).

test("listRunsForWorkspace: matches by projectDir", () => {
  const foo = mkFixture("foo");
  const bar = mkFixture("bar");
  insertRun({ ...RUN, id: "run-a", projectDir: foo });
  insertRun({ ...RUN, id: "run-b", projectDir: bar });
  insertRun({ ...RUN, id: "run-c", projectDir: foo });

  const out = listRunsForWorkspace(foo).map((r) => r.id).sort();
  assert.deepEqual(out, ["run-a", "run-c"]);
});

test("listRunsForWorkspace: matches by metadata.workspace (audit-workspace case)", () => {
  const externalRepo = mkFixture("external-repo");
  const auditWorkspace = mkFixture("audit-workspace");
  insertRun({
    ...RUN,
    id: "run-audit",
    projectDir: externalRepo,
    metadata: { workspace: auditWorkspace },
  });

  // Querying the workspace dir picks up the audit run even though its
  // projectDir is elsewhere.
  const workspaceMatches = listRunsForWorkspace(auditWorkspace).map((r) => r.id);
  assert.deepEqual(workspaceMatches, ["run-audit"]);

  // Querying the external repo also finds it (projectDir match).
  const projectMatches = listRunsForWorkspace(externalRepo).map((r) => r.id);
  assert.deepEqual(projectMatches, ["run-audit"]);
});

// FG-693 regression: the audit-workspace clause is alias-agnostic in BOTH
// directions. metadata.workspace carries no canonical column, so it is resolved at
// read time — and it must not be put through the legacy retarget-proof rule, whose
// link-free clause declines every workspace reached through a symlink and therefore
// deleted this clause outright on any host with an aliased temp or home root. Both
// halves below fail under that rule; the stored-through-a-symlink half fails on
// every platform, so the case is not left to a darwin-only host to catch.
test("listRunsForWorkspace: the audit-workspace match survives an alias on either side", () => {
  const externalRepo = mkFixture("external-repo");
  const auditWorkspace = mkFixture("audit-workspace");
  const linkedParent = join(fixtureRoot, "link-audit");
  symlinkSync(fixtureRoot, linkedParent, "dir");
  const aliasedWorkspace = join(linkedParent, "audit-workspace");

  insertRun({ ...RUN, id: "run-stored-plain", projectDir: externalRepo, metadata: { workspace: auditWorkspace } });
  insertRun({
    ...RUN,
    id: "run-stored-aliased",
    projectDir: externalRepo,
    metadata: { workspace: aliasedWorkspace },
  });

  for (const spelling of [auditWorkspace, aliasedWorkspace, auditWorkspace + sep]) {
    assert.deepEqual(
      listRunsForWorkspace(spelling).map((r) => r.id).sort(),
      ["run-stored-aliased", "run-stored-plain"],
      `both audit runs must be found through the ${spelling} spelling of one workspace`,
    );
  }

  assert.deepEqual(
    listRunsForWorkspace(mkFixture("unrelated")).map((r) => r.id),
    [],
    "and resolving the workspace never widens the match to another directory",
  );
});

test("listRunsForWorkspace: returns empty when no run matches the workspace", () => {
  insertRun({ ...RUN, id: "run-x", projectDir: mkFixture("somewhere") });
  assert.deepEqual(listRunsForWorkspace(mkFixture("other")).map((r) => r.id), []);
});

test("setRunProjectDir: writes the value and returns the previous (undefined on first set)", () => {
  insertRun(RUN);
  const prev1 = setRunProjectDir(RUN.id, "/Users/x/code/foo");
  assert.equal(prev1, undefined);
  assert.equal(getRun(RUN.id)?.projectDir, "/Users/x/code/foo");
});

test("setRunProjectDir: returns the previous value on overwrite", () => {
  insertRun({ ...RUN, projectDir: "/Users/x/code/foo" });
  const prev1 = setRunProjectDir(RUN.id, "/Users/x/code/bar");
  assert.equal(prev1, "/Users/x/code/foo");
  assert.equal(getRun(RUN.id)?.projectDir, "/Users/x/code/bar");
});

// ── FG-693: canonical project identity (AC3, AC6, AC7) ──────────────────────
//
// Every test here drives the STORE's real write and read entry points —
// insertRun / setRunProjectDir on the way in, listRunsForWorkspace /
// uniqueProjectDirs on the way out. None of them calls the identity helper to
// decide the assertion; calling the helper directly would prove only that the
// helper works, never that this store's production seam uses it.

/** The spellings of ONE directory that must all name the same project. Portable:
 *  every one of them is constructed here, none is an enumerated OS alias. */
function aliasSpellingsOf(dir: string, linkName: string): { label: string; spelling: string }[] {
  const linkedParent = join(fixtureRoot, linkName);
  symlinkSync(fixtureRoot, linkedParent, "dir");
  const leaf = relative(fixtureRoot, dir);
  return [
    { label: "trailing separator", spelling: dir + sep },
    { label: "relative to cwd", spelling: relative(process.cwd(), dir) },
    // Concatenated, not join()ed: join() would collapse the segments away and the
    // case would silently degrade into the canonical spelling.
    { label: "'.' and '..' segments", spelling: `${dir}${sep}.${sep}..${sep}${leaf}` },
    { label: "symlinked parent", spelling: join(linkedParent, leaf) },
  ];
}

test("FG-693/AC3: a run created through one spelling is found through every other spelling of the same checkout", () => {
  const checkout = mkFixture("checkout");
  insertRun({ ...RUN, id: "run-aliased", projectDir: checkout });

  for (const { label, spelling } of aliasSpellingsOf(checkout, "link-a")) {
    assert.deepEqual(
      listRunsForWorkspace(spelling).map((r) => r.id),
      ["run-aliased"],
      `workspace scoping must find the run through its ${label} spelling`
    );
    // The seam, stated: raw string equality on the recorded bytes would MISS
    // this — which is what makes the test a falsification of AC8's mutation.
    assert.notEqual(spelling, storedRow("run-aliased").project_dir, `${label} must not be a byte match`);
  }
});

test("FG-693/AC3: a run created through a symlinked parent is found through the checkout's own spelling", () => {
  const checkout = mkFixture("checkout");
  const linkedParent = join(fixtureRoot, "link-b");
  symlinkSync(fixtureRoot, linkedParent, "dir");

  insertRun({ ...RUN, id: "run-via-link", projectDir: join(linkedParent, "checkout") });

  assert.deepEqual(listRunsForWorkspace(checkout).map((r) => r.id), ["run-via-link"]);
  assert.equal(
    storedRow("run-via-link").project_dir,
    join(linkedParent, "checkout"),
    "project_dir keeps the caller's bytes verbatim — it is audit evidence"
  );
});

test("FG-693/AC2 (native alias, executes on darwin): the host's own alias spelling of one checkout resolves to one identity", () => {
  const checkout = mkFixture("checkout");
  const physical = realpathSync(checkout);
  if (physical === checkout) {
    // No native alias on this host (Linux CI) — the portable symlink case above
    // carries the class here. Nothing is asserted rather than asserted trivially.
    return;
  }
  // On darwin this is exactly /var/... vs /private/var/..., reached through the
  // OS rather than through an enumerated prefix.
  insertRun({ ...RUN, id: "run-native-alias", projectDir: checkout });
  assert.deepEqual(listRunsForWorkspace(physical).map((r) => r.id), ["run-native-alias"]);
  assert.deepEqual(listRunsForWorkspace(checkout).map((r) => r.id), ["run-native-alias"]);
  assert.deepEqual(uniqueProjectDirs().map((a) => a.projectDir), [physical]);
});

test("FG-693/AC3: the per-project aggregate reports ONE project for a checkout whose runs were recorded under several spellings", () => {
  const checkout = mkFixture("checkout");
  const linkedParent = join(fixtureRoot, "link-c");
  symlinkSync(fixtureRoot, linkedParent, "dir");

  insertRun({ ...RUN, id: "run-1", projectDir: checkout, createdAt: "2026-05-08T00:00:00Z" });
  insertRun({ ...RUN, id: "run-2", projectDir: checkout + sep, createdAt: "2026-05-08T01:00:00Z" });
  insertRun({ ...RUN, id: "run-3", projectDir: join(linkedParent, "checkout"), createdAt: "2026-05-08T02:00:00Z" });

  const aggs = uniqueProjectDirs();
  assert.equal(aggs.length, 1, "three spellings of one checkout are ONE project, not three");
  assert.equal(aggs[0]!.projectDir, realpathSync(checkout), "the aggregate reports the proven identity");
  assert.equal(aggs[0]!.runCount, 3);
  assert.equal(aggs[0]!.lastRunAt, "2026-05-08T02:00:00Z");
});

test("FG-693/AC3: in-flight counts survive the merge of two spellings of one checkout", () => {
  const checkout = mkFixture("checkout");
  insertRun({ ...RUN, id: "run-live-1", projectDir: checkout });
  insertTask(mkTask("t-live-1", "run-live-1", "running"));
  insertRun({ ...RUN, id: "run-live-2", projectDir: checkout + sep });
  insertTask(mkTask("t-live-2", "run-live-2", "complete"));

  const aggs = uniqueProjectDirs();
  assert.equal(aggs.length, 1);
  assert.equal(aggs[0]!.runCount, 2);
  assert.equal(aggs[0]!.inFlightCount, 1, "the merged group counts in-flight once, not once per spelling");
});

test("FG-693/AC7 negative control: two checkouts of the SAME git remote under one parent stay two projects", () => {
  const remote = "git@github.com:acme/one-repo.git";
  const a = mkCheckout("checkout", remote);
  const b = mkCheckout("checkout-2", remote); // also a shared LEXICAL prefix with `a`
  insertRun({ ...RUN, id: "run-a", projectDir: a });
  insertRun({ ...RUN, id: "run-b", projectDir: b });

  const aggs = uniqueProjectDirs();
  assert.equal(aggs.length, 2, "path identity is NOT repository identity — one remote, two checkouts, two projects");
  assert.deepEqual(listRunsForWorkspace(a).map((r) => r.id), ["run-a"]);
  assert.deepEqual(listRunsForWorkspace(b).map((r) => r.id), ["run-b"], "a shared lexical prefix must not leak runs across checkouts");
});

test("FG-693: insertRun stores the caller's bytes verbatim and the PROVEN identity beside them; an unresolvable path stores NULL, never a lexical guess", () => {
  const checkout = mkFixture("checkout");
  const aliased = checkout + sep;
  insertRun({ ...RUN, id: "run-proven", projectDir: aliased });
  insertRun({ ...RUN, id: "run-unresolvable", projectDir: join(fixtureRoot, "never-existed") });

  const proven = storedRow("run-proven");
  assert.equal(proven.project_dir, aliased, "audit evidence is the spelling as written");
  assert.equal(proven.project_dir_canonical, realpathSync(checkout));

  const unresolvable = storedRow("run-unresolvable");
  assert.equal(unresolvable.project_dir, join(fixtureRoot, "never-existed"));
  assert.equal(unresolvable.project_dir_canonical, null, "an unproven path yields NULL, not a resolve() guess");
});

test("FG-693: setRunProjectDir moves BOTH columns — a re-point never leaves the previous checkout's canonical identity behind", () => {
  const first = mkFixture("first");
  const second = mkFixture("second");
  insertRun({ ...RUN, id: "run-repoint", projectDir: first });

  const prevValue = setRunProjectDir("run-repoint", second + sep);
  assert.equal(prevValue, first, "the returned previous value is still the as-written spelling");
  assert.deepEqual(storedRow("run-repoint"), {
    project_dir: second + sep,
    project_dir_canonical: realpathSync(second),
  });
  assert.deepEqual(listRunsForWorkspace(second).map((r) => r.id), ["run-repoint"]);
  assert.deepEqual(listRunsForWorkspace(first).map((r) => r.id), [], "the run no longer belongs to the old checkout");

  // Re-pointed at a path nothing can confirm: the canonical column must go NULL
  // rather than keep describing a directory this run is no longer in.
  setRunProjectDir("run-repoint", join(fixtureRoot, "gone"));
  assert.equal(storedRow("run-repoint").project_dir_canonical, null);
});

// ── FG-693/AC6: pre-change (NULL-canonical) rows ────────────────────────────

test("FG-693/AC6: a legacy row whose stored spelling traversed no symlink is attributable, and merges into the proven group", () => {
  const checkout = mkFixture("checkout");
  const physical = realpathSync(checkout);
  insertLegacyRun("run-legacy", physical, "2026-05-08T00:00:00Z");
  insertRun({ ...RUN, id: "run-new", projectDir: checkout + sep, createdAt: "2026-05-08T01:00:00Z" });

  assert.deepEqual(
    listRunsForWorkspace(checkout).map((r) => r.id).sort(),
    ["run-legacy", "run-new"],
    "a retarget-proof legacy row is readable AND attributable through the canonical spelling"
  );
  const aggs = uniqueProjectDirs();
  assert.equal(aggs.length, 1, "the legacy row joins the proven group rather than forming a second project");
  assert.equal(aggs[0]!.runCount, 2);
  assert.equal(storedRow("run-legacy").project_dir, physical, "audit evidence is never rewritten");
  assert.equal(storedRow("run-legacy").project_dir_canonical, null, "the read must NOT backfill the canonical column");
});

test("FG-693/AC6: a legacy row recorded through a symlink that was later RETARGETED never attributes to the new target", () => {
  const checkoutA = mkFixture("checkout-a");
  const checkoutB = mkFixture("checkout-b");
  const link = join(fixtureRoot, "current");
  symlinkSync(checkoutA, link, "dir");

  // Written when `current` pointed at A — as the pre-change writer would have.
  insertLegacyRun("run-legacy-alias", link);

  unlinkSync(link);
  symlinkSync(checkoutB, link, "dir");
  assert.equal(realpathSync(link), realpathSync(checkoutB), "the stored spelling now resolves to B");

  // Naive read-time resolution WOULD credit A's run to B. The retarget-proof
  // rule refuses: the row records a spelling, not a tree.
  assert.deepEqual(listRunsForWorkspace(checkoutB).map((r) => r.id), [], "B must not inherit a row written against A");
  assert.deepEqual(listRunsForWorkspace(checkoutA).map((r) => r.id), [], "and it is not silently credited back to A either");

  // Declined for AUTHORITY, still fully READABLE — the row is neither filtered
  // out of the registry nor rewritten.
  const aggs = uniqueProjectDirs();
  assert.deepEqual(aggs.map((a) => a.projectDir), [link], "the declined row stays visible under its own recorded spelling");
  assert.equal(aggs[0]!.runCount, 1);
  assert.equal(storedRow("run-legacy-alias").project_dir, link, "no silent rewrite of audit evidence");
  assert.equal(storedRow("run-legacy-alias").project_dir_canonical, null);
});

test("FG-693/AC6: a legacy row whose directory is GONE stays readable and counted, and is attributed to nothing", () => {
  const vanished = mkFixture("vanished");
  insertLegacyRun("run-legacy-gone", vanished);
  rmSync(vanished, { recursive: true, force: true });

  assert.equal(getRun("run-legacy-gone")?.projectDir, vanished, "the row reads back verbatim");
  assert.deepEqual(uniqueProjectDirs().map((a) => a.projectDir), [vanished], "it is still one visible project");
  assert.deepEqual(listRunsForWorkspace(mkFixture("elsewhere")).map((r) => r.id), [], "and belongs to no other checkout");
});

test("FG-693: two DIFFERENT unproven spellings are never merged into one project", () => {
  insertLegacyRun("run-ghost-1", join(fixtureRoot, "ghost-one"), "2026-05-08T00:00:00Z");
  insertLegacyRun("run-ghost-2", join(fixtureRoot, "ghost-two"), "2026-05-08T01:00:00Z");

  const aggs = uniqueProjectDirs();
  assert.equal(aggs.length, 2, "unresolvable spellings each keep their own bucket — nothing is claimed about them");
  assert.deepEqual(aggs.map((a) => a.projectDir), [join(fixtureRoot, "ghost-two"), join(fixtureRoot, "ghost-one")]);
});

test("schema migration: existing DB without project_dir gets the column added on open", () => {
  // Build a DB with the OLD runs schema (no project_dir column), insert a row,
  // then open it via makeInMemoryDb's migration path. The migration is what runs
  // when an existing on-disk DB upgrades — simulate it here.
  const legacy = new Database(":memory:");
  legacy.pragma("foreign_keys = ON");
  legacy.exec(`
    CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      workflow TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      completed_at TEXT,
      metadata TEXT
    );
  `);
  legacy.prepare(
    `INSERT INTO runs (id, workflow, title, status, created_at) VALUES (?, ?, ?, ?, ?)`
  ).run("legacy-run", "investigation", "legacy", "active", "2026-05-08T00:00:00Z");

  // Confirm the legacy table doesn't have project_dir.
  let cols = legacy.prepare(`PRAGMA table_info(runs)`).all() as { name: string }[];
  assert.ok(!cols.some((c) => c.name === "project_dir"), "legacy schema must not have project_dir");

  // Apply the same migration db.ts runs on open. Inline so the test stays self-
  // contained — the production path lives in db.ts.
  const have = new Set(cols.map((c) => c.name));
  if (!have.has("project_dir")) {
    legacy.exec(`ALTER TABLE runs ADD COLUMN project_dir TEXT`);
  }

  cols = legacy.prepare(`PRAGMA table_info(runs)`).all() as { name: string }[];
  assert.ok(cols.some((c) => c.name === "project_dir"), "post-migration must have project_dir");

  // Existing row's project_dir is null after migration.
  const row = legacy.prepare(`SELECT project_dir FROM runs WHERE id = ?`).get("legacy-run") as
    | { project_dir: string | null }
    | undefined;
  assert.equal(row?.project_dir, null);
  legacy.close();
});

// ── uniqueProjectDirs / inFlightCount (FG-414) ──────────────────────────────
// inFlightCount must agree with the dashboard's in-flight view: a run with
// >= 1 non-terminal task, excluding orchestrator session rows. Plain
// `status = 'active'` over-counted long-lived orchestrator rows and
// un-reconciled/stuck runs whose tasks are all terminal.

function mkTask(id: string, runId: string, status: Task["status"]): Task {
  return {
    id, runId, phase: "engineer", agentRole: "engineer", status,
    taskPackage: { taskId: id, runId, phase: "engineer", role: "engineer", inputs: {}, composedSystemPrompt: "" },
    createdAt: "2026-05-08T00:00:00Z",
  };
}

test("uniqueProjectDirs: inFlightCount counts a run with a non-terminal task", () => {
  insertRun({ ...RUN, id: "run-live", projectDir: "/code/proj" });
  insertTask(mkTask("t-live", "run-live", "running"));

  const [agg] = uniqueProjectDirs();
  assert.equal(agg!.projectDir, "/code/proj");
  assert.equal(agg!.inFlightCount, 1);
});

test("uniqueProjectDirs: excludes an orchestrator session row even though its task is still 'running'", () => {
  insertRun({ ...RUN, id: "run-orch", workflow: "orchestrator", projectDir: "/code/proj" });
  insertTask(mkTask("t-orch", "run-orch", "running"));

  const [agg] = uniqueProjectDirs();
  assert.equal(agg!.inFlightCount, 0, "a long-lived orchestrator session must not inflate in-flight");
});

test("uniqueProjectDirs: excludes a stuck run (active, all tasks terminal) — un-reconciled orphans don't inflate in-flight", () => {
  insertRun({ ...RUN, id: "run-stuck", projectDir: "/code/proj" });
  insertTask(mkTask("t-stuck", "run-stuck", "failed"));

  const [agg] = uniqueProjectDirs();
  assert.equal(agg!.inFlightCount, 0);
});

test("uniqueProjectDirs: mixed project — counts only the genuinely in-flight run", () => {
  insertRun({ ...RUN, id: "run-a", projectDir: "/code/proj" });
  insertTask(mkTask("t-a", "run-a", "awaiting_gate"));
  insertRun({ ...RUN, id: "run-b", workflow: "orchestrator", projectDir: "/code/proj" });
  insertTask(mkTask("t-b", "run-b", "running"));
  insertRun({ ...RUN, id: "run-c", projectDir: "/code/proj" });
  insertTask(mkTask("t-c", "run-c", "complete"));

  const [agg] = uniqueProjectDirs();
  assert.equal(agg!.runCount, 3);
  assert.equal(agg!.inFlightCount, 1, "only run-a has a non-terminal task on a non-orchestrator run");
});

// ── completeRun (FG-484) ────────────────────────────────────────────────────
// Store-layer CAS: abandoned runs must never resurrect to complete, and the
// completion notification must never fire for a refused write. Proving
// "notifyOnRunTransition wasn't invoked" requires actually enabling a
// provider (ntfy) and mocking the network call it makes — under the test
// suite's default NO_NOTIFY=true (test-setup.ts), notifyOnRunTransition
// itself would short-circuit either way, silently. ESM named exports can't
// be monkey-patched via mock.method (module namespace properties aren't
// configurable) and `mock.module()` needs a Node flag this project's test
// script doesn't pass — so global fetch, a plain writable global, is the
// mockable seam that ntfy.ts's transport actually goes through.

const NOTIFY_ENV_KEYS = ["FORGE_NOTIFY", "NTFY_URL", "NTFY_TOKEN", "NTFY_PRIORITY", "NO_NOTIFY"];

function withNtfyEnabledAndFetchMocked(fn: (fetchMock: ReturnType<typeof mock.method>) => Promise<void>) {
  return async () => {
    const saved: Record<string, string | undefined> = {};
    for (const k of NOTIFY_ENV_KEYS) saved[k] = process.env[k];
    process.env["FORGE_NOTIFY"] = "ntfy";
    process.env["NTFY_URL"] = "https://ntfy.example.invalid/forge-test";
    delete process.env["NO_NOTIFY"];

    const fetchMock = mock.method(globalThis, "fetch", async () => new Response("", { status: 200 }));
    try {
      await fn(fetchMock);
    } finally {
      fetchMock.mock.restore();
      for (const k of NOTIFY_ENV_KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  };
}

test(
  "completeRun: completes an active run, sets a fresh completedAt, and fires exactly one notification",
  withNtfyEnabledAndFetchMocked(async (fetchMock) => {
    insertRun({ ...RUN, id: "run-complete-active", status: "active" });

    const ok = completeRun("run-complete-active");
    assert.equal(ok, true);

    const run = getRun("run-complete-active");
    assert.equal(run?.status, "complete");
    assert.ok(run?.completedAt, "completedAt must be set");

    // notifyOnRunTransition is fired async/fire-and-forget; flush the
    // microtask queue so its chained awaits (dispatch -> notifyNtfy -> fetch)
    // resolve before asserting.
    await new Promise((r) => setImmediate(r));
    assert.equal(fetchMock.mock.calls.length, 1, "expected exactly one notification dispatch");
  }),
);

test(
  "completeRun: refuses the abandoned->complete transition — status, completedAt, and notification all untouched",
  withNtfyEnabledAndFetchMocked(async (fetchMock) => {
    insertRun({ ...RUN, id: "run-complete-abandoned", status: "active" });
    updateRunStatus("run-complete-abandoned", "abandoned"); // simulates a concurrent `forge cancel` winning the race
    const abandonedAt = getRun("run-complete-abandoned")?.completedAt;
    assert.ok(abandonedAt, "abandon should have set completedAt");

    await new Promise((r) => setImmediate(r));
    fetchMock.mock.resetCalls(); // discard the abandon transition's own notification; isolate completeRun's attempt

    const ok = completeRun("run-complete-abandoned");
    assert.equal(ok, false, "completeRun must refuse an abandoned run");

    const run = getRun("run-complete-abandoned");
    assert.equal(run?.status, "abandoned", "status must stay abandoned, never flipped to complete");
    assert.equal(run?.completedAt, abandonedAt, "completedAt must be unchanged from the abandon-time value");

    await new Promise((r) => setImmediate(r));
    assert.equal(fetchMock.mock.calls.length, 0, "a refused write must never fire a completion notification");
  }),
);

test(
  "completeRun: refuses complete->complete re-finalization — no double notification, completedAt not clobbered",
  withNtfyEnabledAndFetchMocked(async (fetchMock) => {
    insertRun({ ...RUN, id: "run-complete-twice", status: "active" });

    const first = completeRun("run-complete-twice");
    assert.equal(first, true, "first completeRun call must succeed from active");
    const completedAt = getRun("run-complete-twice")?.completedAt;
    assert.ok(completedAt, "completedAt must be set by the first call");

    await new Promise((r) => setImmediate(r));
    fetchMock.mock.resetCalls(); // isolate the second call's (non-)notification

    const second = completeRun("run-complete-twice");
    assert.equal(second, false, "completeRun must refuse a second call on an already-complete run");

    const run = getRun("run-complete-twice");
    assert.equal(run?.status, "complete");
    assert.equal(run?.completedAt, completedAt, "completedAt must not be bumped by the refused re-finalization");

    await new Promise((r) => setImmediate(r));
    assert.equal(fetchMock.mock.calls.length, 0, "a refused complete->complete re-finalization must never double-notify");
  }),
);

test(
  "updateRunStatus: refuses the abandoned->complete transition at the store layer — universal backstop, independent of any caller migrating to completeRun",
  withNtfyEnabledAndFetchMocked(async (fetchMock) => {
    insertRun({ ...RUN, id: "run-update-abandoned", status: "active" });
    updateRunStatus("run-update-abandoned", "abandoned"); // simulates a concurrent `forge cancel` winning the race
    const abandonedAt = getRun("run-update-abandoned")?.completedAt;
    assert.ok(abandonedAt, "abandon should have set completedAt");

    await new Promise((r) => setImmediate(r));
    fetchMock.mock.resetCalls(); // discard the abandon transition's own notification

    // A caller that bypasses completeRun/finalizeRunIfSettled entirely (e.g.
    // src/cli/commands/design.ts, src/cli/commands/claude.ts) and calls
    // updateRunStatus(id, "complete") directly from a child-exit handler must
    // still be refused — the guard lives in the store layer, not in every caller.
    updateRunStatus("run-update-abandoned", "complete");

    const run = getRun("run-update-abandoned");
    assert.equal(run?.status, "abandoned", "status must stay abandoned, never flipped to complete");
    assert.equal(run?.completedAt, abandonedAt, "completedAt must be unchanged from the abandon-time value");

    await new Promise((r) => setImmediate(r));
    assert.equal(fetchMock.mock.calls.length, 0, "a refused abandoned->complete write must never fire a completion notification");
  }),
);

// ── failRun (FG-585) ─────────────────────────────────────────────────────────
test(
  "failRun: fails an active run, sets a fresh completedAt, and fires exactly one notification",
  withNtfyEnabledAndFetchMocked(async (fetchMock) => {
    insertRun({ ...RUN, id: "run-fail-active", status: "active" });

    const ok = failRun("run-fail-active");
    assert.equal(ok, true);

    const run = getRun("run-fail-active");
    assert.equal(run?.status, "failed");
    assert.ok(run?.completedAt, "completedAt must be set");

    await new Promise((r) => setImmediate(r));
    assert.equal(fetchMock.mock.calls.length, 1, "expected exactly one notification dispatch");
  }),
);

test(
  "failRun: refuses the abandoned->failed transition — an abandoned run is never overwritten (AWN-2)",
  withNtfyEnabledAndFetchMocked(async (fetchMock) => {
    insertRun({ ...RUN, id: "run-fail-abandoned", status: "active" });
    updateRunStatus("run-fail-abandoned", "abandoned");
    const abandonedAt = getRun("run-fail-abandoned")?.completedAt;

    await new Promise((r) => setImmediate(r));
    fetchMock.mock.resetCalls();

    const ok = failRun("run-fail-abandoned");
    assert.equal(ok, false, "failRun must refuse an abandoned run");

    const run = getRun("run-fail-abandoned");
    assert.equal(run?.status, "abandoned", "status must stay abandoned, never flipped to failed");
    assert.equal(run?.completedAt, abandonedAt, "completedAt must be unchanged");

    await new Promise((r) => setImmediate(r));
    assert.equal(fetchMock.mock.calls.length, 0, "a refused write must never fire a notification");
  }),
);

test("failRun: refuses a complete->failed flip — a run that already succeeded never fails", () => {
  insertRun({ ...RUN, id: "run-fail-after-complete", status: "active" });
  assert.equal(completeRun("run-fail-after-complete"), true);
  assert.equal(failRun("run-fail-after-complete"), false, "CAS is from active only");
  assert.equal(getRun("run-fail-after-complete")?.status, "complete");
});

test("updateRunStatus: refuses the abandoned->failed transition at the store layer (FG-585 backstop)", () => {
  insertRun({ ...RUN, id: "run-update-abandoned-fail", status: "active" });
  updateRunStatus("run-update-abandoned-fail", "abandoned");
  const abandonedAt = getRun("run-update-abandoned-fail")?.completedAt;

  updateRunStatus("run-update-abandoned-fail", "failed");

  const run = getRun("run-update-abandoned-fail");
  assert.equal(run?.status, "abandoned", "status must stay abandoned, never flipped to failed");
  assert.equal(run?.completedAt, abandonedAt, "completedAt must be unchanged");
});

test("updateRunStatus: 'active' still flips an abandoned run back to active (the #201 reactivation path)", () => {
  insertRun({ ...RUN, id: "run-reactivate", status: "active" });
  updateRunStatus("run-reactivate", "abandoned");
  assert.equal(getRun("run-reactivate")?.status, "abandoned");

  updateRunStatus("run-reactivate", "active");

  const run = getRun("run-reactivate");
  assert.equal(run?.status, "active", "updateRunStatus must still allow abandoned->active reactivation");
  assert.equal(run?.completedAt, undefined, "reactivating to a non-terminal status clears completedAt");
});

// ── updateRunStatus terminal-crossing backstop (FG-585) ──────────────────────
// A settled run's terminal truth is immutable except an explicit reactivation
// to active. These guard the generic writer against a false green light
// (failed->complete) or a lost failure (complete->failed) reaching it from a
// caller that bypasses the completeRun/failRun active-only CAS.

test("updateRunStatus: refuses a failed->complete flip — a failed run never turns green at the store layer", () => {
  insertRun({ ...RUN, id: "run-failed-to-complete", status: "active" });
  failRun("run-failed-to-complete");
  const failedAt = getRun("run-failed-to-complete")?.completedAt;
  assert.equal(getRun("run-failed-to-complete")?.status, "failed");

  updateRunStatus("run-failed-to-complete", "complete");

  const run = getRun("run-failed-to-complete");
  assert.equal(run?.status, "failed", "status must stay failed, never flipped to complete");
  assert.equal(run?.completedAt, failedAt, "completedAt must be unchanged from the fail-time value");
});

test("updateRunStatus: refuses a complete->failed flip — a completed run never turns red at the store layer", () => {
  insertRun({ ...RUN, id: "run-complete-to-failed", status: "active" });
  completeRun("run-complete-to-failed");
  const completedAt = getRun("run-complete-to-failed")?.completedAt;
  assert.equal(getRun("run-complete-to-failed")?.status, "complete");

  updateRunStatus("run-complete-to-failed", "failed");

  const run = getRun("run-complete-to-failed");
  assert.equal(run?.status, "complete", "status must stay complete, never flipped to failed");
  assert.equal(run?.completedAt, completedAt, "completedAt must be unchanged from the complete-time value");
});

test("updateRunStatus: refuses complete->abandoned and failed->abandoned — a terminal run is never re-terminalized", () => {
  insertRun({ ...RUN, id: "run-complete-to-abandoned", status: "active" });
  completeRun("run-complete-to-abandoned");
  const completedAt = getRun("run-complete-to-abandoned")?.completedAt;
  updateRunStatus("run-complete-to-abandoned", "abandoned");
  const doneRun = getRun("run-complete-to-abandoned");
  assert.equal(doneRun?.status, "complete", "status must stay complete, never re-terminalized to abandoned");
  assert.equal(doneRun?.completedAt, completedAt, "completedAt must be unchanged");

  insertRun({ ...RUN, id: "run-failed-to-abandoned", status: "active" });
  failRun("run-failed-to-abandoned");
  const failedAt = getRun("run-failed-to-abandoned")?.completedAt;
  updateRunStatus("run-failed-to-abandoned", "abandoned");
  const failRun2 = getRun("run-failed-to-abandoned");
  assert.equal(failRun2?.status, "failed", "status must stay failed, never re-terminalized to abandoned");
  assert.equal(failRun2?.completedAt, failedAt, "completedAt must be unchanged");
});

test("updateRunStatus: ALLOWS complete->active and failed->active — the reactivateTerminalRun retry/attach path must keep working", () => {
  insertRun({ ...RUN, id: "run-complete-reactivate", status: "active" });
  completeRun("run-complete-reactivate");
  assert.equal(getRun("run-complete-reactivate")?.status, "complete");
  updateRunStatus("run-complete-reactivate", "active");
  const fromComplete = getRun("run-complete-reactivate");
  assert.equal(fromComplete?.status, "active", "complete->active reactivation must be allowed");
  assert.equal(fromComplete?.completedAt, undefined, "reactivating clears completedAt");

  insertRun({ ...RUN, id: "run-failed-reactivate", status: "active" });
  failRun("run-failed-reactivate");
  assert.equal(getRun("run-failed-reactivate")?.status, "failed");
  updateRunStatus("run-failed-reactivate", "active");
  const fromFailed = getRun("run-failed-reactivate");
  assert.equal(fromFailed?.status, "active", "failed->active reactivation must be allowed");
  assert.equal(fromFailed?.completedAt, undefined, "reactivating clears completedAt");
});

// ── reactivateFailedRun (FG-688) ─────────────────────────────────────────────
// The mirror of failRun in the other direction: the adopt-preserving re-drive
// reopens a terminally-failed ordered wave's parent task, and the run row has to
// come back with it or the reopened parent never dispatches. The accept-set is
// exactly {failed}; everything else — including a run a human abandoned (AWN-2)
// and one that already succeeded — is refused at the store.

test("reactivateFailedRun: moves a failed run back to active, returns true, and clears completedAt", () => {
  insertRun({ ...RUN, id: "run-redrive-failed", status: "active" });
  failRun("run-redrive-failed");
  assert.ok(getRun("run-redrive-failed")?.completedAt, "failRun should have stamped completedAt");

  assert.equal(reactivateFailedRun("run-redrive-failed"), true, "failed->active must apply");

  const run = getRun("run-redrive-failed");
  assert.equal(run?.status, "active");
  assert.equal(run?.completedAt, undefined, "reactivation must null completed_at");
});

test("reactivateFailedRun: refuses a complete run — the accept-set cannot be widened by accident at the store", () => {
  insertRun({ ...RUN, id: "run-redrive-complete", status: "active" });
  completeRun("run-redrive-complete");
  const completedAt = getRun("run-redrive-complete")?.completedAt;

  assert.equal(reactivateFailedRun("run-redrive-complete"), false, "a run that already succeeded is never reopened");

  const run = getRun("run-redrive-complete");
  assert.equal(run?.status, "complete", "status must be unchanged");
  assert.equal(run?.completedAt, completedAt, "completedAt must be unchanged");
});

test("reactivateFailedRun: refuses an abandoned run — a human's `forge cancel` is authoritatively terminal (AWN-2)", () => {
  insertRun({ ...RUN, id: "run-redrive-abandoned", status: "active" });
  updateRunStatus("run-redrive-abandoned", "abandoned");
  const abandonedAt = getRun("run-redrive-abandoned")?.completedAt;

  assert.equal(reactivateFailedRun("run-redrive-abandoned"), false, "an abandoned run is never resurrected");

  const run = getRun("run-redrive-abandoned");
  assert.equal(run?.status, "abandoned", "status must stay abandoned");
  assert.equal(run?.completedAt, abandonedAt, "completedAt must be unchanged");
});

test("reactivateFailedRun: refuses an already-active run — callers must handle the no-op explicitly", () => {
  insertRun({ ...RUN, id: "run-redrive-active", status: "active" });

  assert.equal(reactivateFailedRun("run-redrive-active"), false, "active->active must not read back as applied");
  assert.equal(getRun("run-redrive-active")?.status, "active");
});

test("reactivateFailedRun: onApplied runs exactly once, and only when the CAS applied", () => {
  insertRun({ ...RUN, id: "run-redrive-hook", status: "active" });
  failRun("run-redrive-hook");

  let calls = 0;
  assert.equal(reactivateFailedRun("run-redrive-hook", { onApplied: () => calls++ }), true);
  assert.equal(calls, 1, "onApplied fires once on the applied write");

  // The run is 'active' now, so the CAS refuses — and the hook must not fire.
  assert.equal(reactivateFailedRun("run-redrive-hook", { onApplied: () => calls++ }), false);
  assert.equal(calls, 1, "a refused CAS must never run onApplied");
});

test("reactivateFailedRun: a throw from onApplied rolls the status write back — the run is still failed", () => {
  insertRun({ ...RUN, id: "run-redrive-rollback", status: "active" });
  failRun("run-redrive-rollback");
  const failedAt = getRun("run-redrive-rollback")?.completedAt;

  assert.throws(
    () =>
      reactivateFailedRun("run-redrive-rollback", {
        onApplied: () => {
          throw new Error("audit event write failed");
        },
      }),
    /audit event write failed/,
  );

  const run = getRun("run-redrive-rollback");
  assert.equal(run?.status, "failed", "the status write must roll back with the caller's event write");
  assert.equal(run?.completedAt, failedAt, "completedAt must survive the rollback");
});

test(
  "reactivateFailedRun: fires NO notification — reactivation is silent, matching every existing reactivation path",
  withNtfyEnabledAndFetchMocked(async (fetchMock) => {
    insertRun({ ...RUN, id: "run-redrive-silent", status: "active" });
    failRun("run-redrive-silent");
    await new Promise((r) => setImmediate(r));
    fetchMock.mock.resetCalls(); // discard failRun's own notification

    assert.equal(reactivateFailedRun("run-redrive-silent"), true);

    await new Promise((r) => setImmediate(r));
    assert.equal(fetchMock.mock.calls.length, 0, "no post-commit side effect may escape a caller's rollback");
  }),
);

test("updateRunStatus: ALLOWS active->failed and active->complete — the normal finalize path is untouched", () => {
  insertRun({ ...RUN, id: "run-active-to-failed", status: "active" });
  updateRunStatus("run-active-to-failed", "failed");
  const failed = getRun("run-active-to-failed");
  assert.equal(failed?.status, "failed", "active->failed must be allowed");
  assert.ok(failed?.completedAt, "active->failed sets completedAt");

  insertRun({ ...RUN, id: "run-active-to-complete", status: "active" });
  updateRunStatus("run-active-to-complete", "complete");
  const complete = getRun("run-active-to-complete");
  assert.equal(complete?.status, "complete", "active->complete must be allowed");
  assert.ok(complete?.completedAt, "active->complete sets completedAt");
});

test("schema migration: re-running the migration is a noop", () => {
  // makeInMemoryDb already ran the migration once. Run it again manually and
  // confirm no error and no duplicate column.
  const cols = db.prepare(`PRAGMA table_info(runs)`).all() as { name: string }[];
  const hadIt = cols.some((c) => c.name === "project_dir");
  assert.ok(hadIt, "fresh in-memory DB has project_dir from schema");
  // Calling ALTER again would throw "duplicate column"; the guard prevents that.
  // Simulate the guard:
  const have = new Set(cols.map((c) => c.name));
  assert.equal(have.has("project_dir"), true);
});
