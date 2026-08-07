// FG-576 step 1 — the launcher-owned orchestrator receipt, proven by EXECUTION
// against a real (in-memory) store rather than by asserting on source shape.
//
// Nothing writes a receipt yet — the launcher primitive is step 5 — so this file IS
// the contract those steps consume. Four properties, each with a named acceptance:
//
//   AC6/AC11  the full pre-spawn decision ROUND-TRIPS, field for field, including
//             provider/runtime/adapter/resolved_by, the identity strength, the
//             instruction-carrier provenance and the recorded capability limitations.
//   D15       the five lifecycle states move along the four legal edges ONLY, and an
//             illegal move is refused BY NAME rather than silently applied.
//   D11       a store that cannot be written surfaces a TYPED error naming the write
//             target and a retry remedy — the input the launcher's pre-spawn refusal
//             consumes. Never swallowed.
//   AC8/AC9   trust-bearing values decode DOWN: an unrecognized identity strength is
//             `unknown` and an unrecognized carrier acceptance is `unproven`, so a row
//             this binary cannot interpret can never read as asserted or accepted.
//
// Every DB here is in-memory or under the per-process temp FORGE_HOME the harness
// installs (src/test-setup.ts) — never the operator's ~/.forge/forge.db (AC13).

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { join } from "node:path";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { makeInMemoryDb, setDbForTest, getDb } from "./db.js";
import { SCHEMA_SQL } from "./schema.js";
import { FORGE_HOME } from "../util/paths.js";
import {
  ORCHESTRATOR_RECEIPT_STATES,
  LEGAL_RECEIPT_TRANSITIONS,
  TERMINAL_RECEIPT_STATES,
  SESSION_IDENTITY_STRENGTHS,
  CARRIER_ACCEPTANCES,
  OrchestratorReceiptWriteError,
  OrchestratorReceiptTransitionError,
  persistPendingOrchestratorReceipt,
  markOrchestratorReceiptRunning,
  closeOrchestratorReceipt,
  recordOrchestratorSessionIdentity,
  getOrchestratorReceipt,
  findOrchestratorReceiptBySessionIdentity,
  listOrchestratorReceiptsForProject,
  listOrchestratorReceiptsClaimingRunning,
  listOpenOrchestratorReceipts,
  isLegalReceiptTransition,
  newOrchestratorReceiptId,
  type OrchestratorLaunchDecision,
  type OrchestratorReceiptState,
} from "./orchestrator-receipts.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
});

afterEach(() => {
  if (prev) setDbForTest(prev);
  db.close();
});

// The complete Claude-side decision — every column populated, so the round-trip
// assertion cannot pass vacuously on a field nobody set.
const CLAUDE_DECISION: OrchestratorLaunchDecision = {
  receiptId: "orx-claude-1",
  sessionKey: "11111111-2222-3333-4444-555555555555",
  projectDir: "/tmp/test-project",
  projectName: "test-project",
  resolvedProfile: "claude-subscription",
  runtime: "claude-code",
  provider: "anthropic",
  model: "claude-opus-5",
  authMode: "anthropic-oauth",
  resolvedBy: "cli:--profile",
  adapter: "claude",
  sessionOperation: "new",
  sessionTarget: null,
  providerSessionId: "11111111-2222-3333-4444-555555555555",
  identityStrength: "asserted",
  identityBasis: "forge minted --session-id before spawn",
  carrier: {
    generation: "gen-2026-08-07",
    path: "/tmp/forge-home/generations/gen-2026-08-07/orchestrator-prompt.md",
    acceptance: "accepted",
    evidence: "--append-system-prompt-file echoed in the session preamble",
  },
  limitations: [],
  taskId: "task-orchestrator-abc123",
  launcherPid: 4242,
  launcherIdentity: "boot-1000:4242:987654",
  createdAt: "2026-08-07T10:00:00.000Z",
};

// The Codex-side decision — the honest parity gap, in the shape AC9/AC12 require.
const CODEX_DECISION: OrchestratorLaunchDecision = {
  receiptId: "orx-codex-1",
  sessionKey: "99999999-8888-7777-6666-555555555555",
  projectDir: "/tmp/proj",
  projectName: "proj",
  resolvedProfile: "codex-subscription",
  runtime: "codex-cli",
  provider: "openai",
  model: "gpt-5-codex",
  authMode: "openai-subscription",
  resolvedBy: "policy:overrides.agents.orchestrator",
  adapter: "codex",
  sessionOperation: "resume",
  sessionTarget: "99999999-8888-7777-6666-555555555555",
  identityStrength: "correlated",
  identityBasis: "newest session file under the disposable codex home within 5s of spawn",
  carrier: {
    generation: "gen-2026-08-07",
    path: "/tmp/forge-home/generations/gen-2026-08-07/codex/orchestrator-instructions.md",
    acceptance: "unproven",
    evidence: null,
  },
  limitations: [
    { capability: "usage_capture", note: "codex-cli 0.144.1 supplies no equivalent per-call usage evidence" },
    { capability: "remote_control", note: "no remote-control URL is exposed by this adapter" },
  ],
  createdAt: "2026-08-07T11:00:00.000Z",
};

// ===========================================================================
// AC6 / AC11 — the whole pre-spawn decision round-trips, field for field.
// ===========================================================================
test("AC6/AC11: every recorded field of the pre-spawn decision round-trips, and the row starts NON-LIVE", () => {
  const persisted = persistPendingOrchestratorReceipt(CLAUDE_DECISION);
  assert.equal(persisted.state, "pending", "D15: a receipt is persisted NON-LIVE before spawn");
  assert.equal(persisted.claimsRunning, false, "a pending receipt claims nothing about a running session");
  assert.equal(persisted.terminal, false);

  const read = getOrchestratorReceipt("orx-claude-1");
  assert.ok(read, "the receipt is readable by id");
  assert.deepEqual(
    {
      receiptId: read.receiptId,
      sessionKey: read.sessionKey,
      projectDir: read.projectDir,
      projectName: read.projectName,
      resolvedProfile: read.resolvedProfile,
      runtime: read.runtime,
      provider: read.provider,
      model: read.model,
      authMode: read.authMode,
      resolvedBy: read.resolvedBy,
      adapter: read.adapter,
      sessionOperation: read.sessionOperation,
      sessionTarget: read.sessionTarget,
      providerSessionId: read.providerSessionId,
      identityStrength: read.identityStrength,
      identityBasis: read.identityBasis,
      carrier: read.carrier,
      limitations: read.limitations,
      taskId: read.taskId,
      launcherPid: read.launcherPid,
      launcherIdentity: read.launcherIdentity,
      createdAt: read.createdAt,
    },
    {
      receiptId: "orx-claude-1",
      sessionKey: "11111111-2222-3333-4444-555555555555",
      projectDir: "/tmp/test-project",
      projectName: "test-project",
      resolvedProfile: "claude-subscription",
      runtime: "claude-code",
      provider: "anthropic",
      model: "claude-opus-5",
      authMode: "anthropic-oauth",
      resolvedBy: "cli:--profile",
      adapter: "claude",
      sessionOperation: "new",
      sessionTarget: null,
      providerSessionId: "11111111-2222-3333-4444-555555555555",
      identityStrength: "asserted",
      identityBasis: "forge minted --session-id before spawn",
      carrier: {
        generation: "gen-2026-08-07",
        path: "/tmp/forge-home/generations/gen-2026-08-07/orchestrator-prompt.md",
        acceptance: "accepted",
        evidence: "--append-system-prompt-file echoed in the session preamble",
      },
      limitations: [],
      taskId: "task-orchestrator-abc123",
      launcherPid: 4242,
      launcherIdentity: "boot-1000:4242:987654",
      createdAt: "2026-08-07T10:00:00.000Z",
    },
    "the full decision survives the round trip — nothing is dropped, defaulted or reinterpreted",
  );
});

test("AC12: the recorded capability limitations round-trip verbatim — no value is invented anywhere", () => {
  persistPendingOrchestratorReceipt(CODEX_DECISION);
  const read = getOrchestratorReceipt("orx-codex-1");
  assert.deepEqual(read?.limitations, [
    { capability: "usage_capture", note: "codex-cli 0.144.1 supplies no equivalent per-call usage evidence" },
    { capability: "remote_control", note: "no remote-control URL is exposed by this adapter" },
  ]);
  assert.equal(read?.identityStrength, "correlated", "the honest identity strength is recorded, not upgraded");
  assert.equal(read?.carrier.acceptance, "unproven", "AC8: nothing promotes a carrier to accepted without evidence");
});

test("a decision that names no strength/acceptance/limitations reads FAIL-CLOSED, not blank-and-trusted", () => {
  persistPendingOrchestratorReceipt({
    sessionKey: "bare-session",
    projectDir: "/tmp/x",
    runtime: "codex-cli",
    provider: "openai",
    adapter: "codex",
    sessionOperation: "new",
    receiptId: "orx-bare",
  });
  const read = getOrchestratorReceipt("orx-bare");
  assert.equal(read?.identityStrength, "unknown", "an unstated identity strength is unknown, never asserted");
  assert.equal(read?.carrier.acceptance, "unproven", "AC8: an unstated carrier acceptance is unproven");
  assert.deepEqual(read?.limitations, []);
  assert.equal(read?.model, null, "an unresolved model is null — never a fabricated default");
});

// ===========================================================================
// D15 — the lifecycle. Four legal edges, everything else refused by name.
// ===========================================================================
test("D15: pending -> running only after a confirmed spawn, and running -> exited closes it honestly", () => {
  persistPendingOrchestratorReceipt(CLAUDE_DECISION);

  const running = markOrchestratorReceiptRunning("orx-claude-1", {
    startedAt: "2026-08-07T10:00:01.000Z",
    launcherPid: 4242,
    launcherIdentity: "boot-1000:4242:987654",
  });
  assert.equal(running.state, "running");
  assert.equal(running.claimsRunning, true);
  assert.equal(running.startedAt, "2026-08-07T10:00:01.000Z", "started_at records the CONFIRMED spawn");
  assert.equal(running.terminal, false);

  const exited = closeOrchestratorReceipt("orx-claude-1", {
    state: "exited",
    exitCode: 0,
    closedAt: "2026-08-07T12:00:00.000Z",
  });
  assert.equal(exited.state, "exited");
  assert.equal(exited.exitCode, 0);
  assert.equal(exited.exitSignal, null);
  assert.equal(exited.closedAt, "2026-08-07T12:00:00.000Z");
  assert.equal(exited.terminal, true);
  assert.equal(exited.claimsRunning, false, "a closed receipt claims nothing about a running session");
});

test("D15: a signal-killed child and a spawn failure each close the SAME receipt honestly", () => {
  persistPendingOrchestratorReceipt({ ...CLAUDE_DECISION, receiptId: "orx-signal" });
  markOrchestratorReceiptRunning("orx-signal");
  const killed = closeOrchestratorReceipt("orx-signal", { state: "exited", signal: "SIGKILL" });
  assert.equal(killed.state, "exited");
  assert.equal(killed.exitSignal, "SIGKILL");
  assert.equal(killed.exitCode, null, "a signalled exit records the signal, not an invented exit code");

  persistPendingOrchestratorReceipt({ ...CLAUDE_DECISION, receiptId: "orx-nospawn" });
  const failed = closeOrchestratorReceipt("orx-nospawn", {
    state: "spawn_failed",
    reason: "claude: command not found on PATH",
  });
  assert.equal(failed.state, "spawn_failed");
  assert.equal(failed.failureReason, "claude: command not found on PATH");
  assert.equal(failed.startedAt, null, "a spawn that never happened records no start");
});

test("D17: orphaned asserts LAUNCHER loss only — it records no exit code and no signal", () => {
  persistPendingOrchestratorReceipt({ ...CLAUDE_DECISION, receiptId: "orx-orphan" });
  markOrchestratorReceiptRunning("orx-orphan");
  const orphaned = closeOrchestratorReceipt("orx-orphan", {
    state: "orphaned",
    reason: "launcher process identity is gone; child disposition not asserted",
  });
  assert.equal(orphaned.state, "orphaned");
  assert.equal(orphaned.exitCode, null, "orphaned must not claim the child exited");
  assert.equal(orphaned.exitSignal, null, "orphaned must not claim the child was signalled");
  assert.match(orphaned.failureReason ?? "", /launcher/i, "the recorded reason names what was actually lost");
});

// The legality table is asserted EXHAUSTIVELY over all 25 ordered pairs, executed
// against a real store — not just the four happy edges. A widened table (or a
// dropped guard) fails here rather than in a downstream adapter.
test("D15: all 25 ordered state pairs — exactly four are legal, and every other move is REFUSED", () => {
  const legalPairs: string[] = [];
  for (const from of ORCHESTRATOR_RECEIPT_STATES) {
    for (const to of ORCHESTRATOR_RECEIPT_STATES) {
      if (isLegalReceiptTransition(from, to)) legalPairs.push(`${from}->${to}`);
    }
  }
  assert.deepEqual(
    legalPairs.sort(),
    ["pending->running", "pending->spawn_failed", "running->exited", "running->orphaned"].sort(),
    "the legality table is exactly D15's four edges",
  );

  // ...and the table is ENFORCED, not merely declared. Drive every illegal pair
  // through the real accessors against a real store.
  const reach = (target: OrchestratorReceiptState, id: string): void => {
    persistPendingOrchestratorReceipt({ ...CLAUDE_DECISION, receiptId: id, sessionKey: id });
    if (target === "pending") return;
    if (target === "running") {
      markOrchestratorReceiptRunning(id);
      return;
    }
    if (target === "spawn_failed") {
      closeOrchestratorReceipt(id, { state: "spawn_failed" });
      return;
    }
    markOrchestratorReceiptRunning(id);
    closeOrchestratorReceipt(id, { state: target === "exited" ? "exited" : "orphaned" });
  };

  let n = 0;
  for (const from of ORCHESTRATOR_RECEIPT_STATES) {
    for (const to of ORCHESTRATOR_RECEIPT_STATES) {
      if (isLegalReceiptTransition(from, to)) continue;
      const id = `orx-pair-${n++}`;
      reach(from, id);
      const attempt = (): unknown =>
        to === "running" ? markOrchestratorReceiptRunning(id) : closeOrchestratorReceipt(id, { state: to as never });
      if (to === "pending") continue; // no accessor can write `pending` onto an existing receipt at all
      assert.throws(
        attempt,
        (e: unknown) => e instanceof OrchestratorReceiptTransitionError,
        `${from} -> ${to} must be refused by name, not silently applied`,
      );
      // The refusal left the stored state EXACTLY as it was.
      assert.equal(getOrchestratorReceipt(id)?.state, from, `${from} -> ${to} must not mutate the receipt`);
    }
  }
});

test("D15: a transition on a receipt that does not exist is refused, and creates nothing", () => {
  assert.throws(
    () => markOrchestratorReceiptRunning("orx-never-persisted"),
    (e: unknown) => e instanceof OrchestratorReceiptTransitionError && /no orchestrator receipt/i.test((e as Error).message),
  );
  assert.equal(getOrchestratorReceipt("orx-never-persisted"), undefined, "a refused transition invents no row");
});

test("D15: a state this binary does not understand is refused, never reinterpreted as one it does", () => {
  persistPendingOrchestratorReceipt({ ...CLAUDE_DECISION, receiptId: "orx-future" });
  // A newer forge recorded a state outside this binary's vocabulary.
  getDb().prepare(`UPDATE orchestrator_receipts SET state = 'suspended' WHERE receipt_id = ?`).run("orx-future");

  const read = getOrchestratorReceipt("orx-future");
  assert.equal(read?.state, "suspended", "the recorded state is carried verbatim");
  assert.equal(read?.stateRecognized, false);
  assert.equal(read?.claimsRunning, false, "an unrecognized state is NOT a claim of a running session");
  assert.equal(read?.terminal, false, "and it is not silently declared terminal either");
  assert.throws(
    () => closeOrchestratorReceipt("orx-future", { state: "exited" }),
    (e: unknown) => e instanceof OrchestratorReceiptTransitionError && /does not understand/i.test((e as Error).message),
  );
});

test("the compare-and-set refuses a transition whose expected state was moved by another writer", () => {
  persistPendingOrchestratorReceipt({ ...CLAUDE_DECISION, receiptId: "orx-race" });
  markOrchestratorReceiptRunning("orx-race");
  closeOrchestratorReceipt("orx-race", { state: "exited", exitCode: 3 });
  // The would-be second closer read `running` before the first closer committed.
  assert.throws(
    () => closeOrchestratorReceipt("orx-race", { state: "orphaned" }),
    (e: unknown) => e instanceof OrchestratorReceiptTransitionError,
    "a terminal receipt is never resurrected",
  );
  const read = getOrchestratorReceipt("orx-race");
  assert.equal(read?.state, "exited");
  assert.equal(read?.exitCode, 3, "the first writer's terminal facts survive intact");
});

// ===========================================================================
// D11 — an unwritable store surfaces a TYPED error. Never swallowed.
// ===========================================================================
test("D11: a store that cannot be written raises a typed error naming the target and a retry remedy", () => {
  // A genuinely unwritable store: a real file opened READ-ONLY, installed as the
  // process handle. Nothing here touches the operator's ~/.forge (AC13).
  // The file carries the REAL schema, so the only reason the write can fail is that
  // the store is not writable — not a missing table.
  const path = join(FORGE_HOME, "fg576-readonly.db");
  const build = new Database(path);
  build.exec(SCHEMA_SQL);
  build.close();

  const readonly = new Database(path, { readonly: true });
  readonly.pragma("busy_timeout = 0"); // fail fast: the refusal is the point, not the wait
  const restore = setDbForTest(readonly);
  try {
    let thrown: unknown;
    try {
      persistPendingOrchestratorReceipt({ ...CLAUDE_DECISION, receiptId: "orx-unwritable" });
    } catch (e) {
      thrown = e;
    }
    assert.ok(
      thrown instanceof OrchestratorReceiptWriteError,
      `the write failure must surface as OrchestratorReceiptWriteError, got ${String(thrown)}`,
    );
    const err = thrown as OrchestratorReceiptWriteError;
    assert.equal(err.receiptId, "orx-unwritable", "the refusal names the receipt it could not write");
    assert.ok(err.dbPath.length > 0, "the refusal carries the write target");
    assert.match(err.message, /nothing was spawned/i, "D11: the refusal states that no session was started");
    assert.match(err.message, /retry/i, "D11: the refusal is retryable and says so");
    assert.match(err.message, new RegExp(err.dbPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "it names the store path");
    assert.ok(err.cause !== undefined, "the underlying store error is preserved, not discarded");
  } finally {
    if (restore) setDbForTest(restore);
    readonly.close();
  }
});

test("D11: a duplicate receipt id is a write refusal, never a silent overwrite of the first launch", () => {
  persistPendingOrchestratorReceipt({ ...CLAUDE_DECISION, receiptId: "orx-dup" });
  markOrchestratorReceiptRunning("orx-dup");
  assert.throws(
    () => persistPendingOrchestratorReceipt({ ...CODEX_DECISION, receiptId: "orx-dup" }),
    (e: unknown) => e instanceof OrchestratorReceiptWriteError,
  );
  const read = getOrchestratorReceipt("orx-dup");
  assert.equal(read?.provider, "anthropic", "the first launch's receipt is untouched by the refused second write");
  assert.equal(read?.state, "running");
});

// ===========================================================================
// AC8/AC9 — trust-bearing decode is DOWNWARD only.
// ===========================================================================
test("AC9: an identity strength this binary does not recognize decodes to `unknown`, never to `asserted`", () => {
  persistPendingOrchestratorReceipt({ ...CODEX_DECISION, receiptId: "orx-strength" });
  getDb()
    .prepare(`UPDATE orchestrator_receipts SET identity_strength = 'provably-bound' WHERE receipt_id = ?`)
    .run("orx-strength");
  assert.equal(getOrchestratorReceipt("orx-strength")?.identityStrength, "unknown");
  assert.ok(SESSION_IDENTITY_STRENGTHS.includes("ambiguous"), "'ambiguous' stays a first-class recorded value");
});

test("AC8: a carrier acceptance this binary does not recognize decodes to `unproven`, never to `accepted`", () => {
  persistPendingOrchestratorReceipt({ ...CODEX_DECISION, receiptId: "orx-carrier" });
  getDb()
    .prepare(`UPDATE orchestrator_receipts SET carrier_acceptance = 'probably-fine' WHERE receipt_id = ?`)
    .run("orx-carrier");
  assert.equal(getOrchestratorReceipt("orx-carrier")?.carrier.acceptance, "unproven");
  assert.deepEqual([...CARRIER_ACCEPTANCES], ["accepted", "unproven", "not_applicable"]);
});

test("a malformed limitations blob reports NO limitations rather than a guessed one", () => {
  persistPendingOrchestratorReceipt({ ...CODEX_DECISION, receiptId: "orx-badjson" });
  getDb().prepare(`UPDATE orchestrator_receipts SET limitations = '{oops' WHERE receipt_id = ?`).run("orx-badjson");
  assert.deepEqual(getOrchestratorReceipt("orx-badjson")?.limitations, []);
  getDb()
    .prepare(`UPDATE orchestrator_receipts SET limitations = '[{"capability":"usage_capture"},"junk"]' WHERE receipt_id = ?`)
    .run("orx-badjson");
  assert.deepEqual(getOrchestratorReceipt("orx-badjson")?.limitations, [], "a half-shaped entry is dropped, not filled in");
});

// ===========================================================================
// AC10 — cross-provider resume is answered from the RECEIPT, not from a format.
// ===========================================================================
test("AC10: a session identifier resolves to the receipt that minted it, carrying its provider", () => {
  persistPendingOrchestratorReceipt(CLAUDE_DECISION);
  persistPendingOrchestratorReceipt(CODEX_DECISION);

  const claude = findOrchestratorReceiptBySessionIdentity("11111111-2222-3333-4444-555555555555");
  assert.equal(claude?.provider, "anthropic");
  assert.equal(claude?.adapter, "claude");

  const codex = findOrchestratorReceiptBySessionIdentity("99999999-8888-7777-6666-555555555555");
  assert.equal(codex?.provider, "openai");
  assert.equal(codex?.adapter, "codex");

  // Both identifiers are bare UUIDs of identical shape: only the receipt tells them
  // apart, which is why the refusal must be a lookup and never a format check.
  assert.match(claude?.sessionKey ?? "", /^[0-9a-f-]{36}$/);
  assert.match(codex?.sessionKey ?? "", /^[0-9a-f-]{36}$/);

  assert.equal(findOrchestratorReceiptBySessionIdentity("not-a-session"), undefined);
});

test("the provider's OWN session id is bindable after spawn, and never onto a closed receipt", () => {
  persistPendingOrchestratorReceipt({
    ...CODEX_DECISION,
    receiptId: "orx-correlate",
    providerSessionId: null,
    identityStrength: "unknown",
    identityBasis: null,
  });
  markOrchestratorReceiptRunning("orx-correlate");

  const bound = recordOrchestratorSessionIdentity("orx-correlate", {
    providerSessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    strength: "correlated",
    basis: "single codex session file created within the correlation window",
  });
  assert.equal(bound.providerSessionId, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  assert.equal(bound.identityStrength, "correlated");
  assert.equal(bound.state, "running", "binding an identity is not a lifecycle move");
  assert.equal(
    findOrchestratorReceiptBySessionIdentity("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")?.receiptId,
    "orx-correlate",
  );

  // Two overlapping sessions: the ambiguity is RECORDED, not resolved by a guess.
  const ambiguous = recordOrchestratorSessionIdentity("orx-correlate", {
    providerSessionId: null,
    strength: "ambiguous",
    basis: "two codex session files created within the correlation window",
  });
  assert.equal(ambiguous.identityStrength, "ambiguous");
  assert.equal(ambiguous.providerSessionId, null, "an ambiguous correlation binds no id at all");

  closeOrchestratorReceipt("orx-correlate", { state: "exited", exitCode: 0 });
  assert.throws(
    () => recordOrchestratorSessionIdentity("orx-correlate", { strength: "correlated", basis: "too late" }),
    (e: unknown) => e instanceof OrchestratorReceiptTransitionError && /closed receipt/i.test((e as Error).message),
  );
});

// ===========================================================================
// FG-576: the project read resolves project_dir the way the launcher's cwd
// already did. Proven with an EXPLICIT symlink rather than by relying on the
// host's tmpdir layout, so the darwin `/var` -> `/private/var` failure this
// closes reproduces on every platform.
// ===========================================================================
test("a project read finds the receipt through any spelling of the same directory, and never throws on one that is gone", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "fg576-receipt-canon-")));
  const physical = join(base, "project");
  const link = join(base, "link-to-project");
  mkdirSync(physical);
  symlinkSync(physical, link);
  try {
    persistPendingOrchestratorReceipt({ ...CLAUDE_DECISION, receiptId: "orx-canon", projectDir: physical });

    assert.equal(listOrchestratorReceiptsForProject(physical).length, 1, "the physical path reads its own receipt");
    assert.equal(
      listOrchestratorReceiptsForProject(link).length,
      1,
      "a symlinked spelling is the same directory: a live orchestrator must not go missing from an operator surface",
    );
    assert.equal(listOrchestratorReceiptsForProject(`${physical}/`).length, 1, "a trailing slash is the same directory");
    assert.equal(
      listOrchestratorReceiptsForProject(join(base, "sibling")).length,
      0,
      "resolution never widens the read to another directory",
    );

    rmSync(physical, { recursive: true, force: true });
    assert.equal(
      listOrchestratorReceiptsForProject(physical).length,
      1,
      "a project that no longer resolves degrades to its as-written spelling rather than throwing on an operator read",
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("the WRITE path files a receipt under the canonical dir, so either spelling written is found by either spelling read", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "fg576-receipt-write-canon-")));
  const physical = join(base, "project");
  const link = join(base, "link-to-project");
  mkdirSync(physical);
  symlinkSync(physical, link);
  try {
    // The two directions the launcher can hold the SAME directory in: a symlinked
    // spelling (the darwin `/tmp` -> `/private/tmp` case) and the physical one.
    persistPendingOrchestratorReceipt({ ...CLAUDE_DECISION, receiptId: "orx-wrote-link", projectDir: link });
    persistPendingOrchestratorReceipt({
      ...CLAUDE_DECISION,
      receiptId: "orx-wrote-physical",
      projectDir: physical,
      sessionKey: "s-physical",
    });

    assert.deepEqual(
      getDb().prepare(`SELECT receipt_id, project_dir FROM orchestrator_receipts ORDER BY receipt_id`).all(),
      [
        { receipt_id: "orx-wrote-link", project_dir: physical },
        { receipt_id: "orx-wrote-physical", project_dir: physical },
      ],
      "project_dir is STORED canonical whatever spelling the launcher held — one directory is one key",
    );

    for (const spelling of [physical, link, `${link}/`, `${physical}/`]) {
      assert.deepEqual(
        listOrchestratorReceiptsForProject(spelling).map((r) => r.receiptId).sort(),
        ["orx-wrote-link", "orx-wrote-physical"],
        `both receipts must be readable through ${spelling}`,
      );
    }

    assert.equal(
      getOrchestratorReceipt("orx-wrote-link")?.projectDir,
      physical,
      "and the receipt reports the directory it is actually filed under, not the spelling it was handed",
    );
    assert.equal(
      listOrchestratorReceiptsForProject(join(base, "sibling")).length,
      0,
      "canonicalizing the write never widens a receipt to another directory",
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ===========================================================================
// The read surfaces the downstream steps consume.
// ===========================================================================
test("read surfaces: by project, claiming-running, and open — and `running` is never called live", () => {
  persistPendingOrchestratorReceipt({ ...CLAUDE_DECISION, receiptId: "orx-p1", projectDir: "/tmp/proj" });
  persistPendingOrchestratorReceipt({ ...CLAUDE_DECISION, receiptId: "orx-p2", projectDir: "/tmp/proj", sessionKey: "s2" });
  persistPendingOrchestratorReceipt({ ...CLAUDE_DECISION, receiptId: "orx-other", projectDir: "/tmp/x", sessionKey: "s3" });

  markOrchestratorReceiptRunning("orx-p1");

  const forProject = listOrchestratorReceiptsForProject("/tmp/proj");
  assert.deepEqual(forProject.map((r) => r.receiptId).sort(), ["orx-p1", "orx-p2"]);
  assert.equal(
    listOrchestratorReceiptsForProject("/tmp/x").length,
    1,
    "a project read never returns another project's receipts",
  );

  const claiming = listOrchestratorReceiptsClaimingRunning();
  assert.deepEqual(claiming.map((r) => r.receiptId), ["orx-p1"]);
  assert.ok(
    claiming.every((r) => r.claimsRunning),
    "the running set is a CLAIM set — a surface must still join liveness before rendering it (AC7)",
  );

  assert.deepEqual(
    listOpenOrchestratorReceipts().map((r) => r.receiptId).sort(),
    ["orx-other", "orx-p1", "orx-p2"],
    "the open set carries pending AND running — both are non-terminal",
  );

  closeOrchestratorReceipt("orx-p1", { state: "orphaned" });
  assert.deepEqual(listOrchestratorReceiptsClaimingRunning(), [], "an orphaned receipt stops claiming running");
  assert.deepEqual(
    listOpenOrchestratorReceipts().map((r) => r.receiptId).sort(),
    ["orx-other", "orx-p2"],
    "and drops out of the open set",
  );
});

test("minted receipt ids are unique and namespaced", () => {
  const ids = new Set(Array.from({ length: 200 }, () => newOrchestratorReceiptId()));
  assert.equal(ids.size, 200);
  for (const id of ids) assert.match(id, /^orx-[0-9a-f]{12}$/);
});

test("the terminal set is derived from the legality table, not restated", () => {
  assert.deepEqual([...TERMINAL_RECEIPT_STATES].sort(), ["exited", "orphaned", "spawn_failed"]);
  for (const s of TERMINAL_RECEIPT_STATES) {
    assert.deepEqual([...LEGAL_RECEIPT_TRANSITIONS[s]], [], `${s} must have no successors`);
  }
});
