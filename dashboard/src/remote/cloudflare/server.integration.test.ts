// FG-784 (step 5) INTEGRATION tier — a REAL loopback listener, booted through the SAME hook
// production uses (maybeStartRemoteBoardFromEnv → resolveRemoteConfig → selectRemoteAdapter).
// It spawns no process and touches no network: a locally-generated RS256 keypair signs the
// tokens, a fake JWKS cache holds the matching public key, and a fake access-state + mapping are
// injected through the `transportDeps` seam — exactly the seam FG-782's tailscale integration
// test drives, now carrying the Cloudflare boot deps.
//
// Proves, end to end over a bound 127.0.0.1 listener with FORGE_DASHBOARD_REMOTE_TRANSPORT=cloudflare:
//   * a cryptographically valid, authorized Access token reaches ONLY its granted project's
//     read-only board (NOT the no-adapter 401) — AC2;
//   * EVERY AC3 negative token (missing / expired / wrong-audience / wrong-issuer /
//     invalid-signature / not-yet-valid / replayed-past-exp / spoofed-forged) returns the
//     `unauthorized` envelope with board:null — AC3;
//   * booted with NO trusted team/AUD (access-state absent), even a perfect token is refused on
//     EVERY request — the adapter never degrades to accept-any-issuer/audience;
//   * the bind stays loopback-only regardless of the transport selected — AC2.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createSign, type KeyObject } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { maybeStartRemoteBoardFromEnv } from "../server.js";
import type { ProjectRecord } from "../../queries.js";
import { buildIdentityMapping, type IdentityMapping } from "../mapping.js";
import type { AccessStateRecord } from "./access-state.js";
import type { JwksCache, JwksKey } from "./jwks.js";

// ── fixtures ─────────────────────────────────────────────────────────────────────────────────────

const TEAM_DOMAIN = "team.cloudflareaccess.com";
const ISS = "https://team.cloudflareaccess.com";
const AUD = "aud-tag-deadbeef";
const EMAIL = "operator@example.com";
const NOW_MS = Date.UTC(2026, 0, 1, 0, 0, 0);
const NOW_S = Math.floor(NOW_MS / 1000);
const KID = "rsa-key-1";

const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicJwk: JwksKey = { ...rsa.publicKey.export({ format: "jwk" }), kid: KID };
const attacker = generateKeyPairSync("rsa", { modulusLength: 2048 });

const PROJECT_DIR = "/home/steve/checkouts/cf-project";

function b64url(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/** Build and RS256-sign a JWT. Defaults produce a well-formed, currently-valid, authorized token
 *  keyed on KID and signed by the team private key. */
function signRs256(
  overrides: Record<string, unknown> = {},
  opts: { kid?: string | null; privateKey?: KeyObject } = {},
): string {
  const header: Record<string, unknown> = { alg: "RS256", typ: "JWT" };
  if (opts.kid !== null) header.kid = opts.kid ?? KID;
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
  return `${signingInput}.${signer.sign(opts.privateKey ?? rsa.privateKey).toString("base64url")}`;
}

const ACCESS_STATE: AccessStateRecord = {
  version: 1,
  publicHostname: "board.example.com",
  accessTeamDomain: TEAM_DOMAIN,
  accessAud: AUD,
  loopbackPort: 8025,
  target: "http://127.0.0.1:8025",
  url: "https://board.example.com",
  cloudflaredConfigPath: "/tmp/forge/remote-board-cloudflared.yml",
};

/** A fake JWKS cache over the fixed team key — no fetch, no clock. */
function fakeJwksCache(keys: readonly JwksKey[]): JwksCache {
  return {
    getKeys: () => Promise.resolve(keys),
    refreshForUnknownKid: () => Promise.resolve(keys),
    certsUrl: "https://team.cloudflareaccess.com/cdn-cgi/access/certs",
  };
}

/** The operator mapping: the verified email may read repo-cf, read-only. */
const mapping: IdentityMapping = buildIdentityMapping({
  version: 1,
  identities: [{ login: EMAIL, project: "repo-cf", capabilities: ["read"] }],
});

function projectCf(): ProjectRecord {
  return {
    key: "repo-cf",
    label: "CF",
    color: "#123456",
    description: null,
    projectDir: PROJECT_DIR,
    primaryCheckout: PROJECT_DIR,
    projectDirs: [PROJECT_DIR],
    checkouts: [],
    lastRunAt: null,
    runCount: 0,
    inFlightCount: 0,
    liveSessions: 0,
  } as unknown as ProjectRecord;
}

/** cloudflared proxies from the LOCAL host, so a legitimate tunnel request always arrives on
 *  loopback carrying the Access-minted token as this header. */
function tokenHeaders(token: string): Record<string, string> {
  return { "cf-access-jwt-assertion": token };
}

// ── boot helpers ─────────────────────────────────────────────────────────────────────────────────

const opened: Server[] = [];
after(() => {
  for (const s of opened) {
    s.closeAllConnections?.();
    s.close();
  }
});

function waitListening(srv: Server): Promise<AddressInfo> {
  return new Promise((resolve, reject) => {
    if (srv.listening) return resolve(srv.address() as AddressInfo);
    srv.once("listening", () => resolve(srv.address() as AddressInfo));
    srv.once("error", reject);
  });
}

/** Boot the remote board with the cloudflare transport and the given injected access-state loader
 *  (null → no trusted team/AUD). A fresh keypair-backed JWKS cache, the fake mapping, and the
 *  fixed clock are threaded through the real selectRemoteAdapter path. */
async function bootCloudflare(loadAccessState: () => AccessStateRecord | null): Promise<AddressInfo> {
  const srv = maybeStartRemoteBoardFromEnv(
    {
      FORGE_DASHBOARD_REMOTE: "1",
      FORGE_DASHBOARD_REMOTE_PORT: "0",
      FORGE_DASHBOARD_REMOTE_TRANSPORT: "cloudflare",
    } as unknown as NodeJS.ProcessEnv,
    {
      lookupProject: (key) => (key === "repo-cf" ? projectCf() : undefined),
      transportDeps: {
        jwksCache: fakeJwksCache([publicJwk]),
        loadAccessState,
        loadMapping: () => mapping,
        now: () => NOW_MS,
      },
    },
  );
  assert.ok(srv, "with remote mode on and transport=cloudflare, the boot hook started the listener");
  opened.push(srv!);
  return waitListening(srv!);
}

// ── AC2: a valid authorized token reaches only its project (over a real loopback listener) ─────────

test("AC2: transport='cloudflare' + a valid authorized JWT reaches ONLY its project's board", async () => {
  const addr = await bootCloudflare(() => ACCESS_STATE);
  assert.match(addr.address, /^(127\.|::1$)/, "even with the cloudflare transport selected, the bind stays loopback-only (AC2)");

  const res = await fetch(`http://127.0.0.1:${addr.port}/api/board`, { headers: tokenHeaders(signRs256()) });
  assert.notEqual(res.status, 401, "a cryptographically verified, mapped identity is NOT the no-adapter refusal");
  const body = await res.json();
  assert.notEqual(body.state, "unauthorized", "an authorized Access identity is not refused");
  if (body.state === "live" || body.state === "stale") {
    assert.equal(body.board.projectSummary.projectKey, "repo-cf", "it gets ONLY its granted project, server-authoritatively");
  }
});

// ── AC3: every negative token case is the unauthorized envelope (board:null) ───────────────────────

test("AC3: every negative token returns the unauthorized envelope with NO project data", async () => {
  const addr = await bootCloudflare(() => ACCESS_STATE);
  const base = `http://127.0.0.1:${addr.port}/api/board`;

  const [h, p, sig] = signRs256().split(".") as [string, string, string];
  const midIdx = Math.floor(sig.length / 2);
  const tamperedSig = sig.slice(0, midIdx) + (sig[midIdx] === "A" ? "B" : "A") + sig.slice(midIdx + 1);

  const cases: Array<{ name: string; init?: RequestInit }> = [
    { name: "missing token", init: undefined },
    { name: "expired", init: { headers: tokenHeaders(signRs256({ exp: NOW_S - 3600 })) } },
    { name: "wrong audience", init: { headers: tokenHeaders(signRs256({ aud: "some-other-app" })) } },
    { name: "wrong issuer", init: { headers: tokenHeaders(signRs256({ iss: "https://evil.cloudflareaccess.com" })) } },
    { name: "invalid signature", init: { headers: tokenHeaders(`${h}.${p}.${tamperedSig}`) } },
    { name: "not yet valid (nbf future)", init: { headers: tokenHeaders(signRs256({ nbf: NOW_S + 3600, iat: NOW_S + 3600 })) } },
    { name: "spoofed forged (attacker key)", init: { headers: tokenHeaders(signRs256({ email: "attacker@evil.example" }, { privateKey: attacker.privateKey })) } },
    { name: "unmapped email", init: { headers: tokenHeaders(signRs256({ email: "stranger@example.com" })) } },
  ];

  for (const c of cases) {
    const res = await fetch(base, c.init);
    assert.equal(res.status, 401, `${c.name}: fails closed at the HTTP layer`);
    const body = await res.json();
    assert.equal(body.state, "unauthorized", `${c.name}: the five-state envelope reports the refusal`);
    assert.equal(body.board, null, `${c.name}: a refusal carries NO project data`);
  }
});

test("AC3: replay is exp-bound — a captured token is refused once its exp window has passed", async () => {
  // Boot at NOW; then present a token that expired well before NOW — the same shape a captured,
  // replayed token has after its window closes. There is no jti ledger by design; exp/nbf bounds it.
  const addr = await bootCloudflare(() => ACCESS_STATE);
  const stale = signRs256({ exp: NOW_S - 7200, nbf: NOW_S - 10800, iat: NOW_S - 10800 });
  const res = await fetch(`http://127.0.0.1:${addr.port}/api/board`, { headers: tokenHeaders(stale) });
  assert.equal(res.status, 401, "a replayed token past its exp window is refused");
  assert.equal((await res.json()).board, null, "no project data on a replayed-past-exp token");
});

// ── boot with NO trusted team/AUD → refuse every request (never accept-any) ────────────────────────

test("boot with access-state absent (no team/AUD) refuses EVERY request, even a perfect token", async () => {
  const addr = await bootCloudflare(() => null);
  assert.match(addr.address, /^(127\.|::1$)/, "the listener still binds loopback-only");

  const res = await fetch(`http://127.0.0.1:${addr.port}/api/board`, { headers: tokenHeaders(signRs256()) });
  assert.equal(res.status, 401, "no trusted team/AUD → the adapter refuses (never accept-any-issuer/audience)");
  const body = await res.json();
  assert.equal(body.state, "unauthorized", "the envelope reports the refusal");
  assert.equal(body.board, null, "no project data without a trusted boot config");

  // A bare request (no token) is also refused — the fail-closed default is unchanged.
  const bare = await fetch(`http://127.0.0.1:${addr.port}/api/board`);
  assert.equal(bare.status, 401, "no token → refused");
});
