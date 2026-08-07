// FG-576 step 11 — the DASHBOARD's liveness join, and the structural prohibition
// on the remote-control credential ever reaching a cross-project payload.
//
// Three things are proved here, all of them against the real projection functions:
//
//  1. AGREEMENT WITH `forge show`. dashboard/src/queries.ts carries its own copy of
//     the receipt × liveness decision (importing a CLI command module into the
//     serving path would drag the WRITABLE store handle into a read surface). A copy
//     is only safe if it cannot drift, so the whole matrix — every receipt state ×
//     every process-liveness answer × every interaction state — is asserted
//     identical to src/cli/commands/show.ts's projectOrchestratorReceipt. A future
//     edit to either one that changes the running/not-running answer fails here.
//
//  2. AC7. A receipt CLAIMING a confirmed spawn is reported running ONLY where the
//     launcher is provably alive by process identity; absence of a provider hook
//     renders interaction as `unknown` and never upgrades anything to healthy.
//
//  3. FG-448's CROSS-PROJECT PROHIBITION, asserted as a TYPE-LEVEL AND VALUE-LEVEL
//     property of the projection rather than as a promise: OrchestratorEntry has no
//     url member at all, and a deep scan of a fully-populated cross-project
//     projection finds no credential-shaped value anywhere in it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpHome = mkdtempSync(join(tmpdir(), "forge-fg576-orch-"));
process.env.FORGE_HOME = tmpHome;

const { projectOrchestratorLiveness } = await import("./queries.js");
const { projectOrchestratorReceipt } = await import("../../src/cli/commands/show.js");
const { rowToOrchestratorReceipt, ORCHESTRATOR_RECEIPT_STATES } = await import(
  "../../src/store/orchestrator-receipts.js"
);
import type { OrchestratorReceiptRow } from "../../src/store/orchestrator-receipts.js";
import type { OrchestratorSession, ProcessLiveness } from "../../src/util/orchestrator-heartbeats.js";
import type { OrchestratorEntry } from "./queries.js";

// ─── fixtures ────────────────────────────────────────────────────────────────

function receiptRow(over: Partial<OrchestratorReceiptRow> = {}): OrchestratorReceiptRow {
  return {
    receipt_id: "orx-aaaaaabbbbbb",
    session_key: "11111111-2222-3333-4444-555555555555",
    state: "running",
    created_at: "2026-08-07T10:00:00.000Z",
    updated_at: "2026-08-07T10:00:00.000Z",
    project_dir: "/work/alpha",
    project_name: "Alpha",
    resolved_profile: "claude-subscription",
    runtime: "claude-code",
    provider: "anthropic",
    model: "claude-opus-5",
    auth_mode: "anthropic-oauth",
    resolved_by: "defaults.profile",
    adapter: "claude",
    session_operation: "new",
    session_target: null,
    provider_session_id: "11111111-2222-3333-4444-555555555555",
    identity_strength: "asserted",
    identity_basis: "forge minted --session-id",
    carrier_generation: "gen-1",
    carrier_path: "/forge/gen-1/orchestrator-instructions.md",
    carrier_acceptance: "not_applicable",
    carrier_evidence: null,
    limitations: "[]",
    task_id: "task-orch-1",
    launcher_pid: 4711,
    launcher_identity: "linux-starttime:900",
    started_at: "2026-08-07T10:00:01.000Z",
    closed_at: null,
    exit_code: null,
    exit_signal: null,
    failure_reason: null,
    ...over,
  };
}

function session(over: Partial<OrchestratorSession> = {}): OrchestratorSession {
  return {
    sessionId: "11111111-2222-3333-4444-555555555555",
    projectDir: "/work/alpha",
    startedAt: "2026-08-07T10:00:00.000Z",
    lastSeen: "2026-08-07T10:05:00.000Z",
    isLive: true,
    state: "live",
    processLiveness: "alive",
    interaction: "unknown",
    health: "unknown",
    finalizable: false,
    sources: ["launcher"],
    files: ["/tmp/x.launcher.json"],
    ...over,
  };
}

// ─── 1. the dashboard and `forge show` cannot disagree ───────────────────────

test("FG-576: the dashboard's liveness join matches `forge show`'s over the whole matrix", () => {
  const states = [...ORCHESTRATOR_RECEIPT_STATES, "some_future_state"];
  const livenesses: ProcessLiveness[] = ["alive", "dead", "unknown"];
  const interactions = ["recent", "stale", "unknown"] as const;
  let compared = 0;

  for (const state of states) {
    const receipt = rowToOrchestratorReceipt(receiptRow({ state }));
    // ...including the case where there is NO liveness record at all.
    for (const candidate of [undefined, ...livenesses.flatMap((processLiveness) =>
      interactions.map((interaction) =>
        session({
          processLiveness,
          interaction,
          health: interaction === "unknown" ? "unknown" : interaction === "recent" && processLiveness !== "dead" ? "healthy" : "stale",
          ...(interaction === "unknown" ? {} : { interactionLastSeen: "2026-08-07T10:05:00.000Z" }),
        }),
      ),
    )]) {
      const dashboard = projectOrchestratorLiveness(receipt, candidate);
      const cli = projectOrchestratorReceipt(receipt, candidate);
      compared += 1;
      const where = `state=${state} liveness=${candidate?.processLiveness ?? "no-record"} interaction=${candidate?.interaction ?? "-"}`;
      assert.equal(dashboard.presentation, cli.presentation, `presentation drift at ${where}`);
      assert.equal(dashboard.running, cli.running, `running drift at ${where}`);
      assert.equal(dashboard.recordedState, cli.recordedState, `recordedState drift at ${where}`);
      assert.equal(dashboard.processLiveness, cli.processLiveness, `processLiveness drift at ${where}`);
      assert.equal(dashboard.interaction, cli.interaction, `interaction drift at ${where}`);
      assert.equal(dashboard.health, cli.health, `health drift at ${where}`);
      assert.equal(dashboard.livenessRecord, cli.livenessRecord, `livenessRecord drift at ${where}`);
      assert.equal(dashboard.interactionLastSeen, cli.interactionLastSeen, `interactionLastSeen drift at ${where}`);
    }
  }
  // A matrix that silently shrank to nothing would pass every assertion above.
  assert.equal(compared, states.length * (1 + livenesses.length * interactions.length));
});

// ─── 2. AC7 ──────────────────────────────────────────────────────────────────

test("AC7: a receipt claiming running is only RUNNING where the launcher process is provably alive", () => {
  const receipt = rowToOrchestratorReceipt(receiptRow({ state: "running" }));

  assert.equal(projectOrchestratorLiveness(receipt, session({ processLiveness: "alive" })).running, true);

  // Provably gone: ORPHANED, not running — and not deleted either.
  const dead = projectOrchestratorLiveness(receipt, session({ processLiveness: "dead", state: "orphaned", isLive: false }));
  assert.equal(dead.running, false);
  assert.equal(dead.presentation, "orphaned");
  assert.equal(dead.recordedState, "running", "the receipt's own record is reported verbatim alongside the joined answer");

  // Cannot be judged (foreign host / no start token): NOT running.
  assert.equal(projectOrchestratorLiveness(receipt, session({ processLiveness: "unknown" })).presentation, "unverified");

  // No liveness record at all: NOT running.
  const none = projectOrchestratorLiveness(receipt, undefined);
  assert.equal(none.running, false);
  assert.equal(none.presentation, "unverified");
  assert.equal(none.livenessRecord, false);
});

test("AC7: absence of a provider hook is `unknown` interaction and never upgrades health", () => {
  const receipt = rowToOrchestratorReceipt(receiptRow({ state: "running" }));
  // A launcher-only record — the Codex case, and the Claude case before the first
  // Stop hook fires. The process is alive; interaction evidence does not exist.
  const projection = projectOrchestratorLiveness(
    receipt,
    session({ processLiveness: "alive", interaction: "unknown", health: "unknown", sources: ["launcher"] }),
  );
  assert.equal(projection.running, true, "process liveness alone answers live/not-live");
  assert.equal(projection.interaction, "unknown");
  assert.notEqual(projection.health, "healthy", "no hook is never reported as healthy");
  assert.equal(projection.interactionLastSeen, null);

  // And with no record at all, health is still `unknown` rather than anything better.
  assert.equal(projectOrchestratorLiveness(receipt, undefined).health, "unknown");
});

test("D15: a `pending` receipt is never rendered as live, whatever the process fence says", () => {
  const receipt = rowToOrchestratorReceipt(receiptRow({ state: "pending", started_at: null }));
  const projection = projectOrchestratorLiveness(receipt, session({ processLiveness: "alive" }));
  assert.equal(projection.presentation, "pending");
  assert.equal(projection.running, false);
});

test("a state this binary does not understand is reported verbatim and is never running", () => {
  const receipt = rowToOrchestratorReceipt(receiptRow({ state: "quiescing" }));
  const projection = projectOrchestratorLiveness(receipt, session({ processLiveness: "alive" }));
  assert.equal(projection.presentation, "unrecognized");
  assert.equal(projection.running, false);
  assert.equal(projection.recordedState, "quiescing");
});

// ─── 3. FG-448: no credential in a projection that can span projects ─────────

test("FG-448: OrchestratorEntry carries no url member — the prohibition is structural", () => {
  // A type-level assertion: if a `url` / `remoteControlUrl` member is ever added to
  // OrchestratorEntry, this stops compiling. `dashboard` runs `tsc --noEmit` in CI,
  // so a compile failure here is a test failure.
  type HasCredential = "url" extends keyof OrchestratorEntry ? true
    : "remoteControlUrl" extends keyof OrchestratorEntry ? true
    : false;
  const structurallyAbsent: HasCredential = false;
  assert.equal(structurallyAbsent, false);
});

test("FG-448: the liveness projection emits no credential-shaped value for any receipt state", () => {
  // Every state, live and dead, deep-scanned. A URL cannot appear because the
  // projection never reads the credential store — but "never" has to be asserted
  // over the actual output, not over the code that produces it.
  for (const state of [...ORCHESTRATOR_RECEIPT_STATES, "some_future_state"]) {
    for (const candidate of [undefined, session({ processLiveness: "alive" }), session({ processLiveness: "dead" })]) {
      const projection = projectOrchestratorLiveness(rowToOrchestratorReceipt(receiptRow({ state })), candidate);
      const serialized = JSON.stringify(projection);
      assert.ok(!serialized.includes("claude.ai/code/session_"), `credential leaked for state ${state}`);
      assert.ok(!/"(remoteControlUrl|url)"\s*:/.test(serialized), `a url-shaped key appeared for state ${state}`);
    }
  }
});
