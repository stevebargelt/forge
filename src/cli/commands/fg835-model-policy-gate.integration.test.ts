// FG-835: `forge model policy propose|apply` — the model-policy write gate.
//
// Driven through the REAL registered commands (registerModel + commander parseAsync),
// against a disposable $FORGE_HOME carrying installed role seeds and a published seed
// generation. The real ~/.forge is never touched.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { Command } from "commander";
import { publishFlatAsGeneration } from "../../v2/seed-generation.testkit.js";
import { applyModelPolicy, policyTarget } from "../../v2/model-policy-gate.js";
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
  detail?: string;
  targetSha256: string | null;
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

test("apply --rationale/--source dashboard: the audit line carries by, source, rationale and candidate_sha256; a terminal apply carries neither", async () => {
  const text = policy({ defaultModel: "claude-opus-5-5" });
  const rationale = "promote default to opus; see FG-835 — \"quoted\" $(not a shell)";
  const res = await run(["apply", candidate(text), "--confirm", "--by", "dashboard", "--source", "dashboard", "--rationale", rationale, "--json"]);
  assert.equal(res.exitCode, undefined, res.out);
  const j = JSON.parse(res.out) as Json & { audit: { by: string; source?: string; rationale?: string; candidate_sha256: string } };
  assert.equal(j.audit.by, "dashboard");
  assert.equal(j.audit.source, "dashboard");
  assert.equal(j.audit.rationale, rationale);
  const line = JSON.parse(readFileSync(join(homeDir, "model-policy-audit.log"), "utf8").trim()) as { by: string; source?: string; rationale?: string; candidate_sha256: string; diff: unknown[] };
  assert.deepEqual({ by: line.by, source: line.source, rationale: line.rationale }, { by: "dashboard", source: "dashboard", rationale });
  assert.equal(line.candidate_sha256, createHash("sha256").update(text).digest("hex"));
  assert.ok(line.diff.length > 0, "the resolution diff rides alongside");

  await run(["apply", candidate(CURRENT), "--confirm", "--rationale", "   ", "--json"]);
  const second = JSON.parse(readFileSync(join(homeDir, "model-policy-audit.log"), "utf8").trim().split("\n")[1]!) as Record<string, unknown>;
  assert.equal("source" in second, false);
  assert.equal("rationale" in second, false, "a blank rationale is not recorded");

  const bad = await run(["apply", candidate(text), "--confirm", "--source", "web"]).catch((e: Error) => ({ out: e.message, exitCode: 1 }));
  assert.match(bad.out, /invalid|Allowed choices/i, "--source admits only dashboard");
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

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const auditLines = (dir: string) => {
  const log = join(dir, "model-policy-audit.log");
  return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { outcome: string; error?: string; target_sha256_before: string | null; candidate_sha256: string }) : [];
};

test("RF-1: a rename failure leaves the policy unchanged and audits outcome failed — never an applied entry", () => {
  const text = policy({ defaultModel: "claude-opus-5-5" });
  assert.throws(
    () =>
      applyModelPolicy(text, {
        target: policyTarget(),
        candidateLabel: "c.yml",
        confirm: true,
        writeFile: () => {
          throw new Error("EXDEV: injected rename failure");
        },
      }),
    /injected rename failure/,
  );
  assert.equal(hostPolicy(), CURRENT);
  const lines = auditLines(homeDir);
  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.outcome, "failed");
  assert.match(lines[0]!.error!, /injected rename failure/);
  assert.equal(lines.some((l) => l.outcome === "applied"), false);

  const ok = applyModelPolicy(text, { target: policyTarget(), candidateLabel: "c.yml", confirm: true });
  assert.equal(ok.written, true);
  const after = auditLines(homeDir);
  assert.equal(after.length, 2);
  assert.equal(after[1]!.outcome, "applied");
  assert.equal(after[1]!.target_sha256_before, sha(CURRENT));
  assert.equal(hostPolicy(), text);
});

test("RF-2: an apply that lands between another apply's gate and its write makes that write refuse target_changed", () => {
  const first = policy({ defaultModel: "claude-opus-5-5" });
  const second = policy({ defaultModel: "claude-haiku-4-5" });
  let inner: ReturnType<typeof applyModelPolicy> | undefined;
  const outer = applyModelPolicy(first, {
    target: policyTarget(),
    candidateLabel: "first.yml",
    confirm: true,
    // Runs after the outer gate validated against CURRENT and before it takes the lock.
    now: () => {
      inner = applyModelPolicy(second, { target: policyTarget(), candidateLabel: "second.yml", confirm: true });
      return new Date();
    },
  });
  assert.equal(inner!.written, true);
  assert.equal(outer.written, false);
  assert.equal(outer.reason, "target_changed");
  assert.equal(hostPolicy(), second, "the earlier-landed apply is not silently overwritten");
  const lines = auditLines(homeDir);
  assert.deepEqual(lines.map((l) => [l.outcome, l.candidate_sha256]), [["applied", sha(second)]]);
  assert.deepEqual(readdirSync(homeDir).filter((n) => n.endsWith(".lock")), [], "the lock is released");
});

test("RF-2: apply --expect-sha256 from a stale propose --json is refused target_changed; a fresh one applies", async () => {
  const mine = candidate(policy({ defaultModel: "claude-opus-5-5" }));
  const proposed = JSON.parse((await run(["propose", mine, "--json"])).out) as Json;
  assert.equal(proposed.targetSha256, sha(CURRENT));

  const theirs = policy({ defaultModel: "claude-haiku-4-5" });
  assert.equal((await run(["apply", candidate(theirs), "--confirm", "--json"])).exitCode, undefined);

  const stale = await run(["apply", mine, "--confirm", "--expect-sha256", proposed.targetSha256!, "--json"]);
  assert.equal(stale.exitCode, 1);
  const sj = JSON.parse(stale.out) as Json;
  assert.equal(sj.written, false);
  assert.equal(sj.reason, "target_changed");
  assert.equal(hostPolicy(), theirs);
  assert.equal(auditLines(homeDir).length, 1);

  const fresh = JSON.parse((await run(["propose", mine, "--json"])).out) as Json;
  const res = await run(["apply", mine, "--confirm", "--expect-sha256", fresh.targetSha256!, "--json"]);
  assert.equal(res.exitCode, undefined, res.out);
  assert.equal(auditLines(homeDir)[1]!.target_sha256_before, sha(theirs));
});

test("RF-2: a target lock held by a live process refuses target_locked; a dead holder's lock is stolen", async () => {
  const c = candidate(policy({ defaultModel: "claude-opus-5-5" }));
  const lock = join(homeDir, "model-policy.yml.lock");
  writeFileSync(lock, String(process.pid));
  const held = await run(["apply", c, "--confirm", "--json"]);
  assert.equal(held.exitCode, 1);
  assert.equal((JSON.parse(held.out) as Json).reason, "target_locked");
  assert.equal(hostPolicy(), CURRENT);
  assert.equal(existsSync(lock), true, "a refused apply never removes another holder's lock");

  writeFileSync(lock, "2147483646");
  const stolen = await run(["apply", c, "--confirm", "--json"]);
  assert.equal(stolen.exitCode, undefined, stolen.out);
  assert.equal(existsSync(lock), false);
});

test("RF-3: a project whose .forge symlinks to the host FORGE_HOME is refused target_escapes_project; host file, backups and audit untouched", async () => {
  symlinkSync(homeDir, join(projectDir, ".forge"));
  const before = readdirSync(homeDir).sort();
  const res = await run(["apply", candidate(policy({ defaultModel: "claude-haiku-4-5" })), "--project", projectDir, "--confirm", "--json"]);
  assert.equal(res.exitCode, 1);
  const j = JSON.parse(res.out) as Json;
  assert.equal(j.written, false);
  assert.equal(j.reason, "target_escapes_project");
  assert.equal(hostPolicy(), CURRENT);
  assert.deepEqual(readdirSync(homeDir).sort(), before, "no backup, audit log or lock appears in the host dir");
  assert.equal(existsSync(join(homeDir, "model-policy-audit.log")), false);

  const human = await run(["apply", candidate(policy({ defaultModel: "claude-haiku-4-5" })), "--project", projectDir, "--confirm"]);
  assert.match(human.out, /Not applied — target_escapes_project: .*symlink/);
});

test("RF-3: a symlinked project target file or audit log is refused, and --project at the host dir itself is refused", async () => {
  mkdirSync(join(projectDir, ".forge"));
  symlinkSync(join(homeDir, "model-policy.yml"), join(projectDir, ".forge", "model-policy.yml"));
  const c = candidate(policy({ defaultModel: "claude-haiku-4-5" }));
  const file = JSON.parse((await run(["apply", c, "--project", projectDir, "--confirm", "--json"])).out) as Json;
  assert.equal(file.reason, "target_escapes_project");
  rmSync(join(projectDir, ".forge", "model-policy.yml"));

  symlinkSync(join(homeDir, "model-policy-audit.log"), join(projectDir, ".forge", "model-policy-audit.log"));
  const log = JSON.parse((await run(["apply", c, "--project", projectDir, "--confirm", "--json"])).out) as Json;
  assert.equal(log.reason, "target_escapes_project");
  assert.equal(existsSync(join(homeDir, "model-policy-audit.log")), false);

  const hostParent = mkdtempSync(join(tmpdir(), "fg835-hostparent-"));
  try {
    const home = join(hostParent, ".forge");
    cpSync(homeDir, home, { recursive: true, verbatimSymlinks: true });
    process.env.FORGE_HOME = home;
    const r = applyModelPolicy(CURRENT, { target: policyTarget(hostParent), candidateLabel: "c", confirm: true, roles: [] });
    assert.equal(r.reason, "target_escapes_project", JSON.stringify(r.proposal.findings));
    assert.match(r.detail!, /host model policy/);
    assert.equal(auditLines(home).length, 0);
  } finally {
    process.env.FORGE_HOME = homeDir;
    rmSync(hostParent, { recursive: true, force: true });
  }
  assert.equal(hostPolicy(), CURRENT);
});
