// FG-693 (step 10) — the dashboard's project SCOPE is decided by filesystem
// identity, not by the bytes an operator happened to type.
//
// THE DEFECT. `scopeIncludes` compared `projectDir === scope`, and `scopeSql`
// emitted the same raw equality into SQL. One directory has many names — a
// symlinked parent, a system directory exposed under two prefixes, a relative
// spelling, a trailing separator — so a scope entered under one spelling dropped
// every row recorded under another and the operator got an EMPTY board for a
// project that was busy. On the host where this actually bites, the temp root
// ITSELF is reached through a link, which is why the fixtures below are built
// under `tmpdir()` rather than in a hand-made alias: on such a host every case in
// this file is the native alias case, executed rather than described. No test
// here names an alias prefix or branches on a platform.
//
// WHAT THIS FILE ASSERTS, and how (AC5's seam requirement, taken literally).
// Every assertion drives the DASHBOARD'S OWN QUERY ENTRY POINTS — recentActivity,
// inFlight, opsMetrics, agentRuntimeTrends, completedRunTrends, usageRollup,
// reviewLedger, hostVerificationsForTicket, recentHostVerifications,
// inProgressVerifications, orchestratorEntries, scopedOrchestratorView — with a
// scope spelled differently from what was recorded. Calling the identity helper
// directly would satisfy nothing. The WRITES go through forge's own production
// writers (insertRun, insertHostVerification, persistPendingOrchestratorReceipt)
// so the canonical column is filled by the code that ships, not by the test.
//
// THE FALSIFICATION (AC8) IS STRUCTURAL HERE: every positive case below is a scope
// whose bytes are NOT the recorded bytes, so restoring raw string equality at this
// seam turns them red. `identityDidTheWork` asserts that precondition explicitly
// rather than leaving it to inspection.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import Database from "better-sqlite3";

// FG-607/FG-616: FORGE_HOME must be assigned BEFORE anything that transitively
// evaluates src/util/paths.ts is imported, hence the dynamic imports below.
const root = mkdtempSync(join(tmpdir(), "fg693-dash-scope-"));
const forgeHome = join(root, "forge-home");
mkdirSync(forgeHome, { recursive: true });
process.env.FORGE_HOME = forgeHome;
process.env.FORGE_PROJECT_SCAN_ROOTS = join(root, "scan-roots");
mkdirSync(process.env.FORGE_PROJECT_SCAN_ROOTS, { recursive: true });

const { insertRun } = await import("../../src/store/runs.js");
const { insertHostVerification } = await import("../../src/store/host-verifications.js");
const { persistPendingOrchestratorReceipt } = await import("../../src/store/orchestrator-receipts.js");
const {
  agentRuntimeTrends,
  completedRunTrends,
  hostVerificationsForTicket,
  inFlight,
  inProgressVerifications,
  opsMetrics,
  orchestratorEntries,
  recentActivity,
  recentHostVerifications,
  reviewLedger,
  scopedOrchestratorView,
  usageRollup,
} = await import("./queries.js");

// ─── fixtures ───────────────────────────────────────────────────────────────
//
//   trees/alpha           the project under test
//   trees/alpha-sibling   a DISTINCT physical directory whose lexical path shares
//                         alpha's prefix — the negative control for AC7
//   trees/beta            a second checkout of the SAME git remote as alpha — the
//                         ticket's non-goal: path identity is not repository identity
//   links/parent -> trees        a symlinked PARENT, so links/parent/alpha aliases alpha
//   links/alpha  -> trees/alpha  a direct symlink to the checkout itself

const trees = join(root, "trees");
const links = join(root, "links");
mkdirSync(trees, { recursive: true });
mkdirSync(links, { recursive: true });

function checkout(name: string, remote: string): string {
  const dir = join(trees, name);
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["remote", "add", "origin", remote], { cwd: dir, stdio: "ignore" });
  return dir;
}

const ALPHA_REMOTE = "git@github.com:stevebargelt/fg693-alpha.git";
const alphaAsCreated = checkout("alpha", ALPHA_REMOTE);
const siblingAsCreated = checkout("alpha-sibling", "git@github.com:stevebargelt/fg693-sibling.git");
// Same remote as alpha: two checkouts of ONE repository must stay TWO projects.
const betaAsCreated = checkout("beta", ALPHA_REMOTE);

symlinkSync(trees, join(links, "parent"));
symlinkSync(alphaAsCreated, join(links, "alpha"));

/** The PROVEN identity of each fixture — what the store records as canonical. */
const alpha = realpathSync(alphaAsCreated);
const sibling = realpathSync(siblingAsCreated);
const beta = realpathSync(betaAsCreated);

/** Every spelling of ONE checkout that must resolve to ONE identity. `asCreated`
 *  is not redundant with `canonical`: on a host whose temp root is itself reached
 *  through a link they are DIFFERENT strings naming one tree, which is the native
 *  alias case this ticket exists for. */
const ALPHA_SPELLINGS: ReadonlyArray<readonly [label: string, spelling: string]> = [
  ["canonical", alpha],
  ["as-created (native alias where the temp root is linked)", alphaAsCreated],
  ["symlinked parent", join(links, "parent", "alpha")],
  ["direct symlink to the checkout", join(links, "alpha")],
  ["trailing separator", alpha + sep],
  // Concatenated, not `join`ed: join() normalizes `.` and `..` away, which would
  // hand the scope a spelling the defect never saw.
  ["a `.` segment", `${trees}${sep}.${sep}alpha`],
  ["a `..` segment through a sibling", `${trees}${sep}alpha-sibling${sep}..${sep}alpha`],
  ["relative to the process cwd", relative(process.cwd(), alpha)],
];

/** Spellings that a raw-string comparison could NOT have matched against what the
 *  row recorded — i.e. every case where identity is what did the work. Restoring
 *  `projectDir === scope` at the scope seam makes each of these return nothing. */
function identityDidTheWork(recorded: string): ReadonlyArray<readonly [string, string]> {
  return ALPHA_SPELLINGS.filter(([, spelling]) => spelling !== recorded);
}

// ─── rows, written through forge's OWN writers ──────────────────────────────

const AT = "2026-08-01T10:00:00Z";
const NOW = Date.parse("2026-08-02T10:00:00Z");

// Recorded under the CANONICAL spelling …
insertRun({ id: "run-alpha-canonical", workflow: "feature", title: "alpha canonical", status: "complete", createdAt: AT, completedAt: AT, projectDir: alpha });
// … and under an ALIAS, so the write half is exercised in both directions.
insertRun({ id: "run-alpha-linked", workflow: "feature", title: "alpha via link", status: "active", createdAt: AT, projectDir: join(links, "alpha") });
insertRun({ id: "run-sibling", workflow: "feature", title: "sibling", status: "complete", createdAt: AT, completedAt: AT, projectDir: sibling });
insertRun({ id: "run-beta", workflow: "feature", title: "beta", status: "complete", createdAt: AT, completedAt: AT, projectDir: beta });

insertHostVerification({ ticketId: "FG-693", projectDir: join(links, "parent", "alpha"), commitSha: "abc1234", gateName: "test:all", command: "npm run test:all", exitCode: 0, runId: "run-alpha-canonical", recordedAt: AT, source: "host" });
insertHostVerification({ ticketId: "FG-693", projectDir: sibling, commitSha: "abc1234", gateName: "test:all", command: "npm run test:all", exitCode: 0, runId: "run-sibling", recordedAt: AT, source: "host" });

persistPendingOrchestratorReceipt({
  receiptId: "orx-alpha", sessionKey: "fg693-alpha", projectDir: alphaAsCreated,
  runtime: "claude-code", provider: "anthropic", adapter: "claude", sessionOperation: "new", createdAt: AT,
});
persistPendingOrchestratorReceipt({
  receiptId: "orx-sibling", sessionKey: "fg693-sibling", projectDir: sibling,
  runtime: "claude-code", provider: "anthropic", adapter: "claude", sessionOperation: "new", createdAt: AT,
});

// Everything that is not a project-scope seam is seeded directly: tasks, model
// calls, reviews, campaigns and events carry no project identity of their own —
// they reach one through the run or campaign row above, which is the seam.
//
// The LEGACY rows are also written here on purpose: this is the PRE-CHANGE writer
// shape, a recorded spelling with no canonical identity beside it. A test that
// wrote them through today's writer could not detect the compatibility defect.
const DELETED = join(trees, "deleted-checkout");
{
  const db = new Database(join(forgeHome, "forge.db"));
  const task = db.prepare(
    `INSERT INTO tasks (id, run_id, phase, agent_role, status, task_package, result, created_at, started_at, completed_at)
     VALUES (?,?,?,?,?,'{}','{"ok":true}',?,?,?)`,
  );
  task.run("task-alpha-done", "run-alpha-canonical", "implementation", "engineer", "complete", AT, AT, "2026-08-01T10:00:20Z");
  task.run("task-sibling-done", "run-sibling", "implementation", "engineer", "complete", AT, AT, "2026-08-01T10:00:40Z");
  task.run("task-beta-done", "run-beta", "implementation", "engineer", "complete", AT, AT, "2026-08-01T10:01:00Z");
  db.prepare(
    `INSERT INTO tasks (id, run_id, phase, agent_role, status, task_package, created_at, started_at)
     VALUES (?,?,?,?,?,'{}',?,?)`,
  ).run("task-alpha-running", "run-alpha-linked", "implementation", "engineer", "running", AT, AT);
  // #290: a container.started event makes the running task probe-eligible, which is
  // what the reconcile-candidate fan-out classifies.
  db.prepare(`INSERT INTO events (run_id, task_id, event_type, payload, created_at) VALUES (?,?,?,NULL,?)`)
    .run("run-alpha-linked", "task-alpha-running", "container.started", AT);

  db.prepare(
    `INSERT INTO model_calls (task_id, request_id, model, alias, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run("task-alpha-done", "req-alpha", "claude-opus-5", "default", 100, 10, 0, 0, AT);

  db.prepare(`INSERT INTO reviews (id, run_id, ticket_id, state, review_mode, created_at, updated_at) VALUES (?,?,?,?,?,?,?)`)
    .run("rev-alpha", "run-alpha-canonical", "FG-693", "discovering", "evidence_led", AT, AT);

  // A campaign reconcile gate in flight: the campaign row is the project seam.
  db.prepare(
    `INSERT INTO campaigns (id, status, source_kind, source_input, mode, created_at, updated_at, project_dir)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run("camp-alpha", "running", "ticket", "FG-693", "auto", AT, AT, join(links, "parent", "alpha"));
  db.prepare(`INSERT INTO events (run_id, task_id, event_type, payload, created_at) VALUES (NULL,NULL,?,?,?)`)
    .run("campaign_item.host_gate_started", JSON.stringify({ attemptId: "att-camp", campaignId: "camp-alpha", itemId: "item-1", ticketId: "FG-693" }), new Date(NOW - 60_000).toISOString());
  // A review-loop verification in flight, reached through its RUN's project.
  db.prepare(`INSERT INTO events (run_id, task_id, event_type, payload, created_at) VALUES (?,NULL,?,?,?)`)
    .run("run-alpha-linked", "review_loop.verification_started", JSON.stringify({ attemptId: "att-loop", ticketId: "FG-693", sha: "abc1234" }), new Date(NOW - 60_000).toISOString());

  // ── the LEGACY population: recorded bytes, no canonical identity ──────────
  db.prepare(
    `INSERT INTO runs (id, workflow, title, status, created_at, completed_at, project_dir) VALUES (?,?,?,?,?,?,?)`,
  ).run("run-legacy-alias", "feature", "legacy, recorded through a link", "complete", AT, AT, join(links, "parent", "alpha"));
  db.prepare(
    `INSERT INTO runs (id, workflow, title, status, created_at, completed_at, project_dir) VALUES (?,?,?,?,?,?,?)`,
  ).run("run-legacy-gone", "feature", "legacy, checkout since deleted", "complete", AT, AT, DELETED);
  task.run("task-legacy-alias", "run-legacy-alias", "implementation", "engineer", "complete", AT, AT, "2026-08-01T10:00:30Z");
  task.run("task-legacy-gone", "run-legacy-gone", "implementation", "engineer", "complete", AT, AT, "2026-08-01T10:00:50Z");
  db.close();
}

/** The recorded bytes of a run, read straight from the store — used to prove the
 *  as-written column is never rewritten by a read. */
function recordedRun(id: string): { project_dir: string | null; project_dir_canonical: string | null } {
  const db = new Database(join(forgeHome, "forge.db"), { readonly: true });
  try {
    return db.prepare(`SELECT project_dir, project_dir_canonical FROM runs WHERE id = ?`).get(id) as {
      project_dir: string | null;
      project_dir_canonical: string | null;
    };
  } finally {
    db.close();
  }
}

const BEFORE_ANY_READ = {
  alias: recordedRun("run-legacy-alias"),
  gone: recordedRun("run-legacy-gone"),
  canonical: recordedRun("run-alpha-canonical"),
};

const runIds = (entries: ReadonlyArray<{ runId: string }>): string[] => [...new Set(entries.map((e) => e.runId))].sort();

// ─── AC5: one checkout, every spelling, the same answer ─────────────────────

test("the fixture really is one tree under many names, and the sibling really is another", () => {
  for (const [label, spelling] of ALPHA_SPELLINGS) {
    assert.equal(realpathSync(spelling), alpha, `${label} must name the SAME physical checkout`);
  }
  assert.notEqual(sibling, alpha, "the prefix-sharing sibling is a distinct physical directory");
  assert.notEqual(beta, alpha, "the second checkout of one repository is a distinct directory");
  assert.ok(
    identityDidTheWork(alpha).length >= 5,
    "the alias set must contain spellings a raw string comparison could not match, or AC8 is unfalsifiable here",
  );
});

test("recentActivity: a completed task is returned through every spelling of its checkout", () => {
  for (const [label, spelling] of ALPHA_SPELLINGS) {
    const entries = recentActivity(100, undefined, spelling);
    assert.deepEqual(runIds(entries), ["run-alpha-canonical", "run-legacy-alias"], `activity scoped by ${label}`);
    // Presentation is untouched: the payload still carries the RECORDED spelling.
    const canonicalEntry = entries.find((e) => e.runId === "run-alpha-canonical")!;
    assert.equal(canonicalEntry.projectDir, alpha, "the recorded spelling is what is displayed");
    assert.equal(canonicalEntry.checkoutName, "alpha", "the operator-facing label is unchanged");
    const legacyEntry = entries.find((e) => e.runId === "run-legacy-alias")!;
    assert.equal(legacyEntry.projectDir, join(links, "parent", "alpha"), "a legacy row displays its own recorded bytes verbatim");
  }
});

test("inFlight: a running task is returned through every spelling, and its reconcile annotation with it", () => {
  for (const [label, spelling] of ALPHA_SPELLINGS) {
    // The container is GONE and a result exists: the #290 reconcile-candidate shape.
    const entries = inFlight(spelling, () => "gone");
    assert.deepEqual(entries.map((e) => e.taskId), ["task-alpha-running"], `in-flight scoped by ${label}`);
    assert.equal(
      entries[0]?.reconcile?.classification,
      "reconcile_candidate",
      `the reconcile fan-out must scope identically to the query that selected the row (${label})`,
    );
  }
});

test("opsMetrics, the runtime trends and the throughput trend all agree across spellings", () => {
  const canonicalOps = opsMetrics("all", alpha);
  const canonicalRuntime = agentRuntimeTrends("30d", alpha, NOW);
  const canonicalRuns = completedRunTrends("30d", alpha, NOW);
  for (const [label, spelling] of identityDidTheWork(alpha)) {
    assert.deepEqual(opsMetrics("all", spelling), canonicalOps, `ops roll-up scoped by ${label}`);
    assert.deepEqual(agentRuntimeTrends("30d", spelling, NOW), canonicalRuntime, `runtime trends scoped by ${label}`);
    assert.deepEqual(completedRunTrends("30d", spelling, NOW), canonicalRuns, `completed-run trend scoped by ${label}`);
  }
  assert.ok(canonicalOps.runs.total > 0, "the fixture must actually put runs in scope");
  assert.ok(canonicalRuntime.roleSummary.length > 0, "the fixture must actually put agent tasks in scope");
});

test("usageRollup: token usage is attributed through every spelling", () => {
  // FG-747: the `project` dimension now buckets by DURABLE project identity, not by
  // the recorded checkout path — so the bucket is ONE stable identity label across
  // every spelling of the checkout, no longer the path bytes. The FG-693 invariant
  // this test guards (scope resolution through every spelling) is unchanged: one
  // bucket, 100 input tokens, whichever spelling names the checkout.
  let identityBucket: string | undefined;
  for (const [label, spelling] of ALPHA_SPELLINGS) {
    const rows = usageRollup("project", "all", spelling);
    assert.equal(rows.length, 1, `one project bucket scoped by ${label}`);
    identityBucket ??= rows[0]?.bucket;
    assert.equal(rows[0]?.bucket, identityBucket, `identity-stable bucket across spellings (${label})`);
    assert.notEqual(rows[0]?.bucket, spelling, `bucket is a durable identity label, not the checkout path (${label})`);
    assert.equal(rows[0]?.inputTokens, 100);
  }
});

test("reviewLedger: a review is scoped through its run's project identity", () => {
  for (const [label, spelling] of identityDidTheWork(alpha)) {
    assert.deepEqual(reviewLedger(spelling).map((r) => r.id), ["rev-alpha"], `review ledger scoped by ${label}`);
  }
});

test("host verification evidence is scoped by identity, not by the spelling it was recorded under", () => {
  // Recorded through a symlinked parent; asked for under every other spelling.
  for (const [label, spelling] of ALPHA_SPELLINGS) {
    assert.equal(hostVerificationsForTicket("FG-693", spelling).length, 1, `ticket evidence scoped by ${label}`);
    assert.equal(recentHostVerifications(50, spelling).length, 1, `recent evidence scoped by ${label}`);
  }
  assert.equal(
    hostVerificationsForTicket("FG-693", sibling).length,
    1,
    "the sibling still sees exactly its OWN evidence row",
  );
});

test("orchestrator receipts are scoped by identity, and the scoped view agrees", () => {
  for (const [label, spelling] of ALPHA_SPELLINGS) {
    assert.deepEqual(
      orchestratorEntries(spelling, { sessions: new Map() }).map((e) => e.receiptId),
      ["orx-alpha"],
      `receipts scoped by ${label}`,
    );
    const view = scopedOrchestratorView(spelling, { HOST: "127.0.0.1" }, { sessions: new Map() });
    assert.deepEqual(view.orchestrators.map((e) => e.receiptId), ["orx-alpha"], `scoped view by ${label}`);
    assert.equal(view.activeCount, 0, "a pending receipt with no live launcher is listed but not active");
  }
});

test("inProgressVerifications: both the run-scoped and the campaign-scoped seam accept every spelling", () => {
  for (const [label, spelling] of ALPHA_SPELLINGS) {
    const kinds = inProgressVerifications(NOW, spelling).map((v) => v.kind).sort();
    assert.deepEqual(
      kinds,
      ["campaign_reconcile_gate", "review_loop_verification"],
      `in-progress verifications scoped by ${label}`,
    );
  }
});

test("an ARRAY scope of mixed spellings of one checkout collapses to that one project", () => {
  const everySpelling = ALPHA_SPELLINGS.map(([, spelling]) => spelling);
  assert.deepEqual(
    runIds(recentActivity(100, undefined, everySpelling)),
    ["run-alpha-canonical", "run-legacy-alias"],
    "the same rows as any single spelling — never a row per spelling",
  );
  // The repository-scope shape resolveProjectScope produces: several member paths.
  assert.deepEqual(
    runIds(recentActivity(100, undefined, [alpha, sibling])),
    ["run-alpha-canonical", "run-legacy-alias", "run-sibling"],
    "a multi-checkout repository scope is the union of its members",
  );
});

// ─── AC7: the negative controls ─────────────────────────────────────────────

test("a distinct physical directory whose lexical path shares a prefix stays OUT of scope", () => {
  for (const [label, spelling] of ALPHA_SPELLINGS) {
    const ids = runIds(recentActivity(100, undefined, spelling));
    assert.ok(!ids.includes("run-sibling"), `alpha-sibling must not be absorbed into alpha (${label})`);
  }
  assert.deepEqual(runIds(recentActivity(100, undefined, sibling)), ["run-sibling"], "the sibling scopes to itself alone");
});

test("two checkouts of ONE repository under one parent stay TWO projects", () => {
  // The ticket's non-goal, stated as a test: path identity is not repository identity.
  assert.equal(
    execFileSync("git", ["remote", "get-url", "origin"], { cwd: alpha }).toString().trim(),
    execFileSync("git", ["remote", "get-url", "origin"], { cwd: beta }).toString().trim(),
    "fixture check: alpha and beta really are checkouts of one remote",
  );
  assert.ok(!runIds(recentActivity(100, undefined, alpha)).includes("run-beta"), "a shared remote never merges two checkouts");
  assert.deepEqual(runIds(recentActivity(100, undefined, beta)), ["run-beta"], "beta scopes to itself alone");
});

test("an empty repository scope still matches nothing", () => {
  assert.deepEqual(recentActivity(100, undefined, []), [], "an empty member set is not an unscoped query");
});

// ─── AC6: pre-change rows stay readable and attributable, unrewritten ───────

test("a legacy NULL-canonical row is reached through the canonical spelling of the tree it names", () => {
  const ids = runIds(recentActivity(100, undefined, alpha));
  assert.ok(
    ids.includes("run-legacy-alias"),
    "a pre-FG-693 row recorded through a symlinked parent must not vanish from the board when the operator asks canonically",
  );
});

test("a legacy row whose checkout is GONE is still readable, and is reached by its recorded bytes", () => {
  const unscoped = recentActivity(100, undefined, undefined).map((e) => e.runId);
  assert.ok(unscoped.includes("run-legacy-gone"), "an unscoped read returns it verbatim — never filtered out");
  assert.deepEqual(
    runIds(recentActivity(100, undefined, DELETED)),
    ["run-legacy-gone"],
    "nothing can be PROVEN about a path that no longer resolves, so the only honest relation left is the recorded bytes",
  );
  assert.ok(
    !runIds(recentActivity(100, undefined, alpha)).includes("run-legacy-gone"),
    "and those bytes are never re-attributed to another checkout",
  );
});

test("no read rewrote audit evidence, and no read backfilled a canonical identity", () => {
  // Every read above has now run against this store, several of them resolving the
  // legacy spellings. The read handle is read-only by construction; this asserts the
  // consequence rather than the construction.
  assert.deepEqual(recordedRun("run-legacy-alias"), BEFORE_ANY_READ.alias, "the legacy alias row is byte-identical");
  assert.equal(BEFORE_ANY_READ.alias.project_dir_canonical, null, "fixture check: it really is NULL-canonical");
  assert.deepEqual(recordedRun("run-legacy-gone"), BEFORE_ANY_READ.gone, "the gone-checkout row is byte-identical");
  assert.deepEqual(recordedRun("run-alpha-canonical"), BEFORE_ANY_READ.canonical, "the proven row is byte-identical");
  assert.equal(
    BEFORE_ANY_READ.canonical.project_dir_canonical,
    alpha,
    "fixture check: the production writer recorded the PROVEN identity beside the bytes",
  );
});

// ─── the store's own writer put an alias in project_dir; identity found it ──

test("a run WRITTEN through an alias is found through the canonical spelling", () => {
  assert.equal(
    recordedRun("run-alpha-linked").project_dir,
    join(links, "alpha"),
    "fixture check: the as-written column kept the caller's bytes",
  );
  assert.equal(recordedRun("run-alpha-linked").project_dir_canonical, alpha, "and the proven identity went beside it");
  assert.deepEqual(
    inFlight(alpha, () => "alive").map((e) => e.runId),
    ["run-alpha-linked"],
    "the canonical spelling reaches a run recorded under a link",
  );
});

test.after(() => {
  rmSync(root, { recursive: true, force: true });
});
