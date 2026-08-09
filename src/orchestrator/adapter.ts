// FG-576 step 5 — THE PROVIDER-NEUTRAL INTERACTIVE ORCHESTRATOR ADAPTER CONTRACT.
//
// Forge has exactly one interactive launcher today (`forge claude`) and it is
// provider-specific by construction, so this file is the contract rather than a
// generalization of a second in-repo adapter. It is the code-level counterpart of
// the capability/parity matrix in src/v2/orchestrator-capabilities.ts: the matrix
// says what each adapter DOES, this says what each adapter must SUPPLY.
//
// Seven members, one per capability the launcher needs before it may spawn:
//
//   probeReadiness            gather POSITIVE evidence from the INSTALLED build.
//   declareInstructionCarrier the Forge-OWNED instruction surface for this launch.
//   declareSessionIdentityStrength  how strongly the provider lets Forge bind an id.
//   mapSessionOperation       new / continue / resume onto the provider's own verbs.
//   buildArgv                 the Forge-owned argv, each flag EXACTLY ONCE.
//   buildChildEnv             the child environment, composed from the PARENT.
//   onSpawnConfirmed / closeOut   post-spawn observation and close-out.
//
// TWO RULES THE CONTRACT ENFORCES BY SHAPE RATHER THAN BY REVIEW:
//
//   AC2 — buildChildEnv receives the LAUNCHER's environment and nothing else. There
//   is no parameter through which one adapter's composed environment could reach
//   another, so "the Codex child env is not derived from the Claude one" is a
//   property of the signature, not a thing each adapter has to remember.
//
//   D6 — `reservedPassthroughFlags` is the adapter's own declaration of the argv
//   dimensions Forge owns. The launcher refuses a passthrough token that touches
//   one, so provider passthrough can never become a second, unrecorded way to set
//   the provider, model, auth, project root or resume identity. `forgeOwnedFlags`
//   is the closed set the adapter may itself emit — the argument-closure surface
//   step 9 asserts against.
//
// Nothing here performs I/O, spawns anything, or touches the store. The launcher
// (src/orchestrator/launch.ts) sequences these members and owns every durable
// consequence, which is why the two commands cannot drift: neither of them, and
// neither adapter, owns the lifecycle.

import type { OrchestratorAdapterId, SessionIdentityStrength as AdapterIdentityCapability } from "../v2/orchestrator-capabilities.js";
import type { OrchestratorDecision, OrchestratorSessionOperation } from "../v2/orchestrator-resolve.js";
import type { CapabilityLimitation, CarrierAcceptance, SessionIdentityStrength } from "../store/orchestrator-receipts.js";

export type { OrchestratorAdapterId } from "../v2/orchestrator-capabilities.js";

// ---------------------------------------------------------------------------
// Refusals raised at the LAUNCH boundary
// ---------------------------------------------------------------------------

/** Refusals the launcher itself raises, as opposed to the ones resolution raises
 *  (ORCHESTRATOR_REFUSAL_CODES in src/v2/orchestrator-resolve.ts). Kept as its own
 *  closed set because these are failures of the LAUNCH, not of the decision — a
 *  caller can tell "policy will not permit this" from "this launch could not be
 *  recorded" without string-matching a message. */
export const LAUNCH_REFUSAL_CODES = [
  "adapter-unavailable",
  "adapter-not-ready",
  "passthrough-not-permitted",
  "unsafe-session-identifier",
  "conflicting-session-operation",
  "cross-provider-resume",
  "receipt-unwritable",
  "liveness-unwritable",
  "carrier-unwritable",
] as const;

export type LaunchRefusalCode = (typeof LAUNCH_REFUSAL_CODES)[number];

/** Structurally identical to OrchestratorRefusal's operator-facing half, so the
 *  commands print resolution refusals and launch refusals through one path.
 *  `remediation` is never empty: a refusal with no remedy is a dead end. */
export type LaunchRefusal = {
  code: LaunchRefusalCode;
  message: string;
  remediation: string[];
};

export function launchRefusal(code: LaunchRefusalCode, headline: string, remediation: string[]): LaunchRefusal {
  const body = remediation.map((r) => `  - ${r}`).join("\n");
  return { code, message: `${headline}\nFix:\n${body}`, remediation };
}

// ---------------------------------------------------------------------------
// What an adapter is given
// ---------------------------------------------------------------------------

export type AdapterLaunchContext = {
  /** The full pre-spawn decision from src/v2/orchestrator-resolve.ts. */
  decision: OrchestratorDecision;
  /** The resolved project root. This is the child's cwd, and no argv the adapter
   *  emits and no passthrough token may change it. */
  projectDir: string;
  /** The project display identity carried into the session (AC6). */
  projectName: string;
  /** THE canonical Forge session identity. The receipt and the launcher-owned
   *  liveness record are BOTH keyed by it, which is what makes one session count
   *  once across two writers (D12). */
  sessionKey: string;
  receiptId: string;
  /** The orchestrator run/task the session's usage binds to (#163, AC12). Null when
   *  the best-effort instrumentation write failed — never a reason to refuse. */
  runId: string | null;
  taskId: string | null;
  operation: OrchestratorSessionOperation;
  /** Operator tokens after the explicit `--` separator, ALREADY D6-guarded by the
   *  launcher against this adapter's `reservedPassthroughFlags`. */
  passthrough: readonly string[];
  /** The LAUNCHER's environment. An adapter composes its child env from this and
   *  from nothing else (AC2). */
  parentEnv: NodeJS.ProcessEnv;
};

// ---------------------------------------------------------------------------
// What an adapter returns
// ---------------------------------------------------------------------------

/** What probing the INSTALLED build established. Everything here is evidence or the
 *  honest absence of it; nothing is inferred from the flag Forge intends to pass.
 *
 *  For an adapter whose instruction surface is version-coupled and silently ignored
 *  when unsupported (Codex — AC8), readiness is a GATE and `refusal` is how it says
 *  so. For an adapter whose CLI rejects an unknown flag itself (Claude), readiness
 *  is evidence-gathering ONLY: a missing binary must reach the spawn path and close
 *  the receipt as `spawn_failed`, not masquerade as a policy refusal. */
export type AdapterReadiness = {
  /** Free-form, adapter-owned facts the carrier/argv steps read back. */
  evidence: Record<string, string>;
  /** Advisory findings printed before launch. Never fatal (FG-499). */
  advisories: string[];
  /** Capability gaps THIS launch discovered, on top of the standing matrix rows. */
  limitations: CapabilityLimitation[];
};

export type AdapterReadinessResult =
  | { ok: true; readiness: AdapterReadiness }
  | { ok: false; refusal: LaunchRefusal };

/** The Forge-owned instruction surface for one launch.
 *
 *  `path` + `content` are declared here and MATERIALIZED by the launcher, after the
 *  receipt exists — so an instruction file is never left behind for a launch that
 *  was refused before it was recorded. `acceptance` is the receipt's AC8 field and
 *  defaults to `unproven`: constructing a flag is not evidence it was honored. */
export type AdapterCarrier = {
  /** Absolute path to materialize `content` at, or null when this launch binds no
   *  Forge-owned carrier (in which case `argv` is empty and a limitation says why). */
  path: string | null;
  content: string | null;
  /** Which Forge generation/release the canonical policy came from (AC8 provenance). */
  generation: string | null;
  acceptance: CarrierAcceptance;
  evidence: string | null;
  /** The argv the carrier contributes. Empty when there is no carrier. */
  argv: readonly string[];
  limitations: CapabilityLimitation[];
};

/** The provider session identity, as strongly as the provider actually allows.
 *  `strength` is the RECEIPT vocabulary (asserted / correlated / ambiguous /
 *  unknown), which is wider than the adapter's declared capability precisely so a
 *  launch that could not reach the adapter's best case records the truth. */
export type AdapterSessionIdentity = {
  providerSessionId: string | null;
  strength: SessionIdentityStrength;
  /** What the strength is based on, in the operator's terms. Recorded verbatim. */
  basis: string | null;
};

export type AdapterOperationMapping = {
  /** Argv the operation contributes (e.g. --session-id / --resume / --continue). */
  argv: readonly string[];
  identity: AdapterSessionIdentity;
  /** The identifier the operator asked to act on, for the receipt. */
  sessionTarget: string | null;
  notes: string[];
  limitations: CapabilityLimitation[];
};

export type AdapterOperationResult =
  | { ok: true; mapping: AdapterOperationMapping }
  | { ok: false; refusal: LaunchRefusal };

export type AdapterArgvParts = {
  readiness: AdapterReadiness;
  carrier: AdapterCarrier;
  operation: AdapterOperationMapping;
};

export type AdapterArgvResult =
  | { ok: true; argv: string[] }
  | { ok: false; refusal: LaunchRefusal };

/** What the adapter observed once the child was CONFIRMED spawned. Claude asserts
 *  its identity pre-spawn and returns nothing here; Codex correlates its own after
 *  the fact (step 7), which is the only reason this member exists. */
export type AdapterSpawnObservation = {
  identity?: AdapterSessionIdentity;
  advisories?: string[];
};

export type AdapterCloseOutcome = {
  state: "exited" | "spawn_failed";
  exitCode: number | null;
  signal: string | null;
  reason: string | null;
};

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

export type OrchestratorAdapter = {
  readonly id: OrchestratorAdapterId;
  readonly displayName: string;
  /** The host executable spawned. Resolved through PATH by the launcher, so a test
   *  puts a FAKE one earlier on PATH and no billed session is ever started (AC13). */
  readonly executable: string;

  /** The CLOSED set of flags this adapter may itself emit. Argument closure (step 9)
   *  asserts the recorded argv against it, so no operand can reach the child that
   *  Forge did not construct. */
  readonly forgeOwnedFlags: readonly string[];

  /** D6: argv dimensions Forge owns, which passthrough may therefore never set —
   *  provider, model, auth, project root, instruction surface, session identity, and
   *  anything that would make the recorded receipt untrue (e.g. a non-interactive
   *  print mode under a receipt claiming an interactive orchestrator). */
  readonly reservedPassthroughFlags: readonly string[];

  probeReadiness(ctx: AdapterLaunchContext): AdapterReadinessResult;

  declareInstructionCarrier(ctx: AdapterLaunchContext, readiness: AdapterReadiness): AdapterCarrier;

  /** The asset root that RENDERED the Forge-owned instruction surface this launch
   *  bound, when that is not the running assets. Null (or an adapter that does not
   *  implement it) means the running assets, which is the default the launcher assumes.
   *
   *  This exists because the two adapters answer differently and the launch-boundary
   *  generation check (FG-253 step 8) must judge the project against the forge this
   *  session is ACTUALLY bound to. Claude reads the running tree's
   *  `seeds/orchestrator-template.md`, so it declares nothing. Codex binds out of the
   *  PUBLISHED seed generation, which a failed or deferred publication leaves behind
   *  the running release — and a drift report that compares against the running assets
   *  in that state reports agreement the session does not have. */
  declareBoundAssetRoot?(readiness: AdapterReadiness): string | null;

  /** The adapter's CAPABILITY, from the parity matrix — what it can do at best, not
   *  what this particular launch achieved. */
  declareSessionIdentityStrength(): AdapterIdentityCapability;

  mapSessionOperation(ctx: AdapterLaunchContext): AdapterOperationResult;

  buildArgv(ctx: AdapterLaunchContext, parts: AdapterArgvParts): AdapterArgvResult;

  /** Composed from `ctx.parentEnv` ONLY. Must not mutate it. */
  buildChildEnv(ctx: AdapterLaunchContext, readiness: AdapterReadiness): NodeJS.ProcessEnv;

  /** Advisory preflight lines. Never fatal — an interactive session handles its own
   *  auth failure natively, so forge warns and proceeds (FG-499). */
  preflight(ctx: AdapterLaunchContext): string[];

  onSpawnConfirmed(ctx: AdapterLaunchContext, spawned: { pid: number | undefined }): AdapterSpawnObservation;

  /** Never throws: close-out runs on the exit path, and a telemetry failure must not
   *  change the exit code the operator sees. */
  closeOut(ctx: AdapterLaunchContext, outcome: AdapterCloseOutcome): void;
};

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** A session identifier safe to use as a canonical key: it becomes a FILE NAME in
 *  the liveness namespace and an argv operand, so a leading dash, a path separator
 *  or whitespace is refused rather than sanitized. Sanitizing would silently launch
 *  a session under an identity the operator did not ask for. */
export const SAFE_SESSION_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isSafeSessionIdentifier(value: string): boolean {
  return SAFE_SESSION_IDENTIFIER.test(value);
}

/** True when `token` sets `flag`, in either `--flag value` or `--flag=value` form. */
export function tokenTargetsFlag(token: string, flag: string): boolean {
  return token === flag || token.startsWith(`${flag}=`);
}
