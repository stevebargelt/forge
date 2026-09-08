// FG-784 (step 4) UNIT tier — spawns nothing, fetches nothing. Exercises the Cloudflare Access
// adapter's PURE decision logic through injected seams: a fake JWKS cache (getKeys /
// refreshForUnknownKid over a LOCALLY generated RS256 keypair), a fake access-state loader (the
// boot team/AUD), a real in-memory mapping built by buildIdentityMapping (FG-782 step 4), a fake
// project lookup, and a fixed injected clock. The real listener / real-file end-to-end path lives
// in cloudflare/server.integration.test.ts (step 5).
//
// Security focus — EVERY AC3 negative token case is proven to yield no data (null candidate), and
// no header value is ever trusted on its face: the Cf-Access-Jwt-Assertion header is only a
// candidate the verifier must cryptographically confirm.
//   * loopback peer + a valid, authorized Access JWT            → authorized (AC2, one project);
//   * missing token / expired / wrong-audience / wrong-issuer / invalid-signature / replayed
//     (exp-bound) / spoofed raw header                          → null (AC3);
//   * a non-loopback socket peer                                → null, WITHOUT touching the JWKS;
//   * absent team/AUD in access-state                           → null for EVERY request;
//   * an unmapped / edited-out email                            → null on the next request (AC6);
//   * an unknown kid triggers exactly ONE refresh then re-verify (rotation race);
//   * the produced candidate flows through the EXISTING validateAdapterIdentity to a single read
//     grant, and records cf-access-jwt-assertion as CONFIRMED, not ignored.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createSign, type JsonWebKey, type KeyObject } from "node:crypto";

import {
  createCloudflareAccessAdapter,
  deriveExpectedIssuer,
  CLOUDFLARE_ACCESS_ADAPTER_KIND,
  type AdapterProjectView,
  type CloudflareAccessAdapterDeps,
} from "./adapter.js";
import type { AccessStateRecord } from "./access-state.js";
import type { JwksCache, JwksKey } from "./jwks.js";
import { buildIdentityMapping, type IdentityMapping } from "../mapping.js";
import {
  validateAdapterIdentity,
  resolveRemoteIdentity,
  IGNORED_IDENTITY_HEADERS,
  type RemoteRequestContext,
} from "../identity.js";

// ── fixtures ────────────────────────────────────────────────────────────────────────────────────

const TEAM_DOMAIN = "team"; // RF-5: the team is a bare slug; the issuer is DERIVED from it.
const ISS = "https://team.cloudflareaccess.com";
const AUD = "aud-tag-deadbeef";
const EMAIL = "operator@example.com";
// A fixed injected clock: 2026-01-01T00:00:00Z. All token temporal claims are relative to this.
const NOW_MS = Date.UTC(2026, 0, 1, 0, 0, 0);
const NOW_S = Math.floor(NOW_MS / 1000);

const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const RSA_KID = "rsa-key-1";
const rsaPublicJwk: JwksKey = { ...rsa.publicKey.export({ format: "jwk" }), kid: RSA_KID };
const JWKS: JwksKey[] = [rsaPublicJwk];

// An unrelated keypair standing in for a forger who does not hold the team's private key.
const attacker = generateKeyPairSync("rsa", { modulusLength: 2048 });

function b64url(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/** Build and RS256-sign a JWT. Defaults produce a well-formed, currently-valid, authorized token
 *  keyed on RSA_KID and signed by the team private key. */
function signRs256(
  overrides: Record<string, unknown> = {},
  opts: { kid?: string | null; privateKey?: KeyObject } = {},
): string {
  const header: Record<string, unknown> = { alg: "RS256", typ: "JWT" };
  if (opts.kid !== null) header.kid = opts.kid ?? RSA_KID;
  const payload = {
    iss: ISS,
    aud: AUD,
    exp: NOW_S + 3600,
    nbf: NOW_S - 60,
    iat: NOW_S - 60,
    email: EMAIL,
    sub: "abc123",
    ...overrides,
  };
  const signingInput = `${b64url(header)}.${b64url(payload)}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(opts.privateKey ?? rsa.privateKey).toString("base64url");
  return `${signingInput}.${signature}`;
}

/** The Forge-owned boot config: team domain + AUD (the non-secret deployment facts). */
const ACCESS_STATE: AccessStateRecord = {
  version: 1,
  publicHostname: "board.example.com",
  accessTeamDomain: TEAM_DOMAIN,
  accessAud: AUD,
  loopbackPort: 4599,
  target: "http://127.0.0.1:4599",
  url: "https://board.example.com",
  cloudflaredConfigPath: "/tmp/forge/remote-board-cloudflared.yml",
};

/** The operator mapping: the verified email may read repo-alpha, read-only. Built through the
 *  real FG-782 validator so the test exercises the same fail-closed rules production does. */
function mapping(): IdentityMapping {
  return buildIdentityMapping({
    version: 1,
    identities: [{ login: EMAIL, project: "repo-alpha", capabilities: ["read"] }],
  });
}

/** A project registry that only knows repo-alpha and its own dirs. */
function lookupProject(key: string): AdapterProjectView | undefined {
  if (key === "repo-alpha") return { key: "repo-alpha", projectDirs: ["/work/alpha", "/work/alpha/sub"] };
  return undefined;
}

/** A fake JWKS cache over a mutable current key set. `refreshKeys` (if given) is what a
 *  refresh-on-unknown-kid installs; otherwise the current keys are returned unchanged. Records
 *  get / refresh call counts so a test can prove the amplification bound. */
function fakeJwksCache(
  initial: readonly JwksKey[],
  opts: { refreshKeys?: readonly JwksKey[] } = {},
): JwksCache & { getCalls: () => number; refreshCalls: () => number } {
  let current: readonly JwksKey[] = initial;
  let getCalls = 0;
  let refreshCalls = 0;
  return {
    // eslint-disable-next-line @typescript-eslint/require-await -- async is the cache contract seam
    async getKeys() {
      getCalls += 1;
      return current;
    },
    // eslint-disable-next-line @typescript-eslint/require-await -- async is the cache contract seam
    async refreshForUnknownKid(_kid: string) {
      refreshCalls += 1;
      if (opts.refreshKeys !== undefined) current = opts.refreshKeys;
      return current;
    },
    certsUrl: "https://team.cloudflareaccess.com/cdn-cgi/access/certs",
    getCalls: () => getCalls,
    refreshCalls: () => refreshCalls,
  };
}

/** Build the adapter with the happy-path seams, overridable per test. */
function adapterWith(overrides: Partial<CloudflareAccessAdapterDeps> = {}) {
  return createCloudflareAccessAdapter({
    lookupProject,
    jwksCache: fakeJwksCache(JWKS),
    loadAccessState: () => ACCESS_STATE,
    loadMapping: () => mapping(),
    now: () => NOW_MS,
    ...overrides,
  });
}

/** A tunnel-shaped request: the backend socket peer is the LOOPBACK cloudflared proxy, and it has
 *  forwarded the Access-minted Cf-Access-Jwt-Assertion token. */
function tunnelRequest(
  token: string | undefined,
  overrides: { socket?: string } = {},
): RemoteRequestContext {
  const headers: Record<string, string> = {};
  if (token !== undefined) headers["cf-access-jwt-assertion"] = token;
  return {
    headers,
    peer: { address: overrides.socket ?? "127.0.0.1", port: 54321 },
  };
}

// ── deriveExpectedIssuer (pure) ─────────────────────────────────────────────────────────────────

describe("deriveExpectedIssuer — a bare team SLUG → the exact expected JWT issuer origin (RF-5)", () => {
  test("a bare team slug expands to the canonical cloudflareaccess.com origin", () => {
    assert.equal(deriveExpectedIssuer("acme"), "https://acme.cloudflareaccess.com");
    assert.equal(deriveExpectedIssuer("my-team-1"), "https://my-team-1.cloudflareaccess.com");
  });
  test("RF-5: a dotted/host-shaped/scheme-bearing team value is REFUSED (never a configured issuer)", () => {
    // The whole point: a host an attacker controls must never become the trusted issuer/JWKS root.
    assert.equal(deriveExpectedIssuer("acme.cloudflareaccess.com"), null);
    assert.equal(deriveExpectedIssuer("evil.example.com"), null);
    assert.equal(deriveExpectedIssuer("https://acme.cloudflareaccess.com"), null);
    assert.equal(deriveExpectedIssuer("http://acme.cloudflareaccess.com"), null);
    assert.equal(deriveExpectedIssuer("acme.evil.com/cdn-cgi/access/certs"), null);
  });
  test("an empty/whitespace or otherwise non-label team value yields null (adapter then refuses)", () => {
    assert.equal(deriveExpectedIssuer(""), null);
    assert.equal(deriveExpectedIssuer("   "), null);
    assert.equal(deriveExpectedIssuer("-bad"), null);
    assert.equal(deriveExpectedIssuer("bad_underscore"), null);
  });
});

// ── happy path (AC2) ──────────────────────────────────────────────────────────────────────────

describe("createCloudflareAccessAdapter — a cryptographically valid, authorized token maps to ONE project", () => {
  test("exposes kind 'cloudflare-access'", () => {
    assert.equal(adapterWith().kind, CLOUDFLARE_ACCESS_ADAPTER_KIND);
  });

  test("a loopback tunnel request carrying a valid authorized JWT maps to ONLY its project + read (AC2)", async () => {
    const candidate = await adapterWith().verifyIdentity(tunnelRequest(signRs256()));
    assert.ok(candidate, "a verified + mapped identity yields a candidate");
    assert.equal(candidate.subject, EMAIL);
    assert.deepEqual([...candidate.capabilities], ["read"]);
    const scope = candidate.projectScope as { projectKey: string; memberDirs: readonly string[] };
    assert.equal(scope.projectKey, "repo-alpha");
    assert.deepEqual([...scope.memberDirs], ["/work/alpha", "/work/alpha/sub"]);
    assert.equal(candidate.provenance.adapter, CLOUDFLARE_ACCESS_ADAPTER_KIND);
    assert.equal(candidate.provenance.detail, "sub=abc123", "provenance carries only the non-secret sub");
  });

  test("the produced candidate flows through validateAdapterIdentity to a single read grant", async () => {
    const candidate = await adapterWith().verifyIdentity(tunnelRequest(signRs256()));
    assert.ok(candidate);
    const resolution = validateAdapterIdentity(candidate);
    assert.equal(resolution.ok, true);
    if (resolution.ok) {
      assert.equal(resolution.identity.subject, EMAIL);
      assert.equal(resolution.identity.projectScope.projectKey, "repo-alpha");
      assert.deepEqual([...resolution.identity.capabilities], ["read"]);
    }
  });

  test("cf-access-jwt-assertion is recorded as CONFIRMED, and moved OUT of ignored, through the resolver", async () => {
    // The header is one of IGNORED_IDENTITY_HEADERS; a successful resolution must move it into
    // confirmedIdentityHeaders so the audit trail says truthfully it was verified, not discarded.
    assert.ok(
      (IGNORED_IDENTITY_HEADERS as readonly string[]).includes("cf-access-jwt-assertion"),
      "cf-access-jwt-assertion is an ignored-by-default identity header",
    );
    const resolution = await resolveRemoteIdentity(tunnelRequest(signRs256()), adapterWith());
    assert.equal(resolution.ok, true);
    if (resolution.ok) {
      assert.deepEqual([...resolution.confirmedIdentityHeaders], ["cf-access-jwt-assertion"]);
      assert.ok(
        !resolution.ignoredIdentityHeaders.includes("cf-access-jwt-assertion"),
        "the confirmed header is NOT also reported as ignored",
      );
    }
  });
});

// ── AC3 negative token cases — each must fail CLOSED to no data ──────────────────────────────────

describe("createCloudflareAccessAdapter — every AC3 negative token case yields no data (null)", () => {
  test("AC3: a MISSING Cf-Access-Jwt-Assertion → null", async () => {
    assert.equal(await adapterWith().verifyIdentity(tunnelRequest(undefined)), null);
    assert.equal(await adapterWith().verifyIdentity(tunnelRequest("")), null);
  });

  test("AC3: an EXPIRED token (exp in the past, beyond tolerance) → null", async () => {
    const token = signRs256({ exp: NOW_S - 3600 });
    assert.equal(await adapterWith().verifyIdentity(tunnelRequest(token)), null);
  });

  test("AC3: a WRONG-AUDIENCE token → null", async () => {
    const token = signRs256({ aud: "some-other-app" });
    assert.equal(await adapterWith().verifyIdentity(tunnelRequest(token)), null);
  });

  test("AC3: a WRONG-ISSUER token → null", async () => {
    const token = signRs256({ iss: "https://evil.cloudflareaccess.com" });
    assert.equal(await adapterWith().verifyIdentity(tunnelRequest(token)), null);
  });

  test("AC3: an INVALID-SIGNATURE token (tampered signature) → null", async () => {
    const token = signRs256();
    const [h, p, sig] = token.split(".") as [string, string, string];
    // Flip a character in the MIDDLE of the signature so a real byte changes (flipping the LAST
    // char can land on padding bits base64url discards, leaving the bytes — and the verification —
    // unchanged).
    const mid = Math.floor(sig.length / 2);
    const swap = sig[mid] === "A" ? "B" : "A";
    const mutated = sig.slice(0, mid) + swap + sig.slice(mid + 1);
    assert.equal(await adapterWith().verifyIdentity(tunnelRequest(`${h}.${p}.${mutated}`)), null);
  });

  test("AC3: a SPOOFED raw header (a forger's self-signed token under the real kid) → null", async () => {
    // The attacker sets the header directly at loopback with a token they signed with THEIR key
    // but stamped with the team's kid, so key selection picks the real public key and the
    // signature fails. Header presence is never authentication.
    const forged = signRs256({ email: "attacker@evil.example", sub: "root" }, { privateKey: attacker.privateKey });
    assert.equal(await adapterWith().verifyIdentity(tunnelRequest(forged)), null);
  });

  test("AC3: REPLAY is exp/nbf-bound — a captured token replays ONLY within its validity window", async () => {
    // A token valid at NOW is accepted; the SAME captured token, replayed after it has expired,
    // is refused (exp-bound replay window — there is no jti ledger by design).
    const token = signRs256({ exp: NOW_S + 60 });
    assert.ok(
      await adapterWith().verifyIdentity(tunnelRequest(token)),
      "the token is accepted inside its window",
    );
    const laterAdapter = adapterWith({ now: () => NOW_MS + 2 * 3600 * 1000 }); // 2h later, past exp+tolerance
    assert.equal(
      await laterAdapter.verifyIdentity(tunnelRequest(token)),
      null,
      "the replayed token is refused once its exp window has passed",
    );
  });

  test("AC3: a not-yet-valid token (nbf in the future) → null", async () => {
    const token = signRs256({ nbf: NOW_S + 3600, iat: NOW_S + 3600 });
    assert.equal(await adapterWith().verifyIdentity(tunnelRequest(token)), null);
  });
});

// ── boundary / precondition refusals ────────────────────────────────────────────────────────────

describe("createCloudflareAccessAdapter — preconditions and boot config fail closed", () => {
  test("a NON-LOOPBACK socket peer → null WITHOUT ever consulting the JWKS (not via the tunnel)", async () => {
    const cache = fakeJwksCache(JWKS);
    const adapter = createCloudflareAccessAdapter({
      lookupProject,
      jwksCache: cache,
      loadAccessState: () => ACCESS_STATE,
      loadMapping: () => mapping(),
      now: () => NOW_MS,
    });
    const direct = tunnelRequest(signRs256(), { socket: "203.0.113.7" });
    assert.equal(await adapter.verifyIdentity(direct), null);
    assert.equal(cache.getCalls(), 0, "the loopback precondition refuses before any key lookup");
  });

  test("a request with NO socket peer → null without consulting the JWKS", async () => {
    const cache = fakeJwksCache(JWKS);
    const adapter = createCloudflareAccessAdapter({
      lookupProject,
      jwksCache: cache,
      loadAccessState: () => ACCESS_STATE,
      loadMapping: () => mapping(),
      now: () => NOW_MS,
    });
    const noPeer: RemoteRequestContext = { headers: { "cf-access-jwt-assertion": signRs256() } };
    assert.equal(await adapter.verifyIdentity(noPeer), null);
    assert.equal(cache.getCalls(), 0);
  });

  test("ABSENT access-state (no boot team/AUD) → null for EVERY request, even a perfectly valid token", async () => {
    const adapter = adapterWith({ loadAccessState: () => null });
    assert.equal(await adapter.verifyIdentity(tunnelRequest(signRs256())), null);
  });

  test("a MALFORMED team domain in access-state (no derivable issuer) → null", async () => {
    const bad: AccessStateRecord = { ...ACCESS_STATE, accessTeamDomain: "http://plaintext.example" };
    assert.equal(await adapterWith({ loadAccessState: () => bad }).verifyIdentity(tunnelRequest(signRs256())), null);
  });

  test("RF-5: a dotted/host-shaped team in access-state → null at boot (a configured host is never trusted)", async () => {
    for (const team of ["acme.cloudflareaccess.com", "evil.example.com", "https://evil.example.com"]) {
      const bad: AccessStateRecord = { ...ACCESS_STATE, accessTeamDomain: team };
      assert.equal(
        await adapterWith({ loadAccessState: () => bad }).verifyIdentity(tunnelRequest(signRs256())),
        null,
        `team ${team} must be refused at boot`,
      );
    }
  });

  test("an EMPTY AUD in access-state → null (never accept-any-audience)", async () => {
    const bad = { ...ACCESS_STATE, accessAud: "   " } as AccessStateRecord;
    assert.equal(await adapterWith({ loadAccessState: () => bad }).verifyIdentity(tunnelRequest(signRs256())), null);
  });
});

// ── authorization: live revocation via the mapping (AC6) ────────────────────────────────────────

describe("createCloudflareAccessAdapter — authorization is the mapping, re-read per request", () => {
  test("a verified but UNMAPPED email → null, no data (AC3)", async () => {
    const token = signRs256({ email: "stranger@example.com" });
    assert.equal(await adapterWith().verifyIdentity(tunnelRequest(token)), null);
  });

  test("a verified email whose entry is EDITED OUT of the mapping → null on the next request (AC6, live revocation)", async () => {
    const adapter = adapterWith({ loadMapping: () => buildIdentityMapping({ version: 1, identities: [] }) });
    assert.equal(await adapter.verifyIdentity(tunnelRequest(signRs256())), null);
  });

  test("a token with NO email claim → null (nothing to key the mapping on)", async () => {
    // Override email to undefined so the signed payload carries no email claim at all.
    const token = signRs256({ email: undefined });
    assert.equal(await adapterWith().verifyIdentity(tunnelRequest(token)), null);
  });

  test("a mapped project that is not registered → null (scope cannot be resolved, no widening)", async () => {
    const adapter = adapterWith({ lookupProject: () => undefined });
    assert.equal(await adapter.verifyIdentity(tunnelRequest(signRs256())), null);
  });

  test("a mapped project resolving to ZERO member dirs → null (an empty scope grants nothing)", async () => {
    const adapter = adapterWith({ lookupProject: () => ({ key: "repo-alpha", projectDirs: [] }) });
    assert.equal(await adapter.verifyIdentity(tunnelRequest(signRs256())), null);
  });
});

// ── JWKS rotation race: refresh-on-unknown-kid ──────────────────────────────────────────────────

describe("createCloudflareAccessAdapter — unknown kid triggers exactly one rate-bounded refresh", () => {
  test("a token whose kid is absent, then present after refresh, verifies with exactly ONE refresh", async () => {
    // The cache starts empty (as after a rotation the origin has not yet seen the new key), and a
    // refresh installs the real key set. The valid token then verifies — after ONE refresh.
    const cache = fakeJwksCache([], { refreshKeys: JWKS });
    const adapter = adapterWith({ jwksCache: cache });
    const candidate = await adapter.verifyIdentity(tunnelRequest(signRs256()));
    assert.ok(candidate, "after the refresh installs the rotated-in key, the token verifies");
    assert.equal(cache.refreshCalls(), 1, "exactly one refresh — the amplification bound holds");
  });

  test("a token whose kid stays unknown even after refresh → null (no endless retry)", async () => {
    // The cache is empty and refresh yields nothing (an unreachable rotation) — the token is
    // refused after a single refresh attempt, never accepted, never looped.
    const cache = fakeJwksCache([], { refreshKeys: [] });
    const adapter = adapterWith({ jwksCache: cache });
    assert.equal(await adapter.verifyIdentity(tunnelRequest(signRs256())), null);
    assert.equal(cache.refreshCalls(), 1, "one refresh attempt, then fail closed");
  });
});
