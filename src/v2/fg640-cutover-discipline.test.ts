// FG-640: the cutover is a PER-WORKFLOW DECLARATION, stamped once per run, and never combined.
//
// Three migration-safety bullets, each written as behavior rather than as a field read:
//
//   1. AN UNMIGRATED WORKFLOW IS UNCHANGED. Not "declares legacy_verdict" — a workflow file with
//      NO `review_mode:` line at all, which is what every shipped workflow but `feature` still
//      looks like. Proved by snapshotting the whole observable gate surface for the key-absent and
//      the key-present-legacy workflows and requiring equality, so a future change that makes the
//      default do something reddens here rather than in whichever workflow notices first.
//
//   2. STAMPED ONCE, AT CREATION. The run row's mode is fixed when the run is created; editing the
//      workflow file mid-run cannot move it. Both directions of the resulting disagreement are
//      pinned, INCLUDING the one that is currently asymmetric — see the drift tests below.
//
//   3. NEVER COMBINED WITHIN ONE RUN. One run, two reviewed steps, one of them half-migrated: the
//      half-migrated step refuses by name while the migrated one settles. A workflow-level
//      declaration is the only declaration there is, so a step cannot opt itself out.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest, getDb } from "../store/db.js";
import { insertRun, getRun } from "../store/runs.js";
import { insertTask, getTask } from "../store/tasks.js";
import { insertVerdict } from "../store/verdicts.js";
import { gatesForTask } from "../store/gates.js";
import { insertReview, ingestFindings, recordStageEvidence, setReviewState } from "../store/reviews.js";
import { gate } from "./gate.js";
import { startRun } from "./startRun.js";
import { loadWorkflow } from "./loader.js";
import { resolveSeedGeneration } from "./seed-generation.js";
import { WorkflowSchema } from "./schema.js";
import { publishFlatAsGeneration } from "./seed-generation.testkit.js";
import type { Run, Task, ReviewMode } from "../types/index.js";

const SHA = "cand640cut";
const RUN_ID = "run-cut";

const CONTRACT = {
  threat_model: "a run that changed authority models underneath itself",
  protected_invariants: ["one review_mode per run"],
  acceptance_refs: ["FG-640 AC 18"],
  risk_lenses: ["backend"],
  non_goals: [],
};

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
let originalForgeHome: string | undefined;
let homeDir: string;

/** `modeLine` is the literal text of the cutover declaration — "" writes a workflow with no
 *  `review_mode:` key at all, which is the shape every unmigrated workflow has. */
function writeWorkflow(name: string, modeLine: string, body?: string): void {
  mkdirSync(join(homeDir, "workflows"), { recursive: true });
  writeFileSync(
    join(homeDir, "workflows", `${name}.yml`),
    `name: ${name}
description: test
${modeLine}inputs: []
steps:
${
      body ??
      `  - id: build
    agent: engineer
    gate: verdict
    reds:
      - agent: red-backend
        authority: authoritative
        gate_on_verdict: true
`
    }`,
  );
  publishFlatAsGeneration(homeDir);
}

function seedRun(workflow: string, reviewMode: ReviewMode | undefined, phases: string[] = ["build"]): Run {
  const run: Run = {
    id: RUN_ID,
    workflow,
    title: "cutover discipline",
    status: "active",
    createdAt: "2026-07-30T00:00:00Z",
    ...(reviewMode !== undefined ? { reviewMode } : {}),
  };
  insertRun(run);
  for (const phase of phases) {
    const id = `task-${phase}`;
    const task: Task = {
      id,
      runId: run.id,
      phase,
      agentRole: "engineer",
      status: "awaiting_gate",
      taskPackage: { taskId: id, runId: run.id, phase, role: "engineer", inputs: {}, composedSystemPrompt: "P" },
      createdAt: "2026-07-30T00:00:00Z",
    };
    insertTask(task);
  }
  return run;
}

function checks(): unknown[] {
  return [
    { id: "verification_green", ok: true, detail: "green" },
    { id: "acceptance_mapped", ok: true, detail: "1 acceptance criterion met on executed evidence" },
    { id: "findings_settled", ok: true, detail: "settled" },
    { id: "fix_now_resolved", ok: true, detail: "resolved" },
    { id: "tip_equality", ok: true, detail: "equal" },
    { id: "identity_continuity", ok: true, detail: "continuous" },
    { id: "contract_covers_diff", ok: true, detail: "covered" },
    { id: "docs_closeout", ok: true, detail: "no gaps" },
  ];
}

function settledLedger(reviewMode: ReviewMode, id = "review-cut"): void {
  insertReview({
    id,
    runId: RUN_ID,
    ticketId: "FG-640",
    reviewMode,
    candidateSha: SHA,
    contractConfirmedSha: SHA,
    trustedRemoteSha: SHA,
    contract: CONTRACT,
    lensOutcomes: [{ lens: "backend", role: "red-backend", complete: true, outcome: "pass", authored: true, findings: [] }],
    state: "shipping_review",
  });
  recordStageEvidence(id, "verified_final", { sha: SHA, detail: `green CI at ${SHA}` });
  recordStageEvidence(id, "shipping", { sha: SHA, detail: "shipping", meta: { checks: checks() } });
  setReviewState(id, "settled");
}

function authoritativeFail(taskId: string, id: string): void {
  const redTask = `${id}-red`;
  insertTask({
    id: redTask,
    runId: RUN_ID,
    phase: "red",
    agentRole: "red-backend",
    status: "complete",
    taskPackage: { taskId: redTask, runId: RUN_ID, phase: "red", role: "red-backend", inputs: {}, composedSystemPrompt: "P" },
    createdAt: "2026-07-30T00:00:00Z",
  });
  insertVerdict({
    id,
    taskId,
    redTaskId: redTask,
    redRole: "red-backend",
    verdict: "fail",
    confidence: 0.9,
    authority: "authoritative",
    findings: [],
    createdAt: "2026-07-30T00:00:01Z",
    gateOnVerdict: true,
  });
}

async function attempt(taskId: string, rationale?: string, force = false): Promise<string> {
  try {
    const r = await gate(taskId, "advance", rationale, force ? { force: true } : {});
    return `advanced:${r.task.status}`;
  } catch (e) {
    return (e as Error).message;
  }
}

beforeEach(() => {
  originalForgeHome = process.env.FORGE_HOME;
  homeDir = mkdtempSync(join(tmpdir(), "forge-fg640-cut-"));
  process.env.FORGE_HOME = homeDir;
  db = makeInMemoryDb();
  prev = setDbForTest(db);
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
  if (originalForgeHome === undefined) delete process.env.FORGE_HOME;
  else process.env.FORGE_HOME = originalForgeHome;
  rmSync(homeDir, { recursive: true, force: true });
});

// ── 1. a workflow with NO review_mode key is byte-identical to pre-FG-640 ─────

/** Everything an operator or a caller can observe about a gate on this workflow, as one value. */
async function gateSurface(modeLine: string): Promise<unknown> {
  writeWorkflow("wf-snap", modeLine);
  db.close();
  db = makeInMemoryDb();
  setDbForTest(db);

  const loaded = loadWorkflow("wf-snap", { seedGeneration: resolveSeedGeneration() });
  const { runId } = startRun({ workflow: loaded, title: "snapshot", inputs: {}, projectDir: "/tmp/fg640-cut" });
  for (const id of ["task-clean", "task-red"]) {
    insertTask({
      id,
      runId,
      phase: "build",
      agentRole: "engineer",
      status: "awaiting_gate",
      taskPackage: { taskId: id, runId, phase: "build", role: "engineer", inputs: {}, composedSystemPrompt: "P" },
      createdAt: "2026-07-30T00:00:00Z",
    });
  }
  insertTask({
    id: "red-runner",
    runId,
    phase: "red",
    agentRole: "red-backend",
    status: "complete",
    taskPackage: { taskId: "red-runner", runId, phase: "red", role: "red-backend", inputs: {}, composedSystemPrompt: "P" },
    createdAt: "2026-07-30T00:00:00Z",
  });
  insertVerdict({
    id: "v-fail",
    taskId: "task-red",
    redTaskId: "red-runner",
    redRole: "red-backend",
    verdict: "fail",
    confidence: 0.9,
    authority: "authoritative",
    findings: [],
    createdAt: "2026-07-30T00:00:01Z",
    gateOnVerdict: true,
  });
  // A full ledger sits alongside. Under the pre-FG-640 model it is invisible.
  insertReview({
    id: "review-snap",
    runId,
    subjectTaskId: "task-clean",
    ticketId: "FG-640",
    reviewMode: "legacy_verdict",
    candidateSha: SHA,
    state: "awaiting_disposition",
  });
  ingestFindings("review-snap", [{ summary: "untriaged and blocking-looking", severity: "high" }]);

  const refusals = {
    withVerdictFail: await attempt("task-red"),
    withVerdictFailForced: await attempt("task-red", "operator override", true),
    cleanAdvance: await attempt("task-clean"),
  };
  const events = (
    getDb().prepare(`SELECT task_id, payload FROM events WHERE event_type IN ('gate.decided','run.created') ORDER BY id ASC`).all() as {
      task_id: string | null;
      payload: string;
    }[]
  ).map((e) => ({ taskId: e.task_id, payload: JSON.parse(e.payload) as unknown }));

  return {
    stampedMode: getRun(runId)!.reviewMode,
    refusals,
    statuses: { clean: getTask("task-clean")!.status, red: getTask("task-red")!.status },
    gateRows: [...gatesForTask("task-clean"), ...gatesForTask("task-red")].map((g) => ({
      decision: g.decision,
      rationale: g.rationale,
    })),
    events,
  };
}

test("FG-640: a workflow with NO review_mode key has a gate surface identical to an explicit legacy_verdict one", async () => {
  const absent = await gateSurface("");
  const explicit = await gateSurface("review_mode: legacy_verdict\n");
  assert.deepEqual(absent, explicit, "silence must mean legacy_verdict in behavior, not only in the parsed default");
});

test("FG-640: an unmigrated workflow's gate.decided payload is the pre-FG-640 shape — no gateKind key", async () => {
  const surface = (await gateSurface("")) as { events: { payload: Record<string, unknown> }[] };
  const decided = surface.events.filter((e) => "decision" in e.payload);
  assert.ok(decided.length > 0, "the snapshot must contain at least one gate decision");
  for (const e of decided) {
    assert.deepEqual(
      Object.keys(e.payload).sort(),
      ["decision", "force", "rationale"].filter((k) => k in e.payload).sort(),
      "a legacy gate payload gains no new keys",
    );
    assert.equal("gateKind" in e.payload, false);
  }
});

// ── 2. stamped once, at creation ─────────────────────────────────────────────

test("FG-640: editing the workflow's cutover line mid-run does not restamp the run", () => {
  writeWorkflow("wf-drift", "review_mode: evidence_led\n");
  const evidenceLed = loadWorkflow("wf-drift", { seedGeneration: resolveSeedGeneration() });
  const { runId } = startRun({ workflow: evidenceLed, title: "t", inputs: {}, projectDir: "/tmp/fg640-cut" });
  assert.equal(getRun(runId)!.reviewMode, "evidence_led");

  writeWorkflow("wf-drift", "review_mode: legacy_verdict\n");
  assert.equal(loadWorkflow("wf-drift", { seedGeneration: resolveSeedGeneration() }).review_mode, "legacy_verdict");
  assert.equal(getRun(runId)!.reviewMode, "evidence_led", "the run's authority model is fixed at creation");
});

test("FG-640: a run stamped legacy under a workflow that has since migrated is refused as review_mode_drift", async () => {
  writeWorkflow("wf-drift", "review_mode: evidence_led\n");
  seedRun("wf-drift", "legacy_verdict");
  settledLedger("legacy_verdict");

  const msg = await attempt("task-build");
  assert.match(msg, /review_mode_drift/);
  assert.match(msg, /records review_mode 'legacy_verdict' while its workflow declares 'evidence_led'/);
  assert.match(msg, /a run's authority model is fixed at creation/);
});

test("FG-640 GAP: the reverse drift is NOT refused — a de-migrated workflow silently returns the run to verdict aggregation", async () => {
  // `gate()` computes `evidenceLed` from the WORKFLOW alone and only assembles `modeDrift` inside
  // that branch, so the disagreement is detected in one direction only. A run stamped
  // evidence_led whose workflow was reverted falls through to legacy aggregation with no refusal —
  // the same "settling a step under a model its reds were never dispatched with" the
  // review_mode_drift condition exists to prevent, arrived at from the other side.
  //
  // Pinned as the current behavior, not asserted as correct. If drift detection is made
  // symmetric, this test is the one that must change.
  writeWorkflow("wf-drift", "review_mode: legacy_verdict\n");
  seedRun("wf-drift", "evidence_led");
  // A ledger that could not possibly settle: no contract, no verification, no shipping, an
  // untriaged finding. Under the run's own stamped model this is nowhere near advanceable.
  insertReview({
    id: "review-drift",
    runId: RUN_ID,
    ticketId: "FG-640",
    reviewMode: "evidence_led",
    candidateSha: SHA,
    state: "awaiting_disposition",
  });
  ingestFindings("review-drift", [{ summary: "nobody decided about this", severity: "high" }]);

  const outcome = await attempt("task-build");
  assert.equal(outcome, "advanced:complete", "current behavior: no drift refusal in this direction");
  const payload = JSON.parse(
    (getDb().prepare(`SELECT payload FROM events WHERE event_type = 'gate.decided'`).get() as { payload: string }).payload,
  ) as Record<string, unknown>;
  assert.equal("gateKind" in payload, false, "and the audit record does not claim the disposition gate decided it");
});

// ── 3. never combined within one run ─────────────────────────────────────────

const TWO_STEPS = `  - id: build
    agent: engineer
    gate: verdict
    reds:
      - agent: red-backend
        authority: specialist
        gate_on_verdict: false
  - id: audit
    agent: engineer
    gate: verdict
    reds:
      - agent: red-security
        authority: authoritative
        gate_on_verdict: true
`;

test("FG-640: one run, two reviewed steps — the half-migrated one refuses while the migrated one settles", async () => {
  writeWorkflow("wf-two", "review_mode: evidence_led\n", TWO_STEPS);
  seedRun("wf-two", "evidence_led", ["build", "audit"]);
  settledLedger("evidence_led");

  assert.equal(await attempt("task-build"), "advanced:complete", "the migrated step settles from the run's ledger");

  const msg = await attempt("task-audit");
  assert.match(msg, /mixed_authority_model/);
  assert.match(msg, /the step still DECLARES blocking red\(s\) \(red-security/);
  assert.match(msg, /two \s*\n?\s*authority models must never be combined/s);
  assert.equal(getTask("task-audit")!.status, "awaiting_gate");
});

test("FG-640: a step cannot declare its own review_mode — the cutover is workflow-level only", () => {
  // The schema has no per-step cutover, so a step-level key is silently dropped rather than
  // parsed into a second authority model. That is the property that makes "exactly one
  // review_mode per run" true by construction instead of by convention.
  const parsed = WorkflowSchema.safeParse({
    name: "wf-step-mode",
    description: "a step trying to opt out",
    review_mode: "evidence_led",
    steps: [
      {
        id: "build",
        agent: "engineer",
        gate: "verdict",
        review_mode: "legacy_verdict",
        reds: [{ agent: "red-backend", authority: "specialist", gate_on_verdict: false }],
      },
    ],
  });
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
  assert.equal(parsed.data.review_mode, "evidence_led");
  assert.equal("review_mode" in parsed.data.steps[0]!, false, "no step carries an authority model of its own");
});

test("FG-640: a non-verdict gate on an evidence_led run keeps its own meaning — no ledger requirement", async () => {
  // Migrating a workflow must not silently attach a ledger requirement to its architect and plan
  // steps. `gate: human` on an evidence-led run advances with no review in the store at all.
  writeWorkflow(
    "wf-human",
    "review_mode: evidence_led\n",
    `  - id: plan
    agent: tech-lead
    gate: human
`,
  );
  seedRun("wf-human", "evidence_led", ["plan"]);
  const result = await gate("task-plan", "advance", "the plan looks right", {});
  assert.equal(result.task.status, "complete");
  const payload = JSON.parse(
    (getDb().prepare(`SELECT payload FROM events WHERE event_type = 'gate.decided'`).get() as { payload: string }).payload,
  ) as Record<string, unknown>;
  assert.equal("gateKind" in payload, false, "the disposition gate did not decide a human gate");
});

test("FG-640: an authoritative red on a LEGACY step of a legacy run still blocks by its old message", async () => {
  writeWorkflow("wf-plain", "");
  seedRun("wf-plain", undefined);
  authoritativeFail("task-build", "v-legacy");

  const msg = await attempt("task-build");
  assert.match(msg, /verdict aggregation = fail/);
  assert.doesNotMatch(msg, /review_disposition/);
});
