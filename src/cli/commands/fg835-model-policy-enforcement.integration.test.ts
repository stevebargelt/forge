// FG-835 enforcement regressions for the CLI policy-write gate.  These cases
// intentionally assert the absence of side effects as well as the reported refusal.

import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { publishFlatAsGeneration } from "../../v2/seed-generation.testkit.js";
import { writeFileAtomic } from "../../util/atomic-write.js";
import { REPO_ROOT, SRC_DIR, NODE_EXEC } from "../../integration-cli-spawn.js";

const CLI = join(SRC_DIR, "cli", "index.ts");
const TSX_LOADER = fileURLToPath(import.meta.resolve("tsx"));
const runtime = `
name: claude-oauth
description: test
image: agent-dev-worker:latest
models: { default: claude-sonnet-4-6 }
auth: { mode: oauth-volume }
mounts: [{ host: "\${TASK_DIR}", container: /task }]
invocation: { command: claude, args: ["--model", "\${MODEL}"] }
container: { name: "forge-\${TASK_ID}" }
result: { file: /task/result.json }
`;

function policy(defaultModel = "claude-sonnet-5", extra = ""): string {
  return `
schema_version: 2
on_unavailable: fail
model_profiles:
  claude-subscription:
    provider: anthropic
    auth: subscription
    map:
      reasoning: { model: claude-opus-5-5, cost_tier: premium }
      review: { model: claude-sonnet-5, cost_tier: standard }
      default: { model: ${defaultModel}, cost_tier: standard }
${extra}defaults:
  profile: claude-subscription
  activity: { reasoning: claude-subscription, review: claude-subscription }
overrides: { agents: {} }
`;
}

let root: string;
let home: string;
let project: string;
let candidates: string;
const original = policy();

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "fg835-enforcement-"));
  home = join(root, "home"); project = join(root, "project"); candidates = join(root, "candidates");
  for (const dir of [home, project, candidates]) mkdirSync(dir, { recursive: true });
  for (const role of ["engineer", "red-security"]) {
    mkdirSync(join(home, "agents", role), { recursive: true });
    writeFileSync(join(home, "agents", role, "CLAUDE.md"), `# ${role}\n`);
  }
  mkdirSync(join(home, "runtimes"), { recursive: true });
  writeFileSync(join(home, "runtimes", "claude-oauth.yml"), runtime);
  publishFlatAsGeneration(home, { assetsParent: root });
  writeFileSync(join(home, "model-policy.yml"), original);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function candidate(name: string, text: string): string {
  const path = join(candidates, name);
  writeFileSync(path, text);
  return path;
}

function forge(args: string[]) {
  return spawnSync(NODE_EXEC, ["--import", TSX_LOADER, CLI, "model", ...args], {
    cwd: project,
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, FORGE_HOME: home, HOME: join(root, "fake-home"), ANTHROPIC_API_KEY: "" },
  });
}

function json(args: string[]): Record<string, unknown> {
  const result = forge(args);
  const output = `${result.stdout}${result.stderr}`;
  assert.notEqual(result.status, null, output);
  assert.notEqual(result.status, null, output);
  assert.ok(result.stdout, output);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

function assertNoWrite(target: string): void {
  assert.deepEqual(readFileSync(target), Buffer.from(original), "target bytes must remain exactly unchanged");
  assert.equal(readdirSync(home).some((name) => name.startsWith("model-policy.yml.bak-")), false, "refusal creates no backup");
  assert.equal(existsSync(join(home, "model-policy-audit.log")), false, "refusal appends no audit line");
}

test("apply enforcement: dry-run and every rejected gate leave target bytes, backups, and audit untouched", () => {
  const invalidSchema = candidate("schema.yml", policy().replace("schema_version: 2", "schema_version: 3"));
  const missingRuntime = candidate("runtime.yml", policy(undefined, "  unavailable:\n    provider: groq\n    auth: subscription\n    runtime: absent-runtime\n    map: { default: { model: x, cost_tier: cheap } }\n"));
  const unavailableAuth = candidate("auth.yml", policy(undefined, "  api-only:\n    provider: anthropic\n    auth: api\n    map: { default: { model: x, cost_tier: cheap } }\n"));
  const undispatchable = candidate("undispatchable.yml", policy(undefined, "  review-only:\n    provider: anthropic\n    auth: subscription\n    map: { review: { model: x, cost_tier: cheap } }\n").replace("overrides: { agents: {} }", "overrides: { agents: { engineer: review-only } }"));

  for (const [label, file] of [["schema_version", invalidSchema], ["runtime_missing", missingRuntime], ["auth_unavailable", unavailableAuth], ["default_undispatchable", undispatchable]] as const) {
    const target = join(home, "model-policy.yml");
    const result = json(["policy", "apply", file, "--confirm", "--json"]);
    assert.equal(result.written, false, label);
    assert.ok((result.findings as Array<{ code: string }>).some((finding) => finding.code === label), label);
    assertNoWrite(target);
  }

  const dry = candidate("dry.yml", policy("claude-haiku-4-5"));
  const proposedJson = json(["policy", "propose", dry, "--json"]);
  const appliedJson = json(["policy", "apply", dry, "--json"]);
  assert.equal(proposedJson.reason, "not_confirmed", "propose reports its dry-run mode");
  assert.equal(appliedJson.reason, "not_confirmed", "apply without --confirm reports its dry-run mode");
  assert.deepEqual(appliedJson, proposedJson, "the JSON gate result and diff are identical for both dry-run verbs");

  const proposed = forge(["policy", "propose", dry]);
  const applied = forge(["policy", "apply", dry]);
  assert.equal(proposed.status, 0, `${proposed.stdout}\n${proposed.stderr}`);
  assert.equal(applied.status, 0, `${applied.stdout}\n${applied.stderr}`);
  assert.match(proposed.stdout, /Gate: PASS/, "propose prints the gate verdict");
  assert.match(applied.stdout, /Gate: PASS/, "apply dry-run prints the gate verdict");
  const proposedDiff = proposed.stdout.split("\n").slice(1).filter((line) => line.startsWith("  "));
  assert.ok(proposedDiff.length > 0, "propose prints resolution diff rows");
  for (const row of proposedDiff) assert.ok(applied.stdout.includes(row), `apply dry-run includes propose diff row: ${row}`);
  assert.match(applied.stdout, /Not applied — gate passed\. Re-run with --confirm to write\.\n$/, "apply dry-run honestly reports that no write occurred");
  assertNoWrite(join(home, "model-policy.yml"));
});

test("atomic helper preserves complete old bytes when its target directory cannot create a temp file", () => {
  const dir = join(root, "atomic"); mkdirSync(dir);
  const target = join(dir, "model-policy.yml"); writeFileSync(target, original);
  chmodSync(dir, 0o555);
  try {
    assert.throws(() => writeFileAtomic(target, policy("claude-haiku-4-5")));
    assert.deepEqual(readFileSync(target), Buffer.from(original), "failed atomic write cannot expose partial content");
  } finally {
    chmodSync(dir, 0o755);
  }
  assert.deepEqual(readdirSync(dir).filter((name) => name.includes(".tmp-")), [], "a failed temp write leaves no effective temp file");
});

test("project baseline, restore, and audit JSONL retain exact bytes and no policy secret", () => {
  const projectPolicy = policy("claude-haiku-4-5");
  mkdirSync(join(project, ".forge")); writeFileSync(join(project, ".forge", "model-policy.yml"), projectPolicy);
  const replacement = `${policy("claude-opus-5-5")}# credential=super-secret-fixture\n`;
  const applied = json(["policy", "apply", candidate("replacement.yml", replacement), "--project", project, "--confirm", "--by", "tester", "--json"]);
  assert.equal(applied.written, true);
  assert.equal(readFileSync(join(project, ".forge", "model-policy.yml"), "utf8"), replacement);
  assert.equal(readFileSync(join(home, "model-policy.yml"), "utf8"), original, "host policy is untouched by --project");
  assert.equal(readFileSync(String(applied.backup), "utf8"), projectPolicy, "backup is the effective project baseline");

  const restored = json(["policy", "apply", String(applied.backup), "--project", project, "--confirm", "--by", "tester", "--json"]);
  assert.equal(restored.written, true);
  assert.equal(readFileSync(join(project, ".forge", "model-policy.yml"), "utf8"), projectPolicy, "backup candidate restores original project bytes");
  const lines = readFileSync(join(project, ".forge", "model-policy-audit.log"), "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  const audits = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual(audits.map((entry) => entry.candidate_sha256), [replacement, projectPolicy].map((text) => createHash("sha256").update(text).digest("hex")));
  for (const entry of audits) {
    assert.equal(entry.by, "tester"); assert.match(String(entry.timestamp), /^\d{4}-\d{2}-\d{2}T.*Z$/);
    assert.ok(Array.isArray(entry.diff)); assert.equal(JSON.stringify(entry).includes("super-secret-fixture"), false, "audit must not copy policy secrets");
  }
});

test("real forge model resolve reflects the policy apply role-by-role for two roles and two activities", () => {
  const changed = policy().replace("claude-opus-5-5, cost_tier: premium", "claude-opus-6, cost_tier: premium").replace("claude-sonnet-5, cost_tier: standard }\n      default", "claude-sonnet-6, cost_tier: standard }\n      default");
  const changeFile = candidate("resolve-change.yml", changed);
  const proposal = json(["policy", "propose", changeFile, "--json"]);
  const rows = proposal.rows as Array<{ role: string; activity: string; before: Record<string, unknown>; after: Record<string, unknown> }>;
  const state = (resolved: Record<string, unknown>) => ({
    profile: resolved.profile ?? null, provider: resolved.provider ?? null, model: resolved.model ?? null,
    auth: resolved.auth ?? null, runtime: resolved.runtime ?? null, costTier: resolved.costTier ?? null,
  });
  const comparedState = (row: Record<string, unknown>) => Object.fromEntries(Object.keys(state(row)).map((key) => [key, row[key]]));
  const before = new Map<string, Record<string, unknown>>();
  for (const role of ["engineer", "red-security"]) for (const activity of ["reasoning", "review"]) {
    const result = forge(["resolve", role, "--activity", activity, "--json"]);
    assert.equal(result.status, 0, result.stderr);
    before.set(`${role}/${activity}`, JSON.parse(result.stdout) as Record<string, unknown>);
    const row = rows.find((item) => item.role === role && item.activity === activity)!;
    assert.deepEqual(comparedState(row.before), state(before.get(`${role}/${activity}`)!), "gate before side is the real CLI resolution");
  }
  const applied = forge(["policy", "apply", changeFile, "--confirm"]);
  assert.equal(applied.status, 0, `${applied.stdout}\n${applied.stderr}`);
  for (const role of ["engineer", "red-security"]) for (const activity of ["reasoning", "review"]) {
    const result = forge(["resolve", role, "--activity", activity, "--json"]);
    assert.equal(result.status, 0, result.stderr);
    const after = JSON.parse(result.stdout) as Record<string, unknown>;
    const row = rows.find((item) => item.role === role && item.activity === activity)!;
    assert.deepEqual(comparedState(row.after), state(after), "gate after side is the real CLI resolution");
  }
});
