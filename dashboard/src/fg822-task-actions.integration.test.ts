// FG-822 — the task-action routes through the REAL HTTP server, against a seeded store,
// with the forge CLI replaced by a recording binary (the fg591-queue-mutation precedent:
// a real executable that logs its cwd and every argument, so an extra flag or a smuggled
// operand is visible rather than swallowed by string joining).
//
// What it proves: the preview answers per task; each route spawns exactly its one verb
// with the fixed argv (actor recorded as dashboard, never --force); an ineligible action
// is refused by name with the policy's advice; the CLI's own non-zero exit comes back with
// its output; and every guard — off-loopback, cross-origin, simple content type, a
// leading-dash operand — refuses BEFORE anything is spawned.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RE_DRIVABLE_FAILURE_KINDS, recordedRetryDisposition, retryPolicy } from "@forge/retry-policy";
import type { FailureKind } from "../../src/v2/failure-kind.js";

const TEST_PORT = 18822;
const BASE = `http://127.0.0.1:${TEST_PORT}`;
process.env.FORGE_DASHBOARD_REMOTE = "0";
const { awaitDashboardReady } = await import("./test-support/await-dashboard-ready.js");
const SAME_ORIGIN = BASE;

const tmpHome = mkdtempSync(join(tmpdir(), "fg822-actions-"));
process.env.FORGE_HOME = tmpHome;
process.env.FORGE_DB_PATH = join(tmpHome, "forge.db");
process.env.FORGE_PROJECT_SCAN_ROOTS = mkdtempSync(join(tmpdir(), "fg822-scan-"));
process.env.PORT = String(TEST_PORT);
process.env.HOST = "127.0.0.1";
delete process.env.FORGE_DASHBOARD_ALLOW_REMOTE_MUTATIONS;
delete process.env.FORGE_DASHBOARD_ORIGIN;

const { getDb, writeTransaction } = await import("../../src/store/db.js");

const AT = "2026-09-29T09:00:00Z";
const projectDir = mkdtempSync(join(tmpdir(), "fg822-proj-"));
const canonicalProjectDir = realpathSync(projectDir);
const WORKFLOW_STEP = JSON.stringify({ dispatchSource: "workflow" });
const POLICY_KINDS: FailureKind[] = [
  "cancelled", "orphaned", "orphaned_work_may_persist", "oom_killed", "fanout_wave_orphaned", "orphaned_needs_finalize",
  "container_crash", "idle_timeout", "result_missing", "ended_turn_while_waiting", "result_malformed", "work_not_persisted", "merge_conflict", "capture_failed",
  "integration_failed", "integration_gate_timeout", "integration_gate_crashed", "publish_base_churn", "dirty_publish_target",
  "publication_refused", "lane_taken_over", "auth_missing", "auth_expired", "auth_injection_failed", "model_error", "tool_error",
  "red_blocked", "gate_rejected", "verification_environment_unavailable", "agent_reported_failure", "pre_container_crash",
  "plan_dependency_invalid", "ordered_fanout_unavailable", "integration_blocked", "prerequisite_blocked", "unknown",
];

writeTransaction(() => {
  const db = getDb();
  const run = db.prepare(`INSERT INTO runs (id, workflow, title, status, created_at, project_dir) VALUES (?,?,?,?,?,?)`);
  const task = db.prepare(`INSERT INTO tasks (id, run_id, phase, agent_role, status, task_package, created_at, started_at) VALUES (?,?,?,?,?,?,?,?)`);
  const failedEvent = db.prepare(`INSERT INTO events (run_id, task_id, event_type, payload, created_at) VALUES (?,?,?,?,?)`);
  run.run("run-822", "feature", "actions fixture", "active", AT, projectDir);
  task.run("task-gate", "run-822", "build", "engineer", "awaiting_gate", WORKFLOW_STEP, AT, AT);
  task.run("task-running", "run-822", "review", "red-wide", "running", WORKFLOW_STEP, AT, AT);
  for (const [id, kind] of [["task-crash", "container_crash"], ["task-auth", "auth_expired"], ["task-prereq", "prerequisite_blocked"], ["task-gated-out", "gate_rejected"]] as const) {
    task.run(id, "run-822", "build", "engineer", "failed", WORKFLOW_STEP, AT, AT);
    failedEvent.run("run-822", id, "task.failed", JSON.stringify({ failure_kind: kind }), AT);
  }
  task.run("task-adhoc", "run-822", "task", "engineer", "failed", JSON.stringify({ dispatchSource: "invoke" }), AT, AT);
  failedEvent.run("run-822", "task-adhoc", "task.failed", JSON.stringify({ failure_kind: "container_crash" }), AT);
  for (const kind of POLICY_KINDS) {
    const id = "policy-" + kind;
    task.run(id, "run-822", "build", "engineer", "failed", WORKFLOW_STEP, AT, AT);
    failedEvent.run("run-822", id, "task.failed", JSON.stringify({ failure_kind: kind }), AT);
  }
});

const RIG = mkdtempSync(join(tmpdir(), "fg822-rig-"));
const CALL_LOG = join(RIG, "calls.log");
const STUB = join(RIG, "forge-stub");
writeFileSync(CALL_LOG, "");
writeFileSync(
  STUB,
  [
    "#!/bin/sh",
    `{ printf 'CALL\\t%s\\n' "$PWD"; for a in "$@"; do printf 'ARG\\t%s\\n' "$a"; done; } >> "${CALL_LOG}"`,
    'if [ -n "$STUB_HOLD" ]; then while [ ! -e "$STUB_HOLD" ]; do sleep 0.02; done; fi',
    'if [ -n "$STUB_FAIL" ]; then printf \'%s\\n\' "$STUB_FAIL" >&2; exit 1; fi',
    "printf 'stub ran %s\\n' \"$1\"",
    "exit 0",
  ].join("\n"),
);
chmodSync(STUB, 0o755);
process.env.FORGE_BIN = STUB;

type RecordedCall = { cwd: string; argv: string[] };
const everyCall: RecordedCall[] = [];

function recordedCalls(): RecordedCall[] {
  const calls: RecordedCall[] = [];
  for (const line of readFileSync(CALL_LOG, "utf8").split("\n")) {
    if (line.startsWith("CALL\t")) calls.push({ cwd: line.slice(5), argv: [] });
    else if (line.startsWith("ARG\t")) calls[calls.length - 1]?.argv.push(line.slice(4));
  }
  return calls;
}

function resetCalls(): void {
  everyCall.push(...recordedCalls());
  writeFileSync(CALL_LOG, "");
}

const { server } = await import("./server.js");
await awaitDashboardReady(BASE, { timeoutMs: 4000 });

after(() => {
  server.closeAllConnections?.();
  server.close();
});

{
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      await fetch(`${BASE}/api/task/task-gate/actions`);
      break;
    } catch {
      if (Date.now() > deadline) throw new Error(`server on ${TEST_PORT} did not start`);
      await new Promise((r) => setTimeout(r, 40));
    }
  }
}

type PostOptions = { headers?: Record<string, string>; body?: unknown; raw?: string };

async function post(path: string, options: PostOptions = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: SAME_ORIGIN, ...options.headers },
    body: options.raw ?? JSON.stringify(options.body ?? {}),
  });
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    parsed = { raw: text };
  }
  return { status: res.status, body: parsed };
}

async function preview(taskId: string): Promise<{ status: number; body: Record<string, any> }> {
  const res = await fetch(`${BASE}/api/task/${taskId}/actions`);
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

test("integ FG-822: GET /api/task/:id/actions previews eligible actions with verb + argv, and refused ones with advice", async () => {
  const gate = await preview("task-gate");
  assert.equal(gate.status, 200);
  assert.deepEqual(gate.body["mutations"], { available: true, reason: null });
  assert.deepEqual(gate.body["eligible"].map((e: any) => e.verb), [
    "forge gate task-gate advance", "forge gate task-gate reject", "forge gate task-gate request-changes",
  ]);
  assert.deepEqual(gate.body["eligible"][0].argv, ["gate", "task-gate", "advance", "--rationale", "<rationale>", "--decided-by", "dashboard"]);

  const crash = await preview("task-crash");
  assert.deepEqual(crash.body["eligible"].map((e: any) => [e.action, e.verb]), [["retry", "forge retry task-crash"]]);
  assert.equal(crash.body["failureKind"], "container_crash");

  const auth = await preview("task-auth");
  assert.deepEqual(auth.body["eligible"], []);
  const authRetry = auth.body["refused"].find((r: any) => r.action === "retry");
  assert.match(authRetry.advice, /refresh the session\/profile before retrying/);

  const prereq = await preview("task-prereq");
  assert.deepEqual(prereq.body["eligible"].map((e: any) => e.verb), ["forge recover task-prereq --re-drive"]);
  assert.match(prereq.body["refused"].find((r: any) => r.action === "retry").advice, /forge recover task-prereq --re-drive/,
    "the retry refusal names the advice with this task's id");

  const adhoc = await preview("task-adhoc");
  assert.deepEqual(adhoc.body["eligible"], [], "an ad-hoc retry runs its container in the forge process — not offered");

  assert.equal((await preview("task-running")).body["eligible"].length, 0);
  assert.equal((await preview("no-such-task")).status, 404);
  assert.equal((await preview("-rf")).status, 400);
  assert.equal((await preview("%2D%2Dforce")).status, 400);
});

test("integ FG-822: a gate decision spawns exactly `forge gate <id> <decision> --rationale <text> --decided-by dashboard` in the run's checkout", async () => {
  resetCalls();
  const res = await post("/api/task/task-gate/gate", { body: { decision: "request-changes", rationale: "Tighten the test first." } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body["ok"], true);
  assert.equal(res.body["exitCode"], 0);
  assert.equal(res.body["verb"], "forge gate task-gate request-changes");
  assert.equal(res.body["stdout"], "stub ran gate");
  assert.deepEqual(recordedCalls(), [{
    cwd: canonicalProjectDir,
    argv: ["gate", "task-gate", "request-changes", "--rationale", "Tighten the test first.", "--decided-by", "dashboard"],
  }]);
});

test("integ FG-822: the gate refuses without a rationale, for every decision, and spawns nothing", async () => {
  resetCalls();
  for (const decision of ["advance", "reject", "request-changes"]) {
    for (const body of [{ decision }, { decision, rationale: "" }, { decision, rationale: "  \n " }]) {
      const res = await post("/api/task/task-gate/gate", { body });
      assert.equal(res.status, 400, `${decision} ${JSON.stringify(body)}`);
      assert.match(String(res.body["error"]), /rationale is required/);
    }
  }
  assert.deepEqual(recordedCalls(), []);
});

test("integ FG-822: retry and re-drive spawn their one verb when the policy admits them", async () => {
  resetCalls();
  const retry = await post("/api/task/task-crash/retry");
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  const reDrive = await post("/api/task/task-prereq/recover-re-drive");
  assert.equal(reDrive.status, 200, JSON.stringify(reDrive.body));
  assert.deepEqual(recordedCalls().map((c) => c.argv), [["retry", "task-crash"], ["recover", "task-prereq", "--re-drive"]]);
});

test("integ FG-822: an ineligible action is refused BY NAME with the policy's advice, and nothing is spawned", async () => {
  resetCalls();
  const auth = await post("/api/task/task-auth/retry");
  assert.equal(auth.status, 409);
  assert.match(String(auth.body["error"]), /auth_expired needs a human precondition.*refresh the session/);
  const rejected = await post("/api/task/task-gated-out/retry");
  assert.equal(rejected.status, 409);
  assert.match(String(rejected.body["error"]), /gate_rejected is not retryable.*request-changes/);
  const crashReDrive = await post("/api/task/task-crash/recover-re-drive");
  assert.equal(crashReDrive.status, 409);
  assert.match(String(crashReDrive.body["error"]), /container_crash is not a failure kind the re-drive accepts/);
  const runningGate = await post("/api/task/task-running/gate", { body: { decision: "advance", rationale: "ok" } });
  assert.equal(runningGate.status, 409);
  assert.match(String(runningGate.body["error"]), /the task is running/);
  const adhoc = await post("/api/task/task-adhoc/retry");
  assert.equal(adhoc.status, 409);
  assert.equal((await post("/api/task/no-such-task/retry")).status, 404);
  assert.deepEqual(recordedCalls(), []);
});

test("integ FG-822: the CLI's own refusal comes back with its exit status and output", async () => {
  resetCalls();
  process.env.STUB_FAIL = "Task task-gate is blocked_by_red. Re-run with --force";
  try {
    const res = await post("/api/task/task-gate/gate", { body: { decision: "advance", rationale: "ship it" } });
    assert.equal(res.status, 409);
    assert.equal(res.body["ok"], false);
    assert.equal(res.body["exitCode"], 1);
    assert.equal(res.body["verb"], "forge gate task-gate advance");
    assert.match(String(res.body["stderr"]), /blocked_by_red/);
  } finally {
    delete process.env.STUB_FAIL;
  }
  assert.equal(recordedCalls().length, 1);
});

test("integ FG-822 guards: off-loopback, cross-origin, simple content type and leading-dash operands are refused before any spawn", async () => {
  resetCalls();
  // The bind guard reads HOST at request time — the same predicate a non-loopback bind hits.
  process.env.HOST = "0.0.0.0";
  try {
    const off = await post("/api/task/task-crash/retry");
    assert.equal(off.status, 403);
    assert.match(String(off.body["error"]), /task actions are refused because this dashboard is bound to 0\.0\.0\.0/);
    const offPreview = await preview("task-crash");
    assert.equal(offPreview.body["mutations"].available, false, "the preview says the buttons would be refused");
  } finally {
    process.env.HOST = "127.0.0.1";
  }
  for (const origin of ["http://evil.example", "null", "http://127.0.0.1:9999"]) {
    const res = await post("/api/task/task-crash/retry", { headers: { Origin: origin } });
    assert.equal(res.status, 403, origin);
    assert.match(String(res.body["error"]), /cross-origin/);
  }
  const site = await post("/api/task/task-crash/retry", { headers: { "Sec-Fetch-Site": "cross-site" } });
  assert.equal(site.status, 403);
  for (const contentType of ["application/x-www-form-urlencoded", "text/plain", "multipart/form-data"]) {
    const res = await post("/api/task/task-gate/gate", { headers: { "Content-Type": contentType }, raw: "decision=advance&rationale=x" });
    assert.equal(res.status, 415, contentType);
  }
  for (const id of ["-rf", "--force", "%2D%2Dforce"]) {
    const res = await post(`/api/task/${id}/retry`);
    assert.equal(res.status, 400, id);
    assert.match(String(res.body["error"]), /must not begin with "-"/);
  }
  const flagRationale = await post("/api/task/task-gate/gate", { body: { decision: "advance", rationale: "--force" } });
  assert.equal(flagRationale.status, 400);
  const forceBody = await post("/api/task/task-crash/retry", { body: { force: true } });
  assert.equal(forceBody.status, 400);
  assert.match(String(forceBody.body["error"]), /never passes --force/);
  const preflight = await fetch(`${BASE}/api/task/task-crash/retry`, {
    method: "OPTIONS",
    headers: { Origin: "http://evil.example", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" },
  });
  await preflight.text();
  assert.equal(preflight.status, 405);
  assert.equal(preflight.headers.get("access-control-allow-origin"), null);
  for (const path of ["/api/task/task-crash/cancel", "/api/task/task-crash/next", "/api/task/task-crash/force-retry"]) {
    assert.equal((await post(path)).status, 405, `${path} is not a route`);
  }
  assert.deepEqual(recordedCalls(), [], "a refused request spawned a process");
});

test("integ FG-822: across every call this suite made, no argv carried --force and every verb was registered", () => {
  resetCalls();
  assert.ok(everyCall.length >= 4, "the suite spawned real calls");
  for (const call of everyCall) {
    assert.ok(!call.argv.includes("--force"), `--force in ${call.argv.join(" ")}`);
    assert.ok(["gate", "retry", "recover"].includes(call.argv[0]!), call.argv.join(" "));
  }
});

test("integ FG-822: every POLICY and re-drive row makes the same accept/refuse decision through HTTP, including exact policy advice", async () => {
  resetCalls();
  for (const kind of POLICY_KINDS) {
    const taskId = "policy-" + kind;
    const policy = recordedRetryDisposition(kind);
    assert.ok(policy, kind + " must be a recorded policy row");
    const retry = await post("/api/task/" + taskId + "/retry");
    const retryAllowed = policy.retryable && policy.advice === undefined;
    assert.equal(retry.status, retryAllowed ? 200 : 409, "retry " + kind);
    if (retryAllowed) {
      assert.equal(retry.body["ok"], true, kind);
    } else {
      assert.match(String(retry.body["error"]), new RegExp(kind + " "));
      if (policy.advice) {
        assert.ok(String(retry.body["error"]).includes(retryPolicy(kind, taskId).advice!), kind + " advice must be verbatim");
      }
    }

    const reDrive = await post("/api/task/" + taskId + "/recover-re-drive");
    assert.equal(reDrive.status, RE_DRIVABLE_FAILURE_KINDS[kind] ? 200 : 409, "re-drive " + kind);
    if (!RE_DRIVABLE_FAILURE_KINDS[kind]) {
      assert.match(String(reDrive.body["error"]), new RegExp(kind + " is not a failure kind the re-drive accepts"));
    }
  }
  for (const call of recordedCalls()) {
    assert.ok(!call.argv.includes("--force"), call.argv.join(" "));
    if (call.argv[0] === "recover") assert.deepEqual(call.argv.slice(2), ["--re-drive"]);
  }
});

test("integ FG-822: unregistered action-shaped paths and operands cannot alter the single spawned argv", async () => {
  resetCalls();
  for (const path of ["/api/task/task-crash/cancel", "/api/task/task-crash/arm", "/api/task/task-crash/next"]) {
    const response = await post(path);
    assert.ok(response.status === 404 || response.status === 405, path);
  }
  assert.equal((await post("/api/task/task-gate/gate", { body: { decision: "force", rationale: "no" } })).status, 400);
  assert.equal((await post("/api/task/task-running/gate", { body: { decision: "advance", rationale: "no" } })).status, 409);
  assert.equal((await post("/api/task/task-crash/retry", { body: { force: true, id: "other", operand: "--force" } })).status, 400);
  assert.equal((await post("/api/task/task-gate/gate", { body: { decision: "reject", rationale: "Recorded human decision." } })).status, 200);
  assert.deepEqual(recordedCalls(), [{
    cwd: canonicalProjectDir,
    argv: ["gate", "task-gate", "reject", "--rationale", "Recorded human decision.", "--decided-by", "dashboard"],
  }]);
});

test("integ FG-822: a project classification takes the same global mutation slot — refused by name while action mutations hold every slot, unchanged argv once they free", async () => {
  const { MAX_CONCURRENT_MUTATIONS } = await import("./mutation-guards.js");
  resetCalls();
  const release = join(RIG, "release-slots");
  process.env.STUB_HOLD = release;
  const held: Array<Promise<{ status: number; body: Record<string, unknown> }>> = [];
  try {
    for (let i = 0; i < MAX_CONCURRENT_MUTATIONS; i += 1) {
      held.push(post("/api/task/task-gate/gate", { body: { decision: "advance", rationale: `hold ${i}` } }));
    }
    const deadline = Date.now() + 10_000;
    while (recordedCalls().length < MAX_CONCURRENT_MUTATIONS) {
      if (Date.now() > deadline) throw new Error("the held action mutations never spawned");
      await new Promise((r) => setTimeout(r, 20));
    }

    const refused = await post("/api/projects/classify", { body: { dir: "/tmp/fg822-classify", purpose: "operator" } });
    assert.equal(refused.status, 503, JSON.stringify(refused.body));
    assert.equal(refused.body["ok"], false);
    assert.match(String(refused.body["error"]), new RegExp(`too many dashboard mutations in flight \\(${MAX_CONCURRENT_MUTATIONS}\\)`));
    assert.equal(recordedCalls().length, MAX_CONCURRENT_MUTATIONS, "the refused classification spawned nothing");
  } finally {
    delete process.env.STUB_HOLD;
    writeFileSync(release, "");
  }
  for (const response of await Promise.all(held)) assert.equal(response.status, 200, JSON.stringify(response.body));

  resetCalls();
  const admitted = await post("/api/projects/classify", { body: { dir: "/tmp/fg822-classify", purpose: "operator", run: "run-822" } });
  assert.equal(admitted.status, 200, JSON.stringify(admitted.body));
  assert.deepEqual(recordedCalls().map((call) => call.argv), [
    ["projects", "classify", "/tmp/fg822-classify", "--purpose", "operator", "--actor", "dashboard", "--json", "--run", "run-822"],
  ]);
});
