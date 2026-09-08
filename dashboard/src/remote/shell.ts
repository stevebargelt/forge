// FG-781 (step 3): the Remote Board's HTML shell — its OWN document, its OWN CSP, its OWN
// focused asset set. This is deliberately NOT the local dashboard's shell (../shell.ts):
//
//   * It serves NO CLIENT_DIR asset. The local dashboard's client bundle (/client/main.js,
//     the vendored preact/htm/marked module graph, its importmap) is the full operator
//     surface; re-serving it on the remote board would drag the entire local UI — every
//     tab, every mutation affordance — onto the network-frontable surface. The remote shell
//     references ONLY /remote-client/* (FG-781 step 5's focused board), by its own URL
//     prefix.
//   * It carries its OWN `script-src 'self' 'nonce-…'` CSP so the browser enforces
//     first-party-only script execution at runtime — no CDN JS, no inline-string execution.
//     The single inline script the shell needs (a tiny bootstrap that hands the board its
//     API endpoint) is admitted by a per-response nonce; nothing else inline can run.
//
// The shell carries NO project data. It is a static document whose board script fetches the
// projection endpoint and renders whichever of the five envelope states comes back — so an
// unauthorized/refused read (the FG-781 default, no adapter wired) paints the "unauthorized"
// state rather than any project payload.

import { randomBytes } from "node:crypto";

/** The remote board's asset URL prefix. Its own namespace — never `/client/`. The remote
 *  server (server.ts) maps this to `dashboard/remote-client/` on disk. */
export const REMOTE_CLIENT_URL_PREFIX = "/remote-client/";

/** The remote projection endpoint the board script polls. A GET-only, read-only route. */
export const REMOTE_BOARD_ENDPOINT = "/api/board";

/** The board's entry module under the remote asset prefix (FG-781 step 5 owns the file). */
export const REMOTE_BOARD_ENTRY = `${REMOTE_CLIENT_URL_PREFIX}board.js`;

/**
 * The remote board's Content-Security-Policy. `script-src 'self'` admits the same-origin
 * board module; the per-response `'nonce-…'` admits the one inline bootstrap script. Only
 * script-src is constrained (no default-src), so inline <style> and the shell's own layout
 * are unaffected — the same shape the local dashboard's CSP uses, scoped to this surface.
 */
export function remoteContentSecurityPolicy(nonce: string): string {
  return `script-src 'self' 'nonce-${nonce}'`;
}

/** A fresh per-response CSP nonce — base64 of 16 random bytes — matched verbatim between the
 *  CSP header and the inline bootstrap's `nonce` attribute. */
export function remoteCspNonce(): string {
  return randomBytes(16).toString("base64");
}

/**
 * Render the remote board shell. `nonce` is emitted onto BOTH the inline bootstrap and the
 * board module tag and MUST equal the nonce in the response's CSP header, or the browser
 * blocks the bootstrap and the board never learns its endpoint.
 *
 * The bootstrap carries ONLY the endpoint path — no project data, no identity, no secret.
 */
export function renderRemoteShell(nonce: string): string {
  const bootstrap = `window.__REMOTE_BOARD__=${JSON.stringify({ endpoint: REMOTE_BOARD_ENDPOINT })};`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>forge remote board</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="dark light" />
<style>${CSS}</style>
</head>
<body>
<main id="remote-board" aria-live="polite" aria-busy="true">
<p class="rb-loading">Loading the board…</p>
</main>
<script nonce="${nonce}">${bootstrap}</script>
<script type="module" nonce="${nonce}" src="${REMOTE_BOARD_ENTRY}"></script>
</body>
</html>`;
}

// Minimal, self-contained base layout. The focused board UI (FG-781 step 5) owns the state
// rendering; this only keeps the pre-hydration shell legible and responsive on a phone.
const CSS = String.raw`
:root { color-scheme: dark light; }
* { box-sizing: border-box; }
body {
  margin: 0;
  font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif;
  background: #0e0e10;
  color: #e5e5e7;
}
#remote-board { max-width: 900px; margin: 0 auto; padding: 16px; }
.rb-loading { color: #9a9aa3; font-style: italic; }
@media (max-width: 640px) { #remote-board { padding: 12px; } }
`;
