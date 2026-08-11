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
//
// ── FG-693: PROJECT IDENTITY, AND THE DISPLAY / AUTHORITY SPLIT ─────────────
//
// FG-576 filed a receipt under a "canonical" project_dir computed by projectIdentity,
// whose fallback wrote a LEXICALLY resolved path into the same column on realpath
// failure. So orchestrator_receipts already holds an UNMARKED MIX of proven-canonical
// and guessed-lexical values under one column, and no reader can tell which it is
// looking at. FG-693 removes that ambiguity by splitting the two facts apart:
//
//   project_dir            the launcher's spelling, VERBATIM. Audit evidence and
//                          display. It is never rewritten and it decides NOTHING.
//   project_dir_canonical  the PROVEN filesystem identity (src/util/path-identity.ts)
//                          at write time, or NULL when the filesystem would not
//                          confirm the path. A lexical guess is never written here.
//
// The read stays WRITE-FREE — it does not opportunistically fill the canonical column
// for a legacy row it just resolved — because the dashboard holds a read-only store
// handle and a read that sometimes writes would fail on exactly the aged stores this
// mechanism exists to serve.
//
// LEGACY ROWS TAKE THE SHARED RULE, IMPORTED AND NOT RESTATED
// (./legacy-path-attribution.ts, shared verbatim with host_verifications gate
// evidence). Read-time resolution of a NULL-canonical receipt establishes AT MOST
// that the stored spelling resolves TODAY — never that it resolves to the tree the
// row was written against. A `/projects/current`-style spelling that pointed at
// checkout A survives being repointed at checkout B, and would otherwise let B claim
// A's receipt. FG-576's own rows are in this NULL-canonical population despite
// FG-576 having "already canonicalized" them, precisely because its fallback wrote
// unproven values.
//
// THE DISPOSITION OF A DECLINE DIFFERS FROM GATE EVIDENCE'S, DELIBERATELY. A receipt
// is not gate evidence, and declining it outright would re-create the exact defect
// this module's header names — a live orchestrator missing from `forge show` and the
// dashboard. So the split is by what the read DOES:
//
//   DISPLAY / LISTING   listOrchestratorReceiptsForProject. A declined legacy receipt
//                       is still SHOWN under the queried project, LABELLED as
//                       attributed by an unproven spelling. Display is not authority.
//   AUTHORITY / ACTING  listOrchestratorReceiptsAuthorizedForProject, and any
//                       lifecycle write given a project scope. PROVEN identity only —
//                       the ACTING-class bias, where an indeterminate comparison
//                       counts as NO match and the actor refuses: a receipt that
//                       cannot prove it belongs to the project never authorizes a
//                       transition, an adoption or a cleanup against it. The legacy
//                       arm reaches that bias through attributeLegacyRow, which takes
//                       provenSameOnly itself.
//
// Both dispositions count the decline under the shared reason codes
// (legacy-unresolved / legacy-alias-unprovable) and surface it where it costs
// something, so a refused transition or an unproven-spelling label is explained
// rather than mysterious.
//
// NAMED RESIDUAL, not closed and not hidden: retarget-proof does not exclude path
// RECREATION (`mv /a /b; mkdir /a` makes one absolute physical path name a different
// tree over time). That residual is IDENTICAL for a post-change proven-canonical row,
// is not an aliasing phenomenon, and is out of scope for FG-693.

import { randomBytes } from "node:crypto";
import { getDb, writeTransaction } from "./db.js";
import { resolveDbPath } from "../util/paths.js";
import {
  asIdentity,
  compareIdentity,
  describeIdentity,
  provenPhysical,
  type PathIdentityInput,
  type ResolvedPathIdentity,
} from "../util/path-identity.js";
import {
  attributeLegacyRow,
  countLegacyDecline,
  describeLegacyDeclines,
  legacyDeclineTotal,
  newLegacyDeclineTally,
  type LegacyDeclineReason,
  type LegacyDeclineTally,
} from "./legacy-path-attribution.js";
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

/** FG-693: a write that was given a PROJECT SCOPE and could not prove the receipt
 *  belongs to it. Deliberately its own type: the store is fine (not a write error)
 *  and the lifecycle edge may well be legal (not a transition error) — what failed
 *  is the identity claim, and a caller that catches it must not retry the same
 *  write against the same project the way D11's remedy would advise. */
export class OrchestratorReceiptAuthorityError extends Error {
  constructor(
    message: string,
    readonly receiptId: string,
    /** the project the caller claimed, as written. */
    readonly project: string,
    readonly reason: ReceiptAuthorityRefusal,
  ) {
    super(message);
    this.name = "OrchestratorReceiptAuthorityError";
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
  /** FG-693: PROVEN identity of project_dir at write time, or null when the
   *  filesystem would not confirm it. OPTIONAL on this type rather than required
   *  because ORCHESTRATOR_RECEIPT_COLUMNS — the historical projection external
   *  readers still select and insert with — does not name it; a row read through
   *  that projection is decoded as though its identity were unproven, which is the
   *  conservative direction for every consumer here. */
  project_dir_canonical?: string | null;
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
  /** WHAT THE LAUNCHER WROTE, verbatim. Audit evidence and display. Decides nothing
   *  (FG-693) — every project decision goes through `projectDirCanonical` or, for a
   *  NULL-canonical row, the shared legacy rule. */
  projectDir: string;
  /** FG-693: the PROVEN identity of projectDir at WRITE time, or null when nothing
   *  proved it (every pre-FG-693 row, plus anything written while its path was
   *  unresolvable). Never a lexical guess. */
  projectDirCanonical: string | null;
  /** FG-693: set ONLY by a project-scoped read, and only for the project that read
   *  asked about — how this receipt came to be listed under it. `unproven` rows are
   *  shown and labelled; they authorize nothing. */
  projectAttribution?: ReceiptProjectAttribution;
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

/** The historical column projection. FROZEN at its FG-576 membership: external
 *  readers select with it AND at least one seam inserts with it, so appending a
 *  column here would silently change the arity of somebody else's VALUES list.
 *  FG-693's companion column rides on ORCHESTRATOR_RECEIPT_READ_COLUMNS instead. */
export const ORCHESTRATOR_RECEIPT_COLUMNS =
  "receipt_id, session_key, state, created_at, updated_at, project_dir, project_name, resolved_profile, " +
  "runtime, provider, model, auth_mode, resolved_by, adapter, session_operation, session_target, " +
  "provider_session_id, identity_strength, identity_basis, carrier_generation, carrier_path, " +
  "carrier_acceptance, carrier_evidence, limitations, task_id, launcher_pid, launcher_identity, " +
  "started_at, closed_at, exit_code, exit_signal, failure_reason";

/** What THIS module reads: the historical projection plus FG-693's proven-identity
 *  companion. A reader that selects the historical projection alone still decodes —
 *  the column simply arrives absent, and an absent proof is treated exactly like an
 *  unproven one. */
export const ORCHESTRATOR_RECEIPT_READ_COLUMNS = `${ORCHESTRATOR_RECEIPT_COLUMNS}, project_dir_canonical`;

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

// ─── FG-693: attribution, and the authority it does or does not confer ──────

/** WHY a receipt is listed under the project a read asked about.
 *  `proven`   — PROVEN identity. This, and only this, authorizes.
 *  `unproven` — shown because the operator would otherwise lose a live orchestrator
 *               from `forge show`, LABELLED, and authorizing nothing. */
export type ReceiptProjectAttribution =
  | { readonly kind: "proven"; readonly physical: string }
  | { readonly kind: "unproven"; readonly reason: ReceiptAuthorityRefusal; readonly label: string };

/** Why identity could not be claimed. The two shared legacy reason codes, plus the
 *  two facts that are about the QUESTION rather than the row: the caller's own path
 *  is unproven, or the row provably belongs to a different tree. */
export type ReceiptAuthorityRefusal = LegacyDeclineReason | "unproven-target" | "other-project";

export type ReceiptProjectAuthority =
  | { readonly authorized: true; readonly physical: string }
  | { readonly authorized: false; readonly reason: ReceiptAuthorityRefusal };

/** The identity fields a decision needs — so an authority question can be asked of a
 *  decoded receipt or of a raw row without either being converted to the other. */
type ReceiptProjectIdentity = { projectDir: string; projectDirCanonical: string | null };

/** THE authority decision (ACTING class). A receipt authorizes something against a
 *  project only where identity is PROVEN:
 *
 *    post-change row  its proven canonical identity equals the caller's proven
 *                     physical path. Both sides are already realpaths — the stored
 *                     one proven at write time, the caller's proven just now — so
 *                     this is equality of two proven identities, NOT the raw-spelling
 *                     comparison FG-693 removes. Re-resolving the stored value here
 *                     would buy nothing and would widen the path-recreation residual.
 *    NULL-canonical   the shared retarget-proof rule (./legacy-path-attribution.ts),
 *                     imported and not restated, so receipts and gate evidence cannot
 *                     drift apart on what a legacy row is allowed to claim. */
export function receiptProjectAuthority(
  receipt: ReceiptProjectIdentity,
  project: PathIdentityInput,
): ReceiptProjectAuthority {
  const target = asIdentity(project);
  if (target.kind !== "resolved") return { authorized: false, reason: "unproven-target" };

  if (receipt.projectDirCanonical !== null) {
    return receipt.projectDirCanonical === target.physical
      ? { authorized: true, physical: target.physical }
      : { authorized: false, reason: "other-project" };
  }

  const attribution = attributeLegacyRow(receipt.projectDir, target);
  switch (attribution.outcome) {
    case "attributed":
      return { authorized: true, physical: attribution.physical };
    case "other_project":
      return { authorized: false, reason: "other-project" };
    case "declined":
      return { authorized: false, reason: attribution.reason };
    case "unproven_target":
      return { authorized: false, reason: "unproven-target" };
  }
}

function unprovenLabel(spelling: string, reason: ReceiptAuthorityRefusal): string {
  return `attributed by an unproven spelling (${spelling}) — ${reason}`;
}

/** How a candidate row relates to the project a read asked about, for DISPLAY.
 *  Returns null when the row must not be listed under it at all.
 *
 *  Everything below the `proven` arm is presentation, permitted by FG-693's non-goal
 *  that an operator spelling may be preserved for display PROVIDED it decides
 *  nothing — and it decides nothing here, because only `proven` ever reaches
 *  `receiptProjectAuthority`'s authorized answer. */
function displayAttribution(
  row: ReceiptProjectIdentity,
  target: PathIdentityInput,
  askedSpelling: string,
  declines: LegacyDeclineTally | null,
): ReceiptProjectAttribution | null {
  const asked = asIdentity(target);

  // The caller's own path does not resolve — routine here, where a checkout can be
  // deleted between launch and read. Nothing can be PROVEN about it, so the only
  // honest relation left is the recorded bytes matching the bytes we were handed.
  // It is exact equality, not alias reasoning, and it authorizes nothing.
  if (asked.kind !== "resolved") {
    return row.projectDir === askedSpelling
      ? { kind: "unproven", reason: "unproven-target", label: unprovenLabel(row.projectDir, "unproven-target") }
      : null;
  }

  const authority = receiptProjectAuthority(row, asked);
  if (authority.authorized) return { kind: "proven", physical: authority.physical };
  if (authority.reason === "other-project" || authority.reason === "unproven-target") return null;

  // A DECLINED legacy row. It keeps its place on the operator's surfaces — a live
  // orchestrator must never silently vanish from `forge show` — provided it is
  // plausibly this project's at all: its spelling resolves here today (which proves
  // nothing about where it pointed when the row was written), or, for a spelling
  // that no longer resolves, its recorded bytes are the ones we were asked about.
  const related =
    authority.reason === "legacy-unresolved"
      ? row.projectDir === askedSpelling
      : compareIdentity(row.projectDir, asked) === "same";
  if (!related) return null;

  if (declines) countLegacyDecline(declines, authority.reason);
  return { kind: "unproven", reason: authority.reason, label: unprovenLabel(row.projectDir, authority.reason) };
}

/** Decode a row as it stands under a project the caller asked about. Kept SEPARATE
 *  from rowToOrchestratorReceipt, whose single-argument shape callers pass directly
 *  to `.map()`. */
function receiptUnderProject(
  row: OrchestratorReceiptRow,
  projectAttribution: ReceiptProjectAttribution,
): OrchestratorReceipt {
  return { ...rowToOrchestratorReceipt(row), projectAttribution };
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
    projectDirCanonical: row.project_dir_canonical ?? null,
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

/** FG-576's write-side canonicalization, kept ONLY as a compatibility shim.
 *
 *  @deprecated It is NOT an identity and must not decide one. FG-693 stores the
 *  launcher's bytes verbatim in `project_dir` and the PROVEN identity beside them in
 *  `project_dir_canonical`; every decision in this module goes through
 *  `receiptProjectAuthority`. This function survives only so the dashboard's scope
 *  projection keeps compiling until it migrates to the contract, and it no longer
 *  delegates to projectIdentity — whose realpath-failure fallback wrote a LEXICALLY
 *  resolved path into a column that read as proven, which is the ambiguity FG-693
 *  removes. What it returns now is the PROVEN physical path where the filesystem
 *  confirms one, and otherwise the caller's spelling UNCHANGED: no lexical
 *  resolution, no rewriting, and no platform special-casing. */
export function canonicalReceiptProjectDir(projectDir: string): string {
  return provenPhysical(projectDir) ?? projectDir;
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
    // A refusal this module already made deliberately — an illegal edge, or FG-693's
    // unproven-identity refusal — is not a store failure and must not be dressed as
    // one: D11's "retry the same command" remedy is actively wrong advice for both.
    if (e instanceof OrchestratorReceiptTransitionError || e instanceof OrchestratorReceiptAuthorityError) throw e;
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
  // FG-693: the identity is resolved BEFORE the transaction opens. `writeTransaction`
  // is BEGIN IMMEDIATE on a machine-wide store, and both db.ts and runs.ts state the
  // same invariant — no filesystem syscall is held across the write lock, because a
  // realpath on a slow or unresponsive mount would block every other forge process on
  // this host for as long as it takes to answer.
  const projectDirCanonical = provenPhysical(decision.projectDir);
  return withReceiptWrite(receiptId, "write the pre-spawn launch record", PRE_SPAWN_CONSEQUENCE, () =>
    writeTransaction(() => {
      getDb()
        .prepare(
          `INSERT INTO orchestrator_receipts (${ORCHESTRATOR_RECEIPT_READ_COLUMNS})
           VALUES (@receipt_id, @session_key, @state, @created_at, @updated_at, @project_dir, @project_name,
                   @resolved_profile, @runtime, @provider, @model, @auth_mode, @resolved_by, @adapter,
                   @session_operation, @session_target, @provider_session_id, @identity_strength,
                   @identity_basis, @carrier_generation, @carrier_path, @carrier_acceptance,
                   @carrier_evidence, @limitations, @task_id, @launcher_pid, @launcher_identity,
                   @started_at, @closed_at, @exit_code, @exit_signal, @failure_reason,
                   @project_dir_canonical)`,
        )
        .run({
          receipt_id: receiptId,
          session_key: decision.sessionKey,
          state: "pending",
          created_at: at,
          updated_at: at,
          // FG-693: the launcher's bytes, VERBATIM — audit evidence, and the operator
          // spelling every surface renders. The identity goes in its own column, or
          // NULL when the filesystem would not confirm the path: an unresolvable
          // project is still a fully recorded receipt, it simply cannot later claim
          // to belong to a checkout nobody proved it belonged to.
          project_dir: decision.projectDir,
          project_dir_canonical: projectDirCanonical,
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
/** FG-693: the project a WRITE claims to be acting for. Optional everywhere, because
 *  a caller that holds no project context (the launcher closing the receipt it just
 *  minted, by id, in-process) is not making a cross-project claim and has nothing to
 *  prove. A caller that DOES hold one — a project-scoped cleanup, an orphan adoption,
 *  a dashboard-driven action — passes it, and the write is REFUSED unless identity is
 *  proven. Passing it can only ever narrow what a write may touch. */
export type ReceiptProjectScope = {
  project: PathIdentityInput;
  /** told about the refusal before it is thrown, for surfaces that count declines. */
  onDecline?: (report: ReceiptLegacyDeclineReport) => void;
};

/** ACTING class: an unproven identity never authorizes a write. The refusal names
 *  WHICH reason applies, so a legacy receipt refused because its spelling went
 *  through a link nobody can vouch for is distinguishable from one refused because
 *  it plainly belongs to another checkout. */
function requireProjectAuthority(receiptId: string, row: OrchestratorReceiptRow, scope: ReceiptProjectScope): void {
  const authority = receiptProjectAuthority(
    { projectDir: row.project_dir, projectDirCanonical: row.project_dir_canonical ?? null },
    scope.project,
  );
  if (authority.authorized) return;

  const asked = asIdentity(scope.project);
  const message =
    `forge: orchestrator receipt ${receiptId} cannot be acted on for ${describeIdentity(asked)} — ` +
    `${refusalExplanation(authority.reason, row.project_dir)}. The write was refused rather than applied ` +
    `against a project the receipt cannot be proven to belong to.`;
  if (scope.onDecline && (authority.reason === "legacy-unresolved" || authority.reason === "legacy-alias-unprovable")) {
    const declines = newLegacyDeclineTally();
    countLegacyDecline(declines, authority.reason);
    scope.onDecline({ projectDir: asked.asWritten, declines, message });
  }
  throw new OrchestratorReceiptAuthorityError(message, receiptId, asked.asWritten, authority.reason);
}

function refusalExplanation(reason: ReceiptAuthorityRefusal, storedSpelling: string): string {
  switch (reason) {
    case "other-project":
      return `its proven identity is a different directory`;
    case "unproven-target":
      return `the project path given does not resolve, so nothing can be proven about it`;
    case "legacy-unresolved":
      return (
        `it predates canonical project identity and its recorded path (${storedSpelling}) no longer resolves, ` +
        `so nothing can establish which tree it was written against`
      );
    case "legacy-alias-unprovable":
      return (
        `it predates canonical project identity and its recorded path (${storedSpelling}) resolves only through ` +
        `a symlink, whose target when the receipt was written cannot be established`
      );
  }
}

function transition(
  receiptId: string,
  to: OrchestratorReceiptState,
  patch: TransitionPatch,
  at: string,
  scope?: ReceiptProjectScope,
): OrchestratorReceipt {
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
      // FG-693: BEFORE legality. A caller that cannot prove the receipt is this
      // project's has no standing to move it at all, legal edge or not.
      if (scope) requireProjectAuthority(receiptId, current, scope);
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
  scope?: ReceiptProjectScope,
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
    scope,
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

export function closeOrchestratorReceipt(
  receiptId: string,
  outcome: ReceiptCloseOutcome,
  scope?: ReceiptProjectScope,
): OrchestratorReceipt {
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
    scope,
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
  scope?: ReceiptProjectScope,
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
        if (scope) requireProjectAuthority(receiptId, current, scope);
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
    .prepare(`SELECT ${ORCHESTRATOR_RECEIPT_READ_COLUMNS} FROM orchestrator_receipts WHERE receipt_id = ?`)
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
      `SELECT ${ORCHESTRATOR_RECEIPT_READ_COLUMNS} FROM orchestrator_receipts
        WHERE session_key = ? OR provider_session_id = ?
        ORDER BY created_at DESC, receipt_id DESC
        LIMIT 1`,
    )
    .get(identifier, identifier) as OrchestratorReceiptRow | undefined;
  return row ? rowToOrchestratorReceipt(row) : undefined;
}

// ─── FG-693: the project-scoped reads ───────────────────────────────────────
//
// A receipt is attributed to a project by PROVEN identity, never by raw-string
// equality on the spelling the launcher happened to hold. Two populations answer
// every project question, and they are queried separately because they are answered
// differently:
//
//   PROVEN      project_dir_canonical = <the caller's proven physical path>. One
//               indexed equality probe (idx_orchestrator_receipts_project_canonical),
//               alias-agnostic, no filesystem call per row.
//   LEGACY      project_dir_canonical IS NULL — every pre-FG-693 row plus anything
//               written while its path was unresolvable. Decided in process by the
//               shared retarget-proof rule.
//
// THE LEGACY SCAN IS NOT CAPPED, and the earlier `LIMIT 2000` on it was the same
// defect this ticket exists to remove. It read the newest N NULL-canonical rows and
// only THEN asked which project they belonged to, so a store holding more than N
// newer legacy receipts for other projects hid an older in-scope one from both the
// listing and the authorized read — and hid it silently, which reads as "there are
// none". A cap applied before the identity question is not a bound, it is a wrong
// answer with a constant in front of it.
//
// What narrows it instead is the question itself, asked once per DISTINCT recorded
// spelling rather than once per row: a spelling is a property of a checkout, so the
// population is one entry per project directory ever launched from (tens), not one
// per receipt. The rows are then fetched by that spelling set under the CALLER'S OWN
// `limit`, ordered newest-first — the same explicit newest-N contract the proven arm
// has always had, applied to both arms so the merged result is genuinely the newest
// `limit` receipts of the union.

export type ReceiptLegacyDeclineReport = {
  /** the caller's spelling, as given. */
  projectDir: string;
  declines: LegacyDeclineTally;
  /** one operator-facing line, already assembled. */
  message: string;
};

export type ReceiptProjectReadOptions = {
  /** collects the NULL-canonical rows that could not be PROVEN to be this project's,
   *  under the two shared reason codes. */
  declines?: LegacyDeclineTally;
};

type AttributedRow = { row: OrchestratorReceiptRow; attribution: ReceiptProjectAttribution };

/** Newest first, receipt_id as the deterministic tie-break — the order both project
 *  reads have always promised, applied across the merged populations so a caller
 *  cannot tell (or come to depend on) which SQL statement a row arrived from. */
function byRecency(a: AttributedRow, b: AttributedRow): number {
  if (a.row.created_at !== b.row.created_at) return a.row.created_at < b.row.created_at ? 1 : -1;
  return a.row.receipt_id < b.row.receipt_id ? 1 : -1;
}

/** The NULL-canonical receipts this project could be shown, newest `limit` first.
 *
 *  The spelling decides, so the spelling is what gets asked: one pass over the
 *  DISTINCT recorded directories (one per checkout ever launched from), each put
 *  through the SAME `displayAttribution` the per-row pass below applies, and then one
 *  ordered, limited read of the rows recorded under the surviving ones. The declines
 *  are deliberately NOT tallied here — a tally counts ROWS an operator is shown, and
 *  this pass counts spellings — so the per-row pass remains the only counter. */
function legacyRowsForProject(
  db: ReturnType<typeof getDb>,
  target: ResolvedPathIdentity,
  askedSpelling: string,
  limit: number,
  select: (where: string, params: unknown[]) => OrchestratorReceiptRow[],
): OrchestratorReceiptRow[] {
  const spellings = (
    db
      .prepare(`SELECT DISTINCT project_dir FROM orchestrator_receipts WHERE project_dir_canonical IS NULL`)
      .all() as Array<{ project_dir: string | null }>
  )
    .map((row) => row.project_dir)
    .filter((spelling): spelling is string => spelling !== null && spelling !== "")
    .filter(
      (spelling) =>
        displayAttribution({ projectDir: spelling, projectDirCanonical: null }, target, askedSpelling, null) !== null,
    );
  if (spellings.length === 0) return [];
  return select(`project_dir_canonical IS NULL AND project_dir IN (${spellings.map(() => "?").join(",")})`, [
    ...spellings,
    limit,
  ]);
}

function attributedProjectRows(
  projectDir: string,
  limit: number,
  declines: LegacyDeclineTally | null,
): AttributedRow[] {
  const db = getDb();
  const target = asIdentity(projectDir);
  const select = (where: string, params: unknown[]): OrchestratorReceiptRow[] =>
    db
      .prepare(
        `SELECT ${ORCHESTRATOR_RECEIPT_READ_COLUMNS} FROM orchestrator_receipts
          WHERE ${where}
          ORDER BY created_at DESC, receipt_id DESC
          LIMIT ?`,
      )
      .all(...params) as OrchestratorReceiptRow[];

  // An unresolved caller path can probe nothing: there is no proven value to compare
  // with, and `= NULL` matches nothing anyway. It reads by recorded bytes only, and
  // everything it finds is labelled unproven.
  const candidates: OrchestratorReceiptRow[] =
    target.kind === "resolved"
      ? [
          ...select("project_dir_canonical = ?", [target.physical, limit]),
          ...legacyRowsForProject(db, target, projectDir, limit, select),
        ]
      : select("project_dir = ?", [projectDir, limit]);

  const attributed: AttributedRow[] = [];
  for (const row of candidates) {
    const attribution = displayAttribution(
      { projectDir: row.project_dir, projectDirCanonical: row.project_dir_canonical ?? null },
      target,
      projectDir,
      declines,
    );
    if (attribution) attributed.push({ row, attribution });
  }
  return attributed.sort(byRecency).slice(0, limit);
}

/** DISPLAY / LISTING — what `forge show` and the dashboard panel put in front of an
 *  operator. Every receipt this project can plausibly claim, each carrying HOW it was
 *  attributed:
 *
 *    proven    identity was established (post-change canonical match, or a legacy row
 *              the retarget-proof rule vouches for).
 *    unproven  shown anyway, LABELLED. A legacy receipt whose spelling resolves here
 *              today but cannot be proven to have resolved here when it was written,
 *              or a project path that no longer resolves at all. Declining these
 *              outright would re-create the exact FG-576 defect this module exists to
 *              close — a live orchestrator missing from `forge show` — and display is
 *              not authority: nothing here authorizes a transition or a cleanup.
 *
 *  A caller that needs to ACT must use listOrchestratorReceiptsAuthorizedForProject
 *  (or pass a project scope to the write), never this list. */
export function listOrchestratorReceiptsForProject(
  projectDir: string,
  limit = 200,
  opts: ReceiptProjectReadOptions = {},
): OrchestratorReceipt[] {
  return attributedProjectRows(projectDir, limit, opts.declines ?? null).map(({ row, attribution }) =>
    receiptUnderProject(row, attribution),
  );
}

/** AUTHORITY / ACTING — the receipts this project may act on: adopt, transition,
 *  clean up. PROVEN identity only. A receipt that is merely displayed under the
 *  project is absent here by construction, and the declines that made it so are
 *  reported (they are the reason an operator sees a receipt listed that no action
 *  will touch).
 *
 *  The report channel is deliberately WRITE-FREE — no event row, no opportunistic
 *  backfill of the canonical column — because this is reachable from a read-only
 *  store handle, and a read that sometimes writes would fail on exactly the aged
 *  stores the legacy rule exists to serve. */
export function listOrchestratorReceiptsAuthorizedForProject(
  projectDir: string,
  limit = 200,
  opts: ReceiptProjectReadOptions & { onLegacyDeclines?: (report: ReceiptLegacyDeclineReport) => void } = {},
): OrchestratorReceipt[] {
  const declines = opts.declines ?? newLegacyDeclineTally();
  const authorized = attributedProjectRows(projectDir, limit, declines)
    .filter(({ attribution }) => attribution.kind === "proven")
    .map(({ row, attribution }) => receiptUnderProject(row, attribution));

  if (legacyDeclineTotal(declines) > 0) {
    const message =
      `forge: ${describeLegacyDeclines(declines)} orchestrator receipt(s) listed under ` +
      `${describeIdentity(projectDir)} predate canonical project identity and their recorded path cannot be ` +
      `proven to name this checkout, so they are shown but authorize no transition or cleanup`;
    const report: ReceiptLegacyDeclineReport = { projectDir, declines, message };
    if (opts.onLegacyDeclines) opts.onLegacyDeclines(report);
    else console.error(message);
  }
  return authorized;
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
      `SELECT ${ORCHESTRATOR_RECEIPT_READ_COLUMNS} FROM orchestrator_receipts
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
      `SELECT ${ORCHESTRATOR_RECEIPT_READ_COLUMNS} FROM orchestrator_receipts
        WHERE state IN ('pending', 'running')
        ORDER BY created_at DESC, receipt_id DESC
        LIMIT ?`,
    )
    .all(limit) as OrchestratorReceiptRow[];
  return rows.map(rowToOrchestratorReceipt);
}
