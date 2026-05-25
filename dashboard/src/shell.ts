// HTML shell. The client (main.js + renderers.js) is served as separate
// static files under /client/* — keeps the JS as actual readable JS
// (no nested-template-literal escape gymnastics) and lets the browser
// cache it independently.

export function renderShell(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>forge dashboard</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<link rel="icon" type="image/png" sizes="16x16"  href="/client/favicon-16.png" />
<link rel="icon" type="image/png" sizes="32x32"  href="/client/favicon-32.png" />
<link rel="icon" type="image/png" sizes="48x48"  href="/client/favicon-48.png" />
<link rel="apple-touch-icon" sizes="180x180" href="/client/apple-touch-icon.png" />
<link rel="icon" type="image/png" sizes="192x192" href="/client/icon-192.png" />
<link rel="icon" type="image/png" sizes="512x512" href="/client/icon-512.png" />
<style>${CSS}</style>
</head>
<body>
<div id="app"></div>
<script type="module" src="/client/main.js"></script>
</body>
</html>`;
}

const CSS = String.raw`
:root {
  --bg: #0e0e10;
  --bg-elev: #17171a;
  --bg-elev-2: #1f1f24;
  --border: #2a2a31;
  --fg: #e5e5e7;
  --fg-dim: #9a9aa3;
  --fg-faint: #5d5d65;
  --accent: #7a9fff;
  --ok: #4ade80;
  --warn: #facc15;
  --err: #f87171;
  --info: #60a5fa;
  --magenta: #c084fc;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif;
  background: var(--bg);
  color: var(--fg);
}
.app {
  max-width: 1100px;
  margin: 0 auto;
  padding: 24px 24px 96px;
}
h1, h2, h3 { margin: 0; font-weight: 600; }
h1 { font-size: 18px; }
h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--fg-dim); margin-bottom: 8px; }
h3 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--fg-dim); margin: 16px 0 8px; }
.muted { color: var(--fg-dim); }
.faint { color: var(--fg-faint); }
.mono { font-family: ui-monospace, "SF Mono", Menlo, monospace; }
.row { display: flex; gap: 12px; align-items: baseline; }

header.topbar {
  display: flex; justify-content: space-between; align-items: center;
  padding-bottom: 16px; border-bottom: 1px solid var(--border);
}
header.topbar h1 { display: flex; align-items: center; gap: 10px; }
header.topbar .brand-mark {
  width: 32px; height: 32px;
  flex: 0 0 auto;
}
header.topbar .status-dot {
  display: inline-block; width: 8px; height: 8px; border-radius: 50%;
  background: var(--ok); margin-right: 6px;
  animation: pulse 2s ease-in-out infinite;
}
@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.5} }

section.in-flight {
  margin-top: 20px;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 16px;
}
section.in-flight .item {
  display: grid;
  grid-template-columns: 140px 1fr auto;
  gap: 12px;
  padding: 8px 0;
  border-bottom: 1px solid var(--border);
  cursor: pointer;
}
section.in-flight .item:last-child { border-bottom: none; }
section.in-flight .item:hover { background: var(--bg-elev-2); }
section.in-flight .empty { color: var(--fg-faint); font-style: italic; }

section.feed { margin-top: 24px; }
.card {
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 16px;
  margin-bottom: 12px;
  cursor: pointer;
  transition: background 0.1s;
}
.card:hover { background: var(--bg-elev-2); }
.card .head {
  display: flex; justify-content: space-between; align-items: center; gap: 12px;
  margin-bottom: 8px;
}
.card .agent { font-weight: 600; color: var(--fg); }
.card .context { font-size: 12px; color: var(--fg-dim); }
.card .preview {
  font-size: 13px;
  color: var(--fg-dim);
  white-space: pre-wrap;
  max-height: 60px;
  overflow: hidden;
  position: relative;
}
.card .preview::after {
  content: "";
  position: absolute; bottom: 0; left: 0; right: 0; height: 24px;
  background: linear-gradient(to bottom, transparent, var(--bg-elev));
}

.badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.02em;
}
.model-badge {
  display: inline-block;
  padding: 1px 6px;
  border-radius: 3px;
  font-size: 10px;
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  background: rgba(122, 159, 255, 0.12);
  color: var(--accent);
  margin-left: 6px;
  vertical-align: middle;
}
/* Per-project identity chip. Background color is injected inline from the
 * resolved projectColor (.vscode titleBar.activeBackground or hash fallback);
 * white text is hard-coded because dashboard's dark theme guarantees the
 * project colors will be saturated mid-tones. See #143. */
.project-chip {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 3px;
  font-size: 11px;
  font-weight: 600;
  color: #fff;
  margin-right: 8px;
  vertical-align: middle;
  text-shadow: 0 0 2px rgba(0, 0, 0, 0.35);
  cursor: default;
}
.badge.status-complete, .badge.status-pass { background: rgba(74, 222, 128, 0.15); color: var(--ok); }
.badge.status-failed, .badge.status-fail { background: rgba(248, 113, 113, 0.15); color: var(--err); }
.badge.status-awaiting_gate { background: rgba(250, 204, 21, 0.15); color: var(--warn); }
.badge.status-awaiting_red { background: rgba(96, 165, 250, 0.15); color: var(--info); }
.badge.status-awaiting_human_input { background: rgba(192, 132, 252, 0.15); color: var(--magenta); }
.badge.status-blocked_by_red { background: rgba(248, 113, 113, 0.15); color: var(--err); }
.badge.status-running { background: rgba(96, 165, 250, 0.15); color: var(--info); }
.badge.status-pending { background: rgba(154, 154, 163, 0.15); color: var(--fg-dim); }

.detail-overlay {
  position: fixed; inset: 0;
  background: rgba(0,0,0,0.7);
  display: flex; justify-content: center; align-items: flex-start;
  z-index: 10;
  padding: 40px 24px;
  overflow-y: auto;
}
.detail {
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 8px;
  width: 100%; max-width: 900px;
  padding: 24px;
}
.detail .close {
  float: right; cursor: pointer; color: var(--fg-dim); font-size: 20px; line-height: 1;
}
.detail pre {
  background: var(--bg); padding: 12px; border-radius: 4px;
  overflow-x: auto; font-size: 12px;
  max-height: 400px; overflow-y: auto;
}
.detail .log { font-size: 11px; max-height: 300px; }

.subcard {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 12px;
  margin-bottom: 8px;
}
.subcard:last-child { margin-bottom: 0; }

.md p { margin: 0 0 8px; }
.md p:last-child { margin-bottom: 0; }
.md code { background: var(--bg); padding: 1px 4px; border-radius: 3px; font-size: 12px; }
.md pre { background: var(--bg); padding: 8px; border-radius: 4px; overflow-x: auto; }
.md ul, .md ol { margin: 4px 0 8px; padding-left: 20px; }
.md a { color: var(--accent); }
.md strong { color: var(--fg); }
`;
