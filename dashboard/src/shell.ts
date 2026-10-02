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
/* FG-824: an unrecognized status reads as "<value> (unrecognized)"; keep it inside its column. */
section.in-flight .item > .badge { min-width: 0; overflow-wrap: anywhere; }
section.in-flight .item:hover { background: var(--bg-elev-2); }
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

/* FG-692 RF-1: an orchestrator row's open action is a real <button> stretched over the
   row rather than a role=button on the row, so the row can hold the remote-control link
   without nesting an interactive control inside a button. The link paints above the
   stretched button so it stays independently clickable. */
.orch-row { position: relative; }
.orch-row-open {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  margin: 0;
  padding: 0;
  border: 0;
  background: transparent;
  cursor: pointer;
}
.orch-row-open:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.orch-row .orch-remote-control { position: relative; z-index: 1; }

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
/* FG-560: mapping-path provenance made visible. An EXACT activity mapping keeps
 * the neutral accent badge and carries an "exact" tag; a map.default FALLBACK is
 * tinted amber and carries a "default" tag so it is distinguishable at a glance
 * from an exact hit. An EXPLICIT activity that fell to default (the activity_unmapped
 * shape dispatch refuses) is escalated to a red outline. Colour and hover are never
 * the only signal — the visible tag text carries the same meaning for non-colour,
 * keyboard and touch channels (RF-1). */
.model-badge-exact {
  border: 1px solid rgba(122, 159, 255, 0.35);
}
.model-badge-exact .model-badge-tag {
  margin-left: 5px;
  padding: 0 4px;
  border-radius: 2px;
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.03em;
  text-transform: uppercase;
  background: rgba(122, 159, 255, 0.24);
  color: #cfdcff;
}
.model-badge-default-fallback {
  background: rgba(224, 168, 83, 0.16);
  color: #e0a853;
  border: 1px solid rgba(224, 168, 83, 0.4);
}
.model-badge-default-fallback .model-badge-tag {
  margin-left: 5px;
  padding: 0 4px;
  border-radius: 2px;
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.03em;
  text-transform: uppercase;
  background: rgba(224, 168, 83, 0.28);
  color: #ffd9a0;
}
.model-badge-unmapped {
  background: rgba(240, 110, 110, 0.16);
  color: #f06e6e;
  border: 1px solid rgba(240, 110, 110, 0.5);
}
.model-badge-unmapped .model-badge-tag {
  background: rgba(240, 110, 110, 0.3);
  color: #ffc9c9;
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
/* FG-824: the rest of the status token map (client/status-tokens.js). Every token class has
   a rule here; an unrecognized value takes its vocabulary's neutral, italic fallback. */
.badge.status-unknown { background: rgba(154, 154, 163, 0.12); color: var(--fg-dim); font-style: italic; }
.badge.run-status-active { background: rgba(96, 165, 250, 0.15); color: var(--info); }
.badge.run-status-complete { background: rgba(74, 222, 128, 0.15); color: var(--ok); }
.badge.run-status-failed { background: rgba(248, 113, 113, 0.15); color: var(--err); }
.badge.run-status-abandoned { background: rgba(154, 154, 163, 0.15); color: var(--fg-dim); }
.badge.run-status-unknown { background: rgba(154, 154, 163, 0.12); color: var(--fg-dim); font-style: italic; }
.badge.claim-state-live { background: rgba(192, 132, 252, 0.14); color: var(--magenta); }
.badge.claim-state-released { background: rgba(154, 154, 163, 0.15); color: var(--fg-dim); }
.badge.claim-state-unknown { background: rgba(154, 154, 163, 0.12); color: var(--fg-dim); font-style: italic; }
.tone-accent-ok { border-left: 3px solid var(--ok); }
.tone-accent-err { border-left: 3px solid var(--err); }
.tone-accent-warn { border-left: 3px solid var(--warn); }
.tone-accent-info { border-left: 3px solid var(--info); }
.tone-accent-magenta { border-left: 3px solid var(--magenta); }
.tone-accent-neutral { border-left: 3px solid var(--fg-faint); }
/* FG-824: "unobserved for N min" on an in-flight launch row — informational, never a
   state change. Suspicious at 15 min, critical at 60. */
.freshness { font-size: 11px; margin-left: 8px; white-space: nowrap; }
.freshness-suspicious { color: var(--warn); }
.freshness-critical { color: var(--err); font-weight: 600; }
/* FG-824: the task page's recovery card. */
.recovery-card { margin: 12px 0 16px; padding: 12px 14px; }
.recovery-card h3 { margin: 0 0 8px; font-size: 13px; }
.recovery-card dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 12px; margin: 0 0 10px; font-size: 12px; }
.recovery-card dt { color: var(--fg-dim); }
.recovery-card dd { margin: 0; }
.recovery-next-verb { font-size: 12px; }

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
  background: none; border: none; padding: 0; font-family: inherit;
}
.detail .close:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
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

/* FG-820: the left-column navigation. Full column at >=720px; below it a fixed
 * five-slot bottom bar and a drawer (a modal dialog) holding the same column. 720 is the
 * nav breakpoint; the 520/600/640 rules elsewhere are content breakpoints. */
.app-shell {
  display: grid;
  grid-template-columns: 232px minmax(0, 1fr);
  min-height: 100vh;
}
.app-shell > .app { min-width: 0; width: 100%; }
.app:focus { outline: none; }
.app:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.skip-link {
  position: absolute; left: 8px; top: -48px; z-index: 60;
  background: var(--bg-elev-2); color: var(--fg); border: 1px solid var(--accent);
  border-radius: 4px; padding: 6px 10px; text-decoration: none;
}
.skip-link:focus { top: 8px; }
.nav-column {
  position: sticky; top: 0; height: 100vh; overflow-y: auto;
  display: flex; flex-direction: column; gap: 18px;
  padding: 20px 14px 16px;
  border-right: 1px solid var(--border);
  background: var(--bg);
}
.nav-brand { display: flex; align-items: center; gap: 8px; font-size: 16px; font-weight: 600; }
.nav-brand .brand-mark { width: 28px; height: 28px; }
.nav-scope { display: flex; flex-direction: column; gap: 6px; font-size: 12px; }
.nav-scope-label { color: var(--fg-faint); font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; }
.nav-scope-select {
  width: 100%; background: var(--bg-elev); color: var(--fg); border: 1px solid var(--border);
  border-radius: 4px; font: inherit; font-size: 13px; padding: 5px 6px;
}
.nav-groups { display: flex; flex-direction: column; gap: 14px; }
.nav-group-heading { font-size: 10px; color: var(--fg-faint); margin: 0 0 4px 8px; }
.nav-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 1px; }
.nav-item {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 5px 8px; border-radius: 4px; color: var(--fg-dim); text-decoration: none; font-size: 14px;
}
.nav-item:hover { color: var(--fg); background: var(--bg-elev); }
.nav-item-current { color: var(--fg); background: var(--bg-elev-2); box-shadow: inset 2px 0 0 var(--accent); }
.nav-item:focus-visible, .bottom-bar-item:focus-visible, .skip-link:focus-visible,
.nav-drawer-close:focus-visible, .nav-scope-select:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.nav-clock { margin-top: auto; font-size: 11px; padding-left: 8px; }
.nav-badge {
  display: inline-flex; align-items: center; min-width: 20px; justify-content: center;
  padding: 0 6px; border-radius: 999px; font-size: 11px; font-weight: 600; line-height: 18px;
  background: rgba(122, 159, 255, 0.18); color: var(--accent);
}
.nav-badge-danger { background: rgba(248, 113, 113, 0.22); color: var(--err); }
.nav-badge-unknown { background: rgba(154, 154, 163, 0.18); color: var(--fg-dim); }
.nav-badge-mark { margin-left: 1px; }
.nav-sr-only {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
}
.page-head { display: flex; align-items: baseline; flex-wrap: wrap; gap: 10px; padding-bottom: 12px; border-bottom: 1px solid var(--border); }
/* FG-843: the checkout chooser in the Routing / Config / Notes header — a button and a
   listbox of the project's live operator checkouts; a plain label when there is one. */
.page-head-spacer { flex: 1; }
.checkout-chooser { position: relative; align-self: center; font-size: 12.5px; color: var(--fg-dim); }
.checkout-chooser-button, .checkout-chooser-plain {
  display: inline-flex; align-items: center; gap: 8px; max-width: 100%;
  background: var(--bg-elev); border: 1px solid var(--border); border-radius: 6px;
  padding: 5px 10px; font: inherit; color: var(--fg-dim);
}
.checkout-chooser-button { cursor: pointer; }
.checkout-chooser-plain { background: transparent; border-color: transparent; padding-right: 0; }
.checkout-chooser-button:hover { border-color: var(--fg-dim); }
.checkout-chooser-button:focus-visible, .checkout-chooser-option:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.checkout-chooser-value { font-family: ui-monospace, "SF Mono", Menlo, monospace; color: var(--fg); overflow-wrap: anywhere; }
.checkout-chooser-chip {
  font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 11px; padding: 0 6px;
  border: 1px solid var(--border); border-radius: 4px; color: var(--fg-dim); white-space: nowrap;
}
.checkout-chooser-chip-primary { color: var(--accent); border-color: #3a4a80; }
.checkout-chooser-chip-run { color: var(--warn); border-color: currentColor; }
.checkout-chooser-caret { font-size: 10px; }
.checkout-chooser-menu {
  position: absolute; right: 0; top: 100%; z-index: 32; margin: 6px 0 0; padding: 6px; list-style: none;
  min-width: 300px; max-width: min(460px, calc(100vw - 32px)); box-sizing: border-box;
  background: var(--bg-elev); border: 1px solid var(--border); border-radius: 8px; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
}
.checkout-chooser-option {
  display: flex; align-items: center; gap: 8px; padding: 7px 9px; border-radius: 5px;
  font-size: 13px; color: var(--fg); cursor: pointer;
}
.checkout-chooser-option:hover, .checkout-chooser-option[aria-selected="true"] { background: var(--bg-elev-2); }
.checkout-chooser-option .checkout-chooser-value, .checkout-chooser-option .checkout-chooser-chip { flex: none; white-space: nowrap; }
.checkout-chooser-path {
  margin-left: auto; padding-left: 12px; min-width: 0; color: var(--fg-faint); font-size: 11px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.checkout-chooser-footer {
  margin-top: 4px; padding: 8px 9px 4px; border-top: 1px solid var(--border);
  color: var(--fg-faint); font-size: 11px;
}
@media (max-width: 719px) {
  .checkout-chooser { flex-basis: 100%; }
  .checkout-chooser-menu { left: 0; right: auto; min-width: 0; width: 100%; }
  .checkout-chooser-path { display: none; }
  .checkout-chooser-option .checkout-chooser-value { flex: 0 1 auto; white-space: normal; overflow-wrap: anywhere; }
}
.page-kicker { color: var(--fg-faint); font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; }
.route-notice { margin-top: 16px; }
.placeholder-view a { color: var(--accent); }
/* FG-821: object pages — breadcrumbs, the one-line screen contract, object tabs. */
.object-head { flex-direction: column; align-items: flex-start; gap: 4px; }
.breadcrumbs ol { list-style: none; display: flex; flex-wrap: wrap; gap: 4px; margin: 0; padding: 0; font-size: 12px; color: var(--fg-dim); }
.breadcrumbs li + li::before { content: "›"; margin-right: 4px; color: var(--fg-faint); }
.breadcrumbs a { color: var(--accent); text-decoration: none; }
.breadcrumbs a:hover { text-decoration: underline; }
.breadcrumbs [aria-current="page"] { color: var(--fg); }
.screen-line { margin: 10px 0 0; font-size: 13px; color: var(--fg-dim); }
.screen-line-needs { color: var(--warn); }
.screen-verb { font-size: 12px; background: var(--bg-elev-2); padding: 1px 5px; border-radius: 3px; color: var(--fg); }
/* FG-838: a list view's contract behind a "?" beside its title — tooltip on hover/focus,
   popover on click/Enter/Space. Positioned against .page-head so it fits a 400px screen. */
.page-head { position: relative; }
.info-tip-button {
  align-self: center; width: 20px; height: 20px; padding: 0; border-radius: 50%;
  border: 1px solid var(--fg-faint); background: transparent; color: var(--fg-faint);
  font-size: 12px; line-height: 18px; cursor: pointer;
}
.info-tip-button:hover, .info-tip-button[aria-expanded="true"] { color: var(--fg); border-color: var(--fg-dim); }
.info-tip-button:focus-visible, .info-tip-copy:focus-visible, .info-tip-popover:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.info-tip-tooltip {
  display: none; position: absolute; top: 100%; left: 0; z-index: 30; margin-top: 4px; max-width: 100%;
  padding: 4px 8px; border-radius: 4px; background: var(--bg-elev-2); border: 1px solid var(--border);
  color: var(--fg); font-size: 12px;
}
.info-tip-button:hover:not([aria-expanded="true"]) ~ .info-tip-tooltip,
.info-tip-button:focus-visible:not([aria-expanded="true"]) ~ .info-tip-tooltip { display: block; }
.info-tip-popover {
  position: absolute; top: 100%; left: 0; z-index: 31; margin-top: 4px; width: min(420px, 100%); box-sizing: border-box;
  padding: 10px 12px; border-radius: 6px; background: var(--bg-elev); border: 1px solid var(--border);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35); font-size: 13px; color: var(--fg);
}
.info-tip-popover[hidden] { display: none; }
.info-tip-answers { margin: 0; display: grid; grid-template-columns: max-content 1fr; gap: 4px 10px; }
.info-tip-answers dt { color: var(--fg-faint); font-size: 12px; }
.info-tip-answers dd { margin: 0; }
.info-tip-verb { margin: 8px 0 0; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.info-tip-copy { font-size: 12px; padding: 1px 8px; border-radius: 3px; border: 1px solid var(--border); background: var(--bg-elev-2); color: var(--fg); cursor: pointer; }
/* FG-822: task actions — buttons labeled with their verb, a preview before Confirm, the
   verb's own result inline. Never badge-bearing. */
.task-actions { margin: 8px 0 0; display: flex; flex-direction: column; gap: 8px; }
.task-actions-compact { margin: 4px 0; }
.action-buttons, .inbox-hold-buttons { display: flex; flex-wrap: wrap; gap: 6px; }
.action-btn, .inbox-hold-btn, .recovery-action { background: var(--bg-elev-2); border: 1px solid var(--border); border-radius: 4px; padding: 3px 8px; color: var(--fg); cursor: pointer; font-size: 12px; min-height: 28px; }
.action-btn code, .recovery-action code { font-size: 12px; }
.action-btn:hover, .action-btn-selected, .inbox-hold-btn:hover, .inbox-hold-btn-selected, .recovery-action:hover, .recovery-action-selected { border-color: var(--accent); }
.action-btn:disabled, .inbox-hold-btn:disabled, .recovery-action:disabled { opacity: 0.6; cursor: default; }
.action-preview { border: 1px solid var(--border); border-radius: 4px; padding: 8px 10px; display: flex; flex-direction: column; gap: 6px; max-width: 720px; }
.action-preview-verb { font-size: 12px; background: var(--bg-elev-2); padding: 1px 5px; border-radius: 3px; overflow-wrap: anywhere; }
.action-preview-reason, .action-note { font-size: 12px; }
.action-rationale-label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--fg-dim); }
.action-rationale { font: inherit; font-size: 13px; color: var(--fg); background: var(--bg); border: 1px solid var(--border); border-radius: 4px; padding: 6px; resize: vertical; }
.action-preview-controls { display: flex; gap: 8px; }
.action-confirm, .action-cancel { border-radius: 4px; padding: 3px 12px; min-height: 28px; cursor: pointer; font-size: 12px; border: 1px solid var(--border); background: var(--bg-elev-2); color: var(--fg); }
.action-confirm { border-color: var(--accent); }
.action-error { color: var(--err); font-size: 12px; }
.action-result { border-left: 3px solid var(--border); padding: 4px 10px; font-size: 12px; max-width: 720px; }
.action-result-ok { border-left-color: var(--ok); }
.action-result-fail { border-left-color: var(--err); }
.action-result-output { margin: 4px 0 0; max-height: 200px; overflow: auto; font-size: 11px; white-space: pre-wrap; }
.action-refused { font-size: 12px; margin: 0; padding-left: 16px; }
details.action-refused { padding-left: 0; }
details.action-refused ul { margin: 4px 0 0; padding-left: 16px; }
.action-advice { color: var(--fg-dim); margin-top: 2px; }
.object-tabs { display: flex; gap: 4px; margin: 14px 0 10px; border-bottom: 1px solid var(--border); }
.object-tab { padding: 6px 12px; color: var(--fg-dim); text-decoration: none; border-bottom: 2px solid transparent; font-size: 13px; }
.object-tab:hover { color: var(--fg); }
.object-tab-current { color: var(--fg); border-bottom-color: var(--accent); }
.object-tab:focus-visible, .breadcrumbs a:focus-visible, .task-links a:focus-visible, .runs-table a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.task-links { display: flex; flex-wrap: wrap; gap: 6px 22px; margin: 4px 0 8px; font-size: 12px; }
.task-links div { display: flex; gap: 6px; align-items: baseline; }
.task-links dt { color: var(--fg-faint); }
.task-links dd { margin: 0; }
.task-links a, .run-evidence a, .ticket-run-list a, .runs-table a, .task-link { color: var(--accent); text-decoration: none; }
.task-links a:hover, .run-evidence a:hover, .ticket-run-list a:hover, .runs-table a:hover, .task-link:hover { text-decoration: underline; }
.run-evidence-group h2, .ticket-runs h2 { font-size: 14px; margin: 16px 0 6px; }
.run-evidence-list, .ticket-run-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; font-size: 13px; }
.ticket-run-row { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; }
.runs-filters { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin: 14px 0 10px; font-size: 12px; }
.runs-filters a { text-decoration: none; }
.runs-table-wrap { overflow-x: auto; }
.runs-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.runs-table th { text-align: left; color: var(--fg-faint); font-weight: 500; font-size: 11px; padding: 4px 8px; }
.runs-table td { padding: 6px 8px; border-top: 1px solid var(--border); vertical-align: top; }
.runs-id, .runs-checkout { font-size: 10px; }
.runs-load-more { margin-top: 10px; }
a.backlog-ticket-card { display: block; color: inherit; text-decoration: none; }
/* FG-830: the Notes view — one compact row per checkout, the note on its own page. */
.notes-list { list-style: none; margin: 16px 0 0; padding: 0; }
a.notes-row { display: block; color: inherit; text-decoration: none; }
.notes-run-caption { margin: 22px 0 0; color: var(--fg-faint); font-size: 11px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.08em; }
.notes-row-head { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; min-width: 0; }
.notes-label { overflow-wrap: anywhere; }
.notes-session { font-size: 11px; margin-left: auto; }
.notes-preview { font-size: 13px; margin-top: 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.notes-primary { background: rgba(192, 132, 252, 0.14); color: var(--magenta); }
.notes-meta { gap: 8px; flex-wrap: wrap; align-items: baseline; margin: 12px 0; }
.notes-path { font-size: 11px; margin-bottom: 16px; overflow-wrap: anywhere; }
/* FG-817: the Roles list and role pages. Nine tabs wrap rather than scroll off a phone. */
.role-page .object-tabs { flex-wrap: wrap; }
/* FG-829: the role glyph tile (client/role-glyph.js) — its colours ride the SVG's own
   attributes; these rules only place it beside the role name it decorates. */
.role-tile { flex: none; display: inline-block; vertical-align: middle; }
.role-name { display: inline-flex; align-items: center; gap: 8px; min-width: 0; }
.role-caption { font-size: 12px; margin: 8px 0; overflow-wrap: anywhere; }
.role-footer { margin-top: 16px; }
.role-notice { margin: 8px 0; }
.role-h2 { font-size: 14px; margin: 16px 0 6px; }
.role-facts { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; margin: 10px 0; font-size: 13px; }
.role-facts div { display: contents; }
.role-facts dt { color: var(--fg-faint); }
.role-facts dd { margin: 0; overflow-wrap: anywhere; }
.role-list, .role-routes { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; font-size: 13px; overflow-wrap: anywhere; }
.roles-table .sort-header { all: unset; cursor: pointer; display: inline-flex; gap: 4px; align-items: baseline; font: inherit; color: var(--fg-dim); }
.roles-table th[aria-sort="ascending"] .sort-header, .roles-table th[aria-sort="descending"] .sort-header { color: var(--fg); }
.roles-table .sort-header:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.sort-glyph { font-size: 9px; }
.role-list a, .role-routes a, .roles-table a { color: var(--accent); text-decoration: none; }
.role-prompt-section { border-left: 3px solid var(--border); padding-left: 10px; margin: 8px 0; }
.role-prompt-protocol { border-left-color: var(--accent); }
.role-prompt-addendum, .role-prompt-constraint { border-left-color: var(--warn); }
.role-prompt-label { font-size: 11px; color: var(--fg-faint); text-transform: uppercase; letter-spacing: 0.06em; }
.role-prompt { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; margin: 4px 0 0; }
.role-flag { color: var(--warn); font-size: 13px; }
.role-source { font-size: 12px; margin: 2px 0 8px; overflow-wrap: anywhere; }
.role-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; margin: 12px 0; }
.role-card { background: var(--bg-elev); border: 1px solid var(--border); border-radius: 6px; padding: 10px 12px; min-width: 0; }
.role-card-label { font-size: 11px; color: var(--fg-faint); text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 6px; }
.role-chip[href] { color: var(--accent); text-decoration: none; }
.role-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.role-chip { font-size: 12px; padding: 2px 8px; border: 1px solid var(--border); border-radius: 999px; background: var(--bg-elev-2); color: var(--fg); overflow-wrap: anywhere; }
.role-badge { font-size: 11px; padding: 0 6px; border: 1px solid var(--border); border-radius: 3px; color: var(--fg-dim); white-space: nowrap; }
.role-badge-warn { color: var(--warn); border-color: var(--warn); }
.role-harness-table th, .role-harness-table td { font-size: 12px; white-space: nowrap; }
.role-mounts td { font-size: 12px; overflow-wrap: anywhere; }
.role-raw { margin: 16px 0; }
.role-raw summary { cursor: pointer; color: var(--fg-dim); font-size: 13px; }
.role-skill-group { border: 1px solid var(--border); border-radius: 6px; margin: 12px 0; overflow: hidden; }
.role-skill-group-head { background: var(--bg-elev); padding: 6px 12px; font-size: 12px; color: var(--fg-dim); border-bottom: 1px solid var(--border); }
.role-skill-list { list-style: none; margin: 0; padding: 0; }
.role-skill { padding: 8px 12px 2px; border-top: 1px solid var(--border); }
.role-skill:first-child { border-top: none; }
.role-skill-head { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
.role-skill-name { font-size: 13px; color: var(--fg); }
.role-skill-desc { font-size: 12px; color: var(--fg-dim); margin-top: 2px; overflow-wrap: anywhere; }
.role-skill-mount { list-style: none; padding: 0 12px 8px; font-size: 11px; overflow-wrap: anywhere; }
.role-skill-empty { padding: 8px 12px; font-size: 13px; }
.instr-layout { display: grid; grid-template-columns: minmax(200px, 260px) minmax(0, 1fr); gap: 12px; align-items: start; margin-top: 8px; }
.instr-files { border: 1px solid var(--border); border-radius: 6px; padding: 8px; background: var(--bg-elev); }
.instr-files-head { font-size: 13px; margin: 0 0 6px 4px; }
.instr-files ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.instr-file { display: flex; justify-content: space-between; gap: 8px; width: 100%; text-align: left; background: transparent; border: 1px solid transparent; border-radius: 4px; padding: 4px 6px; color: var(--fg-dim); cursor: pointer; font-size: 12px; }
.instr-file:hover { background: var(--bg-elev-2); color: var(--fg); }
.instr-file-selected { background: var(--bg-elev-2); color: var(--fg); border-color: var(--border); }
.instr-file-name { overflow-wrap: anywhere; }
.instr-kind { font-size: 10px; letter-spacing: 0.06em; color: var(--fg-faint); border: 1px solid var(--border); border-radius: 3px; padding: 0 4px; align-self: center; white-space: nowrap; }
.instr-kind-entry { color: var(--accent); border-color: var(--accent); }
.instr-viewer { border: 1px solid var(--border); border-radius: 6px; padding: 10px 12px; min-width: 0; }
.instr-viewer-head { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-bottom: 8px; }
.instr-viewer-title { display: flex; flex-direction: column; flex: 1 1 200px; min-width: 0; font-size: 13px; overflow-wrap: anywhere; }
.instr-viewer-title .faint { font-size: 11px; }
.instr-modes { display: inline-flex; border: 1px solid var(--border); border-radius: 5px; overflow: hidden; }
.instr-mode { background: transparent; border: none; border-left: 1px solid var(--border); color: var(--fg-dim); padding: 3px 10px; font-size: 12px; cursor: pointer; min-height: 28px; }
.instr-mode:first-child { border-left: none; }
.instr-mode-current { background: var(--bg-elev-2); color: var(--fg); }
.instr-copy { background: var(--bg-elev-2); border: 1px solid var(--border); border-radius: 4px; color: var(--fg); font-size: 12px; padding: 3px 10px; cursor: pointer; min-height: 28px; }
.instr-mode:focus-visible, .instr-file:focus-visible, .instr-copy:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.instr-md { font-size: 13px; overflow-wrap: anywhere; }
.instr-md h1, .instr-md h2, .instr-md h3 { text-transform: none; letter-spacing: 0; color: var(--fg); margin: 12px 0 6px; }
.instr-md h1 { font-size: 17px; } .instr-md h2 { font-size: 15px; } .instr-md h3 { font-size: 13px; }
.instr-frontmatter { color: var(--fg-faint); border-left: 3px solid var(--border); padding-left: 8px; }
.instr-disk { margin: 12px 0 0; }
.instr-disk figcaption { margin-bottom: 4px; }
.instr-edit { font-size: 12px; margin: 10px 0 0; overflow-wrap: anywhere; }
.role-prompt-selected { border-left-color: var(--accent); background: var(--bg-elev); }
.role-periods { margin: 8px 0; }
.role-usage-total { font-size: 13px; }
/* FG-837: Roles after Paperclip (the approved roles-mock / role-page-mock). Existing tokens
   only; every secondary text is --fg-dim, never --fg-faint, which is under 4.5:1 on --bg
   and --bg-elev (dashboard/browser-tests/fg837-roles-parity.test.ts computes it). */
.app:has(> .roles-index) > .page-head { flex-wrap: wrap; row-gap: 14px; border-bottom: 0; padding-bottom: 0; }
.app:has(> .roles-index) > .page-head .page-kicker { flex-basis: 100%; font-size: 12px; letter-spacing: 0.06em; color: var(--fg-dim); }
.app:has(> .roles-index) > .page-head .page-title { font-size: 20px; }
.roles-lede { color: var(--fg-dim); margin: 6px 0 18px; }
.roles-lede code { color: var(--fg); font-size: 13px; }
.roles-toolbar { display: flex; align-items: center; flex-wrap: wrap; gap: 18px; border-bottom: 1px solid var(--border); }
.roles-family-tabs { display: flex; flex-wrap: wrap; gap: 18px; }
.roles-family-tab {
  all: unset; cursor: pointer; padding: 10px 2px; font-size: 14px; color: var(--fg-dim);
  border-bottom: 2px solid transparent; margin-bottom: -1px;
}
.roles-family-tab:hover { color: var(--fg); }
.roles-family-tab-current { color: var(--fg); border-bottom-color: var(--fg); }
.roles-family-tab:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.roles-toolbar-meta { margin-left: auto; display: flex; gap: 18px; font-size: 12px; color: var(--fg-dim); }
.roles-panel { border: 1px solid var(--border); border-radius: 10px; background: var(--bg-elev); overflow-x: auto; margin-top: 14px; }
.roles-table { width: 100%; min-width: 760px; border-collapse: collapse; table-layout: fixed; font-size: 14px; }
.roles-table thead th { text-align: left; font-weight: 400; font-size: 12px; padding: 8px 16px; border-bottom: 1px solid var(--border); white-space: nowrap; }
.roles-table th.roles-col-profile { width: 190px; }
.roles-table th.roles-col-activity { width: 140px; }
.roles-table th.roles-col-lastTask { width: 108px; }
.roles-table th.roles-col-mount { width: 116px; text-align: right; }
.roles-table tbody tr + tr td { border-top: 1px solid var(--border); }
.roles-table tbody tr[data-row-href] { cursor: pointer; }
.roles-table tbody tr[data-role]:hover { background: var(--bg-elev-2); }
.roles-table td { padding: 12px 16px; vertical-align: middle; min-width: 0; }
.roles-ident { display: grid; grid-template-columns: 36px auto minmax(0, 1fr); align-items: center; column-gap: 16px; row-gap: 2px; }
.roles-ident .role-name { display: contents; }
.roles-ident .role-tile { grid-row: 1 / 3; grid-column: 1; }
.roles-ident a { grid-row: 1; grid-column: 2; color: var(--fg); font-weight: 600; text-decoration: none; white-space: nowrap; }
.roles-ident a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
@supports selector(:has(a)) {
  .roles-table tbody tr[data-role]:has(a:focus-visible) { outline: 2px solid var(--accent); outline-offset: -2px; }
  .roles-ident a:focus-visible { outline: none; }
}
.roles-flag { grid-row: 1; grid-column: 3; justify-self: start; font-size: 11px; color: var(--fg-dim); border: 1px solid var(--border); border-radius: 999px; padding: 0 7px; white-space: nowrap; }
.role-subtitle { grid-row: 2; grid-column: 2 / 4; font-size: 12.5px; color: var(--fg-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.role-model, .role-profile { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 12px; color: var(--fg-dim); }
.role-profile { font-family: ui-monospace, "SF Mono", Menlo, monospace; }
.roles-fam { font-size: 12px; color: var(--fg-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.roles-when { font-size: 13px; color: var(--fg-dim); white-space: nowrap; }
.roles-table td[data-col="mount"] { text-align: right; white-space: nowrap; }
.role-pill { display: inline-block; font-size: 12px; padding: 3px 9px; border-radius: 999px; border: 1px solid var(--border); color: var(--fg-dim); }
.role-pill-rw { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 40%, transparent); }
.role-pill-ro { color: var(--err); border-color: color-mix(in srgb, var(--err) 40%, transparent); }
.roles-index .role-footer, .role-page .role-caption { color: var(--fg-dim); font-size: 12px; margin-top: 12px; }
.roles-table .sort-header { font-size: 12px; }

.role-crumbs .breadcrumbs ol { text-transform: uppercase; letter-spacing: 0.06em; }
.role-crumbs .breadcrumbs li[data-crumb="role"] { text-transform: none; letter-spacing: 0; font-size: 13px; }
.role-layout { display: block; }
.role-page-wide .role-layout { display: grid; grid-template-columns: 200px minmax(0, 1fr); margin: 0 -24px 0 -12px; }
.role-page-wide .role-crumbs { margin-bottom: 0; }
.role-subnav { border-right: 1px solid var(--border); padding: 12px 12px 24px 0; }
.role-subnav-group ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 1px; }
.role-subnav-label { font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--fg-dim); margin: 14px 8px 6px; }
.role-subnav-item { display: flex; align-items: center; gap: 8px; padding: 7px 10px; border-radius: 7px; color: var(--fg-dim); text-decoration: none; font-size: 14px; }
.role-subnav-item:hover { color: var(--fg); background: var(--bg-elev); }
.role-subnav-current { background: var(--bg-elev-2); color: var(--fg); }
.role-subnav-item:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.role-subnav-icon { flex: none; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.role-main { min-width: 0; }
.role-page-wide .role-main { padding: 24px 24px 0 32px; }
.role-head { display: flex; align-items: center; gap: 14px; margin: 16px 0 6px; }
.role-page-wide .role-head { margin-top: 0; }
.role-head-text { min-width: 0; }
.role-head .page-title { font-size: 22px; line-height: 1.25; margin: 0; overflow-wrap: anywhere; }
.role-meta { color: var(--fg-dim); font-size: 13px; overflow-wrap: anywhere; }
.role-meta .mono { font-size: 12px; }
.role-hint { color: var(--fg-dim); font-size: 12.5px; margin: 8px 0 22px; padding-bottom: 16px; border-bottom: 1px solid var(--border); overflow-wrap: anywhere; }
.role-hint code { font-size: 12px; }
.role-panel-title { font-size: 18px; font-weight: 600; text-transform: none; letter-spacing: 0; color: var(--fg); margin: 6px 0 14px; }
.role-page .object-tabs + .object-tabpanel .role-panel-title { display: none; }
.role-latest {
  display: flex; align-items: center; gap: 12px; flex-wrap: wrap; font-size: 14px;
  border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; background: var(--bg-elev); margin-bottom: 16px;
}
.role-latest a { text-decoration: none; }
.role-latest-id { color: var(--fg); font-size: 12px; }
.role-latest-title { color: var(--fg); min-width: 0; overflow-wrap: anywhere; }
.role-latest a:hover { text-decoration: underline; }
.role-latest-when { margin-left: auto; color: var(--fg-dim); }
.role-card-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.role-card-wide { grid-column: 1 / -1; }
.role-page .role-card { border-radius: 10px; padding: 14px 16px; }
.role-card-head, .role-section-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
.role-page .role-card-title { font-size: 14px; font-weight: 600; text-transform: none; letter-spacing: 0; color: var(--fg); margin: 0; }
.role-card-link { color: var(--fg-dim); font-size: 12px; text-decoration: none; white-space: nowrap; }
.role-card-link:hover { color: var(--fg); }
.role-kv { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 6px 12px; margin: 0; font-size: 13px; }
.role-kv div { display: contents; }
.role-kv dt { color: var(--fg-dim); }
.role-kv dd { margin: 0; text-align: right; overflow-wrap: anywhere; }
.role-kv dd.mono { font-size: 12px; }
.role-err { color: var(--err); }
.role-page .role-chip { background: var(--bg-elev-2); border: 0; color: var(--fg-dim); padding: 3px 9px; text-decoration: none; }
.role-page a.role-chip { color: var(--fg); }
.role-section-head { margin-top: 18px; }
.role-task-rows { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.role-task-row { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; padding: 10px 14px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-elev); }
.role-task-main { display: flex; gap: 12px; align-items: baseline; min-width: 0; overflow-wrap: anywhere; }
.role-task-main a { color: var(--accent); text-decoration: none; font-size: 12px; }
.role-task-meta { color: var(--fg-dim); font-size: 12.5px; white-space: nowrap; }
.role-page .role-h2 { font-size: 14px; font-weight: 600; text-transform: none; letter-spacing: 0; color: var(--fg); margin: 18px 0 8px; }
.role-page .runs-table-wrap, .role-page .role-facts, .role-page .role-list, .role-page .role-routes {
  border: 1px solid var(--border); border-radius: 10px; background: var(--bg-elev);
}
.role-page .role-facts, .role-page .role-list, .role-page .role-routes { padding: 12px 16px; }
.role-page .role-card .role-facts, .role-page .role-card .role-list, .role-page .role-facts .role-list { border: 0; padding: 0; background: none; }
.role-page .role-facts dt { color: var(--fg-dim); }
.role-page .role-skill-group { border-radius: 10px; background: var(--bg-elev); }
.role-page .role-skill-group-head { background: none; font-size: 13px; font-weight: 600; color: var(--fg); padding: 10px 16px; }
.role-page .role-skill { padding: 10px 16px 4px; }
.role-page .role-skill-mount { padding: 0 16px 10px; color: var(--fg-dim); }
.role-page .role-source { color: var(--fg-dim); }
.role-page .role-card-label { font-size: 14px; font-weight: 600; text-transform: none; letter-spacing: 0; color: var(--fg); margin-bottom: 10px; }
@media (max-width: 719.98px) {
  .role-card-grid { grid-template-columns: 1fr; }
  .role-task-row { flex-wrap: wrap; }
}
@media (max-width: 719.98px) {
  .instr-layout { grid-template-columns: 1fr; }
}
@media (max-width: 519.98px) {
  .role-facts { grid-template-columns: 1fr; }
  .role-facts dd { margin-bottom: 6px; }
}
.mobile-head, .bottom-bar { display: none; }
.nav-drawer-backdrop { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.55); z-index: 70; }
.nav-drawer {
  position: fixed; top: 0; bottom: 0; left: 0; z-index: 71;
  width: min(300px, 86vw); overflow-y: auto;
  display: flex; flex-direction: column; gap: 18px;
  padding: 14px 14px calc(16px + env(safe-area-inset-bottom));
  background: var(--bg); border-right: 1px solid var(--border);
}
.nav-drawer-head { display: flex; align-items: center; justify-content: space-between; }
.nav-drawer-close {
  background: transparent; border: 1px solid var(--border); color: var(--fg-dim);
  border-radius: 4px; font: inherit; font-size: 16px; line-height: 1; padding: 4px 9px; cursor: pointer;
}
@media (max-width: 719.98px) {
  .app-shell { display: block; }
  .nav-column { display: none; }
  .mobile-head {
    display: flex; align-items: center; gap: 10px;
    padding: 12px 16px 0; font-size: 12px;
  }
  .app { padding-bottom: calc(96px + 56px + env(safe-area-inset-bottom)); }
  .bottom-bar {
    display: flex; position: fixed; left: 0; right: 0; bottom: 0; z-index: 50;
    padding: 0 max(4px, env(safe-area-inset-right)) env(safe-area-inset-bottom) max(4px, env(safe-area-inset-left));
    background: var(--bg-elev); border-top: 1px solid var(--border);
  }
  .bottom-bar-item {
    flex: 1 1 0; min-width: 0; min-height: 52px;
    display: flex; align-items: center; justify-content: center; gap: 4px;
    background: transparent; border: none; color: var(--fg-dim); font: inherit; font-size: 12px;
    text-decoration: none; cursor: pointer;
  }
  .bottom-bar-item-current { color: var(--fg); box-shadow: inset 0 2px 0 var(--accent); }
}

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
.project-missing-count { font-size: 11px; margin-top: 4px; }

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

/* FG-759 (#3b): the head wraps instead of overflowing. Before, a fixed-width row of
   chip + badge + classify controls + live + GitHub link pushed the right-pinned
   GitHub pill (white-space:nowrap, margin-left:auto) past the card padding and it
   clipped outside the card. flex-wrap keeps every control within the card bounds at
   the normal card width. */
.project-card-head { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 8px; row-gap: 6px; }
.project-card-head .project-chip { font-size: 12px; padding: 2px 10px; cursor: default; }
/* FG-759 RF-2: the label chip IS the card's primary "open project" control — a real,
   focusable <button> so keyboard users tab to it and activate with Enter, instead of the
   whole card being an (ARIA-invalid) role=button around its own interactive controls.
   Strip the button-native chrome so it renders identically to the old label span. */
.project-card-head button.project-chip {
  border: none;
  font-family: inherit;
  line-height: inherit;
  text-align: inherit;
  cursor: pointer;
}
.project-card-head button.project-chip:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
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

/* FG-745: an unclassified record — visible fail-safe. The workspace's purpose was
   never recorded, so it is flagged and never hidden. FG-759 (#2) CALMS the treatment:
   a real, active project should not be alarmed at. The marker is now a quiet dim
   dashed edge and a muted (not warning-coloured) badge — legible, low-emphasis, and
   no longer competing with the project's own content for attention. */
.project-card.project-unclassified-card { border-left: 3px dashed var(--fg-faint); }
.project-unclassified-badge {
  color: var(--fg-dim);
  background: transparent;
  border: 1px solid var(--border);
  font-weight: 500;
}
/* FG-759 (#2): the inviting one-click operator claim — the primary, low-friction way
   a real project sheds the unclassified flag. Accent-tinted so it reads as the
   recommended action next to the quiet "Classify…" escape hatch for artifact kinds. */
.project-claim {
  font-size: 11px;
  font-weight: 600;
  color: var(--accent);
  background: rgba(96, 165, 250, 0.12);
  border: 1px solid var(--accent);
  border-radius: 10px;
  padding: 2px 10px;
  cursor: pointer;
  white-space: nowrap;
}
.project-claim:hover:not(:disabled) { background: rgba(96, 165, 250, 0.2); }
.project-claim:disabled { opacity: 0.6; cursor: default; }
.project-claim:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
/* RF-2: the one-click claim's success confirmation. Rendered in place of the claim
   button on success and focus-landed so the write is perceivable (and announced via
   role=status) even before the cached Projects list re-projects the card as classified. */
.project-claim-done {
  font-size: 11px;
  font-weight: 600;
  color: var(--ok);
  min-width: 0;
  overflow-wrap: anywhere;
}
.project-claim-done:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.project-classify-toggle {
  font-size: 11px;
  font-weight: 600;
  color: var(--accent);
  background: transparent;
  border: 1px solid var(--fg-faint);
  border-radius: 10px;
  padding: 2px 8px;
  cursor: pointer;
  white-space: nowrap;
}
.project-classify-toggle:hover { background: var(--bg-elev-2); }
.project-classify-toggle:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.project-owner {
  font-size: 11px;
  color: var(--fg-dim);
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* FG-745 (AC8): the operator classify/repair affordance on an unclassified card. */
.project-classify {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-top: 8px;
  border-top: 1px dashed var(--border);
}
.project-classify-label {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--fg-faint);
}
.project-classify-controls { display: flex; gap: 6px; align-items: stretch; }
.project-classify-select {
  flex: 1 1 auto;
  min-width: 0;
  background: var(--bg);
  color: var(--fg);
  border: 1px solid var(--border);
  border-radius: 5px;
  padding: 4px 6px;
  font-size: 12px;
}
.project-classify-select:focus-visible,
.project-classify-submit:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
.project-classify-submit {
  flex: 0 0 auto;
  background: var(--bg-elev-2);
  color: var(--fg);
  border: 1px solid var(--fg-faint);
  border-radius: 5px;
  padding: 4px 12px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
.project-classify-submit:hover:not(:disabled) { background: var(--border); }
.project-classify-submit:disabled,
.project-classify-select:disabled { opacity: 0.6; cursor: default; }
.project-classify-error {
  font-size: 11px;
  color: var(--err);
  line-height: 1.4;
  word-break: break-word;
}
.project-classify-done {
  font-size: 11px;
  color: var(--ok);
  line-height: 1.4;
}
/* RF-1: the confirmation receives focus when the classified form is removed, so a
   keyboard operator is never stranded on a detached submit button. Give the
   programmatic focus a visible ring. */
.project-classify-done:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }

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

/* FG-759 (#1): the working-dirs disclosure. A logical project can span many working
   directories (the main checkout + per-ticket disposable clones); that count is a
   SECONDARY detail, so it collapses behind a low-emphasis toggle and only appears when
   the project genuinely spans more than one. */
.project-working-dirs { display: flex; flex-direction: column; gap: 6px; }
.project-dirs-toggle {
  align-self: flex-start;
  font-size: 11px;
  color: var(--fg-dim);
  background: transparent;
  border: 0;
  padding: 0;
  cursor: pointer;
}
.project-dirs-toggle:hover { color: var(--fg); }
.project-dirs-toggle:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
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
.ca-retry, .inbox-retry, .pin-refresh {
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
.ca-retry:hover, .inbox-retry:hover, .pin-refresh:hover { border-color: var(--accent); }
.ca-retry:focus-visible, .inbox-retry:focus-visible, .pin-refresh:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.pin-toolbar { display: flex; justify-content: flex-end; margin-bottom: 8px; }
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
/* FG-590 (RF-9): a terminal launch's retention disposition — retained-for-investigation
   vs expired/eligible vs leaked — as three visually distinct badges beside the launch id. */
.launch-retention-retained, .launch-retention-expired, .launch-retention-leaked {
  margin-left: 8px;
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.launch-retention-retained { background: rgba(96, 165, 250, 0.15); color: var(--info); }
.launch-retention-expired { background: rgba(154, 154, 163, 0.18); color: var(--fg-dim); }
.launch-retention-leaked { background: rgba(250, 204, 21, 0.15); color: var(--warn); }
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

/* FG-402: the Human Attention Inbox. A card list of actionable items; each row carries
   a kind badge, a severity badge, the reason + requested action, an age, and a link to
   the relevant surface. No new external assets — inline CSS under the existing
   script-src 'self' CSP. */
.attention-inbox { margin: 12px 0 28px; }
.inbox-loading, .inbox-empty { color: var(--fg-dim); padding: 10px 2px; }
.inbox-degraded { color: var(--warn); font-size: 12px; padding: 4px 2px 8px; }
.inbox-list { display: flex; flex-direction: column; gap: 8px; }
.inbox-row {
  display: grid;
  grid-template-columns: minmax(120px, auto) 1fr auto;
  gap: 12px;
  align-items: baseline;
  padding: 10px 12px;
  border: 1px solid var(--border, rgba(154,154,163,0.2));
  border-radius: 8px;
}
.inbox-row-badges { display: flex; flex-direction: column; gap: 4px; align-items: flex-start; }
.inbox-row-body { min-width: 0; }
.inbox-row-head { margin-bottom: 2px; }
.inbox-reason { color: var(--fg); overflow-wrap: anywhere; }
.inbox-action { font-size: 12px; margin: 2px 0; overflow-wrap: anywhere; }
.inbox-meta { font-size: 11px; }
.inbox-row-aside { display: flex; flex-direction: column; gap: 6px; align-items: flex-end; }
/* FG-402: on a narrow viewport the three fixed-ish columns overflow, so stack the row
 * and let the content column shrink (min-width:0 above) instead of forcing a scroll. */
@media (max-width: 640px) {
  .inbox-row { grid-template-columns: 1fr; gap: 6px; }
  .inbox-row-badges { flex-direction: row; flex-wrap: wrap; }
  .inbox-row-aside { align-items: flex-start; }
}
.inbox-age { font-size: 11px; }
.inbox-link { font-size: 12px; color: var(--accent, var(--info)); text-decoration: none; white-space: nowrap; }
.inbox-link:hover { text-decoration: underline; }
.inbox-unavailable { border: 1px solid rgba(250,204,21,0.35); border-radius: 8px; padding: 12px; }
.inbox-unavailable-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.inbox-unavailable-detail { color: var(--fg-dim); font-size: 12px; margin-top: 6px; }
.badge.inbox-kind-waiting_gate { background: rgba(250, 204, 21, 0.15); color: var(--warn); }
.badge.inbox-kind-campaign_paused { background: rgba(250, 204, 21, 0.18); color: var(--warn); }
.badge.inbox-kind-blocked_by_red_or_reviewer { background: rgba(248, 113, 113, 0.15); color: var(--err); }
.badge.inbox-kind-merge_conflict { background: rgba(248, 113, 113, 0.15); color: var(--err); }
.badge.inbox-kind-integration_blocked_park { background: rgba(248, 113, 113, 0.15); color: var(--err); }
.badge.inbox-kind-auth_setup { background: rgba(248, 113, 113, 0.15); color: var(--err); }
.badge.inbox-kind-missing_acceptance_or_readiness { background: rgba(96, 165, 250, 0.15); color: var(--info); }
.badge.inbox-kind-stale_verification { background: rgba(250, 204, 21, 0.15); color: var(--warn); }
.badge.inbox-kind-kanban_conflict { background: rgba(192, 132, 252, 0.18); color: var(--magenta); }
.badge.inbox-kind-unknown { background: rgba(154, 154, 163, 0.15); color: var(--fg-dim); font-style: italic; }
.badge.inbox-sev { font-size: 10px; }
.badge.inbox-sev-high { background: rgba(248, 113, 113, 0.18); color: var(--err); }
.badge.inbox-sev-medium { background: rgba(250, 204, 21, 0.15); color: var(--warn); }
.badge.inbox-sev-low { background: rgba(154, 154, 163, 0.15); color: var(--fg-dim); }
.badge.inbox-sev-unknown { background: rgba(154, 154, 163, 0.12); color: var(--fg-faint); }
.inbox-dismiss { display: flex; flex-direction: column; gap: 6px; margin-top: 6px; }
.inbox-snooze-presets { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.inbox-snooze-custom-label { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--fg-dim); }
.inbox-snooze-custom { font: inherit; font-size: 12px; color: var(--fg); background: var(--bg); border: 1px solid var(--border); border-radius: 4px; padding: 3px 6px; min-width: 0; width: 190px; max-width: 100%; }
.inbox-hold-btn:focus-visible, .action-confirm:focus-visible, .action-cancel:focus-visible, .inbox-dismissed summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.inbox-dismissed { margin-top: 10px; font-size: 12px; }
.inbox-dismissed summary { cursor: pointer; color: var(--fg-dim); padding: 4px 2px; }
.inbox-dismissed-list { list-style: none; margin: 6px 0 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.inbox-dismissed-row { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 10px; align-items: start; border: 1px dashed var(--border); border-radius: 6px; padding: 8px 10px; }
.inbox-dismissed-body { min-width: 0; }
@media (max-width: 480px) { .inbox-dismissed-row { grid-template-columns: 1fr; gap: 6px; } }

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
.runtime-window-btns, .runtime-tz-btns, .runtime-metric-btns { display: flex; gap: 6px; flex-wrap: wrap; }
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
/* FG-836: a window change keeps the previous series on screen, dimmed, under a
 * "loading <w>…" line until the new read lands; the label beside the window buttons
 * names the window the data on screen came from. */
.runtime-loading.tone-accent-info { margin-bottom: 12px; }
.runtime-body { transition: opacity 0.15s; }
.runtime-body-loading { opacity: 0.45; }
.runtime-window-btns .usage-dim-btn:disabled { cursor: progress; }
.runtime-window-pending { border-style: dashed; }
.runtime-showing { font-size: 12px; }
/* FG-836: the Ops summary's own window control, the same honesty as the runtime panel's. */
.ops-loading, .ops-error, .ops-stale { padding: 16px; margin-bottom: 12px; }
.ops-summary-body { transition: opacity 0.15s; }
.ops-summary-body-loading { opacity: 0.45; }
.ops-since-btns .usage-dim-btn:disabled { cursor: progress; }
.ops-since-pending { border-style: dashed; }
.ops-since-showing { font-size: 12px; }
.runtime-chart {
  margin: 0 0 16px;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 16px;
}
.runtime-chart svg { display: block; width: 100%; height: auto; }
.runtime-bar { transition: height 0.2s ease, y 0.2s ease; }
.runs-bar { transition: height 0.2s ease, y 0.2s ease; }
@media (prefers-reduced-motion: reduce) {
  .runtime-bar { transition: none; }
  .runtime-body { transition: none; }
  .ops-summary-body { transition: none; }
  .runs-bar { transition: none; }
}
/* FG-683: the completed-runs metric. A zero bucket is an observed zero, so it
 * draws on the baseline rather than not drawing at all. */
.runs-bar-zero { fill: var(--fg-faint); opacity: 0.5; }
.runs-total {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 12px;
}
.runs-total-num { font-size: 24px; font-weight: 600; color: var(--fg); }
.runs-total-note { font-size: 12px; }
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
/* FG-834: the Edit RACI mode (client/raci-editor-view.js), after /design/edit-raci-mock.html. */
.gov-view .hint { color: var(--fg-dim); font-size: 12px; }
.gov-source-label-row { display: flex; align-items: center; gap: 10px; }
.gov-source-label-row .workbench-section-label { flex: 1; }
.gov-source-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
.gov-source-card { display: flex; padding: 12px 16px; align-items: center !important; }
.gov-source-note { margin-left: auto; }
.raci-btn { background: var(--bg-elev-2); border: 1px solid var(--border); color: var(--fg-dim); padding: 5px 12px; border-radius: 5px; font-size: 13px; cursor: pointer; font-family: inherit; }
.raci-btn:hover:not(:disabled) { color: var(--fg); border-color: var(--fg-dim); }
.raci-btn:focus-visible, .raci-link:focus-visible, .raci-textarea:focus-visible, .raci-field input:focus-visible, .raci-field textarea:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.raci-btn-primary { color: var(--bg); background: var(--accent); border-color: var(--accent); font-weight: 600; }
.raci-btn-primary:hover:not(:disabled) { color: var(--bg); border-color: var(--fg); }
.raci-btn-danger { color: var(--err); border-color: #5a2a2a; }
.raci-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.raci-link { background: none; border: none; padding: 0; color: var(--accent); text-decoration: underline; cursor: pointer; font: inherit; }
.raci-pill { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; letter-spacing: 0.06em; text-transform: uppercase; padding: 2px 8px; border: 1px solid currentColor; border-color: color-mix(in srgb, currentColor 35%, transparent); white-space: nowrap; }
.raci-editor { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 16px; margin-top: 14px; }
.raci-pane { min-width: 0; }
.raci-sections { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; margin-bottom: 10px; }
.raci-sections .hint { margin-right: 4px; }
.raci-section { padding: 3px 10px; font-size: 12px; }
.raci-section-on { color: var(--fg); border-color: var(--accent); }
.raci-code { position: relative; background: #0b0b0d; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
.raci-gutter { position: absolute; left: 0; top: 0; bottom: 0; width: 40px; overflow: hidden; border-right: 1px solid var(--border); color: var(--fg-faint); text-align: right; font-family: ui-monospace, Menlo, monospace; font-size: 12.5px; pointer-events: none; }
.raci-ln { height: 20px; line-height: 20px; padding-right: 8px; }
.raci-ln-err { color: var(--err); }
.raci-marks { position: absolute; left: 44px; right: 0; top: 0; bottom: 0; overflow: hidden; pointer-events: none; }
.raci-errline { position: absolute; left: 0; right: 4px; height: 20px; background: #2a1414; outline: 1px solid #5a2a2a; border-radius: 3px; }
.raci-textarea { position: relative; display: block; width: 100%; min-height: 520px; resize: vertical; background: transparent; color: var(--fg); border: none; padding: 12px 12px 12px 48px; font-family: ui-monospace, Menlo, monospace; font-size: 12.5px; line-height: 20px; white-space: pre; overflow: auto; tab-size: 2; }
.raci-errnote { list-style: none; margin: 8px 0 0; padding: 0; color: var(--err); font-size: 12px; }
.raci-errnote .raci-warn { color: var(--warn); }
.raci-bar { display: flex; gap: 8px; align-items: center; margin-top: 14px; flex-wrap: wrap; }
.raci-bar .hint { flex: 0 1 200px; min-width: 120px; }
.raci-bar .raci-btn { flex: none; }
.raci-apply .raci-bar .hint { flex: 1 1 auto; }
.raci-pane .raci-bar { flex-wrap: nowrap; }
.raci-pane .raci-bar .raci-btn { flex: 0 1 auto; }
.raci-spacer { flex: 1; }
.raci-reload-hint { margin-top: 8px; }
.raci-label-row { display: flex; align-items: center; gap: 12px; margin: 0 0 10px; }
.workbench-section-label.raci-inline-label { border-top: none; padding-top: 0; margin: 0; }
.raci-proposal .raci-label-row, .raci-recorded .workbench-section-label, .raci-apply .workbench-section-label { margin-top: 26px; }
.raci-table-card { padding: 0; overflow: auto; }
.raci-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.raci-table th { color: var(--fg-faint); font-size: 11px; letter-spacing: 0.1em; text-align: left; font-weight: 500; padding: 8px 10px; border-bottom: 1px solid var(--border); }
.raci-table td { padding: 9px 10px; border-bottom: 1px solid #202026; vertical-align: top; }
.raci-table tr:last-child td { border-bottom: none; }
.raci-chip { display: inline-block; background: var(--bg-elev-2); border: 1px solid var(--border); color: var(--fg-dim); padding: 1px 8px; border-radius: 4px; font-size: 12px; }
.raci-route, .raci-audit td:first-child { white-space: nowrap; }
.raci-tag { margin-left: 6px; font-size: 10px; padding: 0 5px; border-radius: 3px; border: 1px solid; font-family: ui-sans-serif, system-ui, sans-serif; }
.raci-tag-changed { color: var(--accent); border-color: #3a4a80; }
.raci-tag-added { color: var(--ok); border-color: #1f4a2c; }
.raci-tag-removed { color: var(--err); border-color: #5a2a2a; }
.raci-row-changed td { background: #1a2340; }
.raci-row-added td { background: #0f2417; }
.raci-row-removed td { background: #2a1414; }
.raci-row-removed .raci-route { text-decoration: line-through; }
.raci-summary { display: flex; gap: 18px; flex-wrap: wrap; margin: 6px 0 12px; font-size: 13px; }
.raci-summary b { font-weight: 600; }
.raci-add { color: var(--ok); }
.raci-changed { color: var(--accent); }
.raci-del { color: var(--err); }
.raci-compare-hint { margin: -6px 0 10px; }
.raci-diff { font-family: ui-monospace, Menlo, monospace; font-size: 12.5px; white-space: pre; overflow: auto; line-height: 1.5; margin: 0; max-height: 420px; }
.raci-diff-add { color: var(--ok); }
.raci-diff-del { color: var(--err); }
.raci-diff-ctx { color: var(--fg-dim); }
.raci-apply-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.raci-field { display: flex; flex-direction: column; gap: 5px; color: var(--fg-dim); font-size: 12px; }
.raci-field input, .raci-field textarea { width: 100%; background: #0b0b0d; border: 1px solid var(--border); border-radius: 6px; color: var(--fg); padding: 8px 10px; font-size: 13px; font-family: inherit; }
.raci-field input.mono { font-family: ui-monospace, Menlo, monospace; }
.raci-field textarea { min-height: 64px; resize: vertical; }
.raci-apply-reason { color: var(--warn); }
.raci-result { margin-top: 12px; border-left: 3px solid var(--border); }
.raci-result-ok { border-left-color: var(--ok); }
.raci-result-fail { border-left-color: var(--err); padding-left: 10px; }
.raci-output { font-family: ui-monospace, Menlo, monospace; font-size: 12px; white-space: pre-wrap; overflow-wrap: anywhere; margin: 8px 0 0; color: var(--fg); }
.raci-error { color: var(--err); font-size: 12px; }
.raci-audit td { font-size: 12.5px; }
.raci-rationale { max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
@media (max-width: 900px) {
  .raci-editor, .raci-apply-grid { grid-template-columns: minmax(0, 1fr); }
  .raci-bar .hint { max-width: 100%; }
}
/* FG-835: Setup › Models (client/models-editor-view.js), after /design/models-editor-mock.html.
   It reuses the FG-834 editor classes above; only the model-policy pieces are here. */
.mp-label-row { margin-top: 26px; }
.mp-view > .workbench-section:first-child .mp-label-row { margin-top: 0; }
.mp-source { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
.mp-path { overflow-wrap: anywhere; }
.mp-chip { text-transform: none; }
.mp-target { display: inline-flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.mp-link, .cp-models-link { color: var(--accent); text-decoration: underline; }
.cp-models-link { display: inline-block; margin-top: 4px; font-size: 12px; }
.mp-source-error { flex-basis: 100%; }
/* FG-845: Setup › Config's git attribution row, controls card and stale notice, and the
   Projects card line. Secondary text stays --fg-dim (AA on --bg). */
.cp-row-attribution td { background: rgba(122, 159, 255, 0.06); }
.attr-tag { display: inline-block; font-size: 11px; padding: 1px 7px; border-radius: 4px; background: var(--border); color: var(--fg); text-transform: none; letter-spacing: normal; }
.attr-tag-src { background: rgba(122, 159, 255, 0.18); color: #c9d6ff; }
.cp-attr-title { font-size: 14px; margin: 0 0 6px; text-transform: none; letter-spacing: normal; }
.cp-attr-caption { font-size: 12px; margin: 0 0 12px; }
.cp-attr-controls { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; }
.cp-attr-ctl { border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; background: var(--bg-elev-2); }
.cp-attr-ctl-title { margin: 0 0 6px; font-size: 13px; text-transform: none; letter-spacing: normal; }
.cp-attr-pill { display: inline-block; border: 1px solid var(--border); border-radius: 999px; padding: 0 8px; font-size: 11px; color: var(--fg-dim); font-weight: 400; overflow-wrap: anywhere; }
.cp-seg { display: inline-flex; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; margin: 6px 0; }
.cp-seg-btn { background: transparent; border: none; border-left: 1px solid var(--border); color: var(--fg-dim); padding: 5px 12px; font-size: 13px; cursor: pointer; min-height: 30px; }
.cp-seg-btn:first-child { border-left: none; }
.cp-seg-btn.cp-seg-on { background: rgba(122, 159, 255, 0.22); color: var(--fg); }
.cp-seg-btn:disabled { cursor: not-allowed; opacity: 0.6; }
.cp-seg-btn:focus-visible, .cp-attr-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.cp-attr-verb { font-size: 12px; margin: 6px 0 10px; overflow-wrap: anywhere; }
.cp-attr-preview { font-size: 12px; margin: 0 0 10px; padding: 6px 8px; border: 1px dashed var(--border); border-radius: 6px; overflow-wrap: anywhere; }
.cp-attr-btn { background: transparent; border: 1px solid var(--border); color: var(--fg); border-radius: 6px; padding: 4px 12px; font-size: 13px; cursor: pointer; min-height: 30px; }
.cp-attr-confirm:not(:disabled) { border-color: var(--accent); background: rgba(122, 159, 255, 0.18); }
.cp-attr-btn:disabled { color: var(--fg-dim); cursor: not-allowed; }
.cp-attr-note { font-size: 12px; margin-top: 8px; }
.cp-attr-result { font-size: 12px; margin-top: 6px; white-space: pre-wrap; overflow-wrap: anywhere; }
.cp-attr-result:empty { display: none; }
.cp-attr-stale { margin-top: 12px; padding: 10px 14px; border: 1px solid rgba(250, 204, 21, 0.6); background: rgba(250, 204, 21, 0.07); border-radius: 8px; font-size: 13px; }
.project-attr { font-size: 13px; }
.project-attr-failed { color: var(--warn); }
.mp-quick { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 12px; }
.mp-view .hint { font-size: 12px; color: var(--fg-dim); letter-spacing: normal; text-transform: none; }
.mp-quick-card h3 { margin: 0 0 8px; font-size: 13px; color: var(--fg-dim); font-weight: 500; text-transform: none; letter-spacing: normal; }
.mp-quick-row { display: flex; gap: 10px; align-items: center; margin: 6px 0; }
.mp-quick-name { flex: 0 0 150px; overflow-wrap: anywhere; }
.mp-quick-row[data-role] .mp-quick-name { flex-basis: 170px; }
.mp-alias { flex: 0 0 110px; font-size: 12px; overflow-wrap: anywhere; }
.mp-quick-card select { background: #0b0b0d; border: 1px solid var(--border); color: var(--fg); border-radius: 5px; padding: 5px 8px; font-size: 13px; flex: 0 1 240px; width: 240px; min-width: 0; }
.mp-quick-card select.mp-add { flex-basis: 190px; width: 190px; font-family: inherit; }
.mp-quick-card select.mono { font-family: ui-monospace, Menlo, monospace; }
.mp-quick-card select:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.mp-add { color: var(--fg-dim) !important; }
.mp-quick-off { margin-top: 0; }
.mp-editing .raci-editor { margin-top: 14px; }
.mp-resolution td { font-size: 12.5px; overflow-wrap: break-word; }
.mp-tier { color: var(--fg-faint); font-size: 11px; }
.mp-role-link { color: inherit; text-decoration: none; }
.mp-role-link:hover, .mp-role-link:focus-visible { color: var(--accent); text-decoration: underline; }
.mp-was { color: var(--fg-faint); font-size: 11px; }
.mp-cell-err { color: var(--err); }
.mp-tag-undispatchable { color: var(--err); border-color: #5a2a2a; }
.mp-tag-changed { color: var(--accent); border-color: #3a4a80; }
.mp-harness-hint { margin-top: 6px; }
.mp-diff td { font-size: 12.5px; overflow-wrap: anywhere; }
.mp-file { overflow-wrap: anywhere; }
.mp-restore-cell { white-space: nowrap; }
.mp-backups .workbench-section-label, .mp-recorded .workbench-section-label, .mp-proposal .raci-label-row { margin-top: 26px; }
@media (max-width: 900px) {
  .mp-quick { grid-template-columns: minmax(0, 1fr); }
}
@media (max-width: 520px) {
  .mp-quick-row { flex-wrap: wrap; }
  .mp-quick-name, .mp-quick-row[data-role] .mp-quick-name, .mp-alias { flex-basis: auto; }
  .mp-quick-card select { flex: 1 1 100%; width: 100%; }
  .mp-restore-cell { white-space: normal; }
}
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

/* ── FG-348 Run Map + Explain ─────────────────────────────────────────────── */
.rm-view { margin-top: 12px; }
.rm-header { margin-bottom: 12px; }
.rm-degraded {
  font-size: 11px; padding: 2px 8px; border-radius: 4px;
  border: 1px dashed var(--warn); color: var(--warn);
}
.rm-warnings { margin: 8px 0 16px; display: flex; flex-direction: column; gap: 6px; }
.rm-warning {
  background: rgba(250, 204, 21, 0.10);
  border-left: 3px solid var(--warn);
  color: var(--fg);
  padding: 8px 12px; border-radius: 4px; font-size: 13px;
}
/* The DAG canvas: layers laid left-to-right, arrows between them. */
.rm-canvas { display: flex; align-items: flex-start; gap: 8px; overflow-x: auto; padding: 8px 0 16px; }
.rm-layer { display: flex; flex-direction: column; gap: 16px; min-width: 220px; }
.rm-arrow { align-self: center; color: var(--fg-faint); font-size: 20px; padding: 0 4px; }
.rm-column { display: flex; flex-direction: column; gap: 8px; }
.rm-phase {
  background: var(--bg-elev-2); border: 1px solid var(--border); border-radius: 6px;
  padding: 8px 10px;
}
/* A fanout PHASE is border-distinguished (dashed) — never color-only. */
.rm-phase-fanout { border-style: dashed; }
.rm-phase-inferred { border-color: var(--warn); }
.rm-phase-name { font-weight: 700; font-size: 13px; }
.rm-phase-meta { display: flex; flex-wrap: wrap; gap: 6px; font-size: 11px; color: var(--fg-dim); margin-top: 4px; }
.rm-phase-role { color: var(--accent); }
.rm-phase-flag { color: var(--magenta); }
.rm-phase-deps { font-size: 10px; color: var(--fg-faint); margin-top: 4px; }
.rm-nodes { display: flex; flex-direction: column; gap: 8px; }
.rm-node-group { display: flex; flex-direction: column; gap: 4px; }
.rm-node {
  display: block; text-decoration: none; box-sizing: border-box;
  text-align: left; width: 100%;
  background: var(--bg-elev); border: 1px solid var(--border); border-radius: 6px;
  padding: 8px 10px; cursor: pointer; color: var(--fg); font: inherit;
}
.rm-node:hover { border-color: var(--accent); }
.rm-node-inferred { border-style: dotted; }
.rm-node-head { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
.rm-role { font-weight: 600; font-size: 13px; }
.rm-node-meta { display: flex; flex-wrap: wrap; gap: 6px; font-size: 11px; color: var(--fg-dim); margin-top: 4px; }
.rm-gate { color: var(--fg-dim); }
.rm-model { color: var(--info); font-family: ui-monospace, "SF Mono", Menlo, monospace; }
.rm-model-inferred { color: var(--warn); }
.rm-lineage { color: var(--fg-faint); font-style: italic; }
.rm-status { font-family: ui-monospace, "SF Mono", Menlo, monospace; }
.rm-status-complete { color: var(--ok); }
.rm-status-failed, .rm-status-blocked_by_red { color: var(--err); }
.rm-status-running { color: var(--info); }
.rm-status-awaiting_gate, .rm-status-awaiting_red, .rm-status-awaiting_recovery { color: var(--warn); }
.rm-status-pending, .rm-status-unknown { color: var(--fg-dim); }
/* Reds attach under their primary, shape-distinguished (◆ + solid left accent). */
.rm-reds { display: flex; flex-direction: column; gap: 4px; margin-left: 16px; }
.rm-red {
  display: flex; align-items: center; gap: 6px; flex-wrap: wrap; text-decoration: none; box-sizing: border-box;
  text-align: left; width: 100%;
  background: var(--bg-elev); border: 1px solid var(--border);
  border-left: 3px solid var(--magenta); border-radius: 4px;
  padding: 5px 8px; cursor: pointer; color: var(--fg); font: inherit; font-size: 11px;
}
.rm-red:hover { border-color: var(--accent); }
.rm-red-mark { color: var(--magenta); }
.rm-red-role { font-weight: 600; }
.rm-red-via { color: var(--fg-faint); }
/* A fanout GROUP node: dashed border + ⑃ mark — shape-distinct from reds. */
.rm-fanout { border: 1px dashed var(--fg-faint); border-radius: 6px; }
.rm-fanout-head {
  display: flex; align-items: center; gap: 6px; width: 100%;
  background: transparent; border: none; color: var(--fg); font: inherit;
  padding: 8px 10px; cursor: pointer; font-size: 12px;
}
.rm-fanout-mark { color: var(--magenta); }
.rm-fanout-children { display: flex; flex-direction: column; gap: 8px; padding: 0 8px 8px; }
.rm-empty { font-size: 12px; padding: 4px 0; }
.rm-open-btn {
  text-decoration: none;
  background: transparent; border: 1px solid var(--border); border-radius: 4px;
  color: var(--accent); font: inherit; font-size: 11px; padding: 2px 8px; cursor: pointer;
}
.rm-open-btn:hover { border-color: var(--accent); }

/* Explain page content (FG-821: a page, no longer an overlay). */
.rx-panel { max-width: 720px; }
.rx-heading { margin: 0 0 12px; font-size: 18px; }
.rx-identity { display: flex; gap: 10px; align-items: baseline; margin-bottom: 12px; font-size: 13px; }
.rx-warnings { margin-bottom: 16px; display: flex; flex-direction: column; gap: 6px; }
.rx-warning {
  background: rgba(250, 204, 21, 0.10);
  border-left: 3px solid var(--warn);
  padding: 8px 12px; border-radius: 4px; font-size: 13px; color: var(--fg);
}
.rx-block { border-top: 1px solid var(--border); padding: 10px 0; }
.rx-block-head { display: flex; justify-content: space-between; align-items: baseline; }
.rx-block-title { margin: 0; font-size: 13px; font-weight: 700; letter-spacing: 0.04em; }
.rx-status { font-size: 11px; font-family: ui-monospace, "SF Mono", Menlo, monospace; }
.rx-status-recorded { color: var(--ok); }
.rx-status-inferred { color: var(--warn); }
.rx-status-unknown { color: var(--fg-faint); }
.rx-block-body { margin-top: 6px; display: flex; flex-direction: column; gap: 3px; }
.rx-field { display: flex; gap: 10px; font-size: 12px; }
.rx-field-label { color: var(--fg-dim); min-width: 130px; }
.rx-field-value { color: var(--fg); word-break: break-all; }
.rx-decision { font-size: 12px; margin: 3px 0; }
.rx-decision-verb { font-weight: 600; margin-right: 8px; }
.rx-decision-rationale { color: var(--fg-dim); margin-top: 2px; }
.rx-red { display: flex; gap: 8px; align-items: baseline; font-size: 12px; margin: 2px 0; }
.rx-verdict-pass { color: var(--ok); }
.rx-verdict-fail { color: var(--err); }
.rx-verdict-inconclusive { color: var(--warn); }
.rx-artifacts { display: flex; flex-wrap: wrap; gap: 10px; font-size: 12px; }
.rx-artifact { font-family: ui-monospace, "SF Mono", Menlo, monospace; }
.rx-artifact-absent { color: var(--fg-faint); }

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

/* FG-386: shipping-audit projection.
 *
 * Every audit state carries its own label text as well as colour — a monochrome or
 * colour-blind read still gets "not observed" vs "passed" from the badge itself,
 * never from hue alone. not_observed is deliberately the dim neutral, never green:
 * absence of evidence is not evidence of a pass.
 *
 * Mechanical evidence (readiness gaps, host-verification shipping checks) and
 * MODEL-authored reviewer findings sit in visually distinct blocks — the mechanical
 * block is monospace on a bordered neutral panel, the model block is a bordered
 * card with a left accent — so the two are never mistaken for one kind of check. */
.shipping-view { margin-top: 20px; }
.audit-row { margin-bottom: 12px; }
.audit-row-head { justify-content: space-between; align-items: baseline; }
.audit-axes {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 6px 16px;
  margin-top: 10px;
  font-size: 12px;
}
.audit-axis-label { color: var(--fg-dim); margin-right: 6px; }
.badge.audit-passed { background: rgba(74, 222, 128, 0.15); color: var(--ok); }
.badge.audit-failed { background: rgba(248, 113, 113, 0.15); color: var(--err); }
.badge.audit-running { background: rgba(96, 165, 250, 0.15); color: var(--info); }
.badge.audit-needs_human { background: rgba(250, 204, 21, 0.18); color: var(--warn); }
.badge.audit-stale { background: rgba(250, 204, 21, 0.15); color: var(--warn); font-style: italic; }
.badge.audit-not_observed { background: rgba(154, 154, 163, 0.15); color: var(--fg-dim); font-style: italic; }
.audit-mechanical {
  margin-top: 8px;
  padding: 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  font-family: var(--mono, monospace);
  font-size: 12px;
}
.audit-mechanical h4, .audit-model h4 {
  margin: 0 0 6px;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--fg-dim);
}
.audit-check-row { display: flex; gap: 8px; align-items: baseline; padding: 2px 0; }
.audit-model {
  margin-top: 8px;
  padding: 8px;
  border: 1px solid var(--border);
  border-left: 3px solid var(--info);
  border-radius: 6px;
  font-size: 12px;
}
.audit-model-finding { padding: 4px 0; border-top: 1px solid var(--border); }
.audit-model-finding:first-of-type { border-top: none; }
.audit-deferrals {
  margin-top: 8px;
  padding: 8px;
  border: 1px dashed var(--border);
  border-radius: 6px;
  font-size: 12px;
}
.audit-gaps { margin: 4px 0 0; padding-left: 18px; }
.audit-stale-note { color: var(--warn); font-size: 11px; margin-top: 4px; }

/* FG-395: the read-only Campaigns view. The list is click-to-open cards; the detail
 * reuses the shared .detail-overlay / .detail modal. Per-item evidence axes borrow
 * the audit-axis-label dim treatment so absence reads as "not observed", never green. */
.campaigns-view { margin-top: 20px; }
.campaign-card { margin-bottom: 10px; cursor: pointer; }
.campaign-card:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.campaign-card-head { justify-content: space-between; align-items: baseline; }
.campaign-counts { font-size: 12px; margin-top: 6px; color: var(--fg-dim); }
.campaign-next-action { margin-top: 8px; border-left: 3px solid var(--accent); }
.campaign-groupings {
  margin-top: 12px;
  padding: 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 12px;
}
.campaign-grouping-row { display: flex; gap: 8px; align-items: baseline; padding: 2px 0; }
.campaign-item { margin-top: 10px; cursor: default; }
.campaign-item-head { justify-content: space-between; align-items: baseline; }
.campaign-item-axis { font-size: 12px; margin-top: 6px; }
.campaign-item-blocker { margin-top: 8px; border-left: 3px solid var(--err); }
.campaign-item-action { font-size: 12px; margin-top: 4px; }
.campaign-git {
  margin-top: 8px;
  padding: 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 12px;
  display: flex;
  flex-wrap: wrap;
  gap: 4px 8px;
  align-items: baseline;
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

/* FG-844: one row of lanes, always. The board is one screen tall (the viewport less
 * --queue-board-chrome: the page's own padding and the horizontal scrollbar); every lane
 * header stays on screen while each lane scrolls its cards inside itself, and the board
 * scrolls sideways when the lanes are wider than the content. */
.app:has(> .queue-view) { max-width: none; }
.queue-view { --queue-board-chrome: 140px; }
.queue-columns {
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: minmax(260px, 1fr);
  grid-template-rows: minmax(0, 1fr);
  gap: 12px;
  margin-top: 16px;
  height: max(320px, calc(100dvh - var(--queue-board-chrome)));
  overflow-x: auto;
  overflow-y: hidden;
  padding-bottom: 6px;
}
.queue-columns:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.queue-column {
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 8px;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.queue-column-head {
  position: sticky;
  top: 0;
  z-index: 1;
  flex: none;
  background: var(--bg-elev);
  border-bottom: 1px solid var(--border);
  border-radius: 8px 8px 0 0;
  padding: 10px 12px;
}
.queue-column-title {
  font-size: 11px;
  letter-spacing: 0.1em;
  margin: 0;
  display: flex;
  align-items: center;
  gap: 6px;
}
.queue-column-name { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
.queue-column-count {
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0;
  color: var(--fg);
}
.queue-derived-badge { background: rgba(122, 159, 255, 0.12); color: var(--accent); font-size: 10px; letter-spacing: 0; text-transform: none; }
.queue-lane-scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 10px; }
.queue-column-hint { font-size: 11px; margin: 0 0 8px; line-height: 1.45; }
.queue-column-missing { font-size: 11px; margin-bottom: 6px; color: var(--warn); }
.queue-column-empty { font-size: 12px; font-style: italic; list-style: none; padding: 8px 0; }
.queue-cards { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
/* Past COMPACT_CARD_THRESHOLD cards a lane is a scannable list: title, id and one status
 * line. The full card returns on hover, on focus anywhere inside it, and on the
 * aria-expanded toggle — the toggle is the path that needs neither a mouse nor focus. */
.queue-card.queue-card-compact { padding: 6px 10px; }
.queue-card-compact .queue-card-title { font-size: 12.5px; font-weight: 500; }
.queue-card-compact:not(.queue-card-expanded):not(:hover):not(:focus-within) .queue-card-detail { display: none; }
.queue-card-compact .queue-card-head { flex-wrap: nowrap; align-items: flex-start; }
.queue-card-compact .queue-card-title { flex: 1 1 auto; min-width: 0; line-height: 1.35; }
.queue-card-meta { display: flex; gap: 6px; align-items: baseline; margin-top: 3px; min-width: 0; }
.queue-card-meta .queue-card-rank { min-width: 0; }
.queue-card-status { font-size: 11px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.queue-card-toggle {
  flex: none; background: transparent; border: 1px solid var(--border); border-radius: 4px;
  color: var(--fg-dim); font: inherit; font-size: 11px; line-height: 1; padding: 2px 6px; cursor: pointer;
}
.queue-card-toggle:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
/* The lane strip exists only under 900px, where the board shows one lane at a time. */
.queue-lane-strip { display: none; }
@media (max-width: 899.98px) {
  .queue-lane-strip {
    display: flex; gap: 4px; margin-top: 16px; overflow-x: auto;
    border-bottom: 1px solid var(--border);
  }
  .queue-lane-tab {
    flex: none; padding: 6px 12px; color: var(--fg-dim); text-decoration: none; font-size: 13px;
    border-bottom: 2px solid transparent; white-space: nowrap;
  }
  .queue-lane-tab:hover { color: var(--fg); }
  .queue-lane-tab-current { color: var(--fg); border-bottom-color: var(--accent); }
  .queue-lane-tab:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  .queue-lane-tab-count { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 11px; color: var(--fg-dim); }
  .queue-columns { grid-auto-columns: minmax(0, 1fr); margin-top: 10px; overflow-x: hidden; }
  .queue-column:not(.queue-column-selected) { display: none; }
}
@media (max-width: 719.98px) {
  /* The page reserves room for the fixed FG-820 bottom bar below the nav breakpoint. */
  .queue-view { --queue-board-chrome: 200px; }
}

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
/* The blocked-vs-waiting state detail (RF-4): its own color is the AA-contrast
 * --fg-dim, never the sub-AA --fg-faint (2.74:1 on the card), so the reason a
 * candidate was passed over stays legible at its 10px size. */
.queue-wait-meta,
.queue-wait-note { color: var(--fg-dim); font-size: 10px; margin-top: 3px; line-height: 1.45; }
.queue-reservation { font-size: 10px; margin-top: 6px; overflow-wrap: anywhere; }
.queue-lease-expired { color: var(--err); }
.queue-card-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 8px; }
.queue-card-reorder-hint { font-size: 10px; }

/* FG-846: an action's outcome at the point of action (client/action-outcome.js). It is the
   control's next DOM sibling; inside a wrapping flex row it takes a line of its own at the
   row's end (order + full basis), so the row's other items keep their places. */
.action-outcome { order: 99; flex: 1 0 100%; box-sizing: border-box; border-left: 3px solid var(--err); background: rgba(248, 113, 113, 0.07); border-radius: 6px; padding: 8px 10px; font-size: 12px; overflow-wrap: anywhere; cursor: default; }
.action-outcome-applied { border-left-color: var(--ok); background: rgba(74, 222, 128, 0.07); }
.action-outcome:focus { outline: 2px solid var(--accent); outline-offset: 2px; }
.action-outcome:focus:not(:focus-visible) { outline-style: dotted; }
.action-outcome-line { display: flex; flex-wrap: wrap; gap: 4px 6px; align-items: baseline; }
.action-outcome-message { white-space: pre-wrap; }
.action-outcome-gaps { margin: 6px 0 4px; padding-left: 0; list-style: none; }
.action-outcome-gaps li::before { content: "☐ "; color: var(--fg-dim); }
.action-outcome-proposal { font-size: 12px; }
.action-outcome-actions { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-top: 8px; }
.action-outcome-actions a { text-decoration: none; display: inline-flex; align-items: center; }
.action-outcome-hint { font-size: 11px; }
.queue-refusal-pill { display: inline-flex; flex-wrap: wrap; align-items: baseline; gap: 4px; font-size: 11px; }
.link-btn { background: none; border: none; padding: 0; color: var(--accent); cursor: pointer; font: inherit; }
.link-btn:hover { text-decoration: underline; }

/* FG-847: the Refine panel (client/refine-panel-view.js) — the Queue's inline refusal and
   the ticket page's edit mode. */
.refine-panel { border: 1px solid var(--border); border-radius: 8px; background: var(--bg-elev-2); padding: 10px 12px; margin-top: 8px; }
.refine-title { margin: 0 0 6px; font-size: 13px; }
.refine-via { font-weight: 400; font-size: 12px; }
.refine-gaps { margin: 6px 0; padding-left: 0; list-style: none; }
.refine-gaps li { margin: 3px 0; }
.refine-gap-open::before { content: "☐ "; color: var(--fg-dim); }
.refine-gap-done::before { content: "☑ "; color: var(--ok); }
.refine-proposal { font-size: 12px; margin: 4px 0 8px; }
.refine-body { width: 100%; box-sizing: border-box; min-height: 160px; resize: vertical; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; color: var(--fg); font: 12px/1.5 ui-monospace, "SF Mono", Menlo, monospace; padding: 8px 10px; }
.refine-body:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
.refine-error { color: var(--err); font-size: 12px; margin-top: 6px; }
.refine-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 8px; }
.refine-hint { font-size: 12px; }
.ticket-readiness { margin: 12px 0; }
.ticket-readiness-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; font-size: 12px; }
.ticket-readiness-gaps { overflow-wrap: anywhere; }

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
