// Forge dashboard — server-rendered HTML shell.
//
// The dashboard is a single-page app. The shell is rendered once by `dashboardHtml()`
// and then JavaScript fetches `/api/...` endpoints and re-renders panes client-side.
// All styling uses CSS variables sourced from the Lunaris palette (the same tokens
// declared in ~/code/forge-design/dashboard.pen — keep these in sync if the .pen
// file's variables block changes).

export function dashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Forge Dashboard</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Geist+Mono:wght@400;500;600&family=Geist:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>${BASE_CSS}</style>
</head>
<body>
  <div id="app">
    <aside id="sidebar" class="pane pane-sidebar"></aside>
    <section id="middle" class="pane pane-middle"></section>
    <section id="detail" class="pane pane-detail"></section>
  </div>
  <div id="modal-root"></div>
  <div id="toast-root"></div>
  <script>${CLIENT_JS}</script>
</body>
</html>`;
}

const BASE_CSS = `
:root {
  --accent: #582CFF;
  --accent-hover: #6B40FF;
  --accent-secondary: #BF40FF;
  --accent-subtle: #1A0F40;
  --accent-tertiary: #00F2FF;
  --background: #080810;
  --background-elevated: #0D0D1A;
  --surface: #111124;
  --surface-raised: #161630;
  --border: #1E1E3A;
  --border-bright: #2E2E55;
  --foreground: #F0F0FF;
  --foreground-secondary: #A1A1C0;
  --foreground-muted: #5A5A7A;
  --pending: #6B7280;
  --running: #00F2FF;
  --success: #22C55E;
  --success-bg: #0A2016;
  --warning: #F59E0B;
  --warning-bg: #201505;
  --error: #EF4444;
  --error-bg: #200A0A;
  --radius-sm: 3px;
  --radius-md: 6px;
  --space-xs: 4px;
  --space-sm: 8px;
  --space-md: 16px;
  --space-lg: 24px;
  --space-xl: 32px;
  --font-mono: 'Geist Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
  --font-sans: 'Geist', -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { height: 100%; }
body {
  font-family: var(--font-mono);
  font-size: 13px;
  background: var(--background);
  color: var(--foreground);
  -webkit-font-smoothing: antialiased;
}
button { font-family: inherit; font-size: inherit; cursor: pointer; }
input, textarea { font-family: inherit; font-size: inherit; color: inherit; }
a { color: var(--accent); text-decoration: none; }

#app {
  display: grid;
  grid-template-columns: 280px 360px 1fr;
  height: 100vh;
  overflow: hidden;
}
.pane {
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}
.pane-detail { border-right: none; }
.pane-header {
  padding: var(--space-md);
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--foreground-muted);
  flex-shrink: 0;
}
.pane-header .label { font-weight: 600; }
.pane-body { flex: 1; overflow-y: auto; padding: var(--space-md); }
.pane-body.no-pad { padding: 0; }

.brand {
  padding: var(--space-md);
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.brand-logo {
  width: 16px; height: 16px;
  border-radius: 50%;
  border: 2px solid var(--accent);
  flex-shrink: 0;
}
.brand-name { font-weight: 700; letter-spacing: 0.1em; font-size: 12px; color: var(--foreground); }

.search {
  padding: var(--space-md);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.search input {
  width: 100%;
  background: var(--background-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: 8px 10px;
  color: var(--foreground);
  font-size: 12px;
}
.search input::placeholder { color: var(--foreground-muted); }
.search input:focus { outline: none; border-color: var(--accent); }

.list-header {
  padding: var(--space-md) var(--space-md) var(--space-sm);
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--foreground-muted);
  flex-shrink: 0;
}
.list-header .count { color: var(--foreground-muted); }
.list-header .new-btn {
  background: var(--accent-subtle);
  color: var(--accent-secondary);
  border: 1px solid var(--accent);
  border-radius: var(--radius-sm);
  padding: 2px 8px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}
.list-header .new-btn:hover { background: var(--accent); color: #fff; }

.run-row, .task-row {
  padding: var(--space-sm) var(--space-md);
  border-left: 2px solid transparent;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-sm);
  border-bottom: 1px solid transparent;
}
.run-row:hover, .task-row:hover { background: var(--background-elevated); }
.run-row.selected, .task-row.selected {
  background: var(--accent-subtle);
  border-left-color: var(--accent);
}
.run-row .row-main, .task-row .row-main { flex: 1; min-width: 0; }
.run-row .row-id, .task-row .row-id {
  font-weight: 600;
  color: var(--foreground);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.run-row .row-meta, .task-row .row-meta {
  font-size: 11px;
  color: var(--foreground-muted);
  margin-top: 2px;
  display: flex;
  gap: var(--space-sm);
}
.run-row .row-meta span + span::before { content: '·'; margin-right: var(--space-sm); color: var(--border-bright); }
.run-row .row-side, .task-row .row-side {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 2px;
  flex-shrink: 0;
}

.badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 10px;
  text-transform: lowercase;
  letter-spacing: 0.04em;
  padding: 2px 6px;
  border-radius: var(--radius-sm);
  font-weight: 500;
  white-space: nowrap;
}
.badge::before {
  content: '';
  width: 6px; height: 6px;
  border-radius: 50%;
  background: currentColor;
  flex-shrink: 0;
}
.badge.status-running, .badge.status-active { color: var(--running); }
.badge.status-success, .badge.status-complete, .badge.verdict-pass { color: var(--success); }
.badge.status-pending { color: var(--pending); }
.badge.status-failed, .badge.verdict-fail { color: var(--error); }
.badge.status-warning, .badge.status-awaiting_gate { color: var(--warning); }
.badge.status-blocked_by_red { color: var(--error); background: var(--error-bg); }
.badge.status-approved { color: var(--success); }
.badge.status-abandoned, .badge.verdict-inconclusive { color: var(--foreground-muted); }
.badge.solid-running { background: var(--running); color: var(--background); }
.badge.solid-warning { background: var(--warning); color: var(--background); }
.badge.solid-error { background: var(--error); color: #fff; }

.row-meta .duration::before { content: ''; margin: 0; }

.middle-header {
  padding: var(--space-md);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.crumb {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--foreground-muted);
  margin-bottom: var(--space-sm);
}
.crumb .sep { margin: 0 6px; color: var(--border-bright); }
.crumb .current { color: var(--foreground); }
.run-meta-strip {
  display: flex;
  gap: var(--space-lg);
  margin-top: var(--space-sm);
  font-size: 11px;
  color: var(--foreground-muted);
}
.run-meta-strip .key { display: block; color: var(--foreground-muted); margin-bottom: 2px; }
.run-meta-strip .val { color: var(--foreground); font-weight: 500; }

.empty-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: var(--foreground-muted);
  font-size: 12px;
  text-align: center;
  padding: var(--space-xl);
}
.empty-state svg { opacity: 0.3; margin-bottom: var(--space-md); }

.detail-section {
  border-bottom: 1px solid var(--border);
  padding: var(--space-md);
}
.detail-section:last-child { border-bottom: none; }
.detail-section h3 {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--foreground-muted);
  font-weight: 600;
  margin-bottom: var(--space-sm);
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.kv-row {
  display: grid;
  grid-template-columns: 100px 1fr;
  gap: var(--space-sm);
  padding: 4px 0;
  font-size: 12px;
}
.kv-row .k { color: var(--foreground-muted); }
.kv-row .v { color: var(--foreground); word-break: break-word; }
.kv-row .v code { font-size: 11px; background: var(--background-elevated); padding: 1px 4px; border-radius: var(--radius-sm); }

.input-row {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: 8px 12px;
  margin-bottom: 6px;
  font-size: 12px;
}
.input-row .label {
  color: var(--foreground-muted);
  margin-right: var(--space-sm);
}
.input-row .type {
  color: var(--accent-tertiary);
  font-size: 10px;
  margin: 0 var(--space-sm);
}

.log-stream {
  background: var(--background);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  font-family: var(--font-mono);
  font-size: 11px;
  padding: var(--space-sm);
  max-height: 240px;
  overflow-y: auto;
}
.log-stream .line { display: flex; gap: var(--space-sm); padding: 2px 0; }
.log-stream .ts { color: var(--foreground-muted); flex-shrink: 0; }
.log-stream .lvl { font-weight: 600; flex-shrink: 0; width: 40px; }
.log-stream .lvl.info { color: var(--accent-tertiary); }
.log-stream .lvl.warn { color: var(--warning); }
.log-stream .lvl.err { color: var(--error); }

.gate-actions {
  display: grid;
  grid-template-columns: 1fr 1fr 1.4fr;
  gap: var(--space-sm);
  margin-bottom: var(--space-md);
}
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 10px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--surface);
  color: var(--foreground);
  font-weight: 500;
  font-size: 12px;
  transition: background 0.1s, border-color 0.1s;
}
.btn:hover { background: var(--surface-raised); border-color: var(--border-bright); }
.btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-reject { color: var(--error); border-color: var(--error); }
.btn-reject:hover { background: var(--error-bg); }
.btn-warning { color: var(--warning); border-color: var(--warning); }
.btn-warning:hover { background: var(--warning-bg); }
.btn-primary {
  background: var(--accent);
  color: #fff;
  border-color: var(--accent);
  font-weight: 600;
}
.btn-primary:hover { background: var(--accent-hover); border-color: var(--accent-hover); }
.btn-danger {
  background: var(--error);
  color: #fff;
  border-color: var(--error);
  font-weight: 600;
}
.btn-ghost { background: transparent; }
.btn-sm { padding: 4px 10px; font-size: 11px; }

.rationale {
  width: 100%;
  background: var(--background-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: 8px 10px;
  color: var(--foreground);
  resize: vertical;
  min-height: 80px;
  font-family: var(--font-mono);
}
.rationale:focus { outline: none; border-color: var(--accent); }
.rationale::placeholder { color: var(--foreground-muted); }

.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}
.modal {
  background: var(--surface);
  border: 1px solid var(--border-bright);
  border-radius: var(--radius-md);
  width: 560px;
  max-width: 90vw;
  max-height: 90vh;
  display: flex;
  flex-direction: column;
}
.modal-header {
  padding: var(--space-md);
  border-bottom: 1px solid var(--border);
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.modal-body { padding: var(--space-md); overflow-y: auto; }
.modal-footer {
  padding: var(--space-md);
  border-top: 1px solid var(--border);
  display: flex;
  justify-content: flex-end;
  gap: var(--space-sm);
}
.modal-close { background: none; border: none; color: var(--foreground-muted); font-size: 14px; }
.modal-close:hover { color: var(--foreground); }

.cli-block {
  background: var(--background);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: var(--space-md);
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--foreground-secondary);
  white-space: pre-wrap;
  word-break: break-all;
  position: relative;
}
.cli-block .copy {
  position: absolute;
  top: 6px;
  right: 6px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 2px 8px;
  font-size: 10px;
  color: var(--accent-tertiary);
}
.cli-block .copy:hover { background: var(--accent-subtle); border-color: var(--accent); }

.alert-banner {
  background: var(--error-bg);
  border-bottom: 1px solid var(--error);
  color: var(--error);
  padding: var(--space-sm) var(--space-md);
  font-size: 11px;
  display: flex;
  align-items: center;
  gap: var(--space-sm);
}
.alert-banner.warn { background: var(--warning-bg); border-color: var(--warning); color: var(--warning); }

.verdict-card {
  background: var(--error-bg);
  border: 1px solid var(--error);
  border-radius: var(--radius-md);
  padding: var(--space-sm) var(--space-md);
  margin-bottom: var(--space-md);
  font-size: 11px;
}
.verdict-card .finding { display: flex; gap: var(--space-sm); padding: 4px 0; }
.verdict-card .severity { font-weight: 600; flex-shrink: 0; }

.thread { display: flex; flex-direction: column; gap: var(--space-sm); margin-bottom: var(--space-md); }
.thread-msg {
  background: var(--background-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: var(--space-sm) var(--space-md);
  font-size: 12px;
  line-height: 1.5;
}
.thread-msg .who {
  display: flex;
  justify-content: space-between;
  font-size: 10px;
  color: var(--accent-tertiary);
  margin-bottom: 4px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.thread-msg .who .ts { color: var(--foreground-muted); }
.thread-msg.from-human .who { color: var(--foreground-secondary); }

.png-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: var(--space-sm);
}
.png-tile {
  background: var(--background-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  aspect-ratio: 4/3;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--foreground-muted);
  font-size: 11px;
}

.toast {
  position: fixed;
  bottom: var(--space-md);
  right: var(--space-md);
  background: var(--surface-raised);
  border: 1px solid var(--border-bright);
  border-radius: var(--radius-md);
  padding: var(--space-sm) var(--space-md);
  font-size: 12px;
  z-index: 200;
  animation: slide-in 0.15s ease-out;
  max-width: 360px;
}
.toast.success { border-color: var(--success); color: var(--success); }
.toast.error { border-color: var(--error); color: var(--error); }
@keyframes slide-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }

.bottom-nav {
  border-top: 1px solid var(--border);
  padding: var(--space-sm) var(--space-md);
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex-shrink: 0;
}
.bottom-nav .item {
  font-size: 11px;
  color: var(--foreground-muted);
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  padding: 2px 0;
}
.bottom-nav .item:hover { color: var(--foreground-secondary); }

.icon { width: 12px; height: 12px; flex-shrink: 0; }
.kbd {
  display: inline-block;
  font-size: 10px;
  background: var(--background-elevated);
  border: 1px solid var(--border);
  border-radius: 3px;
  padding: 1px 5px;
  color: var(--foreground-secondary);
}

.menu {
  position: absolute;
  background: var(--surface);
  border: 1px solid var(--border-bright);
  border-radius: var(--radius-md);
  min-width: 180px;
  padding: 4px;
  z-index: 50;
  box-shadow: 0 4px 16px rgba(0,0,0,0.4);
}
.menu .item {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  padding: 6px 10px;
  border-radius: var(--radius-sm);
  font-size: 12px;
  color: var(--foreground);
  cursor: pointer;
}
.menu .item:hover { background: var(--accent-subtle); color: var(--accent-secondary); }
.menu .item.danger { color: var(--error); }
.menu .item.danger:hover { background: var(--error-bg); color: var(--error); }
.menu .sep { height: 1px; background: var(--border); margin: 4px 0; }
`;

const CLIENT_JS = `
(function() {
  const state = {
    runs: [],
    selectedRunId: null,
    runDetail: null,
    selectedTaskId: null,
    taskDetail: null,
    pollTimer: null,
    interactive: false,
    openMenuTaskId: null,
  };

  // ---------- helpers ----------
  function $(id) { return document.getElementById(id); }
  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const k of Object.keys(attrs)) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'html') node.innerHTML = attrs[k];
        else if (k.startsWith('on')) node.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] !== undefined && attrs[k] !== null) node.setAttribute(k, attrs[k]);
      }
    }
    if (children) {
      for (const c of [].concat(children)) {
        if (c == null) continue;
        node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
      }
    }
    return node;
  }
  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
  }
  function shortId(id) {
    if (!id) return '';
    return id.length > 14 ? id.slice(0, 14) + '…' : id;
  }
  function formatDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const h = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    return d.getFullYear() + '-' + m + '-' + day + ' ' + h + ':' + min;
  }
  function relTime(iso) {
    if (!iso) return '—';
    const ms = Date.now() - new Date(iso).getTime();
    if (Number.isNaN(ms)) return '—';
    const s = Math.floor(ms / 1000);
    if (s < 60) return s + 's ago';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm ago';
    const h = Math.floor(m / 60);
    if (h < 24) return h + 'h ago';
    const d = Math.floor(h / 24);
    return d + 'd ago';
  }
  function durationBetween(startIso, endIso) {
    if (!startIso) return '—';
    const start = new Date(startIso).getTime();
    const end = endIso ? new Date(endIso).getTime() : Date.now();
    let s = Math.max(0, Math.floor((end - start) / 1000));
    const h = Math.floor(s / 3600); s -= h * 3600;
    const m = Math.floor(s / 60); s -= m * 60;
    if (h > 0) return h + 'h ' + m + 'm';
    if (m > 0) return m + 'm ' + s + 's';
    return s + 's';
  }
  function statusTone(status) {
    if (status === 'success' || status === 'complete' || status === 'active') return 'success';
    if (status === 'running') return 'running';
    if (status === 'failed') return 'failed';
    if (status === 'awaiting_gate') return 'warning';
    if (status === 'blocked_by_red') return 'blocked_by_red';
    if (status === 'pending') return 'pending';
    if (status === 'abandoned') return 'abandoned';
    return 'pending';
  }
  function rowDisplayStatus(run) {
    if (run.status === 'active') return 'running';
    return run.status;
  }
  function badge(status) {
    return el('span', { class: 'badge status-' + statusTone(status) }, status);
  }
  function toast(msg, kind) {
    const root = $('toast-root');
    const t = el('div', { class: 'toast ' + (kind || '') }, msg);
    root.appendChild(t);
    setTimeout(() => t.remove(), 4000);
  }

  // ---------- API ----------
  async function fetchJSON(url, opts) {
    const o = opts || {};
    const headers = { 'Accept': 'application/json' };
    if (o.body) headers['Content-Type'] = 'application/json';
    if (o.method && o.method !== 'GET') headers['X-Forge-Request'] = '1';
    const res = await fetch(url, { method: o.method || 'GET', headers, body: o.body ? JSON.stringify(o.body) : undefined });
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
    if (!res.ok) {
      const msg = (data && data.error) || ('HTTP ' + res.status);
      const err = new Error(msg);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  // ---------- render: sidebar (runs) ----------
  function renderSidebar() {
    const sidebar = $('sidebar');
    sidebar.innerHTML = '';
    sidebar.appendChild(el('div', { class: 'brand' }, [
      el('div', { class: 'brand-logo' }),
      el('span', { class: 'brand-name' }, 'FORGE'),
    ]));
    sidebar.appendChild(el('div', { class: 'search' }, [
      el('input', { type: 'text', placeholder: 'search runs…', oninput: onSearchInput, id: 'search-input' }),
    ]));
    const header = el('div', { class: 'list-header' }, [
      el('span', null, 'RUNS'),
      el('span', { class: 'count' }, state.runs.length + ' total'),
    ]);
    if (state.interactive) {
      header.appendChild(el('button', { class: 'new-btn', onclick: openNewRunModal, title: 'Create a new run' }, '+ New run'));
    }
    sidebar.appendChild(header);
    const body = el('div', { class: 'pane-body no-pad' });
    const filter = (state.searchQuery || '').toLowerCase();
    const filtered = filter ? state.runs.filter(r => (r.id + ' ' + (r.title || '')).toLowerCase().includes(filter)) : state.runs;
    if (filtered.length === 0) {
      body.appendChild(el('div', { class: 'empty-state' }, 'No runs yet.'));
    } else {
      for (const r of filtered) body.appendChild(runRow(r));
    }
    sidebar.appendChild(body);
    sidebar.appendChild(el('div', { class: 'bottom-nav' }, [
      el('div', { class: 'item' }, '⚙ settings'),
    ]));
  }
  function onSearchInput(e) {
    state.searchQuery = e.target.value;
    renderSidebar();
  }
  function runRow(r) {
    const taskCount = (r.taskCount != null ? r.taskCount : 0) + ' tasks';
    const status = rowDisplayStatus(r);
    const row = el('div', {
      class: 'run-row' + (r.id === state.selectedRunId ? ' selected' : ''),
      onclick: () => selectRun(r.id),
    }, [
      el('div', { class: 'row-main' }, [
        el('div', { class: 'row-id' }, shortId(r.id)),
        el('div', { class: 'row-meta' }, [
          el('span', null, relTime(r.createdAt)),
          el('span', null, taskCount),
        ]),
      ]),
      el('div', { class: 'row-side' }, [
        badge(status),
        el('span', { class: 'row-meta' }, formatDate(r.createdAt).slice(5)),
      ]),
    ]);
    return row;
  }

  // ---------- render: middle (run detail / tasks) ----------
  function renderMiddle() {
    const middle = $('middle');
    middle.innerHTML = '';
    if (!state.selectedRunId) {
      middle.appendChild(el('div', { class: 'pane-header' }, [
        el('span', { class: 'label' }, 'RUN'),
      ]));
      middle.appendChild(el('div', { class: 'empty-state' }, 'Select a run.'));
      return;
    }
    if (!state.runDetail) {
      middle.appendChild(el('div', { class: 'pane-header' }, [
        el('span', { class: 'label' }, 'RUN'),
      ]));
      middle.appendChild(el('div', { class: 'empty-state' }, 'Loading…'));
      return;
    }
    const { run, tasks } = state.runDetail;
    const counts = countTaskStatuses(tasks);
    middle.appendChild(el('div', { class: 'pane-header' }, [
      el('span', { class: 'label' }, 'RUN'),
      el('span', { class: 'sep' }, '/'),
      el('span', { class: 'current', style: 'color: var(--foreground); text-transform: none;' }, shortId(run.id)),
    ]));
    const headerBlock = el('div', { class: 'middle-header' }, [
      el('div', { style: 'display: flex; align-items: center; gap: var(--space-sm); margin-bottom: var(--space-sm);' }, [
        el('span', { style: 'font-weight: 600; color: var(--foreground);' }, run.id),
        badge(rowDisplayStatus(run)),
      ]),
      el('div', { class: 'run-meta-strip' }, [
        kvCell('STARTED', formatDate(run.createdAt)),
        kvCell('DURATION', durationBetween(run.createdAt, run.completedAt)),
        kvCell('TASKS', counts.summary),
      ]),
    ]);
    if (state.interactive) {
      headerBlock.appendChild(runActionRow(run, counts));
    }
    middle.appendChild(headerBlock);

    const listHeader = el('div', { class: 'list-header' }, [
      el('span', null, 'TASKS'),
      el('span', { class: 'count' }, tasks.length + ' tasks'),
    ]);
    middle.appendChild(listHeader);
    const body = el('div', { class: 'pane-body no-pad' });
    for (const t of tasks) body.appendChild(taskRow(t));
    if (tasks.length === 0) body.appendChild(el('div', { class: 'empty-state' }, 'No tasks yet.'));
    middle.appendChild(body);
  }
  function kvCell(k, v) {
    return el('div', null, [
      el('span', { class: 'key' }, k),
      el('span', { class: 'val' }, v),
    ]);
  }
  function countTaskStatuses(tasks) {
    const c = { running: 0, awaiting_gate: 0, blocked_by_red: 0, complete: 0, failed: 0, pending: 0 };
    for (const t of tasks) c[t.status] = (c[t.status] || 0) + 1;
    const done = c.complete + c.failed;
    const summary = done + ' / ' + tasks.length;
    return Object.assign(c, { summary, done });
  }
  function runActionRow(run, counts) {
    const wrap = el('div', { style: 'display: flex; gap: var(--space-sm); margin-top: var(--space-md);' });
    if (counts.awaiting_gate > 0 || counts.blocked_by_red > 0) {
      wrap.appendChild(el('button', { class: 'btn btn-sm btn-warning', onclick: () => focusFirstGate(run.id) }, 'Review gates'));
    } else if (counts.pending > 0 || counts.running === 0 && counts.complete + counts.failed < state.runDetail.tasks.length) {
      wrap.appendChild(el('button', { class: 'btn btn-sm btn-primary', onclick: () => runNext(run.id) }, '▶ Run next'));
    }
    wrap.appendChild(el('button', { class: 'btn btn-sm btn-ghost', onclick: (e) => openRunMenu(e, run) }, '⋯'));
    return wrap;
  }
  function focusFirstGate(runId) {
    const tasks = state.runDetail ? state.runDetail.tasks : [];
    const t = tasks.find(t => t.status === 'awaiting_gate' || t.status === 'blocked_by_red');
    if (t) selectTask(t.id);
  }
  function taskRow(t) {
    const elapsed = t.startedAt ? durationBetween(t.startedAt, t.completedAt) : '—';
    return el('div', {
      class: 'task-row' + (t.id === state.selectedTaskId ? ' selected' : ''),
      onclick: () => selectTask(t.id),
    }, [
      el('div', { style: 'display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0;' }, [
        el('span', { style: 'color: var(--foreground-muted);' }, '◇'),
        el('div', { class: 'row-main' }, [
          el('div', { class: 'row-id' }, t.taskName || t.phase),
          el('div', { class: 'row-meta' }, [
            el('span', null, t.phase),
            el('span', null, t.agentRole),
          ]),
        ]),
      ]),
      el('div', { class: 'row-side' }, [
        badge(displayTaskStatus(t)),
        el('span', { class: 'row-meta' }, elapsed),
      ]),
    ]);
  }
  function displayTaskStatus(t) {
    if (t.status === 'complete') return 'success';
    return t.status;
  }

  // ---------- render: detail pane ----------
  function renderDetail() {
    const detail = $('detail');
    detail.innerHTML = '';
    if (!state.selectedTaskId) {
      detail.appendChild(el('div', { class: 'pane-header' }, [
        el('span', { class: 'label' }, 'TASK'),
      ]));
      detail.appendChild(el('div', { class: 'empty-state' }, [
        el('div', null, '↘ select a task to inspect'),
      ]));
      return;
    }
    if (!state.taskDetail) {
      detail.appendChild(el('div', { class: 'pane-header' }, [
        el('span', { class: 'label' }, 'TASK'),
      ]));
      detail.appendChild(el('div', { class: 'empty-state' }, 'Loading…'));
      return;
    }
    const { task, verdicts, gates } = state.taskDetail;
    const isBlockedByRed = task.status === 'blocked_by_red';
    const isAwaitingGate = task.status === 'awaiting_gate';

    if (isBlockedByRed) {
      detail.appendChild(el('div', { class: 'alert-banner' }, [
        el('strong', null, '🚫 BLOCKED BY RED — '),
        el('span', null, 'An authoritative red verdict failed. Force-advance requires explicit rationale.'),
      ]));
    }
    detail.appendChild(el('div', { class: 'pane-header' }, [
      el('span', { class: 'label' }, 'TASK'),
      el('span', { class: 'sep' }, '/'),
      el('span', { class: 'current', style: 'color: var(--foreground); text-transform: none;' }, task.taskName || task.phase),
    ]));

    const body = el('div', { class: 'pane-body no-pad' });

    body.appendChild(taskHeaderSection(task));
    if (isAwaitingGate || isBlockedByRed) {
      body.appendChild(gateActionsSection(task, verdicts));
    }
    body.appendChild(taskInputsSection(task));
    if (task.result) body.appendChild(taskResultSection(task));
    if (verdicts && verdicts.length > 0 && !isBlockedByRed) body.appendChild(verdictsSection(verdicts));
    if (gates && gates.length > 0) body.appendChild(gatesSection(gates));
    detail.appendChild(body);
  }
  function taskHeaderSection(task) {
    return el('div', { class: 'detail-section' }, [
      el('div', { style: 'display: flex; align-items: center; justify-content: space-between; gap: var(--space-sm); margin-bottom: var(--space-sm);' }, [
        el('div', { style: 'display: flex; align-items: center; gap: 8px;' }, [
          el('span', { style: 'color: var(--foreground-muted);' }, '◇'),
          el('span', { style: 'font-weight: 600;' }, task.taskName || task.phase),
        ]),
        badge(displayTaskStatus(task)),
      ]),
      el('div', { class: 'kv-row' }, [
        el('span', { class: 'k' }, 'TYPE'),
        el('span', { class: 'v' }, task.phase + ' · ' + task.agentRole),
      ]),
      el('div', { class: 'kv-row' }, [
        el('span', { class: 'k' }, 'STARTED'),
        el('span', { class: 'v' }, task.startedAt ? formatDate(task.startedAt) : '—'),
      ]),
      el('div', { class: 'kv-row' }, [
        el('span', { class: 'k' }, 'ELAPSED'),
        el('span', { class: 'v' }, task.startedAt ? durationBetween(task.startedAt, task.completedAt) : '—'),
      ]),
      task.taskPackage && task.taskPackage.role
        ? el('div', { class: 'kv-row' }, [
            el('span', { class: 'k' }, 'ROLE'),
            el('span', { class: 'v' }, task.taskPackage.role),
          ])
        : null,
    ]);
  }
  function taskInputsSection(task) {
    const inputs = (task.taskPackage && task.taskPackage.inputs) || {};
    const keys = Object.keys(inputs);
    const sec = el('div', { class: 'detail-section' }, [el('h3', null, 'INPUTS')]);
    if (keys.length === 0) {
      sec.appendChild(el('div', { class: 'input-row' }, '(no inputs)'));
      return sec;
    }
    for (const k of keys) {
      const val = inputs[k];
      const valStr = typeof val === 'string' ? val : JSON.stringify(val);
      const type = typeof val;
      const truncated = valStr.length > 200 ? valStr.slice(0, 200) + '…' : valStr;
      sec.appendChild(el('div', { class: 'input-row' }, [
        el('span', { class: 'label' }, k),
        el('span', { class: 'type' }, type),
        el('span', null, truncated),
      ]));
    }
    return sec;
  }
  function taskResultSection(task) {
    const sec = el('div', { class: 'detail-section' }, [el('h3', null, 'OUTPUT')]);
    const json = JSON.stringify(task.result, null, 2);
    sec.appendChild(el('pre', { class: 'cli-block' }, json));
    return sec;
  }
  function verdictsSection(verdicts) {
    const sec = el('div', { class: 'detail-section' }, [el('h3', null, 'RED VERDICTS')]);
    for (const v of verdicts) {
      const verdictClass = v.verdict === 'fail' ? 'verdict-fail' : (v.verdict === 'pass' ? 'verdict-pass' : 'verdict-inconclusive');
      const card = el('div', { class: 'verdict-card', style: v.verdict === 'fail' ? '' : 'background: transparent; border-color: var(--border);' });
      card.appendChild(el('div', { style: 'display: flex; justify-content: space-between; margin-bottom: var(--space-sm); font-size: 11px;' }, [
        el('span', null, [el('span', { class: 'badge ' + verdictClass }, v.verdict), ' · ', v.redRole, ' · ', v.authority]),
        el('span', { style: 'color: var(--foreground-muted);' }, 'confidence ' + v.confidence),
      ]));
      for (const f of (v.findings || [])) {
        card.appendChild(el('div', { class: 'finding' }, [
          el('span', { class: 'severity', style: severityColor(f.severity) }, f.severity.toUpperCase()),
          el('span', null, f.summary),
        ]));
      }
      sec.appendChild(card);
    }
    return sec;
  }
  function severityColor(sev) {
    if (sev === 'high') return 'color: var(--error);';
    if (sev === 'medium') return 'color: var(--warning);';
    return 'color: var(--foreground-muted);';
  }
  function gatesSection(gates) {
    const sec = el('div', { class: 'detail-section' }, [el('h3', null, 'GATE HISTORY')]);
    for (const g of gates) {
      sec.appendChild(el('div', { class: 'thread-msg' }, [
        el('div', { class: 'who' }, [
          el('span', null, g.decision + ' · ' + g.decidedBy),
          el('span', { class: 'ts' }, formatDate(g.decidedAt)),
        ]),
        g.rationale ? el('div', null, g.rationale) : el('em', { style: 'color: var(--foreground-muted);' }, '(no rationale)'),
      ]));
    }
    return sec;
  }
  function gateActionsSection(task, verdicts) {
    const sec = el('div', { class: 'detail-section' });
    const isBlocked = task.status === 'blocked_by_red';
    if (isBlocked && verdicts) {
      const failing = verdicts.filter(v => v.verdict === 'fail' && v.authority === 'authoritative');
      for (const v of failing) sec.appendChild(redVerdictCard(v));
    }
    if (!state.interactive) {
      sec.appendChild(el('div', { class: 'cli-block', style: 'margin-bottom: var(--space-md);' }, [
        el('span', null, 'forge gate ' + task.id + ' advance --rationale "..."'),
        el('button', { class: 'copy', onclick: (e) => copyText(e, 'forge gate ' + task.id + ' advance') }, 'copy'),
      ]));
      sec.appendChild(el('div', { style: 'color: var(--foreground-muted); font-size: 11px;' }, [
        'Set ',
        el('code', null, 'FORGE_DASHBOARD_INTERACTIVE=1'),
        ' before launching the dashboard to enable gate buttons here.',
      ]));
      return sec;
    }
    const rationaleField = el('textarea', {
      class: 'rationale',
      placeholder: isBlocked ? 'Required for force-advance: explain why overriding this red verdict is justified…' : 'optional rationale for your decision…',
      id: 'rationale-' + task.id,
    });
    if (isBlocked) {
      sec.appendChild(el('div', { class: 'gate-actions' }, [
        el('button', { class: 'btn btn-reject', onclick: () => doGate(task.id, 'reject', { requireRationale: false }) }, '✕ Reject'),
        el('button', { class: 'btn btn-warning', onclick: () => doGate(task.id, 'request-changes', { requireRationale: false }) }, '↻ Re-run task'),
        el('button', { class: 'btn btn-danger', onclick: () => doGate(task.id, 'advance', { force: true, requireRationale: true }) }, '⚠ Force advance + rationale'),
      ]));
    } else {
      sec.appendChild(el('div', { class: 'gate-actions' }, [
        el('button', { class: 'btn btn-reject', onclick: () => doGate(task.id, 'reject', { requireRationale: false }) }, '✕ Reject Run'),
        el('button', { class: 'btn btn-warning', onclick: () => doGate(task.id, 'request-changes', { requireRationale: false }) }, '↻ Request Changes'),
        el('button', { class: 'btn btn-primary', onclick: () => doGate(task.id, 'advance', { requireRationale: false }) }, '→ Advance Run'),
      ]));
    }
    sec.appendChild(el('div', { style: 'font-size: 11px; color: var(--foreground-muted); margin-bottom: var(--space-sm);' }, isBlocked ? 'Rationale — required for force-advance' : 'Rationale (optional)'));
    sec.appendChild(rationaleField);
    return sec;
  }
  function redVerdictCard(v) {
    const card = el('div', { class: 'verdict-card' });
    card.appendChild(el('div', { style: 'display: flex; justify-content: space-between; margin-bottom: var(--space-sm); font-size: 11px;' }, [
      el('span', null, [el('span', { class: 'badge verdict-fail' }, 'BLOCKED'), ' · ', v.redRole, ' · ', v.authority]),
      el('span', { style: 'color: var(--foreground-muted);' }, 'confidence ' + v.confidence),
    ]));
    for (const f of (v.findings || [])) {
      card.appendChild(el('div', { class: 'finding' }, [
        el('span', { class: 'severity', style: severityColor(f.severity) }, f.severity.toUpperCase()),
        el('span', null, f.summary),
      ]));
    }
    return card;
  }

  // ---------- mutation actions ----------
  async function doGate(taskId, decision, opts) {
    opts = opts || {};
    const ta = $('rationale-' + taskId);
    const rationale = ta ? ta.value.trim() : '';
    if (opts.requireRationale && !rationale) {
      toast('Rationale required for force-advance.', 'error');
      ta && ta.focus();
      return;
    }
    try {
      await fetchJSON('/api/gate/' + encodeURIComponent(taskId), {
        method: 'POST',
        body: { decision, rationale: rationale || undefined, force: opts.force || undefined },
      });
      toast('Gate decision recorded: ' + decision, 'success');
      await refreshAll();
    } catch (e) {
      toast('Gate failed: ' + (e.message || 'unknown error'), 'error');
    }
  }
  async function runNext(runId) {
    try {
      const data = await fetchJSON('/api/next/' + encodeURIComponent(runId), { method: 'POST', body: {} });
      const summary = (data && data.summary) || 'Dispatched next phase.';
      toast(summary, 'success');
      await refreshAll();
    } catch (e) {
      toast('Run-next failed: ' + (e.message || 'unknown error'), 'error');
    }
  }
  async function refreshAll() {
    await loadRuns();
    if (state.selectedRunId) await loadRunDetail(state.selectedRunId);
    if (state.selectedTaskId) await loadTaskDetail(state.selectedTaskId);
  }

  // ---------- selection ----------
  async function selectRun(runId) {
    state.selectedRunId = runId;
    state.selectedTaskId = null;
    state.taskDetail = null;
    renderSidebar();
    renderMiddle();
    renderDetail();
    await loadRunDetail(runId);
  }
  async function selectTask(taskId) {
    state.selectedTaskId = taskId;
    renderMiddle();
    renderDetail();
    await loadTaskDetail(taskId);
  }
  async function loadRuns() {
    try {
      const data = await fetchJSON('/api/runs');
      state.runs = data.runs || [];
      renderSidebar();
    } catch (e) {
      toast('Failed to load runs: ' + e.message, 'error');
    }
  }
  async function loadRunDetail(runId) {
    try {
      const data = await fetchJSON('/api/runs/' + encodeURIComponent(runId));
      state.runDetail = data;
      attachTaskCounts();
      renderMiddle();
      schedulePoll();
    } catch (e) {
      if (e.status !== 404) toast('Failed to load run: ' + e.message, 'error');
    }
  }
  async function loadTaskDetail(taskId) {
    try {
      const data = await fetchJSON('/api/tasks/' + encodeURIComponent(taskId));
      state.taskDetail = data;
      renderDetail();
    } catch (e) {
      if (e.status !== 404) toast('Failed to load task: ' + e.message, 'error');
    }
  }
  function attachTaskCounts() {
    const counts = {};
    if (state.runDetail) counts[state.runDetail.run.id] = state.runDetail.tasks.length;
    state.runs = state.runs.map(r => ({ ...r, taskCount: counts[r.id] != null ? counts[r.id] : r.taskCount }));
  }
  function schedulePoll() {
    if (state.pollTimer) clearTimeout(state.pollTimer);
    if (state.runDetail && state.runDetail.shouldPoll) {
      state.pollTimer = setTimeout(() => {
        if (state.selectedRunId) loadRunDetail(state.selectedRunId);
        if (state.selectedTaskId) loadTaskDetail(state.selectedTaskId);
      }, 3000);
    }
  }

  // ---------- new-run modal (stub: shows equivalent CLI command) ----------
  function openNewRunModal() {
    const root = $('modal-root');
    root.innerHTML = '';
    const overlay = el('div', { class: 'modal-overlay', onclick: (e) => { if (e.target === overlay) closeModal(); } });
    const modal = el('div', { class: 'modal' });
    overlay.appendChild(modal);
    modal.appendChild(el('div', { class: 'modal-header' }, [
      el('div', null, [el('strong', null, 'NEW RUN'), el('span', { style: 'color: var(--foreground-muted); margin-left: 8px; font-size: 11px;' }, '— v1: copy the CLI command')]),
      el('button', { class: 'modal-close', onclick: closeModal }, '✕'),
    ]));
    const body = el('div', { class: 'modal-body' });
    body.appendChild(el('p', { style: 'color: var(--foreground-secondary); margin-bottom: var(--space-md); font-size: 12px;' },
      'Full new-run form is deferred (BACKLOG #57 follow-up). For now, run this in your terminal:'));
    const example = 'forge new <workflow> "<title>" --project <path> [--brief "..."]';
    body.appendChild(el('div', { class: 'cli-block' }, [
      el('span', null, example),
      el('button', { class: 'copy', onclick: (e) => copyText(e, example) }, 'copy'),
    ]));
    body.appendChild(el('p', { style: 'color: var(--foreground-muted); margin-top: var(--space-md); font-size: 11px;' },
      'Workflows: feature-design-provided, feature-design-needed, investigation, codebase-assessment, ui-design, design-revise.'));
    modal.appendChild(body);
    modal.appendChild(el('div', { class: 'modal-footer' }, [
      el('button', { class: 'btn', onclick: closeModal }, 'Close'),
    ]));
    root.appendChild(overlay);
  }
  function closeModal() { $('modal-root').innerHTML = ''; }
  function copyText(e, text) {
    try {
      navigator.clipboard.writeText(text);
      toast('Copied.', 'success');
    } catch (err) {
      toast('Copy failed.', 'error');
    }
  }

  // ---------- run-row overflow menu ----------
  function openRunMenu(e, run) {
    e.stopPropagation();
    closeMenus();
    const menu = el('div', { class: 'menu' }, [
      el('div', { class: 'item', onclick: () => { closeMenus(); runNext(run.id); } }, '▶ Run next'),
      el('div', { class: 'item', onclick: () => { closeMenus(); copyText(e, run.id); } }, '⧉ Copy run ID'),
      el('div', { class: 'sep' }),
      el('div', { class: 'item danger', onclick: () => { closeMenus(); toast('Cancel/abandon: not implemented in v1.', 'error'); } }, '✕ Abandon'),
    ]);
    document.body.appendChild(menu);
    const rect = e.target.getBoundingClientRect();
    menu.style.left = (rect.right - 180) + 'px';
    menu.style.top = (rect.bottom + 4) + 'px';
    setTimeout(() => document.addEventListener('click', closeMenus, { once: true }), 0);
  }
  function closeMenus() {
    document.querySelectorAll('.menu').forEach(m => m.remove());
  }

  // ---------- bootstrap ----------
  async function bootstrap() {
    state.interactive = (document.documentElement.getAttribute('data-interactive') === '1') ||
      (window.__FORGE_INTERACTIVE === true);
    // The server injects /api/runs?_meta to surface the flag without a separate endpoint.
    try {
      const meta = await fetchJSON('/api/meta');
      state.interactive = !!meta.interactive;
    } catch { /* meta endpoint optional */ }
    renderSidebar();
    renderMiddle();
    renderDetail();
    await loadRuns();
  }
  bootstrap();
})();
`;
