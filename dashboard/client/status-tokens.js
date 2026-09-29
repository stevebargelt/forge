// FG-824: the ONE status vocabulary of the dashboard client. Every badge, row accent, chart
// colour and log marker that renders a store status reads its label, tone and class here,
// keyed by the store's closed vocabularies:
//
//   task    — tasks.status (TASK_STATUSES, src/types/index.ts)
//   run     — runs.status (RUN_STATUSES)
//   inbox   — attention item kinds (ATTENTION_ITEM_KINDS, src/v2/attention-inbox.ts)
//   launch  — launch outcomes (LAUNCH_STATES, src/v2/launch.ts), plus the `unobserved`
//             observation marker a stale launch reads as
//   claim   — queue claim states (QUEUE_CLAIM_STATES, src/store/queue-claims.ts)
//   receipt — the orchestrator liveness presentation (ORCHESTRATOR_PRESENTATIONS)
//   ticket  — backlog ticket status
//   marker  — the two annotations that are not store states but borrow a status badge
//
// A value no vocabulary knows renders the vocabulary's neutral fallback, labeled with the
// raw value AND the word "unrecognized": never blank, never a raw string passing as a
// known status. dashboard/src/fg824-status-tokens.test.ts fails when a store member lacks
// a token here, and when any other client module spells a status class itself.

export const TONES = Object.freeze(["ok", "err", "warn", "info", "magenta", "neutral"]);

const t = (label, tone, cls) => Object.freeze({ label, tone, class: cls });

const VOCABULARIES = {
  task: {
    pending: t("pending", "neutral", "status-pending"),
    running: t("running", "info", "status-running"),
    awaiting_gate: t("awaiting gate", "warn", "status-awaiting_gate"),
    awaiting_red: t("awaiting red", "info", "status-awaiting_red"),
    complete: t("complete", "ok", "status-complete"),
    failed: t("failed", "err", "status-failed"),
    blocked_by_red: t("blocked by red", "err", "status-blocked_by_red"),
    awaiting_recovery: t("awaiting recovery", "warn", "status-awaiting_recovery"),
  },
  run: {
    active: t("active", "info", "run-status-active"),
    complete: t("complete", "ok", "run-status-complete"),
    failed: t("failed", "err", "run-status-failed"),
    abandoned: t("abandoned", "neutral", "run-status-abandoned"),
  },
  inbox: {
    waiting_gate: t("Waiting on gate", "warn", "inbox-kind-waiting_gate"),
    campaign_paused: t("Campaign paused", "warn", "inbox-kind-campaign_paused"),
    blocked_by_red_or_reviewer: t("Blocked by review", "err", "inbox-kind-blocked_by_red_or_reviewer"),
    missing_acceptance_or_readiness: t("Readiness gap", "info", "inbox-kind-missing_acceptance_or_readiness"),
    auth_setup: t("Auth / setup", "err", "inbox-kind-auth_setup"),
    merge_conflict: t("Merge conflict", "err", "inbox-kind-merge_conflict"),
    integration_blocked_park: t("Integration parked", "err", "inbox-kind-integration_blocked_park"),
    stale_verification: t("Stale verification", "warn", "inbox-kind-stale_verification"),
    kanban_conflict: t("Kanban conflict", "magenta", "inbox-kind-kanban_conflict"),
  },
  // Deliberately no class here is named `failed` (BD-4): the terminal-ish launch outcomes
  // are four different facts, not one failure.
  launch: {
    running: t("running", "info", "launch-state-running"),
    exited_ok: t("exited ok", "ok", "launch-state-exited_ok"),
    exited_error: t("exited with error", "err", "launch-state-exited_error"),
    signaled: t("signaled", "magenta", "launch-state-signaled"),
    terminated_unattributed: t("terminated, unattributed", "warn", "launch-state-terminated_unattributed"),
    owner_gone: t("owner gone", "warn", "launch-state-owner_gone"),
    unknown: t("unknown", "neutral", "launch-state-unknown"),
    unobserved: t("unobserved", "neutral", "launch-state-unobserved"),
  },
  claim: {
    live: t("claimed", "magenta", "claim-state-live"),
    released: t("released", "neutral", "claim-state-released"),
  },
  // Its own vocabulary, not a task status: it borrows the badge whose colour already
  // means the same thing rather than inventing a status value.
  receipt: {
    running: t("running", "info", "status-running"),
    orphaned: t("orphaned", "warn", "launch-state-owner_gone"),
    unverified: t("unverified", "neutral", "launch-state-unknown"),
    pending: t("pending", "neutral", "status-pending"),
    exited: t("exited", "ok", "launch-state-exited_ok"),
    spawn_failed: t("spawn failed", "err", "status-failed"),
    unrecognized: t("unrecognized", "neutral", "launch-state-unknown"),
  },
  // Ticket status is not a run-state vocabulary; it borrows the task badge whose colour
  // means the same thing.
  ticket: {
    active: t("active", "ok", "status-complete"),
    blocked: t("blocked", "err", "status-failed"),
    deferred: t("deferred", "neutral", "status-pending"),
    done: t("done", "neutral", "status-pending"),
  },
  marker: {
    reconcile_candidate: t("reconcile candidate", "warn", "status-reconcile_candidate"),
    environment_unavailable: t("environment unavailable", "warn", "status-environment_unavailable"),
  },
};

const FALLBACK_CLASS = {
  task: "status-unknown",
  run: "run-status-unknown",
  inbox: "inbox-kind-unknown",
  launch: "launch-state-unknown",
  claim: "claim-state-unknown",
  receipt: "launch-state-unknown",
  ticket: "status-pending",
  marker: "status-unknown",
};

export const VOCABULARY_NAMES = Object.freeze(Object.keys(VOCABULARIES));

/** The known values of one vocabulary, in declaration order. */
export function vocabularyValues(vocab) {
  return Object.keys(VOCABULARIES[vocab] ?? {});
}

/** The label an unrecognized value reads as: the raw value, qualified, so a newer
 *  server's value stays intelligible without passing as a status this client knows. */
export function unrecognizedLabel(value) {
  return typeof value === "string" && value !== "" ? `${value} (unrecognized)` : "unknown";
}

/** `{label, tone, class, known}` for a value of a vocabulary. Never throws, never blank. */
export function statusToken(vocab, value) {
  const table = VOCABULARIES[vocab];
  const hit = table && typeof value === "string" && Object.hasOwn(table, value) ? table[value] : null;
  if (hit) return { ...hit, known: true };
  return { label: unrecognizedLabel(value), tone: "neutral", class: FALLBACK_CLASS[vocab] ?? "status-unknown", known: false };
}

export function statusClass(vocab, value) {
  return statusToken(vocab, value).class;
}

export function statusLabel(vocab, value) {
  return statusToken(vocab, value).label;
}

/** The whole `badge …` class string for a status badge. */
export function badgeClass(vocab, value) {
  return `badge ${statusClass(vocab, value)}`;
}

/** The run map's node/legend colour for a task status (a chart colour, not a badge). */
export function runMapStatusClass(status) {
  return `rm-status rm-status-${statusToken("task", status).known ? status : "unknown"}`;
}

/** A row accent for a tone — the left edge a row carries so its state reads at a glance. */
export function toneAccentClass(tone) {
  return `tone-accent-${TONES.includes(tone) ? tone : "neutral"}`;
}
