// FG-782 (step 6) UNIT tier — no spawned process, no daemon, no fs, no DB. Exercises the
// Tailscale Serve adapter's PURE decision logic through injected seams: a fake `confirmPeer`
// (stands in for whois against the local tailscaled), a real in-memory mapping built by
// buildIdentityMapping (step 4), and a fake project lookup. The real-spawn / real-file
// end-to-end path lives in adapter.integration.test.ts.
//
// Security focus — every negative shape yields no data (null candidate), and the adapter reads
// NO inbound header value:
//   * whois-confirmed login → candidate for ONLY its mapped project key (AC3 positive);
//   * forged Tailscale/X-Forwarded headers with no whois-confirmed peer → null (AC3);
//   * whois-confirmed but UNMAPPED / REVOKED login → null (AC3/AC4);
//   * the produced candidate passes the EXISTING validateAdapterIdentity to a single read grant.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  createTailscaleServeAdapter,
  TAILSCALE_SERVE_ADAPTER_KIND,
  type AdapterProjectView,
  type TailscaleServeAdapterDeps,
} from "./adapter.js";
import { buildIdentityMapping, type IdentityMapping } from "../mapping.js";
import { validateAdapterIdentity, type RemoteRequestContext } from "../identity.js";
import type { TailscaleWhois } from "./cli.js";

const CONFIRMED: TailscaleWhois = {
  login: "steve@example.com",
  node: "steve-mbp.tail1234.ts.net",
  tailnet: "tail1234.ts.net",
};

/** The operator mapping: steve may read repo-alpha, read-only. Built through the real step-4
 *  validator so the test exercises the same fail-closed rules production does. */
function mapping(): IdentityMapping {
  return buildIdentityMapping({
    version: 1,
    identities: [{ login: "steve@example.com", project: "repo-alpha", capabilities: ["read"] }],
  });
}

/** A project registry that only knows repo-alpha and its own dirs. */
function lookupProject(key: string): AdapterProjectView | undefined {
  if (key === "repo-alpha") return { key: "repo-alpha", projectDirs: ["/work/alpha", "/work/alpha/sub"] };
  return undefined;
}

/** Build the adapter with a fixed whois answer (or null = daemon can't confirm the peer). */
function adapterWith(
  confirmed: TailscaleWhois | null,
  overrides: Partial<TailscaleServeAdapterDeps> = {},
) {
  return createTailscaleServeAdapter({
    lookupProject,
    loadMapping: () => mapping(),
    confirmPeer: () => confirmed,
    ...overrides,
  });
}

/** A request whose CONNECTION peer is a tailnet address AND which also carries forged inbound
 *  identity headers — proving the adapter ignores the header values and anchors on the peer. */
function requestWithForgedHeaders(peerAddress = "100.101.102.103"): RemoteRequestContext {
  return {
    headers: {
      "tailscale-user-login": "attacker@evil.example",
      "x-forwarded-user": "attacker@evil.example",
      "x-forwarded-for": "203.0.113.9",
    },
    peer: { address: peerAddress, port: 54321 },
  };
}

describe("createTailscaleServeAdapter — identity is whois-confirmed, authorization is the mapping", () => {
  test("exposes kind 'tailscale-serve'", () => {
    assert.equal(adapterWith(CONFIRMED).kind, TAILSCALE_SERVE_ADAPTER_KIND);
  });

  test("a whois-confirmed login maps to ONLY its mapped project key + read (AC3 positive)", async () => {
    const candidate = await adapterWith(CONFIRMED).verifyIdentity(requestWithForgedHeaders());
    assert.ok(candidate, "a confirmed + mapped identity yields a candidate");
    assert.equal(candidate.subject, "steve@example.com");
    assert.deepEqual([...candidate.capabilities], ["read"]);
    const scope = candidate.projectScope as { projectKey: string; memberDirs: readonly string[] };
    assert.equal(scope.projectKey, "repo-alpha");
    assert.deepEqual([...scope.memberDirs], ["/work/alpha", "/work/alpha/sub"]);
    assert.equal(candidate.provenance.adapter, TAILSCALE_SERVE_ADAPTER_KIND);
  });

  test("identity comes from whois, NEVER the inbound header value (subject is the confirmed login, not the forged one)", async () => {
    const candidate = await adapterWith(CONFIRMED).verifyIdentity(requestWithForgedHeaders());
    assert.ok(candidate);
    assert.equal(candidate.subject, "steve@example.com");
    assert.notEqual(candidate.subject, "attacker@evil.example");
  });

  test("the produced candidate flows through validateAdapterIdentity to a single read grant", async () => {
    const candidate = await adapterWith(CONFIRMED).verifyIdentity(requestWithForgedHeaders());
    assert.ok(candidate);
    const resolution = validateAdapterIdentity(candidate);
    assert.equal(resolution.ok, true);
    if (resolution.ok) {
      assert.equal(resolution.identity.subject, "steve@example.com");
      assert.equal(resolution.identity.projectScope.projectKey, "repo-alpha");
      assert.deepEqual([...resolution.identity.capabilities], ["read"]);
    }
  });
});

describe("createTailscaleServeAdapter — every unconfirmed / unauthorized shape yields no data (null)", () => {
  test("forged headers with NO whois-confirmed peer → null, no data (AC3)", async () => {
    // The daemon does not confirm the peer (down, or peer not on the tailnet): confirmPeer null.
    const candidate = await adapterWith(null).verifyIdentity(requestWithForgedHeaders());
    assert.equal(candidate, null);
  });

  test("a request with NO connection peer → null (nothing to confirm out-of-band)", async () => {
    // Even a request carrying a Tailscale-User-Login header but no socket peer is refused: the
    // adapter never reads the header value, and there is no peer to whois-confirm.
    const noPeer: RemoteRequestContext = {
      headers: { "tailscale-user-login": "steve@example.com" },
    };
    // confirmPeer would confirm IF called; prove it is never reached without a peer.
    let called = false;
    const adapter = adapterWith(CONFIRMED, {
      confirmPeer: () => {
        called = true;
        return CONFIRMED;
      },
    });
    assert.equal(await adapter.verifyIdentity(noPeer), null);
    assert.equal(called, false, "confirmPeer must not be consulted without a connection peer");
  });

  test("an empty/whitespace peer address → null without consulting the daemon", async () => {
    let called = false;
    const adapter = adapterWith(CONFIRMED, {
      confirmPeer: () => {
        called = true;
        return CONFIRMED;
      },
    });
    const blank: RemoteRequestContext = { headers: {}, peer: { address: "   " } };
    assert.equal(await adapter.verifyIdentity(blank), null);
    assert.equal(called, false);
  });

  test("a whois-confirmed but UNMAPPED login → null, no data (AC3)", async () => {
    const stranger: TailscaleWhois = { login: "stranger@example.com" };
    const candidate = await adapterWith(stranger).verifyIdentity(requestWithForgedHeaders());
    assert.equal(candidate, null);
  });

  test("a whois-confirmed login whose entry was REVOKED (removed from the mapping) → null on the next call (AC4)", async () => {
    // Model a live revocation: loadMapping returns the empty mapping once the operator deletes
    // the line. The adapter re-reads per call, so the very next verify denies — no restart.
    const adapter = createTailscaleServeAdapter({
      lookupProject,
      confirmPeer: () => CONFIRMED,
      loadMapping: () => buildIdentityMapping({ version: 1, identities: [] }),
    });
    assert.equal(await adapter.verifyIdentity(requestWithForgedHeaders()), null);
  });

  test("a confirmed + mapped login whose project is not registered → null (scope cannot be resolved, no widening)", async () => {
    const adapter = createTailscaleServeAdapter({
      lookupProject: () => undefined, // repo-alpha no longer registered
      confirmPeer: () => CONFIRMED,
      loadMapping: () => mapping(),
    });
    assert.equal(await adapter.verifyIdentity(requestWithForgedHeaders()), null);
  });

  test("a mapped project that resolves to ZERO member dirs → null (an empty scope grants nothing)", async () => {
    const adapter = createTailscaleServeAdapter({
      lookupProject: () => ({ key: "repo-alpha", projectDirs: [] }),
      confirmPeer: () => CONFIRMED,
      loadMapping: () => mapping(),
    });
    assert.equal(await adapter.verifyIdentity(requestWithForgedHeaders()), null);
  });
});
