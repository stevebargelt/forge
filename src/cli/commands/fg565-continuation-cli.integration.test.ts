// FG-565 (Slice 6, G1) — integration coverage for the read-only operator surface
// `forge continuation show <id>` / `forge continuation list`.
//
// It seeds REAL continuations in every state (awaiting_completion, ready,
// dispatching, advanced, blocked) plus a continuation carrying a stale-observation
// audit row, against the singleton store at the per-process temp FORGE_HOME
// (test-setup.ts) — never ~/.forge. It then asserts BOTH the factored render
// functions (human + JSON) AND the real CLI command output end-to-end (through
// buildProgram → commander → the registered `continuation` subcommands), so the
// operator-visible-evidence questions Q3–Q7 are proven answerable from durable state:
//   Q3 claim_owner + consumer_kind, Q4 next_action rendered STRUCTURED (not a raw
//   JSON blob), Q5 dispatched_run_id/task_id, Q6 stale/duplicate observations,
//   Q7 blocked state + the required operator action.
//
// SINGLE-STORE PROJECTION (BD-3): the evidence DTO is asserted to carry ONLY
// continuation + continuation_stale_observations fields — no launch-fs record, no
// runs-table join. RED baseline is not applicable here: G1 is a new observability
// surface (a coverage/behavior gap), not a defect to revert — the surface simply did
// not exist before this diff (there was no read CLI over these two tables).

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  recordContinuation,
  observeLaunchStatus,
  claimContinuationDispatch,
  markAdvanced,
  markBlocked,
  rearmForNextPhase,
  getContinuation,
  listContinuations,
  type ConsumerKind,
  type NextAction,
} from "../../store/continuations.js";
import { getDb } from "../../store/db.js";
import { buildProgram } from "../program.js";
import {
  toContinuationEvidence,
  operatorActionFor,
  renderContinuationShow,
  renderContinuationList,
  renderContinuationNotFound,
} from "./continuation.js";

const ACTION: NextAction = { kind: "dispatch_phase", phase: "review", role: "engineer" };
const LEASE = 60_000;

/** Unique id-space per test so seeded rows never collide across cases. */
let seq = 0;
function ids(tag: string): { id: string; launch: string } {
  const n = seq++;
  return { id: `fg565-${tag}-${n}`, launch: `L-${tag}-${n}` };
}

function seedAwaiting(consumer: ConsumerKind = "orchestrator"): string {
  const { id, launch } = ids("await");
  recordContinuation({ continuationId: id, consumerKind: consumer, sourceLaunchId: launch, currentPhase: "review", nextAction: ACTION });
  return id;
}

function seedReady(): string {
  const { id, launch } = ids("ready");
  recordContinuation({ continuationId: id, consumerKind: "orchestrator", sourceLaunchId: launch, currentPhase: "review", nextAction: ACTION });
  observeLaunchStatus(id, launch, "exited_ok");
  return id;
}

function seedDispatching(owner = "ctrl-A"): { id: string; launch: string } {
  const { id, launch } = ids("dispatch");
  recordContinuation({ continuationId: id, consumerKind: "orchestrator", sourceLaunchId: launch, currentPhase: "review", nextAction: ACTION });
  observeLaunchStatus(id, launch, "exited_ok");
  const outcome = claimContinuationDispatch({
    continuationId: id, sourceLaunchId: launch, consumerKind: "orchestrator",
    currentPhase: "review", nextAction: ACTION, expectedState: "ready", owner, leaseTtlMs: LEASE,
  });
  assert.equal(outcome.granted, true, "claim must be granted to reach dispatching");
  return { id, launch };
}

function seedAdvanced(): string {
  const { id } = seedDispatching("ctrl-adv");
  const ok = markAdvanced(id, "ctrl-adv", { runId: "run-777", taskId: "task-888" });
  assert.equal(ok, true, "markAdvanced must settle the claim");
  return id;
}

function seedBlocked(consumer: ConsumerKind = "orchestrator"): string {
  const { id, launch } = ids("blocked");
  recordContinuation({ continuationId: id, consumerKind: consumer, sourceLaunchId: launch, currentPhase: "review", nextAction: ACTION });
  observeLaunchStatus(id, launch, "exited_ok");
  const outcome = claimContinuationDispatch({
    continuationId: id, sourceLaunchId: launch, consumerKind: consumer,
    currentPhase: "review", nextAction: ACTION, expectedState: "ready", owner: "ctrl-blk", leaseTtlMs: LEASE,
  });
  assert.equal(outcome.granted, true);
  const ok = markBlocked(id, "ctrl-blk");
  assert.equal(ok, true, "markBlocked must move the slot to blocked");
  return id;
}

/** A continuation whose slot advanced to phase B, then a DELAYED phase-A completion
 *  arrives — recorded-and-ignored into continuation_stale_observations (Q6). */
function seedWithStaleObservation(): { id: string; launchA: string } {
  const { id, launch: launchA } = ids("stale");
  recordContinuation({ continuationId: id, consumerKind: "orchestrator", sourceLaunchId: launchA, currentPhase: "phase-A", nextAction: ACTION });
  observeLaunchStatus(id, launchA, "exited_ok");
  const claim = claimContinuationDispatch({
    continuationId: id, sourceLaunchId: launchA, consumerKind: "orchestrator",
    currentPhase: "phase-A", nextAction: ACTION, expectedState: "ready", owner: "ctrl-s", leaseTtlMs: LEASE,
  });
  assert.equal(claim.granted, true);
  markAdvanced(id, "ctrl-s", { runId: "run-A" });
  const launchB = `${launchA}-B`;
  rearmForNextPhase(id, { sourceLaunchId: launchB, currentPhase: "phase-B", nextAction: ACTION });
  // A delayed phase-A completion: slot is now bound to launchB, so this is stale.
  observeLaunchStatus(id, launchA, "exited_ok");
  return { id, launchA };
}

/** Run the real registered CLI and capture stdout. */
async function runCli(argv: string[]): Promise<string> {
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  const prevExit = process.exitCode;
  process.stdout.write = ((s: string | Uint8Array): boolean => {
    chunks.push(typeof s === "string" ? s : Buffer.from(s).toString());
    return true;
  }) as typeof process.stdout.write;
  try {
    await buildProgram().parseAsync(["node", "forge", ...argv]);
  } finally {
    process.stdout.write = orig;
    process.exitCode = prevExit;
  }
  return chunks.join("");
}

describe("FG-565 G1 — forge continuation read surface", () => {
  beforeEach(() => {
    // Isolate each case: clear the two tables so list-all assertions are deterministic.
    getDb().exec("DELETE FROM continuation_stale_observations; DELETE FROM continuations;");
  });

  test("show renders Q3–Q5 for a dispatched/advanced continuation (human + JSON, structured next_action)", async () => {
    const id = seedAdvanced();
    const c = getContinuation(id)!;
    const e = toContinuationEvidence(c);

    // JSON: structured next_action (object, not a raw JSON string), dispatched ids.
    const json = JSON.parse(renderContinuationShow(e, true));
    assert.deepEqual(json.nextAction, ACTION, "Q4 next_action must be a structured object");
    assert.equal(typeof json.nextAction, "object");
    assert.equal(json.consumerKind, "orchestrator"); // Q3
    assert.equal(json.claimOwner, "ctrl-adv"); // Q3
    assert.equal(json.dispatchedRunId, "run-777"); // Q5
    assert.equal(json.dispatchedTaskId, "task-888"); // Q5
    assert.equal(json.state, "advanced");

    // Human: the same facts as readable lines.
    const human = renderContinuationShow(e, false);
    assert.match(human, /consumer:\s+orchestrator/);
    assert.match(human, /claim-owner:\s+ctrl-adv/);
    assert.match(human, /dispatched-run:\s+run-777/);
    assert.match(human, /dispatched-task:\s+task-888/);
    assert.match(human, /next-action:\s+\{"kind":"dispatch_phase"/);

    // End-to-end through the registered CLI.
    const cliJson = JSON.parse(await runCli(["continuation", "show", id, "--json"]));
    assert.equal(cliJson.claimOwner, "ctrl-adv");
    assert.deepEqual(cliJson.nextAction, ACTION);
  });

  test("show surfaces Q7 blocked-state operator action from durable state alone", async () => {
    const id = seedBlocked();
    const c = getContinuation(id)!;
    assert.equal(c.state, "blocked");
    assert.notEqual(operatorActionFor(c), null, "a blocked slot must yield an operator action");

    const human = renderContinuationShow(toContinuationEvidence(c), false);
    assert.match(human, /state:\s+blocked/);
    assert.match(human, /operator-action: BLOCKED —/);
    assert.match(human, /adopt dispatch_key=/); // names the receipt the operator must adopt

    const cli = await runCli(["continuation", "show", id]);
    assert.match(cli, /operator-action: BLOCKED —/);

    // A non-blocked slot has NO operator action (Q7 fires only when stuck).
    assert.equal(operatorActionFor(getContinuation(seedReady())!), null);
  });

  test("show renders Q6 stale/duplicate observations recorded-and-ignored", async () => {
    const { id, launchA } = seedWithStaleObservation();
    const e = toContinuationEvidence(getContinuation(id)!);
    assert.equal(e.staleObservations.length, 1, "the delayed phase-A completion must be audited");
    assert.equal(e.staleObservations[0]!.sourceLaunchId, launchA);

    const human = renderContinuationShow(e, false);
    assert.match(human, /stale-observations \(1\):/);
    assert.match(human, new RegExp(`launch=${launchA}`));

    const json = JSON.parse(renderContinuationShow(e, true));
    assert.equal(json.staleObservations.length, 1);
  });

  test("show not-found is a clean non-zero, human + JSON", async () => {
    assert.equal(renderContinuationNotFound("nope", false), "No continuation recorded for id 'nope'.");
    assert.deepEqual(JSON.parse(renderContinuationNotFound("nope", true)), { found: false, continuationId: "nope" });
  });

  test("list --state blocked returns only blocked slots (human + JSON)", async () => {
    seedAwaiting();
    seedReady();
    const blockedId = seedBlocked();

    const blocked = listContinuations({ state: "blocked" }).map(toContinuationEvidence);
    assert.equal(blocked.length, 1);
    assert.equal(blocked[0]!.continuationId, blockedId);

    const human = renderContinuationList(blocked, false);
    assert.match(human, /1 continuation \(newest activity first\):/);
    assert.match(human, /state=blocked/);
    assert.match(human, /ACTION-REQUIRED/);

    const cliJson = JSON.parse(await runCli(["continuation", "list", "--state", "blocked", "--json"]));
    assert.equal(cliJson.count, 1);
    assert.equal(cliJson.continuations[0].continuationId, blockedId);
    assert.equal(cliJson.continuations[0].state, "blocked");
    assert.notEqual(cliJson.continuations[0].operatorAction, null);
  });

  test("list is not scoped to dispatching — it returns every state (unlike continuationsInDispatch)", async () => {
    seedAwaiting();
    seedReady();
    seedDispatching();
    seedAdvanced();
    seedBlocked();
    const all = listContinuations();
    const states = new Set(all.map((c) => c.state));
    for (const s of ["awaiting_completion", "ready", "dispatching", "advanced", "blocked"]) {
      assert.ok(states.has(s as never), `list must include state ${s}`);
    }
  });

  test("list --consumer-kind filters to one consumer", async () => {
    seedBlocked("orchestrator");
    const campaignId = seedBlocked("campaign");
    const rows = listContinuations({ consumerKind: "campaign" });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.continuationId, campaignId);
  });

  test("evidence DTO is a single-store projection (no launch-fs / runs join)", async () => {
    const id = seedAdvanced();
    const e = toContinuationEvidence(getContinuation(id)!);
    // Only continuation + stale-observation fields — nothing sourced from the
    // filesystem launch record or the runs table (BD-3, two sources never joined).
    assert.deepEqual(
      Object.keys(e).sort(),
      [
        "claimExpiresAt", "claimOwner", "consumerKind", "continuationId", "createdAt",
        "currentPhase", "dispatchKey", "dispatchedRunId", "dispatchedTaskId",
        "lastObservedStatus", "nextAction", "operatorAction", "sourceLaunchId",
        "staleObservations", "state", "updatedAt",
      ].sort(),
    );
  });
});
