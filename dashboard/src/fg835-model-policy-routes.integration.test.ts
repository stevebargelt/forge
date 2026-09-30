// FG-835 — the model-policy propose/apply rows and GET /api/model-policy through the REAL
// HTTP server, against a scratch FORGE_HOME (installed role seeds, a published seed
// generation, a host model-policy.yml) and a registered git checkout.
//
// Two forge binaries, switched per test through FORGE_BIN (read per request), as in the
// FG-834 suite: a recording stub for argv shape, the scratch-file lifecycle and every
// refusal-before-spawn; and the REAL `bin/forge` for the gate's own refusals and the green
// propose → apply round trip (atomic write, backup, audit line).

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TEST_PORT = 18835;
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const SAME_ORIGIN = BASE;
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const REAL_FORGE = join(REPO_ROOT, "bin", "forge");

const tmpHome = mkdtempSync(join(tmpdir(), "fg835-mp-"));
process.env.FORGE_HOME = tmpHome;
process.env.FORGE_DB_PATH = join(tmpHome, "forge.db");
process.env.FORGE_PROJECT_SCAN_ROOTS = mkdtempSync(join(tmpdir(), "fg835-scan-"));
process.env.PORT = String(TEST_PORT);
process.env.HOST = "127.0.0.1";
delete process.env.FORGE_DASHBOARD_ALLOW_REMOTE_MUTATIONS;
delete process.env.FORGE_DASHBOARD_ORIGIN;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.CLAUDE_CODE_USE_BEDROCK;

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
const CANDIDATE = policy({ defaultModel: "claude-opus-5-5" });
const LEGACY = policy({ version: "" });
const BREAKS_ENGINEER = policy({
  extraProfiles: "  review-only:\n    provider: anthropic\n    auth: subscription\n    map:\n      review: { model: claude-sonnet-5, cost_tier: standard }",
  overrides: "    engineer: review-only",
});
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

for (const role of ["engineer", "red-security"]) {
  mkdirSync(join(tmpHome, "agents", role), { recursive: true });
  writeFileSync(join(tmpHome, "agents", role, "CLAUDE.md"), `# ${role}\n`);
}
mkdirSync(join(tmpHome, "runtimes"), { recursive: true });
writeFileSync(join(tmpHome, "runtimes", "claude-oauth.yml"), runtime("claude-oauth"));
writeFileSync(join(tmpHome, "runtimes", "claude-apikey.yml"), runtime("claude-apikey"));
const { publishFlatAsGeneration } = await import("../../src/v2/seed-generation.testkit.js");
publishFlatAsGeneration(tmpHome);
const HOST_POLICY = join(tmpHome, "model-policy.yml");
writeFileSync(HOST_POLICY, CURRENT);
const hostPolicy = () => readFileSync(HOST_POLICY, "utf8");

const { getDb, writeTransaction } = await import("../../src/store/db.js");
const { repositoryCheckoutIdentity } = await import("../../src/util/repository-identity.js");
const { modelPolicyScratchRoot } = await import("./model-policy-mutation.js");

const projectDir = mkdtempSync(join(tmpdir(), "fg835-proj-"));
execFileSync("git", ["init", "-b", "main"], { cwd: projectDir, stdio: "ignore" });
execFileSync("git", ["remote", "add", "origin", "git@github.com:stevebargelt/fg835-model-policy.git"], { cwd: projectDir, stdio: "ignore" });
const checkoutDir = realpathSync(projectDir);
const PROJECT_KEY = repositoryCheckoutIdentity(projectDir).key;
const PROJECT_POLICY = join(checkoutDir, ".forge", "model-policy.yml");
writeTransaction(() => {
  getDb()
    .prepare(`INSERT INTO runs (id, workflow, title, status, created_at, project_dir) VALUES (?,?,?,?,?,?)`)
    .run("run-835", "feature", "model policy fixture", "complete", "2026-09-30T09:00:00Z", projectDir);
});

const RIG = mkdtempSync(join(tmpdir(), "fg835-rig-"));
const CALL_LOG = join(RIG, "calls.log");
const STUB = join(RIG, "forge-stub");
writeFileSync(CALL_LOG, "");
writeFileSync(
  STUB,
  [
    "#!/bin/sh",
    `{ printf 'CALL\\t%s\\n' "$PWD"; for a in "$@"; do printf 'ARG\\t%s\\n' "$a"; done; } >> "${CALL_LOG}"`,
    `if [ -f "$4" ]; then cp "$4" "${RIG}/seen-candidate.yml"; fi`,
    'if [ "$3" = "apply" ]; then printf \'{"written":true}\\n\'; else printf \'{"ok":true,"findings":[],"rows":[]}\\n\'; fi',
    "exit 0",
  ].join("\n"),
);
chmodSync(STUB, 0o755);
const SLOW_STUB = join(RIG, "forge-stub-slow");
writeFileSync(SLOW_STUB, ["#!/bin/sh", 'if [ "$3" = "apply" ]; then sleep 1; fi', `exec "${STUB}" "$@"`].join("\n"));
chmodSync(SLOW_STUB, 0o755);
const FAILING_APPLY_STUB = join(RIG, "forge-stub-failing-apply");
writeFileSync(
  FAILING_APPLY_STUB,
  ["#!/bin/sh", `if [ "$3" = "apply" ]; then printf '{"written":false,"reason":"target_locked","detail":"held"}\\n'; exit 1; fi`, `exec "${STUB}" "$@"`].join("\n"),
);
chmodSync(FAILING_APPLY_STUB, 0o755);

function useStub(): void {
  process.env.FORGE_BIN = STUB;
  writeFileSync(CALL_LOG, "");
}
function useRealForge(): void {
  process.env.FORGE_BIN = REAL_FORGE;
}

type RecordedCall = { cwd: string; argv: string[] };
function recordedCalls(): RecordedCall[] {
  const calls: RecordedCall[] = [];
  for (const line of readFileSync(CALL_LOG, "utf8").split("\n")) {
    if (line.startsWith("CALL\t")) calls.push({ cwd: line.slice(5), argv: [] });
    else if (line.startsWith("ARG\t")) calls[calls.length - 1]?.argv.push(line.slice(4));
  }
  return calls;
}

function scratchLeftovers(): string[] {
  return existsSync(modelPolicyScratchRoot()) ? readdirSync(modelPolicyScratchRoot()) : [];
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
      await fetch(`${BASE}/api/projects`);
      break;
    } catch {
      if (Date.now() > deadline) throw new Error(`server on ${TEST_PORT} did not start`);
      await new Promise((r) => setTimeout(r, 40));
    }
  }
}

type PostOptions = { headers?: Record<string, string>; body?: unknown; raw?: string };
async function post(path: string, options: PostOptions = {}): Promise<{ status: number; body: Record<string, any> }> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: SAME_ORIGIN, ...options.headers },
    body: options.raw ?? JSON.stringify(options.body ?? {}),
  });
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: { raw: text } };
  }
}

async function getPolicy(query: string): Promise<{ status: number; body: Record<string, any> }> {
  const res = await fetch(`${BASE}/api/model-policy${query}`);
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

const HOST = { target: "host" };
const PROJECT = () => ({ projectKey: PROJECT_KEY });
const applyBody = (target: Record<string, unknown>, candidate: string, over: Record<string, unknown> = {}) => ({
  ...target,
  candidate,
  proposedSha256: sha(candidate),
  confirmKey: "projectKey" in target ? PROJECT_KEY : "host",
  rationale: "default activity to opus for the release push",
  ...over,
});

test("integ FG-835: GET /api/model-policy — host source text, the resolution table for every installed role × activity, empty audit and backups", async () => {
  const res = await getPolicy("");
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const body = res.body;
  assert.deepEqual(body["target"], { kind: "host", path: HOST_POLICY, exists: true, sha256: sha(CURRENT), confirmKey: "host", project: null });
  assert.deepEqual(body["source"], { kind: "host", path: HOST_POLICY, text: CURRENT, error: null });
  const rows = body["resolution"].rows as Array<Record<string, any>>;
  assert.deepEqual([...new Set(rows.map((r) => r.role))], ["engineer", "red-security"]);
  const engineerDefault = rows.find((r) => r.role === "engineer" && r.isDefault)!;
  assert.equal(engineerDefault.profile, "claude-subscription");
  assert.equal(engineerDefault.model, "claude-sonnet-5");
  for (const field of ["provider", "auth", "runtime", "costTier", "dispatchable", "outcome"]) assert.ok(field in engineerDefault, field);
  assert.ok(rows.some((r) => r.role === "red-security" && r.activity === "review" && r.model === "claude-sonnet-5"));
  assert.equal(body["resolution"].policyError, null);
  assert.deepEqual(body["audit"], { path: join(tmpHome, "model-policy-audit.log"), entries: [], skippedLines: 0 });
  assert.deepEqual(body["backups"], { dir: tmpHome, entries: [] });
  assert.equal(body["proposalWindowMs"], 15 * 60 * 1000);
  assert.equal(body["maxCandidateBytes"], 64 * 1024);

  const project = await getPolicy(`?project=${encodeURIComponent(PROJECT_KEY)}`);
  assert.equal(project.status, 200, JSON.stringify(project.body));
  assert.equal(project.body["target"].kind, "project");
  assert.equal(project.body["target"].path, PROJECT_POLICY);
  assert.equal(project.body["target"].exists, false);
  assert.equal(project.body["target"].confirmKey, PROJECT_KEY);
  assert.equal(project.body["target"].project.checkoutDir, checkoutDir);
  assert.equal(project.body["source"].kind, "host", "no project override: the host file is in force");
  assert.equal(project.body["audit"].path, join(checkoutDir, ".forge", "model-policy-audit.log"));

  assert.equal((await getPolicy("?project=")).status, 404);
  assert.equal((await getPolicy("?project=github.com/nobody/nothing")).status, 404);
});

test("integ FG-835: propose spawns exactly `forge model policy propose <scratch> [--project <checkout>] --json`; the text never reaches argv; the scratch file is removed", async () => {
  useStub();
  const res = await post("/api/model-policy/propose", { body: { ...PROJECT(), projectDir: "/etc", candidate: CANDIDATE } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body["candidateSha256"], sha(CANDIDATE));
  assert.deepEqual(res.body["target"], { kind: "project", key: PROJECT_KEY, checkoutDir });
  assert.ok(Date.parse(res.body["proposalExpiresAt"]) > Date.now());
  const host = await post("/api/model-policy/propose", { body: { ...HOST, candidate: CANDIDATE } });
  assert.equal(host.status, 200, JSON.stringify(host.body));
  const [projectCall, hostCall] = recordedCalls();
  assert.equal(projectCall!.cwd, checkoutDir);
  assert.deepEqual([...projectCall!.argv.slice(0, 3), ...projectCall!.argv.slice(4)], ["model", "policy", "propose", "--project", checkoutDir, "--json"],
    "--project is the registry's checkout, never the caller's /etc");
  assert.deepEqual([...hostCall!.argv.slice(0, 3), ...hostCall!.argv.slice(4)], ["model", "policy", "propose", "--json"], "the host target passes no --project");
  assert.equal(hostCall!.cwd, realpathSync(tmpHome));
  for (const call of [projectCall!, hostCall!]) {
    const scratch = call.argv[3]!;
    assert.ok(scratch.startsWith(modelPolicyScratchRoot() + "/"), `the candidate is staged under FORGE_HOME (${scratch})`);
    assert.ok(!scratch.startsWith(checkoutDir));
    assert.equal(existsSync(scratch), false, "the scratch file is removed after the verb exits");
    assert.ok(!call.argv.some((a) => a.includes("claude-opus-5-5")), "no candidate text in argv");
  }
  assert.equal(readFileSync(join(RIG, "seen-candidate.yml"), "utf8"), CANDIDATE, "the child read the candidate bytes from the scratch file");
  assert.deepEqual(scratchLeftovers(), []);
});

test("integ FG-835: apply spawns exactly `forge model policy apply <scratch> [--project <checkout>] --confirm --by dashboard --source dashboard --rationale <text> --json` after a green propose — never --allow-undispatchable", async () => {
  for (const target of [PROJECT(), HOST]) {
    useStub();
    assert.equal((await post("/api/model-policy/propose", { body: { ...target, candidate: CANDIDATE } })).status, 200);
    writeFileSync(CALL_LOG, "");
    const res = await post("/api/model-policy/apply", { body: applyBody(target, CANDIDATE) });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const [call] = recordedCalls();
    const project = "projectKey" in target ? ["--project", checkoutDir] : [];
    assert.deepEqual([...call!.argv.slice(0, 3), ...call!.argv.slice(4)], [
      "model", "policy", "apply", ...project, "--confirm", "--by", "dashboard",
      "--source", "dashboard", "--rationale", "default activity to opus for the release push", "--json",
    ], "the rationale is its own argv element, verbatim");
    assert.ok(!call!.argv.includes("--force"));
    assert.ok(!call!.argv.includes("--allow-undispatchable"));
    assert.equal(existsSync(call!.argv[3]!), false);

    writeFileSync(CALL_LOG, "");
    const again = await post("/api/model-policy/apply", { body: applyBody(target, CANDIDATE) });
    assert.equal(again.body["refusal"], "candidate_not_proposed", "an applied proposal is spent");
    assert.deepEqual(recordedCalls(), []);
  }
  assert.deepEqual(scratchLeftovers(), []);
});

test("integ FG-835: a propose for one target never admits an apply to another", async () => {
  useStub();
  assert.equal((await post("/api/model-policy/propose", { body: { ...HOST, candidate: CANDIDATE } })).status, 200);
  writeFileSync(CALL_LOG, "");
  const res = await post("/api/model-policy/apply", { body: applyBody(PROJECT(), CANDIDATE) });
  assert.equal(res.body["refusal"], "candidate_not_proposed");
  assert.deepEqual(recordedCalls(), []);
  assert.equal((await post("/api/model-policy/apply", { body: applyBody(HOST, CANDIDATE) })).status, 200, "the host proposal is still there for the host");
});

test("integ FG-835: two concurrent applies of one green propose spawn exactly one apply; the other is refused candidate_not_proposed", async () => {
  process.env.FORGE_BIN = SLOW_STUB;
  writeFileSync(CALL_LOG, "");
  assert.equal((await post("/api/model-policy/propose", { body: { ...HOST, candidate: CANDIDATE } })).status, 200);
  writeFileSync(CALL_LOG, "");
  const [a, b] = await Promise.all([
    post("/api/model-policy/apply", { body: applyBody(HOST, CANDIDATE) }),
    post("/api/model-policy/apply", { body: applyBody(HOST, CANDIDATE) }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409], JSON.stringify([a.body, b.body]));
  assert.equal((a.status === 409 ? a : b).body["refusal"], "candidate_not_proposed");
  assert.equal(recordedCalls().filter((c) => c.argv[2] === "apply").length, 1, "one proposal admits one apply");
  assert.deepEqual(scratchLeftovers(), []);
});

test("integ FG-835: an apply whose child wrote nothing refunds the proposal, and the CLI's reason comes back; a retry is admitted", async () => {
  process.env.FORGE_BIN = FAILING_APPLY_STUB;
  writeFileSync(CALL_LOG, "");
  assert.equal((await post("/api/model-policy/propose", { body: { ...HOST, candidate: CANDIDATE } })).status, 200);
  const failed = await post("/api/model-policy/apply", { body: applyBody(HOST, CANDIDATE) });
  assert.equal(failed.status, 409, JSON.stringify(failed.body));
  assert.match(String(failed.body["error"]), /target_locked: held/);
  useStub();
  const retried = await post("/api/model-policy/apply", { body: applyBody(HOST, CANDIDATE) });
  assert.equal(retried.status, 200, JSON.stringify(retried.body));
  const spent = await post("/api/model-policy/apply", { body: applyBody(HOST, CANDIDATE) });
  assert.equal(spent.body["refusal"], "candidate_not_proposed");
});

test("integ FG-835: the apply refusals are named and spawn nothing", async () => {
  useStub();
  const other = CANDIDATE + "\n# never proposed\n";
  assert.equal((await post("/api/model-policy/propose", { body: { ...PROJECT(), candidate: CANDIDATE } })).status, 200);
  writeFileSync(CALL_LOG, "");
  const cases: Array<[Record<string, unknown>, string, number]> = [
    [applyBody(PROJECT(), other), "candidate_not_proposed", 409],
    [applyBody(PROJECT(), other, { proposedSha256: sha(CANDIDATE) }), "candidate_changed", 409],
    [applyBody(PROJECT(), CANDIDATE, { proposedSha256: undefined }), "candidate_changed", 409],
    [applyBody(PROJECT(), CANDIDATE, { confirmKey: "host" }), "confirm_key_mismatch", 400],
    [applyBody(PROJECT(), CANDIDATE, { confirmKey: undefined }), "confirm_key_mismatch", 400],
    [applyBody(HOST, CANDIDATE, { confirmKey: PROJECT_KEY }), "confirm_key_mismatch", 400],
    [applyBody(PROJECT(), CANDIDATE, { rationale: "   " }), "rationale_required", 400],
    [applyBody(PROJECT(), CANDIDATE, { rationale: undefined }), "rationale_required", 400],
    [applyBody(PROJECT(), CANDIDATE, { rationale: "--allow-undispatchable" }), "rationale_invalid", 400],
    [applyBody(PROJECT(), CANDIDATE, { rationale: " -r" }), "rationale_invalid", 400],
    [applyBody(PROJECT(), CANDIDATE, { rationale: "x".repeat(2001) }), "rationale_invalid", 400],
  ];
  for (const [body, refusal, status] of cases) {
    const res = await post("/api/model-policy/apply", { body });
    assert.equal(res.body["refusal"], refusal, JSON.stringify(res.body));
    assert.equal(res.status, status);
  }
  assert.deepEqual(recordedCalls(), [], "no refusal spawned the CLI");
  assert.deepEqual(scratchLeftovers(), []);
});

test("integ FG-835: size bound, unknown fields (force, allowUndispatchable), a mixed target and an unknown project are refused before any spawn", async () => {
  useStub();
  const big = await post("/api/model-policy/propose", { body: { ...HOST, candidate: "a".repeat(64 * 1024 + 1) } });
  assert.equal(big.status, 413, JSON.stringify(big.body).slice(0, 200));
  const huge = await post("/api/model-policy/propose", { raw: JSON.stringify({ ...HOST, candidate: "a".repeat(400 * 1024) }) })
    .catch((err: Error) => ({ status: 0, body: { error: String(err.cause ?? err) } }));
  assert.ok(huge.status === 413 || /ECONNRESET|EPIPE|socket/.test(String(huge.body["error"])), JSON.stringify(huge));
  assert.equal((await post("/api/model-policy/propose", { body: { ...HOST, candidate: CANDIDATE, force: true } })).status, 400);
  assert.equal((await post("/api/model-policy/propose", { body: { ...HOST, candidate: CANDIDATE, allowUndispatchable: true } })).status, 400);
  assert.equal((await post("/api/model-policy/apply", { body: { ...applyBody(HOST, CANDIDATE), "--allow-undispatchable": true } })).status, 400);
  assert.equal((await post("/api/model-policy/propose", { body: { ...HOST, ...PROJECT(), candidate: CANDIDATE } })).status, 400);
  assert.equal((await post("/api/model-policy/propose", { body: { candidate: CANDIDATE } })).status, 400);
  assert.equal((await post("/api/model-policy/propose", { body: { projectKey: "github.com/nobody/nothing", candidate: CANDIDATE } })).status, 404);
  assert.equal((await post("/api/model-policy/propose", { raw: "{not json" })).status, 400);
  assert.deepEqual(recordedCalls(), []);
  assert.deepEqual(scratchLeftovers(), []);
});

test("integ FG-835: every FG-822 guard — off-loopback, cross-origin, simple content type — refuses before any spawn", async () => {
  useStub();
  const body = { ...HOST, candidate: CANDIDATE };
  for (const path of ["/api/model-policy/propose", "/api/model-policy/apply"]) {
    process.env.HOST = "0.0.0.0";
    try {
      const offLoopback = await post(path, { body });
      assert.equal(offLoopback.status, 403);
      assert.match(String(offLoopback.body["error"]), /model-policy changes are refused because this dashboard is bound to 0\.0\.0\.0/);
    } finally {
      process.env.HOST = "127.0.0.1";
    }
    assert.equal((await post(path, { body, headers: { Origin: "http://evil.example" } })).status, 403);
    assert.equal((await post(path, { body, headers: { "Sec-Fetch-Site": "cross-site" } })).status, 403);
    assert.equal((await post(path, { body, headers: { "Content-Type": "text/plain" } })).status, 415);
    assert.equal((await post(path, { body, headers: { "Content-Type": "application/x-www-form-urlencoded" } })).status, 415);
  }
  const preflight = await fetch(`${BASE}/api/model-policy/apply`, { method: "OPTIONS", headers: { Origin: "http://evil.example" } });
  assert.equal(preflight.status, 405);
  assert.equal(preflight.headers.get("access-control-allow-origin"), null);
  assert.deepEqual(recordedCalls(), []);
  assert.deepEqual(scratchLeftovers(), []);
});

test("integ FG-835: the real CLI's schema and undispatchable refusals come back named with their findings, and admit no apply", async () => {
  useRealForge();
  for (const [text, code] of [[LEGACY, "schema_version"], [BREAKS_ENGINEER, "default_undispatchable"]] as const) {
    const res = await post("/api/model-policy/propose", { body: { ...HOST, candidate: text } });
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body["refusal"], "gate_failed");
    assert.match(String(res.body["error"]), new RegExp(`\\[${code}\\]`));
    assert.equal(res.body["result"].ok, false);
    assert.ok(res.body["result"].findings.some((f: { code: string }) => f.code === code));
    const apply = await post("/api/model-policy/apply", { body: applyBody(HOST, text) });
    assert.equal(apply.body["refusal"], "candidate_not_proposed", "a red propose admits no apply");
  }
  const undispatchable = await post("/api/model-policy/propose", { body: { ...HOST, candidate: BREAKS_ENGINEER } });
  assert.match(String(undispatchable.body["error"]), /role 'engineer'/);
  assert.equal(hostPolicy(), CURRENT, "nothing written");
  assert.equal(existsSync(join(tmpHome, "model-policy-audit.log")), false);
  assert.deepEqual(scratchLeftovers(), []);
});

test("integ FG-835: green propose → host apply through the real CLI replaces the file atomically with a backup, audits by/source/rationale/sha, and GET re-reads it", async () => {
  useRealForge();
  const proposed = await post("/api/model-policy/propose", { body: { ...HOST, candidate: CANDIDATE } });
  assert.equal(proposed.status, 200, JSON.stringify(proposed.body));
  assert.equal(proposed.body["result"].ok, true);
  assert.equal(proposed.body["result"].written, false);
  const row = proposed.body["result"].rows.find((r: { role: string; isDefault: boolean }) => r.role === "engineer" && r.isDefault);
  assert.deepEqual(row.changed, [{ field: "model", before: "claude-sonnet-5", after: "claude-opus-5-5" }], "the resolution diff comes back");

  const refused = await post("/api/model-policy/apply", { body: applyBody(HOST, CANDIDATE, { confirmKey: "" }) });
  assert.equal(refused.body["refusal"], "confirm_key_mismatch");
  assert.equal(hostPolicy(), CURRENT, "refused without the typed target: nothing written");

  const applied = await post("/api/model-policy/apply", { body: applyBody(HOST, CANDIDATE) });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.equal(applied.body["result"].written, true);
  assert.equal(hostPolicy(), CANDIDATE);
  const backup = applied.body["result"].backup as string;
  assert.equal(dirname(backup), tmpHome, "the backup sits beside the policy file");
  assert.equal(readFileSync(backup, "utf8"), CURRENT);
  assert.deepEqual(readdirSync(tmpHome).filter((n) => n.includes(".tmp-")), [], "no temp file left behind (atomic temp+rename)");
  const audit = readFileSync(join(tmpHome, "model-policy-audit.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(audit.length, 1);
  assert.equal(audit[0].by, "dashboard");
  assert.equal(audit[0].source, "dashboard");
  assert.equal(audit[0].rationale, "default activity to opus for the release push");
  assert.equal(audit[0].candidate_sha256, sha(CANDIDATE));
  assert.equal(audit[0].candidate_sha256, applied.body["candidateSha256"], "the audit line's sha is the route's own candidate sha");
  assert.equal(audit[0].allow_undispatchable, false);
  assert.ok(audit[0].diff.some((r: { role: string }) => r.role === "engineer"), "the resolution diff rides in the audit line");
  assert.equal(existsSync(audit[0].candidate), false, "the recorded candidate path was the removed scratch file");
  assert.deepEqual(scratchLeftovers(), []);

  const view = await getPolicy("");
  assert.equal(view.body["source"].text, CANDIDATE);
  assert.equal(view.body["target"].sha256, sha(CANDIDATE));
  assert.equal(view.body["resolution"].rows.find((r: { role: string; isDefault: boolean }) => r.role === "engineer" && r.isDefault).model, "claude-opus-5-5",
    "the resolution table re-reads the applied policy");
  assert.equal(view.body["audit"].entries[0].rationale, "default activity to opus for the release push");
  assert.equal(view.body["audit"].entries[0].actor, "dashboard", "the reader renames the written `by` to the one attribution field, `actor`");
  assert.equal("by" in view.body["audit"].entries[0], false);
  assert.deepEqual(view.body["backups"].entries.map((b: { path: string; sha256: string }) => [b.path, b.sha256]), [[backup, sha(CURRENT)]]);
  assert.equal("text" in view.body["backups"].entries[0], false, "the list never carries a backup's content");

  const name = basename(backup);
  const one = await getPolicy(`?backup=${encodeURIComponent(name)}`);
  assert.equal(one.status, 200, JSON.stringify(one.body));
  assert.deepEqual([one.body["name"], one.body["sha256"], one.body["text"]], [name, sha(CURRENT), CURRENT], "Restore… reads one listed backup's bytes");
  for (const bad of ["model-policy.yml", "../model-policy.yml", `${name}/..`, `../${basename(tmpHome)}/${name}`, join(tmpHome, name)]) {
    const refused = await getPolicy(`?backup=${encodeURIComponent(bad)}`);
    assert.equal(refused.status, 404, `${bad}: only a listed backup name is read`);
    assert.equal("text" in refused.body, false);
  }
  assert.equal((await getPolicy(`?project=${encodeURIComponent(PROJECT_KEY)}&backup=${encodeURIComponent(name)}`)).status, 404, "a host backup is not readable as the project target's");
});

test("integ FG-835: green propose → project apply through the real CLI writes <checkout>/.forge/model-policy.yml and leaves the host file alone", async () => {
  useRealForge();
  const before = hostPolicy();
  const text = policy({ defaultModel: "claude-haiku-4-5" });
  assert.equal((await post("/api/model-policy/propose", { body: { ...PROJECT(), candidate: text } })).status, 200);
  const applied = await post("/api/model-policy/apply", { body: applyBody(PROJECT(), text) });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.equal(readFileSync(PROJECT_POLICY, "utf8"), text);
  assert.equal(applied.body["result"].backup, null, "no prior project file, so nothing to back up");
  assert.equal(hostPolicy(), before);
  const audit = JSON.parse(readFileSync(join(checkoutDir, ".forge", "model-policy-audit.log"), "utf8").trim());
  assert.equal(audit.target_kind, "project");
  assert.equal(audit.source, "dashboard");

  const view = await getPolicy(`?project=${encodeURIComponent(PROJECT_KEY)}`);
  assert.equal(view.body["source"].kind, "project");
  assert.equal(view.body["source"].text, text);
  assert.equal(view.body["target"].exists, true);
  assert.equal(view.body["audit"].entries.length, 1);
  assert.equal(view.body["resolution"].rows.find((r: { role: string; isDefault: boolean }) => r.role === "engineer" && r.isDefault).model, "claude-haiku-4-5");
});
