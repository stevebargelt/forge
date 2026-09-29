// FG-817: GET /api/roles and GET /api/roles/:role end to end against a scratch
// FORGE_HOME carrying a small published seed generation — two installed roles, one of
// them missing its settings.json — the real compiled routing policy, a model policy,
// and a seeded store. Both GETs are reads: no POST exists, and serving them executes no
// subprocess and makes no outbound call (invariant 21).

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TEST_PORT = 18817;
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const home = mkdtempSync(join(tmpdir(), "forge-fg817-"));
process.env.FORGE_HOME = home;
process.env.PORT = String(TEST_PORT);
process.env.HOST = "127.0.0.1";
// The resolved auth for an `auth: subscription` profile is fixed; keep ambient creds out anyway.
delete process.env.ANTHROPIC_API_KEY;
delete process.env.AWS_PROFILE;
process.env.CLAUDE_CODE_USE_BEDROCK = "0";

const { publishTestGeneration } = await import("../../src/v2/seed-generation.testkit.js");
const { getDb, writeTransaction } = await import("../../src/store/db.js");

const RED_WORKFLOW = `name: tiny
description: a one-step workflow with a red
steps:
  - id: build
    agent: engineer
    gate: auto
    reds:
      - agent: red-wide
`;
const gen = publishTestGeneration(home, {
  assetsParent: home,
  raciPath: join(REPO_ROOT, "seeds", "forge-raci.md"),
  runtimes: { "claude-oauth": readFileSync(join(REPO_ROOT, "seeds", "runtimes", "claude-oauth.yml"), "utf8") },
  workflows: { tiny: RED_WORKFLOW },
});
const GEN_ID = basename(gen.root);

cpSync(join(REPO_ROOT, "seeds", "model-policy.example.yml"), join(home, "model-policy.yml"));
mkdirSync(join(home, "agents", "engineer"), { recursive: true });
writeFileSync(join(home, "agents", "engineer", "CLAUDE.md"), "# engineer\n\nYou implement the plan, one step at a time.\n\n## More\n\ndetail\n");
writeFileSync(join(home, "agents", "engineer", "settings.json"), JSON.stringify({ tools: ["read", "edit", "bash"], notes: "rw" }));
// red-wide: installed from a generation that carried no settings.json for it.
mkdirSync(join(home, "agents", "red-wide"), { recursive: true });
writeFileSync(join(home, "agents", "red-wide", "CLAUDE.md"), "# red-wide\n\nYou audit with default disbelief.\n");
mkdirSync(join(home, "agents", "not-a-role"), { recursive: true }); // no CLAUDE.md: not a seed
mkdirSync(join(home, "constraints"), { recursive: true });
writeFileSync(join(home, "constraints", "be-terse.md"), "---\nid: be-terse\nlevel: suggest\nroles: [engineer]\n---\n\nBe terse.\n");
mkdirSync(join(home, "pre-upgrade-backup", "2026-09-01T00-00-00Z", "agents", "engineer"), { recursive: true });
writeFileSync(join(home, "pre-upgrade-backup", "2026-09-01T00-00-00Z", "agents", "engineer", "CLAUDE.md"), "# engineer (edited)\n");

const HOUR = 3_600_000;
const ago = (hours: number) => new Date(Date.now() - hours * HOUR).toISOString();
const PROJECT = mkdtempSync(join(tmpdir(), "forge-fg817-proj-"));
// The project's addendum: composed in only when the role read is anchored at the project.
mkdirSync(join(PROJECT, ".forge", "agents", "engineer"), { recursive: true });
writeFileSync(join(PROJECT, ".forge", "agents", "engineer", "CLAUDE.md"), "Run pnpm, never npm, in this repo.\n");
const E3_AT = ago(2);
const protocolSource = join(gen.root, "agent-protocols", "engineer.md");
const protocolSha = gen.manifest.files["agent-protocols/engineer.md"]!;

writeTransaction(() => {
  const db = getDb();
  db.prepare(`INSERT INTO runs (id, workflow, title, status, created_at, project_dir) VALUES (?,?,?,?,?,?)`).run("run-1", "tiny", "Build it", "complete", ago(10), PROJECT);
  const task = db.prepare(
    `INSERT INTO tasks (id, run_id, phase, agent_role, status, task_package, created_at, started_at, completed_at) VALUES (?,?,?,?,?,?,?,?,?)`,
  );
  task.run("task-e1", "run-1", "build", "engineer", "complete", "{}", ago(9), ago(9), new Date(Date.now() - 9 * HOUR + 60_000).toISOString());
  task.run("task-e2", "run-1", "build", "engineer", "failed", "{}", ago(5), ago(5), new Date(Date.now() - 5 * HOUR + 180_000).toISOString());
  task.run("task-e3", "run-1", "build", "engineer", "complete", "{}", E3_AT, ago(2), new Date(Date.now() - 2 * HOUR + 120_000).toISOString());
  task.run("task-r1", "run-1", "build", "red-wide", "complete", "{}", ago(8), null, null);
  const call = db.prepare(
    `INSERT INTO model_calls (task_id, request_id, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, created_at) VALUES (?,?,?,?,?,?,?,?)`,
  );
  call.run("task-e1", "req-1", "claude-sonnet-5", 100, 10, 5, 1, ago(9));
  call.run("task-e3", "req-2", "claude-sonnet-5", 200, 20, 0, 0, ago(2));
  call.run("task-r1", "req-3", "claude-opus-5-5", 999, 99, 0, 0, ago(8));
});
for (const [taskId, withProtocol] of [["task-e3", true], ["task-e1", false]] as const) {
  const dir = join(home, "runs", "run-1", taskId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({
    taskId, runId: "run-1",
    controlPlane: { mountMode: "rw" },
    ...(withProtocol ? { agentProtocol: { role: "engineer", sha256: protocolSha, source: protocolSource } } : {}),
  }));
}

// Invariant 21: executable shims first on PATH record any subprocess the serving path
// runs, and fetch is wrapped to record any outbound call.
const RIG = mkdtempSync(join(tmpdir(), "fg817-guard-"));
const CALL_LOG = join(RIG, "calls.log");
writeFileSync(CALL_LOG, "");
mkdirSync(join(RIG, "bin"));
for (const bin of ["docker", "git", "gh", "tmux", "forge", "forge-dev", "aws"]) {
  writeFileSync(join(RIG, "bin", bin), `#!/bin/sh\necho "${bin} $*" >> "${CALL_LOG}"\nexit 0\n`);
  chmodSync(join(RIG, "bin", bin), 0o755);
}
process.env.PATH = `${join(RIG, "bin")}:${process.env.PATH ?? ""}`;
const realFetch = globalThis.fetch;
const outbound: string[] = [];
globalThis.fetch = ((input: Parameters<typeof realFetch>[0], init?: Parameters<typeof realFetch>[1]) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
  if (!url.startsWith(BASE)) outbound.push(url);
  return realFetch(input, init);
}) as typeof realFetch;

const { server } = await import("./server.js");
after(() => {
  globalThis.fetch = realFetch;
  server.closeAllConnections?.();
  server.close();
});

async function get(path: string, method = "GET"): Promise<{ status: number; body: any }> {
  const deadline = Date.now() + 4000;
  for (;;) {
    try {
      const res = await fetch(`${BASE}${path}`, { method });
      return { status: res.status, body: await res.json() };
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await new Promise((r) => setTimeout(r, 40));
    }
  }
}

test("GET /api/roles lists every installed seed with activity, resolved profile/effort, mount mode and last task", async () => {
  const { status, body } = await get("/api/roles");
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.generation.id, GEN_ID);
  assert.equal(body.seedInstall.kind, "healthy");
  assert.equal(body.modelPolicy.source, "host");
  assert.deepEqual(body.roles.map((r: any) => r.role), ["engineer", "red-wide"], "a directory without CLAUDE.md is not a seed");
  const [engineer, red] = body.roles;
  assert.equal(engineer.description, "You implement the plan, one step at a time.");
  assert.deepEqual(
    [engineer.defaultActivity, engineer.profile, engineer.model, engineer.effort, engineer.mountMode, engineer.settings],
    ["default", "claude-subscription", "claude-sonnet-5", null, "rw", true],
  );
  assert.equal(engineer.lastTaskAt, E3_AT);
  assert.equal(engineer.protocolSha, protocolSha);
  assert.deepEqual(
    [red.defaultActivity, red.profile, red.model, red.effort, red.mountMode, red.settings],
    ["review", "claude-subscription", "claude-opus-5-5", "low", "ro", false],
  );
  assert.match(red.mountModeSource, /red in a seed-generation workflow/);
});

test("GET /api/roles/engineer: overview from the seed, model policy, compiled routing policy and the store", async () => {
  const { status, body } = await get("/api/roles/engineer");
  assert.equal(status, 200, JSON.stringify(body));
  const o = body.overview;
  assert.equal(o.description, "You implement the plan, one step at a time.");
  assert.deepEqual([o.resolution.activity, o.resolution.profile, o.resolution.resolvedBy, o.resolution.runtime], ["default", "claude-subscription", "defaults.profile", "claude-oauth"]);
  assert.equal(o.mountMode.mode, "rw");
  assert.equal(o.routes, undefined, "FG-827: routes moved to Capabilities");
  const c = body.capabilities;
  assert.equal(c.routingPolicy.available, true);
  assert.ok(c.routes.length > 0, "the shipped RACI names the engineer");
  assert.ok(c.routes.some((r: any) => r.relations.includes("responsible")));
  for (const r of c.routes) assert.ok(r.relations.every((rel: string) => ["responsible", "consulted", "followup"].includes(rel)));
  assert.deepEqual(o.recentTasks.map((t: any) => t.taskId), ["task-e3", "task-e2", "task-e1"]);
  assert.deepEqual([o.ops.terminal, o.ops.complete, o.ops.failed, o.ops.medianMs], [3, 2, 1, 120_000]);
  assert.equal(o.ops.successRate, 2 / 3);
  assert.equal(o.usage.inputTokens, 300);
  assert.equal(o.protocolSha, protocolSha);
  assert.equal(body.generation.id, GEN_ID);
  for (const tab of ["overview", "instructions", "harness", "skills", "capabilities", "tools", "secrets", "tasks", "receipts", "usage"]) {
    assert.equal(typeof body[tab].source, "string", `${tab} names its source`);
    assert.ok(body[tab].source.length > 0);
  }
});

test("GET /api/roles/engineer: instructions composed as dispatch composes them, hashed and sectioned", async () => {
  const { body } = await get("/api/roles/engineer");
  const i = body.instructions;
  assert.equal(i.ok, true, i.refusal);
  assert.equal(i.sha256, createHash("sha256").update(i.prompt, "utf8").digest("hex"));
  assert.equal(i.sections.map((s: any) => i.prompt.slice(s.start, s.end)).join(""), i.prompt);
  assert.deepEqual(i.sections.map((s: any) => s.id ? `${s.kind}:${s.id}` : s.kind), ["protocol", "base", "workflow", "constraint:be-terse", "framing"]);
  assert.equal(i.protocol.sha256, protocolSha);
  assert.match(i.context, /forge invoke engineer/);
});

test("GET /api/roles/engineer?project=<registered key>: composed with that project's addendum, marked, hashed apart from host-only", async () => {
  const projects = await get("/api/projects");
  assert.equal(projects.status, 200, JSON.stringify(projects.body));
  const records: any[] = Array.isArray(projects.body) ? projects.body : projects.body.projects;
  const record = records.find((p: any) => p.projectDirs.includes(PROJECT) || p.projectDir === PROJECT);
  assert.ok(record, `the scratch project is registered: ${JSON.stringify(records.map((p: any) => [p.key, p.projectDir]))}`);

  const hostOnly = (await get("/api/roles/engineer")).body.instructions;
  assert.equal(hostOnly.project, null);
  assert.match(hostOnly.source, /host-only: pick a project in Scope to see its addendum/);
  assert.ok(!hostOnly.sections.some((s: any) => s.kind === "addendum"));

  const { status, body } = await get(`/api/roles/engineer?project=${encodeURIComponent(record.key)}`);
  assert.equal(status, 200, JSON.stringify(body));
  const i = body.instructions;
  assert.equal(i.ok, true, i.refusal);
  assert.deepEqual(i.project, { key: record.key, dir: record.primaryCheckout });
  assert.match(i.source, new RegExp(`project ${record.key}`));
  assert.deepEqual(i.sections.map((s: any) => s.id ? `${s.kind}:${s.id}` : s.kind), ["protocol", "base", "addendum", "workflow", "constraint:be-terse", "framing"]);
  const addendum = i.sections.find((s: any) => s.kind === "addendum");
  assert.equal(addendum.title, "Project addendum");
  assert.match(i.prompt.slice(addendum.start, addendum.end), /Run pnpm, never npm, in this repo\./);
  assert.equal(i.sha256, createHash("sha256").update(i.prompt, "utf8").digest("hex"));
  assert.notEqual(i.sha256, hostOnly.sha256);
  assert.match(i.context, /anchored at /);
});

test("GET /api/roles/engineer?project=<unregistered>: 400 with a named reason; a path is never taken", async () => {
  for (const q of ["no-such-project", encodeURIComponent(PROJECT), ""]) {
    const { status, body } = await get(`/api/roles/engineer?project=${q}`);
    assert.equal(status, 400, `${q}: ${JSON.stringify(body)}`);
    assert.equal(body.reason, "project_not_registered");
  }
});

test("GET /api/roles/engineer: skills, harness, secrets, tools, tasks, receipts and usage", async () => {
  const { body } = await get("/api/roles/engineer");
  assert.ok(body.skills.hostOnly.length > 0, "the release's host skills");
  assert.deepEqual(body.skills.mounted.map((s: any) => [s.name, s.mode]), [["browser-tools", "ro"]]);
  assert.equal(body.configuration, undefined, "FG-827: configuration is now harness");
  assert.equal(body.harness.settings.present, true);
  assert.equal(body.harness.runtime.name, "claude-oauth");
  assert.equal(realpathSync(body.harness.runtime.path), realpathSync(join(gen.root, "runtimes", "claude-oauth.yml")));
  assert.equal(body.harness.authStrategy, "oauth-volume");
  assert.equal(body.secrets.text, "none: containers receive no project secrets");
  assert.deepEqual(body.tools.declared, ["read", "edit", "bash"]);
  assert.equal(body.tools.enforced, false);
  assert.equal(body.tools.mcp, "none");
  assert.deepEqual(body.tasks.rows.map((t: any) => t.taskId), ["task-e3", "task-e2", "task-e1"]);
  const receipts = Object.fromEntries(body.receipts.dispatches.map((d: any) => [d.taskId, d]));
  assert.deepEqual([receipts["task-e3"].protocol.sha256, receipts["task-e3"].generation], [protocolSha, GEN_ID]);
  assert.deepEqual([receipts["task-e1"].manifest, receipts["task-e1"].protocol], [true, null]);
  assert.equal(receipts["task-e2"].manifest, false);
  assert.deepEqual(body.receipts.generations.map((g: any) => [g.id, g.current, g.protocolSha]), [[GEN_ID, true, protocolSha]]);
  assert.deepEqual(body.receipts.backups.map((b: any) => b.files), [["agents/engineer/CLAUDE.md"]]);
  assert.deepEqual(body.usage.windows.map((w: any) => [w.since, w.inputTokens, w.requests]), [["1d", 300, 2], ["7d", 300, 2], ["30d", 300, 2], ["all", 300, 2]]);
  assert.deepEqual(body.usage.windows.find((w: any) => w.since === "all").byModel.map((m: any) => m.model), ["claude-sonnet-5"]);
});

test("GET /api/roles/red-wide: a seed without settings.json says so instead of failing", async () => {
  const { status, body } = await get("/api/roles/red-wide");
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.harness.settings.present, false);
  assert.equal(body.harness.settings.text, null);
  assert.equal(body.tools.settingsPresent, false);
  assert.equal(body.tools.declared, null);
  assert.equal(body.overview.mountMode.mode, "ro");
  assert.equal(body.overview.resolution.effort, "low");
  assert.equal(body.instructions.ok, true, body.instructions.refusal);
  assert.doesNotMatch(body.instructions.prompt, /## Task checklist/, "a read-only dispatch is not given the write-mode framing");
  assert.deepEqual(body.tasks.rows.map((t: any) => t.taskId), ["task-r1"]);
});

test("an unknown role is a 404, a path-shaped one too, and there is no POST", async () => {
  assert.equal((await get("/api/roles/no-such-role")).status, 404);
  assert.equal((await get("/api/roles/not-a-role")).status, 404);
  assert.equal((await get("/api/roles/..%2Fconstraints")).status, 404);
  assert.equal((await get("/api/roles/%E0%A4%A")).status, 404);
  assert.equal((await get("/api/roles", "POST")).status, 405);
  assert.equal((await get("/api/roles/engineer", "POST")).status, 405);
});

test("serving both GETs runs no subprocess and makes no outbound call", async () => {
  writeFileSync(CALL_LOG, "");
  outbound.length = 0;
  assert.equal((await get("/api/roles")).status, 200);
  assert.equal((await get("/api/roles/engineer")).status, 200);
  assert.equal((await get("/api/roles/red-wide")).status, 200);
  assert.deepEqual(readFileSync(CALL_LOG, "utf8").split("\n").filter(Boolean), []);
  assert.deepEqual(outbound, []);
  // Negative control: the shims are live, so an empty log is an observation, not a miss.
  execFileSync("git", ["--version"]);
  assert.deepEqual(readFileSync(CALL_LOG, "utf8").split("\n").filter(Boolean), ["git --version"]);
});
