// FG-576 (D7/D11/D15): the LAUNCHER-OWNED orchestrator launch receipt.
//
// WHAT A ROW IS. The durable record of the ENTIRE decision an interactive
// orchestrator session was launched under — resolved profile, runtime, provider,
// concrete model, effective auth, resolution source, adapter, project, requested
// session operation, provider session identity and how strongly it is known,
// instruction-carrier provenance, and the capability limitations the selected
// provider carries. It is written BEFORE spawn (AC6) and it is what `forge show`
// and the dashboard read to explain, while a session is running, what was selected
// and why (AC11).
//
// WHAT A ROW IS NOT. It is NOT a liveness claim. `state = 'running'` records that a
// spawn was CONFIRMED at the moment the launcher wrote it; whether anything is alive
// NOW is answered by joining the launcher-owned liveness record, never by reading
// this column (AC7, D15). `claimsRunning` is named the way it is so a caller cannot
// reach for it believing it means "live".
//
// THE READ IS FENCED (D14/D15/D17). A launcher that is SIGKILLed runs no exit handler,
// so nothing can close its `running` row from the launch side — by construction, since
// the code that would do it died with the process. A row nothing can falsify is the
// phantom orchestrator this ticket exists to close, so the RESOLUTION IS ON THE READ
// PATH: a receipt recorded `running` whose launcher fence
// (src/util/process-identity.ts — the one mechanism, consumed here, not re-invented)
// classifies `dead` is reported `orphaned`. Per D17 that asserts LAUNCHER LOSS ONLY;
// the child's disposition stays unasserted, no exit code or signal is invented for it,
// and nothing here kills, replaces or resumes anything. A fence that cannot be judged
// (`unknown` — no recorded identity, another host, an OS that supplied no start token)
// resolves NOTHING: it is not evidence of loss any more than it is evidence of life,
// and the operator surfaces render it as unverified rather than as running.
//
// The read never REWRITES the row. `recordedState` carries the stored bytes verbatim
// alongside the resolved `state`, so "orphaned (receipt records: running)" is what an
// operator reads — and so a dashboard holding a read-only handle can answer honestly
// without a write it is not allowed to make.
//
// THREE PROPERTIES THIS MODULE OWNS, all of them refusals rather than conveniences:
//
//   D11 — WRITE FAILURE IS NEVER SWALLOWED. Every accessor that writes raises
//   OrchestratorReceiptWriteError naming the store it could not write and a retry
//   remedy. The launcher turns that into its pre-spawn refusal: an orchestrator
//   forge could not record is not launched at all. This is deliberately the opposite
//   of recordLaunchStart's best-effort instrumentation (src/store/launch-observations.ts),
//   where the work is the thing and the record is only about the work. Here the
//   record is a precondition of the work.
//
//   D15 — THE LIFECYCLE IS EXPLICIT, and only four edges exist:
//       pending -> running | spawn_failed
//       running -> exited  | orphaned
//   Everything else — including a no-op re-entry and any move out of a terminal
//   state — is REFUSED by name (OrchestratorReceiptTransitionError) rather than
//   silently applied. Transitions are compare-and-set inside the write lock, so two
//   processes racing the same receipt cannot both win.
//
//   D17 — `orphaned` asserts LAUNCHER LOSS ONLY. It says nothing about the child's
//   disposition and must never be rendered as "session exited" or "child stopped".
//
// DECODING IS FAIL-CLOSED WHERE TRUST IS AT STAKE, AND VERBATIM WHERE PROVENANCE IS.
// A trust-bearing value this binary does not recognize decodes DOWN — an unknown
// identity strength is `unknown` and an unknown carrier acceptance is `unproven`, so
// a row written by a newer binary can never read as an asserted session identity or
// as an instruction carrier something proved was accepted (AC8/AC9). Provider,
// runtime and adapter decode VERBATIM and have no default at all: a Codex receipt
// read by a reader that knows only the generic columns reports provider='openai',
// because there is no fallback value for it to become.

import { randomBytes } from "node:crypto";
import { getDb, writeTransaction } from "./db.js";
import { resolveDbPath } from "../util/paths.js";
import { projectIdentity } from "../v2/project-identity.js";
import {
  classifyProcessIdentity,
  coerceProcessIdentity,
  type ProcessIdentity,
  type ProcessLiveness,
} from "../util/process-identity.js";

// ─── vocabularies ───────────────────────────────────────────────────────────

/** The five lifecycle states (D15). Enum-as-convention (FG-585): TEXT with no DB
 *  CHECK, so an old/new binary never fights a constraint the other lacks. */
export const ORCHESTRATOR_RECEIPT_STATES = [
  "pending",
  "running",
  "exited",
  "spawn_failed",
  "orphaned",
] as const;
export type OrchestratorReceiptState = (typeof ORCHESTRATOR_RECEIPT_STATES)[number];

/** The ONLY legal edges. A state with an empty list is terminal. */
export const LEGAL_RECEIPT_TRANSITIONS: Record<OrchestratorReceiptState, readonly OrchestratorReceiptState[]> = {
  pending: ["running", "spawn_failed"],
  running: ["exited", "orphaned"],
  exited: [],
  spawn_failed: [],
  orphaned: [],
};

export const TERMINAL_RECEIPT_STATES = ORCHESTRATOR_RECEIPT_STATES.filter(
  (s) => LEGAL_RECEIPT_TRANSITIONS[s].length === 0,
) as ReadonlyArray<OrchestratorReceiptState>;

/** The states `closeOrchestratorReceipt` may write — every terminal one. */
export type TerminalReceiptState = "exited" | "spawn_failed" | "orphaned";

export function isKnownReceiptState(state: string): state is OrchestratorReceiptState {
  return (ORCHESTRATOR_RECEIPT_STATES as readonly string[]).includes(state);
}

export function isTerminalReceiptState(state: OrchestratorReceiptState): boolean {
  return LEGAL_RECEIPT_TRANSITIONS[state].length === 0;
}

export function isLegalReceiptTransition(from: OrchestratorReceiptState, to: OrchestratorReceiptState): boolean {
  return LEGAL_RECEIPT_TRANSITIONS[from].includes(to);
}

/** The requested session operation (D9). `resume`/`continue` carry a target
 *  identifier; `new` does not. */
export const SESSION_OPERATIONS = ["new", "continue", "resume"] as const;
export type SessionOperation = (typeof SESSION_OPERATIONS)[number];

/** How strongly the PROVIDER's session identity is known (AC9's honest parity gap).
 *  'asserted'   — Forge minted it and passed it to the provider (Claude --session-id).
 *  'correlated' — matched after spawn from recorded evidence (Codex).
 *  'ambiguous'  — more than one candidate matched; a guess was REFUSED.
 *  'unknown'    — nothing established it. The fail-closed default. */
export const SESSION_IDENTITY_STRENGTHS = ["asserted", "correlated", "ambiguous", "unknown"] as const;
export type SessionIdentityStrength = (typeof SESSION_IDENTITY_STRENGTHS)[number];

/** Whether the provider gave POSITIVE EVIDENCE it accepted the Forge-owned
 *  instruction carrier (AC8). Constructing the flag is NOT evidence, so 'unproven'
 *  is the default and 'accepted' is only ever written deliberately.
 *  'not_applicable' is for an adapter whose instruction surface is not a carrier at
 *  all — never a synonym for "we did not check". */
export const CARRIER_ACCEPTANCES = ["accepted", "unproven", "not_applicable"] as const;
export type CarrierAcceptance = (typeof CARRIER_ACCEPTANCES)[number];

/** A capability the selected provider does NOT supply, recorded rather than papered
 *  over (AC9/AC12). `note` is what is missing, in the operator's terms. */
export type CapabilityLimitation = { capability: string; note: string };

// ─── refusals ───────────────────────────────────────────────────────────────

/** D11's input. The launcher turns this into its pre-spawn refusal, so the message
 *  must be ACTIONABLE (it names the store that could not be written) and RETRYABLE
 *  (it names what to do and says nothing was spawned). Never swallowed, never
 *  degraded into an unrecorded live session. */
export class OrchestratorReceiptWriteError extends Error {
  constructor(
    message: string,
    readonly receiptId: string,
    readonly dbPath: string,
    cause: unknown,
  ) {
    // The underlying store error rides on the standard `cause` — preserved, never
    // discarded, and reachable by any generic error reporter.
    super(message, { cause });
    this.name = "OrchestratorReceiptWriteError";
  }
}

/** A lifecycle move that is not one of the four legal edges — including a move out
 *  of a terminal state, a no-op re-entry, a receipt that does not exist, and a
 *  compare-and-set that lost a race. Deliberately NOT an OrchestratorReceiptWriteError:
 *  the store is fine, the caller's sequencing is not, and D11's retry remedy would be
 *  wrong advice here. */
export class OrchestratorReceiptTransitionError extends Error {
  constructor(
    message: string,
    readonly receiptId: string,
    readonly from: string | null,
    readonly to: OrchestratorReceiptState,
  ) {
    super(message);
    this.name = "OrchestratorReceiptTransitionError";
  }
}

// ─── the row and the decoded receipt ────────────────────────────────────────

export type OrchestratorReceiptRow = {
  receipt_id: string;
  session_key: string;
  state: string;
  created_at: string;
  updated_at: string;
  project_dir: string;
  project_name: string | null;
  resolved_profile: string | null;
  runtime: string;
  provider: string;
  model: string | null;
  auth_mode: string | null;
  resolved_by: string | null;
  adapter: string;
  session_operation: string;
  session_target: string | null;
  provider_session_id: string | null;
  identity_strength: string;
  identity_basis: string | null;
  carrier_generation: string | null;
  carrier_path: string | null;
  carrier_acceptance: string;
  carrier_evidence: string | null;
  limitations: string | null;
  task_id: string | null;
  launcher_pid: number | null;
  launcher_identity: string | null;
  started_at: string | null;
  closed_at: string | null;
  exit_code: number | null;
  exit_signal: string | null;
  failure_reason: string | null;
};

/** Instruction-carrier provenance (AC8): which generation supplied it, where the
 *  launch bound it from, and whether the provider proved it accepted it. */
export type CarrierProvenance = {
  generation: string | null;
  path: string | null;
  acceptance: CarrierAcceptance;
  evidence: string | null;
};

export type OrchestratorReceipt = {
  receiptId: string;
  /** The ONE canonical session identity shared with the launcher-owned liveness
   *  record (D12), so a receipt and its liveness file are joinable and one session
   *  counts once. Distinct from `providerSessionId`, which is the provider's own. */
  sessionKey: string;
  /** The HONEST state: as recorded, resolved to `orphaned` when the row records
   *  `running` and the owning launcher's process identity is provably gone (D15/D17).
   *  A value outside the five is carried verbatim and `stateRecognized` is false — a
   *  state this binary does not understand is never reinterpreted as one it does. */
  state: OrchestratorReceiptState | (string & {});
  /** The stored bytes, unresolved. Provenance, so a surface can say what the receipt
   *  itself records next to what the fence says about it. */
  recordedState: OrchestratorReceiptState | (string & {});
  stateRecognized: boolean;
  /** The receipt CLAIMS a confirmed spawn. NEVER proof of present liveness, and NOT
   *  falsified by launcher loss either — it stays true of a receipt resolved to
   *  `orphaned`, because a spawn WAS confirmed under it. Surfaces report running only
   *  after joining the process fence (AC7). */
  claimsRunning: boolean;
  /** What the recorded launcher fence establishes about the launcher NOW. `unknown`
   *  for any receipt that does not claim a confirmed spawn — there is no launcher to
   *  ask about — and never upgraded to `alive` by anything else on the row. */
  launcherLiveness: ProcessLiveness;
  terminal: boolean;
  createdAt: string;
  updatedAt: string;
  projectDir: string;
  projectName: string | null;
  resolvedProfile: string | null;
  runtime: string;
  provider: string;
  model: string | null;
  authMode: string | null;
  resolvedBy: string | null;
  adapter: string;
  /** Verbatim: an operation outside the three is provenance, not a trust decision,
   *  so it is reported as recorded rather than downgraded. */
  sessionOperation: SessionOperation | (string & {});
  sessionTarget: string | null;
  providerSessionId: string | null;
  identityStrength: SessionIdentityStrength;
  identityBasis: string | null;
  carrier: CarrierProvenance;
  limitations: CapabilityLimitation[];
  taskId: string | null;
  launcherPid: number | null;
  launcherIdentity: string | null;
  startedAt: string | null;
  closedAt: string | null;
  exitCode: number | null;
  exitSignal: string | null;
  failureReason: string | null;
};

export const ORCHESTRATOR_RECEIPT_COLUMNS =
  "receipt_id, session_key, state, created_at, updated_at, project_dir, project_name, resolved_profile, " +
  "runtime, provider, model, auth_mode, resolved_by, adapter, session_operation, session_target, " +
  "provider_session_id, identity_strength, identity_basis, carrier_generation, carrier_path, " +
  "carrier_acceptance, carrier_evidence, limitations, task_id, launcher_pid, launcher_identity, " +
  "started_at, closed_at, exit_code, exit_signal, failure_reason";

/** Trust-bearing decode: DOWN to the weakest value, never up. */
function decodeIdentityStrength(raw: string): SessionIdentityStrength {
  return (SESSION_IDENTITY_STRENGTHS as readonly string[]).includes(raw)
    ? (raw as SessionIdentityStrength)
    : "unknown";
}

/** Trust-bearing decode (AC8): an acceptance this binary cannot interpret is
 *  'unproven'. Nothing may promote a carrier to accepted except a writer that had
 *  positive evidence. */
function decodeCarrierAcceptance(raw: string): CarrierAcceptance {
  return (CARRIER_ACCEPTANCES as readonly string[]).includes(raw) ? (raw as CarrierAcceptance) : "unproven";
}

/** A malformed limitations blob reports NO limitations rather than a guessed one —
 *  and a caller that renders "no recorded limitation" is saying something true about
 *  the record. Nothing here ever invents a usage number (AC12). */
function decodeLimitations(raw: string | null): CapabilityLimitation[] {
  if (raw === null || raw === "") return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      if (entry === null || typeof entry !== "object") return [];
      const { capability, note } = entry as Record<string, unknown>;
      if (typeof capability !== "string" || typeof note !== "string") return [];
      return [{ capability, note }];
    });
  } catch {
    return [];
  }
}

/** The launcher fence the launcher wrote at `running`, read back. It is stored as
 *  opaque JSON there and interpreted only here. */
function decodeLauncherIdentity(raw: string | null): ProcessIdentity | undefined {
  if (raw === null || raw === "") return undefined;
  try {
    return coerceProcessIdentity(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

export function rowToOrchestratorReceipt(row: OrchestratorReceiptRow): OrchestratorReceipt {
  // Exact match on the recorded bytes: an unrecognized state is not running.
  const claimsRunning = row.state === "running";
  const launcherLiveness: ProcessLiveness = claimsRunning
    ? classifyProcessIdentity(decodeLauncherIdentity(row.launcher_identity))
    : "unknown";
  // D17: launcher loss, and only launcher loss. `dead` is the sole answer that
  // resolves anything — `unknown` leaves the recorded state exactly as it stands.
  const state = claimsRunning && launcherLiveness === "dead" ? "orphaned" : row.state;
  const recognized = isKnownReceiptState(state);
  return {
    receiptId: row.receipt_id,
    sessionKey: row.session_key,
    state,
    recordedState: row.state,
    stateRecognized: recognized,
    claimsRunning,
    launcherLiveness,
    terminal: recognized && isTerminalReceiptState(state as OrchestratorReceiptState),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    projectDir: row.project_dir,
    projectName: row.project_name,
    resolvedProfile: row.resolved_profile,
    // No default and no fallback — see the module header.
    runtime: row.runtime,
    provider: row.provider,
    model: row.model,
    authMode: row.auth_mode,
    resolvedBy: row.resolved_by,
    adapter: row.adapter,
    sessionOperation: row.session_operation,
    sessionTarget: row.session_target,
    providerSessionId: row.provider_session_id,
    identityStrength: decodeIdentityStrength(row.identity_strength),
    identityBasis: row.identity_basis,
    carrier: {
      generation: row.carrier_generation,
      path: row.carrier_path,
      acceptance: decodeCarrierAcceptance(row.carrier_acceptance),
      evidence: row.carrier_evidence,
    },
    limitations: decodeLimitations(row.limitations),
    taskId: row.task_id,
    launcherPid: row.launcher_pid,
    launcherIdentity: row.launcher_identity,
    startedAt: row.started_at,
    closedAt: row.closed_at,
    exitCode: row.exit_code,
    exitSignal: row.exit_signal,
    failureReason: row.failure_reason,
  };
}

// ─── writes ─────────────────────────────────────────────────────────────────

export function newOrchestratorReceiptId(): string {
  return `orx-${randomBytes(3).toString("hex")}${randomBytes(3).toString("hex")}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Wrap ANY store-level failure as D11's actionable, retryable refusal. A refusal
 *  this module already made deliberately (an illegal transition) passes through
 *  untouched — it is not a store problem and must not carry a store remedy.
 *
 *  `consequence` states what is true NOW as a result, because that differs by write:
 *  a failed PRE-SPAWN write means nothing was started, while a failed transition
 *  means a session that IS running has a record that no longer describes it. Saying
 *  "nothing was spawned" on the second one would be a lie. */
function withReceiptWrite<T>(receiptId: string, what: string, consequence: string, fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof OrchestratorReceiptTransitionError) throw e;
    let dbPath: string;
    try {
      dbPath = resolveDbPath();
    } catch {
      dbPath = "<unresolvable forge store path>";
    }
    throw new OrchestratorReceiptWriteError(
      `forge: could not ${what} for orchestrator receipt ${receiptId} in the forge store at ${dbPath}. ` +
        `${consequence} Check that ${dbPath} exists and is writable and that no other forge process is ` +
        `holding it, then retry. Underlying: ${(e as Error).message}`,
      receiptId,
      dbPath,
      e,
    );
  }
}

const PRE_SPAWN_CONSEQUENCE =
  "Forge does not launch an interactive orchestrator it cannot record, so nothing was spawned and no " +
  "session was started; retrying the same command is safe.";

/** The pre-spawn decision, in full. Every field is what the launcher RESOLVED —
 *  nothing here is inferred from a process name, an argv, or a provider's own state. */
export type OrchestratorLaunchDecision = {
  /** Optional so the launcher can mint the id early and use it as a correlation
   *  handle; defaults to a fresh one. */
  receiptId?: string;
  sessionKey: string;
  projectDir: string;
  projectName?: string | null;
  resolvedProfile?: string | null;
  runtime: string;
  provider: string;
  model?: string | null;
  authMode?: string | null;
  resolvedBy?: string | null;
  adapter: string;
  sessionOperation: SessionOperation;
  sessionTarget?: string | null;
  providerSessionId?: string | null;
  identityStrength?: SessionIdentityStrength;
  identityBasis?: string | null;
  carrier?: {
    generation?: string | null;
    path?: string | null;
    acceptance?: CarrierAcceptance;
    evidence?: string | null;
  };
  limitations?: readonly CapabilityLimitation[];
  taskId?: string | null;
  launcherPid?: number | null;
  launcherIdentity?: string | null;
  createdAt?: string;
};

/** D15's first step: persist the receipt NON-LIVE, before spawn.
 *
 *  A `pending` row is not a session and is never rendered as one. It is the durable
 *  proof that the decision below was made before anything was started — and, when it
 *  cannot be written, the reason nothing is started at all (D11). */
export function persistPendingOrchestratorReceipt(decision: OrchestratorLaunchDecision): OrchestratorReceipt {
  const receiptId = decision.receiptId ?? newOrchestratorReceiptId();
  const at = decision.createdAt ?? nowIso();
  return withReceiptWrite(receiptId, "write the pre-spawn launch record", PRE_SPAWN_CONSEQUENCE, () =>
    writeTransaction(() => {
      getDb()
        .prepare(
          `INSERT INTO orchestrator_receipts (${ORCHESTRATOR_RECEIPT_COLUMNS})
           VALUES (@receipt_id, @session_key, @state, @created_at, @updated_at, @project_dir, @project_name,
                   @resolved_profile, @runtime, @provider, @model, @auth_mode, @resolved_by, @adapter,
                   @session_operation, @session_target, @provider_session_id, @identity_strength,
                   @identity_basis, @carrier_generation, @carrier_path, @carrier_acceptance,
                   @carrier_evidence, @limitations, @task_id, @launcher_pid, @launcher_identity,
                   @started_at, @closed_at, @exit_code, @exit_signal, @failure_reason)`,
        )
        .run({
          receipt_id: receiptId,
          session_key: decision.sessionKey,
          state: "pending",
          created_at: at,
          updated_at: at,
          project_dir: decision.projectDir,
          project_name: decision.projectName ?? null,
          resolved_profile: decision.resolvedProfile ?? null,
          runtime: decision.runtime,
          provider: decision.provider,
          model: decision.model ?? null,
          auth_mode: decision.authMode ?? null,
          resolved_by: decision.resolvedBy ?? null,
          adapter: decision.adapter,
          session_operation: decision.sessionOperation,
          session_target: decision.sessionTarget ?? null,
          provider_session_id: decision.providerSessionId ?? null,
          identity_strength: decision.identityStrength ?? "unknown",
          identity_basis: decision.identityBasis ?? null,
          carrier_generation: decision.carrier?.generation ?? null,
          carrier_path: decision.carrier?.path ?? null,
          carrier_acceptance: decision.carrier?.acceptance ?? "unproven",
          carrier_evidence: decision.carrier?.evidence ?? null,
          limitations: JSON.stringify(decision.limitations ?? []),
          task_id: decision.taskId ?? null,
          launcher_pid: decision.launcherPid ?? null,
          launcher_identity: decision.launcherIdentity ?? null,
          started_at: null,
          closed_at: null,
          exit_code: null,
          exit_signal: null,
          failure_reason: null,
        });
      return requireReceipt(receiptId);
    }),
  );
}

/** The columns a transition may also set, alongside `state`/`updated_at`. */
type TransitionPatch = Partial<
  Pick<
    OrchestratorReceiptRow,
    | "provider_session_id"
    | "identity_strength"
    | "identity_basis"
    | "launcher_pid"
    | "launcher_identity"
    | "started_at"
    | "closed_at"
    | "exit_code"
    | "exit_signal"
    | "failure_reason"
  >
>;

/** COMPARE-AND-SET on the state column, inside the write lock.
 *
 *  Legality is checked against what is ACTUALLY STORED, then the UPDATE names that
 *  same state in its WHERE clause. A concurrent writer that moved the receipt in
 *  between loses the race and is REFUSED rather than overwriting a state it never
 *  read — which is how a receipt closed as `exited` would get resurrected as
 *  `running` with nothing behind it. */
function transition(receiptId: string, to: OrchestratorReceiptState, patch: TransitionPatch, at: string): OrchestratorReceipt {
  const consequence =
    to === "running"
      ? `The child was already spawned, so a session is running under a receipt still recorded as pending.`
      : `The session's durable record still reads as open and does not yet say it reached ${to}.`;
  return withReceiptWrite(receiptId, `record the ${to} transition`, consequence, () =>
    writeTransaction(() => {
      const current = readRow(receiptId);
      if (!current) {
        throw new OrchestratorReceiptTransitionError(
          `forge: no orchestrator receipt ${receiptId} exists, so it cannot be moved to ${to}.`,
          receiptId,
          null,
          to,
        );
      }
      if (!isKnownReceiptState(current.state)) {
        throw new OrchestratorReceiptTransitionError(
          `forge: orchestrator receipt ${receiptId} is in state '${current.state}', which this forge does not ` +
            `understand (a newer forge recorded it). Refusing to move it to ${to} rather than reinterpret it.`,
          receiptId,
          current.state,
          to,
        );
      }
      if (!isLegalReceiptTransition(current.state, to)) {
        const legal = LEGAL_RECEIPT_TRANSITIONS[current.state];
        throw new OrchestratorReceiptTransitionError(
          `forge: illegal orchestrator receipt transition ${current.state} -> ${to} for ${receiptId}. ` +
            (legal.length === 0
              ? `${current.state} is terminal; nothing follows it.`
              : `Legal from ${current.state}: ${legal.join(", ")}.`),
          receiptId,
          current.state,
          to,
        );
      }

      // The SET list and the bind object are built TOGETHER: better-sqlite3 rejects a
      // named parameter the statement does not use, so a key filtered out of one must
      // be filtered out of the other.
      const sets = ["state = @state", "updated_at = @updated_at"];
      const bind: Record<string, unknown> = {
        receipt_id: receiptId,
        state: to,
        updated_at: at,
        expected_state: current.state,
      };
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) continue;
        sets.push(`${key} = @${key}`);
        bind[key] = value;
      }
      const res = getDb()
        .prepare(
          `UPDATE orchestrator_receipts SET ${sets.join(", ")}
            WHERE receipt_id = @receipt_id AND state = @expected_state`,
        )
        .run(bind);
      if (res.changes !== 1) {
        throw new OrchestratorReceiptTransitionError(
          `forge: orchestrator receipt ${receiptId} moved out of ${current.state} while the ${to} transition ` +
            `was being recorded; the transition was refused rather than applied over another writer's state.`,
          receiptId,
          current.state,
          to,
        );
      }
      return requireReceipt(receiptId);
    }),
  );
}

/** What a CONFIRMED spawn produced. `startedAt` is when the child was confirmed
 *  running — never when the command was typed. */
export type SpawnConfirmation = {
  startedAt?: string;
  launcherPid?: number;
  /** The process-start identity token that fences a recycled pid (D14). Captured by
   *  the launcher; this module stores it and never interprets it. */
  launcherIdentity?: string;
  providerSessionId?: string;
  identityStrength?: SessionIdentityStrength;
  identityBasis?: string;
};

/** D15's second step: `pending` -> `running`, ONLY after a confirmed spawn.
 *
 *  Nothing in this module can reach `running` any other way, so a receipt in that
 *  state always had a child behind it at the moment it was written. Whether one is
 *  there NOW is the liveness record's question, not this column's. */
export function markOrchestratorReceiptRunning(
  receiptId: string,
  spawn: SpawnConfirmation = {},
): OrchestratorReceipt {
  const at = spawn.startedAt ?? nowIso();
  return transition(
    receiptId,
    "running",
    {
      started_at: at,
      ...(spawn.launcherPid !== undefined ? { launcher_pid: spawn.launcherPid } : {}),
      ...(spawn.launcherIdentity !== undefined ? { launcher_identity: spawn.launcherIdentity } : {}),
      ...(spawn.providerSessionId !== undefined ? { provider_session_id: spawn.providerSessionId } : {}),
      ...(spawn.identityStrength !== undefined ? { identity_strength: spawn.identityStrength } : {}),
      ...(spawn.identityBasis !== undefined ? { identity_basis: spawn.identityBasis } : {}),
    },
    at,
  );
}

/** How a receipt ended. `state` is the honest terminal fact, not a severity:
 *   'exited'       the child exited — exitCode/signal say how.
 *   'spawn_failed' the child never started — reason says why.
 *   'orphaned'     the LAUNCHER was lost (D17). The child's disposition is NOT
 *                  asserted, so exitCode/signal must be left unset here. */
export type ReceiptCloseOutcome = {
  state: TerminalReceiptState;
  exitCode?: number | null;
  signal?: string | null;
  reason?: string | null;
  closedAt?: string;
};

export function closeOrchestratorReceipt(receiptId: string, outcome: ReceiptCloseOutcome): OrchestratorReceipt {
  const at = outcome.closedAt ?? nowIso();
  return transition(
    receiptId,
    outcome.state,
    {
      closed_at: at,
      exit_code: outcome.exitCode ?? null,
      exit_signal: outcome.signal ?? null,
      failure_reason: outcome.reason ?? null,
    },
    at,
  );
}

/** Record the provider's OWN session identity once it is known, without touching the
 *  lifecycle. This is the Codex path: identity is CORRELATED after spawn, and two
 *  overlapping sessions in one project resolve to 'ambiguous' rather than a guess —
 *  so `basis` (what the correlation was based on) is recorded with it.
 *
 *  It never runs on a terminal receipt: attributing a session identity to a receipt
 *  that has already closed is exactly the mis-binding AC10 and FG-448 forbid. */
export function recordOrchestratorSessionIdentity(
  receiptId: string,
  identity: { providerSessionId?: string | null; strength: SessionIdentityStrength; basis?: string | null },
): OrchestratorReceipt {
  return withReceiptWrite(
    receiptId,
    "record the provider session identity",
    "The session's provider identity is not durably bound to its receipt, so a later resume or usage " +
      "capture cannot be attributed to it.",
    () =>
      writeTransaction(() => {
        const current = readRow(receiptId);
        if (!current) {
          throw new OrchestratorReceiptTransitionError(
            `forge: no orchestrator receipt ${receiptId} exists, so no provider session identity can be bound to it.`,
            receiptId,
            null,
            "running",
          );
        }
        if (isKnownReceiptState(current.state) && isTerminalReceiptState(current.state)) {
          throw new OrchestratorReceiptTransitionError(
            `forge: orchestrator receipt ${receiptId} is already ${current.state}; a provider session identity ` +
              `cannot be bound to a closed receipt.`,
            receiptId,
            current.state,
            current.state,
          );
        }
        getDb()
          .prepare(
            `UPDATE orchestrator_receipts
                SET provider_session_id = @provider_session_id,
                    identity_strength = @identity_strength,
                    identity_basis = @identity_basis,
                    updated_at = @updated_at
              WHERE receipt_id = @receipt_id`,
          )
          .run({
            receipt_id: receiptId,
            provider_session_id: identity.providerSessionId ?? null,
            identity_strength: identity.strength,
            identity_basis: identity.basis ?? null,
            updated_at: nowIso(),
          });
        return requireReceipt(receiptId);
      }),
  );
}

// ─── reads ──────────────────────────────────────────────────────────────────

function readRow(receiptId: string): OrchestratorReceiptRow | undefined {
  return getDb()
    .prepare(`SELECT ${ORCHESTRATOR_RECEIPT_COLUMNS} FROM orchestrator_receipts WHERE receipt_id = ?`)
    .get(receiptId) as OrchestratorReceiptRow | undefined;
}

function requireReceipt(receiptId: string): OrchestratorReceipt {
  const row = readRow(receiptId);
  if (!row) throw new Error(`forge: orchestrator receipt ${receiptId} vanished mid-transaction`);
  return rowToOrchestratorReceipt(row);
}

export function getOrchestratorReceipt(receiptId: string): OrchestratorReceipt | undefined {
  const row = readRow(receiptId);
  return row ? rowToOrchestratorReceipt(row) : undefined;
}

/** Look a session identifier up in the DURABLE RECEIPT that minted it — the AC10
 *  path. Both providers use bare UUIDs, so a cross-provider resume can only be
 *  refused by asking which receipt owns the identifier and reading its `provider`;
 *  an identifier FORMAT check cannot tell them apart and must never be used.
 *
 *  Matches the canonical session key OR the provider's own id, because an operator
 *  can paste either. Newest first, so a re-used identifier resolves to the receipt
 *  that most recently minted it. */
export function findOrchestratorReceiptBySessionIdentity(identifier: string): OrchestratorReceipt | undefined {
  const row = getDb()
    .prepare(
      `SELECT ${ORCHESTRATOR_RECEIPT_COLUMNS} FROM orchestrator_receipts
        WHERE session_key = ? OR provider_session_id = ?
        ORDER BY created_at DESC, receipt_id DESC
        LIMIT 1`,
    )
    .get(identifier, identifier) as OrchestratorReceiptRow | undefined;
  return row ? rowToOrchestratorReceipt(row) : undefined;
}

/** A receipt is filed under the PHYSICAL project directory: the launcher resolves its
 *  project root from `process.cwd()`, which the OS has already resolved through every
 *  symlink. A caller holding another spelling of the same directory — `/var/...` for
 *  `/private/var/...` on darwin, a relative path, a trailing slash — must not read as
 *  though the project has no receipts, which is how a live orchestrator goes missing
 *  from `forge show` and the dashboard.
 *
 *  projectIdentity is the ONE canonicalizer (src/v2/project-identity.ts, FG-425) and is
 *  reused rather than restated. It realpaths and falls back to `resolve` when the path
 *  cannot be resolved, so this operator read degrades to the as-written spelling instead
 *  of throwing on a project that has since been deleted. */
export function listOrchestratorReceiptsForProject(projectDir: string, limit = 200): OrchestratorReceipt[] {
  const rows = getDb()
    .prepare(
      `SELECT ${ORCHESTRATOR_RECEIPT_COLUMNS} FROM orchestrator_receipts
        WHERE project_dir = ?
        ORDER BY created_at DESC, receipt_id DESC
        LIMIT ?`,
    )
    .all(projectIdentity(projectDir).canonicalDir, limit) as OrchestratorReceiptRow[];
  return rows.map(rowToOrchestratorReceipt);
}

/** Receipts that CLAIM a confirmed spawn — deliberately not called "live".
 *
 *  This is the candidate set a liveness join runs over (AC7): every row here still
 *  has to be proven alive by the launcher-owned liveness record before any surface
 *  may render it as running. Returning it under a name containing "live" is how a
 *  caller ends up reporting a phantom orchestrator. */
export function listOrchestratorReceiptsClaimingRunning(limit = 200): OrchestratorReceipt[] {
  const rows = getDb()
    .prepare(
      `SELECT ${ORCHESTRATOR_RECEIPT_COLUMNS} FROM orchestrator_receipts
        WHERE state = 'running'
        ORDER BY created_at DESC, receipt_id DESC
        LIMIT ?`,
    )
    .all(limit) as OrchestratorReceiptRow[];
  return rows.map(rowToOrchestratorReceipt);
}

/** Receipts that have not reached a terminal state — `pending` and `running` alike.
 *  The sweep set for crash classification: a `pending` receipt whose launcher is gone
 *  never spawned anything, and a `running` one whose launcher is gone is orphaned. */
export function listOpenOrchestratorReceipts(limit = 200): OrchestratorReceipt[] {
  const rows = getDb()
    .prepare(
      `SELECT ${ORCHESTRATOR_RECEIPT_COLUMNS} FROM orchestrator_receipts
        WHERE state IN ('pending', 'running')
        ORDER BY created_at DESC, receipt_id DESC
        LIMIT ?`,
    )
    .all(limit) as OrchestratorReceiptRow[];
  return rows.map(rowToOrchestratorReceipt);
}
