// FG-653: a red that OBEYS its amended seed ingests through the real coordinator path, and one
// that obeys the OLD AWN-5 prose is refused by name.
//
// WHAT THIS TIER ADDS OVER src/v2/fg653-seed-discovery-context.test.ts. That suite reads the seed
// prose and drives `runNextStage` against a hand-written `dispatchLens` closure over an in-memory
// DB. It proves the schema refuses the four keys. It cannot prove the thing the ticket is actually
// about: that a reviewer's result.json, travelling the SAME seam a container's does
// (invoke → InvokeResult.result → assessLens → normalize → ingestFindings), lands in a DURABLE
// ledger — and that the FG-650 ROOT tolerance the seed-compliant shape DEPENDS ON is still there
// underneath it. So this file binds `buildCoordinatorDeps` with only the container `invoke`
// stubbed, over a real git repo and a real on-disk SQLite store that is closed and reopened.
//
// The three claims, each of which can regress independently:
//
//   AC-5  FG-650's tolerate-and-record is UNCHANGED. The seed-compliant shape is
//         `{status, verdict, confidence, notes}` (the harness output contract, which the reviewer
//         has no choice about) + `{outcome, findings}`. Those four root keys must still be
//         tolerated, STRIPPED, and RECORDED as `toleratedRootKeys` — including root `confidence`,
//         which the seed forbids INSIDE a finding while the harness mandates it at the ROOT. That
//         pair is the whole tolerance boundary in one result.
//
//   AC-1  A seed-compliant panel ingests, findings intact, `finding_type` surviving as the one
//         AWN-5 field the amended seed keeps, and `disposition` untriaged — the ledger's to set.
//
//   AC-3  Each of the four keys the OLD prose taught refuses the ENTIRE lens `malformed_output`,
//         naming the key; and one refused lens leaves the whole panel INCOMPLETE, ingesting
//         nothing even from the lenses that complied. That is the cost the seeds now state.
//
// Per the tier rule in docs/how-to-testing.md: real repos and an on-disk DB are integration-tier
// fixtures, and no test here creates a git worktree. `verify` and `shippingInput` are the same two
// deps fg650-lens-root-tolerance.integration.test.ts stubs — they would run host verification and
// fetch a remote tip that does not exist here. Everything FG-653 touches is real.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { applyMigrations, setDbForTest } from "../store/db.js";
import { SCHEMA_SQL } from "../store/schema.js";
import { insertRun } from "../store/runs.js";
import { findingsForReview, getReview, insertReview, type Review } from "../store/reviews.js";
import { fixBatchesForReview } from "../store/fix-batches.js";
import { RISK_LENSES, lensForRole, lensRole } from "./review-contract.js";
import { buildCoordinatorDeps } from "../cli/commands/review-wiring.js";
import { runNextStage, type CoordinatorDeps } from "./review-run.js";
import { nextTransition, type TransitionKind } from "./review-coordinator.js";
import type { InvokeArgs, InvokeResult } from "./invoke.js";
import type { Run } from "../types/index.js";

const RUN_ID = "run-fg653-integ";
const REVIEW = "review-fg653-integ";
const TICKET = "FG-653";

/** The four AWN-5 enrichment keys the amended seeds now scope to the LEGACY VERDICT path. Named
 *  once so every assertion below is about the same set the seed prose names. */
const FORBIDDEN_ON_DISCOVERY = ["confidence", "affected_files", "recommended_fix", "disposition"] as const;

/** The root keys the HARNESS output contract puts on every agent's result.json — not reviewer
 *  garnish. Sorted, because `toleratedRootKeys` records them sorted. `confidence` is here AND in
 *  FORBIDDEN_ON_DISCOVERY on purpose: that is the tolerance boundary FG-650 drew and FG-653 relies
 *  on — tolerated at the root, refused inside a finding. */
const HARNESS_KEYS = ["confidence", "notes", "status", "verdict"];

const RUN: Run = {
  id: RUN_ID,
  workflow: "feature",
  title: "fg653",
  status: "active",
  createdAt: "2026-07-31T00:00:00Z",
  reviewMode: "evidence_led",
};

const CONTRACT = {
  threat_model: "an operator-trusted candidate reviewed by the five composed red lens prompts",
  protected_invariants: ["a seed-compliant reviewer outcome is never refused"],
  acceptance_refs: ["FG-653 AC 1"],
  risk_lenses: [...RISK_LENSES],
  non_goals: ["relaxing nested validation", "changing any schema"],
};

let dbFile: string;
let openDbs: DatabaseInstance[] = [];
let prev: DatabaseInstance | null = null;
let repo: string;
let tmpDirs: string[] = [];
let baseSha: string;
let entrySha: string;

function git(args: string[]): string {
  const res = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  assert.equal(res.status, 0, `git ${args.join(" ")} failed: ${res.stderr}`);
  return res.stdout;
}

const head = (): string => git(["rev-parse", "HEAD"]).trim();

/** A REAL on-disk store, so the close/reopen below is a genuine process restart rather than a
 *  same-handle read of an object that never left memory. */
function openStore(): DatabaseInstance {
  const db = new Database(dbFile);
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  applyMigrations(db);
  openDbs.push(db);
  const previous = setDbForTest(db);
  if (prev === null) prev = previous;
  return db;
}

/** Close the store and open the same FILE again — what a later forge process does. */
function restartProcess(): void {
  openDbs.pop()?.close();
  const db = new Database(dbFile);
  db.pragma("foreign_keys = ON");
  openDbs.push(db);
  setDbForTest(db);
}

beforeEach(() => {
  const home = mkdtempSync(join(tmpdir(), "fg653-store-"));
  tmpDirs.push(home);
  dbFile = join(home, "forge.db");
  openStore();
  insertRun(RUN);

  repo = mkdtempSync(join(tmpdir(), "fg653-repo-"));
  tmpDirs.push(repo);
  git(["init", "-q", "-b", "main", "."]);
  // Identity is LOCAL on purpose: src/test-setup.ts neutralizes the global git config, so a
  // commit borrowing the operator's identity would fail on CI and prove nothing.
  git(["config", "user.email", "forge@example.com"]);
  git(["config", "user.name", "forge"]);
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "package.json"), `{"name":"candidate","private":true}\n`);
  writeFileSync(join(repo, "src", "reconcile.ts"), "export function reconcile() {\n  write(rowA);\n}\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "seed the candidate"]);
  baseSha = head();
  appendFileSync(
    join(repo, "src", "reconcile.ts"),
    "\nexport function reconcileBoth() {\n  write(rowA);\n  write(rowB);\n}\n",
  );
  git(["add", "-A"]);
  git(["commit", "-qm", "reconcile: write both rows in one path"]);
  entrySha = head();

  insertReview({
    id: REVIEW,
    runId: RUN_ID,
    ticketId: TICKET,
    reviewMode: "evidence_led",
    baseSha,
    candidateSha: entrySha,
    contract: CONTRACT,
    state: "confirming_contract",
  });
});

afterEach(() => {
  for (const db of openDbs) {
    try {
      db.close();
    } catch {
      // already closed by restartProcess
    }
  }
  openDbs = [];
  if (prev !== null) setDbForTest(prev);
  prev = null;
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs = [];
});

// ─── the fixture harness ────────────────────────────────────────────────────

const lineFor = (lens: string): number => (RISK_LENSES as readonly string[]).indexOf(lens) + 400;

/** ONE finding, authored exactly as the AMENDED seed instructs a discovery lens to author it:
 *  `remediation_advice` rather than `recommended_fix`; every implicated file named INSIDE
 *  `evidence` rather than in an `affected_files` array; how well-supported it is carried in
 *  `reachability` rather than `confidence`; no `disposition` anywhere; and `finding_type` as the
 *  one AWN-5 field the seed says a discovery finding also accepts. */
function seedCompliantFinding(lens: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    summary: `${lens}: the reconcile path writes before it commits`,
    evidence: `src/reconcile.ts:${lineFor(lens)} — and src/store/reviews.ts, also implicated`,
    severity: "high",
    risk_lens: lens,
    reachability: "supported",
    challenges_contract: false,
    remediation_advice: "advice: consider committing inside the same transaction as the write",
    finding_type: "correctness",
    file: "src/reconcile.ts",
    line: lineFor(lens),
    invariant_ref: "a seed-compliant reviewer outcome is never refused",
    ...over,
  };
}

/** The result.json a red container writes: the harness output contract's mandated root keys
 *  (tolerated since FG-650) wrapped around the discovery `outcome` + `findings` payload. */
function reviewerResult(body: Record<string, unknown>): Record<string, unknown> {
  return {
    status: "complete",
    verdict: body["outcome"] === "fail" ? "fail" : "pass",
    confidence: 0.9,
    notes: "reviewed the reconcile path against the contract",
    ...body,
  };
}

const seedCompliant = (lens: string, over: Record<string, unknown> = {}): Record<string, unknown> =>
  reviewerResult({ outcome: "fail", findings: [seedCompliantFinding(lens, over)] });

type LensBehaviour = (lens: string) => unknown;

type Harness = {
  deps: CoordinatorDeps;
  calls: InvokeArgs[];
  dispatches: (role: string) => InvokeArgs[];
};

function harness(lensBehaviour: LensBehaviour = (lens) => seedCompliant(lens)): Harness {
  const calls: InvokeArgs[] = [];

  const invokeFn = async (args: InvokeArgs): Promise<InvokeResult> => {
    calls.push(args);
    const lens = lensForRole(args.agentRole);
    assert.ok(lens !== undefined, `this suite reaches discovery only; it dispatched ${args.agentRole}`);
    return {
      runId: RUN_ID,
      taskId: `task-${args.agentRole}-${calls.length}`,
      status: "complete",
      result: lensBehaviour(lens),
    };
  };

  const wiring = buildCoordinatorDeps({
    projectDir: repo,
    ticketId: TICKET,
    runId: RUN_ID,
    invokeFn,
    evaluatedNoDrift: "the implementation diff touches src/reconcile.ts only; the selected lenses already cover it",
  });

  const deps: CoordinatorDeps = {
    ...wiring,
    verify: (sha: string) => ({ ok: true, sha, executedRequiredChecks: true, detail: "reused green CI" }),
    shippingInput: () => {
      throw new Error("the shipping stage is not reached by this suite");
    },
  };

  return { deps, calls, dispatches: (role) => calls.filter((c) => c.agentRole === role) };
}

/** The next transition as a FRESH process would read it — from the persisted rows only. */
function pending() {
  return nextTransition({
    review: getReview(REVIEW) as Review,
    findings: findingsForReview(REVIEW),
    batches: fixBatchesForReview(REVIEW),
  });
}

/** Drive real stages until the PERSISTED next transition is `target`, leaving the review parked
 *  exactly at that boundary so the stage under test is the next one to run. */
async function parkAt(deps: CoordinatorDeps, target: TransitionKind, max = 12): Promise<void> {
  for (let i = 0; i < max; i += 1) {
    if (pending().kind === target) return;
    const outcome = await runNextStage(REVIEW, deps);
    assert.notEqual(outcome.status, "refused", `parking at ${target}: ${outcome.transition.kind} — ${outcome.message}`);
  }
  assert.fail(`never reached ${target} (stuck at ${pending().kind}: ${pending().reason})`);
}

function discoveryStage() {
  return getReview(REVIEW)?.stageEvidence?.discovery;
}

function toleratedInDiscovery(): Array<{ lens: string; keys: string[] }> {
  return (discoveryStage()?.meta?.["toleratedRootKeys"] ?? []) as Array<{ lens: string; keys: string[] }>;
}

function outcomeFor(lens: string): Record<string, unknown> {
  const outcomes = (getReview(REVIEW)?.lensOutcomes ?? []) as Array<Record<string, unknown>>;
  const found = outcomes.find((o) => o["lens"] === lens);
  assert.ok(found !== undefined, `no persisted outcome for the ${lens} lens`);
  return found;
}

/** Run discovery itself and return ITS outcome. Nothing about the reviewer's output is
 *  pre-validated on the way: it travels invoke → assessLens → normalize → ingestFindings exactly
 *  as a container's result.json does. */
async function runDiscovery(deps: CoordinatorDeps) {
  await parkAt(deps, "discover");
  const outcome = await runNextStage(REVIEW, deps);
  assert.equal(outcome.transition.kind, "discover", "the stage under test must be discovery");
  return outcome;
}

// ─── AC-1 + AC-5: a seed-compliant panel ingests, and the ROOT tolerance carries it ──

test("integ FG-653: a panel authored exactly as the five amended seeds instruct ingests through the real dispatch seam, findings intact", async () => {
  // RED baseline: revert the AWN-5 context split in the seeds and a red that follows its own seed
  // emits `confidence`/`affected_files`/`recommended_fix`/`disposition` inside each finding —
  // every lens then refuses `malformed_output` (asserted below), which is the live defect.
  const h = harness();
  const outcome = await runDiscovery(h.deps);

  assert.equal(outcome.status, "advanced", `a seed-compliant panel must complete discovery — got: ${outcome.message}`);
  for (const lens of RISK_LENSES) {
    assert.equal(h.dispatches(lensRole(lens)).length, 1, `the ${lens} lens really ran through the invoke seam`);
  }

  const findings = findingsForReview(REVIEW);
  assert.equal(findings.length, RISK_LENSES.length, "one finding per lens survived ingestion");
  for (const lens of RISK_LENSES) {
    const f = findings.find((x) => x.riskLens === lens);
    assert.ok(f, `the ${lens} lens finding reached the ledger`);
    assert.equal(f.summary, `${lens}: the reconcile path writes before it commits`);
    assert.equal(
      f.evidence,
      `src/reconcile.ts:${lineFor(lens)} — and src/store/reviews.ts, also implicated`,
      "the seed's 'name every implicated file inside evidence' instruction survives ingestion verbatim",
    );
    assert.equal(f.reachability, "supported", "reachability carries support, which is what replaced confidence");
    assert.equal(f.findingType, "correctness", "finding_type IS legal on the discovery path");
    assert.equal(f.file, "src/reconcile.ts");
    assert.equal(f.line, lineFor(lens));
    assert.equal(f.disposition, "untriaged", "the ledger — not the reviewer — authors a durable disposition");
  }
});

test("integ FG-653: the seed-compliant shape RESTS on FG-650 root tolerance — the harness keys are stripped, recorded per lens, and durable", async () => {
  // AC-5, on the real path. The amended seed tells the reviewer to keep emitting result.json in the
  // harness's own shape; that only ingests because FG-650 tolerates unknown ROOT keys. If root
  // strictness were ever restored, every seed-compliant reviewer would be refused again — so the
  // tolerance is asserted here as a precondition of FG-653, not merely as FG-650's own business.
  const h = harness();
  assert.equal((await runDiscovery(h.deps)).status, "advanced");

  const tolerated = toleratedInDiscovery();
  assert.deepEqual(
    tolerated.map((t) => t.lens).sort(),
    [...RISK_LENSES].sort(),
    "every lens that carried the harness's mandated keys is named in the durable stage record",
  );
  for (const t of tolerated) {
    assert.deepEqual(t.keys, HARNESS_KEYS, `${t.lens} records exactly the stripped root keys, sorted`);
  }

  // STRIPPED, not passed through: a validator that merely stopped refusing would leave `status`
  // sitting unnamed on the persisted outcome, and this is what tells the two apart.
  for (const lens of RISK_LENSES) {
    const persisted = outcomeFor(lens);
    assert.deepEqual(persisted["toleratedRootKeys"], HARNESS_KEYS);
    assert.equal(persisted["outcome"], "fail");
    for (const key of HARNESS_KEYS) {
      assert.equal(persisted[key], undefined, `'${key}' was stripped from the ${lens} outcome, not carried on it`);
    }
  }

  // DURABILITY: the forge process that recorded it exits, and another opens the same file. A
  // tolerance record an operator cannot read back later is not a record.
  restartProcess();
  const afterRestart = toleratedInDiscovery();
  assert.deepEqual(afterRestart.map((t) => t.lens).sort(), [...RISK_LENSES].sort());
  for (const t of afterRestart) assert.deepEqual(t.keys, HARNESS_KEYS);
  assert.equal(findingsForReview(REVIEW).length, RISK_LENSES.length, "and the findings outlived the process too");
});

test("integ FG-653: root `confidence` is tolerated in the SAME result whose finding-level `confidence` would be refused", async () => {
  // The single most confusable pair in the amended prose. The harness mandates `confidence` at the
  // ROOT; the seed forbids it INSIDE a finding. Asserting them apart proves the tolerance boundary
  // is drawn where the seed says it is — a reviewer that reads "confidence is forbidden" as a rule
  // about the whole document would drop a harness-required key for no reason.
  const compliant = harness();
  assert.equal((await runDiscovery(compliant.deps)).status, "advanced");
  assert.ok(
    toleratedInDiscovery().every((t) => t.keys.includes("confidence")),
    "root confidence was tolerated and recorded on every lens",
  );
});

// ─── AC-3: each key the old prose taught refuses the WHOLE lens, by name ────

for (const key of FORBIDDEN_ON_DISCOVERY) {
  test(`integ FG-653: a discovery finding carrying \`${key}\` refuses the whole lens malformed_output and ingests nothing`, async () => {
    const over = { [key]: key === "confidence" ? 0.9 : key === "affected_files" ? ["src/reconcile.ts"] : "x" };
    const h = harness((lens) => seedCompliant(lens, over));
    const outcome = await runDiscovery(h.deps);

    assert.equal(outcome.status, "refused", `a discovery finding carrying ${key} must not validate`);
    assert.match(outcome.message, /discovery is INCOMPLETE/);
    assert.match(outcome.message, /malformed_output/);
    assert.ok(
      outcome.message.includes(key),
      `the refusal must NAME ${key}, or the reviewer cannot tell which field cost it the lens — got: ${outcome.message}`,
    );
    assert.equal(findingsForReview(REVIEW).length, 0, "a refused lens ingests nothing");
    assert.equal(discoveryStage(), undefined, "and records no stage — an incomplete panel is not a completed one");
  });
}

test("integ FG-653: renaming remediation_advice to recommended_fix fails on BOTH counts — the seed keeps the field for a reason", async () => {
  const h = harness((lens) => {
    const f = seedCompliantFinding(lens);
    delete f["remediation_advice"];
    return reviewerResult({ outcome: "fail", findings: [{ ...f, recommended_fix: "commit inside the transaction" }] });
  });
  const outcome = await runDiscovery(h.deps);

  assert.equal(outcome.status, "refused");
  assert.ok(outcome.message.includes("remediation_advice"), "the missing required field is named");
  assert.ok(outcome.message.includes("recommended_fix"), "and so is the unknown one it was renamed to");
  assert.equal(findingsForReview(REVIEW).length, 0);
});

test("integ FG-653: ONE non-compliant lens costs the WHOLE panel — the compliant lenses' findings are not ingested either", async () => {
  // The consequence the amended seeds state ("refuses your ENTIRE lens output", and discovery then
  // records that nobody reviewed that lens). Four lenses obeying the new prose do not rescue a
  // fifth that obeyed the old prose: discovery is complete only when EVERY selected lens has a
  // schema-valid authored outcome.
  const h = harness((lens) => (lens === "security" ? seedCompliant(lens, { disposition: "confirmed" }) : seedCompliant(lens)));
  const outcome = await runDiscovery(h.deps);

  assert.equal(outcome.status, "refused");
  assert.ok(outcome.message.includes("security (malformed_output"), `the offending lens is named — got: ${outcome.message}`);
  for (const lens of RISK_LENSES) {
    if (lens === "security") continue;
    assert.ok(!outcome.message.includes(`${lens} (`), `the compliant ${lens} lens is not blamed`);
  }
  assert.equal(findingsForReview(REVIEW).length, 0, "no partial panel is ingested");
  assert.equal(discoveryStage(), undefined);

  // And it is recoverable exactly the way the model says: retry the lens. Nothing was corrupted by
  // the refusal, and the retry ingests the full panel.
  const retry = harness();
  assert.equal((await runNextStage(REVIEW, retry.deps)).status, "advanced", "a retried compliant panel completes");
  assert.equal(findingsForReview(REVIEW).length, RISK_LENSES.length);
});

test("integ FG-653: an invented key inside a finding is still refused — FG-653 changed prose, not nested strictness", async () => {
  const h = harness((lens) => seedCompliant(lens, { blast_radius: "the whole reconcile path" }));
  const outcome = await runDiscovery(h.deps);

  assert.equal(outcome.status, "refused");
  assert.match(outcome.message, /malformed_output/);
  assert.ok(outcome.message.includes("blast_radius"));
  assert.equal(findingsForReview(REVIEW).length, 0);
});
