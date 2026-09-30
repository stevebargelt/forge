// FG-834 enforcement coverage: exercise the RACI mutation handler through HTTP with a
// closed project registry, a recording forge executable, and an injectable proposal clock.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { ProjectRecord } from "./queries.js";
import { ProposalWindow, handleRaciMutation, raciScratchRoot } from "./raci-mutation.js";

const PORT = 18835;
const BASE = `http://127.0.0.1:${PORT}`;
const home = mkdtempSync(join(tmpdir(), "fg834-enforcement-home-"));
const projectA = mkdtempSync(join(tmpdir(), "fg834-enforcement-a-"));
const projectB = mkdtempSync(join(tmpdir(), "fg834-enforcement-b-"));
const rig = mkdtempSync(join(tmpdir(), "fg834-enforcement-rig-"));
const callsPath = join(rig, "calls.log");
const seenPath = join(rig, "candidate.bin");
const stub = join(rig, "forge-stub");

process.env.FORGE_HOME = home;
process.env.FORGE_BIN = stub;
process.env.HOST = "127.0.0.1";
process.env.PORT = String(PORT);
delete process.env.FORGE_DASHBOARD_ALLOW_REMOTE_MUTATIONS;
delete process.env.FORGE_DASHBOARD_ORIGIN;

writeFileSync(callsPath, "");
writeFileSync(
  stub,
  [
    "#!/bin/sh",
    `{ printf 'CALL\\n'; for value in "$@"; do printf 'ARG\\t%s\\n' "$value"; done; } >> "${callsPath}"`,
    `if [ -f "$3" ]; then cp "$3" "${seenPath}"; fi`,
    'if [ -n "$STUB_HOLD" ]; then while [ ! -e "$STUB_HOLD" ]; do sleep 0.02; done; fi',
    'if [ -n "$STUB_FAIL" ]; then printf "stub refusal\\n" >&2; exit 1; fi',
    'printf \'{"ok":true,"written":true}\\n\'',
  ].join("\n"),
);
chmodSync(stub, 0o755);

function record(key: string, dir: string): ProjectRecord {
  return {
    key,
    label: key,
    projectDirs: [dir],
    checkouts: [{ projectDir: dir, exists: true }],
  } as unknown as ProjectRecord;
}

const projects = new Map([
  ["project-a", record("project-a", projectA)],
  ["project-b", record("project-b", projectB)],
]);
let now = Date.parse("2026-09-30T12:00:00Z");
const window = new ProposalWindow();

const server = createServer((req, res) => {
  void handleRaciMutation(req, res, new URL(req.url ?? "/", BASE).pathname, {
    resolveProject: (key) => projects.get(key),
    actor: "dashboard",
    now: () => now,
    window,
  });
});
await new Promise<void>((resolve) => server.listen(PORT, "127.0.0.1", resolve));

after(() => {
  server.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(projectA, { recursive: true, force: true });
  rmSync(projectB, { recursive: true, force: true });
  rmSync(rig, { recursive: true, force: true });
});

const sha = (candidate: string) => createHash("sha256").update(candidate, "utf8").digest("hex");
const candidate = "# RACI\\nroute: ordinary\\n";

function resetCalls(): void {
  writeFileSync(callsPath, "");
  rmSync(seenPath, { force: true });
  delete process.env.STUB_FAIL;
  delete process.env.STUB_HOLD;
}

function calls(): string[][] {
  const output: string[][] = [];
  for (const line of readFileSync(callsPath, "utf8").split("\n")) {
    if (line === "CALL") output.push([]);
    else if (line.startsWith("ARG\t")) output.at(-1)?.push(line.slice(4));
  }
  return output;
}

function leftovers(): string[] {
  return existsSync(raciScratchRoot()) ? readdirSync(raciScratchRoot()) : [];
}

async function post(path: string, body: Record<string, unknown>, headers: Record<string, string> = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: BASE, ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: JSON.parse(await response.text()) as Record<string, unknown> };
}

function apply(projectKey: string, text: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { projectKey, candidate: text, proposedSha256: sha(text), confirmKey: projectKey, rationale: "enforcement regression", ...extra };
}

test("FG-834 enforcement: a green proposal is scoped to its registry project and caller paths cannot select another checkout", async () => {
  resetCalls();
  const proposed = await post("/api/raci/propose", { projectKey: "project-a", projectDir: "/caller/supplied", candidate });
  assert.equal(proposed.status, 200, JSON.stringify(proposed.body));
  assert.deepEqual(calls()[0]?.slice(0, 6), ["raci", "propose", calls()[0]?.[2], "--project", projectA, "--json"]);

  resetCalls();
  const otherProject = await post("/api/raci/apply", apply("project-b", candidate));
  assert.equal(otherProject.status, 409);
  assert.equal(otherProject.body.refusal, "candidate_not_proposed");
  assert.deepEqual(calls(), [], "same bytes proposed for project A do not authorize project B");

  const unregistered = await post("/api/raci/propose", { projectKey: "not-registered", candidate });
  assert.equal(unregistered.status, 404);
  assert.deepEqual(calls(), [], "unregistered projects are refused before resolving or spawning forge");
});

test("FG-834 enforcement: expiry and a one-byte candidate change are refused before any write", async () => {
  resetCalls();
  const expiring = `${candidate}expiry-${now}`;
  assert.equal((await post("/api/raci/propose", { projectKey: "project-a", candidate: expiring })).status, 200);
  now += 15 * 60 * 1000 + 1;
  resetCalls();
  const expired = await post("/api/raci/apply", apply("project-a", expiring));
  assert.equal(expired.status, 409);
  assert.equal(expired.body.refusal, "candidate_not_proposed");
  assert.deepEqual(calls(), []);

  const original = `${candidate}byte-${now}`;
  assert.equal((await post("/api/raci/propose", { projectKey: "project-a", candidate: original })).status, 200);
  resetCalls();
  const changed = `${original}!`;
  const changedResponse = await post("/api/raci/apply", apply("project-a", changed, { proposedSha256: sha(original) }));
  assert.equal(changedResponse.status, 409);
  assert.equal(changedResponse.body.refusal, "candidate_changed");
  assert.deepEqual(calls(), []);
  assert.equal(existsSync(join(projectA, ".forge", "forge-raci.md")), false, "a refused apply writes no override");
  assert.deepEqual(leftovers(), []);
});

test("FG-834 enforcement: candidate bytes never enter argv, failed children clean their scratch files, and 300 KiB is rejected", async () => {
  resetCalls();
  const hostile = "# RACI\\n-leading-dash\\n$(touch nope); ; | & $HOME\\nNUL:\u0000:end\\n";
  process.env.STUB_FAIL = "1";
  const refused = await post("/api/raci/propose", { projectKey: "project-a", candidate: hostile });
  assert.equal(refused.status, 409);
  assert.deepEqual(readFileSync(seenPath), Buffer.from(hostile, "utf8"), "the scratch file preserves exact UTF-8 bytes, including NUL");
  assert.ok(!calls()[0]!.some((argument) => argument.includes("$(touch nope)")), "candidate text is never an argv element");
  assert.deepEqual(leftovers(), [], "scratch directories are removed when forge exits non-zero");

  resetCalls();
  const oversized = await post("/api/raci/propose", { projectKey: "project-a", candidate: "x".repeat(300 * 1024) });
  assert.equal(oversized.status, 413);
  assert.deepEqual(calls(), []);
  assert.deepEqual(leftovers(), []);
});

test("FG-834 enforcement: both routes run the shared guards before spawn and the shared mutation slot bounds concurrent children", async () => {
  resetCalls();
  for (const path of ["/api/raci/propose", "/api/raci/apply"]) {
    const body = path.endsWith("apply") ? apply("project-a", candidate) : { projectKey: "project-a", candidate };
    assert.equal((await post(path, body, { Origin: "http://evil.example" })).status, 403);
    assert.equal((await post(path, body, { "Content-Type": "text/plain" })).status, 415);
  }
  process.env.HOST = "0.0.0.0";
  try {
    assert.equal((await post("/api/raci/propose", { projectKey: "project-a", candidate })).status, 403);
    assert.equal((await post("/api/raci/apply", apply("project-a", candidate))).status, 403);
  } finally {
    process.env.HOST = "127.0.0.1";
  }
  assert.deepEqual(calls(), []);

  const hold = join(rig, "release-children");
  process.env.STUB_HOLD = hold;
  const active = Array.from({ length: 4 }, (_, index) => post("/api/raci/propose", { projectKey: "project-a", candidate: `${candidate}slot-${now}-${index}` }));
  for (let attempt = 0; attempt < 100 && calls().length < 4; attempt += 1) await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls().length, 4, "four shared mutation slots are occupied");
  const rejected = await post("/api/raci/propose", { projectKey: "project-a", candidate: `${candidate}slot-overflow-${now}` });
  assert.equal(rejected.status, 503);
  writeFileSync(hold, "release");
  assert.deepEqual((await Promise.all(active)).map((response) => response.status), [200, 200, 200, 200]);
  delete process.env.STUB_HOLD;
  assert.deepEqual(leftovers(), []);
});
