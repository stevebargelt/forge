// FG-821 step A: the cockpit's read-only endpoints end to end against a seeded store —
// GET /api/runs (paging, status, scope, since, and activeCount as ONE derivation with
// `forge runs query`), GET /api/review/:id, the `links` on GET /api/task/:id,
// GET /api/backlog/:id/runs and (step C) GET /api/run/:id/evidence.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fixtureFetch } from "./test-support/fixture-fetch.js";

const TEST_PORT = 18821;
const BASE = `http://127.0.0.1:${TEST_PORT}`;
process.env.FORGE_DASHBOARD_REMOTE = "0";
const { awaitDashboardReady } = await import("./test-support/await-dashboard-ready.js");

const tmpHome = mkdtempSync(join(tmpdir(), "forge-fg821-"));
process.env.FORGE_HOME = tmpHome;
process.env.PORT = String(TEST_PORT);
process.env.HOST = "127.0.0.1";

const { getDb, writeTransaction } = await import("../../src/store/db.js");

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const projectA = mkdtempSync(join(tmpdir(), "forge-fg821-a-"));
const projectB = mkdtempSync(join(tmpdir(), "forge-fg821-b-"));
const HOUR = 3_600_000;
const ago = (hours: number) => new Date(Date.now() - hours * HOUR).toISOString();
const OLD = "2020-01-01T00:00:00.000Z";

function insertRun(id: string, status: string, createdAt: string, projectDir: string, metadata: unknown): void {
  getDb()
    .prepare(`INSERT INTO runs (id, workflow, title, status, created_at, project_dir, metadata) VALUES (?,?,?,?,?,?,?)`)
    .run(id, "feature", `title ${id}`, status, createdAt, projectDir, metadata === null ? null : JSON.stringify(metadata));
}

writeTransaction(() => {
  const db = getDb();
  insertRun("run-a1", "active", ago(1), projectA, { ticketId: "FG-900" });
  insertRun("run-a2", "active", ago(2), projectA, { inputs: { ticketId: "FG-900" } });
  insertRun("run-a3", "failed", ago(3), projectA, null);
  insertRun("run-a4", "complete", ago(4), projectA, { ticketId: "FG-901" });
  insertRun("run-b1", "active", ago(5), projectB, { ticketId: "FG-900" });
  insertRun("run-b2", "complete", ago(6), projectB, null);
  insertRun("run-old", "active", OLD, projectB, null);

  const task = db.prepare(
    `INSERT INTO tasks (id, run_id, phase, agent_role, status, task_package, created_at, started_at) VALUES (?,?,?,?,?,?,?,?)`,
  );
  task.run("task-a1", "run-a1", "build", "engineer", "running", "{}", ago(1), ago(1));
  task.run("task-a3", "run-a3", "build", "engineer", "failed", "{}", ago(3), ago(3));
  db.prepare(`INSERT INTO events (run_id, task_id, event_type, payload, created_at) VALUES (?,?,?,?,?)`).run(
    "run-a3", "task-a3", "task.failed", JSON.stringify({ failure_kind: "merge_conflict" }), ago(3),
  );

  const review = db.prepare(
    `INSERT INTO reviews (id, run_id, subject_task_id, ticket_id, candidate_sha, state, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`,
  );
  review.run("review-a1", "run-a1", "task-a1", "FG-900", "cand-a1", "awaiting_disposition", ago(1), ago(1));
  review.run("review-b1", "run-b1", null, "FG-900", null, "settled", ago(5), ago(5));
  db.prepare(
    `INSERT INTO review_findings (id, review_id, ordinal, finding_ref, summary, severity, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`,
  ).run("review-a1/RF-1", "review-a1", 1, "RF-1", "missing guard", "high", ago(1), ago(1));

  const launch = db.prepare(
    `INSERT INTO launch_observations (launch_id, command, cwd, project_dir, association_kind, run_id, task_id, started_at, observed_at, state, terminal)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  );
  launch.run("launch-task", "[]", projectA, projectA, "task", "run-a1", "task-a1", ago(1), ago(1), "running", 0);
  launch.run("launch-run", "[]", projectA, projectA, "run", "run-a1", null, ago(2), ago(2), "exited", 1);
  launch.run("launch-other", "[]", projectB, projectB, "run", "run-b1", null, ago(5), ago(5), "exited", 1);

  const hv = db.prepare(
    `INSERT INTO host_verifications (ticket_id, project_dir, commit_sha, gate_name, command, exit_code, run_id, recorded_at) VALUES (?,?,?,?,?,?,?,?)`,
  );
  hv.run("FG-900", projectA, "cand-a1", "suite", "npm test", 0, "run-a1", ago(1));
  hv.run("FG-900", projectA, "cand-a1", "typecheck", "npm run typecheck", 0, null, ago(1));
  hv.run("FG-900", projectB, "cand-b1", "suite", "npm test", 0, "run-b1", ago(5));
});

const { server } = await import("./server.js");
await awaitDashboardReady(BASE, { timeoutMs: 4000 });
after(() => {
  server.closeAllConnections?.();
  server.close();
});

type RunsBody = { runs: Array<Record<string, unknown> & { runId: string; status: string }>; activeCount: number; nextCursor: string | null; generatedAt: string };

async function get(path: string): Promise<{ status: number; body: any }> {
  const deadline = Date.now() + 4000;
  for (;;) {
    try {
      const res = await fixtureFetch(`${BASE}${path}`);
      return { status: res.status, body: await res.json() };
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await new Promise((r) => setTimeout(r, 40));
    }
  }
}

async function runs(query: string): Promise<RunsBody> {
  const res = await get(`/api/runs${query}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body as RunsBody;
}

function cliRuns(args: string[]): Array<Record<string, unknown>> {
  return JSON.parse(
    execFileSync("sh", [join(REPO_ROOT, "bin", "forge"), "runs", "query", "--json", ...args], {
      cwd: projectA,
      env: { ...process.env, FORGE_HOME: tmpHome },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }),
  ) as Array<Record<string, unknown>>;
}

const ids = (body: RunsBody) => body.runs.map((r) => r.runId);

test("FG-821: GET /api/runs lists every run newest first, with the server activeCount", async () => {
  const body = await runs("");
  assert.deepEqual(ids(body), ["run-a1", "run-a2", "run-a3", "run-a4", "run-b1", "run-b2", "run-old"]);
  assert.equal(body.activeCount, 4);
  assert.equal(body.nextCursor, null);
  assert.equal(typeof body.generatedAt, "string");
  const failed = body.runs.find((r) => r.runId === "run-a3")!;
  assert.equal(failed.failedCount, 1);
  assert.deepEqual(failed.failureKinds, ["merge_conflict"]);
  // ticketId reads COALESCE(metadata.inputs.ticketId, metadata.ticketId), as the ticket routes do.
  assert.deepEqual(
    Object.fromEntries(body.runs.map((r) => [r.runId, r.ticketId])),
    { "run-a1": "FG-900", "run-a2": "FG-900", "run-a3": null, "run-a4": "FG-901", "run-b1": "FG-900", "run-b2": null, "run-old": null },
  );
});

test("FG-821: activeCount and the rows are forge runs query's — one derivation", async () => {
  const cliActive = cliRuns(["--status", "active"]);
  const body = await runs("?status=active");
  assert.equal(body.activeCount, cliActive.length);
  assert.deepEqual(body.runs, cliActive);
  assert.deepEqual(await runs("").then((b) => b.runs), cliRuns([]));

  // Scoped to one exact checkout: the same count `--project <dir>` gives.
  const scoped = await runs(`?projectDir=${encodeURIComponent(projectA)}`);
  assert.equal(scoped.activeCount, cliRuns(["--status", "active", "--project", projectA]).length);
  assert.equal(scoped.activeCount, 2);
});

test("FG-821: GET /api/runs pages with a cursor, never repeating or dropping a run", async () => {
  const seen: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const page: RunsBody = await runs(`?limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    assert.ok(page.runs.length <= 3);
    assert.equal(page.activeCount, 4, "activeCount is independent of paging");
    seen.push(...ids(page));
    cursor = page.nextCursor;
    pages++;
  } while (cursor !== null && pages < 10);
  assert.equal(pages, 3);
  assert.deepEqual(seen, ["run-a1", "run-a2", "run-a3", "run-a4", "run-b1", "run-b2", "run-old"]);

  assert.equal((await get("/api/runs?cursor=not-a-cursor")).status, 400);
  assert.equal((await runs("?limit=1000")).runs.length, 7, "limit is clamped to 200, not refused");
  assert.equal((await runs("?limit=0")).runs.length, 1, "limit is clamped to at least 1");
});

test("FG-821: GET /api/runs filters by status and refuses a malformed one", async () => {
  assert.deepEqual(ids(await runs("?status=failed")), ["run-a3"]);
  assert.deepEqual(ids(await runs("?status=complete")), ["run-a4", "run-b2"]);
  const none = await runs("?status=abandoned");
  assert.deepEqual(none.runs, []);
  assert.equal(none.activeCount, 4, "activeCount ignores the status filter");
  assert.equal((await get("/api/runs?status=Active%20OR%201")).status, 400);
});

test("FG-821: GET /api/runs scopes rows and activeCount by project", async () => {
  const a = await runs(`?projectDir=${encodeURIComponent(projectA)}`);
  assert.deepEqual(ids(a), ["run-a1", "run-a2", "run-a3", "run-a4"]);
  assert.equal(a.activeCount, 2);
  const b = await runs(`?projectDir=${encodeURIComponent(projectB)}&status=active`);
  assert.deepEqual(ids(b), ["run-b1", "run-old"]);
  assert.equal(b.activeCount, 2);
  const unknown = await runs("?projectKey=no-such-project");
  assert.deepEqual(unknown.runs, []);
  assert.equal(unknown.activeCount, 0, "an unknown project matches nothing, never widens");
});

test("FG-821: GET /api/runs bounds by since (duration or ISO) without touching activeCount", async () => {
  const day = await runs("?since=1d");
  assert.deepEqual(ids(day), ["run-a1", "run-a2", "run-a3", "run-a4", "run-b1", "run-b2"]);
  assert.equal(day.activeCount, 4);
  assert.deepEqual(ids(await runs(`?since=${encodeURIComponent(ago(2.5))}`)), ["run-a1", "run-a2"]);
  assert.deepEqual(ids(await runs("?since=150m")), ["run-a1", "run-a2"]);
  assert.equal((await runs("?since=all")).runs.length, 7);
  assert.equal((await get("/api/runs?since=yesterday")).status, 400);
});

test("FG-821: GET /api/review/:id returns one review with findings, scoped like the run map", async () => {
  const hit = await get("/api/review/review-a1");
  assert.equal(hit.status, 200);
  assert.equal(hit.body.id, "review-a1");
  assert.equal(hit.body.runId, "run-a1");
  assert.equal(hit.body.candidateSha, "cand-a1");
  assert.deepEqual(hit.body.findings.map((f: { findingRef: string }) => f.findingRef), ["RF-1"]);
  assert.deepEqual(hit.body.countsByDisposition, { untriaged: 1 });

  assert.equal((await get("/api/review/review-nope")).status, 404);
  assert.equal((await get(`/api/review/review-a1?projectDir=${encodeURIComponent(projectA)}`)).status, 200);
  assert.equal((await get(`/api/review/review-a1?projectDir=${encodeURIComponent(projectB)}`)).status, 404);
  assert.equal((await get("/api/review/review-a1?projectKey=anything")).status, 409);
  assert.equal((await get("/api/review/%E0%A4%A")).status, 404);
});

test("FG-821: GET /api/task/:id carries id-only links to its run, ticket, reviews, launches and verifications", async () => {
  const res = await get("/api/task/task-a1");
  assert.equal(res.status, 200);
  const links = res.body.links as { runId: string; ticketId: string | null; reviewIds: string[]; launchIds: string[]; hostVerificationIds: number[] };
  assert.equal(links.runId, "run-a1");
  assert.equal(links.ticketId, "FG-900");
  assert.deepEqual(links.reviewIds, ["review-a1"]);
  assert.deepEqual(links.launchIds, ["launch-task", "launch-run"]);
  // The run_id row and its candidate-sha sibling in the same project — never project B's.
  assert.deepEqual([...links.hostVerificationIds].sort((x, y) => x - y), [1, 2]);
});

test("FG-821: a task whose run carries no ticket and no evidence links to its run alone", async () => {
  const res = await get("/api/task/task-a3");
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.links, { runId: "run-a3", ticketId: null, reviewIds: [], launchIds: [], hostVerificationIds: [] });
});

test("FG-821: GET /api/run/:id/evidence is the union of the run's task links, read once by run", async () => {
  const res = await get("/api/run/run-a1/evidence");
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.body).sort(), ["hostVerificationIds", "launchIds", "reviewIds", "runId", "ticketId"]);
  assert.equal(res.body.runId, "run-a1");
  assert.equal(res.body.ticketId, "FG-900");
  assert.deepEqual(res.body.reviewIds, ["review-a1"]);
  assert.deepEqual(res.body.launchIds, ["launch-task", "launch-run"]);
  // The run_id row and its candidate-sha sibling in the same project — never project B's.
  assert.deepEqual([...res.body.hostVerificationIds].sort((x: number, y: number) => x - y), [1, 2]);
  assert.deepEqual(res.body, { ...(await get("/api/task/task-a1")).body.links }, "the same ids the run's task links carry");

  // A run with no tasks still reads its run-bound evidence.
  const b1 = await get("/api/run/run-b1/evidence");
  assert.deepEqual(b1.body, { runId: "run-b1", ticketId: "FG-900", reviewIds: ["review-b1"], launchIds: ["launch-other"], hostVerificationIds: [3] });

  // An object route: unscoped by id; an exact checkout scopes it; projectKey alone is refused.
  assert.equal((await get(`/api/run/run-a1/evidence?projectDir=${encodeURIComponent(projectA)}`)).status, 200);
  assert.equal((await get(`/api/run/run-a1/evidence?projectDir=${encodeURIComponent(projectB)}`)).status, 404);
  assert.equal((await get("/api/run/run-a1/evidence?projectKey=anything")).status, 409);
  assert.equal((await get("/api/run/run-nope/evidence")).status, 404);
});

test("FG-821: GET /api/run/:id/evidence for a run with no ticket and no evidence is empty, not missing", async () => {
  const res = await get("/api/run/run-a3/evidence");
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { runId: "run-a3", ticketId: null, reviewIds: [], launchIds: [], hostVerificationIds: [] });
});

test("FG-821: GET /api/backlog/:id/runs lists the ticket's runs, scoped, and none for an unused ticket", async () => {
  const all = await get("/api/backlog/FG-900/runs");
  assert.equal(all.status, 200);
  assert.equal(all.body.ticketId, "FG-900");
  assert.deepEqual(all.body.runs.map((r: { runId: string }) => r.runId), ["run-a1", "run-a2", "run-b1"]);
  assert.deepEqual(Object.keys(all.body.runs[0]).sort(), ["runId", "startedAt", "status", "title"]);
  assert.equal(all.body.runs[0].title, "title run-a1");

  const scoped = await get(`/api/backlog/FG-900/runs?projectDir=${encodeURIComponent(projectB)}`);
  assert.deepEqual(scoped.body.runs.map((r: { runId: string }) => r.runId), ["run-b1"]);

  const none = await get("/api/backlog/FG-999/runs");
  assert.equal(none.status, 200);
  assert.deepEqual(none.body.runs, []);
  assert.equal((await get("/api/backlog/..%2Fetc/runs")).status, 400);
});

test("FG-821: GET /api/runs is memoized for the poll interval — a new run shows after it, not within it", async () => {
  const before = await runs("");
  writeTransaction(() => insertRun("run-a5", "active", ago(0.5), projectA, null));
  const within = await runs("");
  assert.equal(within.activeCount, before.activeCount, "served from the per-(scope,status,since) cache");
  assert.deepEqual(ids(within), ids(before));
  // A key not yet cached reads fresh.
  const fresh = await runs("?status=active&since=7d");
  assert.ok(ids(fresh).includes("run-a5"));
});

test("FG-821: run-index cache expires exactly at its injected 30-second poll boundary", async () => {
  const { RUNS_CACHE_MS, runIndex } = await import("./run-index.js");
  const cacheProject = mkdtempSync(join(tmpdir(), "forge-fg821-cache-"));
  const at = Date.parse("2030-01-01T00:00:00.000Z");
  writeTransaction(() => insertRun("run-cache-before", "active", new Date(at - 1_000).toISOString(), cacheProject, null));

  const request = { scope: cacheProject, limit: 50 };
  const first = runIndex(request, at);
  assert.deepEqual(ids(first), ["run-cache-before"]);
  assert.equal(first.activeCount, 1);

  writeTransaction(() => insertRun("run-cache-after", "active", new Date(at).toISOString(), cacheProject, null));
  const within = runIndex(request, at + RUNS_CACHE_MS - 1);
  assert.deepEqual(ids(within), ["run-cache-before"], "a cached response remains stable for its full 30 seconds");
  assert.equal(within.activeCount, 1);

  const expired = runIndex(request, at + RUNS_CACHE_MS);
  assert.deepEqual(ids(expired), ["run-cache-after", "run-cache-before"], "the boundary triggers a fresh shared query");
  assert.equal(expired.activeCount, 2);
});
