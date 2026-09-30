// FG-835 enforcement coverage. Keep the route's trust boundary exercised independently
// of its feature tests: registry-only targets, an expiring one-shot proposal, fixed argv,
// shared POST guards, and a read model built from the Harness helper.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectRecord } from "./queries.js";
import { ProposalWindow } from "./raci-mutation.js";
import { MAX_POLICY_CANDIDATE_BYTES, handleModelPolicyMutation, modelPolicyReadModel, modelPolicyScratchRoot } from "./model-policy-mutation.js";

const port = 18855;
const base = `http://127.0.0.1:${port}`;
const home = mkdtempSync(join(tmpdir(), "fg835-enforcement-home-"));
const projectA = mkdtempSync(join(tmpdir(), "fg835-enforcement-a-"));
const projectB = mkdtempSync(join(tmpdir(), "fg835-enforcement-b-"));
const rig = mkdtempSync(join(tmpdir(), "fg835-enforcement-rig-"));
const callsPath = join(rig, "calls.log");
const candidatePath = join(rig, "candidate.yml");
const stub = join(rig, "forge-stub");

process.env.FORGE_HOME = home;
process.env.FORGE_BIN = stub;
process.env.HOST = "127.0.0.1";
process.env.PORT = String(port);
delete process.env.FORGE_DASHBOARD_ALLOW_REMOTE_MUTATIONS;
delete process.env.FORGE_DASHBOARD_ORIGIN;

writeFileSync(callsPath, "");
writeFileSync(stub, [
  "#!/bin/sh",
  `{ printf 'CALL\\n'; for v in "$@"; do printf 'ARG\\t%s\\n' "$v"; done; } >> "${callsPath}"`,
  `if [ -f "$4" ]; then cp "$4" "${candidatePath}"; fi`,
  'if [ -n "$STUB_HOLD" ]; then while [ ! -e "$STUB_HOLD" ]; do sleep 0.02; done; fi',
  'if [ -n "$STUB_FAIL" ]; then printf \'{"written":false,"reason":"locked"}\\n\'; exit 1; fi',
  'if [ "$3" = apply ]; then printf \'{"written":true}\\n\'; else printf \'{"ok":true,"findings":[]}\\n\'; fi',
].join("\n"));
chmodSync(stub, 0o755);

function project(key: string, dir: string): ProjectRecord {
  return { key, label: key, projectDirs: [dir], checkouts: [{ projectDir: dir, exists: true }] } as unknown as ProjectRecord;
}
const projects = new Map([["project-a", project("project-a", projectA)], ["project-b", project("project-b", projectB)]]);
let now = Date.parse("2026-09-30T12:00:00Z");
const window = new ProposalWindow();
const server = createServer((req, res) => void handleModelPolicyMutation(req, res, new URL(req.url ?? "/", base).pathname, {
  resolveProject: (key) => projects.get(key), actor: "dashboard", now: () => now, window,
}));
await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));

after(() => {
  server.close();
  for (const dir of [home, projectA, projectB, rig]) rmSync(dir, { recursive: true, force: true });
});

const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const yaml = "schema_version: 2\\nmodel_profiles: {}\\ndefaults: {}\\noverrides: {}\\n";

function reset(): void {
  writeFileSync(callsPath, "");
  rmSync(candidatePath, { force: true });
  delete process.env.STUB_FAIL;
  delete process.env.STUB_HOLD;
}
function calls(): string[][] {
  const result: string[][] = [];
  for (const line of readFileSync(callsPath, "utf8").split("\n")) {
    if (line === "CALL") result.push([]);
    else if (line.startsWith("ARG\t")) result.at(-1)?.push(line.slice(4));
  }
  return result;
}
function leftovers(): string[] { return existsSync(modelPolicyScratchRoot()) ? readdirSync(modelPolicyScratchRoot()) : []; }
async function post(path: string, body: Record<string, unknown>, headers: Record<string, string> = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json", Origin: base, ...headers }, body: JSON.stringify(body) });
  return { status: response.status, body: JSON.parse(await response.text()) as Record<string, unknown> };
}
function apply(target: Record<string, unknown>, text: string): Record<string, unknown> {
  return { ...target, candidate: text, proposedSha256: sha(text), confirmKey: target.target === "host" ? "host" : target.projectKey, rationale: "enforcement regression" };
}

test("FG-835 enforcement: proposals are scoped to host or registry project; caller paths never choose a checkout", async () => {
  reset();
  assert.equal((await post("/api/model-policy/propose", { projectKey: "project-a", projectDir: projectB, candidate: yaml })).status, 200);
  assert.deepEqual(calls()[0]?.slice(0, 6), ["model", "policy", "propose", calls()[0]?.[3], "--project", projectA]);
  reset();
  const other = await post("/api/model-policy/apply", apply({ projectKey: "project-b" }, yaml));
  assert.equal(other.body.refusal, "candidate_not_proposed");
  assert.equal((await post("/api/model-policy/apply", apply({ target: "host" }, yaml))).body.refusal, "candidate_not_proposed");
  assert.deepEqual(calls(), []);
});

test("FG-835 enforcement: expiry/change refuse before spawn; concurrent apply spends once and a no-write child refunds", async () => {
  reset();
  const expiring = `${yaml}# expiry ${now}\\n`;
  assert.equal((await post("/api/model-policy/propose", { target: "host", candidate: expiring })).status, 200);
  now += 15 * 60 * 1000 + 1;
  reset();
  assert.equal((await post("/api/model-policy/apply", apply({ target: "host" }, expiring))).body.refusal, "candidate_not_proposed");
  const original = `${yaml}# one-byte ${now}\\n`;
  assert.equal((await post("/api/model-policy/propose", { target: "host", candidate: original })).status, 200);
  reset();
  const changed = await post("/api/model-policy/apply", { ...apply({ target: "host" }, `${original}!`), proposedSha256: sha(original) });
  assert.equal(changed.body.refusal, "candidate_changed");
  assert.deepEqual(calls(), []);

  assert.equal((await post("/api/model-policy/propose", { target: "host", candidate: yaml })).status, 200);
  const hold = join(rig, "release");
  process.env.STUB_HOLD = hold;
  const pending = [post("/api/model-policy/apply", apply({ target: "host" }, yaml)), post("/api/model-policy/apply", apply({ target: "host" }, yaml))];
  for (let attempt = 0; attempt < 100 && calls().filter((call) => call[2] === "apply").length < 1; attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  writeFileSync(hold, "release");
  const settled = await Promise.all(pending);
  assert.deepEqual(settled.map((r) => r.status).sort(), [200, 409]);
  assert.equal(settled.find((r) => r.status === 409)?.body.refusal, "candidate_not_proposed");
  delete process.env.STUB_HOLD;

  const refundable = `${yaml}# refund\\n`;
  delete process.env.STUB_FAIL;
  assert.equal((await post("/api/model-policy/propose", { target: "host", candidate: refundable })).status, 200);
  process.env.STUB_FAIL = "1";
  assert.equal((await post("/api/model-policy/apply", apply({ target: "host" }, refundable))).status, 409);
  delete process.env.STUB_FAIL;
  assert.equal((await post("/api/model-policy/apply", apply({ target: "host" }, refundable))).status, 200, "a child that wrote nothing refunds the proposal");
});

test("FG-835 enforcement: candidate is scratch-only, byte-bounded, and forbidden fields or dash operands cannot spawn", async () => {
  reset();
  const hostile = `${yaml}# $(touch nope) --force \\u0000 é\\n`;
  process.env.STUB_FAIL = "1";
  assert.equal((await post("/api/model-policy/propose", { projectKey: "project-a", candidate: hostile })).status, 409);
  assert.deepEqual(readFileSync(candidatePath), Buffer.from(hostile));
  const [call] = calls();
  assert.ok(!call!.some((arg) => arg.includes("$(touch nope)")));
  assert.ok(call![3]!.startsWith(modelPolicyScratchRoot() + "/"));
  assert.ok(!call![3]!.startsWith(projectA));
  assert.deepEqual(leftovers(), []);
  reset();
  assert.equal((await post("/api/model-policy/propose", { target: "host", candidate: "é".repeat(Math.floor(MAX_POLICY_CANDIDATE_BYTES / 2) + 1) })).status, 413);
  for (const body of [{ target: "host", candidate: yaml, force: true }, { target: "host", candidate: yaml, allowUndispatchable: true }, { ...apply({ target: "host" }, yaml), rationale: "--force" }]) {
    assert.equal((await post("/api/model-policy/propose", body)).status, 400);
  }
  assert.deepEqual(calls(), []);
});

test("FG-835 enforcement: shared POST guards refuse both route names before spawn", async () => {
  reset();
  for (const path of ["/api/model-policy/propose", "/api/model-policy/apply"]) {
    const body = path.endsWith("apply") ? apply({ target: "host" }, yaml) : { target: "host", candidate: yaml };
    assert.equal((await post(path, body, { Origin: "http://evil.example" })).status, 403);
    assert.equal((await post(path, body, { "Content-Type": "text/plain" })).status, 415);
  }
  process.env.HOST = "0.0.0.0";
  try { assert.equal((await post("/api/model-policy/propose", { target: "host", candidate: yaml })).status, 403); } finally { process.env.HOST = "127.0.0.1"; }
  assert.deepEqual(calls(), []);
});

test("FG-835 enforcement: GET's read model uses Harness rows, reverses bounded audit/backups, and never spawns", async () => {
  reset();
  mkdirSync(join(home, "agents", "engineer"), { recursive: true });
  mkdirSync(join(home, "runtimes"), { recursive: true });
  writeFileSync(join(home, "agents", "engineer", "CLAUDE.md"), "# engineer\n");
  writeFileSync(join(home, "runtimes", "claude-oauth.yml"), ["name: claude-oauth", "image: agent-dev-worker:latest", "models:", "  default: claude-sonnet-5", "auth:", "  mode: oauth-volume", "invocation:", "  command: claude", "  args: []"].join("\n"));
  const { publishFlatAsGeneration } = await import("../../src/v2/seed-generation.testkit.js");
  publishFlatAsGeneration(home);
  const policyText = ["schema_version: 2", "on_unavailable: fail", "model_profiles:", "  subscription:", "    provider: anthropic", "    auth: subscription", "    map:", "      default: { model: claude-sonnet-5, cost_tier: standard }", "defaults:", "  profile: subscription", "  activity: {}", "overrides:", "  agents: {}", ""].join("\n");
  writeFileSync(join(home, "model-policy.yml"), policyText);
  for (let i = 0; i < 55; i += 1) writeFileSync(join(home, "model-policy-audit.log"), "", { flag: i === 0 ? "w" : "a" });
  // Keep the audit shape real enough for the tail parser and append in chronological order.
  for (let i = 0; i < 55; i += 1) writeFileSync(join(home, "model-policy-audit.log"), `${JSON.stringify({ at: `2026-09-30T00:00:${String(i).padStart(2, "0")}.000Z`, rationale: `r${i}` })}\n`, { flag: "a" });
  writeFileSync(join(home, "model-policy.yml.bak-2026-09-01T00:00:00.000Z"), "old\n");
  writeFileSync(join(home, "model-policy.yml.bak-2026-09-02T00:00:00.000Z"), "new\n");
  const { harnessActivities } = await import("./roles.js");
  const { listSeedRoles } = await import("../../src/v2/role-surface.js");
  const { resolveSeedGeneration } = await import("../../src/v2/seed-generation.js");
  const expected = listSeedRoles(home).flatMap((role) => harnessActivities(role, resolveSeedGeneration(home)).rows.map((row) => ({
    role, activity: row.activity, isDefault: row.isDefault, profile: row.profile, provider: row.provider, model: row.model,
    auth: row.auth, runtime: row.runtime, costTier: row.costTier, outcome: row.outcome, dispatchable: row.dispatchable,
    resolvedBy: row.resolvedBy, error: row.error,
  })));
  const read = modelPolicyReadModel();
  assert.deepEqual(read.resolution.rows, expected, "the editor and Harness share harnessActivities rows");
  assert.equal(read.audit.entries.length, 20, "audit tail is bounded");
  assert.equal(read.audit.entries[0]?.rationale, "r54", "audit tail is newest first");
  assert.deepEqual(read.backups.entries.map((b) => b.name), ["model-policy.yml.bak-2026-09-02T00:00:00.000Z", "model-policy.yml.bak-2026-09-01T00:00:00.000Z"]);
  assert.ok(read.backups.entries.every((b) => /^[a-f0-9]{64}$/.test(b.sha256)));
  assert.deepEqual(read.backups.entries.map((b) => b.text), ["new\n", "old\n"], "each backup carries its bytes, so Restore loads it as the candidate");
  assert.deepEqual(read.knownModels, ["claude-sonnet-5"], "the picker's model ids come from the generation's runtime seeds");
  assert.deepEqual(calls(), [], "GET's read-model work never shells forge");
});
