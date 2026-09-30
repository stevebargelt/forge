// FG-835: `forge model policy propose|apply` — the model-policy write gate.
//
// Driven through the REAL registered commands (registerModel + commander parseAsync),
// against a disposable $FORGE_HOME carrying installed role seeds and a published seed
// generation. The real ~/.forge is never touched.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { Command } from "commander";
import { publishFlatAsGeneration } from "../../v2/seed-generation.testkit.js";
import { registerModel } from "./model.js";

const runtime = (name: string) => `
name: ${name}
description: test
image: agent-dev-worker:latest
models:
  default: claude-sonnet-4-6
auth:
  mode: oauth-volume
mounts:
  - { host: "\${TASK_DIR}", container: /task }
invocation:
  command: claude
  args: ["--model", "\${MODEL}"]
container:
  name: forge-\${TASK_ID}
result:
  file: /task/result.json
`;

const policy = (opts: { version?: string; defaultModel?: string; extraProfiles?: string; overrides?: string } = {}) => `
${opts.version ?? "schema_version: 2"}
on_unavailable: fail
model_profiles:
  claude-subscription:
    provider: anthropic
    auth: subscription
    map:
      reasoning: { model: claude-opus-5-5, cost_tier: premium }
      review:    { model: claude-sonnet-5, cost_tier: standard }
      default:   { model: ${opts.defaultModel ?? "claude-sonnet-5"}, cost_tier: standard }
${opts.extraProfiles ?? ""}
defaults:
  profile: claude-subscription
  activity:
    reasoning: claude-subscription
    review: claude-subscription
overrides:
  agents:
${opts.overrides ?? "    {}"}
`.replace("  agents:\n    {}", "  agents: {}");

const CURRENT = policy();

let homeDir: string;
let projectDir: string;
let workDir: string;
let savedForgeHome: string | undefined;
let savedApiKey: string | undefined;

beforeEach(() => {
  savedForgeHome = process.env.FORGE_HOME;
  savedApiKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  homeDir = mkdtempSync(join(tmpdir(), "fg835-home-"));
  projectDir = mkdtempSync(join(tmpdir(), "fg835-proj-"));
  workDir = mkdtempSync(join(tmpdir(), "fg835-work-"));
  process.env.FORGE_HOME = homeDir;
  for (const role of ["engineer", "red-security"]) {
    mkdirSync(join(homeDir, "agents", role), { recursive: true });
    writeFileSync(join(homeDir, "agents", role, "CLAUDE.md"), `# ${role}\n`);
  }
  mkdirSync(join(homeDir, "runtimes"), { recursive: true });
  writeFileSync(join(homeDir, "runtimes", "claude-oauth.yml"), runtime("claude-oauth"));
  writeFileSync(join(homeDir, "runtimes", "claude-apikey.yml"), runtime("claude-apikey"));
  publishFlatAsGeneration(homeDir);
  writeFileSync(join(homeDir, "model-policy.yml"), CURRENT);
});

afterEach(() => {
  if (savedForgeHome === undefined) delete process.env.FORGE_HOME;
  else process.env.FORGE_HOME = savedForgeHome;
  if (savedApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedApiKey;
  for (const d of [homeDir, projectDir, workDir]) rmSync(d, { recursive: true, force: true });
});

function candidate(text: string): string {
  const path = join(workDir, `candidate-${Math.random().toString(36).slice(2)}.yml`);
  writeFileSync(path, text);
  return path;
}

async function run(args: string[]): Promise<{ out: string; exitCode: number | undefined }> {
  const program = new Command();
  program.exitOverride();
  registerModel(program);
  const lines: string[] = [];
  const realLog = console.log;
  const realErr = console.error;
  const realStderr = process.stderr.write.bind(process.stderr);
  const savedExit = process.exitCode;
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  console.error = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  process.stderr.write = ((chunk: string) => { lines.push(String(chunk)); return true; }) as typeof process.stderr.write;
  process.exitCode = undefined;
  try {
    await program.parseAsync(["node", "forge", "model", "policy", ...args]);
    return { out: lines.join("\n"), exitCode: process.exitCode };
  } finally {
    console.log = realLog;
    console.error = realErr;
    process.stderr.write = realStderr;
    process.exitCode = savedExit;
  }
}

type Json = {
  ok: boolean;
  written: boolean;
  reason?: string;
  backup?: string | null;
  auditLog?: string;
  findings: Array<{ code: string; message: string }>;
  allowedUndispatchable: string[];
  candidate: { sha256: string };
  rows: Array<{ role: string; activity: string; isDefault: boolean; changed: Array<{ field: string; before: string | null; after: string | null }>; becomesUndispatchable: boolean }>;
};

const hostPolicy = () => readFileSync(join(homeDir, "model-policy.yml"), "utf8");

test("propose: a passing candidate exits 0, renders the before → after diff, and writes nothing", async () => {
  const c = candidate(policy({ defaultModel: "claude-opus-5-5" }));
  const human = await run(["propose", c]);
  assert.equal(human.exitCode, undefined, human.out);
  assert.match(human.out, /Gate: PASS/);
  assert.match(human.out, /engineer \/ default \(default\): model claude-sonnet-5 → claude-opus-5-5/);

  const json = JSON.parse((await run(["propose", c, "--json"])).out) as Json;
  assert.equal(json.ok, true);
  assert.equal(json.written, false);
  const row = json.rows.find((r) => r.role === "engineer" && r.isDefault)!;
  assert.deepEqual(row.changed, [{ field: "model", before: "claude-sonnet-5", after: "claude-opus-5-5" }]);
  // Every installed role × activity is resolved, changed or not.
  assert.ok(json.rows.some((r) => r.role === "red-security" && r.activity === "review" && r.changed.length === 0));

  assert.equal(hostPolicy(), CURRENT, "propose never writes");
  assert.equal(existsSync(join(homeDir, "model-policy-audit.log")), false);
});

test("propose: a missing candidate file exits 1", async () => {
  const res = await run(["propose", join(workDir, "nope.yml")]);
  assert.equal(res.exitCode, 1);
  assert.match(res.out, /candidate not found/);
});

test("schema refusal: a legacy (no schema_version) candidate is refused naming forge upgrade; a newer one naming upgrade Forge", async () => {
  const legacy = await run(["propose", candidate(policy({ version: "" })), "--json"]);
  assert.equal(legacy.exitCode, 1);
  const lj = JSON.parse(legacy.out) as Json;
  assert.equal(lj.findings[0]!.code, "schema_version");
  assert.match(lj.findings[0]!.message, /forge upgrade/);
  assert.deepEqual(lj.rows, []);

  const newer = await run(["apply", candidate(policy({ version: "schema_version: 3" })), "--confirm", "--json"]);
  assert.equal(newer.exitCode, 1);
  const nj = JSON.parse(newer.out) as Json;
  assert.equal(nj.written, false);
  assert.equal(nj.findings[0]!.code, "schema_version");
  assert.match(nj.findings[0]!.message, /upgrade Forge/);
  assert.equal(hostPolicy(), CURRENT);
});

test("schema refusal: an invalid shape and bad name grammar each fail the gate", async () => {
  const invalid = JSON.parse((await run(["propose", candidate(CURRENT.replace("profile: claude-subscription", "profile: nope")), "--json"])).out) as Json;
  assert.equal(invalid.findings[0]!.code, "schema_invalid");

  const bad = policy({ extraProfiles: "  'bad name':\n    provider: anthropic\n    auth: subscription\n    map:\n      default: { model: m, cost_tier: cheap }" });
  const res = await run(["propose", candidate(bad), "--json"]);
  assert.equal(res.exitCode, 1);
  assert.ok((JSON.parse(res.out) as Json).findings.some((f) => f.code === "grammar" && /bad name/.test(f.message)));
});

test("runtime-missing refusal: a profile whose runtime seed is absent from the current generation fails the gate", async () => {
  const c = policy({ extraProfiles: "  pi-groq:\n    provider: groq\n    auth: subscription\n    runtime: pi-apikey\n    map:\n      default: { model: llama, cost_tier: cheap }" });
  const res = await run(["apply", candidate(c), "--confirm", "--json"]);
  assert.equal(res.exitCode, 1);
  const j = JSON.parse(res.out) as Json;
  assert.equal(j.written, false);
  assert.ok(j.findings.some((f) => f.code === "runtime_missing" && /pi-apikey/.test(f.message)), JSON.stringify(j.findings));
  assert.equal(hostPolicy(), CURRENT);
});

test("auth refusal: a profile pinned to an auth the host cannot satisfy fails; satisfying it passes", async () => {
  const c = candidate(policy({ extraProfiles: "  claude-api:\n    provider: anthropic\n    auth: api\n    map:\n      default: { model: claude-sonnet-5, cost_tier: standard }" }));
  const refused = JSON.parse((await run(["propose", c, "--json"])).out) as Json;
  assert.ok(refused.findings.some((f) => f.code === "auth_unavailable" && /ANTHROPIC_API_KEY/.test(f.message)));

  process.env.ANTHROPIC_API_KEY = "sk-test";
  const passed = await run(["propose", c, "--json"]);
  assert.equal(passed.exitCode, undefined, passed.out);
});

const BREAKS_ENGINEER = policy({
  extraProfiles: "  review-only:\n    provider: anthropic\n    auth: subscription\n    map:\n      review: { model: claude-sonnet-5, cost_tier: standard }",
  overrides: "    engineer: review-only",
});

test("undispatchable refusal: a candidate leaving an installed role's default activity unresolvable is refused; --allow-undispatchable accepts it", async () => {
  const c = candidate(BREAKS_ENGINEER);
  const refused = await run(["apply", c, "--confirm", "--json"]);
  assert.equal(refused.exitCode, 1);
  const rj = JSON.parse(refused.out) as Json;
  assert.equal(rj.written, false);
  const f = rj.findings.find((x) => x.code === "default_undispatchable");
  assert.ok(f, JSON.stringify(rj.findings));
  assert.match(f.message, /role 'engineer'/);
  assert.equal(hostPolicy(), CURRENT);

  const human = await run(["propose", c]);
  assert.match(human.out, /engineer \/ default \(default\):.*becomes UNDISPATCHABLE/);

  const allowed = await run(["apply", c, "--confirm", "--allow-undispatchable", "--json"]);
  assert.equal(allowed.exitCode, undefined, allowed.out);
  const aj = JSON.parse(allowed.out) as Json;
  assert.equal(aj.written, true);
  assert.deepEqual(aj.allowedUndispatchable, ["engineer"]);
  assert.equal(hostPolicy(), BREAKS_ENGINEER);
  const audit = JSON.parse(readFileSync(join(homeDir, "model-policy-audit.log"), "utf8").trim()) as { allow_undispatchable: boolean; allowed_undispatchable: string[] };
  assert.equal(audit.allow_undispatchable, true);
  assert.deepEqual(audit.allowed_undispatchable, ["engineer"]);
});

test("dry-run parity: apply without --confirm is propose — same gate, same rows, same exit code, nothing written", async () => {
  for (const text of [policy({ defaultModel: "claude-opus-5-5" }), BREAKS_ENGINEER, policy({ version: "" })]) {
    const c = candidate(text);
    const p = await run(["propose", c, "--json"]);
    const a = await run(["apply", c, "--json"]);
    assert.equal(a.exitCode, p.exitCode);
    const pj = JSON.parse(p.out) as Json;
    const aj = JSON.parse(a.out) as Json;
    assert.equal(aj.written, false);
    assert.deepEqual({ ok: aj.ok, findings: aj.findings, rows: aj.rows }, { ok: pj.ok, findings: pj.findings, rows: pj.rows });
    assert.equal(hostPolicy(), CURRENT);
  }
  const human = await run(["apply", candidate(policy({ defaultModel: "claude-opus-5-5" }))]);
  assert.match(human.out, /Not applied — gate passed\. Re-run with --confirm/);
});

test("apply --confirm: atomically replaces the host file, keeps a timestamped backup beside it, appends a JSONL audit line", async () => {
  const text = policy({ defaultModel: "claude-opus-5-5" });
  const c = candidate(text);
  const res = await run(["apply", c, "--confirm", "--by", "alice", "--json"]);
  assert.equal(res.exitCode, undefined, res.out);
  const j = JSON.parse(res.out) as Json;
  assert.equal(j.written, true);

  assert.equal(hostPolicy(), text);
  assert.match(j.backup!, /model-policy\.yml\.bak-\d{4}-\d{2}-\d{2}T/);
  assert.equal(dirname(j.backup!), homeDir, "the backup sits beside the policy file");
  assert.equal(readFileSync(j.backup!, "utf8"), CURRENT);
  assert.deepEqual(readdirSync(homeDir).filter((n) => n.includes(".tmp-")), [], "no temp file left behind");

  const lines = readFileSync(join(homeDir, "model-policy-audit.log"), "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  const audit = JSON.parse(lines[0]!) as { by: string; timestamp: string; target: string; target_kind: string; candidate_sha256: string; backup: string; diff: Json["rows"] };
  assert.equal(audit.by, "alice");
  assert.equal(audit.target, join(homeDir, "model-policy.yml"));
  assert.equal(audit.target_kind, "host");
  assert.equal(audit.candidate_sha256, createHash("sha256").update(text).digest("hex"));
  assert.equal(audit.backup, j.backup);
  assert.ok(audit.diff.some((r) => r.role === "engineer" && r.isDefault && r.changed.some((ch) => ch.after === "claude-opus-5-5")));
  assert.ok(audit.diff.every((r) => r.changed.length > 0), "the audit carries only the rows that change");

  // A second apply appends, and backs up the first applied file.
  const second = JSON.parse((await run(["apply", candidate(CURRENT), "--confirm", "--json"])).out) as Json;
  assert.equal(readFileSync(second.backup!, "utf8"), text);
  assert.equal(readFileSync(join(homeDir, "model-policy-audit.log"), "utf8").trim().split("\n").length, 2);
});

test("--project targeting: apply writes <project>/.forge/model-policy.yml with its own audit log and leaves the host file alone", async () => {
  const text = policy({ defaultModel: "claude-haiku-4-5" });
  const res = await run(["apply", candidate(text), "--project", projectDir, "--confirm", "--json"]);
  assert.equal(res.exitCode, undefined, res.out);
  const j = JSON.parse(res.out) as Json;
  assert.equal(readFileSync(join(projectDir, ".forge", "model-policy.yml"), "utf8"), text);
  assert.equal(j.backup, null, "no prior project file, so nothing to back up");
  assert.equal(j.auditLog, join(projectDir, ".forge", "model-policy-audit.log"));
  assert.ok(existsSync(j.auditLog!));
  assert.equal(hostPolicy(), CURRENT);
  assert.equal(existsSync(join(homeDir, "model-policy-audit.log")), false);

  // The project diff is against the project's effective policy — now the project file.
  const again = JSON.parse((await run(["propose", candidate(text), "--project", projectDir, "--json"])).out) as Json;
  assert.ok(again.rows.every((r) => r.changed.length === 0));
});
