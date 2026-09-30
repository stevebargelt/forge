// FG-823 — `forge attention dismiss|snooze|undismiss` end to end, with the REAL co-located
// bin/forge against a seeded store: each verb writes its attention_dismissals row and its
// attention.* event; `list --include-dismissed` shows the held items; `list --json` and
// GET /api/attention-inbox stay deep-equal (dismissed section included) while items are
// held; new activity resurfaces a dismissed item and the next write marks the old row
// superseded; an expired snooze is marked expired; and the dashboard route, driving the
// same real CLI, records actor `dashboard` and drops the item from the next GET.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fixtureFetch } from "./test-support/fixture-fetch.js";
import { awaitDashboardReady } from "./test-support/await-dashboard-ready.js";

// The default remains unique in the tier; an explicit override lets the FG-841 stress
// loop run beside one full integration tier without competing with that tier's fixture.
const TEST_PORT = Number(process.env.FG823_TEST_PORT ?? "18829");
const BASE = `http://127.0.0.1:${TEST_PORT}`;

const tmpHome = mkdtempSync(join(tmpdir(), "fg823-cli-"));
process.env.FORGE_HOME = tmpHome;
process.env.FORGE_DB_PATH = join(tmpHome, "forge.db");
process.env.FORGE_PROJECT_SCAN_ROOTS = mkdtempSync(join(tmpdir(), "fg823-cli-scan-"));
process.env.PORT = String(TEST_PORT);
process.env.HOST = "127.0.0.1";
process.env.FORGE_DASHBOARD_REMOTE = "0";
delete process.env.FORGE_BIN;
delete process.env.FORGE_DASHBOARD_ALLOW_REMOTE_MUTATIONS;
delete process.env.FORGE_DASHBOARD_ORIGIN;

const { getDb, writeTransaction } = await import("../../src/store/db.js");

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");
const OLDER = "2026-09-19T09:00:00Z";
const projectDir = mkdtempSync(join(tmpdir(), "fg823-cli-proj-"));

writeTransaction(() => {
  const db = getDb();
  const run = db.prepare(`INSERT INTO runs (id, workflow, title, status, created_at, project_dir) VALUES (?,?,?,?,?,?)`);
  const task = db.prepare(`INSERT INTO tasks (id, run_id, phase, agent_role, status, task_package, created_at, started_at) VALUES (?,?,?,?,?,?,?,?)`);
  const event = db.prepare(`INSERT INTO events (run_id, task_id, event_type, payload, created_at) VALUES (?,?,?,?,?)`);
  run.run("run-auth", "feature", "auth run", "active", OLDER, projectDir);
  task.run("task-auth", "run-auth", "build", "engineer", "failed", "{}", OLDER, OLDER);
  event.run("run-auth", "task-auth", "task.failed", JSON.stringify({ failure_kind: "auth_missing" }), OLDER);
  run.run("run-merge", "feature", "merge run", "active", OLDER, projectDir);
  task.run("task-merge", "run-merge", "build", "engineer", "failed", "{}", OLDER, OLDER);
  event.run("run-merge", "task-merge", "task.failed", JSON.stringify({ failure_kind: "merge_conflict" }), OLDER);
});

const { server } = await import("./server.js");
after(() => {
  server.closeAllConnections?.();
  server.close();
});

await awaitDashboardReady(BASE, { timeoutMs: 4000 });

async function route(): Promise<Record<string, any>> {
  const deadline = Date.now() + 4000;
  for (;;) {
    try {
      return (await (await fixtureFetch(`${BASE}/api/attention-inbox`)).json()) as Record<string, any>;
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await new Promise((r) => setTimeout(r, 40));
    }
  }
}

function forge(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const child = spawnSync("sh", [join(REPO_ROOT, "bin", "forge"), "attention", ...args], {
    cwd: projectDir,
    env: { ...process.env, FORGE_HOME: tmpHome, USER: "tester" },
    encoding: "utf8",
  });
  return { status: child.status, stdout: child.stdout, stderr: child.stderr };
}

function listJson(): Record<string, any> {
  return JSON.parse(execFileSync("sh", [join(REPO_ROOT, "bin", "forge"), "attention", "list", "--json"], {
    cwd: projectDir,
    env: { ...process.env, FORGE_HOME: tmpHome },
    encoding: "utf8",
  })) as Record<string, any>;
}

function rows(): Array<Record<string, any>> {
  return getDb().prepare(`SELECT item_key, kind, run_id, actor, rationale, state, snooze_until, settled_at FROM attention_dismissals ORDER BY created_at, rowid`).all() as Array<Record<string, any>>;
}

function attentionEvents(): Array<{ event_type: string; run_id: string | null; payload: Record<string, any> }> {
  return (getDb().prepare(`SELECT event_type, run_id, payload FROM events WHERE event_type LIKE 'attention.%' ORDER BY id`).all() as Array<{ event_type: string; run_id: string | null; payload: string }>)
    .map((e) => ({ ...e, payload: JSON.parse(e.payload) as Record<string, any> }));
}

function withoutClock(envelope: Record<string, any>): Record<string, any> {
  const { generatedAt: _clock, ...rest } = envelope;
  return rest;
}

test("integ FG-823: dismiss writes the row and an attention.dismissed event; list excludes it and counts drop", async () => {
  const before = await route();
  assert.deepEqual(before["counts"], { open: 2, high: 2 });

  const out = forge(["dismiss", "task:task-auth", "--rationale", "rotating the key tomorrow"]);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /dismissed task:task-auth \(auth_setup\)/);
  assert.deepEqual(rows(), [{
    item_key: "task:task-auth", kind: "auth_setup", run_id: "run-auth", actor: "tester",
    rationale: "rotating the key tomorrow", state: "active", snooze_until: null, settled_at: null,
  }]);
  const [event] = attentionEvents();
  assert.equal(event!.event_type, "attention.dismissed");
  assert.equal(event!.run_id, "run-auth");
  assert.equal(event!.payload["actor"], "tester");
  assert.equal(event!.payload["itemKey"], "task:task-auth");

  const after = await route();
  assert.deepEqual(after["items"].map((i: any) => i.id), ["task:task-merge"]);
  assert.deepEqual(after["counts"], { open: 1, high: 1 });
  assert.deepEqual(after["dismissed"].map((d: any) => [d.item.id, d.dismissal.state, d.dismissal.actor, d.dismissal.rationale]), [
    ["task:task-auth", "dismissed", "tester", "rotating the key tomorrow"],
  ]);
});

test("integ FG-823: list --json and GET /api/attention-inbox are deep-equal while an item is held, dismissed section included", async () => {
  const fromCli = listJson();
  const fromRoute = await route();
  assert.equal(fromCli["dismissed"].length, 1, "a vacuous parity: nothing is held");
  assert.deepEqual(withoutClock(fromCli), withoutClock(fromRoute));
});

test("integ FG-823: --include-dismissed lists the held item; without it the footer only counts it", () => {
  const plain = forge(["list"]);
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(plain.stdout.trimEnd().split("\n").at(-1), "1 open · 1 high · 1 dismissed (--include-dismissed to list)");
  assert.ok(!plain.stdout.includes("task:task-auth"));
  const listed = forge(["list", "--include-dismissed"]);
  assert.match(listed.stdout, /Dismissed \(1\):\ntask:task-auth +auth_setup +dismissed \S+ +by tester +rotating the key tomorrow/);
});

test("integ FG-823: a second dismissal of a held item is refused and writes nothing", () => {
  const out = forge(["snooze", "task:task-auth", "--until", "1h"]);
  assert.equal(out.status, 1);
  assert.match(out.stderr, /task:task-auth is already dismissed; run `forge attention undismiss task:task-auth` first/);
  assert.equal(rows().length, 1);
  assert.equal(forge(["dismiss", "task:no-such"]).status, 1);
  assert.match(forge(["dismiss", "--", "-rf"]).stderr, /not an attention item key/);
  assert.equal(attentionEvents().length, 1);
});

test("integ FG-823: new activity resurfaces the item; the next write marks the old row superseded (kept) and snoozes afresh", async () => {
  await new Promise((r) => setTimeout(r, 5));
  getDb().prepare(`UPDATE tasks SET started_at = ? WHERE id = 'task-auth'`).run(new Date().toISOString());
  const back = await route();
  assert.deepEqual(back["items"].map((i: any) => i.id).sort(), ["task:task-auth", "task:task-merge"]);
  assert.deepEqual(back["dismissed"], []);

  const out = forge(["snooze", "task:task-auth", "--until", "4h", "--rationale", "after the rotation"]);
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(rows().map((r) => [r.state, r.snooze_until === null]), [["superseded", true], ["active", false]]);
  assert.deepEqual(attentionEvents().map((e) => e.event_type), ["attention.dismissed", "attention.dismissal_superseded", "attention.snoozed"]);
  const snoozed = attentionEvents().at(-1)!;
  assert.deepEqual([snoozed.payload["actor"], snoozed.payload["itemKey"]], ["tester", "task:task-auth"]);
  const held = await route();
  assert.deepEqual(held["dismissed"].map((d: any) => [d.item.id, d.dismissal.state]), [["task:task-auth", "snoozed"]]);
});

test("integ FG-823: a snooze whose instant passed returns the item and is marked expired on the next write", async () => {
  getDb().prepare(`UPDATE attention_dismissals SET snooze_until = ? WHERE state = 'active'`).run(new Date(Date.now() - 1000).toISOString());
  const back = await route();
  assert.ok(back["items"].some((i: any) => i.id === "task:task-auth"), "an expired snooze no longer holds");
  const out = forge(["dismiss", "task:task-auth"]);
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(rows().map((r) => r.state), ["superseded", "expired", "active"]);
  assert.equal(attentionEvents().at(-2)!.event_type, "attention.snooze_expired");
});

test("integ FG-823: undismiss clears the row (kept) with an attention.undismissed event; a second undismiss is refused", async () => {
  const out = forge(["undismiss", "task:task-auth"]);
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(rows().map((r) => r.state), ["superseded", "expired", "cleared"]);
  const last = attentionEvents().at(-1)!;
  assert.equal(last.event_type, "attention.undismissed");
  assert.equal(last.payload["clearedBy"], "tester");
  assert.equal(last.payload["itemKey"], "task:task-auth");
  assert.ok((await route())["items"].some((i: any) => i.id === "task:task-auth"));
  const again = forge(["undismiss", "task:task-auth"]);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /has no active dismissal or snooze/);
});

test("integ FG-823: the dashboard route drives the SAME real CLI — actor dashboard, and the next GET excludes the item", async () => {
  const res = await fixtureFetch(`${BASE}/api/attention/${encodeURIComponent("task:task-merge")}/snooze`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: BASE },
    body: JSON.stringify({ until: "1d", rationale: "rebasing after lunch" }),
  });
  const body = (await res.json()) as Record<string, any>;
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body["exitCode"], 0);
  const row = rows().at(-1)!;
  assert.deepEqual([row.item_key, row.actor, row.state, row.rationale], ["task:task-merge", "dashboard", "active", "rebasing after lunch"]);
  assert.equal(attentionEvents().at(-1)!.payload["actor"], "dashboard");
  const next = await route();
  assert.ok(!next["items"].some((i: any) => i.id === "task:task-merge"));
  assert.deepEqual(next["counts"], { open: 1, high: 1 });
  assert.deepEqual(withoutClock(listJson()), withoutClock(await route()));
  assert.equal((getDb().prepare(`SELECT COUNT(*) AS c FROM attention_dismissals`).get() as { c: number }).c, 4, "no row was ever deleted");
});
