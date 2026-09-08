// FG-782 (step 6) UNIT tier — no spawned process, no daemon, no fs, no DB. Exercises the
// Tailscale Serve adapter's PURE decision logic through injected seams: a fake `confirmPeer`
// (stands in for whois against the local tailscaled), a real in-memory mapping built by
// buildIdentityMapping (step 4), and a fake project lookup. The real-spawn / real-file
// end-to-end path lives in adapter.integration.test.ts.
//
// RF-1 correction — Tailscale Serve proxies from the LOCAL node, so at the backend socket the
// connection peer is the loopback Serve proxy, NOT the tailnet caller. The adapter therefore:
//   * requires the socket peer to be LOOPBACK (a precondition — a request that did not arrive
//     through the local Serve proxy is refused);
//   * takes the Serve-set X-Forwarded-For as the tailnet-address HINT and whois-CONFIRMS it;
//   * requires the whois login to EQUAL the Serve-set Tailscale-User-Login (a forged login the
//     daemon contradicts is refused).
//
// Security focus — every negative shape yields no data (null candidate); no header value is ever
// trusted on its face:
//   * loopback peer + Serve-shaped headers + fake whois for the forwarded address → authorized;
//   * a forged Tailscale-User-Login that whois contradicts → null (AC3);
//   * a non-loopback socket peer → null (not via Serve);
//   * a missing / garbage X-Forwarded-For → null (AC3);
//   * whois-confirmed but UNMAPPED / REVOKED login → null (AC3/AC4);
//   * the produced candidate flows through the EXISTING validateAdapterIdentity to a single read
//     grant, and records the two Serve headers as confirmed-against-whois.

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

/** The tailnet address Serve records in X-Forwarded-For for steve's peer. */
const TAILNET_ADDR = "100.101.102.103";

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

/** A Serve-shaped request: the backend socket peer is the LOOPBACK Serve proxy, and Serve has
 *  set X-Forwarded-For (the tailnet address) and Tailscale-User-Login (the login it authed). */
function serveRequest(
  overrides: {
    socket?: string;
    forwardedFor?: string | undefined;
    login?: string | undefined;
  } = {},
): RemoteRequestContext {
  const headers: Record<string, string> = {};
  if (overrides.forwardedFor !== undefined) headers["x-forwarded-for"] = overrides.forwardedFor;
  if (overrides.login !== undefined) headers["tailscale-user-login"] = overrides.login;
  return {
    headers,
    peer: { address: overrides.socket ?? "127.0.0.1", port: 54321 },
  };
}

/** The canonical happy-path request: loopback socket, Serve headers naming steve's tailnet
 *  address and login. */
function goodServeRequest(): RemoteRequestContext {
  return serveRequest({ forwardedFor: TAILNET_ADDR, login: "steve@example.com" });
}

describe("createTailscaleServeAdapter — identity is whois-confirmed, authorization is the mapping", () => {
  test("exposes kind 'tailscale-serve'", () => {
    assert.equal(adapterWith(CONFIRMED).kind, TAILSCALE_SERVE_ADAPTER_KIND);
  });

  test("a loopback Serve request whose forwarded address whois-confirms maps to ONLY its project + read (AC3 positive)", async () => {
    const candidate = await adapterWith(CONFIRMED).verifyIdentity(goodServeRequest());
    assert.ok(candidate, "a confirmed + mapped identity yields a candidate");
    assert.equal(candidate.subject, "steve@example.com");
    assert.deepEqual([...candidate.capabilities], ["read"]);
    const scope = candidate.projectScope as { projectKey: string; memberDirs: readonly string[] };
    assert.equal(scope.projectKey, "repo-alpha");
    assert.deepEqual([...scope.memberDirs], ["/work/alpha", "/work/alpha/sub"]);
    assert.equal(candidate.provenance.adapter, TAILSCALE_SERVE_ADAPTER_KIND);
  });

  test("whois runs on the FORWARDED address, not the loopback socket peer", async () => {
    let confirmedFor: string | undefined;
    const adapter = adapterWith(CONFIRMED, {
      confirmPeer: (addr) => {
        confirmedFor = addr;
        return CONFIRMED;
      },
    });
    await adapter.verifyIdentity(goodServeRequest());
    assert.equal(confirmedFor, TAILNET_ADDR, "the tailnet caller is confirmed, never 127.0.0.1");
  });

  test("identity is the whois login, and the Serve headers are recorded as confirmed-against-whois", async () => {
    const candidate = await adapterWith(CONFIRMED).verifyIdentity(goodServeRequest());
    assert.ok(candidate);
    assert.equal(candidate.subject, "steve@example.com");
    assert.deepEqual(
      [...(candidate.confirmedIdentityHeaders ?? [])].sort(),
      ["tailscale-user-login", "x-forwarded-for"],
      "the two Serve headers are reported as confirmed inputs, not silently ignored",
    );
  });

  test("the produced candidate flows through validateAdapterIdentity to a single read grant", async () => {
    const candidate = await adapterWith(CONFIRMED).verifyIdentity(goodServeRequest());
    assert.ok(candidate);
    const resolution = validateAdapterIdentity(candidate);
    assert.equal(resolution.ok, true);
    if (resolution.ok) {
      assert.equal(resolution.identity.subject, "steve@example.com");
      assert.equal(resolution.identity.projectScope.projectKey, "repo-alpha");
      assert.deepEqual([...resolution.identity.capabilities], ["read"]);
      assert.deepEqual(
        [...resolution.confirmedIdentityHeaders].sort(),
        ["tailscale-user-login", "x-forwarded-for"],
      );
    }
  });
});

describe("createTailscaleServeAdapter — every unconfirmed / unauthorized shape yields no data (null)", () => {
  test("a non-loopback socket peer → null WITHOUT consulting the daemon (not via the local Serve proxy)", async () => {
    let called = false;
    const adapter = adapterWith(CONFIRMED, {
      confirmPeer: () => {
        called = true;
        return CONFIRMED;
      },
    });
    // The socket peer is the tailnet address itself (a direct connection), not the loopback proxy.
    const direct = serveRequest({ socket: TAILNET_ADDR, forwardedFor: TAILNET_ADDR, login: "steve@example.com" });
    assert.equal(await adapter.verifyIdentity(direct), null);
    assert.equal(called, false, "the loopback precondition refuses before any whois");
  });

  test("a request with NO socket peer → null without consulting the daemon", async () => {
    let called = false;
    const adapter = adapterWith(CONFIRMED, {
      confirmPeer: () => {
        called = true;
        return CONFIRMED;
      },
    });
    const noPeer: RemoteRequestContext = {
      headers: { "x-forwarded-for": TAILNET_ADDR, "tailscale-user-login": "steve@example.com" },
    };
    assert.equal(await adapter.verifyIdentity(noPeer), null);
    assert.equal(called, false);
  });

  test("a MISSING X-Forwarded-For → null without consulting the daemon (no tailnet address to confirm)", async () => {
    let called = false;
    const adapter = adapterWith(CONFIRMED, {
      confirmPeer: () => {
        called = true;
        return CONFIRMED;
      },
    });
    const noXff = serveRequest({ login: "steve@example.com" }); // loopback socket, but no XFF
    assert.equal(await adapter.verifyIdentity(noXff), null);
    assert.equal(called, false);
  });

  test("a GARBAGE X-Forwarded-For → null without handing junk to the daemon", async () => {
    let called = false;
    const adapter = adapterWith(CONFIRMED, {
      confirmPeer: () => {
        called = true;
        return CONFIRMED;
      },
    });
    const garbage = serveRequest({ forwardedFor: "not-an-ip", login: "steve@example.com" });
    assert.equal(await adapter.verifyIdentity(garbage), null);
    assert.equal(called, false, "a non-IP-shaped forwarded value never reaches the CLI");
  });

  test("a MISSING Tailscale-User-Login → null (nothing to hold whois against)", async () => {
    const noLogin = serveRequest({ forwardedFor: TAILNET_ADDR });
    assert.equal(await adapterWith(CONFIRMED).verifyIdentity(noLogin), null);
  });

  test("a FORGED Tailscale-User-Login the daemon contradicts → null, no data (AC3)", async () => {
    // whois confirms steve for the forwarded address, but the request claims to be the attacker.
    const forged = serveRequest({ forwardedFor: TAILNET_ADDR, login: "attacker@evil.example" });
    assert.equal(await adapterWith(CONFIRMED).verifyIdentity(forged), null);
  });

  test("a Tailscale-User-Login matching whois only after case/space normalization is accepted", async () => {
    const messy = serveRequest({ forwardedFor: TAILNET_ADDR, login: "  Steve@Example.com  " });
    const candidate = await adapterWith(CONFIRMED).verifyIdentity(messy);
    assert.ok(candidate, "case/whitespace differences never cause a false mismatch");
    assert.equal(candidate.subject, "steve@example.com");
  });

  test("the daemon cannot confirm the forwarded address → null, no data (AC3)", async () => {
    assert.equal(await adapterWith(null).verifyIdentity(goodServeRequest()), null);
  });

  test("a whois-confirmed but UNMAPPED login → null, no data (AC3)", async () => {
    // whois confirms 'stranger' and the request's login claim matches whois — but the operator
    // never mapped that login.
    const stranger: TailscaleWhois = { login: "stranger@example.com" };
    const req = serveRequest({ forwardedFor: TAILNET_ADDR, login: "stranger@example.com" });
    assert.equal(await adapterWith(stranger).verifyIdentity(req), null);
  });

  test("a whois-confirmed login whose entry was REVOKED (removed from the mapping) → null on the next call (AC4)", async () => {
    const adapter = createTailscaleServeAdapter({
      lookupProject,
      confirmPeer: () => CONFIRMED,
      loadMapping: () => buildIdentityMapping({ version: 1, identities: [] }),
    });
    assert.equal(await adapter.verifyIdentity(goodServeRequest()), null);
  });

  test("a confirmed + mapped login whose project is not registered → null (scope cannot be resolved, no widening)", async () => {
    const adapter = createTailscaleServeAdapter({
      lookupProject: () => undefined, // repo-alpha no longer registered
      confirmPeer: () => CONFIRMED,
      loadMapping: () => mapping(),
    });
    assert.equal(await adapter.verifyIdentity(goodServeRequest()), null);
  });

  test("a mapped project that resolves to ZERO member dirs → null (an empty scope grants nothing)", async () => {
    const adapter = createTailscaleServeAdapter({
      lookupProject: () => ({ key: "repo-alpha", projectDirs: [] }),
      confirmPeer: () => CONFIRMED,
      loadMapping: () => mapping(),
    });
    assert.equal(await adapter.verifyIdentity(goodServeRequest()), null);
  });
});
