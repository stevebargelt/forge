// AWN-3: retry policy per failure_kind. Makes `forge retry` predictable — it
// explains why a failed task is retryable or not, and carries forward the
// previous failure context (no secrets) so the new attempt is informed.
//
// Transient failures (infra/timeout/crash) retry cleanly. Auth failures retry
// but warn that auth must be resolved first. Outcome failures that would simply
// re-run identical work (gate rejection, red block) are NOT retryable via
// `forge retry` — they need the underlying issue addressed (or a --force
// override) rather than a blind re-dispatch.
//
// FG-425: this advice is the operator-facing surface `forge retry` PRINTS. It
// must describe the world AFTER the serialized integration publisher — a failed
// integration gate publishes NOTHING, so no advice here may tell an operator to
// undo a merge on the publish target.

import type { FailureKind } from "./failure-kind.js";

export type RetryDisposition = {
  retryable: boolean;
  reason: string;
  advice?: string; // extra human guidance (e.g. "resolve auth first")
};

// Typed as Record<FailureKind, …>, NOT Record<string, …>: every failure kind
// MUST carry a named disposition. A kind added to FailureKind without an entry
// here is a COMPILE ERROR, not a silent fall-through to the unrecognized-kind
// default below — which is what let the FG-425 kinds reach operators as
// "unrecognized failure kind 'dirty_publish_target'; re-dispatch" (retryable,
// with no remediation) for as long as they did. The string-keyed lookup in
// retryPolicy() still guards the runtime case of a kind read back off an old
// event that this build no longer knows about.
const POLICY: Record<FailureKind, RetryDisposition> = {
  idle_timeout:         { retryable: true, reason: "transient — the agent went idle; a fresh attempt may complete" },
  container_crash:      { retryable: true, reason: "transient infrastructure failure; re-dispatch" },
  orphaned:             { retryable: true, reason: "the container was lost (host/parent crash); re-dispatch" },
  orphaned_work_may_persist: { retryable: false, reason: "the container was lost, but the worktree has changed files — a blind retry would re-dispatch over unreviewed work and could clobber it", advice: "inspect the worktree diff, verify/salvage the work, then `forge retry <id> --force` once you've confirmed it's safe to re-dispatch" },
  oom_killed:           { retryable: false, reason: "the container was killed (OOM / exit 137) and the worktree may hold persisted work — a blind retry would re-dispatch over it and could clobber it", advice: "inspect the worktree diff (`forge recover <id>`), verify/salvage the work, then `forge retry <id> --force` once safe (and consider a larger memory allowance or a smaller task if it was OOM)" },
  result_missing:       { retryable: true, reason: "no result was written; re-dispatch" },
  result_malformed:     { retryable: true, reason: "the result was unparseable; the agent may produce valid output on retry" },
  work_not_persisted:   { retryable: true, reason: "the agent's output never reached the host project mount; re-dispatch", advice: "ensure containers run with cwd = the /project bind mount (spawn.ts -w) so cwd-relative writes persist" },
  pre_container_crash:  { retryable: true, reason: "the forge process died before the agent container launched — no work exists to clobber; re-dispatch" },
  model_error:          { retryable: true, reason: "model/provider error; re-dispatch" },
  tool_error:           { retryable: true, reason: "a tool failed; re-dispatch" },
  cancelled:            { retryable: true, reason: "the task was cancelled; re-dispatch to resume the work" },
  unknown:              { retryable: true, reason: "cause unclear; re-dispatch (inspect logs if it recurs)" },

  auth_missing:         { retryable: true, reason: "auth was missing", advice: "ensure the auth profile / login is set up before retrying" },
  auth_expired:         { retryable: true, reason: "the auth session expired", advice: "refresh the session/profile before retrying" },
  auth_injection_failed:{ retryable: true, reason: "auth injection failed", advice: "verify the auth profile, then retry" },

  fanout_wave_orphaned: { retryable: false, reason: "this task is a fanout wave's parent; retrying it directly would mint a second, uncoordinated pending primary in the same phase, bypassing forge recover's re-drive coordination and audit trail", advice: "use `forge recover <parent> --re-drive` to re-drive the whole wave coherently, or pass --force to retry anyway" },
  orphaned_needs_finalize: { retryable: false, reason: "the container finished this pipeline step's work, but the host-side finalize (worktree merge → integration gate → reds) never ran — a blind retry would re-dispatch over the preserved result/worktree and could clobber it", advice: "inspect the preserved result and worktree diff (`forge show <id>`), then `forge retry <id> --force` to re-run the step through the real finalize path" },
  gate_rejected:        { retryable: false, reason: "a human rejected this at the gate; retry would re-run identical inputs", advice: "use `forge gate <task> request-changes` to send fix guidance, or address the rejection" },
  red_blocked:          { retryable: false, reason: "a red review blocked this; retry re-runs the same work unchanged", advice: "fix the finding (or override with `forge gate <task> advance --force`), then advance" },
  // FG-425 reversed the merge/validate order: the gate now runs against a
  // candidate built in a throwaway integration worktree, and a failing gate
  // publishes NOTHING. So none of these three advise touching the publish
  // target — there is no merge on it to undo. The pre-FG-425 advice here told
  // operators to `git reset --hard HEAD~1` in run.projectDir, which after this
  // change would discard whatever legitimately sits at the target's HEAD
  // (quite possibly an earlier, correctly-validated publication). Never advise
  // resetting the publish target.
  merge_conflict:       { retryable: true, reason: "the task's branch could not be merged into the candidate; nothing was published and the publish target is unchanged", advice: "the branch and its worktree are retained — rebase the task branch onto the current base and resolve the conflict, or retry to re-do the work against the current base" },
  // FG-621: capture is the step BEFORE any merge — Forge safety-commits the
  // private clone, fetches its branch into the parent's ref namespace, and
  // verifies the two agree. A failure there merged nothing and touched no
  // publish target, so the remediation is about the clone, never about a
  // conflict or a target. The clone is retained with the agent's work in it.
  capture_failed:       { retryable: false, reason: "forge could not capture the task's private clone into the parent repository (unreadable status, failed safety commit, rejected fetch, or a fetched ref that did not match the clone's tip). Nothing was merged and nothing was published — the work is still in the clone", advice: "inspect the retained clone named in the error (`forge show <id>`); once its state is resolved, `forge retry <id> --force` — a plain retry refuses, because a fresh attempt would refuse to reuse that workspace" },
  integration_failed:   { retryable: false, reason: "the candidate merged cleanly but build+test of the candidate failed; retry would re-dispatch against the same broken code. Nothing was published — the publish target was never modified", advice: "fix the break in code, then retry. Do NOT reset the publish target: it does not carry this merge" },
  integration_gate_timeout: { retryable: true, reason: "the integration gate run against the candidate timed out; a fresh attempt may complete. Nothing was published" },
  integration_gate_crashed: { retryable: false, reason: "the integration gate run against the candidate was killed unexpectedly (signal), not failed on its own merits; a tree's state after an abrupt kill is not trustworthy to blindly re-run. Nothing was published", advice: "inspect the host for a broken or half-updated toolchain/cache, resolve it, then retry — a retry validates a FRESH candidate worktree, so nothing has to be cleaned up in the publish target" },

  // FG-425 publication blockers. All four are terminal for THIS attempt and all
  // four published nothing: every target mutation happens under the publication
  // mutex behind a compare-and-swap, so a refused/parked attempt leaves the
  // target byte-for-byte where it started.
  dirty_publish_target: { retryable: false, reason: "the publish target's working tree is dirty (AD-3): it has uncommitted tracked changes, or untracked files the validated candidate would overwrite. Forge refused BEFORE any mutation and will never stash, reset, clean, or check out over operator-owned state — so a blind retry just re-runs the work and refuses again at the same place", advice: "in the publish target, commit or stash the tracked changes (and commit, move, or remove any untracked file the candidate would overwrite — `forge show <id>` names them), then `forge retry <id>`" },
  publish_base_churn:   { retryable: false, reason: "the publish target moved off the validated base twice (AD-1). Forge-owned attempts are FIFO-ordered and cannot move each other's base, so an EXTERNAL writer is pushing to the target mid-run; retrying into ongoing external write traffic just churns again. Nothing was published and the candidate worktrees are preserved as evidence", advice: "find the other writer (a person or a job pushing to the target) and quiesce it — do NOT respond by raising the rebuild bound — then `forge retry <id>`" },
  publication_refused:  { retryable: false, reason: "publication was refused at the compare-and-swap: the validated candidate did not descend from the base it was validated against (a non-fast-forward — the target's history was rewritten or moved under it), or its checkout could not be applied and the ref advance was rolled back. Nothing was published; the target is unchanged", advice: "inspect the target's history against the recorded {baseSha, candidateSha} on the attempt (`forge show <id>`) to find what moved or rewrote it, resolve that, then `forge retry <id>` — a retry captures a fresh base and re-validates against it" },
  lane_taken_over:      { retryable: true, reason: "this attempt's publication-lane lease lapsed and a later attempt claimed the lane (AD-2/AD-7). Terminal for this attempt only — nothing was published and nothing needs reaping", advice: "retry to enqueue a NEW publication attempt with a fresh candidate worktree" },

  verification_environment_unavailable: { retryable: true, reason: "dependency provisioning failed before the verification could run — the tests never got a verdict", advice: "check the project's dependency install (network, registry auth, lockfile) before retrying" },

  // FG-678 (AC3): the agent ran, wrote a well-formed result, and declared its own
  // work failed. NOT retryable by default: a blind re-dispatch re-runs identical
  // inputs against whatever the agent reported as the obstacle, which is the same
  // reasoning that makes gate_rejected and red_blocked non-retryable. The agent's
  // own stated reason is on the task's error, so the remediation starts there.
  agent_reported_failure: { retryable: false, reason: "the agent reported its own work as failed (result.json declared status: failed); a retry would re-dispatch identical inputs against the obstacle the agent named", advice: "read the agent's reported reason (`forge show <id>`) and address it — or pass --force to re-dispatch unchanged if the obstacle was transient" },
};

const NO_KIND: RetryDisposition = { retryable: true, reason: "no recorded failure kind; re-dispatch" };

/**
 * The retry disposition for a failure kind (undefined → no recorded kind).
 * When `taskId` is given, any `<id>` placeholder in the advice is replaced
 * with it so operator guidance (`forge retry <id> --force`, `forge show <id>`)
 * names the actual task instead of a literal placeholder.
 */
export function retryPolicy(failureKind: string | undefined, taskId?: string): RetryDisposition {
  const disposition = failureKind === undefined
    ? NO_KIND
    // The cast is the deliberate seam between the compile-time guarantee (POLICY
    // covers every kind this build knows) and the runtime one (a kind read off
    // an event written by another build may not be in it).
    : POLICY[failureKind as FailureKind] ?? { retryable: true, reason: `unrecognized failure kind '${failureKind}'; re-dispatch` };
  if (taskId === undefined || disposition.advice === undefined) return disposition;
  return { ...disposition, advice: disposition.advice.replaceAll("<id>", taskId) };
}
