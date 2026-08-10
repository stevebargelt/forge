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

  // ── FG-584 ordered fan-out. Nothing was dispatched for the first two and
  // nothing was published for either of the last two — every one of them is a
  // controller decision recorded before the target could be touched.
  plan_dependency_invalid: { retryable: false, reason: "the plan's declared work-item graph is not executable (an unknown `depends_on` reference, a self-dependency, a cycle, a duplicate declared id, or two concurrently-runnable items claiming the same path). No build child was minted and no container started — a retry re-reads the SAME plan and refuses at the same place", advice: "the refusal names the offending edge or path — send the plan back with `forge gate <plan task> request-changes` so the tech lead fixes the edges (or merges the two items that share a path), then re-run the build" },
  ordered_fanout_unavailable: { retryable: false, reason: "the plan declares dependency edges, but the ordered path cannot be honored in this configuration: with workspace isolation off there is no private workspace to integrate between items, so a dependent could only ever start from a base missing its prerequisite. Refused before any build child started", advice: "run with workspace isolation on (FORGE_WORKTREES=1, and unset FORGE_NO_WORKTREES) so ordered items can integrate through the candidate — or send the plan back and have the dependent steps collapsed into one item" },
  integration_blocked:  { retryable: false, reason: "an ordered worker's captured commit conflicts with the run's candidate (FG-584 AC8). The wave is PARKED: no downstream dependent was dispatched and nothing was published — the publish target is unchanged. Forge does not resolve merge conflicts, and a blind retry re-runs the work into the same conflict", advice: "the block names the conflicting worker, the candidate it was merged into, and the conflicting paths (`forge show <id>`). The worker's captured branch and the candidate are retained — rebase the worker's branch onto the candidate and resolve the conflict, then `forge retry <id> --force`" },
  prerequisite_blocked: { retryable: true, reason: "a prerequisite work item failed (or its integration was refused), so every transitive dependent was blocked and never dispatched. Independent ready work ran to completion first; nothing was published", advice: "the failure names the blocking item and each blocked dependent — fix the blocking item's cause and retry, or send the plan back if the dependency itself was wrong" },
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

// ── FG-688: which failure kinds an adopt-preserving re-drive may act on ──
//
// The ONE enumeration. `forge recover <parent> --re-drive`'s mutation guard and
// the recommendation `forge recover <parent>` PRINTS both read it, so the
// inspector cannot advise a verb the guard will reject — the defect this ticket
// exists to close, on both surfaces, from one list.
//
// THE DEFAULTS HERE AND IN retryPolicy ABOVE ARE DELIBERATELY OPPOSITE AND MUST
// NEVER BE SHARED. retryPolicy is an ADVISORY surface: it explains a failure to
// an operator who then decides, so an unrecognized kind defaults to
// `{ retryable: true }` (see the `??` above) — the worst case is imprecise
// prose. This is a MUTATION guard: saying yes reopens a settled task row and a
// settled run row. It has the opposite duty and FAILS CLOSED — an unrecognized
// string, or a kind read off an event written by a build this one does not know,
// is refused. That is the FG-425 lesson (a kind added by another build reaching
// operators through a permissive default), applied where the cost is a write
// rather than a sentence.
//
// Typed as Record<FailureKind, boolean>, NOT Record<string, boolean>: adding a
// kind to FailureKind without deciding this question is a COMPILE ERROR. There
// is no "sensible default" line to fall into; the decision is forced at the
// point the kind is authored.
export const RE_DRIVABLE_FAILURE_KINDS: Record<FailureKind, boolean> = {
  // ── Accepted ──
  // The unordered wave's stranded parent — today's only accepted kind, and the
  // behaviour it authorizes (mint one fresh pending primary) is unchanged.
  fanout_wave_orphaned: true,
  // FG-688's headline case. A prerequisite failed, so every transitive dependent
  // was blocked and never dispatched, while independent ready work ran to
  // completion and was captured and integrated. Re-driving adopts the integrated
  // items and dispatches only what never ran. Note a mid-wave gate that fails ON
  // THE MERITS also lands here, not on integration_failed: the gated ref simply
  // does not advance, its dependents block, and runNext.ts:2771-2779 stamps this
  // kind unconditionally of failure_mode.
  prerequisite_blocked: true,
  // The three mid-wave arms where the ordered wave itself reached NO VERDICT on
  // the code (runNext.ts:2740-2749). Nothing was said about the work items — so
  // re-running the gate over the already-adopted candidate is the correct
  // forward move, not a re-run of the items.
  integration_gate_timeout: true,
  integration_gate_crashed: true,
  verification_environment_unavailable: true,
  // A typed PARK, not a verdict: the captured work is integrated and retained
  // and no dependent was dispatched. Once a human has rebased the conflicting
  // worker onto the candidate, the adopt-preserving re-drive IS the resume. If
  // the conflict still stands, the wave simply parks again with nothing lost —
  // which is what makes accepting this cheap rather than risky.
  integration_blocked: true,

  // ── Refused ──
  // A re-drive re-reads the SAME plan and the SAME isolation config and refuses
  // at exactly the same place; the plan or the setting has to change first.
  plan_dependency_invalid: false,
  ordered_fanout_unavailable: false,
  // An end-of-phase verdict on the MERGED code. A re-drive adopts everything,
  // re-gates the same tree, and fails identically — fix the break, then retry.
  integration_failed: false,
  // A human's decision. Authoritatively terminal (AWN-2): no recovery verb ever
  // resurrects it.
  cancelled: false,

  // Everything else. These are per-TASK failures with their own remediation
  // (retryPolicy above), not wave-level stops an adopt-preserving re-drive has
  // anything to say about.
  orphaned: false,
  orphaned_work_may_persist: false,
  oom_killed: false,
  orphaned_needs_finalize: false,
  container_crash: false,
  idle_timeout: false,
  result_missing: false,
  result_malformed: false,
  work_not_persisted: false,
  merge_conflict: false,
  capture_failed: false,
  publish_base_churn: false,
  dirty_publish_target: false,
  publication_refused: false,
  lane_taken_over: false,
  auth_missing: false,
  auth_expired: false,
  auth_injection_failed: false,
  model_error: false,
  tool_error: false,
  red_blocked: false,
  gate_rejected: false,
  agent_reported_failure: false,
  pre_container_crash: false,
  unknown: false,
};

/**
 * FG-688: may an adopt-preserving re-drive act on this failure kind?
 *
 * Fails CLOSED, deliberately unlike `retryPolicy` above: `undefined` (no
 * recorded kind) and any string this build does not recognize both return
 * false. Consulted by BOTH the `--re-drive` mutation guard and the recommendation
 * `forge recover` prints, so the two can never disagree.
 */
export function isReDrivableFailureKind(kind: string | undefined): boolean {
  if (kind === undefined) return false;
  // Same cast seam as retryPolicy's, with the opposite default: a kind read off
  // an event written by another build is absent from the map and refused.
  return RE_DRIVABLE_FAILURE_KINDS[kind as FailureKind] === true;
}
