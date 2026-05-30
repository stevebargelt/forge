// AWN-3: retry policy per failure_kind. Makes `forge retry` predictable — it
// explains why a failed task is retryable or not, and carries forward the
// previous failure context (no secrets) so the new attempt is informed.
//
// Transient failures (infra/timeout/crash) retry cleanly. Auth failures retry
// but warn that auth must be resolved first. Outcome failures that would simply
// re-run identical work (gate rejection, red block) are NOT retryable via
// `forge retry` — they need the underlying issue addressed (or a --force
// override) rather than a blind re-dispatch.

export type RetryDisposition = {
  retryable: boolean;
  reason: string;
  advice?: string; // extra human guidance (e.g. "resolve auth first")
};

const POLICY: Record<string, RetryDisposition> = {
  idle_timeout:         { retryable: true, reason: "transient — the agent went idle; a fresh attempt may complete" },
  container_crash:      { retryable: true, reason: "transient infrastructure failure; re-dispatch" },
  orphaned:             { retryable: true, reason: "the container was lost (host/parent crash); re-dispatch" },
  result_missing:       { retryable: true, reason: "no result was written; re-dispatch" },
  result_malformed:     { retryable: true, reason: "the result was unparseable; the agent may produce valid output on retry" },
  model_error:          { retryable: true, reason: "model/provider error; re-dispatch" },
  tool_error:           { retryable: true, reason: "a tool failed; re-dispatch" },
  cancelled:            { retryable: true, reason: "the task was cancelled; re-dispatch to resume the work" },
  unknown:              { retryable: true, reason: "cause unclear; re-dispatch (inspect logs if it recurs)" },

  auth_missing:         { retryable: true, reason: "auth was missing", advice: "ensure the auth profile / login is set up before retrying" },
  auth_expired:         { retryable: true, reason: "the auth session expired", advice: "refresh the session/profile before retrying" },
  auth_injection_failed:{ retryable: true, reason: "auth injection failed", advice: "verify the auth profile, then retry" },

  gate_rejected:        { retryable: false, reason: "a human rejected this at the gate; retry would re-run identical inputs", advice: "use `forge gate <task> request-changes` to send fix guidance, or address the rejection" },
  red_blocked:          { retryable: false, reason: "a red review blocked this; retry re-runs the same work unchanged", advice: "fix the finding (or override with `forge gate <task> advance --force`), then advance" },
};

const NO_KIND: RetryDisposition = { retryable: true, reason: "no recorded failure kind; re-dispatch" };

/** The retry disposition for a failure kind (undefined → no recorded kind). */
export function retryPolicy(failureKind: string | undefined): RetryDisposition {
  if (failureKind === undefined) return NO_KIND;
  return POLICY[failureKind] ?? { retryable: true, reason: `unrecognized failure kind '${failureKind}'; re-dispatch` };
}
