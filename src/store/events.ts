import { getDb } from "./db.js";
import { nowIso } from "../util/ids.js";

export type EventType =
  | "run.created"
  | "run.completed"
  | "run.failed"
  | "run.reactivated"
  | "run.reconciled"
  | "run.cancelled"
  | "run.abandoned"
  | "task.created"
  | "task.started"
  | "task.completed"
  | "task.failed"
  | "task.cancelled"
  | "task.blocked_by_red"
  | "task.awaiting_red"
  | "task.awaiting_gate"
  // FG-425 (AC5): the task's publication attempt lost the publication window with
  // its ref advance already on the target. Non-terminal — no claim is made about
  // what landed until AD-5 convergence settles the attempt.
  | "task.awaiting_recovery"
  // FG-425 (AC5): AD-5 convergence settled that attempt, and this task was moved
  // onto the truth it recorded (complete when the candidate landed; failed with the
  // converged kind when it did not).
  | "task.publication_reconciled"
  // FG-425: the task was CANCELLED and its publication attempt nevertheless converged
  // to `published` — the candidate is on the target. The cancel is terminal and stands
  // (recovery never resurrects it, so no task.publication_reconciled is written), which
  // is exactly why this exists: it is the durable record that the target carries work
  // from a task the operator stopped. Emitted once, on the first reconciliation pass
  // that sees the pair — never once per wave.
  | "task.published_after_cancel"
  | "task.retried"
  | "task.reconciled"
  // FG-540: a missing result.json was recovered as the exact structured JSON
  // object from the runtime's cleanly-completed stream (codex-jsonl terminal
  // agent_message). Emitted by EVERY consumer that adopts a stream-recovered
  // structured result — dispatch (invoke.ts / runNext.ts, payload.source
  // "invoke"/"workflow"), `forge recover --continue` (adoptedFrom
  // "stream_recovered"), and reconcile (payload.source "reconcile" /
  // "reconcile_pipeline_unfinalized" / "reconcile_backfill") — so structured
  // recovery is always distinguishable from FG-337 narrative synthesis, which
  // never emits this event.
  | "task.result_recovered_from_stream"
  // FG-356: reconcile's orphan workspace reaper disposed of a terminal task's
  // workspace and branch after proving the work in it was captured — the sweep
  // for a tree whose own dispatch-path cleanup died with its forge process.
  | "task.workspace_reaped"
  // FG-356: the same pass REFUSED to dispose of one, and this is the durable
  // record of where that work still lives: the workspace path, the branch, the
  // substrate, and why (uncommitted work, unmerged commits, a retain-by-design
  // failure kind such as merge_conflict, or FG-621's not-yet-implemented private
  // clone substrate). Emitted once per (task, reason).
  | "task.workspace_retained"
  // FG-621: the same pass POSTPONED the decision — the parent repository is
  // repacking, and a private clone's alternates point into the very object store
  // being rewritten, so disposal waits for the next pass rather than racing it.
  // Not a disposition: the workspace is neither reaped nor retained, and a later
  // pass still has to settle it. Emitted once per (task, reason), so a deferral
  // that persists is visible instead of silent while a resolved one stays quiet.
  | "task.workspace_reap_deferred"
  | "task.progress"
  | "task.artifact"
  | "task.decision"
  | "verdict.received"
  | "verdict.findings_dropped"
  // FG-628: a dispatched red returned no valid review, so forge synthesized the
  // recorded `inconclusive` — it is the ABSENCE of a review rather than a reviewer
  // that could not decide. Blocks the gate orthogonally to the red's authority: an
  // incomplete panel is incomplete regardless of the missing member's rank.
  // Payload carries `failureKind` and `containerStarted` as diagnostics only.
  | "verdict.review_missing"
  | "gate.decided"
  | "container.started"
  | "container.exited"
  | "container.killed"
  | "container.idle_timeout"
  | "container.dependency_provisioning_failed"
  // FG-664 AC3's LEDGER half, and the SUCCESS counterpart to the refusal above:
  // a read-only dispatch's dependency environment resolved, and this is which
  // engine it resolved to. The manifest carries the whole receipt, but a manifest
  // is a file beside one dispatch — an auditor asking "which engine did this
  // verification actually run against" reads the timeline, and before this event
  // the successful case (the one an audit checks) left no trace there at all.
  // Payload: { stage: "environment_resolution", cacheKey, probeImage, nodeVersion,
  // abi, packages: [{ name, version, loaded }] }. Built by naming fields rather
  // than by spreading the receipt, so no host path can reach the timeline — see
  // dependencyEnvironmentResolvedPayload.
  | "container.dependency_environment_resolved"
  // FG-628: the dependency-volume mountpoints could not be created in the tree
  // about to be bound at the container's project path (a read-only or
  // permission-denied checkout). The cache is left unmounted rather than mounted
  // into a tree docker cannot bind it in — the same "cache isn't ready" posture,
  // never a block.
  | "container.dependency_mountpoints_unavailable"
  // FG-559: the entrypoint's git probe found git unusable in the project mount
  // (a linked worktree whose parent .git never made it into the container) and
  // exited before the agent ran.
  | "container.git_unavailable"
  // FG-503: finalizeContainerRetention(..., true) attempted a reap on a
  // successful task and `docker rm -f -v` errored — the container (and its
  // anonymous DEC-019 shadow volume) is left behind, unrecorded and
  // unsweepable until this event exists to key `forge ops reap-containers`'
  // completed-task scan off of. Never emitted on the reaped/retained
  // outcomes — those stay silent, exactly as before FG-503.
  | "container.reap_failed"
  // FG-504: the resolution counterpart to container.reap_failed — recorded
  // ONLY by `forge ops reap-containers` (the sweeper) when a candidate is
  // confirmed gone (rm succeeded, or it was already not_found). detect.ts
  // treats any container.reap_failed as superseded once a LATER container.reaped
  // exists for the same task, clearing the container_reap_failed incident.
  // Happy-path task-completion reaps never emit this (FG-503 AC4 still holds).
  | "container.reaped"
  // FG-437: durable phase-boundary markers around the (separate, short-lived)
  // dependency provisioner container, so a mid-provision crash is visible to
  // reconcile even though the task's own container.started hasn't fired yet.
  | "container.provision_started"
  | "container.provision_succeeded"
  | "auth.profile_applied"
  | "auth.profile_failed"
  // AWN-7 model resolution (policy mode). profile_resolved: a task resolved to a
  // profile/model. profile_unavailable: fail-loud — resolved auth has no working
  // credentials. fallback_applied: a same-capability lower-cost substitution was
  // made (vocabulary reserved for Walk/Run; not emitted in Crawl).
  | "model.profile_resolved"
  | "model.profile_unavailable"
  | "model.fallback_applied"
  // #202/#203: an orchestrator-declared checkpoint (forge notify milestone). The
  // orchestrator owns *meaning*; forge owns delivery/dedupe/policy. Always
  // recorded (audit trail) regardless of whether a push was sent.
  | "orchestrator.milestone"
  // FG-353: worktree integration git mutation events for forge show / dashboard.
  | "integration.worktree_created"
  | "integration.child_merged"
  // Retained: no longer emitted (FG-425 replaced it with integration.published),
  // but historical rows in existing DBs still carry it and must keep rendering.
  | "integration.merged_to_head"
  // FG-425: publication of a validated candidate to the project's target ref,
  // through the serialized integration publisher. Replaces the FG-353
  // "integration.merged_to_head" event, which recorded a merge that landed on the
  // target BEFORE it was validated — the defect FG-425 removes. The payload
  // carries the durable {target, baseSha, candidateSha, publishedSha} record.
  | "integration.published"
  // ── FG-584: the ordered fan-out's durable record. These four exist because
  // readiness must be recomputable by ANY process, before and after a crash — an
  // in-memory accumulator owned by one dispatchFanoutStep invocation cannot be
  // read by the process that resumes the wave.
  //
  // The candidate passed (or failed) the D1 integration gate for the named work
  // items. `ok: true` is HALF THE READINESS PREDICATE — a dependent is released
  // only when its prerequisite's commit is an ancestor of the candidate AND that
  // candidate is named here. `ok: false` is recorded too and never counts as
  // satisfaction: it is the evidence a blocked dependent is named from.
  | "integration.prerequisites_gated"
  // An ordered worker's captured commit conflicted with the candidate (AC8/D2).
  // The typed block: the conflicting worker, the candidate, and the conflicting
  // paths. No dependent dispatches and nothing publishes while it stands.
  | "integration.blocked"
  // A work item never dispatched because a prerequisite failed or its integration
  // was refused (AC7/D3), naming what blocked it.
  | "fanout.item_blocked"
  // A resumed wave found this item's work already complete AND already captured,
  // and did NOT re-dispatch it (AC9: recovery duplicates no completed work).
  | "fanout.item_adopted"
  // The publisher's own lifecycle, per attempt. requested: intent recorded (AD-5),
  // before any target mutation. base_moved: the CAS found the target off its
  // validated base — one rebuild follows (AD-1). parked: a named blocker
  // (publish_base_churn | dirty_publish_target), evidence preserved.
  | "publication.requested"
  | "publication.merge_failed"
  | "publication.validation_failed"
  | "publication.base_moved"
  | "publication.published"
  | "publication.refused"
  | "publication.parked"
  // FG-425 (AC5): the publisher's ref advance LANDED and it then lost the
  // publication window. NOT a refusal — the target carries the candidate, and the
  // attempt stays `publishing` until AD-5 convergence settles it. Recorded instead
  // of publication.refused, which claimed the opposite of what happened.
  | "publication.window_lost"
  // FG-425 (AC5): the window did not come free within the convergence bound, so the
  // attempt's disposition is still unsettled. No terminal claim is made about it.
  | "publication.recovery_pending"
  // FG-425 (AC5): the publisher was asked to publish a task whose work is ALREADY on
  // the target (an attempt recorded `published`). It republished nothing.
  | "publication.already_published"
  // AD-5 recovery converged an attempt left in the non-terminal `publishing`
  // state (a crash inside the publication window). Emitted by the run-path sweep
  // AND by `forge publish recover` — a defined recovery nothing invokes is not a
  // defined recovery.
  | "publication.recovered"
  // FG-428: operator-triggered `campaign reconcile` shipped a wedged item after
  // re-deriving its outcome from durable evidence. Distinct from run.reconciled /
  // task.reconciled (crash-recovery) — this is a trust-gate write, not a crash repair.
  | "campaign_item.evidence_reconciled"
  // FG-443: operator-triggered `campaign reconcile` shipped an awaiting_gate item
  // that was delivered outside the feature pipeline (re-routed lane), after
  // re-deriving delivery from durable evidence. Distinct from
  // campaign_item.evidence_reconciled — that event covers the scope-blocked
  // stale-red-fail shape; this one covers the non-pipeline/awaiting_gate shape.
  | "campaign_item.out_of_band_reconciled"
  // FG-502: operator-triggered `campaign reconcile` shipped an item that one of
  // executor.ts's campaign-system producers (run non-complete salvage, done-audit
  // gap after a passing verdict, or the unresolved-outcome fallback) had parked at
  // failed/blockerKind='campaign_system', after proving out-of-band delivery via
  // the SAME evidence bar as campaign_item.out_of_band_reconciled (ticket done +
  // closed commit reachable + lane evidence + no unresolved authoritative
  // objection). Distinct event kind so the audit trail can tell "delivered
  // out-of-band via a re-routed lane" apart from "recovered from a campaign-system
  // salvage/gap/fallback failure that turned out to be already-shipped."
  | "campaign_item.campaign_system_reconciled"
  // FG-511: `forge campaign retry` reset a failed/blockerKind='campaign_system'
  // item back to pending after proving, from the underlying run's durable task
  // evidence, that EVERY failed primary task classified transient (auth or
  // infrastructure). Distinct from campaign_item.campaign_system_reconciled —
  // that event ships an item whose work turned out to be already delivered; this
  // one re-drives an item whose run was abandoned by a transient blip and never
  // finished. Payload: { campaignId, itemId, ticketId, runId, evidence:
  // [{ taskId, failureKind, classified }], decidedAt }.
  | "campaign_item.campaign_system_retried"
  // FG-441 red-review fix: `campaign resume`'s manually-driven awaiting_gate
  // reconcile branch found evidence incomplete and refused to ship, re-parking
  // the item. Durable counterpart to the console.error refusal message — under
  // a cron/service invocation stderr may not be captured, so this is the only
  // audit trail of the refusal decision.
  | "campaign_item.evidence_reconcile_refused"
  // FG-490 (review F7): the drive path (runNext/startRun) threw instead of
  // returning a structured failure. Durable record of the thrown error, taken
  // BEFORE the campaign is parked to 'paused' and the error is rethrown to the
  // caller — the only audit trail of the raw error under a cron/service
  // invocation where stderr may not be captured.
  | "campaign_item.drive_error"
  // FG-487: durable phase-boundary markers around host-side verification work
  // that previously had no dashboard trace — `forge review-loop`'s per-round
  // verification (the FG-501 CI-wait poll, or the local typecheck+test
  // fallback) and `forge campaign reconcile`'s real host-gate execs (a covering-
  // evidence REUSE never emits these — only an actual exec does). Every
  // start/finish pair carries a shared `attemptId` (see util/ids.ts's
  // newAttemptId) so a crashed-and-restarted round/gate at the same
  // round/ticket/sha identity can never be mispaired with the wrong finish.
  | "review_loop.verification_started"
  | "review_loop.verification_finished"
  // FG-513: the loop's reviewer hit a provider/model infrastructure failure
  // (failure_kind=model_error) and was retried once, same round, on the
  // fallback profile — payload carries {ticketId, round, failedProfile?,
  // retryProfile?, cause}. Emitted whether or not the retry then succeeded.
  | "review_loop.reviewer_model_error_retry"
  // FG-679: what the ONE Forge-owned CI observer actually saw at the exact
  // candidate sha it probed — one event per poll iteration plus one at round
  // resolution, so a reader can tell a fresh observation from a stale one
  // without probing anything itself. Payload (Contract B, pinned by the FG-679
  // plan and consumed verbatim by the dashboard's current-activity reader):
  //   {attemptId, ticketId, projectDir, candidateSha, observedAt, outcome,
  //    unavailableReason, contexts: [{context, state, url, observedAt}]}
  // `candidateSha` is DECLARED by the observer and is always the full sha it
  // probed — no reader derives the candidate, which is what makes an
  // advanced-candidate observation simply stop being the newest (BD-6).
  | "review_loop.ci_observed"
  // FG-566: the SHARED readiness contract for Forge-owned host-side verification
  // (src/v2/host-readiness.ts), emitted by BOTH consumers — the review loop's
  // local fallback and the FG-357/FG-425 integration gate — so a preparation is
  // always distinguishable from the verification it precedes.
  //   ready:   {workspace, treeSha, lockfileDigest, nodeVersion, abi, setupCommand, reused, coveredCommandSet, label}
  //   refused: {reason, workspace, command, exitStatus, stderrTail, label, treeSha}
  // `not_required` is deliberately silent: nothing was established and nothing was
  // touched — it is carried on review_loop.verification_finished's `readiness`
  // field instead of manufacturing an event for a no-op.
  | "host_readiness.ready"
  | "host_readiness.refused"
  // FG-566: the publication-side projection — preparation refused for a
  // publication candidate, so the gate never ran. NOT publication.validation_failed
  // (which would be a code verdict for an environment fault) and NOT
  // integration_failed: nothing was published and no ref moved.
  | "publication.readiness_failed"
  | "campaign_item.host_gate_started"
  | "campaign_item.host_gate_finished"
  // FG-608 (N1): the dispatch path could not write this task's backlog authority
  // marker into the mount source. prepareBacklogSnapshotMount NEVER throws, so the
  // dispatch proceeds with no authority asserted — this is the only durable record
  // that it did. Payload: { taskId, hostDir, mode, projectKey, error }.
  | "container.backlog_authority_marker_failed"
  // FG-666: the dispatch path could not RESOLVE this task's backlog authority — a
  // project_key was declared and the cross-repository guard would not honour it. The
  // dispatch proceeds with an `unknown` marker exactly as before; this is what makes
  // the degradation visible to the operator instead of only to the agent whose reads
  // then refuse. A project declaring NO project_key resolves markdown and never emits
  // this. Payload: { taskId, projectDir, error }.
  | "container.backlog_authority_unresolved"
  // FG-638: the review ledger's append-only audit half. The `reviews` /
  // `review_findings` rows carry CURRENT state; these carry how it got there.
  // review.state_changed is emitted on EVERY lifecycle transition (payload
  // {reviewId, from, to, reason, at}) — a row alone cannot say when a review
  // entered awaiting_disposition or who moved it.
  | "review.created"
  | "review.state_changed"
  // Payload names the Forge-assigned id AND the id the model supplied (or null),
  // so "the reviewer called it CVE-1, forge calls it RF-3" stays auditable.
  | "review.finding_ingested"
  // Payload carries disposition, decidedBy (operator | orchestrator), the candidate
  // sha it was decided against, rationale, evidence, and any canonical/followup
  // linkage — the durable record behind the authority rules.
  | "review.finding_dispositioned"
  // FG-639 (Change 2): the coordinator's own audit half.
  // review.stage_completed names the stage AND the sha it completed against — the durable
  // answer to "what has this review already done", which is what makes resuming after a
  // crash a read rather than a guess.
  | "review.stage_completed"
  // FG-640 (Change 3): which risk lenses the plan-gate-approved contract selected, and which
  // declared reds it therefore did NOT dispatch. Recorded because a narrower panel is a
  // decision — an operator reading a run with three reds where the workflow declares six must
  // be able to see that it was selection rather than three reds failing to start.
  | "review.lenses_selected"
  // FG-640: a review_contract that selection REFUSED to read, because it came from a task
  // that is not the reviewed step's declared plan step. Recorded rather than dropped: a
  // contract written by another human-gated step is an attempt to select someone else's
  // panel, and the wide panel it fell back to should be readable as a refusal.
  | "review.contract_ignored"
  // What a recheck ESTABLISHED for one finding, per id: resolved | still_present |
  // inconclusive, the evidence kind, and the sha it was proven at. A resolution is
  // candidate-bound; the event says which candidate.
  | "review.finding_resolution_recorded"
  // The candidate moved, so resolutions proven at the old sha stopped being evidence about
  // the new one. Payload names every finding whose resolution was cleared and why.
  | "review.resolutions_invalidated"
  // PRD Appendix A: the FixBatch lifecycle. created carries the revision, the candidate,
  // the superseded batch and the payload hash; dispatched pairs the batch with the task
  // that consumed it; ingested records the per-finding results and whether the ingest was
  // a repeat (delivery is at-least-once, application is idempotent).
  | "review.fix_batch_created"
  | "review.fix_batch_dispatched"
  | "review.fix_batch_ingested"
  // FG-640: the third route by which an absent lens clears. The payload NAMES the missing
  // evidence, the lens it attaches to, and the candidate it was accepted against — an
  // acceptance is a decision about one candidate's missing review, never a standing waiver.
  | "review.lens_accepted";

export type Event = {
  id: number;
  runId: string | null;
  taskId: string | null;
  eventType: EventType;
  payload: unknown;
  createdAt: string;
};

type EventRow = {
  id: number;
  run_id: string | null;
  task_id: string | null;
  event_type: string;
  payload: string | null;
  created_at: string;
};

function rowToEvent(row: EventRow): Event {
  return {
    id: row.id,
    runId: row.run_id,
    taskId: row.task_id,
    eventType: row.event_type as EventType,
    payload: row.payload !== null ? (JSON.parse(row.payload) as unknown) : null,
    createdAt: row.created_at,
  };
}

export function eventsForTask(taskId: string): Event[] {
  const rows = getDb({ readOnly: true })
    .prepare(`SELECT * FROM events WHERE task_id = ? ORDER BY created_at ASC, id ASC`)
    .all(taskId) as EventRow[];
  return rows.map(rowToEvent);
}

export function eventsForRun(runId: string): Event[] {
  const rows = getDb({ readOnly: true })
    .prepare(`SELECT * FROM events WHERE run_id = ? ORDER BY created_at ASC, id ASC`)
    .all(runId) as EventRow[];
  return rows.map(rowToEvent);
}

// FG-516: does ANY recorded orchestrator.milestone event across the WHOLE events
// store carry this dedupeKey with dispatched=true? The campaign-pause dedupe key
// is campaign+item-stable, but `forge campaign retry` clears the item's runId so a
// re-park lands on a NEW run — a run-scoped scan (eventsForRun) would miss the
// prior push and re-notify. This scan is run-agnostic so the suppression holds
// across runs. There is NO index on json_extract(payload, '$.dedupeKey') — only
// idx_events_type_created (event_type, created_at) exists — so this narrows to
// orchestrator.milestone rows via that index and then scans their payloads for the
// dedupeKey match. Cost is bounded by the count of milestone events (a small,
// slow-growing slice: one per dispatched pause), not the whole events table, so the
// scan is acceptable at expected volumes. The dispatched check parses the payload
// exactly like rowToEvent, keeping the semantics identical to the run-scoped dedupe
// in emitMilestone.
export function anyDispatchedMilestoneWithDedupeKey(dedupeKey: string): boolean {
  const rows = getDb({ readOnly: true })
    .prepare(
      `SELECT payload FROM events
       WHERE event_type = 'orchestrator.milestone'
         AND json_extract(payload, '$.dedupeKey') = ?`
    )
    .all(dedupeKey) as { payload: string | null }[];
  return rows.some((r) => {
    if (r.payload === null) return false;
    const p = JSON.parse(r.payload) as { dispatched?: boolean };
    return p.dispatched === true;
  });
}

export function logEvent(
  eventType: EventType,
  opts: { runId?: string; taskId?: string; payload?: unknown } = {}
): void {
  getDb()
    .prepare(
      `INSERT INTO events (run_id, task_id, event_type, payload, created_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(
      opts.runId ?? null,
      opts.taskId ?? null,
      eventType,
      opts.payload ? JSON.stringify(opts.payload) : null,
      nowIso()
    );
}
