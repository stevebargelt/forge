// FG-563 (BD-9, Slice 4): the durable lost-signal watchdog audit.
//
// The interactive orchestrator's happy path is completion-DRIVEN: a disposable
// waiter (`forge launch wait`) wakes the controller the moment a launch reaches a
// terminal disposition, and the controller claims + advances. `ScheduleWakeup` is
// demoted to a low-frequency HEALTH-bound watchdog (never sized from a guessed job
// duration — BD-9). Its ONLY job is to catch a LOST completion signal: a launch
// that reached a terminal disposition whose normal wake never arrived (the Monitor
// died silently, the session was swept, the event was dropped).
//
// When that watchdog discovers terminal-but-UNADVANCED work and recovers it, it
// must leave DURABLE evidence that the event path was missed — "did the signal get
// lost?" must have an answer that is not transcript archaeology (FG-563 AC). This
// module is that evidence.
//
// DISTINCT FROM continuation_stale_observations (BINDING — the plan's CP1
// correction). That table means "an observation arrived for a SUPERSEDED launch";
// this one means "the watchdog recovered a launch whose completion was lost." A
// stale observation is NOT a lost signal, and reusing that table would answer the
// wrong operator question. See schema.ts for the full contrast.
//
// THE WRITE RULE (FG-548): the single mutation takes its write lock immediately via
// writeTransaction. THE CLOCK RULE (FG-425): recovered_at is the store's own clock
// (storeNowMs), never a process clock.

import { getDb, writeTransaction } from "./db.js";
import { storeNowMs } from "./publications.js";
import type { ConsumerKind, ObservedStatus } from "./continuations.js";

// Recovered-by-watchdog is the only trigger that writes a row today (normal
// delivery advances WITHOUT one). It is recorded explicitly so an operator surface
// can distinguish recovery provenance without inferring it from the table's mere
// existence, and so a future recovery source (e.g. restart replay) can be added
// additively without a schema change. Enum-as-convention (FG-585): unconstrained
// TEXT in the store.
export type RecoveryTrigger = "watchdog";

export type LostSignalRecovery = {
  id: number;
  continuationId: string;
  sourceLaunchId: string;
  currentPhase: string;
  consumerKind: ConsumerKind;
  /** The claim owner that recovered the lost signal — WHICH controller. */
  controller: string;
  /** The canonical terminal LaunchStatus.state the watchdog re-derived (BD-3). */
  observedStatus: ObservedStatus;
  recoveryTrigger: RecoveryTrigger;
  dispatchKey?: string;
  dispatchedRunId?: string;
  dispatchedTaskId?: string;
  recoveredAt: string;
};

type LostSignalRow = {
  id: number;
  continuation_id: string;
  source_launch_id: string;
  current_phase: string;
  consumer_kind: string;
  controller: string;
  observed_status: string;
  recovery_trigger: string;
  dispatch_key: string | null;
  dispatched_run_id: string | null;
  dispatched_task_id: string | null;
  recovered_at: string;
};

function toRecovery(r: LostSignalRow): LostSignalRecovery {
  return {
    id: r.id,
    continuationId: r.continuation_id,
    sourceLaunchId: r.source_launch_id,
    currentPhase: r.current_phase,
    consumerKind: r.consumer_kind as ConsumerKind,
    controller: r.controller,
    observedStatus: r.observed_status as ObservedStatus,
    recoveryTrigger: r.recovery_trigger as RecoveryTrigger,
    ...(r.dispatch_key !== null ? { dispatchKey: r.dispatch_key } : {}),
    ...(r.dispatched_run_id !== null ? { dispatchedRunId: r.dispatched_run_id } : {}),
    ...(r.dispatched_task_id !== null ? { dispatchedTaskId: r.dispatched_task_id } : {}),
    recoveredAt: r.recovered_at,
  };
}

/**
 * Append one durable lost-signal recovery row. The consumer calls this EXACTLY
 * ONCE — after a WATCHDOG-triggered consume has WON the claim and advanced a
 * terminal-but-unadvanced continuation. It is never called on the normal delivery
 * path (which advances without a lost signal), never when the watchdog re-arms a
 * still-running launch, and never when the slot was already advanced (F18). The
 * caller owns that discipline; this function is a pure append.
 */
export function recordLostSignalRecovery(rec: {
  continuationId: string;
  sourceLaunchId: string;
  currentPhase: string;
  consumerKind: ConsumerKind;
  controller: string;
  observedStatus: ObservedStatus;
  recoveryTrigger?: RecoveryTrigger;
  dispatchKey?: string;
  dispatchedRunId?: string;
  dispatchedTaskId?: string;
}): LostSignalRecovery {
  return writeTransaction((): LostSignalRecovery => {
    const iso = new Date(storeNowMs()).toISOString();
    const trigger: RecoveryTrigger = rec.recoveryTrigger ?? "watchdog";
    const info = getDb()
      .prepare(
        `INSERT INTO continuation_lost_signal_recoveries
           (continuation_id, source_launch_id, current_phase, consumer_kind, controller,
            observed_status, recovery_trigger, dispatch_key, dispatched_run_id,
            dispatched_task_id, recovered_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        rec.continuationId,
        rec.sourceLaunchId,
        rec.currentPhase,
        rec.consumerKind,
        rec.controller,
        rec.observedStatus,
        trigger,
        rec.dispatchKey ?? null,
        rec.dispatchedRunId ?? null,
        rec.dispatchedTaskId ?? null,
        iso,
      );
    return {
      id: Number(info.lastInsertRowid),
      continuationId: rec.continuationId,
      sourceLaunchId: rec.sourceLaunchId,
      currentPhase: rec.currentPhase,
      consumerKind: rec.consumerKind,
      controller: rec.controller,
      observedStatus: rec.observedStatus,
      recoveryTrigger: trigger,
      ...(rec.dispatchKey !== undefined ? { dispatchKey: rec.dispatchKey } : {}),
      ...(rec.dispatchedRunId !== undefined ? { dispatchedRunId: rec.dispatchedRunId } : {}),
      ...(rec.dispatchedTaskId !== undefined ? { dispatchedTaskId: rec.dispatchedTaskId } : {}),
      recoveredAt: iso,
    };
  });
}

/** Every lost-signal recovery for one continuation, oldest-first. */
export function lostSignalRecoveriesFor(continuationId: string): LostSignalRecovery[] {
  const rows = getDb()
    .prepare(`SELECT * FROM continuation_lost_signal_recoveries WHERE continuation_id = ? ORDER BY id ASC`)
    .all(continuationId) as LostSignalRow[];
  return rows.map(toRecovery);
}

/** The operator surface: every lost-signal recovery, newest-first. Answers "which
 *  signals got lost, on which launch, recovered by which controller" without
 *  transcript archaeology. */
export function listLostSignalRecoveries(opts: { consumerKind?: ConsumerKind } = {}): LostSignalRecovery[] {
  const rows = opts.consumerKind
    ? (getDb()
        .prepare(`SELECT * FROM continuation_lost_signal_recoveries WHERE consumer_kind = ? ORDER BY id DESC`)
        .all(opts.consumerKind) as LostSignalRow[])
    : (getDb()
        .prepare(`SELECT * FROM continuation_lost_signal_recoveries ORDER BY id DESC`)
        .all() as LostSignalRow[]);
  return rows.map(toRecovery);
}
