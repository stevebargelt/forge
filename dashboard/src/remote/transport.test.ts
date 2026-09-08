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

import { generateKeyPairSync, createSign, type KeyObject } from "node:crypto";

import { selectRemoteAdapter, TAILSCALE_TRANSPORT, CLOUDFLARE_TRANSPORT, type RemoteTransportDeps } from "./transport.js";
import { TAILSCALE_SERVE_ADAPTER_KIND, type TailscaleServeAdapterDeps } from "./tailscale/adapter.js";
import { CLOUDFLARE_ACCESS_ADAPTER_KIND } from "./cloudflare/adapter.js";
import { buildIdentityMapping, type IdentityMapping } from "./mapping.js";
import type { AccessStateRecord } from "./cloudflare/access-state.js";
import type { JwksCache, JwksKey } from "./cloudflare/jwks.js";
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
  for (const token of [null, undefined, "", "  ", "tailscal", "TAILSCALE", "cloudflare-access", "funnel", "1"]) {
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
  // A Serve-shaped request: loopback socket, X-Forwarded-For = alice's tailnet address (the fake
  // daemon confirms it), Tailscale-User-Login = the login it authed (equals the whois answer).
  const candidate = await adapter!.verifyIdentity({
    headers: { "x-forwarded-for": "100.64.0.1", "tailscale-user-login": "alice@example.com" },
    peer: { address: "127.0.0.1", port: 41000 },
  });
  assert.ok(candidate, "a whois-confirmed, mapped peer yields a candidate");
  assert.equal(candidate!.subject, "alice@example.com", "identity is the whois login for the forwarded address");
  assert.deepEqual(candidate!.projectScope, { projectKey: "repo-alpha", memberDirs: ["/work/alpha"] });
});

test("the selected adapter fails closed for an unconfirmable forwarded address (no whois)", async () => {
  const adapter = selectRemoteAdapter(TAILSCALE_TRANSPORT, pureDeps());
  assert.ok(adapter);
  // Loopback socket + a Serve-set X-Forwarded-For the fake daemon does NOT confirm; the login
  // header is never trusted on its face.
  const candidate = await adapter!.verifyIdentity({
    headers: { "x-forwarded-for": "203.0.113.9", "tailscale-user-login": "alice@example.com" },
    peer: { address: "127.0.0.1", port: 41000 },
  });
  assert.equal(candidate, null, "no whois-confirmed forwarded address → no candidate, no data (AC3)");
});

// ─── FG-784: the 'cloudflare' case selects the Cloudflare Access adapter ─────────────────────────
// UNIT tier — node:crypto generates a local RS256 keypair (pure; no spawn, no network) and a fake
// JWKS cache / access-state / mapping drive the SAME selectRemoteAdapter path production uses.

const CF_TEAM = "team"; // RF-5: a bare team slug; the issuer is DERIVED as <slug>.cloudflareaccess.com
const CF_ISS = "https://team.cloudflareaccess.com";
const CF_AUD = "aud-tag-1234";
const CF_EMAIL = "cf-operator@example.com";
const CF_NOW_MS = Date.UTC(2026, 0, 1, 0, 0, 0);
const CF_NOW_S = Math.floor(CF_NOW_MS / 1000);
const CF_KID = "rsa-key-1";

const cfKeypair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const cfPublicJwk: JwksKey = { ...cfKeypair.publicKey.export({ format: "jwk" }), kid: CF_KID };

function cfB64url(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function cfSignRs256(overrides: Record<string, unknown> = {}, privateKey: KeyObject = cfKeypair.privateKey): string {
  const header = { alg: "RS256", typ: "JWT", kid: CF_KID };
  const payload = {
    iss: CF_ISS,
    aud: CF_AUD,
    exp: CF_NOW_S + 3600,
    nbf: CF_NOW_S - 60,
    iat: CF_NOW_S - 60,
    email: CF_EMAIL,
    sub: "cf-sub-1",
    ...overrides,
  };
  const signingInput = `${cfB64url(header)}.${cfB64url(payload)}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  return `${signingInput}.${signer.sign(privateKey).toString("base64url")}`;
}

const CF_ACCESS_STATE: AccessStateRecord = {
  version: 1,
  publicHostname: "board.example.com",
  accessTeamDomain: CF_TEAM,
  accessAud: CF_AUD,
  loopbackPort: 8025,
  target: "http://127.0.0.1:8025",
  url: "https://board.example.com",
  cloudflaredConfigPath: "/tmp/forge/remote-board-cloudflared.yml",
};

/** A fake JWKS cache over a fixed key set — no fetch, no clock. */
function cfFakeJwksCache(keys: readonly JwksKey[]): JwksCache {
  return {
    getKeys: () => Promise.resolve(keys),
    refreshForUnknownKid: () => Promise.resolve(keys),
    certsUrl: "https://team.cloudflareaccess.com/cdn-cgi/access/certs",
  };
}

/** A fully-injected set of Cloudflare boot deps: fake JWKS cache, fake access-state (the boot
 *  team/AUD), a fake mapping authorizing exactly CF_EMAIL for one project, and a fixed clock. */
function cfDeps(): RemoteTransportDeps {
  const mapping: IdentityMapping = buildIdentityMapping({
    version: 1,
    identities: [{ login: CF_EMAIL, project: "repo-alpha", capabilities: ["read"] }],
  });
  return {
    lookupProject: (key) => (key === "repo-alpha" ? { key: "repo-alpha", projectDirs: ["/work/alpha"] } : undefined),
    jwksCache: cfFakeJwksCache([cfPublicJwk]),
    loadAccessState: () => CF_ACCESS_STATE,
    loadMapping: () => mapping,
    now: () => CF_NOW_MS,
  };
}

test("'cloudflare' → an adapter whose kind is 'cloudflare-access'", () => {
  const adapter = selectRemoteAdapter(CLOUDFLARE_TRANSPORT, cfDeps());
  assert.ok(adapter, "the recognised token selects an adapter");
  assert.equal(adapter!.kind, CLOUDFLARE_ACCESS_ADAPTER_KIND);
});

test("the selected cloudflare adapter is wired to the injected deps: valid authorized JWT → candidate", async () => {
  const adapter = selectRemoteAdapter(CLOUDFLARE_TRANSPORT, cfDeps());
  assert.ok(adapter);
  // A tunnel-shaped request: loopback socket peer (cloudflared proxies locally) carrying the
  // Access-minted Cf-Access-Jwt-Assertion the fake JWKS cache verifies.
  const candidate = await adapter!.verifyIdentity({
    headers: { "cf-access-jwt-assertion": cfSignRs256() },
    peer: { address: "127.0.0.1", port: 54321 },
  });
  assert.ok(candidate, "a cryptographically verified, mapped identity yields a candidate");
  assert.equal(candidate!.subject, CF_EMAIL, "identity is the verified email claim");
  assert.deepEqual(candidate!.projectScope, { projectKey: "repo-alpha", memberDirs: ["/work/alpha"] });
});

test("the selected cloudflare adapter fails closed for a forged (attacker-signed) token", async () => {
  const attacker = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const adapter = selectRemoteAdapter(CLOUDFLARE_TRANSPORT, cfDeps());
  assert.ok(adapter);
  // A token stamped with the team kid but signed by the attacker's key: signature fails (AC3).
  const forged = cfSignRs256({ email: "attacker@evil.example" }, attacker.privateKey);
  const candidate = await adapter!.verifyIdentity({
    headers: { "cf-access-jwt-assertion": forged },
    peer: { address: "127.0.0.1", port: 54321 },
  });
  assert.equal(candidate, null, "a forged token fails cryptographic verification → no candidate, no data (AC3)");
});
