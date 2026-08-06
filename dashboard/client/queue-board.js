// FG-591 step 13 — the operator Kanban board.
//
// Five projection columns (plus the sixth state a dequeued-but-executing item lands
// in), drag-reorder that submits RELATIVE intent with the version the board loaded,
// enqueue/dequeue controls, per-card reasons that keep a genuine blocker visibly
// distinct from a temporary scheduling wait, and a READ-ONLY dispatcher panel.
//
// Every decision this view makes lives in queue-board-state.js and is unit-tested
// there. What is left here is rendering, drag mechanics and the fetch — deliberately,
// so "the board groups by the server's partition" is a pinned claim rather than a
// property of JSX nobody can assert.
//
// ACCESSIBILITY: reordering is not drag-only. Every queued card is a listitem with
// keyboard grab (Enter/Space) and Arrow-key movement, because a mouse-only reorder is
// a mouse-only queue. Both paths funnel through the same planRelativeMove.

import { h } from "preact";
import { useState, useCallback, useRef } from "preact/hooks";
import htm from "htm";
import {
  BOARD_COLUMNS,
  DEQUEUE_NOTE,
  queueBoardState,
  waitBadge,
  planRelativeMove,
  previewMove,
  rankRequest,
  enqueueRequest,
  dequeueRequest,
  mutationOutcome,
} from "./queue-board-state.js";

const html = htm.bind(h);

const EXECUTION_LABELS = { idle: "idle", launching: "launching", running: "running" };

function fmtDuration(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "—";
  const abs = Math.abs(ms);
  if (abs < 1000) return `${Math.round(abs)}ms`;
  if (abs < 60_000) return `${Math.round(abs / 1000)}s`;
  if (abs < 3_600_000) return `${Math.round(abs / 60_000)}m`;
  return `${(abs / 3_600_000).toFixed(1)}h`;
}

/** The scope every mutation POST carries — the SAME resolution /api/queue used, so a
 *  board cannot write to a project other than the one it is showing. */
function scopeQuery(projectFilter, checkoutFilter) {
  const params = new URLSearchParams();
  if (checkoutFilter) params.set("projectDir", checkoutFilter);
  else if (projectFilter?.key) params.set("projectKey", projectFilter.key);
  const q = params.toString();
  return q ? `?${q}` : "";
}

export function QueueBoardView({ data, projectFilter, checkoutFilter, onReload }) {
  const [pending, setPending] = useState(null);
  const [outcome, setOutcome] = useState(null);
  const [enqueueId, setEnqueueId] = useState("");
  const [grabbed, setGrabbed] = useState(null);
  const dragging = useRef(null);

  const state = queueBoardState(data, { projectSelected: Boolean(projectFilter) });

  const submit = useCallback(
    async (request, describe) => {
      if (!request) return;
      setPending(describe);
      try {
        const res = await fetch(`${request.path}${scopeQuery(projectFilter, checkoutFilter)}`, {
          method: "POST",
          // The non-simple content type is load-bearing on the server side; sending it
          // here is what makes this same-origin request legal at all.
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(request.body),
        });
        let payload = null;
        try {
          payload = await res.json();
        } catch {
          payload = null;
        }
        const result = mutationOutcome({ status: res.status, payload });
        setOutcome(result);
        // A REFUSAL IS NEVER SWALLOWED INTO A RELOAD. Only an applied mutation
        // re-reads the board; a stale-version refusal keeps its message on screen and
        // makes the operator reload deliberately, because the order they composed the
        // move against no longer exists.
        if (result.ok && onReload) onReload();
      } catch (err) {
        setOutcome(mutationOutcome({ status: 0, payload: { error: String(err) } }));
      } finally {
        setPending(null);
      }
    },
    [projectFilter, checkoutFilter, onReload],
  );

  const move = useCallback(
    (ticketId, targetIndex) => {
      const planned = planRelativeMove(state.queuedIds, ticketId, targetIndex);
      if (!planned) return;
      const request = rankRequest(planned, state.version);
      if (!request) {
        setOutcome({
          ok: false,
          kind: "refused",
          verb: null,
          blocking: true,
          needsReload: true,
          message: "This board has no queue version loaded, so a reorder cannot be submitted safely. Reload the board.",
        });
        return;
      }
      void submit(request, `${planned.placement === "before" ? "moving" : "moving"} ${ticketId} ${planned.placement} ${planned.reference}`);
    },
    [state.queuedIds, state.version, submit],
  );

  if (state.kind === "no-project") {
    return html`<div class="muted queue-empty">Select a project to see its work queue.</div>`;
  }
  if (state.kind === "loading") {
    return html`<div class="muted queue-empty">loading queue…</div>`;
  }

  return html`
    <div class="queue-view">
      ${state.kind === "error"
        ? html`<div class="card queue-alert queue-alert-err" role="alert">
            <strong>The queue board could not be read.</strong> This is not an empty queue — the count is unknown.
            <div class="muted queue-alert-detail">${state.error}</div>
          </div>`
        : null}

      ${state.degraded.length > 0
        ? html`<div class="card queue-alert queue-alert-warn" role="status">
            <strong>Partial read.</strong> These sections are UNKNOWN rather than empty:
            ${" "}<span class="mono">${state.degraded.join(", ")}</span>. A store written before this
            feature has no dispatcher tables, and a read-only handle never creates them.
          </div>`
        : null}

      ${outcome && !outcome.ok
        ? html`<div class="card queue-alert queue-alert-err" role="alert">
            <strong>${outcome.kind === "stale_version" ? "The queue moved — your change was NOT applied." : "Refused."}</strong>
            <div class="muted queue-alert-detail">${outcome.message}</div>
            ${outcome.hint ? html`<div class="muted queue-alert-detail">${outcome.hint}</div>` : null}
            <div class="queue-alert-actions">
              ${outcome.needsReload && onReload
                ? html`<button class="usage-dim-btn" onClick=${() => { setOutcome(null); onReload(); }}>reload board</button>`
                : null}
              <button class="usage-dim-btn" onClick=${() => setOutcome(null)}>dismiss</button>
            </div>
          </div>`
        : null}

      <${DispatcherPanel} dispatcher=${state.dispatcher} capacity=${state.capacity} />

      ${state.kind === "no-truth" || state.kind === "unavailable"
        ? html`<div class="muted queue-empty queue-unavailable">${state.message}</div>`
        : html`
            <${QueueControls}
              state=${state}
              enqueueId=${enqueueId}
              onEnqueueIdChange=${setEnqueueId}
              onEnqueue=${() => {
                const id = enqueueId.trim();
                if (!id) return;
                setEnqueueId("");
                void submit(enqueueRequest(id), `enqueueing ${id}`);
              }}
              pending=${pending}
            />

            ${state.kind === "empty"
              ? html`<div class="muted queue-empty">${state.message}</div>`
              : html`
                  <div class="queue-columns">
                    ${BOARD_COLUMNS.map((def) => {
                      const column = state.columns.find((c) => c.view === def.view);
                      return html`<${BoardColumn}
                        key=${def.view}
                        column=${column}
                        state=${state}
                        grabbed=${grabbed}
                        pending=${pending}
                        onGrab=${setGrabbed}
                        onMove=${move}
                        onDequeue=${(id) => void submit(dequeueRequest(id), `dequeueing ${id}`)}
                        onEnqueue=${(id) => void submit(enqueueRequest(id), `enqueueing ${id}`)}
                        dragging=${dragging}
                      />`;
                    })}
                  </div>
                `}
          `}
    </div>
  `;
}

function QueueControls({ state, enqueueId, onEnqueueIdChange, onEnqueue, pending }) {
  return html`
    <section class="queue-controls card" aria-label="Queue planning controls">
      <div class="queue-controls-row">
        <label class="queue-controls-label" for="queue-enqueue-id">Enqueue ticket</label>
        <input
          id="queue-enqueue-id"
          class="backlog-search queue-enqueue-input"
          type="text"
          placeholder="FG-123"
          value=${enqueueId}
          onInput=${(e) => onEnqueueIdChange(e.target.value)}
          onKeyDown=${(e) => { if (e.key === "Enter") onEnqueue(); }}
        />
        <button class="usage-dim-btn" onClick=${onEnqueue} disabled=${Boolean(pending) || enqueueId.trim() === ""}>
          enqueue
        </button>
        <span class="muted queue-version" title="The order-affecting queue event this board loaded. Every reorder carries it, so a queue that moved underneath the page refuses instead of being clobbered.">
          queue version <span class="mono">${state.version}</span>
        </span>
        ${pending ? html`<span class="muted queue-pending" role="status">${pending}…</span>` : null}
      </div>
      <p class="muted queue-controls-note">
        Enqueue is refused unless the ticket's <em>current</em> revision is ready; the refusal carries the concrete
        refinement proposal. ${DEQUEUE_NOTE}
      </p>
    </section>
  `;
}

function BoardColumn({ column, state, grabbed, pending, onGrab, onMove, onDequeue, onEnqueue, dragging }) {
  if (!column) return null;
  const reorderable = column.view === "queued";

  const onDrop = (e, index) => {
    e.preventDefault();
    const id = dragging.current ?? e.dataTransfer?.getData("text/plain");
    dragging.current = null;
    if (id) onMove(id, index);
  };

  return html`
    <section class=${`queue-column queue-column-${column.view}`} aria-label=${`${column.title} (${column.count})`}>
      <header class="queue-column-head">
        <h2 class="queue-column-title">
          ${column.title}
          <span class="queue-column-count" aria-hidden="true">${column.count}</span>
          ${column.derived
            ? html`<span class="badge queue-derived-badge" title="Derived from run/readiness evidence on every read. Never stored and never manually toggled.">derived</span>`
            : null}
        </h2>
        <p class="muted queue-column-hint">${column.hint}</p>
      </header>
      ${column.missing.length > 0
        ? html`<div class="muted queue-column-missing" role="status">
            ${column.missing.length} item(s) in this column had no row in the payload: <span class="mono">${column.missing.join(", ")}</span>
          </div>`
        : null}
      <ul class="queue-cards" role="list">
        ${column.rows.length === 0
          ? html`<li class="muted queue-column-empty">nothing here</li>`
          : column.rows.map((row, index) => html`
              <${QueueCard}
                key=${row.ticketId}
                row=${row}
                index=${index}
                reorderable=${reorderable}
                grabbed=${grabbed === row.ticketId}
                disabled=${Boolean(pending)}
                queuedIds=${state.queuedIds}
                onGrab=${onGrab}
                onMove=${onMove}
                onDequeue=${onDequeue}
                onEnqueue=${onEnqueue}
                onDragStartId=${(id) => { dragging.current = id; }}
                onDropAt=${onDrop}
              />
            `)}
      </ul>
    </section>
  `;
}

function QueueCard({
  row,
  index,
  reorderable,
  grabbed,
  disabled,
  queuedIds,
  onGrab,
  onMove,
  onDequeue,
  onEnqueue,
  onDragStartId,
  onDropAt,
}) {
  const badge = waitBadge(row);

  // KEYBOARD REORDER. Same plan, same submission, same version as the drag path —
  // a reorder that only a mouse can perform is a queue only a mouse can plan.
  const onKeyDown = (e) => {
    if (!reorderable) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onGrab(grabbed ? null : row.ticketId);
      return;
    }
    if (e.key === "Escape" && grabbed) {
      e.preventDefault();
      onGrab(null);
      return;
    }
    if (!grabbed) return;
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      const from = queuedIds.indexOf(row.ticketId);
      if (from < 0) return;
      onGrab(null);
      onMove(row.ticketId, from + (e.key === "ArrowUp" ? -1 : 1));
    }
  };

  return html`
    <li
      class=${`card queue-card queue-card-${row.view}${grabbed ? " queue-card-grabbed" : ""}`}
      draggable=${reorderable && !disabled ? "true" : "false"}
      onDragStart=${(e) => {
        if (!reorderable) return;
        onDragStartId(row.ticketId);
        e.dataTransfer?.setData("text/plain", row.ticketId);
      }}
      onDragOver=${(e) => { if (reorderable) e.preventDefault(); }}
      onDrop=${(e) => { if (reorderable) onDropAt(e, index); }}
      tabIndex=${reorderable ? 0 : -1}
      onKeyDown=${onKeyDown}
      aria-grabbed=${reorderable ? String(Boolean(grabbed)) : undefined}
      aria-label=${`${row.ticketId} ${row.title}${row.rank === null ? ", unranked" : `, rank ${row.rank}`}`}
    >
      <div class="queue-card-head">
        <span class="mono queue-card-rank" title=${row.rank === null ? "Unranked. Null rank is a valid backlog item, not a deprioritized one." : "Canonical stack rank"}>
          ${row.rank === null ? "—" : `#${row.rank}`}
        </span>
        <span class="mono queue-card-id">${row.ticketId}</span>
        <strong class="queue-card-title">${row.title}</strong>
      </div>

      <div class="queue-card-facts muted">
        <span title="Lifecycle status, verbatim — not a projection.">${row.status}</span>
        ${row.queued ? html`<span class="badge queue-member-badge">queued</span>` : null}
        ${row.executionState && row.executionState !== "idle"
          ? html`<span class=${`badge queue-exec-badge queue-exec-${row.executionState}`}>${EXECUTION_LABELS[row.executionState] ?? row.executionState}</span>`
          : null}
        ${row.readiness
          ? html`<span
              class=${`badge queue-readiness-badge${row.readiness.stale ? " queue-readiness-stale" : ""}`}
              title=${row.readiness.stale
                ? "This assessment describes an OLDER revision — the ticket was edited after it was recorded. The dispatcher never silently re-evaluates it; that is operator-actionable."
                : "Readiness assessed against the ticket's current revision."}
            >${row.readiness.outcome}${row.readiness.stale ? " · stale" : ""}</span>`
          : null}
      </div>

      ${badge
        ? html`<div class=${`queue-wait queue-wait-${badge.tone}`}>
            <span class=${`badge queue-wait-badge queue-wait-badge-${badge.tone}`}>${badge.label}</span>
            <span class="queue-wait-reason">${badge.reason}</span>
            <div class="faint queue-wait-meta">
              ${badge.durability === "temporary" ? "temporary — self-clearing" : badge.durability === "durable" ? "durable" : "unknown"}
              ${" · "}${badge.evidence === "per-evaluation" ? "from the last dispatcher evaluation" : "from durable ticket state"}
              ${badge.observedAt ? html` · observed ${badge.observedAt}` : null}
            </div>
            <div class="faint queue-wait-note">${badge.note}</div>
          </div>`
        : null}

      ${row.reservation
        ? html`<div class="faint queue-reservation" title="The RESERVATION half. queue_claims is authoritative for the reservation, the run record for the execution — never joined.">
            reserved by <span class="mono">${row.reservation.owner}</span> gen ${row.reservation.generation}
            ${row.reservation.launchId ? html` · launch <span class="mono">${row.reservation.launchId}</span>` : null}
            ${row.reservation.leaseExpired ? html` · <span class="queue-lease-expired">lease expired — recoverable by takeover</span>` : null}
          </div>`
        : null}

      <div class="queue-card-actions">
        ${row.queued
          ? html`<button class="usage-dim-btn" disabled=${disabled} onClick=${() => onDequeue(row.ticketId)} title=${DEQUEUE_NOTE}>dequeue</button>`
          : html`<button class="usage-dim-btn" disabled=${disabled} onClick=${() => onEnqueue(row.ticketId)}>enqueue</button>`}
        ${reorderable
          ? html`<span class="faint queue-card-reorder-hint">drag, or focus and press Enter then ↑/↓</span>`
          : null}
      </div>
    </li>
  `;
}

function DispatcherPanel({ dispatcher, capacity }) {
  const lease = dispatcher.lease;
  return html`
    <section class="card queue-dispatcher" aria-label="Dispatcher">
      <div class="queue-dispatcher-head">
        <h2 class="queue-dispatcher-title">Dispatcher</h2>
        <span class=${`badge queue-dispatcher-state queue-tone-${dispatcher.tone}`}>${dispatcher.label}</span>
        <span class=${`badge queue-armed-badge${dispatcher.armed ? " queue-armed-on" : ""}`}>
          ${dispatcher.armed ? "armed" : "disarmed"}
        </span>
        ${!dispatcher.configured
          ? html`<span class="muted queue-dispatcher-default" title="No host policy row has ever been written — every value below is a default, not an operator choice.">defaults (never configured)</span>`
          : null}
      </div>

      ${dispatcher.detail ? html`<p class="muted queue-dispatcher-detail">${dispatcher.detail}</p>` : null}

      <div class="queue-dispatcher-grid">
        <div><span class="muted">max active runs</span> <span class="mono">${dispatcher.maxActiveRuns ?? "—"}</span></div>
        <div><span class="muted">capacity scope</span> <span class="mono">${dispatcher.capacityScope ?? "—"}</span></div>
        <div>
          <span class="muted">queue-owned active</span>
          <span class="mono">${capacity.queueOwnedActive}${capacity.limit === null ? "" : `/${capacity.limit}`}</span>
        </div>
        <div>
          <span class="muted">lease</span>
          ${lease
            ? html`<span class="mono" title=${`generation ${lease.generation}`}>${lease.owner}</span>
                ${dispatcher.leaseExpired
                  ? html` <span class="queue-lease-expired">EXPIRED</span>`
                  : html` <span class="faint">live</span>`}`
            : html`<span class="faint">none</span>`}
        </div>
        <div>
          <span class="muted" title="How long since the owner was last actually alive. 'Nothing to do' and 'the dispatcher died hours ago' must never read the same.">last heartbeat</span>
          <span class="mono">${dispatcher.leaseStaleness === null ? "—" : `${fmtDuration(dispatcher.leaseStaleness)} ago`}</span>
        </div>
        <div>
          <span class="muted">next watchdog</span>
          <span class="mono">
            ${dispatcher.nextWatchdogInMs === null
              ? "—"
              : dispatcher.nextWatchdogInMs <= 0
                ? "due"
                : `in ${fmtDuration(dispatcher.nextWatchdogInMs)}`}
          </span>
        </div>
        <div><span class="muted">pending wakes</span> <span class="mono">${dispatcher.pendingWakes}</span></div>
        <div><span class="muted">default workflow</span> <span class="mono">${dispatcher.defaultWorkflow ?? "—"}</span></div>
      </div>

      ${dispatcher.lastEvaluation
        ? html`<div class="queue-dispatcher-eval">
            <span class="muted">last evaluation</span>
            <span class="mono">${dispatcher.lastEvaluation.reason}</span>
            <span class="faint">
              ${dispatcher.lastEvaluation.evaluatedAt}
              ${dispatcher.lastEvaluationAgeMs === null ? null : ` (${fmtDuration(dispatcher.lastEvaluationAgeMs)} ago)`}
            </span>
            ${dispatcher.lastEvaluation.detail
              ? html`<div class="muted queue-dispatcher-eval-detail">${dispatcher.lastEvaluation.detail}</div>`
              : null}
          </div>`
        : html`<div class="muted queue-dispatcher-eval">
            No dispatcher evaluation has been recorded yet — reported as such rather than guessed at.
          </div>`}

      ${capacity.otherProjectHolders > 0
        ? html`<div class="queue-capacity-holders">
            ${/* One interpolation: htm collapses a line break between text and an
                  interpolation to nothing, which silently welds words together. */ ""}
            <span class="muted">${`${capacity.otherProjectHolders} of the ${capacity.scope ?? "host"}-scoped capacity slots ${capacity.otherProjectHolders === 1 ? "is" : "are"} held by another project:`}</span>
            <ul class="queue-holder-list" role="list">
              ${capacity.holders
                .filter((holder) => holder && holder.thisProject === false)
                .map((holder) => html`
                  <li key=${holder.claimId} class="mono queue-holder">
                    ${holder.projectLabel ?? holder.projectKey} · ${holder.ticketId}
                  </li>
                `)}
            </ul>
          </div>`
        : null}

      ${capacity.notCounted
        ? html`<p class="faint queue-capacity-policy">${`${capacity.notCounted.activeTasks} other active task(s) on this host are `}<em>reported, never counted</em>${` against the ceiling. ${capacity.notCounted.policy}`}</p>`
        : null}

      <p class="muted queue-cli-only" role="note">
        <span class="badge queue-cli-badge">CLI only</span> ${dispatcher.controlNotice}
      </p>
    </section>
  `;
}
