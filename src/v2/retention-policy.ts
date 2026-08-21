// FG-590: the ONE retention authority for automatically retiring terminal runtime
// resources — the tmux remains of a finished `forge launch` and the stopped task
// container retained for failure investigation.
//
// This module is DELIBERATELY PURE: no fs, no docker, no tmux, no store. It answers
// three questions and nothing else — how a terminal outcome CLASSIFIES, how long that
// class is RETAINED, and what an aged resource's DISPOSITION is for a surface. The two
// convergence models that ACT on those answers (the filesystem-authoritative launch
// sweep in launch.ts, the DB+docker-authoritative container reap in ops.ts) stay
// separate and each keeps its own crash-safety proof; this module never merges them.
//
// Defaults are CODE CONSTANTS, so upgrade ships a safe policy with no project editing
// local config (the upgrade AC). `.forge/config.yml` and FORGE_* env are OVERRIDE-ONLY
// (resolveRetention), and an override may only re-time cleanup — it can never widen the
// safety posture, because the "never remove a running/non-terminal resource" rule lives
// at the destroy chokepoints, not here.

/** The two retention regimes. A terminal outcome is either a clean SUCCESS (retired
 *  promptly — its remains have no diagnostic value) or FAILURE/AMBIGUOUS (kept for a
 *  multi-day inspection window before automatic retirement). */
export type RetentionClass = "success" | "failure_ambiguous";

/** The retention durations, in milliseconds. `success` is short by design ("retire
 *  promptly"); `failureAmbiguous` is the diagnostic window a failed or undeterminable
 *  outcome is inspectable for. */
export type RetentionPolicy = {
  success: number;
  failureAmbiguous: number;
};

/** Retire a clean success promptly — long enough that a just-finished launch/container
 *  is still inspectable for a few minutes, short enough that a long autonomous run does
 *  not accumulate hundreds of dead successful resources. */
export const DEFAULT_SUCCESS_RETENTION_MS = 15 * 60_000; // 15 minutes

/** Keep a failed/signaled/owner-gone/unknown outcome inspectable for a multi-day
 *  diagnostic window before automatic retirement — the operator's investigation window. */
export const DEFAULT_FAILURE_RETENTION_MS = 7 * 24 * 60 * 60_000; // 7 days

export const DEFAULT_RETENTION_POLICY: RetentionPolicy = {
  success: DEFAULT_SUCCESS_RETENTION_MS,
  failureAmbiguous: DEFAULT_FAILURE_RETENTION_MS,
};

/** An optional override block (from `.forge/config.yml`'s `retention:` subtree or a
 *  caller). Every field is optional — an absent field falls back to the env override,
 *  then the code default. Durations are MILLISECONDS. */
export type RetentionOverrides = {
  successMs?: number;
  failureAmbiguousMs?: number;
};

/** The terminal launch states that classify as SUCCESS vs FAILURE/AMBIGUOUS — the
 *  discriminants of launch.ts's LaunchStatus, named here as strings so this module
 *  imports nothing from launch.ts (keeping it fs/tmux-free and dashboard-importable). */
const SUCCESS_LAUNCH_STATES: ReadonlySet<string> = new Set(["exited_ok"]);

/** Classify a terminal outcome into its retention regime.
 *
 *  A LAUNCH is classified from its LaunchStatus discriminant: `exited_ok` is the only
 *  success; `exited_error`, `signaled`, `terminated_unattributed`, `owner_gone`, and
 *  `unknown` are all failure/ambiguous (the ticket's "failed, signaled, owner-gone, or
 *  unknown" set). `running` is NOT terminal and must never be classified — callers gate
 *  on terminality first; passed here it conservatively reads failure_ambiguous (the
 *  longer window), so a misuse never shortens retention.
 *
 *  A CONTAINER is classified from its owning task's durable status: `complete` is
 *  success, everything else (`failed`, and any non-terminal status a caller should have
 *  filtered) is failure/ambiguous. A raw container exit code is NEVER consulted here —
 *  terminality is the task's DB status, per the non-goal. */
export function classifyRetention(
  input: { kind: "launch"; state: string } | { kind: "container"; taskStatus: string },
): RetentionClass {
  if (input.kind === "launch") {
    return SUCCESS_LAUNCH_STATES.has(input.state) ? "success" : "failure_ambiguous";
  }
  return input.taskStatus === "complete" ? "success" : "failure_ambiguous";
}

/** The retention window for a class under a policy. */
export function retentionWindowMs(cls: RetentionClass, policy: RetentionPolicy): number {
  return cls === "success" ? policy.success : policy.failureAmbiguous;
}

/** Layer overrides over env over the code defaults. Precedence, strongest first:
 *  explicit `overrides` (config block or caller) → FORGE_* env → DEFAULT_RETENTION_POLICY.
 *  A value that is not a finite, non-negative number is IGNORED at each layer (it falls
 *  through to the next), so a malformed override can only ever fall back to a safe
 *  default — never disable or negate a window. `env` is injectable for tests; it defaults
 *  to process.env (reading env is not an fs/docker/tmux side effect). */
export function resolveRetention(overrides?: RetentionOverrides, env: NodeJS.ProcessEnv = process.env): RetentionPolicy {
  const success = firstValid(overrides?.successMs, env["FORGE_RETENTION_SUCCESS_MS"], DEFAULT_SUCCESS_RETENTION_MS);
  const failureAmbiguous = firstValid(
    overrides?.failureAmbiguousMs,
    env["FORGE_RETENTION_FAILURE_MS"],
    DEFAULT_FAILURE_RETENTION_MS,
  );
  return { success, failureAmbiguous };
}

/** The first of the candidates that is a finite, non-negative duration. A string (env)
 *  is parsed as a number; anything else is skipped. The final fallback is a validated
 *  code default, so the result is always a real duration. */
function firstValid(...candidates: Array<number | string | undefined>): number {
  for (const c of candidates) {
    const n = typeof c === "string" ? Number(c) : c;
    if (typeof n === "number" && Number.isFinite(n) && n >= 0) return n;
  }
  return 0;
}

/** Is an aged terminal resource eligible for automatic removal NOW? A resource is
 *  eligible once its age EXCEEDS its class's window. This is the ONE eligibility gate the
 *  destroy paths use; it is deliberately distinct from `retentionDisposition` (a surface
 *  label) so the "is it time to reap" decision and the "how do we describe it" decision
 *  can never drift into agreeing by accident. */
export function reapEligible(cls: RetentionClass, ageMs: number, policy: RetentionPolicy): boolean {
  return ageMs > retentionWindowMs(cls, policy);
}

/** How a surface (forge status, the dashboard) should DESCRIBE a terminal resource,
 *  computed from class + age + clock — NEVER a stored flag, so it re-derives correctly
 *  after any crash and can never go stale:
 *
 *    within_retention_for_investigation — a FAILURE/AMBIGUOUS resource still inside its
 *      diagnostic window: deliberately retained for the operator to inspect. This is the
 *      "retained-for-investigation" bucket the ticket requires be visibly distinct.
 *    expired_eligible — eligible for routine automatic retirement with nothing being
 *      preserved: a failure/ambiguous resource PAST its diagnostic window, or a success
 *      resource inside its (short) prompt-retirement window. Cleanup may retire it.
 *    leaked — a SUCCESS resource STILL present PAST its prompt window. Successful work is
 *      retired promptly, so its lingering presence has outlived every reason to exist —
 *      the 447-dead-tmux-sessions / 25-stopped-containers condition FG-590 targets.
 *
 *  Note `expired_eligible` is not the same as `reapEligible`: a success resource inside
 *  its window renders `expired_eligible` (routine, no investigation) but is not yet
 *  reap-eligible. The surface label and the removal gate are answered separately on
 *  purpose. */
export type RetentionDisposition = "within_retention_for_investigation" | "expired_eligible" | "leaked";

export function retentionDisposition(cls: RetentionClass, ageMs: number, policy: RetentionPolicy): RetentionDisposition {
  const window = retentionWindowMs(cls, policy);
  if (cls === "failure_ambiguous") {
    return ageMs > window ? "expired_eligible" : "within_retention_for_investigation";
  }
  // success
  return ageMs > window ? "leaked" : "expired_eligible";
}
