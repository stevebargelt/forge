import { getDb } from "./db.js";
import { nowIso } from "../util/ids.js";

export type EventType =
  | "run.created"
  | "run.completed"
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
  | "task.progress"
  | "task.artifact"
  | "task.decision"
  | "verdict.received"
  | "verdict.findings_dropped"
  | "gate.decided"
  | "container.started"
  | "container.exited"
  | "container.killed"
  | "container.idle_timeout"
  | "container.dependency_provisioning_failed"
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
  | "campaign_item.host_gate_started"
  | "campaign_item.host_gate_finished";

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
