// FG-781 (step 3) UNIT tier — no spawned process, no DB, no network. Two pure modules:
//   * the remote board SHELL (shell.ts): its own nonce CSP; serves NO CLIENT_DIR asset.
//   * the remote MODE/BIND config resolver (config.ts): mode + loopback bind from env, with
//     the bind host structurally pinned to loopback (never env-overridable).
//
// Mutation-sensitive:
//   - Weaken the shell CSP away from `script-src 'self'` (add unsafe-inline/a CDN) → RED.
//   - Reference any `/client/` asset from the remote shell → RED (it must be its own set).
//   - Emit the inline bootstrap without a nonce, or a nonce that mismatches the CSP → RED.
//   - Make the remote bind host env-derivable / non-loopback → RED.
//   - Treat an unset / unrecognised remote-mode flag as enabled → RED (fail closed).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  REMOTE_BOARD_ENDPOINT,
  REMOTE_BOARD_ENTRY,
  REMOTE_CLIENT_URL_PREFIX,
  remoteContentSecurityPolicy,
  remoteCspNonce,
  renderRemoteShell,
} from "./shell.js";
import {
  DEFAULT_REMOTE_PORT,
  REMOTE_LOOPBACK_HOST,
  REMOTE_MODE_ENV,
  REMOTE_PORT_ENV,
  RemotePortCollisionError,
  isLoopbackHost,
  resolveRemoteConfig,
} from "./config.js";

// ─── shell: CSP ───────────────────────────────────────────────────────────────

test("the remote CSP pins script-src to 'self' plus the response nonce — no CDN, no unsafe-inline", () => {
  const csp = remoteContentSecurityPolicy("NONCE123");
  assert.equal(csp, "script-src 'self' 'nonce-NONCE123'");
  assert.match(csp, /script-src 'self'/);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|https?:\/\//, "the remote CSP must not admit inline strings, eval, or a remote origin");
});

test("each nonce is fresh — a nonce is not a reusable constant", () => {
  assert.notEqual(remoteCspNonce(), remoteCspNonce());
});

// ─── shell: HTML ────────────────────────────────────────────────────────────────

test("the shell admits its one inline bootstrap with a nonce that matches the CSP", () => {
  const nonce = "abc+DEF/123=";
  const html = renderRemoteShell(nonce);
  const csp = remoteContentSecurityPolicy(nonce);
  const headerNonce = csp.match(/'nonce-([^']+)'/)?.[1];
  assert.equal(headerNonce, nonce);
  // Every executable inline/module <script> in the shell carries the matching nonce, so
  // nothing runs that the CSP would not admit.
  const scriptTags = [...html.matchAll(/<script(?![^>]*type="application\/json")[^>]*>/g)].map((m) => m[0]);
  assert.ok(scriptTags.length >= 2, "expected the inline bootstrap and the board module script");
  for (const tag of scriptTags) {
    assert.match(tag, new RegExp(`nonce="${nonce.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`), `script tag missing the CSP nonce: ${tag}`);
  }
});

test("the shell serves NO CLIENT_DIR asset — it references only its own /remote-client/ set", () => {
  const html = renderRemoteShell("n");
  assert.ok(!html.includes("/client/"), "the remote shell must not reference any /client/ asset");
  assert.ok(!/importmap/i.test(html), "the remote shell must not carry the local dashboard's vendored importmap");
  assert.ok(!html.includes("/vendor/") && !html.includes("preact") && !html.includes("marked"), "the remote shell must not pull the local client's vendored module graph");
  assert.ok(html.includes(REMOTE_BOARD_ENTRY), "the shell must load its own board entry module");
  assert.ok(REMOTE_BOARD_ENTRY.startsWith(REMOTE_CLIENT_URL_PREFIX), "the board entry lives under the remote asset prefix");
});

test("RF-3: the board container is NOT a live region — state is announced by the scoped role=status banner", () => {
  const html = renderRemoteShell("n");
  const mainTag = html.match(/<main id="remote-board"[^>]*>/)?.[0] ?? "";
  assert.ok(mainTag, "the shell renders the board container");
  assert.ok(!/aria-live/.test(mainTag), "the board container must not carry aria-live (it re-announces every card on refresh)");
  assert.match(mainTag, /aria-busy="true"/, "the container still declares its pre-hydration busy state");
});

test("the shell is responsive and carries no project data in the document itself", () => {
  const html = renderRemoteShell("n");
  assert.match(html, /<meta name="viewport"/, "a phone-usable board declares a viewport");
  // The bootstrap hands the board ONLY its endpoint path — no identity, no project payload.
  assert.ok(html.includes(REMOTE_BOARD_ENDPOINT));
  assert.ok(!/projectKey|projectDir/.test(html), "the shell must not embed any project scope");
});

// ─── config: fail-closed mode resolution ─────────────────────────────────────────

test("remote mode is OFF by default and for every non-opt-in value (fail closed)", () => {
  assert.equal(resolveRemoteConfig({}).enabled, false, "unset → disabled");
  for (const value of ["", "0", "false", "no", "off", "yes", "enabled", "  "]) {
    assert.equal(resolveRemoteConfig({ [REMOTE_MODE_ENV]: value }).enabled, false, `${JSON.stringify(value)} must not enable remote mode`);
  }
});

test("only an explicit 1/true opts in (case-insensitive, trimmed)", () => {
  for (const value of ["1", "true", "TRUE", " true ", "True"]) {
    assert.equal(resolveRemoteConfig({ [REMOTE_MODE_ENV]: value }).enabled, true, `${JSON.stringify(value)} must enable remote mode`);
  }
});

// ─── config: bind resolution — loopback is not env-overridable ───────────────────

test("the bind host is ALWAYS loopback, never widened by any env value", () => {
  assert.equal(resolveRemoteConfig({}).host, REMOTE_LOOPBACK_HOST);
  assert.ok(isLoopbackHost(REMOTE_LOOPBACK_HOST));
  // Even a hostile attempt to widen the bind (a HOST env, or an invented remote-host key)
  // cannot move the remote board off loopback — there is no host input to the resolver.
  const hostile = resolveRemoteConfig({
    [REMOTE_MODE_ENV]: "1",
    HOST: "0.0.0.0",
    FORGE_DASHBOARD_REMOTE_HOST: "0.0.0.0",
  } as NodeJS.ProcessEnv);
  assert.equal(hostile.host, REMOTE_LOOPBACK_HOST, "no env value may open a non-loopback remote listener");
  assert.ok(isLoopbackHost(hostile.host));
});

test("the port resolves from env, falling back to the default for absent/garbage values", () => {
  assert.equal(resolveRemoteConfig({}).port, DEFAULT_REMOTE_PORT);
  assert.equal(resolveRemoteConfig({ [REMOTE_PORT_ENV]: "9931" }).port, 9931);
  assert.equal(resolveRemoteConfig({ [REMOTE_PORT_ENV]: "0" }).port, 0, "0 = OS-assigned ephemeral is honoured");
  for (const bad of ["abc", "-1", "70000", "12.5", ""]) {
    assert.equal(resolveRemoteConfig({ [REMOTE_PORT_ENV]: bad }).port, DEFAULT_REMOTE_PORT, `${JSON.stringify(bad)} must fall back to the default port`);
  }
});

// ─── config: RF-1 — a remote/local port collision is refused before either listener binds ──

test("resolveRemoteConfig REFUSES a remote port equal to the local dashboard port (RF-1)", () => {
  // Default local port (8024) with the remote pinned to it → the remote listener would win the
  // bind and the local dashboard would then fail EADDRINUSE. Refuse at resolution, naming both.
  assert.throws(
    () => resolveRemoteConfig({ [REMOTE_MODE_ENV]: "1", [REMOTE_PORT_ENV]: "8024" }),
    (err: unknown) => {
      assert.ok(err instanceof RemotePortCollisionError, "the refusal is the named collision error");
      assert.equal(err.localPort, 8024);
      assert.equal(err.remotePort, 8024);
      assert.match(err.message, /8024/, "the message names the colliding port");
      return true;
    },
  );

  // Collision via an explicit local PORT too (both set to the same non-default value).
  assert.throws(
    () => resolveRemoteConfig({ [REMOTE_MODE_ENV]: "1", PORT: "9100", [REMOTE_PORT_ENV]: "9100" }),
    /9100/,
  );

  // The default remote port (8025) collides when the LOCAL port is moved onto it.
  assert.throws(
    () => resolveRemoteConfig({ [REMOTE_MODE_ENV]: "1", PORT: "8025" }),
    /8025/,
  );
});

test("resolveRemoteConfig allows distinct ports, and never collides when remote is disabled or ephemeral (RF-1)", () => {
  // Distinct ports are fine — the common case.
  assert.equal(resolveRemoteConfig({ [REMOTE_MODE_ENV]: "1", PORT: "8024", [REMOTE_PORT_ENV]: "8025" }).port, 8025);
  // A disabled remote board binds nothing, so an equal port is not a collision.
  assert.doesNotThrow(() => resolveRemoteConfig({ PORT: "8024", [REMOTE_PORT_ENV]: "8024" }));
  // Port 0 is the OS-assigned ephemeral request; it never "collides" with a fixed local port.
  assert.equal(resolveRemoteConfig({ [REMOTE_MODE_ENV]: "1", PORT: "0", [REMOTE_PORT_ENV]: "0" }).port, 0);
});

test("isLoopbackHost accepts loopback forms and rejects public addresses", () => {
  for (const ok of ["127.0.0.1", "127.5.5.5", "::1", "localhost"]) assert.ok(isLoopbackHost(ok), `${ok} is loopback`);
  for (const no of ["0.0.0.0", "10.0.0.1", "192.168.1.9", "example.com", ""]) assert.ok(!isLoopbackHost(no), `${no} is not loopback`);
});
