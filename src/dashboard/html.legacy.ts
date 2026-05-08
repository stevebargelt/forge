export function dashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Forge Dashboard</title>
  <script
    src="https://cdn.jsdelivr.net/npm/marked@9.1.6/marked.min.js"
    integrity="sha384-odPBjvtXVM/5hOYIr3A1dB+flh0c3wAT3bSesIOqEGmyUA4JoKf/YTWy0XKOYAY7"
    crossorigin="anonymous"></script>
  <script
    src="https://cdn.jsdelivr.net/npm/dompurify@3.0.6/dist/purify.min.js"
    integrity="sha384-cwS6YdhLI7XS60eoDiC+egV0qHp8zI+Cms46R0nbn8JrmoAzV9uFL60etMZhAnSu"
    crossorigin="anonymous"></script>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; background: #f5f5f5; color: #222; }
    header { background: #1a1a2e; color: #fff; padding: 1rem 2rem; display: flex; align-items: center; gap: 1rem; }
    header h1 { font-size: 1.25rem; font-weight: 600; }
    .badge { font-size: 0.7rem; padding: 2px 8px; border-radius: 999px; font-weight: 600; text-transform: uppercase; }
    .badge-active { background: #22c55e; color: #fff; }
    .badge-complete { background: #6366f1; color: #fff; }
    .badge-abandoned { background: #94a3b8; color: #fff; }
    .badge-running { background: #f59e0b; color: #fff; }
    .badge-pending { background: #e2e8f0; color: #555; }
    .badge-failed { background: #ef4444; color: #fff; }
    .badge-awaiting_gate { background: #a78bfa; color: #fff; }
    .badge-blocked_by_red { background: #f97316; color: #fff; }
    .badge-pass { background: #22c55e; color: #fff; }
    .badge-fail { background: #ef4444; color: #fff; }
    .badge-inconclusive { background: #94a3b8; color: #fff; }
    main { max-width: 1100px; margin: 2rem auto; padding: 0 1rem; }
    .card { background: #fff; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); margin-bottom: 1rem; }
    .card-header { padding: 1rem 1.5rem; border-bottom: 1px solid #f0f0f0; display: flex; align-items: center; gap: 0.75rem; cursor: pointer; }
    .card-header h2 { font-size: 1rem; font-weight: 600; flex: 1; }
    .card-body { padding: 1.5rem; }
    .runs-list { display: flex; flex-direction: column; gap: 0.75rem; }
    .run-item { background: #fff; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); padding: 1rem 1.5rem; cursor: pointer; display: flex; align-items: center; gap: 1rem; transition: box-shadow 0.1s; }
    .run-item:hover { box-shadow: 0 2px 8px rgba(0,0,0,0.12); }
    .run-item .run-title { flex: 1; font-weight: 500; }
    .run-item .run-meta { font-size: 0.8rem; color: #888; }
    #run-detail { display: none; }
    #run-detail.visible { display: block; }
    .tasks-table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
    .tasks-table th { text-align: left; padding: 0.5rem 0.75rem; border-bottom: 2px solid #e5e7eb; font-weight: 600; color: #555; }
    .tasks-table td { padding: 0.5rem 0.75rem; border-bottom: 1px solid #f0f0f0; }
    .tasks-table tr:last-child td { border-bottom: none; }
    .tasks-table tr:hover td { background: #f9fafb; }
    .tasks-table .clickable { cursor: pointer; color: #4f46e5; text-decoration: underline; }
    #task-detail { display: none; }
    #task-detail.visible { display: block; }
    .back-btn { display: inline-flex; align-items: center; gap: 0.4rem; background: none; border: none; color: #4f46e5; font-size: 0.9rem; cursor: pointer; padding: 0; margin-bottom: 1rem; }
    .back-btn:hover { text-decoration: underline; }
    .section-title { font-size: 0.8rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: #888; margin-bottom: 0.75rem; }
    .markdown-body { font-size: 0.9rem; line-height: 1.6; }
    .markdown-body h1, .markdown-body h2, .markdown-body h3 { margin: 1rem 0 0.5rem; }
    .markdown-body p { margin-bottom: 0.75rem; }
    .markdown-body ul, .markdown-body ol { padding-left: 1.5rem; margin-bottom: 0.75rem; }
    .markdown-body code { background: #f1f5f9; padding: 1px 4px; border-radius: 3px; font-size: 0.85em; }
    .markdown-body pre { background: #f1f5f9; padding: 0.75rem; border-radius: 6px; overflow-x: auto; margin-bottom: 0.75rem; }
    pre.json { background: #f1f5f9; padding: 0.75rem; border-radius: 6px; overflow-x: auto; font-size: 0.8rem; }
    .findings { display: flex; flex-direction: column; gap: 0.75rem; }
    .finding { border-left: 3px solid #e5e7eb; padding: 0.75rem 1rem; background: #fafafa; border-radius: 0 6px 6px 0; }
    .finding.high { border-color: #ef4444; }
    .finding.medium { border-color: #f59e0b; }
    .finding.low { border-color: #22c55e; }
    .finding-summary { font-weight: 600; margin-bottom: 0.5rem; }
    .finding-label { font-size: 0.75rem; font-weight: 600; text-transform: uppercase; color: #888; margin-top: 0.5rem; }
    .gate-item { display: flex; gap: 1rem; align-items: flex-start; padding: 0.75rem 0; border-bottom: 1px solid #f0f0f0; }
    .gate-item:last-child { border-bottom: none; }
    .spinner { display: inline-block; width: 10px; height: 10px; border: 2px solid #f59e0b; border-top-color: transparent; border-radius: 50%; animation: spin 0.6s linear infinite; margin-left: 6px; vertical-align: middle; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .error-msg { color: #ef4444; font-size: 0.85rem; padding: 0.5rem; background: #fef2f2; border-radius: 6px; }
  </style>
</head>
<body>
  <header>
    <h1>Forge Dashboard</h1>
    <span id="poll-indicator" style="display:none"><span class="spinner"></span> Live</span>
  </header>
  <main>
    <div id="runs-view">
      <p class="section-title" style="margin-bottom:1rem">Runs</p>
      <div id="runs-list" class="runs-list"><p style="color:#888">Loading…</p></div>
    </div>
    <div id="run-detail">
      <button class="back-btn" id="back-to-runs">&#8592; All runs</button>
      <div id="run-detail-card" class="card">
        <div class="card-body"><p style="color:#888">Loading…</p></div>
      </div>
    </div>
    <div id="task-detail">
      <button class="back-btn" id="back-to-run">&#8592; Back to run</button>
      <div id="task-detail-card" class="card">
        <div class="card-body"><p style="color:#888">Loading…</p></div>
      </div>
    </div>
  </main>
  <script>
    (function () {
      let currentRunId = null;
      let currentTaskId = null;
      let pollInterval = null;

      function md(text) {
        if (!text) return '';
        return DOMPurify.sanitize(marked.parse(text));
      }

      function badge(status) {
        const span = document.createElement('span');
        span.className = 'badge badge-' + status;
        span.textContent = status;
        return span;
      }

      function el(tag, cls, text) {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text !== undefined) e.textContent = text;
        return e;
      }

      function showView(name) {
        document.getElementById('runs-view').style.display = name === 'runs' ? '' : 'none';
        const rd = document.getElementById('run-detail');
        rd.style.display = name === 'run' ? '' : 'none';
        rd.classList.toggle('visible', name === 'run');
        const td = document.getElementById('task-detail');
        td.style.display = name === 'task' ? '' : 'none';
        td.classList.toggle('visible', name === 'task');
      }

      function stopPoll() {
        if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
        document.getElementById('poll-indicator').style.display = 'none';
      }

      function startPoll(fn) {
        stopPoll();
        document.getElementById('poll-indicator').style.display = '';
        pollInterval = setInterval(fn, 2000);
      }

      // ── Runs list ──────────────────────────────────────────────────────────
      async function loadRuns() {
        const res = await fetch('/api/runs');
        const data = await res.json();
        renderRuns(data.runs);
      }

      function renderRuns(runs) {
        const container = document.getElementById('runs-list');
        container.innerHTML = '';
        if (!runs.length) {
          container.textContent = 'No runs yet.';
          return;
        }
        for (const run of runs) {
          const item = el('div', 'run-item');
          const titleEl = el('span', 'run-title');
          titleEl.textContent = run.title;
          item.appendChild(titleEl);
          item.appendChild(badge(run.status));
          const meta = el('span', 'run-meta');
          meta.textContent = run.createdAt;
          item.appendChild(meta);
          item.addEventListener('click', () => openRun(run.id));
          container.appendChild(item);
        }
      }

      // ── Run detail ─────────────────────────────────────────────────────────
      async function openRun(runId) {
        currentRunId = runId;
        currentTaskId = null;
        stopPoll();
        showView('run');
        await fetchAndRenderRun();
      }

      async function fetchAndRenderRun() {
        const res = await fetch('/api/runs/' + currentRunId);
        if (!res.ok) {
          document.getElementById('run-detail-card').innerHTML = '<div class="card-body"><p class="error-msg">Run not found.</p></div>';
          return;
        }
        const data = await res.json();
        renderRun(data);
        if (data.shouldPoll) {
          startPoll(fetchAndRenderRun);
        } else {
          stopPoll();
        }
      }

      function renderRun(data) {
        const { run, tasks, verdicts } = data;
        const card = document.getElementById('run-detail-card');
        card.innerHTML = '';

        const hdr = el('div', 'card-header');
        const title = el('h2');
        title.textContent = run.title;
        hdr.appendChild(title);
        hdr.appendChild(badge(run.status));
        const meta = el('span', 'run-meta');
        meta.textContent = run.workflow + ' · ' + run.createdAt;
        hdr.appendChild(meta);
        card.appendChild(hdr);

        const body = el('div', 'card-body');

        const tableWrap = document.createElement('div');
        tableWrap.style.overflowX = 'auto';
        const table = document.createElement('table');
        table.className = 'tasks-table';
        const thead = document.createElement('thead');
        const hr = document.createElement('tr');
        for (const h of ['ID', 'Phase', 'Role', 'Status', 'Created']) {
          const th = document.createElement('th');
          th.textContent = h;
          hr.appendChild(th);
        }
        thead.appendChild(hr);
        table.appendChild(thead);

        const tbody = document.createElement('tbody');
        for (const task of tasks) {
          const tr = document.createElement('tr');
          const tdId = document.createElement('td');
          tdId.className = 'clickable';
          tdId.textContent = task.id;
          tdId.addEventListener('click', () => openTask(task.id));
          tr.appendChild(tdId);
          const tdPhase = document.createElement('td');
          tdPhase.textContent = task.phase;
          tr.appendChild(tdPhase);
          const tdRole = document.createElement('td');
          tdRole.textContent = task.agentRole;
          tr.appendChild(tdRole);
          const tdStatus = document.createElement('td');
          tdStatus.appendChild(badge(task.status));
          tr.appendChild(tdStatus);
          const tdCreated = document.createElement('td');
          tdCreated.textContent = task.createdAt;
          tr.appendChild(tdCreated);
          tbody.appendChild(tr);
        }
        table.appendChild(tbody);
        tableWrap.appendChild(table);
        body.appendChild(tableWrap);
        card.appendChild(body);
      }

      // ── Task detail ────────────────────────────────────────────────────────
      async function openTask(taskId) {
        currentTaskId = taskId;
        stopPoll();
        showView('task');
        const res = await fetch('/api/tasks/' + taskId);
        if (!res.ok) {
          document.getElementById('task-detail-card').innerHTML = '<div class="card-body"><p class="error-msg">Task not found.</p></div>';
          return;
        }
        const data = await res.json();
        renderTask(data);
      }

      function renderTask(data) {
        const { task, verdicts, gates } = data;
        const card = document.getElementById('task-detail-card');
        card.innerHTML = '';

        const hdr = el('div', 'card-header');
        const title = el('h2');
        title.textContent = task.id;
        hdr.appendChild(title);
        hdr.appendChild(badge(task.status));
        card.appendChild(hdr);

        const body = el('div', 'card-body');

        // Meta
        const meta = el('div');
        meta.style.marginBottom = '1.5rem';
        const metaLines = [
          ['Run', task.runId],
          ['Phase', task.phase],
          ['Role', task.agentRole],
          ['Created', task.createdAt],
        ];
        if (task.startedAt) metaLines.push(['Started', task.startedAt]);
        if (task.completedAt) metaLines.push(['Completed', task.completedAt]);
        if (task.error) metaLines.push(['Error', task.error]);
        for (const [k, v] of metaLines) {
          const row = el('div');
          row.style.display = 'flex';
          row.style.gap = '0.5rem';
          row.style.marginBottom = '0.25rem';
          row.style.fontSize = '0.85rem';
          const lbl = el('span');
          lbl.style.fontWeight = '600';
          lbl.style.minWidth = '90px';
          lbl.style.color = '#666';
          lbl.textContent = k + ':';
          row.appendChild(lbl);
          const val = el('span');
          val.textContent = v;
          row.appendChild(val);
          meta.appendChild(row);
        }
        body.appendChild(meta);

        // Result
        if (task.result) {
          const result = task.result;
          const sec = el('div');
          sec.style.marginBottom = '1.5rem';
          const sTitle = el('p', 'section-title');
          sTitle.textContent = 'Result';
          sec.appendChild(sTitle);

          if (typeof result === 'object' && result !== null) {
            const r = result;
            for (const field of ['report', 'recommendation', 'summary']) {
              if (r[field] && typeof r[field] === 'string') {
                const fTitle = el('p');
                fTitle.style.fontWeight = '600';
                fTitle.style.marginBottom = '0.25rem';
                fTitle.style.fontSize = '0.85rem';
                fTitle.textContent = field.charAt(0).toUpperCase() + field.slice(1);
                sec.appendChild(fTitle);
                const fBody = el('div', 'markdown-body');
                fBody.innerHTML = md(r[field]);
                sec.appendChild(fBody);
              }
            }
          }

          const pre = document.createElement('pre');
          pre.className = 'json';
          pre.textContent = JSON.stringify(task.result, null, 2);
          sec.appendChild(pre);
          body.appendChild(sec);
        }

        // Verdicts
        if (verdicts.length > 0) {
          const sec = el('div');
          sec.style.marginBottom = '1.5rem';
          const sTitle = el('p', 'section-title');
          sTitle.textContent = 'Verdicts';
          sec.appendChild(sTitle);

          for (const v of verdicts) {
            const vCard = el('div', 'card');
            vCard.style.marginBottom = '0.75rem';
            const vHdr = el('div', 'card-header');
            vHdr.style.cursor = 'default';
            const vTitle = el('h2');
            vTitle.textContent = v.redRole + ' (' + v.authority + ')';
            vHdr.appendChild(vTitle);
            vHdr.appendChild(badge(v.verdict));
            const conf = el('span', 'run-meta');
            conf.textContent = 'confidence: ' + v.confidence.toFixed(2);
            vHdr.appendChild(conf);
            vCard.appendChild(vHdr);

            if (v.findings.length > 0) {
              const vBody = el('div', 'card-body');
              const findings = el('div', 'findings');
              for (const f of v.findings) {
                const fEl = el('div', 'finding ' + f.severity);
                const fSum = el('div', 'finding-summary');
                fSum.textContent = '[' + f.severity + '] ' + f.summary;
                fEl.appendChild(fSum);

                const evLbl = el('div', 'finding-label');
                evLbl.textContent = 'Evidence';
                fEl.appendChild(evLbl);
                const evBody = el('div', 'markdown-body');
                evBody.innerHTML = md(f.evidence);
                fEl.appendChild(evBody);

                const hypLbl = el('div', 'finding-label');
                hypLbl.textContent = 'Hypothesis';
                fEl.appendChild(hypLbl);
                const hypBody = el('div', 'markdown-body');
                hypBody.innerHTML = md(f.hypothesis);
                fEl.appendChild(hypBody);

                findings.appendChild(fEl);
              }
              vBody.appendChild(findings);
              vCard.appendChild(vBody);
            }
            sec.appendChild(vCard);
          }
          body.appendChild(sec);
        }

        // Gates
        if (gates.length > 0) {
          const sec = el('div');
          const sTitle = el('p', 'section-title');
          sTitle.textContent = 'Gates';
          sec.appendChild(sTitle);
          for (const g of gates) {
            const gItem = el('div', 'gate-item');
            gItem.appendChild(badge(g.decision));
            const gInfo = el('div');
            gInfo.style.flex = '1';
            const gMeta = el('div', 'run-meta');
            gMeta.textContent = g.decidedBy + ' · ' + g.decidedAt;
            gInfo.appendChild(gMeta);
            if (g.rationale) {
              const gRat = el('div');
              gRat.style.fontSize = '0.85rem';
              gRat.style.marginTop = '0.25rem';
              gRat.textContent = g.rationale;
              gInfo.appendChild(gRat);
            }
            gItem.appendChild(gInfo);
            sec.appendChild(gItem);
          }
          body.appendChild(sec);
        }

        card.appendChild(body);
      }

      // ── Navigation ─────────────────────────────────────────────────────────
      document.getElementById('back-to-runs').addEventListener('click', () => {
        stopPoll();
        currentRunId = null;
        showView('runs');
        loadRuns();
      });

      document.getElementById('back-to-run').addEventListener('click', () => {
        currentTaskId = null;
        if (currentRunId) openRun(currentRunId);
        else { showView('runs'); loadRuns(); }
      });

      // Initial load
      showView('runs');
      loadRuns();
    })();
  </script>
</body>
</html>`;
}
