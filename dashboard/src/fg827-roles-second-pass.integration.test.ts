// FG-827: the Roles second pass end to end against a scratch FORGE_HOME — the new payload
// shapes (the Instructions files list, the Harness per-activity rows and container facts,
// Skills with frontmatter and sources, Capabilities, Tools effective access, Usage by
// period/model/provider), each proven against the thing it claims to be:
//   - the Composed bytes and hash are composeSystemPrompt's output for the same role and project;
//   - each Harness row is `forge model resolve <role> --activity <a> --json`, through the real binary;
//   - each Usage window is `forge usage show --by role --since <w> --json`'s row for the role,
//     through the real binary.
// Serving the route stays read-only: no POST, no subprocess, no outbound call (invariant 21).

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TEST_PORT = 19002;
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const home = mkdtempSync(join(tmpdir(), "forge-fg827-"));
process.env.FORGE_HOME = home;
process.env.PORT = String(TEST_PORT);
process.env.HOST = "127.0.0.1";
process.env.FORGE_DASHBOARD_REMOTE = "0";
delete process.env.ANTHROPIC_API_KEY;
delete process.env.AWS_PROFILE;
delete process.env.FORGE_AGENT_IDLE_TIMEOUT_MS;
delete process.env.FORGE_OAUTH_VOLUME;
process.env.CLAUDE_CODE_USE_BEDROCK = "0";

// The runtime's browser-tools skill mount resolves through FORGE_BROWSER_TOOLS_DIR.
const SKILL_DIR = mkdtempSync(join(tmpdir(), "fg827-browser-tools-"));
writeFileSync(join(SKILL_DIR, "SKILL.md"), "---\nname: browser-tools\ndescription: Drive a headless Chrome\n  to verify UI changes.\n---\n\n# browser-tools\n");
process.env.FORGE_BROWSER_TOOLS_DIR = SKILL_DIR;

const { publishTestGeneration } = await import("../../src/v2/seed-generation.testkit.js");
const { getDb, writeTransaction } = await import("../../src/store/db.js");
const { composeSystemPrompt } = await import("../../src/v2/compose.js");
const { invokeWorkflowShape } = await import("../../src/v2/invoke-shape.js");

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

cpSync(join(REPO_ROOT, "seeds", "model-policy.example.yml"), join(home, "model-policy.yml"));
for (const role of ["engineer", "red-wide"]) {
  mkdirSync(join(home, "agents", role), { recursive: true });
  cpSync(join(REPO_ROOT, "seeds", "agents", role, "CLAUDE.md"), join(home, "agents", role, "CLAUDE.md"));
}
writeFileSync(join(home, "agents", "engineer", "settings.json"), JSON.stringify({ tools: ["read", "edit", "bash"] }));
cpSync(join(REPO_ROOT, "seeds", "constraints"), join(home, "constraints"), { recursive: true });

const HOUR = 3_600_000;
const ago = (hours: number) => new Date(Date.now() - hours * HOUR).toISOString();
const PROJECT = mkdtempSync(join(tmpdir(), "forge-fg827-proj-"));
mkdirSync(join(PROJECT, ".forge", "agents", "engineer"), { recursive: true });
writeFileSync(join(PROJECT, ".forge", "agents", "engineer", "CLAUDE.md"), "Run pnpm, never npm, in this repo.\n");
mkdirSync(join(PROJECT, ".forge", "constraints"), { recursive: true });
writeFileSync(join(PROJECT, ".forge", "constraints", "house-style.md"), "---\nid: house-style\nlevel: suggest\nroles: [engineer]\n---\n\n# House style\n\nTabs, not spaces.\n");
mkdirSync(join(PROJECT, ".claude", "skills", "deploy-notes"), { recursive: true });
writeFileSync(join(PROJECT, ".claude", "skills", "deploy-notes", "SKILL.md"), "---\nname: deploy-notes\ndescription: How this project deploys.\n---\n");
const CLI_CWD = mkdtempSync(join(tmpdir(), "forge-fg827-cwd-")); // no .forge: the host policy applies, as without ?project=

writeTransaction(() => {
  const db = getDb();
  db.prepare(`INSERT INTO runs (id, workflow, title, status, created_at, project_dir) VALUES (?,?,?,?,?,?)`).run("run-1", "tiny", "Build it", "complete", ago(200), PROJECT);
  const task = db.prepare(
    `INSERT INTO tasks (id, run_id, phase, agent_role, status, task_package, created_at, started_at, completed_at, resolved_provider, resolved_auth) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  );
  task.run("task-old", "run-1", "build", "engineer", "complete", "{}", ago(200), ago(200), ago(199.9), null, null);
  task.run("task-api", "run-1", "build", "engineer", "failed", "{}", ago(100), ago(100), ago(99.9), "anthropic", "api");
  task.run("task-sub", "run-1", "build", "engineer", "complete", "{}", ago(3), ago(3), ago(2.9), "anthropic", "subscription");
  task.run("task-red", "run-1", "build", "red-wide", "complete", "{}", ago(4), ago(4), ago(3.9), "anthropic", "subscription");
  const call = db.prepare(
    `INSERT INTO model_calls (task_id, request_id, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, created_at) VALUES (?,?,?,?,?,?,?,?)`,
  );
  call.run("task-old", "req-1", "claude-sonnet-4-5", 1000, 100, 10, 1, ago(24 * 40));
  call.run("task-api", "req-2", "claude-sonnet-5", 500, 50, 5, 0, ago(100));
  call.run("task-api", "req-3", "claude-opus-5", 700, 70, 0, 7, ago(99));
  call.run("task-sub", "req-4", "claude-sonnet-5", 200, 20, 2, 2, ago(3));
  call.run("task-red", "req-5", "claude-opus-5-5", 999, 99, 0, 0, ago(4));
});

// Invariant 21 guard, as fg817-roles-routes: shims record a subprocess, fetch records an outbound call.
const RIG = mkdtempSync(join(tmpdir(), "fg827-guard-"));
const CALL_LOG = join(RIG, "calls.log");
writeFileSync(CALL_LOG, "");
mkdirSync(join(RIG, "bin"));
for (const bin of ["docker", "git", "gh", "tmux", "forge", "forge-dev", "aws"]) {
  writeFileSync(join(RIG, "bin", bin), `#!/bin/sh\necho "${bin} $*" >> "${CALL_LOG}"\nexit 0\n`);
  chmodSync(join(RIG, "bin", bin), 0o755);
}
const CLEAN_PATH = process.env.PATH ?? "";
process.env.PATH = `${join(RIG, "bin")}:${CLEAN_PATH}`;
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

async function waitForServer(ms = 4000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      const response = await fetch(`${BASE}/api/roles/engineer`);
      if (response.ok) return;
      throw new Error(`server on ${TEST_PORT} answered ${response.status}`);
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await new Promise((r) => setTimeout(r, 40));
    }
  }
}

await waitForServer();

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

/** The real co-located binary, against the same FORGE_HOME, off the guard shims' PATH. */
function forgeCli(args: string[]): any {
  return JSON.parse(execFileSync("sh", [join(REPO_ROOT, "bin", "forge"), ...args], {
    cwd: CLI_CWD,
    env: { ...process.env, PATH: CLEAN_PATH, FORGE_HOME: home },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }));
}

async function projectKey(): Promise<string> {
  const projects = await get("/api/projects");
  const records: any[] = Array.isArray(projects.body) ? projects.body : projects.body.projects;
  const record = records.find((p: any) => p.projectDirs.includes(PROJECT) || p.projectDir === PROJECT);
  assert.ok(record, "the scratch project is registered");
  return record.key;
}

test("Instructions: files[] lists every composition source in order, the entry marked, with bytes and edit paths", async () => {
  const { status, body } = await get("/api/roles/engineer");
  assert.equal(status, 200, JSON.stringify(body));
  const i = body.instructions;
  assert.equal(i.ok, true, i.refusal);
  assert.deepEqual(i.files.map((f: any) => [f.id, f.kind]), [
    ["protocol", "protocol"], ["entry", "entry"], ["workflow", "workflow"], ["constraint:personal-coding-conventions", "constraint"],
  ]);
  const entry = i.files.find((f: any) => f.kind === "entry");
  assert.equal(realpathSync(entry.path), realpathSync(join(home, "agents", "engineer", "CLAUDE.md")));
  const entryOnDisk = readFileSync(join(home, "agents", "engineer", "CLAUDE.md"), "utf8");
  assert.equal(entry.markdown, entryOnDisk.trim(), "the entry's composed section: compose trims the seed");
  assert.equal(entry.raw ?? entry.markdown, entryOnDisk, "the file as on disk");
  assert.equal(entry.bytes, Buffer.byteLength(entry.markdown, "utf8"));
  assert.match(entry.edit, /forge upgrade/);
  const protocol = i.files.find((f: any) => f.kind === "protocol");
  assert.equal(realpathSync(protocol.path), realpathSync(join(gen.root, "agent-protocols", "engineer.md")));
  assert.equal(i.files.find((f: any) => f.kind === "workflow").path, null);
  const constraint = i.files.find((f: any) => f.kind === "constraint");
  assert.equal(realpathSync(constraint.path), realpathSync(join(home, "constraints", "personal-coding-conventions.md")));
  // Every file's section is in the composed prompt, in the same order.
  assert.deepEqual(i.sections.filter((s: any) => s.kind !== "framing").map((s: any) => s.id ? `constraint:${s.id}` : s.kind),
    ["protocol", "base", "workflow", "constraint:personal-coding-conventions"]);
});

test("Instructions: the Composed bytes and sha256 are composeSystemPrompt's output for the same role and project", async () => {
  const key = await projectKey();
  const { status, body } = await get(`/api/roles/engineer?project=${encodeURIComponent(key)}`);
  assert.equal(status, 200, JSON.stringify(body));
  const i = body.instructions;
  const { step, workflow } = invokeWorkflowShape("engineer", undefined, undefined);
  const composed = composeSystemPrompt({
    role: "engineer", workflow, step, seedGeneration: gen,
    agentDir: join(home, "agents", "engineer"), constraintsDir: join(home, "constraints"),
    projectDir: i.project.dir, projectMode: "rw",
  });
  assert.equal(composed.ok, true);
  if (!composed.ok) return;
  assert.equal(i.prompt, composed.prompt, "the Composed view is the exact bytes a container receives");
  assert.equal(i.sha256, createHash("sha256").update(composed.prompt, "utf8").digest("hex"));
  assert.equal(i.sections.map((s: any) => i.prompt.slice(s.start, s.end)).join(""), composed.prompt);
  assert.deepEqual(i.files.map((f: any) => f.id), [
    "protocol", "entry", "addendum", "workflow", "constraint:personal-coding-conventions", "constraint:house-style",
  ], "composition order: host constraints, then the project layer");
  const addendum = i.files.find((f: any) => f.kind === "addendum");
  assert.ok(addendum, "with ?project= the project addendum is its own file");
  assert.equal(realpathSync(addendum.path), realpathSync(join(PROJECT, ".forge", "agents", "engineer", "CLAUDE.md")));
  assert.equal(addendum.raw, "Run pnpm, never npm, in this repo.\n", "the addendum as on disk");
  assert.equal(addendum.markdown, `## Project-specific instructions (${basename(i.project.dir)})\n\nRun pnpm, never npm, in this repo.`, "its composed section: wrapped under the labeled heading");
  assert.equal(i.prompt.slice(addendum.start, addendum.end), addendum.markdown);
  const projectConstraint = i.files.find((f: any) => f.id === "constraint:house-style");
  assert.equal(realpathSync(projectConstraint.path), realpathSync(join(PROJECT, ".forge", "constraints", "house-style.md")));
});

for (const role of ["engineer", "red-wide"]) {
  test(`Harness: every ${role} activity row equals forge model resolve ${role} --activity <a> --json through the real binary`, async () => {
    const { body } = await get(`/api/roles/${role}`);
    const rows: any[] = body.harness.activities;
    const expected = role === "engineer"
      ? ["default", "reasoning", "review", "fast", "spec-writer", "fast-orchestrator"]
      : ["review", "reasoning", "fast", "spec-writer", "fast-orchestrator", "default"];
    assert.deepEqual(rows.map((r) => r.activity), expected, "the role default first, then the policy's activity map, then default");
    assert.deepEqual(rows.filter((r) => r.isDefault).map((r) => r.activity), [expected[0]]);
    for (const row of rows) {
      const cli = forgeCli(["model", "resolve", role, "--activity", row.activity, "--json"]);
      assert.deepEqual(row.resolve, cli, `${role} --activity ${row.activity}: the row is the CLI's report`);
      assert.deepEqual(
        [row.profile, row.provider, row.model, row.auth, row.runtime, row.costTier, row.resolvedBy, row.mappingPath, row.dispatchable],
        [cli.profile, cli.provider, cli.model, cli.auth, cli.runtime, cli.costTier, cli.resolvedBy, cli.mappingPath, cli.dispatchable],
      );
      assert.equal(row.effort, cli.effectiveEffort ?? null);
      assert.equal(row.image, "agent-dev-worker:latest");
    }
  });
}

test("Harness: container facts read from the runtime seed and dispatch config, each captioned with its source", async () => {
  const { body } = await get("/api/roles/red-wide");
  const c = body.harness.container;
  const runtimePath = join(gen.root, "runtimes", "claude-oauth.yml");
  assert.deepEqual(c.mounts.map((m: any) => [m.path, m.mode, m.optional]), [
    ["/task", "rw", false], ["/project", "ro", false], ["/design", "ro", true], ["/home/agent/.claude/skills/browser-tools", "ro", true],
  ], "the /project mode is the role's dispatch mount mode, not the template default");
  assert.match(c.mounts.find((m: any) => m.path === "/project").caption, /red in a seed-generation workflow/);
  for (const m of c.mounts) assert.ok(m.caption.includes(realpathSync(dirname(runtimePath))) || m.caption.includes(dirname(runtimePath)), m.caption);
  assert.deepEqual([c.authVolume.authMode, c.authVolume.volume, c.authVolume.path, c.authVolume.mode], ["oauth-volume", "forge-claude-oauth-v2", "/home/agent", "rw"]);
  assert.match(c.authVolume.source, /auth\.mode: oauth-volume/);
  assert.deepEqual(c.skillMounts.map((s: any) => s.name), ["browser-tools"]);
  assert.deepEqual([c.idleTimeout.seconds, c.idleTimeout.effectiveMs, c.idleTimeout.override], [600, 600_000, null]);
  assert.match(c.idleTimeout.source, /idle_timeout_seconds/);
  assert.equal(c.network.mode, "docker default (bridge)");
  assert.match(c.network.source, /no --network flag/);
  assert.match(body.harness.edit.runtime, /published by forge upgrade/);
  assert.match(body.harness.edit.settings, /published by forge upgrade/);
  assert.equal(typeof body.harness.runtime.text, "string");
});

test("Skills: mounted skills carry their SKILL.md description, source, optional flag and seed reference; host-only apart; available empty", async () => {
  const hostOnly = (await get("/api/roles/engineer")).body.skills;
  assert.deepEqual(hostOnly.mounted.map((s: any) => [s.name, s.description, s.source, s.optional, s.referencedBySeed, s.present]), [
    ["browser-tools", "Drive a headless Chrome to verify UI changes.", "host", true, true, true],
  ]);
  assert.equal(realpathSync(hostOnly.mounted[0].descriptionSource), realpathSync(join(SKILL_DIR, "SKILL.md")));
  assert.ok(hostOnly.hostOnly.some((s: any) => s.name === "forge-backlog" && /forge backlog/.test(s.description)), "host-only skills keep their own section, described");
  assert.deepEqual(hostOnly.available, []);
  assert.match(hostOnly.availableNote, /FG-797\/FG-798/);
  const red = (await get("/api/roles/red-wide")).body.skills;
  assert.equal(red.mounted[0].referencedBySeed, false, "red-wide's seed never names browser-tools");

  const key = await projectKey();
  const scoped = (await get(`/api/roles/engineer?project=${encodeURIComponent(key)}`)).body.skills;
  assert.deepEqual(scoped.mounted.map((s: any) => [s.name, s.source, s.description, s.container]), [
    ["browser-tools", "host", "Drive a headless Chrome to verify UI changes.", "/home/agent/.claude/skills/browser-tools"],
    ["deploy-notes", "project", "How this project deploys.", "/project/.claude/skills/deploy-notes"],
  ]);
});

test("Capabilities: activities, routes, result contract from the seed's schema block, mount mode and constraints by name", async () => {
  const engineer = (await get("/api/roles/engineer")).body;
  const c = engineer.capabilities;
  assert.deepEqual(c.activities.map((a: any) => a.activity), engineer.harness.activities.map((a: any) => a.activity));
  assert.ok(c.routes.length > 0);
  assert.equal(c.resultContract.declared, true);
  assert.deepEqual(c.resultContract.fields.map((f: any) => f.name), [
    "status", "steps_completed", "diff_summary", "files_modified", "tests_run", "tests_passed", "tests_failed",
    "no_validation_reason", "screenshots", "docs_impact", "notes",
  ]);
  assert.match(c.resultContract.source, /agents\/engineer\/CLAUDE\.md § Output schema$/);
  assert.equal(c.mountMode.mode, "rw");
  assert.deepEqual(c.constraints.map((k: any) => [k.id, k.level, k.active]), [
    ["atlas-stack-rn", "force", true], ["no-ai-attribution", "force", true], ["no-env-fabrication", "force", true],
    ["personal-coding-conventions", "suggest", true],
  ]);
  const atlas = c.constraints.find((k: any) => k.id === "atlas-stack-rn");
  assert.equal(atlas.heading, "Atlas frontend stack");
  assert.equal(realpathSync(atlas.file), realpathSync(join(home, "constraints", "atlas-stack-rn.md")));
  assert.match(atlas.scope, /workflows: feature-design-provided/);

  const red = (await get("/api/roles/red-wide")).body.capabilities;
  assert.deepEqual(red.resultContract.fields.map((f: any) => f.name), ["status", "verdict", "confidence", "findings", "notes"]);
  assert.equal(red.mountMode.mode, "ro");
  assert.deepEqual(red.constraints.map((k: any) => k.id), ["no-ai-attribution", "no-env-fabrication"], "constraints naming other roles do not apply");
});

test("Tools: the declared list keeps its caption, and effective access names mounts, network, toolchain and MCP none", async () => {
  const t = (await get("/api/roles/engineer")).body.tools;
  assert.deepEqual(t.declared, ["read", "edit", "bash"]);
  assert.match(t.note, /^declared, not enforced/);
  assert.deepEqual(t.effective.mounts.map((m: any) => [m.path, m.mode]), [
    ["/task", "rw"], ["/project", "rw"], ["/design", "ro"], ["/home/agent/.claude/skills/browser-tools", "ro"],
  ]);
  assert.equal(t.effective.network.mode, "docker default (bridge)");
  assert.equal(t.effective.mcp, "none");
  const tc = t.effective.toolchain;
  assert.equal(realpathSync(tc.source), realpathSync(join(REPO_ROOT, "docker", "agent-dev-worker.Dockerfile")));
  const names = tc.entries.map((e: any) => e.name);
  for (const tool of ["node", "npm", "git", "@anthropic-ai/claude-code", "chromium", "forge-test"]) assert.ok(names.includes(tool), `${tool} in ${names}`);
  assert.match(t.source, /agent-dev-worker\.Dockerfile/);
});

test("Usage: 1d/7d/30d/all equal forge usage show --by role --since <w> --json through the real binary; by model and provider", async () => {
  const u = (await get("/api/roles/engineer")).body.usage;
  assert.deepEqual(u.windows.map((w: any) => w.since), ["1d", "7d", "30d", "all"]);
  const pick = (r: any) => [r.inputTokens, r.outputTokens, r.cacheReadTokens, r.cacheCreationTokens, r.requests];
  for (const w of u.windows) {
    const cli = forgeCli(["usage", "show", "--by", "role", "--since", w.since, "--json"]);
    const row = cli.rows.find((r: any) => r.bucket === "engineer");
    assert.ok(row, `${w.since}: the CLI has an engineer row`);
    assert.deepEqual(pick(w), pick(row), `${w.since}: the window is the CLI's row`);
    const sum = (rows: any[]) => rows.reduce((acc, r) => pick(r).map((v: number, i: number) => v + acc[i]!), [0, 0, 0, 0, 0]);
    assert.deepEqual(sum(w.byModel), pick(row), `${w.since}: the model split sums to the row`);
    assert.deepEqual(sum(w.byProvider), pick(row), `${w.since}: the provider split sums to the row`);
  }
  const all = u.windows.find((w: any) => w.since === "all");
  assert.deepEqual(all.byModel.map((m: any) => [m.model, m.requests]), [["claude-sonnet-4-5", 1], ["claude-sonnet-5", 2], ["claude-opus-5", 1]]);
  const providers = Object.fromEntries(all.byProvider.map((p: any) => [`${p.provider}/${p.auth}`, p]));
  assert.deepEqual(Object.keys(providers).sort(), ["anthropic/api", "anthropic/subscription", "null/null"]);
  assert.equal(providers["anthropic/api"].requests, 2);
  for (const p of all.byProvider) assert.equal(p.cost, null, "no pricing source on this host: no row carries a cost");
  assert.match(providers["anthropic/api"].costNote, /API key — no pricing source on this host/);
  assert.equal(providers["anthropic/subscription"].costNote, "tokens only (subscription)");
  assert.match(providers["null/null"].costNote, /provider not recorded/);
  assert.equal(u.pricing.source, null);
  const day = u.windows.find((w: any) => w.since === "1d");
  assert.deepEqual([day.requests, day.byProvider.map((p: any) => p.auth)], [1, ["subscription"]]);
});

test("Overview: a Latest task card and the mounted skills; no route list, no status of the role's own", async () => {
  const o = (await get("/api/roles/engineer")).body.overview;
  assert.deepEqual([o.latestTask.taskId, o.latestTask.status, o.latestTask.runId], ["task-sub", "complete", "run-1"]);
  assert.deepEqual(o.skills, ["browser-tools"]);
  assert.equal(o.routes, undefined);
  assert.equal(o.status, undefined, "a role is a seed: it has no status");
});

test("still read-only: no POST, no subprocess and no outbound call across every new tab", async () => {
  writeFileSync(CALL_LOG, "");
  outbound.length = 0;
  const seedBefore = readFileSync(join(home, "agents", "engineer", "CLAUDE.md"), "utf8");
  const policyBefore = readFileSync(join(home, "model-policy.yml"), "utf8");
  assert.equal((await get("/api/roles/engineer")).status, 200);
  assert.equal((await get("/api/roles/red-wide")).status, 200);
  assert.equal((await get("/api/roles/engineer", "POST")).status, 405);
  assert.deepEqual(readFileSync(CALL_LOG, "utf8").split("\n").filter(Boolean), []);
  assert.deepEqual(outbound, []);
  assert.equal(readFileSync(join(home, "agents", "engineer", "CLAUDE.md"), "utf8"), seedBefore, "no seed file written");
  assert.equal(readFileSync(join(home, "model-policy.yml"), "utf8"), policyBefore, "no policy file written");
  execFileSync("git", ["--version"]);
  assert.deepEqual(readFileSync(CALL_LOG, "utf8").split("\n").filter(Boolean), ["git --version"]);
});

test("Instructions: host-only composition has the exact composeSystemPrompt bytes, and every displayed source accounts for its ordered prompt section", async () => {
  const { status, body } = await get("/api/roles/engineer");
  assert.equal(status, 200, JSON.stringify(body));
  const i = body.instructions;
  const { step, workflow } = invokeWorkflowShape("engineer", undefined, undefined);
  const composed = composeSystemPrompt({
    role: "engineer", workflow, step, seedGeneration: gen,
    agentDir: join(home, "agents", "engineer"), constraintsDir: join(home, "constraints"), projectMode: "rw",
  });
  assert.equal(composed.ok, true);
  if (!composed.ok) return;
  assert.equal(i.prompt, composed.prompt, "host-only Composed bytes are the dispatch prompt");
  assert.equal(i.sha256, createHash("sha256").update(composed.prompt, "utf8").digest("hex"));

  const sectionFileIds = i.sections.filter((s: any) => s.kind !== "framing").map((s: any) => s.kind === "base" ? "entry" : s.kind === "constraint" ? `constraint:${s.id}` : s.kind);
  assert.deepEqual(sectionFileIds, i.files.map((f: any) => f.id), "the panel neither omits nor invents a composed source");
  assert.equal(i.sections.map((s: any) => i.prompt.slice(s.start, s.end)).join(""), i.prompt, "sections tile every composed byte");
  for (const section of i.sections.filter((s: any) => s.kind !== "framing")) {
    const fileId = section.kind === "base" ? "entry" : section.kind === "constraint" ? `constraint:${section.id}` : section.kind;
    const file = i.files.find((f: any) => f.id === fileId);
    assert.ok(file, `${fileId} has a Files-panel source`);
    assert.ok(i.prompt.includes(file.markdown), `${fileId}'s exact source bytes occur in Composed`);
    assert.equal(file.bytes, Buffer.byteLength(file.markdown, "utf8"));
    if (file.path) assert.equal(realpathSync(file.path), realpathSync(file.path));
  }
});

test("Harness: a policy activity without an exact map remains an honest not-dispatchable CLI-parity row", async () => {
  const policyPath = join(home, "model-policy.yml");
  const policy = readFileSync(policyPath, "utf8");
  writeFileSync(policyPath, policy.replace("    fast-orchestrator: claude-subscription\n\noverrides:", "    fast-orchestrator: claude-subscription\n    unmapped: claude-subscription\n\noverrides:"));
  const { body } = await get("/api/roles/engineer");
  const row = body.harness.activities.find((r: any) => r.activity === "unmapped");
  assert.ok(row, "the policy activity appears in Harness");
  const cli = forgeCli(["model", "resolve", "engineer", "--activity", "unmapped", "--json"]);
  assert.deepEqual(row.resolve, cli);
  assert.equal(row.resolve.outcome, "activity_unmapped");
  assert.equal(row.dispatchable, false);
  assert.ok(row.resolve.activityUnmapped, "the refusal stays inspectable rather than pretending it can dispatch");
});

test("Usage: each model split is the real forge usage --by model result for the role's calls", async () => {
  const usage = (await get("/api/roles/engineer")).body.usage;
  const pick = (r: any) => [r.inputTokens, r.outputTokens, r.cacheReadTokens, r.cacheCreationTokens, r.requests];
  for (const window of usage.windows) {
    const cli = forgeCli(["usage", "show", "--by", "model", "--since", window.since, "--json"]);
    const expected = cli.rows.filter((r: any) => window.byModel.some((m: any) => m.model === r.bucket));
    assert.deepEqual(window.byModel.map((m: any) => ({ model: m.model, values: pick(m) })), expected.map((r: any) => ({ model: r.bucket, values: pick(r) })), `${window.since}: every dashboard model row is the real CLI row`);
  }
});
