// FG-663 (build step 6) — a run's PROJECT is durable data captured at creation, so a
// checkout deletion can never orphan it into "Unknown repository". This file drives
// the DASHBOARD'S OWN read seams — recentActivity, taskDetail, usageRollup,
// usageTimeSeries, agentRuntimeTrends — across a checkout that is DELETED after its
// runs exist, and pins the four properties step 6 owns:
//
//   (a) AC2/AC3  a deleted-checkout run shows its correct project label+color, never
//                "Unknown repository", because presentation reads the STORED identity
//                and never re-derives from a project_dir that is gone.
//   (b) AC5      a project-scoped feed/usage/runtime query INCLUDES the project's
//                deleted-checkout runs (the identity arm), and EXCLUDES another
//                project's runs (cross-project isolation).
//   (c)          a `pk-` (declared/registered) run and a `repo-` (evidence) run of ONE
//                project normalize through the project_identity registry to ONE label
//                and ONE color — no second dashboard group.
//   (d) AC7      an exact-checkout (projectDir string) scope still isolates ONE
//                checkout and is NEVER widened by identity.
//
// NON-VACUOUS BY CONSTRUCTION. Two runs share ONE gone directory: `run-a-del-pk`
// carries the stored `pk-` identity, `run-a-legacy` carries NULL (the pre-FG-663
// shape). The first renders its real project; the second renders "Unknown repository".
// Same vanished path, opposite outcome — so the stored identity is provably what did
// the work, and a read that fell back to the path could not tell them apart. The
// WRITES that must capture identity go through forge's OWN writer (insertRun), so the
// column is filled by the code that ships; the `repo-`/legacy rows are seeded directly
// because their exact stored identity IS the fixture.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// FG-607/FG-616: FORGE_HOME must be assigned BEFORE anything that transitively
// evaluates src/util/paths.ts is imported, hence the dynamic imports below.
const root = mkdtempSync(join(tmpdir(), "fg663-dash-identity-"));
const forgeHome = join(root, "forge-home");
mkdirSync(forgeHome, { recursive: true });
process.env.FORGE_HOME = forgeHome;
process.env.FORGE_PROJECT_SCAN_ROOTS = join(root, "scan-roots");
mkdirSync(process.env.FORGE_PROJECT_SCAN_ROOTS, { recursive: true });

const { getDb } = await import("../../src/store/db.js");
const { insertRun } = await import("../../src/store/runs.js");
const { repositoryCheckoutIdentity } = await import("../../src/util/repository-identity.js");
const {
  agentRuntimeTrends,
  recentActivity,
  taskDetail,
  usageRollup,
  usageTimeSeries,
} = await import("./queries.js");

// ─── fixtures: two repositories, each with a surviving and a doomed checkout ──
//
//   trees/alpha-live   project A, SURVIVES  — makes A's dashboard ProjectRecord exist
//   trees/alpha-del    project A (same remote), DELETED after its runs are written
//   trees/beta-live    project B, SURVIVES  — the isolation control
//   trees/beta-del     project B (same remote), DELETED after its runs are written

const trees = join(root, "trees");
mkdirSync(trees, { recursive: true });

function checkout(name: string, remote: string): string {
  const dir = join(trees, name);
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["remote", "add", "origin", remote], { cwd: dir, stdio: "ignore" });
  return realpathSync(dir);
}

const ALPHA_REMOTE = "git@github.com:stevebargelt/fg663-alpha.git";
const BETA_REMOTE = "git@github.com:stevebargelt/fg663-beta.git";
const alphaLive = checkout("alpha-live", ALPHA_REMOTE);
const alphaDel = checkout("alpha-del", ALPHA_REMOTE);
const betaLive = checkout("beta-live", BETA_REMOTE);
const betaDel = checkout("beta-del", BETA_REMOTE);

// The `repo-` evidence keys the dashboard registry and project colors are built on.
// alpha-live and alpha-del share ONE remote, so they carry ONE evidence key.
const REPO_A = repositoryCheckoutIdentity(alphaLive).key;
const REPO_B = repositoryCheckoutIdentity(betaLive).key;
assert.equal(repositoryCheckoutIdentity(alphaDel).key, REPO_A, "fixture: alpha-del is the same repository as alpha-live");
assert.notEqual(REPO_A, REPO_B, "fixture: the two projects are genuinely distinct repositories");

// The declared/registered project_key for project A. Its presence in project_identity
// makes insertRun capture `pk-alpha` for every alpha checkout (registry precedence),
// and makes the dashboard normalize `pk-alpha` back to REPO_A for label+color.
const PK_A = "pk-fg663-alpha";

const AT = "2026-08-11T10:00:00Z";
const NOW = Date.parse("2026-08-12T00:00:00Z");

// ─── seed, through forge's own writer where capture is what is under test ────

const store = getDb();
// The registry row is what turns alpha's evidence into a declared `pk-`. Written
// directly: minting it through the claiming door is exactly the side effect capture
// must never have, and here it is fixture, not behaviour under test.
store
  .prepare(
    `INSERT INTO project_identity (project_key, repo_evidence_key, repo_evidence_source, created_at)
     VALUES (?, ?, 'remote', ?)`,
  )
  .run(PK_A, REPO_A, AT);

// insertRun is the single capture choke point (build step 2). These four rows have
// their project_identity filled by the SHIPPING writer, not by this test.
insertRun({ id: "run-a-live", workflow: "feature", title: "alpha, surviving checkout", status: "complete", createdAt: AT, completedAt: AT, projectDir: alphaLive });
insertRun({ id: "run-a-del-pk", workflow: "feature", title: "alpha, doomed checkout", status: "complete", createdAt: AT, completedAt: AT, projectDir: alphaDel });
insertRun({ id: "run-b-live", workflow: "feature", title: "beta, surviving checkout", status: "complete", createdAt: AT, completedAt: AT, projectDir: betaLive });
insertRun({ id: "run-b-del", workflow: "feature", title: "beta, doomed checkout", status: "complete", createdAt: AT, completedAt: AT, projectDir: betaDel });

// Fixture check: the writer captured what the ticket says it must — `pk-` for a
// checkout the registry maps, `repo-` for one it does not.
function storedIdentity(id: string): string | null {
  return (store.prepare(`SELECT project_identity FROM runs WHERE id = ?`).get(id) as { project_identity: string | null })
    .project_identity;
}
assert.equal(storedIdentity("run-a-live"), PK_A, "fixture: a registered checkout captures its pk- at creation");
assert.equal(storedIdentity("run-a-del-pk"), PK_A, "fixture: the doomed alpha checkout captured pk- while it still existed");
assert.equal(storedIdentity("run-b-live"), REPO_B, "fixture: an unregistered checkout captures its repo- evidence key");
assert.equal(storedIdentity("run-b-del"), REPO_B, "fixture: the doomed beta checkout captured repo- while it still existed");

// The two rows that make the mix and the falsification. `run-a-repo` is the SAME
// project A carrying the OTHER identity space (repo-), so it must group with the pk-
// rows. `run-a-legacy` is the pre-FG-663 shape — NULL identity, NULL canonical — on
// the SAME vanished directory as run-a-del-pk, the non-vacuous control.
function directRun(id: string, projectDir: string, identity: string | null, canonical: string | null): void {
  store
    .prepare(
      `INSERT INTO runs (id, workflow, title, status, created_at, completed_at, project_dir, project_dir_canonical, project_identity)
       VALUES (?, 'feature', ?, 'complete', ?, ?, ?, ?, ?)`,
    )
    .run(id, `direct ${id}`, AT, AT, projectDir, canonical, identity);
}
directRun("run-a-repo", alphaDel, REPO_A, alphaDel);
directRun("run-a-legacy", alphaDel, null, null);

// One completed engineer task per run (feed + runtime trends), each with a model_call
// carrying DISTINCT input tokens so a scoped usage total is exact.
function seedTaskAndCall(runId: string, tokens: number): void {
  const taskId = `task-${runId}`;
  store
    .prepare(
      `INSERT INTO tasks (id, run_id, phase, agent_role, status, task_package, result, created_at, started_at, completed_at)
       VALUES (?, ?, 'implementation', 'engineer', 'complete', '{}', '{"ok":true}', ?, ?, ?)`,
    )
    .run(taskId, runId, AT, AT, "2026-08-11T10:05:00Z");
  store
    .prepare(
      `INSERT INTO model_calls (task_id, request_id, model, alias, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, created_at)
       VALUES (?, ?, 'claude-opus-5', 'default', ?, 0, 0, 0, ?)`,
    )
    .run(taskId, `req-${runId}`, tokens, AT);
}
seedTaskAndCall("run-a-live", 100);
seedTaskAndCall("run-a-del-pk", 200);
seedTaskAndCall("run-a-repo", 400);
seedTaskAndCall("run-a-legacy", 800); // outside A's scope: NULL identity + gone path
seedTaskAndCall("run-b-live", 1000);
seedTaskAndCall("run-b-del", 2000);

// ─── THE DELETION. Every alpha/beta *-del checkout is removed from disk. Anything
// that still attributes their runs correctly is reading the STORED identity. ──────
rmSync(alphaDel, { recursive: true, force: true });
rmSync(betaDel, { recursive: true, force: true });
assert.throws(() => realpathSync(alphaDel), "fixture: the doomed alpha checkout no longer resolves");
assert.throws(() => realpathSync(betaDel), "fixture: the doomed beta checkout no longer resolves");

// The project scope the dashboard builds for project A — its `repo-` key resolves to
// the surviving checkout's member paths, exactly as resolveProjectScope() does.
const { resolveProjectScope } = await import("./queries.js");
const scopeA = resolveProjectScope(REPO_A);
assert.ok(Array.isArray(scopeA) && scopeA.length > 0, "fixture: project A resolves to a non-empty member scope");

const runIds = (entries: ReadonlyArray<{ runId: string }>): string[] => [...new Set(entries.map((e) => e.runId))].sort();

// ─── (a) AC2/AC3: a deleted-checkout run keeps its project, never "Unknown" ──

test("recentActivity: deleted-checkout runs show project A's real label and color, never 'Unknown repository'", () => {
  const entries = recentActivity(100, undefined, scopeA);
  assert.deepEqual(runIds(entries), ["run-a-del-pk", "run-a-live", "run-a-repo"], "the feed scoped to A holds all three A runs, deleted or not");

  const live = entries.find((e) => e.runId === "run-a-live")!;
  assert.ok(live.projectLabel && live.projectLabel !== "Unknown repository", "the surviving checkout has a real label");

  for (const id of ["run-a-del-pk", "run-a-repo"]) {
    const gone = entries.find((e) => e.runId === id)!;
    assert.notEqual(gone.projectLabel, "Unknown repository", `${id} (deleted checkout) is never labelled Unknown`);
    assert.equal(gone.projectLabel, live.projectLabel, `${id} carries the SAME project label as the live checkout`);
    assert.equal(gone.projectColor, live.projectColor, `${id} carries the SAME project color as the live checkout`);
  }
});

test("taskDetail: a deleted-checkout task resolves its project from the stored identity", () => {
  const detail = taskDetail("task-run-a-del-pk");
  assert.ok(detail, "the task detail exists");
  assert.notEqual(detail!.task.projectLabel, "Unknown repository", "AC3: a gone checkout is never Unknown in the detail view");
  const liveDetail = taskDetail("task-run-a-live")!;
  assert.equal(detail!.task.projectLabel, liveDetail.task.projectLabel, "the detail label matches the live checkout's");
  assert.equal(detail!.task.projectColor, liveDetail.task.projectColor, "the detail color matches the live checkout's");
});

// ─── the falsification: same vanished directory, identity is what decides ────

test("non-vacuous: on ONE gone directory, the stored-identity run resolves the project and the NULL-identity legacy row does not", () => {
  const all = recentActivity(100, undefined, undefined); // unscoped: both rows are present
  const withIdentity = all.find((e) => e.runId === "run-a-del-pk")!;
  const legacy = all.find((e) => e.runId === "run-a-legacy")!;
  assert.equal(withIdentity.projectDir, legacy.projectDir, "fixture: both rows recorded the SAME now-deleted directory");
  assert.notEqual(withIdentity.projectLabel, "Unknown repository", "the FG-663 row resolves its project from the stored identity");
  assert.equal(legacy.projectLabel, "Unknown repository", "the pre-FG-663 row, lacking a stored identity, degrades to Unknown — the defect the column removes");
});

// ─── (c) pk- and repo- rows of one project group to one label and one color ──

test("a pk- run and a repo- run of one project normalize to a single label and color", () => {
  const entries = recentActivity(100, undefined, scopeA);
  const pk = entries.find((e) => e.runId === "run-a-del-pk")!; // stored pk-fg663-alpha
  const repo = entries.find((e) => e.runId === "run-a-repo")!; // stored REPO_A
  assert.equal(storedIdentity("run-a-del-pk"), PK_A, "fixture: this run really carries the pk- space");
  assert.equal(storedIdentity("run-a-repo"), REPO_A, "fixture: this run really carries the repo- space");
  assert.equal(pk.projectLabel, repo.projectLabel, "pk- and repo- of one project resolve to ONE label");
  assert.equal(pk.projectColor, repo.projectColor, "pk- and repo- of one project resolve to ONE color — no second dashboard group");
});

// ─── (b) AC5: project-scoped reads include deleted checkouts; isolate other projects ─

test("usageRollup: project A's scoped usage includes its deleted-checkout runs and excludes project B", () => {
  const rows = usageRollup("role", "all", scopeA);
  const total = rows.reduce((sum, r) => sum + r.inputTokens, 0);
  assert.equal(total, 700, "100 (live) + 200 (deleted pk) + 400 (deleted repo) — the deleted checkouts' usage is counted");
  // The B-only numbers (1000, 2000) and the out-of-scope legacy 800 must not leak in.
  assert.ok(total < 800, "no project-B or NULL-identity usage is attributed to A");
});

test("usageTimeSeries: the same scoped total holds day by day", () => {
  const series = usageTimeSeries("30d", scopeA);
  const total = series.reduce((sum, r) => sum + r.inputTokens, 0);
  assert.equal(total, 700, "AC5: usage over time includes the deleted checkouts, excludes other projects");
});

test("agentRuntimeTrends: project A's runtime trend counts the deleted-checkout tasks and no others", () => {
  const trends = agentRuntimeTrends("30d", scopeA, NOW);
  const engineer = trends.roleSummary.find((r) => r.role === "engineer");
  assert.ok(engineer, "the engineer role is present in A's runtime trend");
  assert.equal(engineer!.sampleCount, 3, "FG-648 AC5: all three A tasks (incl. two deleted checkouts) are sampled, B's are not");
});

test("cross-project isolation: project B's scope sees only B's runs, including its own deleted checkout", () => {
  const scopeB = resolveProjectScope(REPO_B);
  const entries = recentActivity(100, undefined, scopeB);
  assert.deepEqual(runIds(entries), ["run-b-del", "run-b-live"], "B's feed holds B's runs (deleted checkout included) and none of A's");
  const bUsage = usageRollup("role", "all", scopeB).reduce((sum, r) => sum + r.inputTokens, 0);
  assert.equal(bUsage, 3000, "1000 + 2000 — B's own usage, never A's");
});

// ─── (d) AC7: an exact-checkout scope isolates ONE checkout, unwidened by identity ─

test("an exact-checkout (projectDir string) scope returns only that checkout's run", () => {
  const entries = recentActivity(100, undefined, alphaLive);
  assert.deepEqual(
    runIds(entries),
    ["run-a-live"],
    "AC7: the surviving checkout's own run only — the deleted-checkout runs of the same project are NOT pulled in by identity",
  );
});

test("an exact-checkout scope of a now-deleted directory is a pure path filter, never widened to its project", () => {
  const entries = recentActivity(100, undefined, alphaDel);
  const ids = runIds(entries);
  // Whatever the path arm can still match by recorded bytes is acceptable; what is
  // NOT acceptable is the identity arm firing for a string scope and sweeping in the
  // whole project (e.g. run-a-live, whose checkout is elsewhere and still on disk).
  assert.ok(!ids.includes("run-a-live"), "a string scope never widens to sibling checkouts via identity (AC7)");
});

test.after(() => {
  rmSync(root, { recursive: true, force: true });
});
