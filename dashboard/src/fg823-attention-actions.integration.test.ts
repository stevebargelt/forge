// FG-823 — the three attention-row routes through the REAL HTTP server, with the forge CLI
// replaced by a recording binary (the fg822-task-actions precedent: a real executable that
// logs its cwd and every argument, so an extra flag or a smuggled operand is visible).
//
// What it proves: each route spawns exactly `forge attention dismiss|snooze|undismiss
// <item-key> ... --actor dashboard` from the dashboard's own directory; the CLI's refusal
// comes back with its output; every guard refuses BEFORE anything is spawned; and the
// closed table admits nothing beyond its rows.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TEST_PORT = 19001;
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const SAME_ORIGIN = BASE;
const DASHBOARD_DIR = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));

const tmpHome = mkdtempSync(join(tmpdir(), "fg823-actions-"));
process.env.FORGE_HOME = tmpHome;
process.env.FORGE_DB_PATH = join(tmpHome, "forge.db");
process.env.FORGE_PROJECT_SCAN_ROOTS = mkdtempSync(join(tmpdir(), "fg823-scan-"));
process.env.PORT = String(TEST_PORT);
process.env.HOST = "127.0.0.1";
process.env.FORGE_DASHBOARD_REMOTE = "0";
delete process.env.FORGE_DASHBOARD_ALLOW_REMOTE_MUTATIONS;
delete process.env.FORGE_DASHBOARD_ORIGIN;

const { getDb } = await import("../../src/store/db.js");
getDb();

const RIG = mkdtempSync(join(tmpdir(), "fg823-rig-"));
const CALL_LOG = join(RIG, "calls.log");
const STUB = join(RIG, "forge-stub");
writeFileSync(CALL_LOG, "");
writeFileSync(
  STUB,
  [
    "#!/bin/sh",
    `{ printf 'CALL\\t%s\\n' "$PWD"; for a in "$@"; do printf 'ARG\\t%s\\n' "$a"; done; } >> "${CALL_LOG}"`,
    'if [ -n "$STUB_FAIL" ]; then printf \'%s\\n\' "$STUB_FAIL" >&2; exit 1; fi',
    "printf 'stub ran %s %s\\n' \"$1\" \"$2\"",
    "exit 0",
  ].join("\n"),
);
chmodSync(STUB, 0o755);
process.env.FORGE_BIN = STUB;

type RecordedCall = { cwd: string; argv: string[] };

function recordedCalls(): RecordedCall[] {
  const calls: RecordedCall[] = [];
  for (const line of readFileSync(CALL_LOG, "utf8").split("\n")) {
    if (line.startsWith("CALL\t")) calls.push({ cwd: line.slice(5), argv: [] });
    else if (line.startsWith("ARG\t")) calls[calls.length - 1]?.argv.push(line.slice(4));
  }
  return calls;
}

function resetCalls(): void {
  writeFileSync(CALL_LOG, "");
}

const { server } = await import("./server.js");

after(() => {
  server.closeAllConnections?.();
  server.close();
});

{
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      await fetch(`${BASE}/api/attention-inbox`);
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

const KEY = encodeURIComponent("task:task-auth");

test("integ FG-823: dismiss spawns exactly `forge attention dismiss <key> --actor dashboard [--rationale <text>]` from the dashboard dir", async () => {
  resetCalls();
  const plain = await post(`/api/attention/${KEY}/dismiss`);
  assert.equal(plain.status, 200, JSON.stringify(plain.body));
  assert.equal(plain.body["ok"], true);
  assert.equal(plain.body["action"], "attention-dismiss");
  assert.equal(plain.body["verb"], "forge attention dismiss task:task-auth");
  assert.equal(plain.body["stdout"], "stub ran attention dismiss");
  const withWhy = await post(`/api/attention/${KEY}/dismiss`, { body: { rationale: "known, tracked in FG-9" } });
  assert.equal(withWhy.status, 200);
  assert.deepEqual(recordedCalls(), [
    { cwd: DASHBOARD_DIR, argv: ["attention", "dismiss", "task:task-auth", "--actor", "dashboard"] },
    { cwd: DASHBOARD_DIR, argv: ["attention", "dismiss", "task:task-auth", "--actor", "dashboard", "--rationale", "known, tracked in FG-9"] },
  ]);
});

test("integ FG-823: snooze passes the preset or ISO --until through; undismiss takes no body", async () => {
  resetCalls();
  for (const until of ["1h", "4h", "1d"]) {
    const res = await post(`/api/attention/${KEY}/snooze`, { body: { until } });
    assert.equal(res.status, 200, `${until}: ${JSON.stringify(res.body)}`);
  }
  const iso = new Date(Date.now() + 3 * 86_400_000).toISOString();
  assert.equal((await post(`/api/attention/${KEY}/snooze`, { body: { until: iso, rationale: "after the release" } })).status, 200);
  assert.equal((await post(`/api/attention/${KEY}/undismiss`)).status, 200);
  assert.deepEqual(recordedCalls().map((c) => c.argv), [
    ["attention", "snooze", "task:task-auth", "--until", "1h", "--actor", "dashboard"],
    ["attention", "snooze", "task:task-auth", "--until", "4h", "--actor", "dashboard"],
    ["attention", "snooze", "task:task-auth", "--until", "1d", "--actor", "dashboard"],
    ["attention", "snooze", "task:task-auth", "--until", iso, "--actor", "dashboard", "--rationale", "after the release"],
    ["attention", "undismiss", "task:task-auth", "--actor", "dashboard"],
  ]);
  for (const call of recordedCalls()) assert.equal(call.cwd, DASHBOARD_DIR);
});

test("integ FG-823: the CLI's own refusal comes back with its exit status and output", async () => {
  resetCalls();
  process.env.STUB_FAIL = "forge attention dismiss: no open attention item task:task-auth";
  try {
    const res = await post(`/api/attention/${KEY}/dismiss`);
    assert.equal(res.status, 409);
    assert.equal(res.body["ok"], false);
    assert.equal(res.body["exitCode"], 1);
    assert.match(String(res.body["error"]), /no open attention item task:task-auth/);
  } finally {
    delete process.env.STUB_FAIL;
  }
  assert.equal(recordedCalls().length, 1);
});

test("integ FG-823 guards: off-loopback, cross-origin, simple content type, bad operands and bad bodies are refused before any spawn", async () => {
  resetCalls();
  process.env.HOST = "0.0.0.0";
  try {
    const off = await post(`/api/attention/${KEY}/dismiss`);
    assert.equal(off.status, 403);
    assert.match(String(off.body["error"]), /attention actions are refused because this dashboard is bound to 0\.0\.0\.0/);
  } finally {
    process.env.HOST = "127.0.0.1";
  }
  for (const origin of ["http://evil.example", "null", "http://127.0.0.1:9999"]) {
    const res = await post(`/api/attention/${KEY}/snooze`, { headers: { Origin: origin }, body: { until: "1h" } });
    assert.equal(res.status, 403, origin);
  }
  assert.equal((await post(`/api/attention/${KEY}/undismiss`, { headers: { "Sec-Fetch-Site": "cross-site" } })).status, 403);
  for (const contentType of ["application/x-www-form-urlencoded", "text/plain", "multipart/form-data"]) {
    const res = await post(`/api/attention/${KEY}/dismiss`, { headers: { "Content-Type": contentType }, raw: "rationale=x" });
    assert.equal(res.status, 415, contentType);
  }
  for (const key of ["-rf", "--force", "%2D%2Dforce", "nocolon", encodeURIComponent("task: spaced")]) {
    assert.equal((await post(`/api/attention/${key}/dismiss`)).status, 400, key);
  }
  for (const body of [{ until: "yesterday" }, {}, { until: "1h", actor: "mallory" }, { until: "1h", rationale: "--force" }]) {
    assert.equal((await post(`/api/attention/${KEY}/snooze`, { body })).status, 400, JSON.stringify(body));
  }
  assert.equal((await post(`/api/attention/${KEY}/dismiss`, { raw: "{not json" })).status, 400);
  assert.equal((await post(`/api/attention/${KEY}/undismiss`, { body: { force: true } })).status, 400);
  const preflight = await fetch(`${BASE}/api/attention/${KEY}/dismiss`, {
    method: "OPTIONS",
    headers: { Origin: "http://evil.example", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" },
  });
  await preflight.text();
  assert.equal(preflight.status, 405);
  assert.equal(preflight.headers.get("access-control-allow-origin"), null);
  assert.deepEqual(recordedCalls(), [], "a refused request spawned a process");
});

test("integ FG-823: the closed table admits nothing beyond its rows", async () => {
  resetCalls();
  for (const path of [
    `/api/attention/${KEY}/delete`,
    `/api/attention/${KEY}/clear`,
    `/api/attention/${KEY}/resolve`,
    `/api/attention/${KEY}`,
    "/api/attention-inbox",
    "/api/attention/dismiss",
  ]) {
    assert.equal((await post(path)).status, 405, `${path} is not a route`);
  }
  const read = await fetch(`${BASE}/api/attention/${KEY}/dismiss`);
  await read.text();
  assert.notEqual(read.status, 200, "a GET never reaches a mutation");
  assert.deepEqual(recordedCalls(), []);
});
