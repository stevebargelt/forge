// FG-679 / FG-694: the `Current activity` surface, as a component.
//
// SINCE THE FG-694 POST-SHIP CORRECTION IT IS NOT ON HOME. Home has exactly one
// activity surface — `In flight` — and folds in only the compact waits below
// (`InFlightActivityWaits`). This component is the DIAGNOSTIC rendering, on the
// Activity view: host/CI diagnostics, the four BD-4 launch facts, and the per-context
// CI evidence behind its disclosure. Agent work has exactly one dashboard owner:
// `In flight`. Everything AC4-AC7 below still holds of the diagnostic evidence, which
// is the point — the detail moved behind disclosure, it was not deleted.
//
// Lives outside main.js since FG-694 for the reason current-activity-render.js was
// split out in the first place: main.js calls `render()` at module scope, so nothing
// in it can be imported by a test, and this component's job is now a claim about
// HONESTY that has to be assertable. AC7 is "these four strings cannot render from a
// failed read" — an assertion you can only make against the rendered tree.
//
// It adds NO decisions. `homeActivityView` in current-activity-render.js decides
// which sections exist, what the CI line says, and which of loading / ready /
// unavailable is true; this file renders that. Two consequences worth stating:
//
//   AC4  ONE compact line per current candidate — `FG-253 · CI running · 7/10
//        complete`. Per-context state, the FULL sha, check URLs and observation
//        timestamps are inside a <details> disclosure. AC5 is the constraint on AC4:
//        the detail is MOVED, never deleted, and it is the same per-context evidence
//        FG-679's BD-5 put there.
//   AC6  an empty section renders NOTHING — not an empty block, not a heading. With
//        nothing current at all the surface says `Nothing currently running.` once.
//   AC7  a non-2xx, a malformed body or a timeout renders `Current activity
//        unavailable` and a Retry. It renders NONE of the four observation claims,
//        because a read that failed has observed nothing.
//
// READ-ONLY, still: the only control on this surface is Retry, which re-reads. There
// is no start, stop or cancel for a launch or for CI, and no host filesystem path is
// rendered or linked — a launch is addressed by its identity (BD-10).

import { h } from "preact";
import htm from "htm";
import {
  launchBadge, launchAssociationLabel, launchIdentityLine,
  ciContextRows, caElapsedText, homeActivityView,
  homeInFlightActivity, launchWaitIdentity,
} from "./current-activity-render.js";

const html = htm.bind(h);

// An agent row navigates to its task, so it is a control and must be reachable as
// one: focusable, with Enter/Space activating it. Same shape as ProjectCard's — a
// mouse-only affordance on a new surface is a defect in the surface.
function caRowKey(event, activate) {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    activate();
  }
}

export function CurrentActivitySection({ load, now, onTaskClick, onRetry }) {
  const view = homeActivityView(load);
  // The dashboard's live-work owner is In flight. Once agent rows moved there, an
  // empty diagnostic projection no longer means "nothing is running"; it means only
  // that there is no host/CI detail to disclose. Render nothing instead of making a
  // broader claim than this component can support.
  if (view.phase === "ready" && view.empty) return null;
  return html`
    <section class="current-activity" aria-labelledby="current-activity-heading">
      <div class="home-section-heading">
        <div>
          <div class="home-section-kicker">Right now</div>
          <h2 id="current-activity-heading">Current activity</h2>
        </div>
      </div>
      ${view.phase === "loading"
        ? html`<div class="ca-loading" role="status">${view.message}</div>`
        : view.phase === "unavailable"
          ? html`<${CurrentActivityUnavailable} view=${view} onRetry=${onRetry} />`
          : view.sections.map((section) => html`
              <${CurrentActivityBlock}
                key=${section.kind}
                section=${section}
                now=${now}
                onTaskClick=${onTaskClick}
              />
            `)}
    </section>
  `;
}

// FG-694 (post-ship correction): the host-verification and required-check waits, as
// rows INSIDE Home's existing `In flight` section. There is no heading, no kicker and
// no section of its own — that second top-level panel is what this correction removes.
//
// It renders NOTHING when there is nothing to wait on, which is what keeps `In flight`
// the size of the work in flight. `homeInFlightActivity` decides what qualifies; this
// renders it, and adds no decision of its own.
export function InFlightActivityWaits({ load, now, onRetry }) {
  const waits = homeInFlightActivity(load);
  if (waits.message !== null) {
    return html`
      <div class="item ca-wait-row ca-wait-unavailable" role="status">
        <span class="badge launch-state-unknown">waits unavailable</span>
        <div>
          <div>${waits.message}</div>
          <div class="faint" style="font-size: 11px;">${waits.detail}</div>
        </div>
        <button type="button" class="ca-retry" onClick=${() => onRetry && onRetry()}>Retry</button>
      </div>
    `;
  }
  if (waits.hostVerification.length === 0 && waits.ci.length === 0) return null;
  return html`
    ${waits.hostVerification.map((entry) => html`<${HostWaitRow} key=${entry.launchId} entry=${entry} now=${now} />`)}
    ${waits.ci.map((summary) => html`<${CiWaitRow} key=${ciWaitKey(summary)} summary=${summary} />`)}
  `;
}

function ciWaitKey(summary) {
  const o = summary.observation;
  return o ? `${o.candidateSha}:${o.attemptId}` : `ci-${summary.identity ?? ""}`;
}

// ONE line. The argv, the launch id, the run and task ids and the observation time are
// all still on the Activity view's Current activity panel and in `forge status`; here
// the operator gets what they are waiting on and how long it has been.
//
// No `unassociated` badge: `homeInFlightActivity` only ever hands this row a launch the
// submitter associated with current work, so a badge here could only ever say the same
// thing twice. The label still renders on the Activity view, where unassociated launches
// still appear.
function HostWaitRow({ entry, now }) {
  return html`
    <div class="item ca-wait-row ca-host-wait-row">
      <span class="badge launch-state-running">host verification</span>
      <div>
        <strong>${launchWaitIdentity(entry)}</strong>
      </div>
      <div class="muted mono" style="font-size: 11px;" title="time since the launch started">
        ${caElapsedText(entry.startedAt, now)}
      </div>
    </div>
  `;
}

// `FG-253 · CI running · 7/10 complete`, and no drill-down: opening one here would put
// the sha, every context and every check URL back on Home. They are one view away, on
// the surface whose job is diagnosis.
function CiWaitRow({ summary }) {
  return html`
    <div class="item ca-wait-row ca-ci-wait-row">
      <span class="badge ${summary.class}">CI checks</span>
      <div>
        ${summary.identity ? html`<strong>${summary.identity}</strong>` : null}
        <span class="faint"> · in progress</span>
        ${summary.detail ? html`<span class="faint"> · </span><span class="ca-ci-detail-text">${summary.detail}</span>` : null}
      </div>
      <div></div>
    </div>
  `;
}

// The version-skew state FG-694 reproduced, and the whole point of AC7. Note what is
// NOT here: any statement about agents, launches or checks. We failed to read; that
// is the only fact we have.
function CurrentActivityUnavailable({ view, onRetry }) {
  return html`
    <div class="ca-unavailable" role="alert">
      <div class="ca-unavailable-head">
        <strong>${view.message}</strong>
        <button type="button" class="ca-retry" onClick=${() => onRetry && onRetry()}>Retry</button>
      </div>
      <div class="ca-unavailable-detail">${view.detail}</div>
    </div>
  `;
}

function CurrentActivityBlock({ section, now, onTaskClick }) {
  const headingId = `ca-${section.kind}-heading`;
  return html`
    <section class="ca-section" aria-labelledby=${headingId}>
      <h3 id=${headingId} class="ca-heading">${section.heading}</h3>
      ${section.kind === "unassociated" ? html`
        <div class="faint" style="font-size: 11px; padding: 0 14px 6px;">
          Running under no registered project home. Forge will not guess an owner from a launch name, its argv, or its log.
        </div>
      ` : null}
      ${section.kind === "agents"
        ? section.entries.map((a) => html`<${AgentRow} key=${a.taskId} entry=${a} now=${now} onTaskClick=${onTaskClick} />`)
        : section.kind === "requiredCi"
          ? section.entries.map((summary, index) => html`
            <${RequiredCiRow} key=${ciRowKey(summary, index)} summary=${summary} />
          `)
          : section.entries.map((l) => html`<${LaunchRow} key=${l.launchId} entry=${l} now=${now} />`)}
    </section>
  `;
}

function ciRowKey(summary, index) {
  const o = summary.observation;
  return o ? `${o.candidateSha}:${o.attemptId}` : `ci-${index}`;
}

function AgentRow({ entry, now, onTaskClick }) {
  const open = () => onTaskClick && onTaskClick(entry.taskId);
  return html`
    <div
      class="item ca-row ca-agent-row"
      role="button"
      tabIndex="0"
      aria-label=${`Open task ${entry.taskId} — ${entry.agentRole}, ${entry.runTitle}`}
      onClick=${open}
      onKeyDown=${(event) => caRowKey(event, open)}
    >
      <span class="badge status-${entry.status}">${entry.status.replace(/_/g, " ")}</span>
      <div>
        <div><strong>${entry.agentRole}</strong> <span class="faint"> ·</span> <span class="muted">${entry.runTitle}</span></div>
        <div class="faint mono" style="font-size: 11px;">${entry.phase} · ${entry.taskId}${entry.projectLabel ? ` · ${entry.projectLabel}` : ""}</div>
      </div>
      <div class="muted mono" style="font-size: 11px;">${caElapsedText(entry.startedAt, now)}</div>
    </div>
  `;
}

// The badge text is the server-rendered `statusLabel` — src/v2/launch.ts's
// `statusLine`, byte for byte. SIGTERM-terminated, a bare signal-range `exited 143`,
// owner-gone and unknown are FOUR DIFFERENT FACTS and none of them is a generic
// `failed` (BD-4); a stale observation reads `unobserved since <t>` and is never
// dressed up as `running` or as terminal (BD-12).
function LaunchRow({ entry, now }) {
  const badge = launchBadge(entry);
  const assoc = launchAssociationLabel(entry);
  return html`
    <div class="item ca-row ca-launch-row">
      <span class="badge ${badge.class}" title=${`observed ${entry.observedAt}`}>${badge.text}</span>
      <div>
        <div>
          <strong class="mono">${entry.name || entry.launchId}</strong>
          ${assoc ? html`<span class="ca-assoc-badge">${assoc}</span>` : null}
        </div>
        <div class="faint mono" style="font-size: 11px;">${entry.commandLine}</div>
        <div class="faint mono" style="font-size: 11px;">${launchIdentityLine(entry)}</div>
      </div>
      <div class="muted mono" style="font-size: 11px;" title="time since the launch started">
        ${caElapsedText(entry.startedAt, now)}
      </div>
    </div>
  `;
}

// AC4 + AC5, in one element. The SUMMARY is the compact line an operator reads at a
// glance; the disclosure below it is FG-679's BD-5 evidence unchanged — every
// required context with its own state, URL and observation time, the exact candidate
// sha the observer declared, and the unavailable reason when there is one. A native
// <details> because it is a disclosure: keyboard-operable and announced without a
// hand-rolled aria-expanded that can drift out of sync with the state it describes.
function RequiredCiRow({ summary }) {
  const observation = summary.observation;
  if (!observation) {
    // Nothing was observed for a current candidate, so there is nothing to open.
    return html`
      <div class="item ca-row ca-ci-row ca-ci-flat">
        <span class="badge ${summary.class}">${summary.label}</span>
        <div></div>
        <div></div>
      </div>
    `;
  }
  const rows = ciContextRows(observation);
  return html`
    <details class="ca-ci-item">
      <summary class="ca-ci-summary">
        <span class="ca-ci-line">
          ${summary.identity ? html`<strong class="ca-ci-id">${summary.identity}</strong><span class="faint"> · </span>` : null}
          <span class="badge ${summary.class}">${summary.label}</span>
          ${summary.detail ? html`<span class="faint"> · </span><span class="ca-ci-detail-text">${summary.detail}</span>` : null}
        </span>
      </summary>
      <div class="ca-ci-evidence">
        <div class="faint mono ca-ci-candidate">
          <span class="muted">candidate</span> <span class="ca-sha">${observation.candidateSha}</span>
          <span class="ca-ci-observed">observed ${observation.observedAt}</span>
        </div>
        ${rows.length === 0
          ? html`<div class="faint mono" style="font-size: 11px;">No required context enumerated at this sha.</div>`
          : html`<div class="ca-ci-contexts">
              ${rows.map((c) => html`
                <div class="ca-ci-context" key=${c.context}>
                  <span class="ca-ctx-name mono">${c.context}</span>
                  <span class="ca-ctx-state ${c.class}">${c.state}</span>
                  ${c.url ? html`<a class="ca-ctx-url" href=${c.url} target="_blank" rel="noreferrer noopener">check</a>` : html`<span class="faint">(no url)</span>`}
                  <span class="faint mono ca-ctx-observed">observed ${c.observedAt}</span>
                </div>
              `)}
            </div>`}
        ${observation.unavailableReason ? html`<div class="faint mono" style="font-size: 11px;">unavailable: ${observation.unavailableReason}</div>` : null}
      </div>
    </details>
  `;
}
