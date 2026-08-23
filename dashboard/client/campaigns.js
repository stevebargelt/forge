// forge-dashboard — Campaigns view (FG-395).
//
// READ-ONLY. Two surfaces: a list of recent campaign summaries for the selected
// project, and a per-campaign detail that is the EXACT campaign report contract
// (assembleCampaignReport → ReportResult). Nothing here re-derives done-audit,
// readiness, verdict, next-action or git-state — every value is a field the report
// already carries, rendered truthfully: a null readiness/done-audit/reviewer/PR is
// shown as absent, never as a pass and never as a fabricated link.
//
// NOTE (checkpoints): the campaign report contract persists NO checkpoint /
// report-snapshot history — `forge campaign report` assembles the current/final
// report live on demand (a "checkpoint" is a point in time you run it, not a stored
// row). So this surface shows the current/final report and says so; it does not
// invent a snapshot history the store does not keep.

import { h } from "preact";
import { useState, useEffect, useRef } from "preact/hooks";
import htm from "htm";
import {
  campaignStatusBadgeClass, verdictBadgeClass, verdictLabel, itemLifecycleBadgeClass,
  shortSha, formatItemCounts, gitEvidence, itemActionText,
} from "./campaigns-render.js";

const html = htm.bind(h);

function CampaignCard({ summary, onSelect }) {
  const current = summary.currentItem;
  return html`
    <div class="card campaign-card" data-testid="campaign-card" role="button" tabindex="0"
      onClick=${() => onSelect(summary.campaignId)}
      onKeyDown=${(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(summary.campaignId); } }}>
      <div class="row campaign-card-head">
        <div>
          <span class="badge ${campaignStatusBadgeClass(summary.status)}">${summary.status}</span>
          <span class="badge ${verdictBadgeClass(summary.verdict)}" style="margin-left: 6px;">${verdictLabel(summary.verdict)}</span>
          <strong class="mono" style="margin-left: 8px;">${summary.campaignId}</strong>
        </div>
        <span class="muted mono" style="font-size: 11px;">${summary.mode}</span>
      </div>
      ${summary.goal ? html`<div class="muted" style="margin-top: 4px;">${summary.goal}</div>` : null}
      <div class="campaign-counts mono">${formatItemCounts(summary.counts)}</div>
      <div class="muted" style="font-size: 12px; margin-top: 4px;">
        ${current
          ? html`current: <span class="mono">${current.ticketId}</span>${current.title ? ` — ${current.title}` : ""}`
          : "no current item"}
      </div>
    </div>`;
}

export function CampaignsView({ data, selectedId, onSelect, onCloseDetail }) {
  if (!data) return html`<div class="muted" style="margin-top: 20px;">loading campaigns…</div>`;

  const campaigns = data.campaigns || [];
  return html`
    <section class="campaigns-view">
      <h2>Campaigns</h2>
      <div class="muted" style="margin-bottom: 8px;">
        Read-only projection of the campaign report contract. Blocked / shipped / skipped / held items, blocker reasons,
        readiness, done-audit, Shipping Reviewer and per-item git/PR evidence — rendered exactly as the report records them.
        Absence is shown as "not observed", never green. Forge keeps no report-snapshot history; this is the current report.
      </div>
      ${data.error ? html`<div class="card" style="color: var(--err);">Campaigns unreadable: ${data.error}</div>` : null}
      ${data.projectKey === null && !data.error && campaigns.length === 0
        ? html`<div class="muted" data-testid="campaigns-no-project">Select a project to see its campaigns (or none are recorded yet).</div>`
        : campaigns.length === 0
          ? html`<div class="muted" data-testid="campaigns-empty">No campaigns recorded for this project yet.</div>`
          : campaigns.map((c) => html`<${CampaignCard} key=${c.campaignId} summary=${c} onSelect=${onSelect} />`)}
      ${selectedId ? html`<${CampaignDetail} campaignId=${selectedId} onClose=${onCloseDetail} />` : null}
    </section>`;
}

// The full report overlay. Self-fetches /api/campaign/:id (the TaskDetail pattern),
// re-reading while the campaign is still running so a live campaign's items stay
// current. A 404 is the report contract's "unknown id" answer, rendered as such.
function CampaignDetail({ campaignId, onClose }) {
  const [report, setReport] = useState(null);
  const [err, setErr] = useState(null);
  // FG-746/RF-2: one batch read of ALL reconcile-gate evidence for the campaign,
  // keyed by ticketId, instead of one fetch per rendered item. null while loading,
  // then an object mapping ticketId → rows (tickets with no evidence are absent).
  const [reconcileByTicket, setReconcileByTicket] = useState(null);
  const overlayRef = useRef(null);

  // Dialog semantics: close on Escape, and move focus into the overlay on open,
  // restoring it to the opener on close — the backlog NoteDetail modal precedent.
  const onKeyDown = (e) => { if (e.key === "Escape") onClose(); };

  useEffect(() => {
    const opener = document.activeElement;
    const node = overlayRef.current;
    if (node) (node.querySelector(".close") ?? node).focus();
    return () => { if (opener && typeof opener.focus === "function") opener.focus(); };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer = null;
    const load = async () => {
      try {
        const res = await fetch(`/api/campaign/${encodeURIComponent(campaignId)}`);
        if (res.status === 404) { if (!cancelled) setErr("campaign not found"); return; }
        const d = await res.json().catch(() => null);
        if (cancelled) return;
        // A 503 degraded-store read still carries { error }; surface its message rather
        // than a bare status so the operator sees why the report is unavailable.
        if (!res.ok) { setErr(d && d.error ? d.error : `HTTP ${res.status}`); return; }
        if (d && d.error) { setErr(d.error); return; }
        setReport(d);
        if (d.status === "running") timer = setTimeout(load, 3000);
      } catch (e) { if (!cancelled) setErr(String(e)); }
    };
    load();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [campaignId]);

  // FG-746/RF-2: fetch the campaign's reconcile-gate evidence ONCE, keyed by
  // ticketId. Each ItemCard reads its slice from this map — no per-item request.
  useEffect(() => {
    if (!campaignId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/host-verifications?campaignId=${encodeURIComponent(campaignId)}`);
        if (!cancelled && res.ok) setReconcileByTicket(await res.json());
      } catch { /* leave null — each item's evidence axis simply omits the table */ }
    })();
    return () => { cancelled = true; };
  }, [campaignId]);

  if (!report) {
    return html`
      <div class="detail-overlay" ref=${overlayRef} onClick=${onClose} onKeyDown=${onKeyDown}
        role="dialog" aria-modal="true" aria-label=${`Campaign detail for ${campaignId}`}>
        <div class="detail" onClick=${(e) => e.stopPropagation()}>
          <button type="button" class="close" aria-label="close" onClick=${onClose}>×</button>
          <div class="muted" data-testid="campaign-detail-status">${err ?? "loading…"}</div>
        </div>
      </div>`;
  }

  return html`
    <div class="detail-overlay" ref=${overlayRef} onClick=${onClose} onKeyDown=${onKeyDown}
      role="dialog" aria-modal="true" aria-label=${`Campaign detail for ${report.campaignId}`}>
      <div class="detail" onClick=${(e) => e.stopPropagation()}>
        <button type="button" class="close" aria-label="close" onClick=${onClose}>×</button>
        <h1>
          <span class="badge ${campaignStatusBadgeClass(report.status)}">${report.status}</span>
          <span class="badge ${verdictBadgeClass(report.verdict)}" style="margin-left: 6px;">${verdictLabel(report.verdict)}</span>
          <span class="mono" style="margin-left: 8px;">${report.campaignId}</span>
        </h1>
        <div class="faint mono" style="font-size: 11px; margin: 8px 0 12px;">
          mode ${report.mode} · safety ${report.safetyToContinue}${report.goal ? ` · ${report.goal}` : ""}
        </div>

        <div class="subcard campaign-next-action" data-testid="campaign-next-action">
          <span class="audit-axis-label">next operator action</span>
          <div>${report.nextOperatorAction}</div>
        </div>

        <${GroupingsBlock} groupings=${report.groupings} />

        ${report.dirtyGitState ? html`
          <div class="subcard" style="margin-top: 12px;">
            <span class="audit-axis-label">dirty git state</span>
            <pre class="log" style="margin-top: 4px;">${report.dirtyGitState}</pre>
          </div>` : null}

        <h3 style="margin-top: 16px;">Items (${report.items.length})</h3>
        ${report.items.map((item) => html`<${ItemCard} key=${item.ticketId} item=${item} reconcileRows=${reconcileByTicket ? reconcileByTicket[item.ticketId] : null} />`)}
      </div>
    </div>`;
}

function GroupingsBlock({ groupings }) {
  const g = groupings || {};
  const buckets = [
    ["shipped", g.shipped], ["blocked", g.blocked], ["held", g.held],
    ["skipped", g.skipped], ["failed", g.failed],
  ];
  return html`
    <div class="campaign-groupings" data-testid="campaign-groupings">
      ${buckets.map(([label, ids]) => html`
        <div key=${label} class="campaign-grouping-row">
          <span class="audit-axis-label">${label}</span>
          <span class="mono">${ids && ids.length > 0 ? ids.join(", ") : "—"}</span>
        </div>`)}
    </div>`;
}

// The per-item evidence card. Order: identity + status, run/task/verdict links,
// blocker + requested action, readiness, done-audit, git/PR evidence, and the
// reviewer / verification axes (currently null on the contract → "not available").
// FG-746 (C6): per-item reconcile-gate host_verifications evidence, scoped through
// the campaign's own project (fail closed). Read-only, degrades to nothing when no
// evidence is recorded for the item's ticket.
// FG-746/RF-2: the evidence is fetched ONCE for the whole campaign (see
// CampaignDetail) and handed down as `rows`, rather than one fetch per item — an
// N-request burst on campaigns with many items. `rows` is null while the batch is
// still loading, [] once loaded with nothing for this ticket.
function ReconcileEvidence({ rows }) {
  if (!rows || rows.length === 0) return null;
  return html`
    <div class="campaign-item-axis" data-testid="campaign-item-reconcile-evidence">
      <span class="audit-axis-label">reconcile-gate evidence</span>
      <div class="card" style="overflow-x: auto; margin-top: 4px;">
        <table style="width: 100%; border-collapse: collapse; font-size: 11px;">
          <thead>
            <tr class="muted" style="text-align: left;">
              <th style="padding: 3px 6px;">gate</th>
              <th style="padding: 3px 6px;">source</th>
              <th style="padding: 3px 6px;">result</th>
              <th style="padding: 3px 6px;">commit</th>
              <th style="padding: 3px 6px;">recorded</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map((r, i) => html`
              <tr key=${r.id ?? i} style="border-top: 1px solid var(--border);" data-testid="reconcile-evidence-row">
                <td style="padding: 3px 6px;" title=${r.command ?? ""}>${r.gateName ?? "—"}</td>
                <td style="padding: 3px 6px;">${r.source ?? "host"}</td>
                <td style="padding: 3px 6px;"><span class="badge ${r.exitCode === 0 ? "status-complete" : "status-failed"}">${r.exitCode === 0 ? "pass" : `exit ${r.exitCode}`}</span></td>
                ${r.ciUrl
                  ? html`<td style="padding: 3px 6px;"><a class="mono" href=${r.ciUrl} target="_blank" rel="noreferrer noopener">${shortSha(r.commitSha)}</a></td>`
                  : html`<td style="padding: 3px 6px;" class="mono faint">${shortSha(r.commitSha)}</td>`}
                <td style="padding: 3px 6px;" class="muted mono">${r.recordedAt ?? "—"}</td>
              </tr>`)}
          </tbody>
        </table>
      </div>
    </div>`;
}

function ItemCard({ item, reconcileRows }) {
  const git = gitEvidence(item);
  const action = itemActionText(item);
  const readiness = item.readiness;
  const audit = item.doneAuditState;
  return html`
    <div class="card campaign-item" data-testid="campaign-item" data-ticket=${item.ticketId}>
      <div class="row campaign-item-head">
        <div>
          <span class="badge ${itemLifecycleBadgeClass(item.lifecycleStatus)}">${item.lifecycleStatus}</span>
          ${item.outcome ? html`<span class="muted" style="margin-left: 6px;">outcome=${item.outcome}</span>` : null}
          <strong class="mono" style="margin-left: 8px;">${item.ticketId}</strong>
          ${item.title ? html`<span class="muted" style="margin-left: 6px;">${item.title}</span>` : null}
        </div>
        ${item.runId ? html`<span class="muted mono" style="font-size: 11px;">run ${item.runId}</span>` : null}
      </div>

      <div class="muted" style="font-size: 12px; margin-top: 4px;">
        execution: ${item.executionMode}${item.workflowName ? ` [${item.workflowName}]` : ""}${item.agentRole ? ` [role=${item.agentRole}]` : ""}
      </div>

      ${item.taskSummaries && item.taskSummaries.length > 0 ? html`
        <div class="muted mono" style="font-size: 11px; margin-top: 4px;">
          tasks: ${item.taskSummaries.map((t) => `${t.phase}(${t.status})`).join(", ")}
        </div>` : null}

      ${item.verdictSummaries && item.verdictSummaries.length > 0 ? html`
        <div class="mono" style="font-size: 11px; margin-top: 4px;" data-testid="campaign-item-verdicts">
          <span class="audit-axis-label">reviewer</span>
          ${item.verdictSummaries.map((v) => `${v.verdict}/${v.authority}${v.findingsCount > 0 ? ` (${v.findingsCount} finding${v.findingsCount === 1 ? "" : "s"})` : ""}`).join(", ")}
        </div>` : null}

      ${(item.reason || item.blockerKind || action) ? html`
        <div class="subcard campaign-item-blocker" data-testid="campaign-item-blocker">
          ${item.blockerKind ? html`<span class="badge status-blocked_by_red">blocker: ${item.blockerKind}</span>` : null}
          ${item.reason ? html`<div style="margin-top: 4px;">${item.reason}</div>` : null}
          ${action ? html`<div class="campaign-item-action" data-testid="campaign-item-action"><span class="audit-axis-label">action</span> ${action}</div>` : null}
        </div>` : null}

      ${readiness && (readiness.outcome === "needs_refinement" || readiness.outcome === "blocked" || (item.outcome === "held" && item.blockerKind === "readiness")) ? html`
        <div class="campaign-item-axis"><span class="audit-axis-label">readiness</span> ${readiness.outcome}${readiness.gaps && readiness.gaps.length > 0 ? html` — <span class="muted">${readiness.gaps.join("; ")}</span>` : null}</div>` : null}

      ${audit ? html`
        <div class="campaign-item-axis" data-testid="campaign-item-audit">
          <span class="audit-axis-label">done-audit</span>
          <span class="badge ${audit.outcome === "pass" ? "status-complete" : "status-failed"}">${audit.outcome}</span>
          ${item.hostVerificationDetail ? html`<span class="muted" style="margin-left: 6px;">${item.hostVerificationDetail}</span>` : null}
          ${audit.outcome !== "pass" && audit.gaps && audit.gaps.length > 0 ? html`<div class="muted" style="margin-top: 2px;">gaps: ${audit.gaps.join("; ")}</div>` : null}
        </div>` : null}

      <${GitEvidenceBlock} git=${git} />

      <${ReconcileEvidence} rows=${reconcileRows} />

      <div class="campaign-item-axis muted" style="font-size: 11px;">
        <span class="audit-axis-label">verification</span> ${item.verificationState ?? "not available"}
      </div>
    </div>`;
}

// FG-367 v1 evidence layer — branch / worktree / closed commit / PR-state, all from
// report facts. The null/non-worktree and no-PR cases are rendered truthfully.
function GitEvidenceBlock({ git }) {
  return html`
    <div class="campaign-git" data-testid="campaign-git">
      <span class="audit-axis-label">git</span>
      ${git.managed
        ? html`<span class="mono" data-testid="campaign-git-managed">branch ${git.branch ?? "—"}${git.worktreePath ? ` · worktree ${git.worktreePath}` : ""}</span>`
        : html`<span class="muted" data-testid="campaign-git-unmanaged">not a Forge-managed worktree</span>`}
      <span class="mono" style="margin-left: 8px;">commit ${git.commitShort ?? "—"}</span>
      <span class="badge audit-not_observed" style="margin-left: 8px;" data-testid="campaign-pr-state">${git.prLabel}</span>
      <span class="badge ${git.pushState === "pushed" ? "status-complete" : git.pushState === "not_pushed" ? "status-failed" : "audit-not_observed"}" style="margin-left: 6px;" data-testid="campaign-push-state">${git.pushLabel}</span>
      ${git.pushActionHint ? html`<div class="campaign-item-action" data-testid="campaign-push-action"><span class="audit-axis-label">action</span> ${git.pushActionHint}</div>` : null}
    </div>`;
}
