// FG-821: the run page (#run/<runId>[/<tab>]; #run-map/<runId> is its permanent alias).
// Two tabs: `map` (the default — the Run Map, inline) and `evidence` (the reviews, host
// verifications and launches recorded for the run, each linking to its object). A map
// node links to that task's Explain page.
//
// The run is read by its global id with NO scope: an object page ignores the scope in
// hand, so an inbox click and a pasted link read — and title — the same run. The
// run-map read keeps FG-348's sequence guard: a response for a run navigated away from
// never repaints the one on screen.
//
// Evidence and the ticket crumb come from GET /api/run/:id/evidence — the union of the
// run's task links, read once per run. Host verifications bind to the run (every task
// of a run shows the same ones on its Explain page), so each links to the first task's
// Explain.

import { h } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import htm from "htm";
import { RunMap } from "./run-map.js";
import { readAttentionInbox } from "./attention-inbox-render.js";
import { breadcrumbTrail, parentHash } from "./breadcrumbs-render.js";
import { runHeader } from "./screen-header-render.js";
import { hashFor } from "./view-routing.js";
import { ObjectHead, ObjectTabs, useEscapeTo } from "./object-page-view.js";

const html = htm.bind(h);
const MAP_POLL_MS = 2000;

function useRunMap(runId) {
  const [state, setState] = useState({ graph: null, error: null });
  const seq = useRef(0);
  useEffect(() => {
    const mine = (seq.current += 1);
    setState({ graph: null, error: null });
    const read = async () => {
      try {
        const res = await fetch(`/api/run/${encodeURIComponent(runId)}/map`);
        if (mine !== seq.current) return;
        if (!res.ok) {
          setState((s) => ({ graph: s.graph, error: res.status === 404 ? `No run ${runId}.` : `Run map read failed (HTTP ${res.status}).` }));
          return;
        }
        // Re-check AFTER the body decode too: a run change during res.json() must not
        // render the retired graph.
        const graph = await res.json();
        if (mine !== seq.current) return;
        setState({ graph, error: null });
      } catch (e) {
        if (mine !== seq.current) return;
        setState((s) => ({ graph: s.graph, error: String(e) }));
      }
    };
    read();
    const timer = setInterval(read, MAP_POLL_MS);
    return () => {
      seq.current += 1;
      clearInterval(timer);
    };
  }, [runId]);
  return state;
}

/** GET /api/run/:id/evidence, read once per run; null while loading, `{ error }` when
 *  the read fails — never an empty union that would read as "nothing recorded". */
function useRunEvidence(runId) {
  const [state, setState] = useState({ runId: null, evidence: null });
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/run/${encodeURIComponent(runId)}/evidence`)
      .then(async (res) => (res.ok ? await res.json() : { error: `Evidence read failed (HTTP ${res.status}).` }))
      .catch((e) => ({ error: String(e) }))
      .then((evidence) => { if (!cancelled) setState({ runId, evidence }); });
    return () => { cancelled = true; };
  }, [runId]);
  return state.runId === runId ? state.evidence : null;
}

export function RunPage({ runId, tab, projects }) {
  const { graph, error } = useRunMap(runId);
  const [inbox, setInbox] = useState(null);
  const evidence = tab === "evidence";
  const runEvidence = useRunEvidence(runId);
  const ticketId = runEvidence?.ticketId ?? null;

  const runStatus = graph?.run?.status ?? null;
  useEffect(() => {
    let cancelled = false;
    readAttentionInbox(`/api/attention-inbox?runId=${encodeURIComponent(runId)}`).then((load) => { if (!cancelled) setInbox(load); });
    return () => { cancelled = true; };
  }, [runId, runStatus]);

  const payload = { projectDir: graph?.run?.projectDir ?? null, ticketId, runId, runTitle: graph?.run?.title ?? null };
  useEscapeTo(parentHash("run", payload));
  const tabs = [
    { id: "map", label: "Map", href: hashFor({ view: "run", id: runId }), current: !evidence },
    { id: "evidence", label: "Evidence", href: hashFor({ view: "run", id: runId, tab: "evidence" }), current: evidence },
  ];

  return html`
    <section class="object-page run-page" data-run-id=${runId}>
      <${ObjectHead} crumbs=${breadcrumbTrail("run", payload, projects)} title=${graph?.run?.title || "Run"} header=${runHeader(graph, inbox)} />
      <${ObjectTabs} id="run-views" label="Run views" tabs=${tabs}>
        ${error ? html`<div class="card" style="color: var(--err);" role="alert">${error}</div>` : null}
        ${evidence
          ? html`<${RunEvidence} graph=${graph} evidence=${runEvidence} />`
          : error && !graph ? null : html`<${RunMap} graph=${graph} hrefFor=${(taskId) => hashFor({ view: "task", id: taskId, tab: "explain" })} />`}
      <//>
    </section>
  `;
}

function EvidenceGroup({ title, kind, rows, empty }) {
  return html`
    <section class="run-evidence-group" data-evidence=${kind} aria-label=${title}>
      <h2>${title}</h2>
      ${rows.length === 0 ? html`<div class="muted">${empty}</div>` : html`<ul class="run-evidence-list">${rows}</ul>`}
    </section>
  `;
}

function RunEvidence({ graph, evidence }) {
  if (!graph || evidence === null) return html`<div class="muted">loading evidence…</div>`;
  if (evidence.error) return html`<div class="card" style="color: var(--err);" role="alert">${evidence.error}</div>`;
  const firstTask = graph.nodes[0] ?? null;
  return html`
    <div class="run-evidence">
      <${EvidenceGroup} title="Reviews" kind="reviews" empty="No review recorded for this run."
        rows=${evidence.reviewIds.map((id) => html`<li key=${id}><a class="mono" href=${hashFor({ view: "reviews", id })}>${id}</a></li>`)} />
      <${EvidenceGroup} title="Host verifications" kind="host-verifications" empty="No host verification recorded for this run's tasks."
        rows=${evidence.hostVerificationIds.map((id) => firstTask
          ? html`<li key=${id}><a href=${hashFor({ view: "task", id: firstTask.taskId, tab: "explain" })}><span class="mono">#${id}</span> on ${firstTask.role} <span class="faint mono">${firstTask.taskId}</span></a></li>`
          : html`<li key=${id}><span class="mono">#${id}</span></li>`)} />
      <${EvidenceGroup} title="Launches" kind="launches" empty="No launch recorded for this run."
        rows=${evidence.launchIds.map((id) => html`<li key=${id}><a class="mono" href=${`/api/launches/${encodeURIComponent(id)}`} target="_blank" rel="noopener">${id}</a> (<a href=${`/api/launches/${encodeURIComponent(id)}/log`} target="_blank" rel="noopener">log</a>)</li>`)} />
    </div>
  `;
}
