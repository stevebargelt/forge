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
.badge.status-awaiting_human_input { color: var(--warning); background: var(--warning-bg, transparent); }
.badge.status-awaiting_red { color: var(--running); background: var(--warning-bg, transparent); }
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

/* #34: pretty-rendered task results. Walks an arbitrary result object and
   renders prose / lists / paths / nested objects with appropriate widgets. */
.result-pretty { display: flex; flex-direction: column; gap: var(--space-md); }
.result-field { display: flex; flex-direction: column; gap: 4px; }
.result-field-label {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--foreground-muted);
  font-weight: 600;
}
.result-prose { font-size: 13px; color: var(--foreground); line-height: 1.55; }
.result-prose p { margin: 0 0 8px 0; }
.result-prose p:last-child { margin-bottom: 0; }
.result-list { font-size: 13px; color: var(--foreground); line-height: 1.55; padding-left: 22px; margin: 0; }
.result-list li { margin-bottom: 8px; }
.result-list li:last-child { margin-bottom: 0; }
.result-list li p { margin: 0 0 6px 0; }
.result-list li p:last-child { margin-bottom: 0; }
.result-list-of-objects { display: flex; flex-direction: column; gap: 8px; }
.result-subcard {
  background: var(--background-elevated, var(--background));
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.result-subcard-index { font-size: 10px; color: var(--foreground-muted); font-weight: 600; }
.result-nested {
  border-left: 2px solid var(--border);
  padding-left: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.result-empty { font-size: 12px; color: var(--foreground-muted); font-style: italic; }
.result-path {
  font-family: var(--font-mono);
  font-size: 11px;
  background: var(--background-elevated, var(--background));
  padding: 2px 6px;
  border-radius: var(--radius-sm);
  word-break: break-all;
}
.result-scalar {
  font-family: var(--font-mono);
  font-size: 12px;
  background: var(--background-elevated, var(--background));
  padding: 1px 6px;
  border-radius: var(--radius-sm);
}
.view-toggle { display: flex; gap: 4px; }
.view-toggle .btn { padding: 2px 8px; font-size: 11px; }

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

.form-row { display: flex; flex-direction: column; gap: 4px; margin-bottom: var(--space-md); }
.form-row label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--foreground-muted); font-weight: 600; }
.form-row label .req { color: var(--accent); margin-left: 4px; }
.form-row input, .form-row textarea, .form-row select {
  background: var(--background);
  border: 1px solid var(--border);
  color: var(--foreground);
  padding: 8px 10px;
  font-family: var(--font-mono);
  font-size: 12px;
  border-radius: var(--radius-sm);
  outline: none;
}
.form-row input:focus, .form-row textarea:focus, .form-row select:focus { border-color: var(--accent); }
.form-row textarea { min-height: 80px; resize: vertical; }
.form-row .help { font-size: 11px; color: var(--foreground-muted); }
.form-row .err { font-size: 11px; color: var(--error); margin-top: 2px; }
.form-row.has-err input, .form-row.has-err textarea, .form-row.has-err select { border-color: var(--error); }
.workflow-desc { font-size: 12px; color: var(--foreground-secondary); padding: var(--space-sm) 0; border-bottom: 1px dashed var(--border); margin-bottom: var(--space-md); }

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
    // Last-rendered cache keys per pane (#72). Each render computes a key from
    // the data it would draw + selection state; if the key matches the cached
    // one, the render is skipped entirely (DOM untouched). Polling ticks that
    // bring back unchanged data become silent — solves the entire class of
    // "polling clobbers user input / scroll / focus" bugs.
    lastRender: { sidebar: null, middle: null, detail: null },
  };

  // ---------- helpers ----------
  function $(id) { return document.getElementById(id); }
  // Render-key helpers (#72). Computes a string key from the data + selection
  // a render function would consume; identical key → skip the render. Cheap
  // because pane data is bounded (tasks per run, runs per dashboard), and a
  // skipped render does ZERO DOM work — preserving scroll, input, focus,
  // selection, and animation state for free. JSON.stringify is good enough
  // for forge's scale; no need for a content hash.
  function renderKey(parts) {
    return JSON.stringify(parts);
  }
  // Slim a tasks array down to just the fields the middle pane renders. Keeps
  // the render-key small + stable: trivial fields the dashboard doesn't render
  // (e.g. taskPackage, full result blobs) don't trigger spurious re-renders.
  function slimTasksForKey(tasks) {
    return (tasks || []).map(t => ({
      id: t.id, phase: t.phase, agentRole: t.agentRole, status: t.status,
      startedAt: t.startedAt, completedAt: t.completedAt, taskName: t.taskName,
    }));
  }
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
    if (status === 'awaiting_human_input') return 'awaiting_human_input';
    if (status === 'awaiting_red') return 'awaiting_red';
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
    // Smart-refresh gate (#72): skip the render if the data + selection key
    // hasn't changed. Polling that returns identical run rows becomes silent.
    const slimRuns = (state.runs || []).map(r => ({
      id: r.id, status: r.status, title: r.title, workflow: r.workflow,
      taskCount: r.taskCount, completedAt: r.completedAt,
    }));
    const key = renderKey([slimRuns, state.searchQuery || '', state.selectedRunId]);
    if (state.lastRender.sidebar === key) return;
    state.lastRender.sidebar = key;
    const prevScrollTop = readPaneScroll(sidebar);
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
    if (prevScrollTop > 0) {
      requestAnimationFrame(() => { writePaneScroll(sidebar, prevScrollTop); });
    }
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
    // Smart-refresh gate (#72): skip if data + selection unchanged. Idle
    // polling on awaiting-gate / awaiting_human_input runs becomes silent;
    // user can scroll the task list without polling popping it back.
    const rd = state.runDetail;
    const key = rd
      ? renderKey([
          rd.run.id, rd.run.status, rd.run.title, rd.run.workflow,
          rd.run.completedAt, rd.run.projectDir,
          (rd.run.metadata && rd.run.metadata.designDir) || null,
          slimTasksForKey(rd.tasks),
          state.selectedTaskId,
          state.interactive,
        ])
      : renderKey(['none', state.selectedRunId]);
    if (state.lastRender.middle === key) return;
    state.lastRender.middle = key;
    const prevScrollTop = readPaneScroll(middle);
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
    const designDir = (run.metadata && typeof run.metadata.designDir === 'string') ? run.metadata.designDir : '';
    const headerBlock = el('div', { class: 'middle-header' }, [
      el('div', { style: 'display: flex; align-items: center; gap: var(--space-sm); margin-bottom: var(--space-sm);' }, [
        el('span', { style: 'font-weight: 600; color: var(--foreground);' }, run.id),
        badge(rowDisplayStatus(run)),
      ]),
      run.title ? el('div', { style: 'color: var(--foreground); margin-bottom: var(--space-sm); font-size: 13px;' }, run.title) : null,
      el('div', { class: 'run-meta-strip' }, [
        kvCell('WORKFLOW', run.workflow),
        kvCell('STARTED', formatDate(run.createdAt)),
        kvCell('DURATION', durationBetween(run.createdAt, run.completedAt)),
        kvCell('TASKS', counts.summary),
      ]),
      (run.projectDir || designDir) ? el('div', { class: 'run-meta-strip', style: 'margin-top: var(--space-sm); font-family: var(--font-mono); font-size: 11px;' }, [
        run.projectDir ? kvCell('--project', run.projectDir) : null,
        designDir ? kvCell('--design-dir', designDir) : null,
      ]) : null,
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
    // Compute per-phase position FIRST (over the natural creation order, not
    // the display order) so "1 of 8" assignments are stable when we re-sort
    // the list by attention level below. Without this a task labeled "3 of 8"
    // could become "5 of 8" simply because its status changed and the visual
    // order shifted.
    const phaseCounts = {};
    const phaseIndex = new Map();
    for (const t of tasks) phaseCounts[t.phase] = (phaseCounts[t.phase] || 0) + 1;
    const phaseSeen = {};
    for (const t of tasks) {
      phaseSeen[t.phase] = (phaseSeen[t.phase] || 0) + 1;
      phaseIndex.set(t.id, phaseSeen[t.phase]);
    }
    // Sort by attention level: actionable states bubble up so the user lands
    // on the things they need to act on. Within a status, group by phase and
    // preserve creation order so the "N of M" indices read naturally.
    const sortedTasks = tasks.slice().sort(compareTaskAttention);
    for (const t of sortedTasks) {
      const idx = phaseIndex.get(t.id);
      const total = phaseCounts[t.phase];
      body.appendChild(taskRow(t, idx, total));
    }
    if (tasks.length === 0) body.appendChild(el('div', { class: 'empty-state' }, 'No tasks yet.'));
    middle.appendChild(body);
    if (prevScrollTop > 0) {
      requestAnimationFrame(() => { writePaneScroll(middle, prevScrollTop); });
    }
  }
  function kvCell(k, v) {
    return el('div', null, [
      el('span', { class: 'key' }, k),
      el('span', { class: 'val' }, v),
    ]);
  }
  function countTaskStatuses(tasks) {
    const c = { running: 0, awaiting_gate: 0, awaiting_human_input: 0, awaiting_red: 0, blocked_by_red: 0, complete: 0, failed: 0, pending: 0 };
    for (const t of tasks) c[t.status] = (c[t.status] || 0) + 1;
    const done = c.complete + c.failed;
    const summary = done + ' / ' + tasks.length;
    return Object.assign(c, { summary, done });
  }
  function runActionRow(run, counts) {
    const wrap = el('div', { style: 'display: flex; gap: var(--space-sm); margin-top: var(--space-md);' });
    if (counts.awaiting_gate > 0 || counts.blocked_by_red > 0 || counts.awaiting_human_input > 0) {
      wrap.appendChild(el('button', { class: 'btn btn-sm btn-warning', onclick: () => focusFirstGate(run.id) }, 'Review gates'));
    } else if (counts.pending > 0 || counts.running === 0 && counts.complete + counts.failed < state.runDetail.tasks.length) {
      wrap.appendChild(el('button', { class: 'btn btn-sm btn-primary', onclick: () => runNext(run.id) }, '▶ Run next'));
    }
    wrap.appendChild(el('button', { class: 'btn btn-sm btn-ghost', onclick: (e) => openRunMenu(e, run) }, '⋯'));
    return wrap;
  }
  function focusFirstGate(runId) {
    const tasks = state.runDetail ? state.runDetail.tasks : [];
    const t = tasks.find(t => t.status === 'awaiting_gate' || t.status === 'blocked_by_red' || t.status === 'awaiting_human_input');
    if (t) selectTask(t.id);
  }
  function taskRow(t, phaseIndex, phaseTotal) {
    const elapsed = t.startedAt ? durationBetween(t.startedAt, t.completedAt) : '—';
    // Title shape: "<phase> · N of M" when the phase has multiple tasks (fanout
    // or otherwise), plain "<phase>" when there's just one. Lets the user say
    // "the third investigate" without reading inputs to disambiguate. The
    // detail pane shows the heuristic-derived claim/lens text + full task id
    // for content-based + copy-paste navigation.
    let title;
    if (phaseTotal > 1) title = t.phase + ' · ' + phaseIndex + ' of ' + phaseTotal;
    else title = t.taskName || t.phase;
    return el('div', {
      class: 'task-row' + (t.id === state.selectedTaskId ? ' selected' : ''),
      onclick: () => selectTask(t.id),
    }, [
      el('div', { style: 'display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0;' }, [
        el('span', { style: 'color: var(--foreground-muted);' }, '◇'),
        el('div', { class: 'row-main' }, [
          el('div', { class: 'row-id' }, title),
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
  // Sort key by attention level — lowest number first. Actionable states
  // (running, awaiting_*, blocked) bubble to the top so the user lands on
  // what needs them. failed comes after actionable (resolved-as-bad still
  // worth seeing). pending sits low (queued, not yet interesting). complete
  // sinks to the bottom (nothing to do).
  function attentionRank(status) {
    switch (status) {
      case 'running': return 0;
      case 'awaiting_red': return 1; // active, but waiting on reds — peer of running
      case 'awaiting_human_input': return 2;
      case 'awaiting_gate': return 3;
      case 'blocked_by_red': return 4;
      case 'failed': return 5;
      case 'pending': return 6;
      case 'complete': return 7;
      default: return 8;
    }
  }
  function compareTaskAttention(a, b) {
    const r = attentionRank(a.status) - attentionRank(b.status);
    if (r !== 0) return r;
    // Same status → group by phase (alphabetical for now; workflows have ≤6
    // phases so this is fine) then by creation order so "N of M" reads in
    // sequence.
    const p = (a.phase || '').localeCompare(b.phase || '');
    if (p !== 0) return p;
    return (a.createdAt || '').localeCompare(b.createdAt || '');
  }

  // ---------- render: detail pane ----------
  function renderDetail() {
    const detail = $('detail');
    // Smart-refresh gate (#72): the detail pane is the most expensive to
    // re-render and the most user-hostile when re-rendered (form inputs lose
    // focus + content). Skip when the underlying data is unchanged.
    const td = state.taskDetail;
    let key;
    if (!state.selectedTaskId) {
      key = renderKey(['empty']);
    } else if (!td) {
      key = renderKey(['loading', state.selectedTaskId]);
    } else {
      key = renderKey([
        td.task.id, td.task.status, td.task.startedAt, td.task.completedAt,
        td.task.error || null,
        td.task.result ? JSON.stringify(td.task.result) : null,
        (td.verdicts || []).map(v => ({ id: v.id, verdict: v.verdict, confidence: v.confidence, redRole: v.redRole, redTaskId: v.redTaskId, findings: v.findings })),
        (td.gates || []).map(g => ({ id: g.id, decision: g.decision, rationale: g.rationale, decidedAt: g.decidedAt })),
        td.briefContext ? { briefTaskId: td.briefContext.briefTaskId, designDir: td.briefContext.designDir, hasPrompt: !!td.briefContext.promptMarkdown, promptLen: (td.briefContext.promptMarkdown || '').length } : null,
        state.interactive,
      ]);
    }
    if (state.lastRender.detail === key) return;
    state.lastRender.detail = key;
    // Preserve scroll position + form-input values + focus across re-renders.
    // The actual scroll container is .pane-body inside the pane (the pane
    // itself has overflow:hidden); read scrollTop from there.
    const prevScrollTop = readPaneScroll(detail);
    const inputSnapshot = snapshotInputs(detail);
    const activeId = (document.activeElement && detail.contains(document.activeElement)) ? document.activeElement.id : null;
    const activeSelStart = activeId ? document.activeElement.selectionStart : null;
    const activeSelEnd = activeId ? document.activeElement.selectionEnd : null;
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
    const { task, verdicts, gates, briefContext } = state.taskDetail;
    const isBlockedByRed = task.status === 'blocked_by_red';
    const isAwaitingGate = task.status === 'awaiting_gate';
    const isAwaitingHuman = task.status === 'awaiting_human_input';

    if (isBlockedByRed) {
      detail.appendChild(el('div', { class: 'alert-banner' }, [
        el('strong', null, '🚫 BLOCKED BY RED — '),
        el('span', null, 'An authoritative red verdict failed. Force-advance requires explicit rationale.'),
      ]));
    }
    detail.appendChild(el('div', { class: 'pane-header' }, [
      el('span', { class: 'label' }, 'TASK'),
      el('span', { class: 'sep' }, '/'),
      el('span', { class: 'current', style: 'color: var(--foreground); text-transform: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;', title: deriveTaskTitle(task) }, deriveTaskTitle(task)),
    ]));

    const body = el('div', { class: 'pane-body no-pad' });

    body.appendChild(taskHeaderSection(task));
    if (isAwaitingHuman) {
      body.appendChild(submitActionsSection(task, briefContext));
    }
    if (isAwaitingGate || isBlockedByRed) {
      body.appendChild(gateActionsSection(task, verdicts));
    }
    body.appendChild(taskInputsSection(task));
    if (task.result) body.appendChild(taskResultSection(task));
    if (verdicts && verdicts.length > 0 && !isBlockedByRed) body.appendChild(verdictsSection(verdicts));
    if (gates && gates.length > 0) body.appendChild(gatesSection(gates));
    detail.appendChild(body);
    // Restore form-input values + focus + scroll after the new DOM is in
    // place. requestAnimationFrame so the browser applies these after layout.
    requestAnimationFrame(() => {
      restoreInputs(detail, inputSnapshot);
      if (activeId) {
        const el = detail.querySelector('#' + CSS.escape(activeId));
        if (el) {
          el.focus();
          if (activeSelStart != null && typeof el.setSelectionRange === 'function') {
            try { el.setSelectionRange(activeSelStart, activeSelEnd); } catch (e) { /* selection unsupported on this input type */ }
          }
        }
      }
      if (prevScrollTop > 0) writePaneScroll(detail, prevScrollTop);
    });
  }
  // The .pane elements have overflow:hidden; their .pane-body child is the
  // real scroll container. Helpers route around that so polling preservation
  // actually works (without these the pane's own scrollTop is always 0).
  function readPaneScroll(pane) {
    const body = pane.querySelector('.pane-body');
    return body ? body.scrollTop : 0;
  }
  function writePaneScroll(pane, top) {
    const body = pane.querySelector('.pane-body');
    if (body) body.scrollTop = top;
  }
  // Capture textarea + input values keyed by id so we can restore them after
  // a polling re-render. Only inputs with an id participate (the load-bearing
  // ones — rationale-<taskId>, submit-notes-<taskId> — both have ids).
  function snapshotInputs(root) {
    const out = {};
    const inputs = root.querySelectorAll('input[id], textarea[id]');
    for (const el of inputs) out[el.id] = el.value;
    return out;
  }
  function restoreInputs(root, snapshot) {
    if (!snapshot) return;
    for (const id in snapshot) {
      const el = root.querySelector('#' + CSS.escape(id));
      if (el && el.value === '') el.value = snapshot[id];
    }
  }
  // Manual-phase task awaiting the human's off-forge work (FORGE-DEC-016).
  // Renders the upstream brief's PROMPT.md inline + parameters/openQuestions
  // + a primary "I'm done — review my design" button that POSTs to /api/submit.
  function submitActionsSection(task, briefContext) {
    const sec = el('div', { class: 'detail-section' });
    sec.appendChild(el('div', { class: 'alert-banner', style: 'background: transparent; border: 1px solid var(--border);' }, [
      el('strong', null, '▢ AWAITING YOUR DESIGN WORK — '),
      el('span', null, 'Run PROMPT.md against Pencil + Claude Code on your host. When the .pen file is saved (Cmd+S in VS Code) and the export step finished, click "I’m done" below.'),
    ]));

    if (briefContext && briefContext.designDir) {
      sec.appendChild(el('div', { class: 'kv-row' }, [
        el('span', { class: 'k' }, 'DESIGN DIR'),
        el('span', { class: 'v' }, el('code', null, briefContext.designDir)),
      ]));
    }
    if (briefContext && briefContext.briefResult && typeof briefContext.briefResult === 'object') {
      const r = briefContext.briefResult;
      if (r.parameters && typeof r.parameters === 'object') {
        const params = el('div', { class: 'detail-section', style: 'padding-top: var(--space-sm);' }, [
          el('h3', null, 'PROMPT PARAMETERS'),
        ]);
        for (const k of Object.keys(r.parameters)) {
          const v = r.parameters[k];
          params.appendChild(el('div', { class: 'kv-row' }, [
            el('span', { class: 'k' }, k),
            el('span', { class: 'v' }, typeof v === 'string' ? v : JSON.stringify(v)),
          ]));
        }
        sec.appendChild(params);
      }
      if (Array.isArray(r.openQuestions) && r.openQuestions.length > 0) {
        const oq = el('div', { class: 'detail-section', style: 'padding-top: var(--space-sm);' }, [
          el('h3', null, 'OPEN QUESTIONS (defaults the prompt-author picked)'),
        ]);
        const ul = el('ul', { style: 'margin: 0; padding-left: 18px;' });
        for (const q of r.openQuestions) ul.appendChild(el('li', null, typeof q === 'string' ? q : JSON.stringify(q)));
        oq.appendChild(ul);
        sec.appendChild(oq);
      }
    }
    if (briefContext && briefContext.promptMarkdown) {
      const promptSec = el('div', { class: 'detail-section', style: 'padding-top: var(--space-sm);' }, [
        el('h3', null, 'PROMPT.md'),
      ]);
      promptSec.appendChild(el('pre', { class: 'cli-block', style: 'max-height: 360px; overflow: auto;' }, briefContext.promptMarkdown));
      sec.appendChild(promptSec);
    } else if (briefContext) {
      sec.appendChild(el('div', { style: 'font-size: 11px; color: var(--foreground-muted);' }, [
        'PROMPT.md not found at ',
        el('code', null, briefContext.promptPathHost),
      ]));
    }

    if (!state.interactive) {
      sec.appendChild(el('div', { class: 'cli-block', style: 'margin-top: var(--space-md);' }, [
        el('span', null, 'forge submit ' + task.id),
        el('button', { class: 'copy', onclick: (e) => copyText(e, 'forge submit ' + task.id) }, 'copy'),
      ]));
      sec.appendChild(el('div', { style: 'color: var(--foreground-muted); font-size: 11px;' }, [
        'Set ',
        el('code', null, 'FORGE_DASHBOARD_INTERACTIVE=1'),
        ' before launching the dashboard to enable the submit button here.',
      ]));
      return sec;
    }

    const notesField = el('textarea', {
      class: 'rationale',
      placeholder: 'Notes about the design pass (optional) — captured into result.notes for the gate reviewer.',
      id: 'submit-notes-' + task.id,
    });
    sec.appendChild(el('div', { style: 'font-size: 11px; color: var(--foreground-muted); margin: var(--space-md) 0 var(--space-sm);' }, 'Notes (optional)'));
    sec.appendChild(notesField);
    sec.appendChild(el('div', { class: 'gate-actions', style: 'margin-top: var(--space-sm);' }, [
      el('button', { class: 'btn btn-primary', onclick: () => doSubmit(task.id) }, '✓ I’m done — review my design'),
    ]));
    return sec;
  }
  // Heuristic title: pick the first scalar-string input whose key isn't one of
  // the universal/run-level inputs that the dashboard already shows elsewhere.
  // Works for fanout-from-upstream phases without any workflow change:
  //   investigate → inputs.claim → "build is slow because of cold cache"
  //   codebase-assessment.assess → inputs.lens → "security"
  // Falls back to phase name when no scalar input exists. Truncates long values.
  const GENERIC_INPUT_KEYS = new Set(['brief', 'question', 'prd', 'designDir', 'upstream', 'requestedChanges', 'rejectedRationale', 'rejectedTaskId']);
  function deriveTaskTitle(task) {
    const inputs = (task.taskPackage && task.taskPackage.inputs) || {};
    for (const k of Object.keys(inputs)) {
      if (GENERIC_INPUT_KEYS.has(k)) continue;
      const v = inputs[k];
      if (typeof v === 'string' && v.length > 0) {
        return v.length > 80 ? v.slice(0, 80) + '…' : v;
      }
    }
    return task.taskName || task.phase;
  }
  function taskHeaderSection(task) {
    const heuristicTitle = deriveTaskTitle(task);
    return el('div', { class: 'detail-section' }, [
      el('div', { style: 'display: flex; align-items: center; justify-content: space-between; gap: var(--space-sm); margin-bottom: var(--space-sm);' }, [
        el('div', { style: 'display: flex; align-items: center; gap: 8px; min-width: 0;' }, [
          el('span', { style: 'color: var(--foreground-muted);' }, '◇'),
          el('span', { style: 'font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;', title: heuristicTitle }, heuristicTitle),
        ]),
        badge(displayTaskStatus(task)),
      ]),
      el('div', { class: 'kv-row' }, [
        el('span', { class: 'k' }, 'TASK ID'),
        el('span', { class: 'v' }, [
          el('code', null, task.id),
          el('button', { class: 'copy', style: 'margin-left: 8px;', onclick: (e) => copyText(e, task.id) }, 'copy'),
        ]),
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
      task.agentAlias || task.agentModel
        ? el('div', { class: 'kv-row' }, [
            el('span', { class: 'k' }, 'MODEL'),
            el('span', { class: 'v' }, [
              task.agentAlias ? el('code', null, task.agentAlias) : '',
              task.agentModel ? ' → ' : '',
              task.agentModel ? el('code', null, task.agentModel) : '',
            ]),
          ])
        : null,
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
  // Per-task pretty/raw toggle state (#34). Persists across polling re-renders
  // because the map lives on the module's closure, not the DOM.
  const _resultViewMode = new Map();
  function taskResultSection(task) {
    const sec = el('div', { class: 'detail-section' });
    const r = task.result;
    const mode = _resultViewMode.get(task.id) || 'pretty';
    const header = el('div', { style: 'display: flex; justify-content: space-between; align-items: center; margin-bottom: var(--space-sm);' }, [
      el('h3', { style: 'margin: 0;' }, 'OUTPUT'),
      el('div', { class: 'view-toggle' }, [
        el('button', { class: 'btn btn-sm' + (mode === 'pretty' ? ' btn-primary' : ' btn-ghost'), onclick: () => { _resultViewMode.set(task.id, 'pretty'); state.lastRender.detail = null; renderDetail(); } }, 'pretty'),
        el('button', { class: 'btn btn-sm' + (mode === 'raw' ? ' btn-primary' : ' btn-ghost'), onclick: () => { _resultViewMode.set(task.id, 'raw'); state.lastRender.detail = null; renderDetail(); } }, 'raw'),
      ]),
    ]);
    sec.appendChild(header);

    if (mode === 'raw' || r == null || typeof r !== 'object') {
      const json = JSON.stringify(r, null, 2);
      sec.appendChild(el('pre', { class: 'cli-block', style: 'white-space: pre-wrap; word-wrap: break-word;' }, json));
      return sec;
    }

    // Pretty mode — render the result object structurally.
    sec.appendChild(renderResultObject(r));
    return sec;
  }
  // Render an arbitrary result object as readable sections. The result schemas
  // forge agents return are loose ({status, claim, evidence, conclusion, notes}
  // for investigators; {architecturalImplications, antiFindings, openQuestions}
  // for synthesizers; {penFile, pngFiles, htmlFiles, notes} for ui-design
  // review; etc), so the renderer is shape-agnostic — walk top-level keys, pick
  // the right widget per value type.
  //
  // Special-case the keys we know about so they get prettier framing; fall
  // through to a generic key/value treatment for unknown keys (forward-compat).
  function renderResultObject(r) {
    const wrap = el('div', { class: 'result-pretty' });
    // A few keys we want to render with specific widgets.
    const keys = Object.keys(r);
    // Drop the status field — it's redundant with the badge in the task header.
    const visibleKeys = keys.filter(k => k !== 'status');
    for (const k of visibleKeys) {
      wrap.appendChild(renderResultField(k, r[k]));
    }
    if (visibleKeys.length === 0) {
      wrap.appendChild(el('div', { style: 'color: var(--foreground-muted); font-size: 12px;' }, '(empty)'));
    }
    return wrap;
  }
  function renderResultField(key, value) {
    const block = el('div', { class: 'result-field' });
    block.appendChild(el('div', { class: 'result-field-label' }, humanizeKey(key)));
    block.appendChild(renderResultValue(value, key));
    return block;
  }
  function renderResultValue(value, contextKey) {
    if (value == null) {
      return el('div', { class: 'result-empty' }, '(none)');
    }
    if (typeof value === 'string') {
      // File-path keys: render as <code> so they're scannable + selectable as one.
      if (looksLikePath(contextKey, value)) {
        return el('code', { class: 'result-path' }, value);
      }
      // Multi-paragraph strings: split on blank lines, render each paragraph.
      // Single-line strings render as a plain paragraph. Either way, no <pre>
      // wrapper — natural word-wrap is what we want for prose.
      const paragraphs = String(value).split(/\\n{2,}/);
      const wrap = el('div', { class: 'result-prose' });
      for (const p of paragraphs) wrap.appendChild(el('p', null, p));
      return wrap;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      return el('code', { class: 'result-scalar' }, String(value));
    }
    if (Array.isArray(value)) {
      if (value.length === 0) return el('div', { class: 'result-empty' }, '(empty list)');
      // Array of strings — render as numbered list. Long prose strings get
      // split-on-blank-line just like top-level strings.
      if (value.every(v => typeof v === 'string')) {
        const ol = el('ol', { class: 'result-list' });
        for (const item of value) {
          const li = el('li', null);
          const paragraphs = String(item).split(/\\n{2,}/);
          for (const p of paragraphs) li.appendChild(el('p', null, p));
          ol.appendChild(li);
        }
        return ol;
      }
      // Array of objects — render each as a sub-card.
      if (value.every(v => v && typeof v === 'object' && !Array.isArray(v))) {
        const wrap = el('div', { class: 'result-list-of-objects' });
        value.forEach((obj, i) => {
          const card = el('div', { class: 'result-subcard' });
          card.appendChild(el('div', { class: 'result-subcard-index' }, '#' + (i + 1)));
          for (const k of Object.keys(obj)) card.appendChild(renderResultField(k, obj[k]));
          wrap.appendChild(card);
        });
        return wrap;
      }
      // Mixed array — fall back to JSON.
      return el('pre', { class: 'cli-block', style: 'white-space: pre-wrap; word-wrap: break-word;' }, JSON.stringify(value, null, 2));
    }
    if (typeof value === 'object') {
      // Nested object — render each key as a sub-field, indented.
      const wrap = el('div', { class: 'result-nested' });
      for (const k of Object.keys(value)) wrap.appendChild(renderResultField(k, value[k]));
      return wrap;
    }
    // Unknown type — JSON fallback.
    return el('pre', { class: 'cli-block', style: 'white-space: pre-wrap; word-wrap: break-word;' }, String(value));
  }
  // Convert camelCase / snake_case / kebab-case keys to readable labels.
  function humanizeKey(k) {
    return String(k)
      .replace(/[_-]+/g, ' ')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/\\s+/g, ' ')
      .trim()
      .toUpperCase();
  }
  // Heuristic: a string looks like a path if its key suggests one OR the value
  // has a / and no spaces. Used for monospace styling, not validation.
  function looksLikePath(key, value) {
    const keyLooksPathy = /(file|path|dir|directory)$/i.test(String(key)) || /^(penFile|designDir|projectDir|promptPath|promptPathHost)$/.test(String(key));
    if (keyLooksPathy) return true;
    if (typeof value === 'string' && value.length < 200 && !/\\s/.test(value) && (value.includes('/') || value.startsWith('~'))) return true;
    return false;
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
      if (v.redTaskId) {
        card.appendChild(el('div', { style: 'font-size: 11px; color: var(--foreground-muted); margin-bottom: var(--space-sm); display: flex; align-items: center; gap: 6px;' }, [
          el('span', null, 'red task:'),
          el('code', null, v.redTaskId),
          el('button', { class: 'copy', onclick: (e) => copyText(e, v.redTaskId) }, 'copy'),
        ]));
      }
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
      placeholder: isBlocked
        ? 'Required for force-advance: explain why overriding this red verdict is justified…'
        : 'Required for reject and request-changes — describe what to change. Optional for advance.',
      id: 'rationale-' + task.id,
    });
    sec.appendChild(el('div', { style: 'font-size: 11px; color: var(--foreground-muted); margin-bottom: var(--space-sm);' }, isBlocked ? 'Rationale — required for force-advance' : 'Rationale — required for reject + request-changes, optional for advance'));
    sec.appendChild(rationaleField);
    if (isBlocked) {
      sec.appendChild(el('div', { class: 'gate-actions' }, [
        el('button', { class: 'btn btn-reject', onclick: () => doGate(task.id, 'reject', { requireRationale: true }) }, '✕ Reject'),
        el('button', { class: 'btn btn-warning', onclick: () => doGate(task.id, 'request-changes', { requireRationale: true }) }, '↻ Re-run task'),
        el('button', { class: 'btn btn-danger', onclick: () => doGate(task.id, 'advance', { force: true, requireRationale: true }) }, '⚠ Force advance + rationale'),
      ]));
    } else {
      sec.appendChild(el('div', { class: 'gate-actions' }, [
        el('button', { class: 'btn btn-reject', onclick: () => doGate(task.id, 'reject', { requireRationale: true }) }, '✕ Reject Run'),
        el('button', { class: 'btn btn-warning', onclick: () => doGate(task.id, 'request-changes', { requireRationale: true }) }, '↻ Request Changes'),
        el('button', { class: 'btn btn-primary', onclick: () => doGate(task.id, 'advance', { requireRationale: false }) }, '→ Advance Run'),
      ]));
    }
    return sec;
  }
  function redVerdictCard(v) {
    const card = el('div', { class: 'verdict-card' });
    card.appendChild(el('div', { style: 'display: flex; justify-content: space-between; margin-bottom: var(--space-sm); font-size: 11px;' }, [
      el('span', null, [el('span', { class: 'badge verdict-fail' }, 'BLOCKED'), ' · ', v.redRole, ' · ', v.authority]),
      el('span', { style: 'color: var(--foreground-muted);' }, 'confidence ' + v.confidence),
    ]));
    if (v.redTaskId) {
      card.appendChild(el('div', { style: 'font-size: 11px; color: var(--foreground-muted); margin-bottom: var(--space-sm); display: flex; align-items: center; gap: 6px;' }, [
        el('span', null, 'red task:'),
        el('code', null, v.redTaskId),
        el('button', { class: 'copy', onclick: (e) => copyText(e, v.redTaskId) }, 'copy'),
      ]));
    }
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
      toast('Rationale required for ' + decision + '. Add it above and try again.', 'error');
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
  async function doSubmit(taskId) {
    const ta = $('submit-notes-' + taskId);
    const notes = ta ? ta.value.trim() : '';
    try {
      await fetchJSON('/api/submit/' + encodeURIComponent(taskId), {
        method: 'POST',
        body: { notes: notes || undefined },
      });
      toast('Submitted; advance the gate when ready.', 'success');
      await refreshAll();
    } catch (e) {
      toast('Submit failed: ' + (e.message || 'unknown error'), 'error');
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

  // ---------- new-run modal (BACKLOG #66) ----------
  // Workflow schema is fetched once from /api/workflows then cached. The modal
  // re-renders when the workflow picker changes — fields appear/disappear per
  // the selected workflow's spec. Submit POSTs to /api/runs which validates
  // server-side too (single source of truth in workflowSchema.ts).
  let _workflowSchema = null;
  async function loadWorkflowSchema() {
    if (_workflowSchema) return _workflowSchema;
    _workflowSchema = await fetchJSON('/api/workflows');
    return _workflowSchema;
  }
  async function openNewRunModal() {
    const root = $('modal-root');
    root.innerHTML = '';
    let schema;
    try {
      schema = await loadWorkflowSchema();
    } catch (e) {
      toast('Failed to load workflow schema: ' + (e.message || 'unknown'), 'error');
      return;
    }
    if (!state.interactive) {
      // Read-only fallback: show what would be submitted as a CLI command.
      renderReadOnlyNewRun(schema);
      return;
    }
    renderInteractiveNewRun(schema);
  }
  function renderReadOnlyNewRun(schema) {
    const root = $('modal-root');
    const overlay = el('div', { class: 'modal-overlay', onclick: (e) => { if (e.target === overlay) closeModal(); } });
    const modal = el('div', { class: 'modal' });
    overlay.appendChild(modal);
    modal.appendChild(el('div', { class: 'modal-header' }, [
      el('div', null, [el('strong', null, 'NEW RUN'), el('span', { style: 'color: var(--foreground-muted); margin-left: 8px; font-size: 11px;' }, '— read-only: copy the CLI command')]),
      el('button', { class: 'modal-close', onclick: closeModal }, '✕'),
    ]));
    const body = el('div', { class: 'modal-body' });
    body.appendChild(el('p', { style: 'color: var(--foreground-secondary); margin-bottom: var(--space-md); font-size: 12px;' },
      'Set FORGE_DASHBOARD_INTERACTIVE=1 before launching to enable the form. Until then, copy the CLI:'));
    const example = 'forge new <workflow> "<title>" --project <path> [--brief "..."] [--design-dir <path>]';
    body.appendChild(el('div', { class: 'cli-block' }, [
      el('span', null, example),
      el('button', { class: 'copy', onclick: (e) => copyText(e, example) }, 'copy'),
    ]));
    body.appendChild(el('p', { style: 'color: var(--foreground-muted); margin-top: var(--space-md); font-size: 11px;' },
      'Workflows: ' + schema.order.join(', ') + '.'));
    modal.appendChild(body);
    modal.appendChild(el('div', { class: 'modal-footer' }, [
      el('button', { class: 'btn', onclick: closeModal }, 'Close'),
    ]));
    root.appendChild(overlay);
  }
  function renderInteractiveNewRun(schema) {
    const root = $('modal-root');
    const overlay = el('div', { class: 'modal-overlay', onclick: (e) => { if (e.target === overlay) closeModal(); } });
    const modal = el('div', { class: 'modal' });
    overlay.appendChild(modal);
    // Form state lives on a closure object so re-rendering fields preserves
    // values across workflow-picker changes that share field names.
    const formState = {
      workflow: schema.order[0],
      values: {}, // keyed by field name; persists across workflow re-renders
      errors: {}, // keyed by field name
      submitting: false,
    };
    modal.appendChild(el('div', { class: 'modal-header' }, [
      el('div', null, [el('strong', null, 'NEW RUN')]),
      el('button', { class: 'modal-close', onclick: closeModal }, '✕'),
    ]));
    const body = el('div', { class: 'modal-body' });
    modal.appendChild(body);
    const footer = el('div', { class: 'modal-footer' });
    const submitBtn = el('button', { class: 'btn btn-primary', onclick: () => submitNewRun(schema, formState, body, submitBtn) }, '▶ Create run');
    footer.appendChild(el('button', { class: 'btn', onclick: closeModal }, 'Cancel'));
    footer.appendChild(submitBtn);
    modal.appendChild(footer);
    rerenderNewRunBody(schema, formState, body);
    root.appendChild(overlay);
  }
  function rerenderNewRunBody(schema, formState, body) {
    body.innerHTML = '';
    const spec = schema.workflows[formState.workflow];

    // Workflow picker — first field, drives the rest.
    const pickerRow = el('div', { class: 'form-row' });
    pickerRow.appendChild(el('label', null, ['Workflow', el('span', { class: 'req' }, '*')]));
    const select = el('select', {
      onchange: (e) => {
        formState.workflow = e.target.value;
        // Reset only field-level errors; preserve user input on shared field names.
        formState.errors = {};
        rerenderNewRunBody(schema, formState, body);
      },
    });
    for (const w of schema.order) {
      const opt = el('option', { value: w }, w);
      if (w === formState.workflow) opt.selected = true;
      select.appendChild(opt);
    }
    pickerRow.appendChild(select);
    pickerRow.appendChild(el('div', { class: 'help' }, spec.description));
    body.appendChild(pickerRow);

    body.appendChild(el('div', { class: 'workflow-desc' }, [
      'Required: ',
      el('code', null, ['title', ', ', 'project'].concat(spec.fields.filter(f => f.required).map(f => f.name)).filter(Boolean).join(', ')),
    ]));

    // Universal fields then per-workflow fields.
    const allFields = schema.universal.concat(spec.fields);
    for (const f of allFields) body.appendChild(renderField(f, formState, schema, body));
  }
  function renderField(f, formState, schema, body) {
    const wrap = el('div', { class: 'form-row' + (formState.errors[f.name] ? ' has-err' : '') });
    const labelChildren = [f.label];
    if (f.required) labelChildren.push(el('span', { class: 'req' }, '*'));
    wrap.appendChild(el('label', null, labelChildren));
    const value = formState.values[f.name] != null ? formState.values[f.name] : (f.defaultValue || '');
    const inputAttrs = {
      placeholder: f.placeholder || '',
      value,
      oninput: (e) => {
        formState.values[f.name] = e.target.value;
        // Clear field error on edit; full validation runs at submit.
        if (formState.errors[f.name]) {
          delete formState.errors[f.name];
          // Light-touch error clearing: don't re-render the whole modal on
          // every keystroke. Just remove the err class + message from this row.
          wrap.classList.remove('has-err');
          const errEl = wrap.querySelector('.err');
          if (errEl) errEl.remove();
        }
      },
    };
    let input;
    if (f.type === 'textarea') {
      input = el('textarea', inputAttrs);
      input.value = value;
    } else {
      input = el('input', { ...inputAttrs, type: 'text' });
      input.value = value;
    }
    wrap.appendChild(input);
    if (f.help) wrap.appendChild(el('div', { class: 'help' }, f.help));
    if (formState.errors[f.name]) wrap.appendChild(el('div', { class: 'err' }, formState.errors[f.name]));
    return wrap;
  }
  async function submitNewRun(schema, formState, body, submitBtn) {
    if (formState.submitting) return;
    // Client-side preflight: required fields filled, paths look absolute. Mirrors
    // the server validation in workflowSchema.validateNewRunBody.
    const errors = {};
    const spec = schema.workflows[formState.workflow];
    const allFields = schema.universal.concat(spec.fields);
    for (const f of allFields) {
      const v = (formState.values[f.name] || '').trim();
      if (f.required && !v) {
        errors[f.name] = f.label + ' is required.';
        continue;
      }
      if (v && f.type === 'path') {
        if (!v.startsWith('/') && !v.startsWith('~')) {
          errors[f.name] = f.label + ' must be an absolute path.';
        }
      }
    }
    if (Object.keys(errors).length > 0) {
      formState.errors = errors;
      rerenderNewRunBody(schema, formState, body);
      return;
    }

    formState.submitting = true;
    submitBtn.disabled = true;
    submitBtn.textContent = '… creating';
    try {
      const payload = { workflow: formState.workflow, ...formState.values };
      const resp = await fetchJSON('/api/runs', { method: 'POST', body: payload });
      toast('Run created: ' + (resp.runId || '(unknown id)'), 'success');
      closeModal();
      await loadRuns();
      if (resp.runId) await selectRun(resp.runId);
    } catch (e) {
      // Server returned 400 with field-level errors → show inline. Otherwise
      // generic toast. fetchJSON attaches parsed body to e.data on non-2xx.
      if (e.data && Array.isArray(e.data.errors)) {
        const newErrors = {};
        for (const er of e.data.errors) newErrors[er.field] = er.message;
        formState.errors = newErrors;
        rerenderNewRunBody(schema, formState, body);
      } else {
        toast('Create failed: ' + (e.message || 'unknown'), 'error');
      }
    } finally {
      formState.submitting = false;
      submitBtn.disabled = false;
      submitBtn.textContent = '▶ Create run';
    }
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
