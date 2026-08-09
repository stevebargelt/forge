// HTML shell. The client (main.js + renderers.js) is served as separate
// static files under /client/* — keeps the JS as actual readable JS
// (no nested-template-literal escape gymnastics) and lets the browser
// cache it independently.

import { randomBytes } from "node:crypto";

// FG-580 — the ONE wiring point that resolves the vendored client-lib module
// graph. The client imports the bare specifiers `preact`, `preact/hooks`, `htm`
// and `marked`; this import map points them at the first-party vendored ESM under
// /client/vendor/** (produced by scripts/vendor-dashboard-libs.mjs). Because the
// vendored bytes are byte-identical to the upstream dist, `preact/hooks`'s own
// internal `import ... from "preact"` also resolves through this map — so a
// promoted release boots and renders with NO network fetch of executable JS.
// Keep these paths in sync with scripts/vendor-dashboard-libs.mjs.
const IMPORT_MAP = JSON.stringify({
  imports: {
    preact: "/client/vendor/preact/preact.js",
    "preact/hooks": "/client/vendor/preact/hooks.js",
    htm: "/client/vendor/htm/htm.js",
    marked: "/client/vendor/marked/marked.js",
  },
});

// FG-580: the served Content-Security-Policy makes "no CDN-executed JS" a RUNTIME
// invariant, not just a test property — the browser itself refuses any script whose
// origin is not first-party. `script-src 'self'` allows the same-origin module graph
// (/client/*.js + the vendored /client/vendor/**), and the per-response nonce below
// permits the ONE inline script the shell carries: the `<script type="importmap">`.
// An import map MUST be inline (browsers do not honour `src=` on it), so it cannot move
// to a same-origin file — a nonce is the correct way to admit it under strict CSP. Only
// script-src is constrained; inline <style> and images stay unrestricted (no default-src),
// so tightening scripts does not break the existing stylesheet or favicons.
export function contentSecurityPolicy(nonce: string): string {
  return `script-src 'self' 'nonce-${nonce}'`;
}

/** A fresh per-response CSP nonce. base64 of 16 random bytes — matched verbatim between
 *  the CSP header (contentSecurityPolicy) and the inline importmap's nonce attribute. */
export function cspNonce(): string {
  return randomBytes(16).toString("base64");
}

export function renderShell(nonce?: string): string {
  // With a nonce the inline importmap is admitted under `script-src 'self' 'nonce-…'`;
  // without one (a fixture/test that serves the shell with no CSP) it is a plain inline
  // script, exactly as before.
  const importmapNonce = nonce ? ` nonce="${nonce}"` : "";
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
<script type="importmap"${importmapNonce}>
${IMPORT_MAP}
</script>
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
header.topbar h1 { display: flex; align-items: center; flex: 1 1 auto; gap: 10px; min-width: 0; }
header.topbar > .muted { flex: 0 0 auto; margin-left: 12px; }
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
section.in-flight .item, section.verify-view .item {
  display: grid;
  grid-template-columns: 140px 1fr auto;
  gap: 12px;
  padding: 8px 0;
  border-bottom: 1px solid var(--border);
  cursor: pointer;
}
section.in-flight .item:last-child, section.verify-view .item:last-child { border-bottom: none; }
section.in-flight .item:hover, section.verify-view .item:hover { background: var(--bg-elev-2); }
section.in-flight .empty { color: var(--fg-faint); font-style: italic; }

.orch-group {
  border-bottom: 1px solid var(--border);
  margin-bottom: 8px;
  padding-bottom: 8px;
}
.orch-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 0;
  cursor: pointer;
  color: var(--fg-muted);
  font-size: 12px;
  user-select: none;
}
.orch-header:hover { color: var(--fg); }
.orch-chevron {
  display: inline-block;
  transition: transform 0.15s ease;
  font-size: 10px;
}
.orch-chevron.open { transform: rotate(90deg); }
.orch-summary { font-weight: 500; }
section.in-flight .item.item-muted { opacity: 0.6; }
section.in-flight .item.item-muted:hover { opacity: 1; }

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
.project-identity { display: inline-flex; align-items: center; vertical-align: middle; }
.project-identity .project-chip { margin-right: 4px; }
.checkout-chip,
.checkout-context {
  display: inline-block;
  border: 1px solid var(--border);
  border-radius: 3px;
  color: var(--fg-dim);
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  font-size: 10px;
  font-weight: 500;
  line-height: 1.4;
  margin-right: 8px;
  padding: 1px 6px;
  vertical-align: middle;
}
.checkout-context { margin-bottom: 8px; }
.badge.status-complete, .badge.status-pass { background: rgba(74, 222, 128, 0.15); color: var(--ok); }
.badge.status-failed, .badge.status-fail { background: rgba(248, 113, 113, 0.15); color: var(--err); }
.badge.status-awaiting_gate { background: rgba(250, 204, 21, 0.15); color: var(--warn); }
.badge.status-awaiting_red { background: rgba(96, 165, 250, 0.15); color: var(--info); }
.badge.status-blocked_by_red { background: rgba(248, 113, 113, 0.15); color: var(--err); }
.badge.status-awaiting_recovery { background: rgba(250, 204, 21, 0.15); color: var(--warn); }
.badge.status-running { background: rgba(96, 165, 250, 0.15); color: var(--info); }
.badge.status-pending { background: rgba(154, 154, 163, 0.15); color: var(--fg-dim); }
/* FG-566: an environment/readiness REFUSAL — the verification never ran, so this
   must not read as the red of a failed verification NOR as the grey of something
   still in flight. Amber with a dashed edge: terminal, but not a verdict on the
   code. */
.badge.status-environment_unavailable {
  background: rgba(250, 204, 21, 0.12);
  border: 1px dashed var(--warn);
  color: var(--warn);
}
/* #290: a running task whose container is gone — stale DB row, needs reconcile. */
.badge.status-reconcile_candidate { background: rgba(250, 204, 21, 0.18); color: var(--warn); }

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

/* #154: top-level view tabs (activity / projects). */
nav.view-tabs {
  display: flex;
  gap: 4px;
  min-width: 0;
  overflow-x: auto;
  overscroll-behavior-x: contain;
  scrollbar-width: none;
}
nav.view-tabs::-webkit-scrollbar { display: none; }
nav.view-tabs .tab {
  background: transparent;
  border: none;
  color: var(--fg-dim);
  font: inherit;
  font-size: 18px;
  font-weight: 600;
  padding: 4px 10px;
  cursor: pointer;
  border-radius: 4px;
  transition: color 0.1s, background 0.1s;
}
nav.view-tabs .tab:hover { color: var(--fg); background: var(--bg-elev); }
nav.view-tabs .tab-active { color: var(--fg); }

/* #154: filter banner shown when activity feed is scoped to one project. */
.filter-banner {
  display: flex; justify-content: space-between; align-items: center;
  margin-top: 16px; padding: 8px 12px;
  background: rgba(122, 159, 255, 0.08);
  border: 1px solid rgba(122, 159, 255, 0.25);
  border-radius: 6px;
  font-size: 13px;
}
.filter-banner strong { color: var(--accent); }
.project-scope-banner { gap: 10px; flex-wrap: wrap; }
.project-scope-options { display: flex; gap: 4px; flex: 1; flex-wrap: wrap; }
.checkout-scope-btn {
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--fg-dim);
  cursor: pointer;
  font: 10px ui-monospace, "SF Mono", Menlo, monospace;
  padding: 3px 7px;
}
.checkout-scope-btn:hover { color: var(--fg); border-color: var(--fg-dim); }
.checkout-scope-btn-active { background: rgba(122, 159, 255, 0.16); border-color: var(--accent); color: var(--accent); }
.clear-filter {
  background: transparent; border: 1px solid var(--border); color: var(--fg-dim);
  font: inherit; font-size: 12px; padding: 2px 8px; border-radius: 4px; cursor: pointer;
}
.clear-filter:hover { color: var(--fg); border-color: var(--fg-dim); }

/* "copy id" button in the task-detail header. */
.copy-id {
  background: transparent; border: 1px solid var(--border); color: var(--fg-dim);
  font: inherit; font-size: 10px; padding: 1px 6px; border-radius: 4px; cursor: pointer;
  margin: 0 6px; vertical-align: middle; transition: color 0.1s, border-color 0.1s;
}
.copy-id:hover { color: var(--fg); border-color: var(--fg-dim); }
.copy-id.copied { color: var(--ok); border-color: var(--ok); }

/* #154: projects grid + cards. */
section.projects-grid {
  margin-top: 20px;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 12px;
}
.project-card {
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 14px;
  cursor: pointer;
  transition: background 0.1s, border-color 0.1s;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.project-card:hover { background: var(--bg-elev-2); border-color: var(--fg-faint); }

/* State-driven dimming: live > active > recent > idle > stale. */
.project-card.state-live   { border-color: rgba(74, 222, 128, 0.45); }
.project-card.state-active { opacity: 1; }
.project-card.state-recent { opacity: 0.92; }
.project-card.state-idle   { opacity: 0.72; }
.project-card.state-stale  { opacity: 0.5; }

.project-card-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.project-card-head .project-chip { font-size: 12px; padding: 2px 10px; cursor: default; }
/* FG-438: GitHub repo link on the project card. margin-left:auto pins it right so
   the chip/live-indicator cluster left; stopPropagation on click keeps card
   selection intact. */
.project-github {
  margin-left: auto;
  font-size: 11px;
  font-weight: 600;
  color: var(--accent);
  text-decoration: none;
  padding: 2px 8px;
  border-radius: 10px;
  border: 1px solid var(--fg-faint);
  white-space: nowrap;
}
.project-github:hover { background: var(--bg-elev-2); text-decoration: underline; }
.live-indicator {
  font-size: 11px;
  font-weight: 600;
  color: var(--ok);
  letter-spacing: 0.05em;
  background: rgba(74, 222, 128, 0.12);
  padding: 2px 8px;
  border-radius: 10px;
  animation: pulse 2s ease-in-out infinite;
}

.project-desc {
  font-size: 13px;
  color: var(--fg);
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.project-stats {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 8px;
  padding-top: 6px;
  border-top: 1px solid var(--border);
}
.project-stat-label {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--fg-faint);
}
.project-stat-val {
  font-size: 14px;
  font-weight: 600;
  color: var(--fg);
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
}
.project-stat-val.stat-warn { color: var(--warn); }

.project-checkouts {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 190px;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
}
.project-checkout-row {
  align-items: baseline;
  background: transparent;
  border: 0;
  border-radius: 4px;
  color: inherit;
  cursor: pointer;
  display: grid;
  gap: 8px;
  grid-template-columns: minmax(90px, auto) minmax(0, 1fr);
  padding: 4px 5px;
  text-align: left;
  width: 100%;
}
.project-checkout-row:hover,
.project-checkout-row:focus-visible { background: var(--bg); outline: none; }
.checkout-branch { color: var(--fg-dim); font-size: 11px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.checkout-branch.checkout-missing { color: var(--warn, var(--err)); font-style: italic; }
.project-checkout-row .project-path { direction: ltr; text-align: right; }

.project-path {
  font-size: 10px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  direction: rtl; /* truncate the prefix, keep the tail (basename) visible */
  text-align: left;
}

/* Usage view */
section.usage-section { margin-top: 20px; }
section.home-view { margin-top: 20px; }
section.home-view .plan-usage { margin-bottom: 0; }
.home-in-flight-group { margin-top: 28px; }
section.home-view section.in-flight { margin-top: 0; }

/* FG-679 — the Current activity surface: Agents / Host verification / Required CI.
   The three sections are visually DISTINCT on purpose (their own heading and their
   own bordered block), because BD-1 turns on an operator being able to tell "an
   agent is working" from "host verification is running" from "a check is pending"
   at a glance. The launch badges are keyed on the structured status state and none
   of them is a generic failed: SIGTERM-terminated, a bare signal-range exited
   143, owner-gone and unknown are four different facts (BD-4). */
section.current-activity { margin-top: 28px; }
.ca-section {
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 8px;
  margin-top: 10px;
  overflow: hidden;
}
.ca-heading {
  margin: 0;
  padding: 10px 14px;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--fg-dim);
  border-bottom: 1px solid var(--border);
}
/* FG-694 — Home says one thing at a time. Loading, "Nothing currently running." and
   "Current activity unavailable" are three MUTUALLY EXCLUSIVE states; the pre-fix
   surface rendered its loading line alongside three empty sections and so said all
   of them at once. There is no empty-section style any more, because an empty
   section does not render (AC6). */
.ca-loading, .ca-nothing { padding: 12px 14px; color: var(--fg-faint); font-style: italic; }
.ca-unavailable {
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-left: 3px solid var(--warn);
  border-radius: 8px;
  background: var(--bg-elev);
  margin-top: 10px;
}
.ca-unavailable-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.ca-unavailable-detail { margin-top: 4px; font-size: 12px; color: var(--fg-dim); }
.ca-retry {
  flex: none;
  padding: 4px 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  color: var(--fg);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.ca-retry:hover { border-color: var(--accent); }
.ca-retry:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.ca-section .item.ca-row {
  display: grid;
  grid-template-columns: minmax(0, auto) 1fr auto;
  gap: 12px;
  align-items: start;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
}
.ca-section .item.ca-row:last-child { border-bottom: none; }
/* The agent row navigates to its task — it is a control, so it takes focus and shows it. */
.ca-section .item.ca-agent-row { cursor: pointer; }
.ca-section .item.ca-agent-row:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.ca-launch-row .badge, .ca-ci-row .badge { white-space: normal; text-align: left; max-width: 30ch; }
.ca-assoc-badge {
  margin-left: 8px;
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  background: rgba(154, 154, 163, 0.18);
  color: var(--fg-dim);
}
.ca-sha { word-break: break-all; }

/* FG-694 AC4/AC5 — the compact CI line and the drill-down that keeps the evidence.
   A native <details>: the disclosure is keyboard-operable and announced without a
   hand-rolled aria-expanded that can drift out of sync with the state it names. The
   marker is kept (and given a visible focus ring) because a disclosure nobody can
   see is a detail nobody reaches. */
.ca-ci-item { border-bottom: 1px solid var(--border); }
.ca-ci-item:last-child { border-bottom: none; }
.ca-ci-summary { padding: 10px 14px; cursor: pointer; list-style-position: inside; }
.ca-ci-summary::marker { color: var(--fg-dim); font-size: 11px; }
.ca-ci-summary:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.ca-ci-summary:hover { background: rgba(154, 154, 163, 0.06); }
.ca-ci-line { display: inline-flex; flex-wrap: wrap; gap: 4px; align-items: baseline; }
.ca-ci-detail-text { color: var(--fg-dim); font-size: 12px; }
.ca-ci-evidence { padding: 0 14px 12px 14px; }
.ca-ci-candidate { font-size: 11px; display: flex; flex-wrap: wrap; gap: 8px; }
.ca-ci-observed { color: var(--fg-faint); }
/* One class per compact state. The unavailable state is deliberately not coloured as
   a failure: not knowing is not a red check. */
.badge.ci-compact-running { background: rgba(96, 165, 250, 0.15); color: var(--info); }
.badge.ci-compact-failed { background: rgba(248, 113, 113, 0.15); color: var(--err); }
.badge.ci-compact-passed { background: rgba(74, 222, 128, 0.15); color: var(--ok); }
.badge.ci-compact-not_started { background: rgba(154, 154, 163, 0.15); color: var(--fg-dim); }
.badge.ci-compact-not_running { background: rgba(154, 154, 163, 0.15); color: var(--fg-dim); }
.badge.ci-compact-unavailable { background: rgba(250, 204, 21, 0.15); color: var(--warn); }

.ca-ci-contexts { margin-top: 4px; display: flex; flex-direction: column; gap: 3px; }
.ca-ci-context { display: flex; flex-wrap: wrap; gap: 8px; align-items: baseline; font-size: 11px; }
.ca-ctx-name { color: var(--fg); }
.ca-ctx-state { padding: 0 5px; border-radius: 4px; }
.ca-ctx-observed { color: var(--fg-faint); }
.ca-ctx-pending { background: rgba(250, 204, 21, 0.15); color: var(--warn); }
.ca-ctx-success { background: rgba(74, 222, 128, 0.15); color: var(--ok); }
.ca-ctx-failure { background: rgba(248, 113, 113, 0.15); color: var(--err); }
.ca-ctx-unknown { background: rgba(154, 154, 163, 0.15); color: var(--fg-dim); }

/* One class per STRUCTURED launch state. Deliberately no failed class: flattening
   any of these into a generic failure badge is the honesty regression BD-4 bans. */
.badge.launch-state-running { background: rgba(96, 165, 250, 0.15); color: var(--info); }
.badge.launch-state-exited_ok { background: rgba(74, 222, 128, 0.15); color: var(--ok); }
.badge.launch-state-exited_error { background: rgba(248, 113, 113, 0.15); color: var(--err); }
.badge.launch-state-signaled { background: rgba(192, 132, 252, 0.18); color: var(--magenta); }
.badge.launch-state-terminated_unattributed { background: rgba(250, 204, 21, 0.15); color: var(--warn); }
.badge.launch-state-owner_gone { background: rgba(250, 204, 21, 0.18); color: var(--warn); }
.badge.launch-state-unknown { background: rgba(154, 154, 163, 0.15); color: var(--fg-dim); }
.badge.launch-state-unobserved { background: rgba(154, 154, 163, 0.15); color: var(--fg-dim); font-style: italic; }

.badge.ci-state-running { background: rgba(96, 165, 250, 0.15); color: var(--info); }
.badge.ci-state-not_running { background: rgba(154, 154, 163, 0.15); color: var(--fg-dim); }
.badge.ci-state-stale { background: rgba(250, 204, 21, 0.15); color: var(--warn); }
.badge.ci-state-not_observed { background: rgba(154, 154, 163, 0.15); color: var(--fg-dim); }

/* FG-694 post-ship correction — the host/CI waits folded into Home's In flight list.
   They borrow section.in-flight .item's grid deliberately: a wait is part of the same
   list an operator is already reading, not a second visual language stacked above it.
   No cursor, because unlike a task row they navigate nowhere. */
section.in-flight .item.ca-wait-row { cursor: default; align-items: baseline; }
section.in-flight .item.ca-wait-row:hover { background: none; }
.ca-wait-unavailable { align-items: center; }
.ca-wait-unavailable .ca-retry { justify-self: end; }
.home-ops-summary { margin-top: 28px; }
.home-section-heading {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 12px;
}
.home-section-heading h2 {
  margin: 0;
  color: var(--fg);
  font-size: 18px;
  line-height: 1.25;
  letter-spacing: -0.015em;
}
.home-section-kicker {
  color: var(--fg-faint);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.16em;
  margin-bottom: 4px;
  text-transform: uppercase;
}

.plan-usage { margin-bottom: 34px; }
.plan-usage-heading {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 12px;
}
.plan-usage-heading h2,
.usage-analytics-heading h2 {
  margin: 0;
  color: var(--fg);
  font-size: 18px;
  line-height: 1.25;
  letter-spacing: -0.015em;
}
.plan-usage-kicker {
  color: var(--fg-faint);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.16em;
  margin-bottom: 4px;
  text-transform: uppercase;
}
.plan-usage-actions { display: flex; align-items: center; gap: 12px; }
.plan-usage-sync {
  color: var(--fg-faint);
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  font-size: 10px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.plan-refresh {
  align-items: center;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--fg-dim);
  cursor: pointer;
  display: inline-flex;
  font: inherit;
  font-size: 10px;
  gap: 5px;
  letter-spacing: 0.06em;
  padding: 6px 9px;
  text-transform: uppercase;
}
.plan-refresh:hover { background: var(--bg-elev-2); color: var(--fg); }
.plan-refresh:disabled { cursor: default; opacity: 0.55; }
.plan-refresh-icon { display: inline-block; font-size: 14px; line-height: 10px; }
.plan-refresh-icon.spinning { animation: plan-spin 0.8s linear infinite; }
@keyframes plan-spin { to { transform: rotate(360deg); } }
.plan-refresh-error {
  background: rgba(250, 204, 21, 0.07);
  border: 1px solid rgba(250, 204, 21, 0.22);
  border-radius: 6px;
  color: var(--warn);
  font-size: 11px;
  margin-bottom: 10px;
  padding: 8px 10px;
}

.plan-services {
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 12px;
  overflow: hidden;
}
.plan-service {
  background-image: radial-gradient(70% 150% at 0 50%, color-mix(in srgb, var(--service-color) 8%, transparent), transparent 65%);
  display: grid;
  gap: 28px;
  grid-template-columns: minmax(230px, 0.8fr) minmax(300px, 1.7fr);
  padding: 20px 22px;
}
.plan-service + .plan-service { border-top: 1px solid var(--border); }
.plan-service-identity { align-items: center; display: flex; gap: 15px; min-width: 0; }
.plan-dial {
  flex: 0 0 76px;
  height: 76px;
  position: relative;
  width: 76px;
}
.plan-dial-ring { display: block; transform: rotate(-90deg); }
.plan-dial-track,
.plan-dial-progress { fill: none; }
.plan-dial-track { stroke: rgba(255, 255, 255, 0.06); }
.plan-dial-progress {
  filter: drop-shadow(0 0 6px color-mix(in srgb, var(--service-color) 53%, transparent));
  stroke-linecap: round;
  transition: stroke-dashoffset 600ms;
}
.plan-dial-inner {
  bottom: 0;
  align-items: center;
  color: var(--fg);
  display: flex;
  flex-direction: column;
  justify-content: center;
  left: 0;
  position: absolute;
  right: 0;
  top: 0;
}
.plan-dial-gauge {
  color: var(--service-color);
  fill: none;
  height: 12px;
  margin-bottom: 2px;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 2;
  width: 12px;
}
.plan-dial-value {
  color: var(--service-color);
  font-family: ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji";
  font-size: 14px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  line-height: 14px;
}
.plan-dial-unknown .plan-dial-gauge,
.plan-dial-unknown .plan-dial-value { color: var(--fg-faint); }
.plan-service-copy { min-width: 0; }
.plan-service-name-row { align-items: center; display: flex; gap: 8px; }
.plan-service-name-row strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.plan-service-mark {
  align-items: center;
  background: color-mix(in srgb, var(--service-color) 14%, transparent);
  border: 1px solid color-mix(in srgb, var(--service-color) 45%, transparent);
  border-radius: 5px;
  color: var(--service-color);
  display: inline-flex;
  flex: 0 0 25px;
  font-size: 11px;
  font-weight: 700;
  height: 25px;
  justify-content: center;
  overflow: hidden;
}
.plan-service-logo { display: block; height: 17px; object-fit: contain; width: 17px; }
.plan-service-logo-invert { filter: invert(1); }
.plan-service-plan { color: var(--fg-dim); font-size: 11px; margin: 7px 0 8px 33px; }
.plan-service-meta { align-items: center; color: var(--fg-faint); display: flex; font-size: 9px; gap: 8px; margin-left: 33px; text-transform: uppercase; }
.plan-status { border: 1px solid var(--border); border-radius: 3px; padding: 1px 5px; }
.plan-status-live { background: rgba(74, 222, 128, 0.1); border-color: rgba(74, 222, 128, 0.3); color: var(--ok); }
.plan-status-stale,
.plan-status-not_configured { background: rgba(250, 204, 21, 0.1); border-color: rgba(250, 204, 21, 0.3); color: var(--warn); }
.plan-status-error { background: rgba(248, 113, 113, 0.1); border-color: rgba(248, 113, 113, 0.3); color: var(--err); }
.plan-status-not_applicable,
.plan-status-unavailable { color: var(--fg-faint); }
.plan-window-list { display: flex; flex-direction: column; gap: 13px; justify-content: center; min-width: 0; }
.plan-window-top { align-items: baseline; display: flex; gap: 12px; justify-content: space-between; margin-bottom: 6px; }
.plan-window-label { align-items: baseline; display: flex; gap: 9px; min-width: 0; }
.plan-window-label span { color: var(--fg-dim); font-size: 10px; letter-spacing: 0.08em; overflow: hidden; text-overflow: ellipsis; text-transform: uppercase; white-space: nowrap; }
.plan-window-label strong { color: var(--fg); font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 12px; }
.plan-window-detail { color: var(--fg-faint); font-size: 10px; white-space: nowrap; }
.plan-pace { color: var(--service-color); margin-left: 8px; }
.plan-window-track { background: var(--bg-elev-2); border-radius: 4px; height: 8px; overflow: hidden; position: relative; }
.plan-window-fill {
  background: linear-gradient(90deg, color-mix(in srgb, var(--service-color) 65%, transparent), var(--service-color));
  border-radius: 4px;
  box-shadow: 0 0 12px color-mix(in srgb, var(--service-color) 45%, transparent);
  height: 100%;
  min-width: 2px;
  position: absolute;
}
.plan-window-track i { border-left: 1px solid rgba(255,255,255,0.055); bottom: 0; position: absolute; top: 0; }
.plan-window-track i:nth-of-type(1) { left: 25%; }
.plan-window-track i:nth-of-type(2) { left: 50%; }
.plan-window-track i:nth-of-type(3) { left: 75%; }
.plan-service-note { color: var(--fg-dim); font-size: 12px; line-height: 1.5; }
.plan-service-note-inline { color: var(--warn); font-size: 10px; }
.plan-observed { color: var(--fg-faint); font-size: 9px; letter-spacing: 0.04em; text-align: right; text-transform: uppercase; }
.plan-empty { color: var(--fg-faint); padding: 24px; }
.plan-usage-footnote { color: var(--fg-faint); font-size: 10px; line-height: 1.5; margin: 8px 2px 0; }
.usage-analytics-heading { border-top: 1px solid var(--border); margin-bottom: 14px; padding-top: 24px; }

@media (max-width: 720px) {
  .plan-service { grid-template-columns: 1fr; gap: 18px; }
  .plan-window-detail { white-space: normal; text-align: right; }
}
@media (max-width: 520px) {
  section.in-flight .item {
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 6px 10px;
  }
  section.in-flight .item > .badge {
    grid-column: 1 / -1;
    justify-self: start;
  }
  .plan-usage-heading { align-items: flex-start; flex-direction: column; }
  .plan-usage-actions { justify-content: space-between; width: 100%; }
  .plan-service { padding: 17px; }
  .plan-window-top { align-items: flex-start; flex-direction: column; gap: 3px; }
  .plan-window-detail { text-align: left; }
}

.usage-headline {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 12px;
  margin-bottom: 20px;
}
@media (min-width: 600px) {
  .usage-headline { grid-template-columns: repeat(4, 1fr); }
}
.usage-headline-card {
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 16px;
}
.usage-headline-label {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--fg-faint);
  margin-bottom: 6px;
}
.usage-headline-value {
  font-size: 2rem;
  font-weight: 700;
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  color: var(--fg);
  line-height: 1.1;
}
.usage-headline-delta { font-size: 12px; margin-top: 4px; }
.usage-delta-better { color: var(--ok); }
.usage-delta-worse  { color: var(--err); }
.usage-delta-same   { color: var(--fg-faint); }

.usage-dim-selector { display: flex; gap: 6px; margin-bottom: 16px; flex-wrap: wrap; }
.usage-dim-btn {
  background: transparent;
  border: 1px solid var(--border);
  color: var(--fg-dim);
  font: inherit;
  font-size: 12px;
  padding: 3px 10px;
  border-radius: 4px;
  cursor: pointer;
  transition: color 0.1s, background 0.1s, border-color 0.1s;
}
.usage-dim-btn:hover { color: var(--fg); border-color: var(--fg-dim); }
.usage-dim-btn-active {
  background: rgba(122, 159, 255, 0.12);
  border-color: var(--accent);
  color: var(--accent);
}

.usage-rollup { margin-bottom: 24px; }
.usage-row {
  display: grid;
  grid-template-columns: 180px 1fr auto auto;
  gap: 12px;
  align-items: center;
  padding: 8px 0;
  cursor: pointer;
}
.usage-row-wrap {
  border-bottom: 1px solid var(--border);
}
.usage-row-wrap:last-child { border-bottom: none; }
.usage-detail {
  overflow: hidden;
  transition: max-height 0.25s ease;
}
.usage-bucket {
  font-size: 12px;
  color: var(--fg);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.usage-bar-wrap {
  background: var(--bg-elev);
  border-radius: 3px;
  height: 8px;
  overflow: hidden;
}
.usage-bar {
  height: 100%;
  background: var(--accent);
  border-radius: 3px;
  min-width: 2px;
  transition: width 0.3s ease;
}
.usage-cache-badge {
  display: inline-block;
  padding: 1px 6px;
  border-radius: 3px;
  font-size: 10px;
  font-weight: 500;
  white-space: nowrap;
}
.usage-cache-good { background: rgba(74, 222, 128, 0.15);  color: var(--ok); }
.usage-cache-mid  { background: rgba(250, 204, 21, 0.15);  color: var(--warn); }
.usage-cache-bad  { background: rgba(248, 113, 113, 0.15); color: var(--err); }
.usage-reuse-warn {
  background: rgba(250, 204, 21, 0.15);
  color: var(--warn);
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 3px;
  display: inline-block;
  margin-left: 4px;
}
.usage-req-count {
  font-size: 11px;
  color: var(--fg-dim);
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  white-space: nowrap;
}
@media (max-width: 720px) {
  .usage-row { grid-template-columns: minmax(0, 1fr) auto auto; gap: 8px; }
  .usage-row > .usage-bar-wrap { display: none; }
}

.usage-timeseries {
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 16px;
}
.usage-timeseries-title {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--fg-faint);
  margin-bottom: 12px;
}
.usage-timeseries svg { display: block; width: 100%; height: auto; }

/* FG-648: average agent runtime over time (ops view). */
.runtime-view { margin: 24px 0; }
.runtime-controls {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}
.runtime-window-btns, .runtime-tz-btns { display: flex; gap: 6px; flex-wrap: wrap; }
.runtime-selector {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}
.runtime-selector label { font-size: 12px; color: var(--fg-dim); }
.runtime-role-select {
  background: var(--bg-elev);
  border: 1px solid var(--border);
  color: var(--fg);
  font: inherit;
  font-size: 12px;
  padding: 4px 8px;
  border-radius: 4px;
  max-width: 100%;
}
.runtime-sample-note { font-size: 12px; }
.runtime-loading, .runtime-empty, .runtime-error, .runtime-stale { padding: 16px; }
.runtime-error { border-color: var(--err); color: var(--err); }
/* FG-661/RF-15: the series on screen is real, just no longer current — warn, not
 * error, and never in place of the chart it is warning about. */
.runtime-stale { border-color: var(--warn); color: var(--warn); margin-bottom: 12px; }
.runtime-chart {
  margin: 0 0 16px;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 16px;
}
.runtime-chart svg { display: block; width: 100%; height: auto; }
.runtime-bar { transition: height 0.2s ease, y 0.2s ease; }
@media (prefers-reduced-motion: reduce) {
  .runtime-bar { transition: none; }
}
/* No font-size rule for the chart's labels here on purpose. The chart scales its
 * 1000-unit viewBox down to the column width, which would shrink the labels with
 * it; a viewport breakpoint only fixes the widths it samples, so client/main.js
 * measures the rendered width and sizes the labels in user units off it. That
 * holds them at RUNTIME_AXIS_TARGET_PX at EVERY width. A font-size declared here
 * would outrank the presentation attribute and break that. */
/* The per-bucket values, shown only when the chart is too dense to label every
 * bar on the plot itself. aria-hidden: the sr-only table below already carries
 * the same rows, and a screen reader should hear them once. */
.runtime-bucket-values {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 8px;
  list-style: none;
  margin: 10px 0 0;
  padding: 0;
  font-size: 11px;
  color: var(--fg-dim);
}
.runtime-bucket-values li {
  background: var(--bg-elev-2);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 2px 6px;
}
/* The chip carries a full local range now, which is too wide to hold on one line
 * at a phone width. The RANGE itself must not break — half a range names no
 * bucket — so the chip wraps between the range and the value instead. */
.runtime-bucket-values .mono { color: var(--fg); white-space: nowrap; }
.runtime-caption {
  font-size: 11px;
  color: var(--fg-dim);
  margin-top: 8px;
  line-height: 1.5;
}
.runtime-partial-note { color: var(--warn); }
.runtime-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.runtime-table caption {
  text-align: left;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--fg-dim);
  padding-bottom: 8px;
}
.runtime-table th, .runtime-table td {
  text-align: left;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border);
  font-weight: 400;
}
.runtime-table thead th {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--fg-dim);
}
.runtime-table td { white-space: nowrap; }
.runtime-table tbody tr:last-child th, .runtime-table tbody tr:last-child td { border-bottom: none; }
.runtime-row-active { background: rgba(122, 159, 255, 0.08); }
.runtime-role-btn {
  background: transparent;
  border: none;
  color: var(--fg);
  font: inherit;
  padding: 0;
  cursor: pointer;
  text-align: left;
  border-bottom: 1px dotted var(--fg-faint);
  overflow-wrap: anywhere;
}
.runtime-role-btn:hover { color: var(--accent); }
.runtime-role-btn-active { color: var(--accent); border-bottom-color: var(--accent); }

.card.stat { cursor: default; }
.stat-num {
  font-size: 2rem;
  font-weight: 700;
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  color: var(--fg);
  line-height: 1.1;
  margin-bottom: 4px;
}
/* #285 / FG-359: RACI Workbench (read-only routing/governance panel). */
.gov-view { display: flex; flex-direction: column; }
.gov-card { margin-bottom: 8px; }
.badge.gov-src-host { background: rgba(122, 159, 255, 0.15); color: var(--accent); }
.badge.gov-src-project { background: rgba(192, 132, 252, 0.18); color: var(--magenta); }
.badge.gov-path { background: var(--bg-elev-2); color: var(--fg-dim); }
.badge.gov-bad { background: rgba(248, 113, 113, 0.15); color: var(--err); }
.badge.gov-added { background: rgba(74, 222, 128, 0.15); color: var(--ok); }
.badge.gov-removed { background: rgba(248, 113, 113, 0.15); color: var(--err); }
.badge.gov-modified { background: rgba(250, 204, 21, 0.15); color: var(--warn); }
.gov-error { border: 1px solid var(--err); }
.gov-drift { border: 1px solid var(--warn); }
.gov-warn-title { color: var(--warn); margin-bottom: 8px; }
.gov-error .gov-warn-title { color: var(--err); }
.gov-finding { padding: 2px 0; }
.gov-diff-line { padding: 4px 0; }
.gov-field { padding: 1px 0; }
.gov-audit-row + .gov-audit-row { border-top: 1px solid var(--border); }
.gov-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.gov-table th {
  text-align: left;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--fg-faint);
  padding: 4px 10px 8px 0;
  border-bottom: 1px solid var(--border);
}
.gov-table td { padding: 8px 10px 8px 0; border-bottom: 1px solid var(--border); vertical-align: top; }
.gov-table tr:last-child td { border-bottom: none; }
.gov-route-key { color: var(--fg); }
.gov-hints { font-size: 11px; margin-top: 2px; max-width: 240px; }

/* FG-359: workbench four-section labels (SOURCE / DERIVED / EFFECTIVE / RECORDED). */
.workbench-section { margin-top: 8px; }
.workbench-section-label {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.12em;
  color: var(--fg-faint);
  border-top: 1px solid var(--border);
  padding-top: 14px;
  margin-top: 20px;
  margin-bottom: 10px;
}
.workbench-section:first-child .workbench-section-label { border-top: none; padding-top: 0; margin-top: 16px; }

/* Health badge — text + color signal (non-color a11y: symbol prefix, FG-123). */
.gov-health-badge {
  display: inline-block;
  padding: 3px 10px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 600;
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
}
.gov-health-ok   { background: rgba(74,  222, 128, 0.12); color: var(--ok); }
.gov-health-warn { background: rgba(250, 204,  21, 0.12); color: var(--warn); }
.gov-health-err  { background: rgba(248, 113, 113, 0.12); color: var(--err); }

/* #FG-363: backlog view */
.backlog-view { margin-top: 16px; }
.backlog-notes { margin-bottom: 20px; }
.backlog-notes-body { cursor: default; }
.backlog-note-card { cursor: pointer; }
.backlog-note-card:focus,
.backlog-note-card:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.backlog-note-badge { background: rgba(192, 132, 252, 0.14); color: var(--magenta); margin-right: 8px; }
.backlog-note-action { font-size: 10px; white-space: nowrap; }
.backlog-note-path { font-size: 11px; margin-bottom: 16px; overflow-wrap: anywhere; }
.backlog-controls { margin-bottom: 4px; }
.backlog-search {
  background: var(--bg-elev);
  border: 1px solid var(--border);
  color: var(--fg);
  font: inherit;
  font-size: 13px;
  padding: 5px 10px;
  border-radius: 4px;
  width: 280px;
  outline: none;
}
.backlog-search:focus { border-color: var(--accent); box-shadow: 0 0 0 2px rgba(122, 159, 255, 0.2); }
.backlog-search::placeholder { color: var(--fg-faint); }
.backlog-empty { margin: 24px 0; font-style: italic; }
.backlog-group { margin-bottom: 24px; }
.backlog-ticket-card { cursor: pointer; }
.backlog-ticket-card:focus { outline: 2px solid var(--accent); outline-offset: 2px; }
.backlog-ticket-card:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.backlog-type-badge { background: rgba(122, 159, 255, 0.12); color: var(--accent); }
.backlog-id { user-select: all; }
/* Wrap a TABLE in this rather than putting it on the table: a table's used width is
 * its min-content width whatever the width declaration says, so an sr-only table of
 * bucket ranges sets the document's scroll width from behind the visible layout and
 * puts a horizontal scrollbar on a phone. A block wrapper clips it for real. */
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }

/* FG-638: review ledger view */
.reviews-view { margin-top: 20px; }
.review-card { margin-bottom: 12px; }
.review-summary-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 4px 16px;
  margin-top: 10px;
  font-size: 12px;
}
.review-summary-grid .muted { margin-right: 4px; }
.review-next {
  margin-top: 10px;
  font-size: 12px;
  color: var(--warn);
}

/* FG-591: the operator work queue / Kanban board.
 *
 * The two wait tones that MUST stay visually distinct are .queue-wait-blocker and
 * .queue-wait-scheduling — a genuine blocker vs. a temporary scheduling wait. They
 * differ in hue AND carry their own label text, because colour is never the only
 * channel: a monochrome or colour-blind reading still gets "Blocked" vs "Waiting to
 * overlap" from the badge itself. */
.queue-view { margin-top: 16px; }
.queue-empty { margin: 24px 0; font-style: italic; }
.queue-unavailable { max-width: 70ch; }
.queue-alert { margin-top: 16px; }
.queue-alert-err { border-left: 3px solid var(--err); }
.queue-alert-warn { border-left: 3px solid var(--warn); }
.queue-alert-detail { font-size: 12px; margin-top: 6px; overflow-wrap: anywhere; }
.queue-alert-actions { display: flex; gap: 8px; margin-top: 10px; }

.queue-controls { margin-top: 16px; }
.queue-controls-row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.queue-controls-label { font-size: 12px; color: var(--fg-dim); }
.queue-enqueue-input { width: 160px; }
.queue-version { font-size: 12px; margin-left: auto; }
.queue-pending { font-size: 12px; }
.queue-controls-note { font-size: 11px; margin: 8px 0 0; max-width: 90ch; line-height: 1.5; }

.queue-columns {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 12px;
  margin-top: 16px;
  align-items: start;
}
.queue-column {
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 10px;
  min-width: 0;
}
.queue-column-head { margin-bottom: 8px; }
.queue-column-title {
  font-size: 13px;
  margin: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.queue-column-count {
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  font-size: 11px;
  color: var(--fg-faint);
}
.queue-derived-badge { background: rgba(122, 159, 255, 0.12); color: var(--accent); font-size: 10px; }
.queue-column-hint { font-size: 11px; margin: 4px 0 0; line-height: 1.45; }
.queue-column-missing { font-size: 11px; margin-bottom: 6px; color: var(--warn); }
.queue-column-empty { font-size: 12px; font-style: italic; list-style: none; padding: 8px 0; }
.queue-cards { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }

/* .card carries cursor:pointer for the click-to-open feed cards; these are not
 * click-to-open, so the affordance would be a lie. */
.queue-card { margin: 0; padding: 10px; cursor: default; }
.queue-card[draggable="true"] { cursor: grab; }
.queue-card:focus,
.queue-card:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
/* The grabbed state is announced by aria-grabbed AND drawn — a keyboard reorder that
 * only reads to a screen reader leaves a sighted keyboard user with no feedback. */
.queue-card-grabbed { outline: 2px dashed var(--accent); outline-offset: 2px; }
.queue-card-head { display: flex; gap: 6px; align-items: baseline; flex-wrap: wrap; }
.queue-card-rank { font-size: 11px; color: var(--fg-faint); min-width: 2.5em; }
.queue-card-id { font-size: 11px; color: var(--fg-faint); }
.queue-card-title { font-size: 13px; overflow-wrap: anywhere; }
.queue-card-facts { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; font-size: 11px; margin-top: 6px; }
.queue-member-badge { background: rgba(122, 159, 255, 0.12); color: var(--accent); }
.queue-exec-running { background: rgba(74, 222, 128, 0.14); color: var(--ok); }
.queue-exec-launching { background: rgba(250, 204, 21, 0.14); color: var(--warn); }
.queue-readiness-badge { background: rgba(148, 163, 184, 0.14); }
.queue-readiness-stale { background: rgba(250, 204, 21, 0.14); color: var(--warn); }

.queue-wait { margin-top: 8px; font-size: 11px; line-height: 1.5; border-left: 3px solid var(--border); padding-left: 8px; }
.queue-wait-blocker { border-left-color: var(--err); }
.queue-wait-scheduling { border-left-color: var(--accent); }
.queue-wait-capacity { border-left-color: var(--warn); }
.queue-wait-readiness { border-left-color: var(--warn); }
.queue-wait-claimed { border-left-color: var(--magenta); }
.queue-wait-disarmed { border-left-color: var(--fg-faint); }
.queue-wait-badge { font-size: 10px; margin-right: 6px; }
.queue-wait-badge-blocker { background: rgba(248, 113, 113, 0.14); color: var(--err); }
.queue-wait-badge-scheduling { background: rgba(122, 159, 255, 0.14); color: var(--accent); }
.queue-wait-badge-capacity { background: rgba(250, 204, 21, 0.14); color: var(--warn); }
.queue-wait-badge-readiness { background: rgba(250, 204, 21, 0.14); color: var(--warn); }
.queue-wait-badge-claimed { background: rgba(192, 132, 252, 0.14); color: var(--magenta); }
/* Every tone gets a pill, including the honest-unknown ones — an unstyled label
 * reads as body text and stops looking like a state at all. */
.queue-wait-badge-neutral,
.queue-wait-badge-unknown,
.queue-wait-badge-disarmed { background: rgba(148, 163, 184, 0.14); color: var(--fg-dim); }
.queue-wait-reason { overflow-wrap: anywhere; }
.queue-wait-meta,
.queue-wait-note { font-size: 10px; margin-top: 3px; line-height: 1.45; }
.queue-reservation { font-size: 10px; margin-top: 6px; overflow-wrap: anywhere; }
.queue-lease-expired { color: var(--err); }
.queue-card-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 8px; }
.queue-card-reorder-hint { font-size: 10px; }

.queue-dispatcher { margin-top: 16px; cursor: default; }
.queue-alert, .queue-controls { cursor: default; }
.queue-dispatcher-head { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.queue-dispatcher-title { font-size: 14px; margin: 0; }
.queue-dispatcher-default { font-size: 11px; }
.queue-tone-ok { background: rgba(74, 222, 128, 0.14); color: var(--ok); }
.queue-tone-warn { background: rgba(250, 204, 21, 0.14); color: var(--warn); }
.queue-tone-err { background: rgba(248, 113, 113, 0.14); color: var(--err); }
.queue-tone-capacity { background: rgba(250, 204, 21, 0.14); color: var(--warn); }
.queue-tone-scheduling { background: rgba(122, 159, 255, 0.14); color: var(--accent); }
.queue-tone-disarmed,
.queue-tone-neutral,
.queue-tone-unknown { background: rgba(148, 163, 184, 0.14); }
.queue-armed-badge { background: rgba(148, 163, 184, 0.14); font-size: 10px; }
.queue-armed-on { background: rgba(74, 222, 128, 0.14); color: var(--ok); }
.queue-dispatcher-detail { font-size: 12px; margin: 8px 0 0; max-width: 90ch; line-height: 1.5; }
.queue-dispatcher-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 4px 16px;
  margin-top: 10px;
  font-size: 12px;
}
.queue-dispatcher-grid .muted { margin-right: 4px; }
.queue-dispatcher-eval { font-size: 12px; margin-top: 10px; display: flex; gap: 6px; flex-wrap: wrap; align-items: baseline; }
.queue-dispatcher-eval-detail { flex-basis: 100%; font-size: 11px; }
.queue-capacity-holders { font-size: 11px; margin-top: 10px; }
.queue-holder-list { list-style: none; margin: 4px 0 0; padding: 0; display: flex; gap: 6px; flex-wrap: wrap; }
.queue-holder { font-size: 11px; }
.queue-capacity-policy { font-size: 11px; margin: 8px 0 0; max-width: 90ch; line-height: 1.5; }
.queue-cli-only { font-size: 11px; margin: 12px 0 0; max-width: 90ch; line-height: 1.5; }
.queue-cli-badge { background: rgba(192, 132, 252, 0.14); color: var(--magenta); margin-right: 6px; }
`;
