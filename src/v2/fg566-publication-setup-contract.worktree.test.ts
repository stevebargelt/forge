// FG-566 (ACs 13-18) — the STRUCTURED SETUP CONTRACT, driven through CONSUMER 2.
//
// The publication falsification suite (fg566-publication-readiness.worktree.test.ts)
// was authored in the same fanout as the primitive, so it deliberately imports no
// readiness symbol and exercises exactly one refusal reason (`setup_failed`,
// forced by a lockfile desync). The contract suite covers the grammar, but with an
// injected `runSetup` and no consumer in the picture.
//
// That leaves two things about the RESTATED contract unproven end to end on the
// publication path:
//
//   1. A NEW vocabulary member reaching a consumer. `ambiguous_setup_contract` did
//      not exist before this reopen. A consumer that mishandled it — mapping it to
//      `validation_failed`, or letting the gate run anyway — would be the exact
//      drift the shared vocabulary exists to prevent, and it would be a code
//      verdict for a broken CONFIG. Here the operator declares a shell-shaped
//      contract and the publisher must refuse it BEFORE anything is built: no gate
//      run, nothing published, no ref movement.
//   2. A MULTI-STEP contract actually running against a real candidate worktree.
//      Every existing multi-step assertion is against an injected `runSetup`, so
//      nothing has yet shown two real steps executing in order, in the candidate,
//      under the setup env, with the tree still byte-identical afterwards.
//
// Both are driven through `publishIntegration`'s public surface only, against real
// git worktrees and a real npm project whose single dependency is vendored inside
// the repo (`file:`), so the suite is fully offline.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { getPublicationAttempt } from "../store/publications.js";
import { eventsForRun } from "../store/events.js";
import { insertRun } from "../store/runs.js";
import { publishIntegration, type PublishOutcome, type ValidationResult } from "./integration-publisher.js";
import { localTargetFor, readTargetSha } from "./publication-target.js";

let prevDb: DatabaseInstance | null;
const dirsToRemove: string[] = [];
const filesToRemove: string[] = [];
let savedSetup: string | undefined;

beforeEach(() => {
  prevDb = setDbForTest(makeInMemoryDb());
  savedSetup = process.env["FORGE_HOST_VERIFICATION_SETUP"];
  delete process.env["FORGE_HOST_VERIFICATION_SETUP"];
});

afterEach(() => {
  setDbForTest(prevDb as DatabaseInstance);
  if (savedSetup === undefined) delete process.env["FORGE_HOST_VERIFICATION_SETUP"];
  else process.env["FORGE_HOST_VERIFICATION_SETUP"] = savedSetup;
  for (const f of filesToRemove.splice(0)) rmSync(f, { force: true });
  for (const d of dirsToRemove.splice(0)) rmSync(d, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function commit(dir: string, message: string): string {
  git(dir, ["add", "-A"]);
  git(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", message]);
  return git(dir, ["rev-parse", "HEAD"]);
}

const DEP = "fg566-vendored-dep";

type Fixture = { dir: string; runId: string; gateLog: string; stepLog: string };

/** A genuine offline npm project whose `test:unit` statically imports a bare
 *  specifier — so the gate can only run at all in a workspace that was prepared —
 *  plus a committed `post-install.mjs` a multi-step contract can name as its
 *  second step. Both logs live OUTSIDE the repo: a marker written inside would
 *  also trip the dirtied-by-setup refusal and conflate two facts. */
function makeProject(runId: string): Fixture {
  const root = mkdtempSync(join(tmpdir(), "fg566-contract-"));
  dirsToRemove.push(root);
  const dir = join(root, "project");
  const gateLog = join(root, "gate-runs.jsonl");
  const stepLog = join(root, "setup-steps.jsonl");
  mkdirSync(dir, { recursive: true });

  const depDir = join(dir, "vendor", DEP);
  mkdirSync(depDir, { recursive: true });
  writeFileSync(join(depDir, "package.json"), JSON.stringify({ name: DEP, version: "1.0.0", type: "module", main: "index.js" }));
  writeFileSync(join(depDir, "index.js"), `export const name = ${JSON.stringify(DEP)};\n`);

  writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
  writeFileSync(
    join(dir, "gate.mjs"),
    [
      `import { appendFileSync, existsSync } from "node:fs";`,
      `import { name } from ${JSON.stringify(DEP)};`,
      `appendFileSync(${JSON.stringify(gateLog)}, JSON.stringify({ cwd: process.cwd(), dep: name, nodeModules: existsSync("node_modules") }) + "\\n");`,
    ].join("\n"),
  );
  // The SECOND step of the multi-step contract. It records where it ran and what
  // it ran under, so "the steps really executed, in order, in the candidate, with
  // the reduced env" is read off the child rather than inferred.
  writeFileSync(
    join(dir, "post-install.mjs"),
    [
      `import { appendFileSync, existsSync } from "node:fs";`,
      `appendFileSync(${JSON.stringify(stepLog)}, JSON.stringify({`,
      `  cwd: process.cwd(),`,
      `  nodeModules: existsSync("node_modules"),`,
      `  hasForgeEnv: Object.keys(process.env).some((k) => k.startsWith("FORGE_")),`,
      `}) + "\\n");`,
    ].join("\n"),
  );
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "fg566-contract-fixture", version: "1.0.0", private: true, type: "module",
      scripts: { "test:unit": "node ./gate.mjs" },
      dependencies: { [DEP]: `file:./vendor/${DEP}` },
    }, null, 2),
  );
  execFileSync("npm", ["install", "--package-lock-only", "--no-audit", "--no-fund"], { cwd: dir, stdio: "ignore" });
  mkdirSync(join(dir, ".forge"), { recursive: true });
  writeFileSync(join(dir, ".forge", "config.json"), JSON.stringify({ baseBranch: "main" }));

  git(dir, ["init", "-q", "-b", "main"]);
  commit(dir, "seed");

  insertRun({
    id: runId, workflow: "fg566", title: "fg566 setup contract", status: "active",
    projectDir: dir, createdAt: new Date().toISOString(), metadata: {},
  });

  return { dir, runId, gateLog, stepLog };
}

function branchWithWork(p: Fixture, label: string): string {
  const branch = `forge/${p.runId}/${label}`;
  git(p.dir, ["checkout", "-q", "-b", branch, "main"]);
  writeFileSync(join(p.dir, "agent-work.txt"), "the agent's output\n");
  commit(p.dir, `${label} work`);
  git(p.dir, ["checkout", "-q", "main"]);
  return branch;
}

function jsonl(path: string): Record<string, unknown>[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as Record<string, unknown>);
}

function trackCandidate(out: PublishOutcome): void {
  const wt = (out as { candidateWorktree?: string }).candidateWorktree;
  if (typeof wt === "string" && wt.length > 0) dirsToRemove.push(wt);
}

const ok = (): ValidationResult => ({ ok: true });
const laneOpts = { pollMs: 10, log: () => {} };

// ---------------------------------------------------------------------------
// A NEW vocabulary member, projected by consumer 2.
// ---------------------------------------------------------------------------

test("FG-566 CONTRACT + PUBLISHER — a shell-shaped setup contract is refused `ambiguous_setup_contract` BEFORE anything runs: nothing published, no ref movement, no gate verdict", async () => {
  const runId = "fg566-contract-ambiguous";
  const p = makeProject(runId);
  const branch = branchWithWork(p, "task-a");
  const baseBefore = readTargetSha(localTargetFor(p.dir));

  // Written FOR a shell — which forge is not. Whitespace-splitting it would run
  // `npm` with the literal arguments `ci`, `&&`, `npm`, `run`, `build:native`,
  // and the resulting failure would read like a broken project.
  process.env["FORGE_HOST_VERIFICATION_SETUP"] = "npm ci && npm run build:native";

  let alsoValidateRan = false;
  const out = await publishIntegration({
    runId, taskId: "task-build-1", projectDir: p.dir,
    sources: [{ branch, label: "task" }],
    lane: laneOpts,
    alsoValidate: () => { alsoValidateRan = true; return ok(); },
  });
  trackCandidate(out);

  assert.equal(out.kind, "readiness_failed", `a broken CONTRACT is an environment outcome, not a verdict on the candidate — got ${out.kind}`);
  if (out.kind !== "readiness_failed") return;
  assert.equal(out.reason, "ambiguous_setup_contract", "the NEW vocabulary member must reach the consumer intact, not be flattened into setup_failed");
  assert.match(out.error, /verification_environment_unavailable/, "the shared classification token travels with it");
  assert.match(out.error, /\["npm","ci"\]/, "the refusal is actionable: it shows the argv shape the operator should have written");

  // Nothing ran and nothing moved.
  assert.equal(jsonl(p.gateLog).length, 0, "the gate must NOT run against a workspace forge refused to prepare");
  assert.equal(alsoValidateRan, false, "no part of the validation set runs after a readiness refusal");
  assert.equal(readTargetSha(localTargetFor(p.dir)), baseBefore, "the target ref is byte-identical");
  assert.equal(existsSync(join(p.dir, "agent-work.txt")), false, "the candidate's work is not on the target");
  assert.equal(getPublicationAttempt(out.attemptId)?.publishedSha, undefined);
  assert.equal(getPublicationAttempt(out.attemptId)?.state, "failed");

  const refusals = eventsForRun(runId).filter((e) => e.eventType === "publication.readiness_failed");
  assert.equal(refusals.length, 1, "readiness stops ONCE, with one durable classified record");
  assert.equal((refusals[0]!.payload as Record<string, unknown>)["reason"], "ambiguous_setup_contract");
});

test("FG-566 CONTRACT + PUBLISHER — a contract whose FIRST step fails stops there and names the step; the second step never runs", async () => {
  const runId = "fg566-contract-firstfail";
  const p = makeProject(runId);
  const branch = branchWithWork(p, "task-a");
  const baseBefore = readTargetSha(localTargetFor(p.dir));

  // Step 1 exits non-zero (the node-gyp shape); step 2 would leave an
  // unmistakable mark if the sequence carried on past a failure.
  const marker = join(tmpdir(), `fg566-step2-${process.pid}`);
  filesToRemove.push(marker);
  process.env["FORGE_HOST_VERIFICATION_SETUP"] = JSON.stringify([
    ["node", "-e", `process.stderr.write("FG566_STEP1_FAILED\\n"); process.exit(7)`],
    ["node", "-e", `require("fs").writeFileSync(${JSON.stringify(marker)}, "1")`],
  ]);

  const out = await publishIntegration({
    runId, taskId: "task-build-1", projectDir: p.dir,
    sources: [{ branch, label: "task" }],
    lane: laneOpts,
    alsoValidate: () => ok(),
  });
  trackCandidate(out);

  assert.equal(out.kind, "readiness_failed", `got ${out.kind}`);
  if (out.kind !== "readiness_failed") return;
  assert.equal(out.reason, "setup_failed");
  assert.match(out.error, /step 1 of 2/, "the refusal names WHICH step failed");
  assert.equal(existsSync(marker), false, "the first failure stops the sequence — a step after it must never run");
  assert.equal(jsonl(p.gateLog).length, 0, "the gate must not run");
  assert.equal(readTargetSha(localTargetFor(p.dir)), baseBefore, "no ref movement");

  const payload = eventsForRun(runId).find((e) => e.eventType === "publication.readiness_failed")?.payload as Record<string, unknown>;
  assert.match(String(payload["stderrTail"]), /FG566_STEP1_FAILED/, "the failing step's own stderr is what the operator is handed");
  assert.equal(payload["exitStatus"], 7, "…and its exit status");
});

// ---------------------------------------------------------------------------
// A MULTI-STEP contract, executed for real against a candidate worktree.
// ---------------------------------------------------------------------------

test("FG-566 CONTRACT + PUBLISHER — a MULTI-STEP contract runs both steps IN ORDER in the candidate, and the candidate is still gated GREEN and published unchanged", async () => {
  const runId = "fg566-contract-multistep";
  const p = makeProject(runId);
  const branch = branchWithWork(p, "task-a");

  // The shape the reopen exists to make expressible: install, then build. Under
  // the old bare-string contract this could only have been written `npm ci && node
  // ./post-install.mjs`, which is now refused — this is the replacement, and it
  // has to actually work.
  process.env["FORGE_HOST_VERIFICATION_SETUP"] = JSON.stringify([
    ["npm", "ci", "--no-audit", "--no-fund"],
    ["node", "./post-install.mjs"],
  ]);

  const out = await publishIntegration({
    runId, taskId: "task-build-1", projectDir: p.dir,
    sources: [{ branch, label: "task" }],
    lane: laneOpts,
    alsoValidate: () => ok(),
  });
  trackCandidate(out);

  assert.equal(out.kind, "published", `a multi-step contract must prepare the candidate, not refuse it — got ${out.kind}`);
  if (out.kind !== "published") return;

  // Step 2 ran, AFTER step 1: it saw the node_modules step 1 created, in the
  // candidate worktree, under the reduced setup env.
  const steps = jsonl(p.stepLog);
  assert.equal(steps.length, 1, "the second step ran exactly once");
  assert.equal(steps[0]?.["nodeModules"], true, "step 2 ran AFTER step 1 — order is the contract, not an accident");
  assert.match(String(steps[0]?.["cwd"]), /publications/, "step 2 ran in the per-attempt candidate worktree, not the live checkout");
  assert.equal(steps[0]?.["hasForgeEnv"], false, "the reduced setup env applies to EVERY step, not just the first");

  // The gate then ran to completion against that prepared candidate.
  const runs = jsonl(p.gateLog);
  assert.equal(runs.length, 1, "the gate ran once, to completion — an unprepared workspace dies at module load instead");
  assert.equal(runs[0]?.["nodeModules"], true);

  // …and preparation still did not move the tree it prepared.
  assert.equal(out.publishedSha, out.candidateSha, "the gated tree is the published tree");
  assert.equal(git(p.dir, ["status", "--porcelain"]), "", "the publish target is clean");
  assert.equal(existsSync(join(p.dir, "node_modules")), false, "preparation never installs into the live checkout");
});
