// FG-834 — the RACI propose/apply rows and GET /api/raci through the REAL HTTP server,
// against a scratch FORGE_HOME and a registered git checkout.
//
// Two forge binaries, switched per test through FORGE_BIN (read per request): a
// recording stub (the FG-822 precedent — it logs cwd, every argument, and the bytes of
// the candidate file it was handed) for argv shape, the scratch-file lifecycle and every
// refusal-before-spawn; and the REAL `bin/forge` for the green propose → apply round
// trip, the gate's own refusal, and the audit line it appends.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TEST_PORT = 18834;
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const SAME_ORIGIN = BASE;
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const REAL_FORGE = join(REPO_ROOT, "bin", "forge");
const SEEDS = join(REPO_ROOT, "seeds");

const tmpHome = mkdtempSync(join(tmpdir(), "fg834-raci-"));
process.env.FORGE_HOME = tmpHome;
process.env.FORGE_DB_PATH = join(tmpHome, "forge.db");
process.env.FORGE_PROJECT_SCAN_ROOTS = mkdtempSync(join(tmpdir(), "fg834-scan-"));
process.env.PORT = String(TEST_PORT);
process.env.HOST = "127.0.0.1";
delete process.env.FORGE_DASHBOARD_ALLOW_REMOTE_MUTATIONS;
delete process.env.FORGE_DASHBOARD_ORIGIN;

// The host the gate validates against: the seed RACI, every seed agent installed, every
// seed workflow known. No seed generation is published, so there is no host policy to be
// a superset of.
const HOST_RACI = readFileSync(join(SEEDS, "forge-raci.md"), "utf8");
writeFileSync(join(tmpHome, "forge-raci.md"), HOST_RACI);
for (const agent of readdirSync(join(SEEDS, "agents"))) mkdirSync(join(tmpHome, "agents", agent), { recursive: true });
mkdirSync(join(tmpHome, "workflows"), { recursive: true });
for (const wf of readdirSync(join(SEEDS, "workflows"))) copyFileSync(join(SEEDS, "workflows", wf), join(tmpHome, "workflows", wf));

const IQ_ANCHOR = "responsible: engineer\naccountable: human\npath: invoke_chain";
assert.ok(HOST_RACI.includes(IQ_ANCHOR), "the seed RACI carries the implementation_quick anchor this test edits");
const CANDIDATE = HOST_RACI.replace(IQ_ANCHOR, "responsible: frontend-specialist\naccountable: human\npath: invoke_chain");
const BROKEN = HOST_RACI.replace(IQ_ANCHOR, "responsible: no-such-agent\naccountable: human\npath: invoke_chain");
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

const { getDb, writeTransaction } = await import("../../src/store/db.js");
const { repositoryCheckoutIdentity } = await import("../../src/util/repository-identity.js");
const { raciScratchRoot } = await import("./raci-mutation.js");

const projectDir = mkdtempSync(join(tmpdir(), "fg834-proj-"));
execFileSync("git", ["init", "-b", "main"], { cwd: projectDir, stdio: "ignore" });
execFileSync("git", ["remote", "add", "origin", "git@github.com:stevebargelt/fg834-raci.git"], { cwd: projectDir, stdio: "ignore" });
const checkoutDir = realpathSync(projectDir);
const PROJECT_KEY = repositoryCheckoutIdentity(projectDir).key;
writeTransaction(() => {
  getDb()
    .prepare(`INSERT INTO runs (id, workflow, title, status, created_at, project_dir) VALUES (?,?,?,?,?,?)`)
    .run("run-834", "feature", "raci fixture", "complete", "2026-09-30T09:00:00Z", projectDir);
});

const RIG = mkdtempSync(join(tmpdir(), "fg834-rig-"));
const CALL_LOG = join(RIG, "calls.log");
const STUB = join(RIG, "forge-stub");
writeFileSync(CALL_LOG, "");
writeFileSync(
  STUB,
  [
    "#!/bin/sh",
    `{ printf 'CALL\\t%s\\n' "$PWD"; for a in "$@"; do printf 'ARG\\t%s\\n' "$a"; done; } >> "${CALL_LOG}"`,
    `if [ -f "$3" ]; then cp "$3" "${RIG}/seen-candidate.md"; fi`,
    'if [ "$2" = "apply" ]; then printf \'{"written":true}\\n\'; else printf \'{"ok":true}\\n\'; fi',
    "exit 0",
  ].join("\n"),
);
chmodSync(STUB, 0o755);

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
  return existsSync(raciScratchRoot()) ? readdirSync(raciScratchRoot()) : [];
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

async function getRaci(query: string): Promise<{ status: number; body: Record<string, any> }> {
  const res = await fetch(`${BASE}/api/raci${query}`);
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

const applyBody = (candidate: string, over: Record<string, unknown> = {}) => ({
  projectKey: PROJECT_KEY,
  candidate,
  proposedSha256: sha(candidate),
  confirmKey: PROJECT_KEY,
  rationale: "route quick implementation to the frontend specialist",
  ...over,
});

test("integ FG-834: GET /api/raci — host default as the starting source, governance, empty audit tail", async () => {
  const res = await getRaci(`?project=${encodeURIComponent(PROJECT_KEY)}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body["project"], { key: PROJECT_KEY, label: res.body["project"].label, checkoutDir });
  assert.equal(res.body["source"].kind, "host");
  assert.equal(res.body["source"].path, join(tmpHome, "forge-raci.md"));
  assert.equal(res.body["source"].text, HOST_RACI);
  assert.ok(res.body["governance"].derived, "the governance panel is embedded");
  assert.deepEqual(res.body["audit"], { path: join(checkoutDir, ".forge", "raci-audit.log"), entries: [], skippedLines: 0 });
  assert.equal(res.body["proposalWindowMs"], 15 * 60 * 1000);
  assert.equal(res.body["maxCandidateBytes"], 256 * 1024);

  assert.equal((await getRaci("")).status, 404);
  assert.equal((await getRaci("?project=github.com/nobody/nothing")).status, 404);
});

test("integ FG-834: propose spawns exactly `forge raci propose <scratch> --project <checkout> --json`; the text never reaches argv; the scratch file is removed", async () => {
  useStub();
  const res = await post("/api/raci/propose", { body: { projectKey: PROJECT_KEY, projectDir: "/etc", candidate: CANDIDATE } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body["candidateSha256"], sha(CANDIDATE));
  assert.ok(Date.parse(res.body["proposalExpiresAt"]) > Date.now());
  const calls = recordedCalls();
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call!.cwd, checkoutDir);
  assert.equal(call!.argv.length, 6);
  assert.deepEqual([call!.argv[0], call!.argv[1], ...call!.argv.slice(3)], ["raci", "propose", "--project", checkoutDir, "--json"],
    "--project is the registry's checkout, never the caller's /etc");
  const scratch = call!.argv[2]!;
  assert.ok(scratch.startsWith(raciScratchRoot() + "/"), `the candidate is staged under FORGE_HOME (${scratch})`);
  assert.ok(!scratch.startsWith(checkoutDir));
  assert.equal(readFileSync(join(RIG, "seen-candidate.md"), "utf8"), CANDIDATE, "the child read the candidate bytes from the scratch file");
  assert.ok(!call!.argv.some((a) => a.includes("frontend-specialist")), "no candidate text in argv");
  assert.equal(existsSync(scratch), false, "the scratch file is removed after the verb exits");
  assert.deepEqual(scratchLeftovers(), []);
});

test("integ FG-834: apply spawns exactly `forge raci apply <scratch> --project <checkout> --confirm --by dashboard --source dashboard --rationale <text> --json` after a green propose", async () => {
  useStub();
  assert.equal((await post("/api/raci/propose", { body: { projectKey: PROJECT_KEY, candidate: CANDIDATE } })).status, 200);
  writeFileSync(CALL_LOG, "");
  const res = await post("/api/raci/apply", { body: applyBody(CANDIDATE) });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const [call] = recordedCalls();
  assert.deepEqual([call!.argv[0], call!.argv[1], ...call!.argv.slice(3)], [
    "raci", "apply", "--project", checkoutDir, "--confirm", "--by", "dashboard",
    "--source", "dashboard", "--rationale", "route quick implementation to the frontend specialist", "--json",
  ], "the rationale is its own argv element, verbatim");
  assert.ok(!call!.argv.includes("--force"));
  assert.ok(!call!.argv.some((a) => a.includes("frontend-specialist")), "no candidate text in argv");
  assert.equal(existsSync(call!.argv[2]!), false);
  assert.deepEqual(scratchLeftovers(), []);

  writeFileSync(CALL_LOG, "");
  const again = await post("/api/raci/apply", { body: applyBody(CANDIDATE) });
  assert.equal(again.body["refusal"], "candidate_not_proposed", "an applied proposal is spent");
  assert.deepEqual(recordedCalls(), []);
});

test("integ FG-834: the apply refusals are named and spawn nothing", async () => {
  useStub();
  const other = CANDIDATE + "\n<!-- never proposed -->\n";
  assert.equal((await post("/api/raci/propose", { body: { projectKey: PROJECT_KEY, candidate: CANDIDATE } })).status, 200);
  writeFileSync(CALL_LOG, "");
  const cases: Array<[Record<string, unknown>, string, number]> = [
    [applyBody(other), "candidate_not_proposed", 409],
    [applyBody(other, { proposedSha256: sha(CANDIDATE) }), "candidate_changed", 409],
    [applyBody(CANDIDATE, { proposedSha256: undefined }), "candidate_changed", 409],
    [applyBody(CANDIDATE, { confirmKey: "not-the-key" }), "confirm_key_mismatch", 400],
    [applyBody(CANDIDATE, { confirmKey: undefined }), "confirm_key_mismatch", 400],
    [applyBody(CANDIDATE, { rationale: "   " }), "rationale_required", 400],
    [applyBody(CANDIDATE, { rationale: undefined }), "rationale_required", 400],
    [applyBody(CANDIDATE, { rationale: "--force" }), "rationale_invalid", 400],
    [applyBody(CANDIDATE, { rationale: " -r" }), "rationale_invalid", 400],
    [applyBody(CANDIDATE, { rationale: "x".repeat(2001) }), "rationale_invalid", 400],
  ];
  for (const [body, refusal, status] of cases) {
    const res = await post("/api/raci/apply", { body });
    assert.equal(res.body["refusal"], refusal, JSON.stringify(res.body));
    assert.equal(res.status, status);
  }
  assert.deepEqual(recordedCalls(), [], "no refusal spawned the CLI");
  assert.deepEqual(scratchLeftovers(), []);
});

test("integ FG-834: size bound, unknown fields (force) and an unknown project are refused before any spawn", async () => {
  useStub();
  const big = await post("/api/raci/propose", { body: { projectKey: PROJECT_KEY, candidate: "a".repeat(256 * 1024 + 1) } });
  assert.equal(big.status, 413, JSON.stringify(big.body).slice(0, 200));
  // Past the body cap the shared readBody drops the connection mid-upload: a refusal
  // either way, and nothing is spawned.
  const huge = await post("/api/raci/propose", { raw: JSON.stringify({ projectKey: PROJECT_KEY, candidate: "a".repeat(600 * 1024) }) })
    .catch((err: Error) => ({ status: 0, body: { error: String(err.cause ?? err) } }));
  assert.ok(huge.status === 413 || /ECONNRESET|EPIPE|socket/.test(String(huge.body["error"])), JSON.stringify(huge));
  assert.equal((await post("/api/raci/propose", { body: { projectKey: PROJECT_KEY, candidate: CANDIDATE, force: true } })).status, 400);
  assert.equal((await post("/api/raci/apply", { body: { ...applyBody(CANDIDATE), "--force": true } })).status, 400);
  assert.equal((await post("/api/raci/propose", { body: { projectKey: "github.com/nobody/nothing", candidate: CANDIDATE } })).status, 404);
  assert.equal((await post("/api/raci/propose", { raw: "{not json" })).status, 400);
  assert.deepEqual(recordedCalls(), []);
  assert.deepEqual(scratchLeftovers(), []);
});

test("integ FG-834: every FG-822 guard — off-loopback, cross-origin, simple content type — refuses before any spawn", async () => {
  useStub();
  const body = { projectKey: PROJECT_KEY, candidate: CANDIDATE };
  for (const path of ["/api/raci/propose", "/api/raci/apply"]) {
    process.env.HOST = "0.0.0.0";
    try {
      const offLoopback = await post(path, { body });
      assert.equal(offLoopback.status, 403);
      assert.match(String(offLoopback.body["error"]), /RACI changes are refused because this dashboard is bound to 0\.0\.0\.0/);
    } finally {
      process.env.HOST = "127.0.0.1";
    }
    assert.equal((await post(path, { body, headers: { Origin: "http://evil.example" } })).status, 403);
    assert.equal((await post(path, { body, headers: { "Sec-Fetch-Site": "cross-site" } })).status, 403);
    assert.equal((await post(path, { body, headers: { "Content-Type": "text/plain" } })).status, 415);
    assert.equal((await post(path, { body, headers: { "Content-Type": "application/x-www-form-urlencoded" } })).status, 415);
  }
  const preflight = await fetch(`${BASE}/api/raci/apply`, { method: "OPTIONS", headers: { Origin: "http://evil.example" } });
  assert.equal(preflight.status, 405);
  assert.equal(preflight.headers.get("access-control-allow-origin"), null);
  assert.deepEqual(recordedCalls(), []);
  assert.deepEqual(scratchLeftovers(), []);
});

test("integ FG-834: the real CLI's gate refusal comes back named with its findings, and admits no apply", async () => {
  useRealForge();
  const res = await post("/api/raci/propose", { body: { projectKey: PROJECT_KEY, candidate: BROKEN } });
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.equal(res.body["refusal"], "gate_failed");
  assert.match(String(res.body["error"]), /no-such-agent/);
  assert.equal(res.body["result"].ok, false);
  const apply = await post("/api/raci/apply", { body: applyBody(BROKEN) });
  assert.equal(apply.body["refusal"], "candidate_not_proposed", "a red propose admits no apply");
  assert.equal(existsSync(join(checkoutDir, ".forge", "forge-raci.md")), false);
  assert.deepEqual(scratchLeftovers(), []);
});

test("integ FG-834: green propose → apply through the real CLI writes the override, recompiles the policy and audits actor, source, rationale and candidate sha", async () => {
  useRealForge();
  const proposed = await post("/api/raci/propose", { body: { projectKey: PROJECT_KEY, candidate: CANDIDATE } });
  assert.equal(proposed.status, 200, JSON.stringify(proposed.body));
  assert.equal(proposed.body["result"].ok, true);
  const modified = proposed.body["result"].routeChanges;
  assert.ok(modified.added.includes("implementation_quick"), "a fresh override reads every route as added");

  const refused = await post("/api/raci/apply", { body: applyBody(CANDIDATE, { confirmKey: "" }) });
  assert.equal(refused.body["refusal"], "confirm_key_mismatch");
  assert.equal(existsSync(join(checkoutDir, ".forge", "forge-raci.md")), false, "refused without the typed key: nothing written");

  const applied = await post("/api/raci/apply", { body: applyBody(CANDIDATE) });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.equal(applied.body["result"].written, true);
  assert.equal(readFileSync(join(checkoutDir, ".forge", "forge-raci.md"), "utf8"), CANDIDATE);
  assert.match(readFileSync(join(checkoutDir, ".forge", "routing-policy.yml"), "utf8"), /frontend-specialist/);
  const audit = readFileSync(join(checkoutDir, ".forge", "raci-audit.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(audit.length, 1);
  assert.equal(audit[0].actor, "dashboard");
  assert.equal(audit[0].action, "apply");
  assert.equal(audit[0].rationale, "route quick implementation to the frontend specialist");
  assert.equal(audit[0].source, "dashboard");
  assert.equal(audit[0].candidate_sha256, sha(CANDIDATE));
  assert.equal(audit[0].candidate_sha256, applied.body["candidateSha256"], "the audit line's sha is the route's own candidate sha");
  assert.equal(existsSync(audit[0].candidate), false, "the recorded candidate path was the removed scratch file");
  assert.deepEqual(scratchLeftovers(), []);

  const view = await getRaci(`?project=${encodeURIComponent(PROJECT_KEY)}`);
  assert.equal(view.body["source"].kind, "project");
  assert.equal(view.body["source"].text, CANDIDATE);
  assert.equal(view.body["audit"].entries.length, 1);
  assert.equal(view.body["audit"].entries[0].actor, "dashboard");
  assert.match(JSON.stringify(view.body["governance"].effective.routes["implementation_quick"]), /frontend-specialist/,
    "the governance view re-reads the applied route");
});
