// FG-823: the ONE accessor for attention_dismissals — the Attention Inbox's audited
// dismissals and snoozes. It owns the table's vocabulary (row states, the item-key shape,
// the snooze-until grammar); no caller writes a raw state string. Every write commits its
// events row in the same transaction, so a dismissal is auditable from the events table.
//
// A row is never deleted. It leaves `active` exactly once: `cleared` by an undismiss,
// `superseded` when the item's activity advanced past the dismissal, `expired` when a
// snooze's instant passed. WHETHER a row still holds is decided by the pure derivation
// (src/v2/attention-inbox.ts, applyDismissals) on every read; the persisted marking is the
// writer's job, because every reader of the inbox (the dashboard, `forge attention list`)
// is read-only.

import type { Database as DatabaseInstance } from "better-sqlite3";
import { randomBytes } from "node:crypto";
import { getDb, writeTransaction } from "./db.js";
import { logEvent } from "./events.js";

export const ATTENTION_DISMISSAL_STATES = ["active", "superseded", "expired", "cleared"] as const;
export type AttentionDismissalState = (typeof ATTENTION_DISMISSAL_STATES)[number];

/** The two ways a row stops holding on its own (never by an operator). */
export type AttentionDismissalLapse = Extract<AttentionDismissalState, "superseded" | "expired">;

/** An inbox item id as composeInbox emits it: a lowercase source prefix, a colon, then
 *  the source's own id. It cannot begin with `-`, carry whitespace or a control byte. */
const ITEM_KEY = /^[a-z][a-z_-]*:[^\s\u0000-\u001f\u007f]{1,256}$/;

export function isAttentionItemKey(value: unknown): value is string {
  return typeof value === "string" && ITEM_KEY.test(value);
}

/** The dashboard's preset snooze lengths; the CLI accepts any `<n>m|h|d|w` or an ISO instant. */
export const SNOOZE_PRESETS = ["1h", "4h", "1d"] as const;

const DURATION = /^([1-9][0-9]{0,3})(m|h|d|w)$/;
const UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
const MAX_SNOOZE_MS = 366 * 86_400_000;

/** `--until`: a duration from now (`90m`, `4h`, `1d`, `2w`) or an ISO-8601 instant, which
 *  must lie in the future and within a year. Returns the normalized ISO instant. */
export function parseSnoozeUntil(value: string, nowMs: number): { ok: true; until: string } | { ok: false; error: string } {
  const text = value.trim();
  const duration = text.match(DURATION);
  let ms: number;
  if (duration) {
    ms = nowMs + Number(duration[1]) * UNIT_MS[duration[2]!]!;
  } else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text) && Number.isFinite(Date.parse(text))) {
    ms = Date.parse(text);
  } else {
    return { ok: false, error: `--until must be a duration like 1h, 4h, 1d, 2w or an ISO-8601 instant (got ${JSON.stringify(value)})` };
  }
  if (ms <= nowMs) return { ok: false, error: `--until ${text} is not in the future` };
  if (ms - nowMs > MAX_SNOOZE_MS) return { ok: false, error: `--until ${text} is more than a year away` };
  return { ok: true, until: new Date(ms).toISOString() };
}

export type AttentionDismissal = {
  id: string;
  itemKey: string;
  kind: string;
  projectKey: string | null;
  runId: string | null;
  dismissedAt: string;
  /** Null for a dismissal; the re-arm instant for a snooze. */
  snoozeUntil: string | null;
  actor: string;
  rationale: string | null;
  state: AttentionDismissalState;
  settledAt: string | null;
  createdAt: string;
};

type Row = {
  id: string;
  item_key: string;
  kind: string;
  project_key: string | null;
  run_id: string | null;
  dismissed_at: string;
  snooze_until: string | null;
  actor: string;
  rationale: string | null;
  state: string;
  settled_at: string | null;
  created_at: string;
};

const COLUMNS = "id, item_key, kind, project_key, run_id, dismissed_at, snooze_until, actor, rationale, state, settled_at, created_at";

function fromRow(row: Row): AttentionDismissal {
  return {
    id: row.id,
    itemKey: row.item_key,
    kind: row.kind,
    projectKey: row.project_key,
    runId: row.run_id,
    dismissedAt: row.dismissed_at,
    snoozeUntil: row.snooze_until,
    actor: row.actor,
    rationale: row.rationale,
    state: row.state as AttentionDismissalState,
    settledAt: row.settled_at,
    createdAt: row.created_at,
  };
}

function hasTable(db: DatabaseInstance): boolean {
  return db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'attention_dismissals'`).get() !== undefined;
}

/** The rows still recorded `active` — the inbox derivation's input. A store opened
 *  read-only that predates the table has no dismissals, which is the truth, not a
 *  degraded read. */
export function activeAttentionDismissals(db: DatabaseInstance = getDb({ readOnly: true })): AttentionDismissal[] {
  if (!hasTable(db)) return [];
  const rows = db
    .prepare(`SELECT ${COLUMNS} FROM attention_dismissals WHERE state = 'active' ORDER BY dismissed_at ASC, id ASC`)
    .all() as Row[];
  return rows.map(fromRow);
}

/** Every row ever recorded for an item, oldest first — the audit trail. */
export function attentionDismissalHistory(itemKey: string): AttentionDismissal[] {
  const db = getDb({ readOnly: true });
  if (!hasTable(db)) return [];
  const rows = db
    .prepare(`SELECT ${COLUMNS} FROM attention_dismissals WHERE item_key = ? ORDER BY created_at ASC, id ASC`)
    .all(itemKey) as Row[];
  return rows.map(fromRow);
}

export class AttentionDismissalConflict extends Error {
  constructor(readonly existing: AttentionDismissal) {
    super(
      `${existing.itemKey} is already ${existing.snoozeUntil === null ? "dismissed" : `snoozed until ${existing.snoozeUntil}`} ` +
        `(by ${existing.actor} at ${existing.dismissedAt}); run \`forge attention undismiss ${existing.itemKey}\` first`,
    );
    this.name = "AttentionDismissalConflict";
  }
}

export type RecordDismissalInput = {
  itemKey: string;
  kind: string;
  projectKey: string | null;
  runId: string | null;
  actor: string;
  rationale: string | null;
  snoozeUntil: string | null;
  at: string;
};

/** Record a dismissal (snoozeUntil null) or a snooze, with its event. Refuses while the
 *  item already has an active row; the partial unique index is the backstop. `lapses` are
 *  the rows the caller's derivation found no longer holding — they are settled first, in
 *  the same transaction, so a resurfaced item can be dismissed again. */
export function recordAttentionDismissal(input: RecordDismissalInput, lapses: readonly DismissalLapse[] = []): AttentionDismissal {
  if (!isAttentionItemKey(input.itemKey)) throw new Error(`not an attention item key: ${JSON.stringify(input.itemKey)}`);
  return writeTransaction(() => {
    settle(lapses, input.at);
    const existing = getDb()
      .prepare(`SELECT ${COLUMNS} FROM attention_dismissals WHERE item_key = ? AND state = 'active'`)
      .get(input.itemKey) as Row | undefined;
    if (existing) throw new AttentionDismissalConflict(fromRow(existing));
    const row: AttentionDismissal = {
      id: `dismissal-${randomBytes(6).toString("hex")}`,
      itemKey: input.itemKey,
      kind: input.kind,
      projectKey: input.projectKey,
      runId: input.runId,
      dismissedAt: input.at,
      snoozeUntil: input.snoozeUntil,
      actor: input.actor,
      rationale: input.rationale,
      state: "active",
      settledAt: null,
      createdAt: input.at,
    };
    getDb()
      .prepare(`INSERT INTO attention_dismissals (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(row.id, row.itemKey, row.kind, row.projectKey, row.runId, row.dismissedAt, row.snoozeUntil, row.actor, row.rationale, row.state, row.settledAt, row.createdAt);
    logEvent(row.snoozeUntil === null ? "attention.dismissed" : "attention.snoozed", {
      runId: row.runId ?? undefined,
      payload: eventPayload(row),
    });
    return row;
  });
}

/** Undismiss: the item's active row becomes `cleared`. Null when there was none. */
export function clearAttentionDismissal(itemKey: string, actor: string, at: string): AttentionDismissal | null {
  return writeTransaction(() => {
    const existing = getDb()
      .prepare(`SELECT ${COLUMNS} FROM attention_dismissals WHERE item_key = ? AND state = 'active'`)
      .get(itemKey) as Row | undefined;
    if (!existing) return null;
    getDb().prepare(`UPDATE attention_dismissals SET state = 'cleared', settled_at = ? WHERE id = ? AND state = 'active'`).run(at, existing.id);
    const row: AttentionDismissal = { ...fromRow(existing), state: "cleared", settledAt: at };
    logEvent("attention.undismissed", { runId: row.runId ?? undefined, payload: { ...eventPayload(row), clearedBy: actor } });
    return row;
  });
}

export type DismissalLapse = { id: string; state: AttentionDismissalLapse };

/** Persist what the derivation decided: each lapsed row is marked (never deleted) with
 *  its event. Only a row still `active` moves, so a replay is a no-op. */
export function settleAttentionDismissals(lapses: readonly DismissalLapse[], at: string): number {
  if (lapses.length === 0) return 0;
  return writeTransaction(() => settle(lapses, at));
}

function settle(lapses: readonly DismissalLapse[], at: string): number {
  let moved = 0;
  for (const lapse of lapses) {
    const existing = getDb().prepare(`SELECT ${COLUMNS} FROM attention_dismissals WHERE id = ? AND state = 'active'`).get(lapse.id) as Row | undefined;
    if (!existing) continue;
    getDb().prepare(`UPDATE attention_dismissals SET state = ?, settled_at = ? WHERE id = ? AND state = 'active'`).run(lapse.state, at, lapse.id);
    const row: AttentionDismissal = { ...fromRow(existing), state: lapse.state, settledAt: at };
    logEvent(lapse.state === "superseded" ? "attention.dismissal_superseded" : "attention.snooze_expired", {
      runId: row.runId ?? undefined,
      payload: eventPayload(row),
    });
    moved += 1;
  }
  return moved;
}

function eventPayload(row: AttentionDismissal) {
  return {
    dismissalId: row.id,
    itemKey: row.itemKey,
    kind: row.kind,
    projectKey: row.projectKey,
    actor: row.actor,
    rationale: row.rationale,
    dismissedAt: row.dismissedAt,
    snoozeUntil: row.snoozeUntil,
    state: row.state,
  };
}
