// FG-782 (step 7) UNIT tier — the boot-time transport registry. No process, no listener, no
// real fs: selectRemoteAdapter is a pure function of the token + injected deps, and the fake
// deps below are plain functions, so the whole registry surface is exercised without spawning
// anything or touching a real tailscaled/mapping file.
//
// Coverage:
//   * the recognised token 'tailscale' builds an adapter whose kind is 'tailscale-serve';
//   * every OTHER value — null, undefined, '', an unknown token, a near-miss — fails closed to
//     null (the FG-781 no-adapter default);
//   * the built adapter is actually WIRED to the injected deps: a whois-confirmed + mapped peer
//     flows to a candidate, and a forged-header/unconfirmable peer flows to null.

import { test } from "node:test";
import assert from "node:assert/strict";

import { selectRemoteAdapter, TAILSCALE_TRANSPORT } from "./transport.js";
import { TAILSCALE_SERVE_ADAPTER_KIND, type TailscaleServeAdapterDeps } from "./tailscale/adapter.js";
import type { IdentityMapping } from "./mapping.js";
import type { TailscaleWhois } from "./tailscale/cli.js";

/** A pure (no-process) set of adapter deps: a fake daemon that confirms exactly one peer and a
 *  fake mapping that authorizes exactly one login for one project. */
function pureDeps(): TailscaleServeAdapterDeps {
  const mapping: IdentityMapping = {
    lookup: (login) =>
      login === "alice@example.com"
        ? { login: "alice@example.com", projectKey: "repo-alpha", capabilities: ["read"] }
        : null,
    size: 1,
  };
  const confirmPeer = (peerAddr: string): TailscaleWhois | null =>
    peerAddr === "100.64.0.1" ? { login: "alice@example.com", node: "alice.tail.ts.net" } : null;
  return {
    lookupProject: (key) => (key === "repo-alpha" ? { key: "repo-alpha", projectDirs: ["/work/alpha"] } : undefined),
    confirmPeer,
    loadMapping: () => mapping,
  };
}

test("'tailscale' → an adapter whose kind is 'tailscale-serve'", () => {
  const adapter = selectRemoteAdapter(TAILSCALE_TRANSPORT, pureDeps());
  assert.ok(adapter, "the recognised token selects an adapter");
  assert.equal(adapter!.kind, TAILSCALE_SERVE_ADAPTER_KIND);
});

test("every non-recognised token fails closed to null (the FG-781 no-adapter default)", () => {
  const deps = pureDeps();
  for (const token of [null, undefined, "", "  ", "tailscal", "TAILSCALE", "cloudflare", "funnel", "1"]) {
    assert.equal(
      selectRemoteAdapter(token as string | null | undefined, deps),
      null,
      `token ${JSON.stringify(token)} must select NO adapter (fail closed)`,
    );
  }
});

test("the selected adapter is wired to the injected deps: confirmed+mapped peer → candidate", async () => {
  const adapter = selectRemoteAdapter(TAILSCALE_TRANSPORT, pureDeps());
  assert.ok(adapter);
  const candidate = await adapter!.verifyIdentity({
    headers: { "tailscale-user-login": "attacker@evil.example" }, // forged; must be ignored
    peer: { address: "100.64.0.1", port: 41000 },
  });
  assert.ok(candidate, "a whois-confirmed, mapped peer yields a candidate");
  assert.equal(candidate!.subject, "alice@example.com", "identity is the whois login, NOT the forged header");
  assert.deepEqual(candidate!.projectScope, { projectKey: "repo-alpha", memberDirs: ["/work/alpha"] });
});

test("the selected adapter fails closed for an unconfirmable peer (forged headers, no whois)", async () => {
  const adapter = selectRemoteAdapter(TAILSCALE_TRANSPORT, pureDeps());
  assert.ok(adapter);
  // A peer the fake daemon does not confirm — the forged header is never read.
  const candidate = await adapter!.verifyIdentity({
    headers: { "tailscale-user-login": "alice@example.com" },
    peer: { address: "203.0.113.9", port: 41000 },
  });
  assert.equal(candidate, null, "no whois-confirmed peer → no candidate, no data (AC3)");
});
