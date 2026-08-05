// FG-679 (BD-10): launch detail and logs are addressed by launch IDENTITY.
//
// Two distinct exposures, and id-only addressing only closes the first:
//   PATH TRAVERSAL — an id is validated against the same charset `launchDir`
//     enforces BEFORE it can become a path, so `..`, a separator and an absolute
//     path are refused with a 4xx rather than resolved.
//   CONTENT — the launch log is UNBOUNDED host-command output served by a process
//     with no authentication and an env-overridable bind address. Identity
//     addressing does nothing about that; the BOUNDED TAIL is what does.
//
// And no response body may carry a host filesystem path at all.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_PORT = 18796;
const BASE = `http://127.0.0.1:${TEST_PORT}`;

const tmpHome = mkdtempSync(join(tmpdir(), "fg679-launch-id-"));
process.env.FORGE_HOME = tmpHome;
process.env.PORT = String(TEST_PORT);
process.env.HOST = "127.0.0.1";

const db = new Database(join(tmpHome, "forge.db"));
db.exec(`
  CREATE TABLE runs (id TEXT PRIMARY KEY, title TEXT, workflow TEXT, project_dir TEXT, status TEXT, created_at TEXT);
  CREATE TABLE tasks (id TEXT PRIMARY KEY, run_id TEXT, phase TEXT, agent_role TEXT, agent_model TEXT, status TEXT, started_at TEXT, created_at TEXT, parent_id TEXT);
  CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, task_id TEXT, event_type TEXT, payload TEXT, created_at TEXT);
  CREATE TABLE launch_observations (
    launch_id TEXT PRIMARY KEY, name TEXT, command TEXT NOT NULL, cwd TEXT NOT NULL, project_dir TEXT,
    association_kind TEXT NOT NULL, run_id TEXT, task_id TEXT, ticket_id TEXT, campaign_id TEXT, item_id TEXT,
    started_at TEXT NOT NULL, observed_at TEXT NOT NULL, state TEXT NOT NULL, exit_code INTEGER, signal TEXT,
    terminal INTEGER NOT NULL
  );
`);

const now = new Date();
const iso = now.toISOString();
const SECRET_CWD = "/Users/operator/private-checkouts/forge";

db.prepare(`
  INSERT INTO launch_observations (launch_id, name, command, cwd, project_dir, association_kind, run_id, started_at, observed_at, state, terminal)
  VALUES ('launch-worktree-abc123', 'worktree', ?, ?, ?, 'explicit', 'run-1', ?, ?, 'running', 0)
`).run(JSON.stringify(["npm", "run", "test:worktree"]), SECRET_CWD, SECRET_CWD, iso, iso);

// A real log file under the launch dir, larger than the tail bound.
const launchDir = join(tmpHome, "launches", "launch-worktree-abc123");
mkdirSync(launchDir, { recursive: true });
const HEAD = "SECRET-HEAD-LINE-THAT-MUST-BE-TRIMMED\n";
const BODY = "x".repeat(40 * 1024);
const TAIL = "\nFINAL-LINE\n";
writeFileSync(join(launchDir, "out.log"), HEAD + BODY + TAIL);

const { server } = await import("./server.js");

after(() => {
  server.closeAllConnections?.();
  server.close();
});

async function waitForServer(ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      await fetch(`${BASE}/`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 40));
    }
  }
  throw new Error(`Server on port ${TEST_PORT} did not start within ${ms}ms`);
}

await waitForServer();

test("FG-679 BD-10: a launch is addressable by its identity", async () => {
  const res = await fetch(`${BASE}/api/launches/launch-worktree-abc123`);
  assert.equal(res.status, 200);
  const body = await res.json() as Record<string, unknown>;
  assert.equal(body["launchId"], "launch-worktree-abc123");
  assert.equal(body["statusLabel"], "running");
  assert.equal(body["runId"], "run-1");
  assert.deepEqual(body["command"], ["npm", "run", "test:worktree"]);
});

test("FG-679 BD-10: NO host filesystem path appears in the detail response", async () => {
  const raw = await (await fetch(`${BASE}/api/launches/launch-worktree-abc123`)).text();
  assert.doesNotMatch(raw, new RegExp(SECRET_CWD.replace(/\//g, "\\/")), "the launch cwd must not be exposed");
  assert.equal(raw.includes(SECRET_CWD), false);
  assert.equal(raw.includes(tmpHome), false, "the forge home path must not be exposed");
  const body = JSON.parse(raw) as Record<string, unknown>;
  assert.equal("cwd" in body, false);
  assert.equal("logPath" in body, false);
  assert.equal("projectDir" in body, false);
  // A weaker, path-free label is what the surface carries instead.
  assert.equal(body["projectLabel"], "forge");
});

test("FG-679 BD-10: `..`, separators and absolute paths are refused with a 4xx BEFORE becoming a path", async () => {
  const hostile = [
    "..",
    "..%2F..%2Fetc%2Fpasswd",
    "%2Fetc%2Fpasswd",
    "%2E%2E%2F%2E%2E%2Fforge.db",
    "launch%2F..%2F..%2Fforge.db",
    "launch_with_underscore%00",
    "-leading-dash",
  ];
  for (const id of hostile) {
    for (const suffix of ["", "/log"]) {
      const res = await fetch(`${BASE}/api/launches/${id}${suffix}`);
      assert.ok(res.status >= 400 && res.status < 500, `${id}${suffix} -> ${res.status} (must be 4xx)`);
      const raw = await res.text();
      assert.equal(raw.includes(tmpHome), false, `${id}${suffix}: no host path may leak in the refusal`);
      assert.equal(raw.includes("/etc/passwd"), false);
    }
  }
});

test("FG-679 BD-10: a MALFORMED percent-encoding is a 4xx refusal, not a 500", async () => {
  // decodeURIComponent THROWS on these, and an uncaught throw on a serving path this
  // ticket introduces became a server error — an identity-addressed surface owes a bad
  // identity a refusal, and a bad id is a bad request whether or not it decodes.
  for (const id of ["%", "%E0%A4%A", "%zz", "launch-abc%"]) {
    for (const suffix of ["", "/log"]) {
      const res = await fetch(`${BASE}/api/launches/${id}${suffix}`);
      assert.ok(res.status >= 400 && res.status < 500, `${id}${suffix} -> ${res.status} (must be 4xx, never 5xx)`);
      const raw = await res.text();
      assert.equal(raw.includes(tmpHome), false, `${id}${suffix}: no host path may leak in the refusal`);
    }
  }
});

test("FG-679 BD-10: an unknown but well-formed id is a 404, distinct from a refused id", async () => {
  const res = await fetch(`${BASE}/api/launches/launch-does-not-exist-000000`);
  assert.equal(res.status, 404);
});

test("FG-679 BD-10: the log response is a BOUNDED TAIL, not the whole file", async () => {
  const res = await fetch(`${BASE}/api/launches/launch-worktree-abc123/log`);
  assert.equal(res.status, 200);
  const body = await res.json() as { launchId: string; text: string; bytes: number; truncated: boolean };
  assert.equal(body.launchId, "launch-worktree-abc123");
  assert.equal(body.truncated, true, "a file larger than the bound reports that it was trimmed");
  assert.ok(body.text.length <= 16 * 1024, `tail is bounded, got ${body.text.length} bytes`);
  assert.ok(body.bytes > 40 * 1024, "the true size is reported honestly even though the body is trimmed");
  assert.equal(body.text.includes("SECRET-HEAD-LINE-THAT-MUST-BE-TRIMMED"), false, "the head of an unbounded log is not served");
  assert.match(body.text, /FINAL-LINE/, "the TAIL is what an operator needs, and it is what is served");
});

test("FG-679: the log response STATES what it is — raw, unredacted host-command output", async () => {
  // The endpoint serves stdout of an arbitrary host command in the operator's own
  // environment (FG-626's reproduction is `forge launch run -- env`). There is no
  // redactor and there will not be one — docs/redaction.md is allowlist discipline and
  // a denylist scrubber would be false assurance — so the surface says so plainly and
  // bounds what it serves.
  const body = await (await fetch(`${BASE}/api/launches/launch-worktree-abc123/log`)).json() as Record<string, unknown>;
  assert.equal(body["content"], "raw");
  assert.match(String(body["notice"]), /unredacted/);
  assert.match(String(body["notice"]), /secret/i);
  assert.equal(body["maxBytes"], 16 * 1024, "the bound is declared, not left to be inferred");
  assert.equal(body["truncated"], true);
});

test("FG-679 BD-10: a launch with no log file on disk is a 404, not an empty success", async () => {
  db.prepare(`
    INSERT INTO launch_observations (launch_id, name, command, cwd, project_dir, association_kind, started_at, observed_at, state, terminal)
    VALUES ('launch-nolog-def456', 'nolog', '[]', ?, NULL, 'none', ?, ?, 'running', 0)
  `).run(SECRET_CWD, iso, iso);
  const res = await fetch(`${BASE}/api/launches/launch-nolog-def456/log`);
  assert.equal(res.status, 404);
});

test("FG-679: the surface is READ-ONLY — every mutating method is refused", async () => {
  for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
    const res = await fetch(`${BASE}/api/launches/launch-worktree-abc123`, { method });
    assert.equal(res.status, 405, `${method} must not be accepted on a read-only surface`);
  }
});
