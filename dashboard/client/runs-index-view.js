// FG-821: the run index (#runs[?scope&status=]). A list over GET /api/runs — the rows
// core's queryRuns returns, what `forge runs query` prints — with a status filter carried
// in the hash and "load more" over the server's keyset cursor. It polls at 30s (the
// server memoizes the walk for the same interval), re-reading everything shown so a
// loaded page never goes stale under a fresh first page. It adds no decisions:
// runs-index-render.js builds the rows, filters and badge.

import { h } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import htm from "htm";
import { MONO_CLASS, formatTimestamp } from "./format.js";
import { badgeClass, statusLabel } from "./status-tokens.js";
import { RUNS_MAX_LIMIT, RUNS_PAGE_SIZE, RUNS_POLL_MS, readRuns, runRow, runsUrl, statusFilters } from "./runs-index-render.js";

const html = htm.bind(h);

/**
 * `onLoad(load)` hands every first-page read up to the shell, so the Runs badge shows the
 * activeCount of the very response this list rendered.
 */
export function RunsIndexView({ scope, status, projects, onLoad }) {
  const [state, setState] = useState({ key: null, runs: [], nextCursor: null, load: null, more: false, moreError: null });
  const key = JSON.stringify([scope?.project ?? null, scope?.checkout ?? null, status ?? null]);
  const shown = useRef(RUNS_PAGE_SIZE);
  const seq = useRef(0);

  useEffect(() => {
    shown.current = RUNS_PAGE_SIZE;
    const read = async () => {
      const mine = (seq.current += 1);
      const load = await readRuns(runsUrl({ scope, status, limit: Math.min(shown.current, RUNS_MAX_LIMIT) }));
      if (mine !== seq.current) return;
      onLoad?.(load);
      setState((s) => (load.phase === "ready"
        ? { key, runs: load.body.runs, nextCursor: load.body.nextCursor ?? null, load, more: false, moreError: null }
        : { ...s, key, load, runs: s.key === key ? s.runs : [], nextCursor: s.key === key ? s.nextCursor : null }));
    };
    read();
    const timer = setInterval(read, RUNS_POLL_MS);
    return () => {
      seq.current += 1;
      clearInterval(timer);
    };
  }, [key]);

  const loadMore = async () => {
    if (!state.nextCursor) return;
    const mine = seq.current;
    setState((s) => ({ ...s, more: true, moreError: null }));
    const load = await readRuns(runsUrl({ scope, status, cursor: state.nextCursor, limit: RUNS_PAGE_SIZE }));
    if (mine !== seq.current) return;
    if (load.phase !== "ready") {
      setState((s) => ({ ...s, more: false, moreError: "Could not read the next page." }));
      return;
    }
    setState((s) => {
      const runs = [...s.runs, ...load.body.runs];
      shown.current = runs.length;
      return { ...s, runs, nextCursor: load.body.nextCursor ?? null, more: false };
    });
  };

  const current = state.key === key ? state : { runs: [], nextCursor: null, load: null, more: false, moreError: null };
  const now = Date.now();
  return html`
    <section class="runs-index" aria-label="Run index">
      <nav class="runs-filters" aria-label="Filter runs by status">
        <span class="muted">status:</span>
        ${statusFilters(scope, status).map((f) => html`
          <a
            key=${f.label}
            class=${"usage-dim-btn" + (f.current ? " usage-dim-btn-active" : "")}
            href=${f.href}
            aria-current=${f.current ? "page" : undefined}
            data-status=${f.value ?? "all"}
          >${f.label}</a>
        `)}
      </nav>
      ${current.load === null
        ? html`<div class="muted">loading runs…</div>`
        : current.load.phase !== "ready" && current.runs.length === 0
        ? html`<div class="card" style="color: var(--err);" role="alert">The run index is unreadable${current.load.body?.error ? `: ${current.load.body.error}` : ""}. Nothing here means no runs; it means no answer.</div>`
        : current.runs.length === 0
        ? html`<div class="muted runs-empty">${status ? `No ${status} runs in this scope.` : "No runs in this scope."}</div>`
        : html`
          <div class="runs-table-wrap">
            <table class="runs-table">
              <thead>
                <tr><th scope="col">run</th><th scope="col">project</th><th scope="col">ticket</th><th scope="col">status</th><th scope="col">started</th><th scope="col">duration</th></tr>
              </thead>
              <tbody>
                ${current.runs.map((run) => {
                  const row = runRow(run, projects, now);
                  return html`
                    <tr key=${row.runId} data-run-id=${row.runId}>
                      <td><a href=${row.href}>${row.title}</a><div class="faint mono runs-id">${row.runId}</div></td>
                      <td><a href=${row.project.href}>${row.project.label}</a></td>
                      <td>${row.ticket ? html`<a href=${row.ticket.href}>${row.ticket.label}</a>` : html`<span class="faint">—</span>`}</td>
                      <td><span class=${badgeClass("run", row.status)}>${statusLabel("run", row.status)}</span></td>
                      <td class=${MONO_CLASS} title=${row.startedAt}>${formatTimestamp(row.startedAt)}</td>
                      <td class="mono">${row.duration}</td>
                    </tr>
                  `;
                })}
              </tbody>
            </table>
          </div>
          ${current.load.phase !== "ready" ? html`<div class="muted" role="status">The last refresh failed; showing the rows already read.</div>` : null}
          ${current.moreError ? html`<div class="muted" role="status">${current.moreError}</div>` : null}
          ${current.nextCursor
            ? html`<button type="button" class="runs-load-more" onClick=${loadMore} disabled=${current.more}>${current.more ? "loading…" : "Load more"}</button>`
            : null}
        `}
    </section>
  `;
}
