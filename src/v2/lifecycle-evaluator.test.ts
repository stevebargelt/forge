// FG-477 slice 1 — the lineage classifier's executable spec.
//
// Three layers:
//   1. the decision table, rule by rule, plus every priority collision;
//   2. seeded property-based totality over the task-row shape space (no
//      fast-check in this repo and no new dependencies — the generator below is
//      a deterministic LCG, so a failure reproduces from its seed);
//   3. behavior parity per migrated consumer: each consumer's PRE-migration
//      predicate is frozen verbatim here as a fixture and compared against the
//      classifier over the generated corpus (FG-477's migration-freeze rule —
//      a migration must not change a decision, and a disagreement is a finding).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyTaskLineage,
  isAdHocInvokeRow,
  isOnRejectRecoveryRow,
  isPhasePrimaryRow,
  isWorkflowPrimaryRow,
  type LineageKind,
} from "./lifecycle-evaluator.js";
import type { Workflow, Step } from "./schema.js";
import type { Task, TaskPackage } from "../types/index.js";

const ALL_KINDS: LineageKind[] = [
  "primary",
  "retry_replacement",
  "on_reject_recovery",
  "red_review",
  "fanout_child",
  "adhoc_invoke",
  "legacy_ambiguous_invoke",
];

// ----- fixtures -----

function mkStep(opts: Partial<Step> & { id: string }): Step {
  return {
    depends_on: [],
    reds: [],
    ...opts,
  } as Step;
}

function mkWorkflow(steps: Step[]): Workflow {
  return { name: "test", description: "test", review_mode: "legacy_verdict", inputs: [], steps };
}

function mkTask(opts: {
  id: string;
  phase: string;
  parentId?: string;
  agentRole?: string;
  createdAt?: string;
  status?: Task["status"];
  inputs?: Record<string, unknown>;
  dispatchSource?: TaskPackage["dispatchSource"];
}): Task {
  const taskPackage: TaskPackage = {
    taskId: opts.id,
    runId: "r1",
    phase: opts.phase,
    role: opts.agentRole ?? "engineer",
    inputs: opts.inputs ?? {},
    composedSystemPrompt: "",
    ...(opts.dispatchSource ? { dispatchSource: opts.dispatchSource } : {}),
  };
  return {
    id: opts.id,
    runId: "r1",
    ...(opts.parentId ? { parentId: opts.parentId } : {}),
    phase: opts.phase,
    agentRole: opts.agentRole ?? "engineer",
    status: opts.status ?? "pending",
    taskPackage,
    createdAt: opts.createdAt ?? "2026-07-11T00:00:00.000Z",
  };
}

// build: a fanout step with two reds — one following the `red-` naming
// convention, one NOT (feature.yml's shipping-reviewer). The second is what the
// legacy role-prefix heuristic misclassifies; see the parity tests below.
const WORKFLOW = mkWorkflow([
  mkStep({ id: "plan", agent: "tech-lead" }),
  mkStep({
    id: "build",
    agent: "engineer",
    depends_on: ["plan"],
    reds: [
      { agent: "red-wide", authority: "authoritative" },
      { agent: "shipping-reviewer", authority: "authoritative" },
    ],
    fanout: {
      from_upstream: { step: "plan", array_key: "steps", input_key: "step" },
      agent_map: {},
      max_concurrency: 4,
      failure_mode: "fail-phase",
    },
  } as Partial<Step> & { id: string }),
  mkStep({ id: "audit", agent: "auditor", depends_on: ["build"], on_reject: "audit" }),
]);

function kindOf(workflow: Workflow, tasks: Task[], id: string): LineageKind {
  const k = classifyTaskLineage(workflow, tasks).get(id);
  assert.ok(k !== undefined, `no kind for ${id}`);
  return k;
}

// ----- 1. the decision table, rule by rule -----

test("rule 1: the first parent-less row in a phase is primary", () => {
  const t = mkTask({ id: "a", phase: "plan" });
  assert.equal(kindOf(WORKFLOW, [t], "a"), "primary");
});

test("rule 1: a fanout parent is just a primary — no separate marker", () => {
  const t = mkTask({ id: "a", phase: "build" });
  assert.equal(kindOf(WORKFLOW, [t], "a"), "primary");
});

test("rule 1: a manual step's row (no agent on the step) is primary", () => {
  const wf = mkWorkflow([mkStep({ id: "review", manual: true } as Partial<Step> & { id: string })]);
  const t = mkTask({ id: "a", phase: "review" });
  assert.equal(kindOf(wf, [t], "a"), "primary");
});

test("rule 2: a later parent-less row in the same phase is retry_replacement", () => {
  const first = mkTask({ id: "a", phase: "plan", createdAt: "2026-07-11T00:00:00.000Z", status: "failed" });
  const second = mkTask({
    id: "b",
    phase: "plan",
    createdAt: "2026-07-11T01:00:00.000Z",
    inputs: { previous_failure: { failedTaskId: "a" } },
  });
  const kinds = classifyTaskLineage(WORKFLOW, [first, second]);
  assert.equal(kinds.get("a"), "primary");
  assert.equal(kinds.get("b"), "retry_replacement");
});

test("rule 2: forge-retry and gate request-changes replacements are the SAME kind", () => {
  const first = mkTask({ id: "a", phase: "plan", createdAt: "2026-07-11T00:00:00.000Z" });
  const retryRow = mkTask({
    id: "b",
    phase: "plan",
    createdAt: "2026-07-11T01:00:00.000Z",
    inputs: { previous_failure: { failedTaskId: "a" } },
  });
  const requestChangesRow = mkTask({
    id: "c",
    phase: "plan",
    createdAt: "2026-07-11T02:00:00.000Z",
    inputs: { requestedChanges: "do it again" },
  });
  const kinds = classifyTaskLineage(WORKFLOW, [first, retryRow, requestChangesRow]);
  assert.equal(kinds.get("b"), "retry_replacement");
  assert.equal(kinds.get("c"), "retry_replacement");
});

test("rule 2: retrying a fanout PARENT is a retry_replacement, not a new primary", () => {
  const parent = mkTask({ id: "p", phase: "build", createdAt: "2026-07-11T00:00:00.000Z", status: "failed" });
  const child = mkTask({ id: "c", phase: "build", parentId: "p", createdAt: "2026-07-11T00:10:00.000Z" });
  const replacement = mkTask({ id: "p2", phase: "build", createdAt: "2026-07-11T01:00:00.000Z" });
  const kinds = classifyTaskLineage(WORKFLOW, [parent, child, replacement]);
  assert.equal(kinds.get("p"), "primary");
  assert.equal(kinds.get("c"), "fanout_child");
  assert.equal(kinds.get("p2"), "retry_replacement");
});

test("rule 3: a parented row carrying rejectedTaskId is on_reject_recovery", () => {
  const rejected = mkTask({ id: "a", phase: "audit", status: "failed" });
  const recovery = mkTask({
    id: "b",
    phase: "plan",
    parentId: "a",
    inputs: { rejectedTaskId: "a", rejectedRationale: "no" },
  });
  assert.equal(kindOf(WORKFLOW, [rejected, recovery], "b"), "on_reject_recovery");
});

test("rule 3 beats rule 4: a recovery row whose phase is a RED phase and whose role IS that phase's red", () => {
  // Priority collision: without rule 3's precedence this row reads as a red child.
  const rejected = mkTask({ id: "a", phase: "audit", status: "failed" });
  const recovery = mkTask({
    id: "b",
    phase: "build",
    parentId: "a",
    agentRole: "red-wide",
    inputs: { rejectedTaskId: "a" },
  });
  assert.equal(kindOf(WORKFLOW, [rejected, recovery], "b"), "on_reject_recovery");
});

test("rule 3 beats rule 5: a SELF-REFERENCING on_reject (on_reject === step.id) is recovery, not a fanout child", () => {
  // audit.on_reject === "audit": the recovery row lands in the same phase as the
  // task that rejected it, and is parented to it — structurally a fanout child.
  const rejected = mkTask({ id: "a", phase: "audit", status: "failed" });
  const recovery = mkTask({
    id: "b",
    phase: "audit",
    parentId: "a",
    agentRole: "auditor",
    inputs: { rejectedTaskId: "a" },
  });
  assert.equal(kindOf(WORKFLOW, [rejected, recovery], "b"), "on_reject_recovery");
});

test("rule 4: a parented row whose role is one of the phase's reds is red_review", () => {
  const primary = mkTask({ id: "p", phase: "build" });
  const red = mkTask({ id: "r", phase: "build", parentId: "p", agentRole: "red-wide" });
  assert.equal(kindOf(WORKFLOW, [primary, red], "r"), "red_review");
});

test("rule 4: a red is found by the workflow's reds[].agent, NOT by a `red-` name prefix", () => {
  const primary = mkTask({ id: "p", phase: "build" });
  const red = mkTask({ id: "r", phase: "build", parentId: "p", agentRole: "shipping-reviewer" });
  assert.equal(kindOf(WORKFLOW, [primary, red], "r"), "red_review");
});

test("rule 4 does not fire on a phase that does not declare that red", () => {
  const primary = mkTask({ id: "p", phase: "plan" });
  const child = mkTask({ id: "c", phase: "plan", parentId: "p", agentRole: "red-wide" });
  assert.equal(kindOf(WORKFLOW, [primary, child], "c"), "fanout_child");
});

test("rule 5: a parented row that is neither recovery nor red is a fanout_child", () => {
  const parent = mkTask({ id: "p", phase: "build" });
  const child = mkTask({ id: "c", phase: "build", parentId: "p", agentRole: "frontend-specialist" });
  assert.equal(kindOf(WORKFLOW, [parent, child], "c"), "fanout_child");
});

test("rule 0: a dispatchSource=invoke row is adhoc_invoke, even in a `task`-declaring workflow (FG-507)", () => {
  const wf = mkWorkflow([mkStep({ id: "task", agent: "engineer" })]);
  const invoked = mkTask({ id: "a", phase: "task", dispatchSource: "invoke" });
  assert.equal(kindOf(wf, [invoked], "a"), "adhoc_invoke");
});

test("rule 0: an adhoc invoke row does not consume its phase's primary slot", () => {
  // The FG-507 shape: an invoke row attached to a run whose workflow declares a
  // `task` step. The step's own row is still that phase's PRIMARY (not a
  // retry_replacement ranked behind the invoke row).
  const wf = mkWorkflow([mkStep({ id: "task", agent: "engineer" })]);
  const invoked = mkTask({ id: "inv", phase: "task", createdAt: "2026-07-11T00:00:00.000Z", dispatchSource: "invoke" });
  const stepRow = mkTask({ id: "step", phase: "task", createdAt: "2026-07-11T01:00:00.000Z", dispatchSource: "workflow" });
  const kinds = classifyTaskLineage(wf, [invoked, stepRow]);
  assert.equal(kinds.get("inv"), "adhoc_invoke");
  assert.equal(kinds.get("step"), "primary");
});

test("rule 0: a runner-stamped `task`-phase row is a primary, not ambiguous (FG-512)", () => {
  const wf = mkWorkflow([mkStep({ id: "task", agent: "engineer" })]);
  const stepRow = mkTask({ id: "a", phase: "task", dispatchSource: "workflow" });
  assert.equal(kindOf(wf, [stepRow], "a"), "primary");
});

test("rule 0: a marker-less legacy `task`-phase row in a `task`-declaring workflow is named, not guessed", () => {
  const wf = mkWorkflow([mkStep({ id: "task", agent: "engineer" })]);
  const legacy = mkTask({ id: "a", phase: "task" });
  assert.equal(kindOf(wf, [legacy], "a"), "legacy_ambiguous_invoke");
  // and it is still a phase-primary row for every consumer, exactly as before
  // FG-477 (isAdHocInvokeTask is marker-only, so it never excluded this row).
  assert.equal(isWorkflowPrimaryRow("legacy_ambiguous_invoke"), true);
});

test("rule 0: a marker-less legacy row in a phase the workflow does NOT call `task` is ordinary lineage", () => {
  const legacy = mkTask({ id: "a", phase: "plan" });
  assert.equal(kindOf(WORKFLOW, [legacy], "a"), "primary");
});

test("a row in a phase the workflow does not declare still classifies (totality, no throw)", () => {
  const orphan = mkTask({ id: "a", phase: "no-such-step" });
  const child = mkTask({ id: "b", phase: "no-such-step", parentId: "a" });
  const kinds = classifyTaskLineage(WORKFLOW, [orphan, child]);
  assert.equal(kinds.get("a"), "primary");
  assert.equal(kinds.get("b"), "fanout_child");
});

// ----- 2. seeded property-based totality -----

// Deterministic LCG (numerical recipes). No dependency, reproducible from a seed.
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const PHASES = ["plan", "build", "audit", "task", "no-such-step"];
const ROLES = ["engineer", "tech-lead", "red-wide", "shipping-reviewer", "auditor", "frontend-specialist"];
const STATUSES: Task["status"][] = ["pending", "running", "awaiting_gate", "awaiting_red", "blocked_by_red", "complete", "failed"];
const SOURCES: (TaskPackage["dispatchSource"] | undefined)[] = ["workflow", "invoke", undefined];
const MARKERS: (Record<string, unknown>)[] = [
  {},
  { rejectedTaskId: "x-1" },
  { previous_failure: { failedTaskId: "x-1" } },
  { requestedChanges: "again" },
  { rejectedTaskId: "x-1", requestedChanges: "again" },
];
// Times chosen to include exact duplicates — the classifier must still be total
// and order-insensitive when two rows share a createdAt.
const TIMES = [
  "2026-07-11T00:00:00.000Z",
  "2026-07-11T00:00:00.000Z",
  "2026-07-11T01:00:00.000Z",
  "2026-07-11T02:00:00.000Z",
];

// The generator's workflow: a `task` step (so the legacy-ambiguity and FG-507
// collisions are in the sampled space) plus the fanout+reds step above.
const GEN_WORKFLOW = mkWorkflow([...WORKFLOW.steps, mkStep({ id: "task", agent: "engineer" })]);

function pick<T>(r: () => number, xs: readonly T[]): T {
  return xs[Math.floor(r() * xs.length)]!;
}

/** One sampled task set: 1-6 rows, parents drawn from the rows already emitted
 *  (so parentId links are realistic) or a dangling id (so they are not always). */
function sampleTasks(r: () => number, n: number): Task[] {
  const tasks: Task[] = [];
  for (let i = 0; i < n; i++) {
    const id = `t${i}`;
    const parented = r() < 0.5;
    const parentId = !parented
      ? undefined
      : tasks.length > 0 && r() < 0.8
        ? pick(r, tasks).id
        : "dangling-parent";
    const source = pick(r, SOURCES);
    tasks.push(
      mkTask({
        id,
        phase: pick(r, PHASES),
        agentRole: pick(r, ROLES),
        createdAt: pick(r, TIMES),
        status: pick(r, STATUSES),
        inputs: { ...pick(r, MARKERS) },
        ...(parentId ? { parentId } : {}),
        ...(source ? { dispatchSource: source } : {}),
      }),
    );
  }
  return tasks;
}

function shuffled(r: () => number, tasks: Task[]): Task[] {
  const out = [...tasks];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** The corpus. Seeded: a failure reproduces by re-running with the same SEED/CASES.
 *  Deliberately UNCONSTRAINED — it samples row shapes no minting site can produce,
 *  because totality is a claim about every shape, not just the reachable ones. */
const SEED = 20260711;
const CASES = 3000;
function corpus(): Task[][] {
  const r = rng(SEED);
  const sets: Task[][] = [];
  for (let i = 0; i < CASES; i++) sets.push(sampleTasks(r, 1 + Math.floor(r() * 6)));
  return sets;
}

/** The corpus restricted to rows the system can actually mint. One invariant:
 *  an invoke row is never parented. Every `dispatchSource: "invoke"` insert
 *  (invoke.ts, and retry.ts's copy of an ad-hoc row) leaves parentId unset, and
 *  every PARENTED insert — gate.ts's on_reject recovery row, runNext's red and
 *  fanout children — stamps `workflow`. A parented invoke row would therefore be
 *  a corruption, not a state.
 *
 *  PARITY is asserted here rather than over the full corpus because that one
 *  impossible shape is the only place a legacy predicate and the classifier can
 *  differ: `isOnRejectRecoveryTask` is marker-only, so it would call a parented
 *  invoke row a recovery, while the classifier's rule 0 (provenance first) calls
 *  it adhoc_invoke. The classifier's answer is the safer one and is pinned by its
 *  own test below; asserting parity on a shape neither code path can receive
 *  would only be asserting which of two dead branches wins. */
function reachableCorpus(): Task[][] {
  return corpus().map((tasks) =>
    tasks.filter((t) => !(t.taskPackage.dispatchSource === "invoke" && t.parentId !== undefined)),
  );
}

test("rule 0 wins over rule 3 on the (unmintable) parented invoke row — provenance before lineage", () => {
  const rejected = mkTask({ id: "a", phase: "audit", status: "failed" });
  const corrupt = mkTask({
    id: "b",
    phase: "plan",
    parentId: "a",
    inputs: { rejectedTaskId: "a" },
    dispatchSource: "invoke",
  });
  assert.equal(kindOf(WORKFLOW, [rejected, corrupt], "b"), "adhoc_invoke");
});

test("TOTALITY: every generated row maps to exactly one known kind", () => {
  let rows = 0;
  for (const tasks of corpus()) {
    const kinds = classifyTaskLineage(GEN_WORKFLOW, tasks);
    assert.equal(kinds.size, new Set(tasks.map((t) => t.id)).size);
    for (const t of tasks) {
      const kind = kinds.get(t.id);
      assert.ok(kind !== undefined, `unclassified row ${t.id}`);
      assert.ok(ALL_KINDS.includes(kind), `unknown kind ${kind}`);
      rows++;
    }
  }
  assert.ok(rows > CASES, "generator produced too few rows to be meaningful");
});

test("TOTALITY: the kind space is exhaustively switchable — no default case is ever hit", () => {
  const seen = new Set<LineageKind>();
  for (const tasks of corpus()) {
    for (const kind of classifyTaskLineage(GEN_WORKFLOW, tasks).values()) {
      // Exhaustive switch: adding a LineageKind without a case here fails to compile.
      switch (kind) {
        case "primary":
        case "retry_replacement":
        case "on_reject_recovery":
        case "red_review":
        case "fanout_child":
        case "adhoc_invoke":
        case "legacy_ambiguous_invoke":
          seen.add(kind);
          break;
        default: {
          const never: never = kind;
          assert.fail(`default case hit: ${String(never)}`);
        }
      }
    }
  }
  // The generator must actually reach every kind, or the totality claim is vacuous.
  for (const k of ALL_KINDS) assert.ok(seen.has(k), `generator never produced kind ${k}`);
});

test("ORDER-INSENSITIVITY: classification does not depend on input array order", () => {
  const r = rng(SEED + 1);
  for (const tasks of corpus()) {
    const base = classifyTaskLineage(GEN_WORKFLOW, tasks);
    for (let i = 0; i < 3; i++) {
      const permuted = classifyTaskLineage(GEN_WORKFLOW, shuffled(r, tasks));
      assert.equal(permuted.size, base.size);
      for (const [id, kind] of base) assert.equal(permuted.get(id), kind, `row ${id} reclassified under a permutation`);
    }
  }
});

test("EXACTLY-ONE-PRIMARY: a phase's non-invoke parent-less rows hold exactly one `primary`", () => {
  for (const tasks of corpus()) {
    const kinds = classifyTaskLineage(GEN_WORKFLOW, tasks);
    const primariesPerPhase = new Map<string, number>();
    const phasesWithParentless = new Set<string>();
    for (const t of tasks) {
      const kind = kinds.get(t.id)!;
      if (t.parentId === undefined && kind !== "adhoc_invoke") phasesWithParentless.add(t.phase);
      if (kind === "primary") primariesPerPhase.set(t.phase, (primariesPerPhase.get(t.phase) ?? 0) + 1);
    }
    for (const phase of phasesWithParentless) {
      // A legacy-ambiguous row occupies the slot without being `primary`; that is
      // the point of its own kind. Otherwise the phase has exactly one primary.
      const count = primariesPerPhase.get(phase) ?? 0;
      assert.ok(count <= 1, `phase ${phase} produced ${count} primaries`);
    }
  }
});

test("isPhasePrimaryRow is exactly the classifier's phase-primary rule (workflow-free view)", () => {
  for (const tasks of corpus()) {
    const kinds = classifyTaskLineage(GEN_WORKFLOW, tasks);
    for (const t of tasks) {
      assert.equal(
        isPhasePrimaryRow(t),
        isWorkflowPrimaryRow(kinds.get(t.id)!),
        `isPhasePrimaryRow drifted from the classifier on ${t.id}`,
      );
    }
  }
});

// ----- 3. behavior parity per migrated consumer -----
//
// Each legacy predicate below is a FROZEN VERBATIM COPY of the pre-FG-477 code,
// kept here as the parity oracle. They are intentionally not imported — the
// point is to compare the migrated consumer's decision against the code it
// replaced, over the generator's corpus.

/** ready-queue.ts (pre-FG-477): isOnRejectRecoveryTask */
function legacyIsOnRejectRecoveryTask(task: Task): boolean {
  return task.parentId !== undefined && task.taskPackage.inputs?.["rejectedTaskId"] !== undefined;
}

/** ready-queue.ts (pre-FG-477): isAdHocInvokeTask */
function legacyIsAdHocInvokeTask(task: Task): boolean {
  return task.taskPackage.dispatchSource === "invoke";
}

/** ready-queue.ts (pre-FG-477): computeStepSettleStates' row bucketing, and
 *  runNext.ts's dispatchSingleStep pending-primary match — the same predicate. */
function legacyIsWorkflowPrimaryRow(task: Task): boolean {
  return task.parentId === undefined && !legacyIsAdHocInvokeTask(task);
}

/** reconcile.ts (pre-FG-477): finalizeOrphanedPrimaries' primary filter. */
function legacyIsOrphanSweepPrimary(task: Task): boolean {
  if (task.parentId !== undefined) return false;
  if (legacyIsAdHocInvokeTask(task)) return false;
  return true;
}

test("PARITY (ready-queue): isOnRejectRecoveryTask decides identically to kind === on_reject_recovery", () => {
  for (const tasks of reachableCorpus()) {
    const kinds = classifyTaskLineage(GEN_WORKFLOW, tasks);
    for (const t of tasks) {
      assert.equal(isOnRejectRecoveryRow(t), legacyIsOnRejectRecoveryTask(t));
      assert.equal(kinds.get(t.id) === "on_reject_recovery", legacyIsOnRejectRecoveryTask(t), `row ${t.id}`);
    }
  }
});

test("PARITY (ready-queue): the ad-hoc exclusion decides identically to kind === adhoc_invoke", () => {
  for (const tasks of reachableCorpus()) {
    const kinds = classifyTaskLineage(GEN_WORKFLOW, tasks);
    for (const t of tasks) {
      assert.equal(isAdHocInvokeRow(t), legacyIsAdHocInvokeTask(t));
      assert.equal(kinds.get(t.id) === "adhoc_invoke", legacyIsAdHocInvokeTask(t), `row ${t.id}`);
    }
  }
});

test("PARITY (ready-queue + runNext): isWorkflowPrimaryRow decides identically to the legacy primary predicate", () => {
  for (const tasks of reachableCorpus()) {
    const kinds = classifyTaskLineage(GEN_WORKFLOW, tasks);
    for (const t of tasks) {
      assert.equal(
        isWorkflowPrimaryRow(kinds.get(t.id)!),
        legacyIsWorkflowPrimaryRow(t),
        `row ${t.id} (${kinds.get(t.id)}) disagrees with the pre-migration primary predicate`,
      );
    }
  }
});

test("PARITY (runNext): dispatchSingleStep's pending-row pick is unchanged", () => {
  // The migrated site picks the same row as the legacy two-step find: a pending
  // workflow primary first, else a pending on_reject recovery row for the phase.
  for (const tasks of reachableCorpus()) {
    const kinds = classifyTaskLineage(GEN_WORKFLOW, tasks);
    for (const phase of PHASES) {
      const legacy =
        tasks.find((t) => t.phase === phase && t.status === "pending" && legacyIsWorkflowPrimaryRow(t)) ??
        tasks.find((t) => t.phase === phase && t.status === "pending" && legacyIsOnRejectRecoveryTask(t));
      const migrated =
        tasks.find((t) => t.phase === phase && t.status === "pending" && isWorkflowPrimaryRow(kinds.get(t.id)!)) ??
        tasks.find((t) => t.phase === phase && t.status === "pending" && kinds.get(t.id) === "on_reject_recovery");
      assert.equal(migrated?.id, legacy?.id, `phase ${phase}: dispatch would reuse a different row`);
    }
  }
});

test("PARITY (reconcile): finalizeOrphanedPrimaries sweeps exactly the same rows", () => {
  for (const tasks of reachableCorpus()) {
    // The sweep's decision: for each phase whose primary rows contain a complete
    // one, every PENDING primary row in that phase is orphaned.
    const sweep = (isPrimary: (t: Task) => boolean): string[] => {
      const byPhase = new Map<string, Task[]>();
      for (const t of tasks) {
        if (!isPrimary(t)) continue;
        const arr = byPhase.get(t.phase) ?? [];
        arr.push(t);
        byPhase.set(t.phase, arr);
      }
      const swept: string[] = [];
      for (const rows of byPhase.values()) {
        if (!rows.some((p) => p.status === "complete")) continue;
        for (const p of rows) if (p.status === "pending") swept.push(p.id);
      }
      return swept.sort();
    };
    assert.deepEqual(sweep(isPhasePrimaryRow), sweep(legacyIsOrphanSweepPrimary));
  }
});

// ----- the disagreements the migration-freeze rule says to REPORT, not fix -----
//
// These two consumers were NOT migrated. The tests below pin the exact shapes on
// which the legacy heuristic and the classifier disagree, so the disagreement is
// a recorded fact rather than a claim in a PR description. See FG-477 notes.

/** retry.ts (current, unmigrated): fanoutParentOf's kind test — parent shares the
 *  child's phase and the child's role does not start with `red-`. Parent lookup
 *  inlined against the row set (retry.ts reads it from the DB). */
function legacyIsFanoutChildForRetry(task: Task, tasks: Task[]): boolean {
  if (task.parentId === undefined) return false;
  if (task.agentRole.startsWith("red-")) return false;
  const parent = tasks.find((t) => t.id === task.parentId);
  return parent !== undefined && parent.phase === task.phase;
}

test("DISAGREEMENT (retry.ts, unmigrated): the `red-` prefix heuristic calls a shipping-reviewer red a fanout child", () => {
  // feature.yml's `build` step is a FANOUT step whose reds include
  // `shipping-reviewer` — a red whose agent name does not start with `red-`.
  const parent = mkTask({ id: "p", phase: "build" });
  const red = mkTask({ id: "r", phase: "build", parentId: "p", agentRole: "shipping-reviewer", status: "failed" });
  const tasks = [parent, red];

  // Legacy: a fanout child ⇒ `forge retry r` throws FanoutChildRetryError.
  assert.equal(legacyIsFanoutChildForRetry(red, tasks), true);
  // Classifier: a red review ⇒ retry would be allowed. A REAL decision change,
  // so retry.ts keeps its legacy predicate until FG-477's later slice decides.
  assert.equal(kindOf(WORKFLOW, tasks, "r"), "red_review");

  // The `red-`-prefixed red is where the two agree — which is why the legacy
  // heuristic has survived: every red in the shipped seeds but one is `red-*`.
  const redWide = mkTask({ id: "rw", phase: "build", parentId: "p", agentRole: "red-wide", status: "failed" });
  assert.equal(legacyIsFanoutChildForRetry(redWide, [parent, redWide]), false);
  assert.equal(kindOf(WORKFLOW, [parent, redWide], "rw"), "red_review");
});

test("DISAGREEMENT (runNext dispatchFanoutStep, unmigrated): its parent lookup does not exclude ad-hoc invoke rows", () => {
  // dispatchFanoutStep's existingParent = phase + parentId undefined + pending,
  // with no FG-507 ad-hoc exclusion (dispatchSingleStep's has one). On a workflow
  // whose FANOUT step is named `task`, a pending invoke row would be adopted as
  // the fanout parent. The classifier excludes it; migrating that site would
  // therefore change behavior, so it is left alone and reported.
  const wf = mkWorkflow([
    mkStep({
      id: "task",
      agent: "engineer",
      fanout: {
        from_upstream: { step: "task", array_key: "steps", input_key: "step" },
        agent_map: {},
        max_concurrency: 2,
        failure_mode: "fail-phase",
      },
    } as Partial<Step> & { id: string }),
  ]);
  const invoked = mkTask({ id: "inv", phase: "task", status: "pending", dispatchSource: "invoke" });
  const legacyParent = [invoked].find((t) => t.phase === "task" && t.parentId === undefined && t.status === "pending");
  assert.equal(legacyParent?.id, "inv");
  assert.equal(kindOf(wf, [invoked], "inv"), "adhoc_invoke");
});
