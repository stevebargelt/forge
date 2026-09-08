// FG-782 (step 3) UNIT tier — no spawned process, no DB, no network, no filesystem.
// Covers the boot-time TRANSPORT selector added to the pure env config resolver.
//
// Mutation-sensitive:
//   - Treat an absent / empty / unrecognised transport as anything but null → RED (fail
//     closed: no adapter = refuse, the unchanged FG-781 default).
//   - Fail to canonicalise a recognised token (trim + lower-case) → RED.
//   - Let the transport selection touch the bind host → RED (host stays the loopback constant).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_REMOTE_PORT,
  REMOTE_LOOPBACK_HOST,
  REMOTE_MODE_ENV,
  REMOTE_PORT_ENV,
  REMOTE_TRANSPORT_ENV,
  RemotePortCollisionError,
  resolveRemoteConfig,
  resolveRemoteTransport,
} from "./config.js";

// ─── resolveRemoteTransport: fail-closed selector ───────────────────────────────

test("resolveRemoteTransport returns null for absent / empty / unrecognised tokens (fail closed)", () => {
  assert.equal(resolveRemoteTransport({}), null, "absent → no adapter");
  for (const value of ["", "   ", "0", "false", "funnel", "cloudflare", "tailscale-serve", "TAILSCALE!", "garbage"]) {
    assert.equal(
      resolveRemoteTransport({ [REMOTE_TRANSPORT_ENV]: value }),
      null,
      `${JSON.stringify(value)} must not select an adapter`,
    );
  }
});

test("resolveRemoteTransport canonicalises a recognised token (trim + lower-case)", () => {
  for (const value of ["tailscale", "TAILSCALE", "  tailscale  ", "Tailscale"]) {
    assert.equal(
      resolveRemoteTransport({ [REMOTE_TRANSPORT_ENV]: value }),
      "tailscale",
      `${JSON.stringify(value)} must select the canonical 'tailscale' token`,
    );
  }
});

test("resolveRemoteTransport reads FORGE_DASHBOARD_REMOTE_TRANSPORT and nothing a request carries", () => {
  // The selector is a function of the one env value alone — an unrelated env key never leaks in.
  assert.equal(resolveRemoteTransport({ TAILSCALE: "tailscale", "X-Forwarded-For": "tailscale" }), null);
});

// ─── resolveRemoteConfig: transport is always populated, additively ─────────────

test("resolveRemoteConfig always populates transport and keeps it null by default", () => {
  assert.equal(resolveRemoteConfig({}).transport, null, "no transport env → null (FG-781 default)");
  assert.equal(
    resolveRemoteConfig({ [REMOTE_TRANSPORT_ENV]: "tailscale" }).transport,
    "tailscale",
    "recognised token flows through to the config",
  );
  assert.equal(
    resolveRemoteConfig({ [REMOTE_TRANSPORT_ENV]: "funnel" }).transport,
    null,
    "unrecognised token → null (never a widened selection)",
  );
});

test("selecting a transport NEVER changes the loopback bind host (FG-781 invariant preserved)", () => {
  const cfg = resolveRemoteConfig({
    [REMOTE_MODE_ENV]: "1",
    [REMOTE_TRANSPORT_ENV]: "tailscale",
    // hostile attempts to steer the bind — the host is a constant, never env-derived.
    FORGE_DASHBOARD_REMOTE_HOST: "0.0.0.0",
    HOST: "0.0.0.0",
  });
  assert.equal(cfg.host, REMOTE_LOOPBACK_HOST, "the bind host stays the loopback constant");
  assert.equal(cfg.transport, "tailscale");
});

// ─── FG-781 config assertions remain green under the additive change ────────────

test("resolveRemoteConfig still returns the loopback host constant and default port", () => {
  const cfg = resolveRemoteConfig({});
  assert.equal(cfg.host, REMOTE_LOOPBACK_HOST);
  assert.equal(cfg.port, DEFAULT_REMOTE_PORT);
  assert.equal(cfg.enabled, false);
});

test("the RF-1 port collision guard is unchanged by the transport field", () => {
  assert.throws(
    () => resolveRemoteConfig({ [REMOTE_MODE_ENV]: "1", [REMOTE_PORT_ENV]: "8024", [REMOTE_TRANSPORT_ENV]: "tailscale" }),
    RemotePortCollisionError,
    "a colliding remote port is still refused even with a transport selected",
  );
});
