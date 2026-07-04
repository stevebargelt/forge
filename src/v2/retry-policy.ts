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
  orphaned_work_may_persist: { retryable: false, reason: "the container was lost, but the worktree has changed files — a blind retry would re-dispatch over unreviewed work and could clobber it", advice: "inspect the worktree diff, verify/salvage the work, then `forge retry --force` once you've confirmed it's safe to re-dispatch" },
  result_missing:       { retryable: true, reason: "no result was written; re-dispatch" },
  result_malformed:     { retryable: true, reason: "the result was unparseable; the agent may produce valid output on retry" },
  work_not_persisted:   { retryable: true, reason: "the agent's output never reached the host project mount; re-dispatch", advice: "ensure containers run with cwd = the /project bind mount (spawn.ts -w) so cwd-relative writes persist" },
  model_error:          { retryable: true, reason: "model/provider error; re-dispatch" },
  tool_error:           { retryable: true, reason: "a tool failed; re-dispatch" },
  cancelled:            { retryable: true, reason: "the task was cancelled; re-dispatch to resume the work" },
  unknown:              { retryable: true, reason: "cause unclear; re-dispatch (inspect logs if it recurs)" },

  auth_missing:         { retryable: true, reason: "auth was missing", advice: "ensure the auth profile / login is set up before retrying" },
  auth_expired:         { retryable: true, reason: "the auth session expired", advice: "refresh the session/profile before retrying" },
  auth_injection_failed:{ retryable: true, reason: "auth injection failed", advice: "verify the auth profile, then retry" },

  fanout_wave_orphaned: { retryable: false, reason: "this task is a fanout wave's parent; retrying it directly would mint a second, uncoordinated pending primary in the same phase, bypassing forge recover's re-drive coordination and audit trail", advice: "use `forge recover <parent> --re-drive` to re-drive the whole wave coherently, or pass --force to retry anyway" },
  gate_rejected:        { retryable: false, reason: "a human rejected this at the gate; retry would re-run identical inputs", advice: "use `forge gate <task> request-changes` to send fix guidance, or address the rejection" },
  red_blocked:          { retryable: false, reason: "a red review blocked this; retry re-runs the same work unchanged", advice: "fix the finding (or override with `forge gate <task> advance --force`), then advance" },
  integration_failed:   { retryable: false, reason: "the merge was clean but build+test of the merged tree failed; retry would re-dispatch against the same broken merge", advice: "fix the break in code, or run `git reset --hard HEAD~1` in run.projectDir to undo the merge, then retry" },
};

const NO_KIND: RetryDisposition = { retryable: true, reason: "no recorded failure kind; re-dispatch" };

/** The retry disposition for a failure kind (undefined → no recorded kind). */
export function retryPolicy(failureKind: string | undefined): RetryDisposition {
  if (failureKind === undefined) return NO_KIND;
  return POLICY[failureKind] ?? { retryable: true, reason: `unrecognized failure kind '${failureKind}'; re-dispatch` };
}
