// FG-576 step 9: cross-provider credentials are never interchangeable.
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CODEX_CARRIER_ORIENTATION_MARKER, CODEX_CARRIER_SOURCE_REL, CODEX_CARRIER_SPLICE_MARKER, publishSeedGeneration } from "../v2/seed-generation.js";
import { stageAgentProtocols } from "../v2/seed-generation.testkit.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..");
const cli = ["--import", join(repo, "bin", "forge-loader.mjs"), join(repo, "src", "cli", "index.ts")];
type Roots = { base: string; home: string; project: string; bin: string; state: string; db: string; record: string };
let roots: Roots;

function policy(defaultProfile: "codex" | "claude"): string {
  return `schema_version: 2\nmodel_profiles:\n  codex:\n    provider: openai\n    auth: subscription\n    map:\n      default: { model: gpt-5.6-terra, cost_tier: standard }\n  claude:\n    provider: anthropic\n    auth: api\n    map:\n      default: { model: claude-sonnet-4-6, cost_tier: standard }\ndefaults:\n  profile: ${defaultProfile}\n  activity: {}\n`;
}
function setup(): Roots {
  const base = mkdtempSync(join(tmpdir(), "fg576-isolation-"));
  const home = join(base, "forge-home"), project = join(base, "project"), bin = join(base, "bin"), state = join(base, "codex-state");
  for (const d of [home, project, bin, state]) mkdirSync(d, { recursive: true });
  writeFileSync(join(project, "CLAUDE.md"), "<!-- forge:orchestrator-start -->\n", "utf8");
  copyFileSync(join(here, "__fixtures__", "fake-codex.js"), join(bin, "codex"));
  copyFileSync(join(here, "__fixtures__", "fake-claude.js"), join(bin, "claude"));
  chmodSync(join(bin, "codex"), 0o755); chmodSync(join(bin, "claude"), 0o755);
  const release = join(base, "release");
  mkdirSync(join(release, "seeds", "workflows"), { recursive: true }); mkdirSync(join(release, "seeds", "runtimes"), { recursive: true }); mkdirSync(join(release, "seeds", "codex"), { recursive: true });
  writeFileSync(join(release, "seeds", "workflows", "feature.yml"), "name: feature\nsteps: []\n"); writeFileSync(join(release, "seeds", "runtimes", "claude.yml"), "kind: claude\n");
  stageAgentProtocols(join(release, "seeds"));
  writeFileSync(join(release, "seeds", "orchestrator-template.md"), "<!-- forge:orchestrator-start -->\npolicy\n<!-- forge:orchestrator-end -->\n");
  writeFileSync(join(release, "seeds", CODEX_CARRIER_SOURCE_REL), `# carrier\n${CODEX_CARRIER_ORIENTATION_MARKER}\n${CODEX_CARRIER_SPLICE_MARKER}\n`);
  publishSeedGeneration({ home, assetsDir: release, trustedAssetRoot: () => release });
  return { base, home, project, bin, state, db: join(home, "forge.db"), record: join(base, "record.json") };
}
function run(args: string[], env: Record<string, string | undefined> = {}) {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, FORGE_HOME: roots.home, FORGE_DB_PATH: roots.db, FORGE_CODEX_DIR: roots.state, FORGE_ORCHESTRATORS_DIR: join(roots.base, "orchestrators"), PATH: `${roots.bin}:${process.env.PATH ?? ""}`, FAKE_CODEX_RECORD: roots.record, ...env };
  for (const [key, value] of Object.entries(childEnv)) if (value === undefined) delete childEnv[key];
  const r = spawnSync(process.execPath, [...cli, ...args], { cwd: roots.project, env: childEnv, encoding: "utf8", timeout: 30_000 });
  return { status: r.status, stderr: r.stderr ?? "", stdout: r.stdout ?? "" };
}
beforeEach(() => { roots = setup(); });
afterEach(() => rmSync(roots.base, { recursive: true, force: true }));

test("FG-576 AC13: Codex launch strips all Claude auth controls from its recorded child environment", () => {
  writeFileSync(join(roots.home, "model-policy.yml"), policy("codex"));
  writeFileSync(join(roots.state, "auth.json"), '{"tokens":{"access_token":"fixture"}}\n');
  const r = run(["orchestrator"], { CLAUDE_CODE_USE_BEDROCK: "1", AWS_PROFILE: "claude-only", ANTHROPIC_API_KEY: "claude-secret", CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1" });
  assert.equal(r.status, 0, r.stderr);
  const record = JSON.parse(readFileSync(roots.record, "utf8")) as { env: Record<string, string> };
  for (const key of ["CLAUDE_CODE_USE_BEDROCK", "AWS_PROFILE", "ANTHROPIC_API_KEY", "CLAUDE_CODE_DISABLE_BACKGROUND_TASKS"]) assert.equal(record.env[key], undefined, `${key} leaked into Codex`);
});

test("FG-576 AC13: each command probes only the selected provider's credential", () => {
  writeFileSync(join(roots.home, "model-policy.yml"), policy("codex"));
  writeFileSync(join(roots.state, "auth.json"), '{"tokens":{"access_token":"fixture"}}\n');
  const claudeWithoutCredential = run(["claude", "--profile", "claude"], { ANTHROPIC_API_KEY: undefined });
  assert.notEqual(claudeWithoutCredential.status, 0); assert.match(claudeWithoutCredential.stderr, /ANTHROPIC_API_KEY not set/);
  const codexWithCredential = run(["orchestrator"], { ANTHROPIC_API_KEY: undefined });
  assert.equal(codexWithCredential.status, 0, codexWithCredential.stderr);
  rmSync(join(roots.state, "auth.json")); writeFileSync(join(roots.home, "model-policy.yml"), policy("codex"));
  const codexWithoutCredential = run(["orchestrator"], { ANTHROPIC_API_KEY: "claude-fixture" });
  assert.notEqual(codexWithoutCredential.status, 0); assert.match(codexWithoutCredential.stderr, /no ~\/\.codex\/auth\.json/);
  const claudeWithCredential = run(["claude", "--profile", "claude"], { ANTHROPIC_API_KEY: "claude-fixture" });
  assert.equal(claudeWithCredential.status, 0, claudeWithCredential.stderr);
  assert.ok(existsSync(roots.record));
});
