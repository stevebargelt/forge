// FG-576 step 5 — THE SHARED INTERACTIVE ORCHESTRATOR LAUNCH PRIMITIVE.
//
// `forge orchestrator` and `forge claude` both run through this file, and NEITHER
// the commands nor the adapters own any part of the lifecycle. That is the whole
// point: two commands that each implemented their own receipt/liveness/close-out
// would drift, and the drift would show up as a phantom orchestrator rather than as
// a failing test.
//
// THE ORDER IS THE CONTRACT (D11 / D15). It is not an implementation detail:
//
//   1. RESOLVE            src/v2/orchestrator-resolve.ts. No spawn path exists there,
//                         so "fails before spawn" is structural (AC5).
//   2. GATE               provider pin, passthrough closure (D6), adapter readiness.
//                         Every refusal here happens before ANYTHING is recorded.
//   3. RECORD NON-LIVE    the receipt is persisted `pending`. If it cannot be
//                         written, the launcher REFUSES with the store's own
//                         actionable, retryable message and spawns nothing — an
//                         orchestrator forge cannot record is not launched (D11).
//   4. PROVE WRITABLE     the liveness namespace is created and probed BEFORE spawn,
//                         so a session can never start into a namespace that will
//                         then refuse its record.
//   5. MATERIALIZE        the Forge-owned instruction carrier, under Forge's own
//                         root only. Nothing is written into an operator config root.
//   6. SPAWN              and wait for node's `spawn` event — a CONFIRMED spawn.
//   7. GO LIVE            receipt `pending` -> `running` AND the launcher-owned
//                         liveness record appears, in that order, only now.
//   8. CLOSE HONESTLY     child exit / signal -> `exited`; a child that never
//                         started -> `spawn_failed`. A launcher killed mid-session
//                         writes nothing at all, which is exactly why its record
//                         classifies as `orphaned` by process identity rather than
//                         staying `running` forever (D14/D17, AC7).
//
// Step 3 and step 4 are separated ON PURPOSE. A carrier materialized before the
// receipt would leave an instruction file behind for a launch that was refused; a
// liveness record written before the spawn would claim a session that does not
// exist. Both are the same failure — a durable artifact that outlives the thing it
// describes — and both are ordered out of existence rather than cleaned up after.

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve as pathResolve } from "node:path";
import {
  closeOrchestratorReceipt,
  markOrchestratorReceiptRunning,
  newOrchestratorReceiptId,
  persistPendingOrchestratorReceipt,
  recordOrchestratorSessionIdentity,
  OrchestratorReceiptWriteError,
  type CapabilityLimitation,
  type SessionOperation,
} from "../store/orchestrator-receipts.js";
import { insertRun, updateRunStatus } from "../store/runs.js";
import { insertTask } from "../store/tasks.js";
import { newRunId, newTaskId, nowIso } from "../util/ids.js";
import { captureProcessIdentity } from "../util/process-identity.js";
import {
  closeLauncherHeartbeat,
  refreshLauncherHeartbeat,
  writeLauncherHeartbeat,
  HeartbeatWriteError,
} from "../util/orchestrator-heartbeats.js";
import { resolveProjectMeta } from "../util/project-meta.js";
import type { AuthProbe } from "../v2/provider-doctor.js";
import type { EffectiveAuth } from "../v2/model-resolution.js";
import type { OrchestratorAdapterId } from "../v2/orchestrator-capabilities.js";
import {
  explainDecision,
  resolveOrchestratorLaunch,
  type OrchestratorDecision,
  type OrchestratorRefusal,
  type OrchestratorSessionOperation,
} from "../v2/orchestrator-resolve.js";
import { createClaudeAdapter } from "./claude-adapter.js";
import {
  isSafeSessionIdentifier,
  launchRefusal,
  tokenTargetsFlag,
  type AdapterCarrier,
  type AdapterLaunchContext,
  type AdapterReadiness,
  type AdapterSessionIdentity,
  type LaunchRefusal,
  type OrchestratorAdapter,
} from "./adapter.js";

const ORCHESTRATOR_MARKER = "<!-- forge:orchestrator-start -->";

// ---------------------------------------------------------------------------
// Adapter registry
// ---------------------------------------------------------------------------

type AdapterFactory = () => OrchestratorAdapter;

const ADAPTER_FACTORIES = new Map<OrchestratorAdapterId, AdapterFactory>([
  ["claude-code", () => createClaudeAdapter()],
]);

/** Register an interactive adapter implementation. The registry is a MAP rather than
 *  a literal so an adapter shipped by a later step registers itself without this file
 *  reaching forward into a module that does not exist yet. */
export function registerOrchestratorAdapter(id: OrchestratorAdapterId, factory: AdapterFactory): void {
  ADAPTER_FACTORIES.set(id, factory);
}

export function resolveOrchestratorAdapter(id: OrchestratorAdapterId): OrchestratorAdapter | undefined {
  return ADAPTER_FACTORIES.get(id)?.();
}

// ---------------------------------------------------------------------------
// Project root
// ---------------------------------------------------------------------------

/** Walk up from `start` for the CLAUDE.md carrying the forge orchestrator marker.
 *  Falls back to `start` when there is none (a non-forge project, or one that has
 *  not run `forge init`), which is the behavior `forge claude` has always had. */
export function resolveOrchestratorProjectRoot(start: string): string {
  let dir = pathResolve(start);
  for (;;) {
    const claudeMd = join(dir, "CLAUDE.md");
    if (existsSync(claudeMd)) {
      try {
        if (readFileSync(claudeMd, "utf8").includes(ORCHESTRATOR_MARKER)) return dir;
      } catch {
        /* unreadable; continue up */
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return pathResolve(start); // reached the filesystem root
    dir = parent;
  }
}

// ---------------------------------------------------------------------------
// D6 — the passthrough closure
// ---------------------------------------------------------------------------

/**
 * Provider passthrough is a documented explicit-separator surface, NOT a second
 * unrecorded way to change the launch. A token that targets a flag the adapter
 * declares reserved is refused before spawn, naming D6 and the Forge-owned flag that
 * owns that dimension.
 *
 * The check is on the FLAG, in both `--flag value` and `--flag=value` forms, and it
 * is deliberately a denylist over an adapter-declared set rather than an allowlist:
 * passthrough exists so provider-native flags Forge knows nothing about still work.
 * What Forge owns, Forge keeps.
 */
export function guardPassthrough(adapter: OrchestratorAdapter, tokens: readonly string[]): LaunchRefusal | null {
  for (const token of tokens) {
    const hit = adapter.reservedPassthroughFlags.find((flag) => tokenTargetsFlag(token, flag));
    if (hit === undefined) continue;
    return launchRefusal(
      "passthrough-not-permitted",
      `\`${hit}\` cannot be passed through to ${adapter.displayName}: it sets a dimension Forge owns and records ` +
        `(provider, model, auth, project root, instruction surface or session identity). D6 — provider passthrough ` +
        `is never a second, unrecorded way to change the launch, because the receipt would then describe a session ` +
        `that is not the one running.`,
      [
        `use Forge's own flags instead: \`--profile\`, \`--model\`, \`--continue\`, \`--resume <id>\``,
        `run \`forge orchestrator --explain\` to see the effective choice before launching`,
        `pass only provider-native flags Forge does not own after the \`--\` separator`,
      ],
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Planning (no spawn, no writes — the surface step 9 asserts argument closure on)
// ---------------------------------------------------------------------------

export type LaunchPlan = {
  adapter: OrchestratorAdapter;
  executable: string;
  argv: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  carrier: AdapterCarrier;
  identity: AdapterSessionIdentity;
  sessionTarget: string | null;
  readiness: AdapterReadiness;
  advisories: string[];
  notes: string[];
  limitations: CapabilityLimitation[];
};

export type LaunchPlanResult = { ok: true; plan: LaunchPlan } | { ok: false; refusal: LaunchRefusal };

/** Sequence the adapter contract into one plan. Pure with respect to the store and
 *  the filesystem's launch state: it reads (the installed CLI's --help, the canonical
 *  policy, the receipt that owns a resume identifier) but writes nothing and spawns
 *  no interactive session. */
export function planLaunch(adapter: OrchestratorAdapter, ctx: AdapterLaunchContext): LaunchPlanResult {
  const guard = guardPassthrough(adapter, ctx.passthrough);
  if (guard) return { ok: false, refusal: guard };

  const readinessResult = adapter.probeReadiness(ctx);
  if (!readinessResult.ok) return { ok: false, refusal: readinessResult.refusal };
  const readiness = readinessResult.readiness;

  const carrier = adapter.declareInstructionCarrier(ctx, readiness);

  const operationResult = adapter.mapSessionOperation(ctx);
  if (!operationResult.ok) return { ok: false, refusal: operationResult.refusal };
  const operation = operationResult.mapping;

  const argvResult = adapter.buildArgv(ctx, { readiness, carrier, operation });
  if (!argvResult.ok) return { ok: false, refusal: argvResult.refusal };

  return {
    ok: true,
    plan: {
      adapter,
      executable: adapter.executable,
      argv: argvResult.argv,
      env: adapter.buildChildEnv(ctx, readiness),
      cwd: ctx.projectDir,
      carrier,
      identity: operation.identity,
      sessionTarget: operation.sessionTarget,
      readiness,
      advisories: [...readiness.advisories, ...adapter.preflight(ctx)],
      notes: [...ctx.decision.notes, ...operation.notes],
      limitations: [
        ...ctx.decision.limitations.map((l) => ({ capability: l.capability, note: l.note })),
        ...readiness.limitations,
        ...carrier.limitations,
        ...operation.limitations,
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// The launch
// ---------------------------------------------------------------------------

export type OrchestratorLaunchInput = {
  /** How this launch is named in refusals — "forge orchestrator" or "forge claude". */
  commandName: string;
  cliProfile?: string | undefined;
  cliModel?: string | undefined;
  continueSession?: boolean | undefined;
  resumeSessionId?: string | undefined;
  explain?: boolean | undefined;
  passthrough?: readonly string[] | undefined;
  /** D5: the adapter a provider SHORTCUT pins. Evaluated against the resolution
   *  policy actually produced; it never changes which profile is selected. */
  providerPin?: OrchestratorAdapterId | undefined;
  cwd?: string | undefined;
  /** The project display identity carried into the session. Defaults to the
   *  project's own metadata; a shortcut that lets the operator override it
   *  (`forge claude -n <name>`) supplies the resolved value here. */
  projectName?: string | undefined;

  // ---- test seams. Every one of them exists so behavioral tests can use FAKE
  // executables and disposable roots and never start a billed session (AC13). ----
  adapter?: OrchestratorAdapter | undefined;
  authProbe?: ((provider: string, mode: EffectiveAuth) => AuthProbe) | undefined;
  heartbeatsDir?: string | undefined;
  spawnFn?: typeof spawn | undefined;
  stdio?: "inherit" | "ignore" | undefined;
  out?: ((line: string) => void) | undefined;
  err?: ((line: string) => void) | undefined;
  /** Observation hook fired the instant the receipt exists and BEFORE spawn, so a
   *  test can prove the receipt is `pending` — not `running` — at that moment (D15). */
  onBeforeSpawn?: ((state: { receiptId: string; sessionKey: string; plan: LaunchPlan }) => void) | undefined;
};

export type OrchestratorLaunchOutcome = {
  exitCode: number;
  receiptId: string | null;
  sessionKey: string | null;
  refusal: LaunchRefusal | OrchestratorRefusal | null;
  spawned: boolean;
};

/** The canonical Forge session identity for a launch. A resume ADOPTS the identifier
 *  being resumed so the receipt, the liveness record and the provider's own state all
 *  agree on one key; everything else gets a fresh UUID, which the Claude adapter then
 *  ASSERTS via --session-id and the Codex adapter correlates against (step 7). */
export function mintSessionKey(operation: OrchestratorSessionOperation): string {
  if (operation.kind === "resume" && isSafeSessionIdentifier(operation.sessionId)) return operation.sessionId;
  return randomUUID();
}

export async function runOrchestratorLaunch(input: OrchestratorLaunchInput): Promise<OrchestratorLaunchOutcome> {
  const out = input.out ?? ((line: string) => console.log(line));
  const err = input.err ?? ((line: string) => console.error(line));
  const label = input.commandName;

  const refuse = (refusal: LaunchRefusal | OrchestratorRefusal): OrchestratorLaunchOutcome => {
    err(`${label}: ${refusal.message}`);
    return { exitCode: 1, receiptId: null, sessionKey: null, refusal, spawned: false };
  };

  // ---- 0. The requested session operation. ----
  if (input.continueSession && input.resumeSessionId !== undefined) {
    return refuse(
      launchRefusal(
        "conflicting-session-operation",
        `--continue and --resume name two different sessions, so ${label} cannot honor both.`,
        ["pass `--resume <id>` to launch a specific session", "or pass `--continue` to let the provider choose"],
      ),
    );
  }
  const operation: OrchestratorSessionOperation = input.resumeSessionId !== undefined
    ? { kind: "resume", sessionId: input.resumeSessionId }
    : input.continueSession
      ? { kind: "continue" }
      : { kind: "new" };

  // ---- 1. Resolve. No spawn path exists in the resolver (AC5). ----
  const cwd = input.cwd ?? process.cwd();
  const projectDir = resolveOrchestratorProjectRoot(cwd);
  if (projectDir !== pathResolve(cwd)) out(`${label}: chdir to project root: ${projectDir}`);

  const resolution = resolveOrchestratorLaunch({
    cliProfile: input.cliProfile,
    cliModel: input.cliModel,
    providerPin: input.providerPin,
    providerPinSource: input.providerPin ? label : undefined,
    operation,
    projectDir,
    authProbe: input.authProbe,
  });
  if (!resolution.ok) return refuse(resolution.refusal);
  const decision = resolution.decision;

  // ---- 2. --explain: print the recorded decision and spawn NOTHING (AC15). ----
  if (input.explain) {
    for (const { label: field, value } of explainDecision(decision)) {
      out(`${field.padEnd(12)} ${value}`);
    }
    for (const note of decision.notes) out(`note         ${note}`);
    for (const limitation of decision.limitations) {
      out(`limitation   ${limitation.capability}: ${limitation.note}`);
    }
    return { exitCode: 0, receiptId: null, sessionKey: null, refusal: null, spawned: false };
  }

  // ---- 3. Bind the adapter. ----
  const adapter = input.adapter ?? resolveOrchestratorAdapter(decision.adapter);
  if (!adapter) {
    return refuse(
      launchRefusal(
        "adapter-unavailable",
        `the orchestrator resolved to the '${decision.adapter}' adapter` +
          (decision.profile ? ` via profile '${decision.profile}'` : ``) +
          `, and this build of forge ships no implementation for it. Refusing rather than substituting another ` +
          `provider or falling back to an ambient CLI default.`,
        [
          `select a profile whose runtime this build supports: \`${label} --profile <profile>\``,
          `run \`forge orchestrator --explain\` to see the effective choice before launching`,
          `upgrade forge to a build that ships the '${decision.adapter}' adapter`,
        ],
      ),
    );
  }

  const sessionKey = mintSessionKey(operation);
  const receiptId = newOrchestratorReceiptId();
  const projectName =
    input.projectName ?? resolveProjectMeta(projectDir)?.label ?? basename(projectDir);

  const ctx: AdapterLaunchContext = {
    decision,
    projectDir,
    projectName,
    sessionKey,
    receiptId,
    // Filled in below, once the launch has cleared every gate. A refused launch must
    // not leave a `running` orchestrator task row behind describing work that never
    // started — which is the same class of lie the receipt lifecycle exists to prevent.
    runId: null,
    taskId: null,
    operation,
    passthrough: input.passthrough ?? [],
    parentEnv: process.env,
  };

  // ---- 4. Gate. Every refusal below still happens before anything is recorded. ----
  const planned = planLaunch(adapter, ctx);
  if (!planned.ok) return refuse(planned.refusal);
  const plan = planned.plan;

  // The orchestrator run/task the session's usage binds to (#163, AC12). Best-effort
  // instrumentation, deliberately NOT the receipt: a telemetry write that fails must
  // not stop a launch, while a receipt that fails must (D11).
  const instrumentation = openOrchestratorInstrumentation(projectDir, projectName);
  ctx.runId = instrumentation?.runId ?? null;
  ctx.taskId = instrumentation?.taskId ?? null;

  for (const advisory of plan.advisories) out(`${label}: ⚠ ${advisory}`);
  out(statusBanner(decision, adapter.displayName, projectName));
  out("");

  // ---- 5. Record NON-LIVE, before spawn (D15). ----
  try {
    persistPendingOrchestratorReceipt({
      receiptId,
      sessionKey,
      projectDir,
      projectName,
      resolvedProfile: decision.profile ?? null,
      runtime: decision.runtime,
      provider: decision.provider,
      model: decision.modelExplicit ? decision.model : null,
      authMode: decision.auth,
      resolvedBy: `${decision.resolvedBy} (model: ${decision.modelResolvedBy})`,
      adapter: decision.adapter,
      sessionOperation: operation.kind as SessionOperation,
      sessionTarget: plan.sessionTarget,
      // Pre-spawn the identity is only what the adapter can ASSERT. Claude's is real
      // here; a correlated one (Codex) stays unknown until after spawn.
      providerSessionId: plan.identity.strength === "asserted" ? plan.identity.providerSessionId : null,
      identityStrength: plan.identity.strength === "asserted" ? "asserted" : "unknown",
      identityBasis: plan.identity.basis,
      carrier: {
        generation: plan.carrier.generation,
        path: plan.carrier.path,
        acceptance: plan.carrier.acceptance,
        evidence: plan.carrier.evidence,
      },
      limitations: plan.limitations,
      taskId: instrumentation?.taskId ?? null,
      launcherPid: process.pid,
    });
  } catch (e) {
    if (instrumentation) closeInstrumentation(instrumentation.runId);
    if (e instanceof OrchestratorReceiptWriteError) {
      // The store's message already names the write target and the retry remedy, and
      // already states that nothing was spawned. Printing it verbatim keeps ONE
      // wording for a failure the operator has to act on.
      err(`${label}: ${e.message}`);
      return {
        exitCode: 1,
        receiptId: null,
        sessionKey: null,
        refusal: launchRefusal("receipt-unwritable", e.message, [
          "check that the forge store is present and writable, then retry the same command",
        ]),
        spawned: false,
      };
    }
    throw e;
  }

  // ---- 6. Prove the liveness namespace is writable BEFORE spawn. ----
  // A namespace that refuses now would otherwise refuse AFTER spawn, when refusing is
  // no longer an option. refreshLauncherHeartbeat is the probe rather than a hand-rolled
  // mkdir because it resolves the namespace through the module that OWNS it — a second
  // derivation of that path could drift out of D12's single directory.
  //
  // It creates NO record: with no existing file it returns false having only ensured the
  // directory, so nothing here can produce a liveness claim before a spawn is confirmed.
  // Resuming a session whose record still exists refreshes only `refreshedAt`, which this
  // module documents as bookkeeping and never reads as liveness — the process fence is
  // untouched, so an orphaned record stays orphaned until the new spawn rewrites it.
  try {
    refreshLauncherHeartbeat(sessionKey, { heartbeatsDir: input.heartbeatsDir });
  } catch (e) {
    const message = e instanceof HeartbeatWriteError ? e.message : String(e);
    closeReceiptQuietly(receiptId, { state: "spawn_failed", reason: `liveness namespace unwritable: ${message}` }, err, label);
    if (instrumentation) closeInstrumentation(instrumentation.runId);
    return refuse(
      launchRefusal(
        "liveness-unwritable",
        `the orchestrator liveness record could not be prepared: ${message}. Forge does not start an interactive ` +
          `session whose liveness it cannot record, because a live session with no record is indistinguishable ` +
          `from no session at all. Nothing was spawned.`,
        ["fix the reported directory, then retry the same command", "or set FORGE_ORCHESTRATORS_DIR to a writable location"],
      ),
    );
  }

  // ---- 7. Materialize the Forge-owned instruction carrier. ----
  if (plan.carrier.path && plan.carrier.content !== null) {
    try {
      writeCarrierAtomically(plan.carrier.path, plan.carrier.content);
    } catch (e) {
      closeReceiptQuietly(receiptId, { state: "spawn_failed", reason: `carrier unwritable: ${(e as Error).message}` }, err, label);
      if (instrumentation) closeInstrumentation(instrumentation.runId);
      return refuse(
        launchRefusal(
          "carrier-unwritable",
          `the Forge-owned orchestrator instruction file could not be written to ${plan.carrier.path}: ` +
            `${(e as Error).message}. Nothing was spawned — a session that silently ran without the Forge-owned ` +
            `policy would be registered as an initialized Forge orchestrator without being one.`,
          [`check that ${dirname(plan.carrier.path)} is writable, then retry the same command`],
        ),
      );
    }
  }

  input.onBeforeSpawn?.({ receiptId, sessionKey, plan });

  // ---- 8. Spawn, and wait for a CONFIRMED spawn. ----
  const spawnImpl = input.spawnFn ?? spawn;
  const child: ChildProcess = spawnImpl(plan.executable, plan.argv, {
    cwd: plan.cwd,
    stdio: input.stdio ?? "inherit",
    env: plan.env,
  });

  return await new Promise<OrchestratorLaunchOutcome>((resolveOutcome) => {
    let confirmed = false;
    let settled = false;

    const cleanupCarrier = (): void => {
      if (plan.carrier.path) {
        try {
          unlinkSync(plan.carrier.path);
        } catch {
          /* already gone */
        }
      }
    };

    child.on("spawn", () => {
      confirmed = true;
      // ---- 9. GO LIVE. Receipt first, then the liveness record — in that order,
      // only now, and only because a spawn was confirmed (D15, AC6).
      try {
        markOrchestratorReceiptRunning(receiptId, {
          launcherPid: process.pid,
          launcherIdentity: JSON.stringify(captureProcessIdentity()),
        });
      } catch (e) {
        err(`${label}: ⚠ ${(e as Error).message}`);
      }

      try {
        writeLauncherHeartbeat(
          {
            sessionId: sessionKey,
            projectDir,
            provider: decision.provider,
            runtime: decision.runtime,
            adapter: decision.adapter,
            receiptId,
          },
          { heartbeatsDir: input.heartbeatsDir },
        );
      } catch (e) {
        // The child is already running, so refusing is no longer available. Say so
        // loudly: without this record every liveness-joined surface will classify the
        // session as not running, which is fail-closed and honest but surprising.
        err(
          `${label}: ⚠ the orchestrator liveness record could not be written (${(e as Error).message}). ` +
            `The session is running, but \`forge show\` and the dashboard will not report it as live.`,
        );
      }

      const observed = adapter.onSpawnConfirmed(ctx, { pid: child.pid });
      for (const advisory of observed.advisories ?? []) err(`${label}: ⚠ ${advisory}`);
      if (observed.identity) {
        try {
          recordOrchestratorSessionIdentity(receiptId, {
            providerSessionId: observed.identity.providerSessionId,
            strength: observed.identity.strength,
            basis: observed.identity.basis,
          });
        } catch (e) {
          err(`${label}: ⚠ ${(e as Error).message}`);
        }
      }
    });

    child.on("error", (e: Error) => {
      if (settled) return;
      settled = true;
      // No `spawn` event fired, so nothing ever ran: the receipt closes as
      // spawn_failed and never passed through `running` at all.
      cleanupCarrier();
      closeReceiptQuietly(receiptId, { state: "spawn_failed", reason: e.message }, err, label);
      if (instrumentation) closeInstrumentation(instrumentation.runId);
      adapter.closeOut(ctx, { state: "spawn_failed", exitCode: null, signal: null, reason: e.message });
      err(`${label}: failed to spawn ${plan.executable} — ${e.message}`);
      err(`  Is the \`${plan.executable}\` binary in your PATH?`);
      resolveOutcome({ exitCode: 1, receiptId, sessionKey, refusal: null, spawned: false });
    });

    child.on("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      cleanupCarrier();
      closeLauncherHeartbeat(sessionKey, { heartbeatsDir: input.heartbeatsDir });
      if (confirmed) {
        // The child ran and stopped. `exited` is the honest terminal fact whether it
        // returned 0, returned non-zero, or was killed by a signal — the code and the
        // signal say which, and neither is reinterpreted as the other.
        closeReceiptQuietly(receiptId, { state: "exited", exitCode: code, signal: signal ?? null }, err, label);
      } else {
        closeReceiptQuietly(
          receiptId,
          { state: "spawn_failed", reason: `child exited (code=${code}, signal=${signal}) without a confirmed spawn` },
          err,
          label,
        );
      }
      if (instrumentation) closeInstrumentation(instrumentation.runId);
      adapter.closeOut(ctx, {
        state: confirmed ? "exited" : "spawn_failed",
        exitCode: code,
        signal: signal ?? null,
        reason: null,
      });
      resolveOutcome({
        exitCode: signal ? 128 : (code ?? 0),
        receiptId,
        sessionKey,
        refusal: null,
        spawned: confirmed,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Close-out must never throw on the exit path: a telemetry failure changing the exit
 *  code the operator sees would be worse than the failure itself. It is REPORTED,
 *  never swallowed silently — that is the difference D11 draws. */
function closeReceiptQuietly(
  receiptId: string,
  outcome: { state: "exited" | "spawn_failed" | "orphaned"; exitCode?: number | null; signal?: string | null; reason?: string | null },
  err: (line: string) => void,
  label: string,
): void {
  try {
    closeOrchestratorReceipt(receiptId, outcome);
  } catch (e) {
    err(`${label}: ⚠ could not close orchestrator receipt ${receiptId}: ${(e as Error).message}`);
  }
}

function writeCarrierAtomically(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, content, "utf8");
    renameSync(tmp, path);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* nothing to remove */
    }
    throw e;
  }
}

type Instrumentation = { runId: string; taskId: string };

/** #163's orchestrator run/task, so post-session usage rows land under the right
 *  project. Best-effort by design and separate from the receipt: this is telemetry
 *  ABOUT the work, while the receipt is a PRECONDITION of it. */
function openOrchestratorInstrumentation(projectDir: string, projectName: string): Instrumentation | null {
  const runId = newRunId("orchestrator");
  const taskId = newTaskId("session");
  const startedAt = nowIso();
  try {
    insertRun({
      id: runId,
      workflow: "orchestrator",
      title: `${projectName} orchestrator`,
      status: "active",
      createdAt: startedAt,
      projectDir,
    });
    insertTask({
      id: taskId,
      runId,
      phase: "session",
      agentRole: "orchestrator",
      status: "running",
      taskPackage: {
        taskId,
        runId,
        phase: "session",
        role: "orchestrator",
        inputs: { projectDir },
        composedSystemPrompt: "",
      },
      createdAt: startedAt,
      startedAt,
    });
    return { runId, taskId };
  } catch {
    return null;
  }
}

/** The run is closed here; the TASK is left `running` on purpose — step 8 completes it
 *  when it binds the session's usage rows to the receipt. */
function closeInstrumentation(runId: string): void {
  try {
    updateRunStatus(runId, "complete");
  } catch {
    /* telemetry only */
  }
}

/** One banner for both commands, built from the RECORDED decision — so what the
 *  operator reads at launch is the same thing `forge show` reads back (AC11). */
export function statusBanner(decision: OrchestratorDecision, adapterName: string, projectName: string): string {
  return [
    `Launching as '${projectName}' orchestrator via ${adapterName}`,
    `profile: ${decision.profile ?? "(none)"}`,
    `model: ${decision.modelExplicit ? decision.model : "(provider default)"}`,
    `auth: ${decision.provider}/${decision.auth}`,
  ].join(" · ");
}
