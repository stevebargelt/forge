// FG-784 (step 4): the Cloudflare Access TransportAdapter.
//
// THREAT MODEL. This adapter is where the Cloudflare Access boundary meets Forge's
// transport-neutral identity contract — and it is deliberately the ONLY place they meet.
// cloudflared runs on the operator's host, terminates the Access edge, and PROXIES the request
// to the loopback origin, forwarding the Access-minted `Cf-Access-Jwt-Assertion` token as a
// header. As identity.ts warns, that header's PRESENCE is never authentication: a direct caller
// to 127.0.0.1 can set the same header with a forged token. This adapter answers all of that
// structurally, each step failing CLOSED to `null` (no data) before the next is reached:
//
//   (1) LOOPBACK PRECONDITION (defense in depth). cloudflared proxies from the LOCAL host, so a
//       legitimate Access-fronted request always arrives on 127.0.0.1 / ::1. Identity rides the
//       JWT, not the socket, so this is not the identity check — but a non-loopback socket peer
//       never came through the local tunnel and is refused before any token is even read.
//   (2) TOKEN AS CANDIDATE ONLY. The `Cf-Access-Jwt-Assertion` header VALUE is read as a
//       candidate to be cryptographically confirmed — never trusted on its face. A raw header
//       carrying a forged token reaches verification and fails there (AC3, spoofed header).
//   (3) BOOT CONFIG OR REFUSE. The expected issuer (derived from the Access team domain) and the
//       expected audience (the Access application AUD tag) come from the Forge-owned access-state
//       (step 3), re-read per request. Absent team/AUD → REFUSE every request. There is no
//       accept-any-issuer / accept-any-audience degradation (architect risk 3). Re-reading per
//       request also means `forge remote cloudflare disable` (which removes the access-state
//       file) stops the adapter authenticating anyone on the very next request.
//   (4) CRYPTOGRAPHIC VERIFICATION. The token is verified by the PURE step-1 verifier against the
//       step-2 JWKS cache: signature (RS256 default / ES256 opt-in, alg allowlist, no HS*/none),
//       issuer, audience, and exp/nbf/iat. Replay is EXP/NBF-BOUND by design — a captured token
//       replays only within its own validity window; there is no jti ledger (architect
//       constraint). An `unknown-kid` result (a rotation race) triggers exactly ONE rate-bounded
//       JWKS refresh and a single re-verify; anything but `ok` after that → refuse.
//   (5) AUTHORIZATION FROM THE MAPPING. The verified email is mapped through the SAME operator
//       mapping file the Tailscale adapter uses (step FG-782/mapping.ts), keyed on the existing
//       `login` selector — Cloudflare gains NO separate vocabulary (AC5). The file is re-read per
//       request so an operator's mapping edit revokes access on the next request (AC6, live
//       revocation). An unmapped / edited-out email → refuse.
//   (6) SERVER-AUTHORITATIVE SCOPE. The granted project's OWN member dirs are resolved through an
//       injected lookup — never invented or widened. The candidate then flows through the EXISTING
//       `validateAdapterIdentity` path (single-grant + closed-capability checks); the adapter does
//       NOT re-validate.
//
// The identity oracle (the cryptographically verified JWT) and the authorization oracle (the
// operator mapping) are never merged: the token says WHO the browser is; the mapping says WHAT
// that who may read. Both must agree, per request, or the request refuses.
//
// STATELESSNESS. This adapter mints NO Forge session and sets NO cookie: the browser already
// carries the Access `CF_Authorization` cookie, and Forge holds no session state that outlives
// the Access token. Revocation is therefore bounded by the token lifetime (AC6, documented) plus
// the live mapping re-read. It NEVER logs the JWT or the CF_Authorization cookie — the `detail`
// on provenance carries only the non-secret Access subject id, never token bytes.
//
// AUDIT TRAIL. The one header this adapter consults and cryptographically confirms
// (`cf-access-jwt-assertion`) is reported back as `confirmedIdentityHeaders`, so the resolution
// records truthfully that it was VERIFIED, not silently ignored.

import {
  type AdapterCandidateIdentity,
  type RemoteRequestContext,
  type TransportAdapter,
} from "../identity.js";
import { loadIdentityMapping, type IdentityMapping } from "../mapping.js";
import { readAccessState, type AccessStateRecord } from "./access-state.js";
import type { JsonWebKey } from "node:crypto";
import type { JwksCache } from "./jwks.js";
import { verifyAccessJwt, type SupportedJwtAlgorithm } from "./jwt.js";

/** The provenance token stamped on every identity this adapter produces. Names the out-of-band
 *  channel that proved the principal (Cloudflare Access's cryptographically verified JWT), NEVER
 *  a raw header source. */
export const CLOUDFLARE_ACCESS_ADAPTER_KIND = "cloudflare-access";

/** The one header this adapter CONSULTS and then cryptographically confirms. Reported as
 *  `confirmedIdentityHeaders` on a successful resolution so the audit trail records that its value
 *  was verified against the team JWKS, not trusted on its face. Lower-cased to match Node's
 *  normalized header keys — and it is deliberately one of identity.ts's IGNORED_IDENTITY_HEADERS,
 *  which the resolver moves OUT of the ignored set once this adapter confirms it. */
const CF_ACCESS_JWT_HEADER = "cf-access-jwt-assertion";

/** Is the backend socket peer a loopback address? cloudflared proxies from the LOCAL host, so a
 *  legitimate tunnel-fronted request always arrives on 127.0.0.1 / ::1 (or the IPv4-mapped form).
 *  A non-loopback socket peer means the request did NOT come through the local tunnel — refuse it
 *  before any token is read. Mirrors the Tailscale adapter's precondition. */
function isLoopbackPeer(addr: string | undefined): boolean {
  if (typeof addr !== "string") return false;
  const v = addr.trim().toLowerCase();
  if (v === "::1") return true;
  const bare = v.startsWith("::ffff:") ? v.slice("::ffff:".length) : v;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare);
}

/** Read one string value for a header Node may deliver as a string or a string[]. */
function headerValue(v: string | string[] | undefined): string | undefined {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v[0];
  return undefined;
}

/** A bare Cloudflare Access team SLUG: a single RFC-1123 label — lowercase alphanumerics and
 *  hyphens, no dots, no scheme, 1–63 chars, not hyphen-bordered. This is the ONLY accepted team
 *  form (RF-5): the issuer and JWKS authority are DERIVED from it as `<slug>.cloudflareaccess.com`,
 *  never taken from an operator-supplied hostname, so a configured attacker-controlled HTTPS host
 *  can never become the trusted issuer/JWKS root. */
const TEAM_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** True iff `team` is a bare Access team slug (see {@link TEAM_SLUG_RE}). Anything dotted,
 *  host-shaped, scheme-bearing, or otherwise not a single DNS label is rejected. */
export function isBareTeamSlug(team: string): boolean {
  return TEAM_SLUG_RE.test((team ?? "").trim());
}

/**
 * Derive the exact JWT issuer the token must carry from the recorded Access team SLUG. Cloudflare
 * Access issues tokens with `iss = https://<slug>.cloudflareaccess.com` — the team ORIGIN, no path,
 * no trailing slash. The team MUST be a bare slug (RF-5): a dotted/host-shaped/scheme-bearing value
 * yields `null` so the adapter refuses (fail closed) rather than letting a configured hostname
 * become the trusted issuer. The issuer is ALWAYS the derived cloudflareaccess.com origin.
 */
export function deriveExpectedIssuer(teamDomain: string): string | null {
  const raw = (teamDomain ?? "").trim();
  if (!isBareTeamSlug(raw)) return null;
  return `https://${raw}.cloudflareaccess.com`;
}

/**
 * The minimal project projection the adapter needs to name a server-authoritative scope: the
 * granted project's key and its OWN member dirs. Injected (not imported from the dashboard
 * registry) so the adapter stays a pure decision unit and unit tests supply a fake without a DB.
 * Identical to the Tailscale adapter's shape — this is the transport-neutral scope seam.
 */
export interface AdapterProjectView {
  readonly key: string;
  readonly projectDirs: readonly string[];
}

/**
 * Injectable seams for the adapter. Every default is the fail-closed production wiring; unit tests
 * override `jwksCache`, `loadAccessState`, `loadMapping`, and `now` with pure fakes (no process,
 * no fs, no fetch, no wall clock).
 */
export interface CloudflareAccessAdapterDeps {
  /** Resolve a granted project key to its OWN member dirs, or undefined if it is not a registered
   *  project. REQUIRED — there is no safe default that could invent a scope. */
  readonly lookupProject: (projectKey: string) => AdapterProjectView | undefined;
  /** The team's JWKS cache (step 2): supplies the current signing keys and a rate-bounded
   *  refresh-on-unknown-kid. REQUIRED — built at boot for the access-state's team domain. Fails
   *  closed (yields no keys) when it cannot prove it holds current keys. */
  readonly jwksCache: JwksCache;
  /** Load the Forge-owned access-state (step 3) for the boot config: team domain + AUD. Default:
   *  {@link readAccessState}, which re-reads the file on EVERY call (fail-closed to null), so a
   *  removed access-state (`disable`) refuses every request on the next call. */
  readonly loadAccessState?: (env?: NodeJS.ProcessEnv) => AccessStateRecord | null;
  /** Load the operator identity→authorization mapping. Default: {@link loadIdentityMapping}, which
   *  re-reads the file on EVERY call so a mapping-edit revocation is live (AC6). */
  readonly loadMapping?: (env?: NodeJS.ProcessEnv) => IdentityMapping;
  /** Injected clock (epoch MILLISECONDS). Default: `Date.now`. The only wall-clock read; passed to
   *  the pure verifier so tests are deterministic. */
  readonly now?: () => number;
  /** Env map the default `loadAccessState` / `loadMapping` resolve FORGE_HOME from. Default:
   *  `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** The signature algorithms to accept. Defaults to the verifier's RS256-only allowlist; ES256
   *  must be opted in explicitly. Never widens past the asymmetric allowlist. */
  readonly allowedAlgorithms?: readonly SupportedJwtAlgorithm[];
  /** Clock-skew tolerance in SECONDS applied to exp/nbf/iat by the verifier. Omitted here, so the
   *  verifier's own small default (5s, bounded — see DEFAULT/MAX_CLOCK_TOLERANCE_SECONDS) governs;
   *  a caller may only narrow it, never widen exp acceptance past the verifier's hard bound. */
  readonly clockToleranceSeconds?: number;
}

/**
 * Build the Cloudflare Access transport adapter. Its `verifyIdentity` is async: the JWKS cache
 * may perform a (rate-bounded) outbound refresh on an unknown kid, which is inherently async, and
 * the resolver awaits it on the single async path (there is no parallel sync branch that could
 * fail open).
 *
 * Decision order (every step fails CLOSED to null — no data — before the next):
 *   1. the backend SOCKET peer is not loopback                          → null (not via the tunnel)
 *   2. no `Cf-Access-Jwt-Assertion` header value                        → null (AC3 missing token)
 *   3. no trusted team/AUD in access-state (or a malformed team domain) → null (never accept-any)
 *   4. the JWT does not cryptographically verify (one refresh on kid)   → null (AC3)
 *   5. the verified email is not in the operator mapping (unmapped/revoked) → null (AC3/AC6)
 *   6. the mapped projectKey is not a registered project (or has no dirs)   → null (no widening)
 * Only a request that clears all six yields a candidate — and even then the resolver's
 * `validateAdapterIdentity` must still accept it (single non-empty grant + closed capability
 * vocabulary). No header value is EVER trusted on its face: the token is cryptographically
 * confirmed, and only its verified claims name the principal.
 */
export function createCloudflareAccessAdapter(
  deps: CloudflareAccessAdapterDeps,
): TransportAdapter {
  const lookupProject = deps.lookupProject;
  const jwksCache = deps.jwksCache;
  const loadAccessState = deps.loadAccessState ?? readAccessState;
  const loadMapping = deps.loadMapping ?? loadIdentityMapping;
  const now = deps.now ?? (() => Date.now());
  const env = deps.env;

  return {
    kind: CLOUDFLARE_ACCESS_ADAPTER_KIND,
    async verifyIdentity(
      request: RemoteRequestContext,
    ): Promise<AdapterCandidateIdentity | null> {
      // (1) PRECONDITION: the backend socket peer MUST be loopback. cloudflared proxies from the
      // LOCAL host, so a legitimate tunnel-fronted request always arrives on 127.0.0.1 / ::1. A
      // non-loopback socket peer never came through the local tunnel — refuse before reading any
      // token. Identity rides the JWT, so this is defense in depth, not the identity check.
      if (!isLoopbackPeer(request.peer?.address)) return null;

      // (2) The Access token — read the header VALUE only as a candidate to be cryptographically
      // confirmed below. Its mere presence proves nothing (a direct loopback caller can set it).
      // Missing → refuse (AC3, missing token).
      const token = headerValue(request.headers[CF_ACCESS_JWT_HEADER]);
      if (token === undefined || token === "") return null;

      // (3) The boot config: team domain (→ expected issuer) + AUD (→ expected audience), from the
      // Forge-owned access-state, re-read per request. ABSENT team/AUD → refuse every request; a
      // malformed team domain that yields no issuer → refuse. Never accept-any-issuer/audience
      // (architect risk 3). A removed access-state (`disable`) lands here and refuses.
      const accessState = loadAccessState(env);
      if (accessState === null) return null;
      const expectedIssuer = deriveExpectedIssuer(accessState.accessTeamDomain);
      if (expectedIssuer === null) return null;
      const expectedAudience = accessState.accessAud;
      if (typeof expectedAudience !== "string" || expectedAudience.trim() === "") return null;

      // (4) Cryptographically verify the token against the team JWKS. The verifier is PURE; the
      // only clock is our injected `now` (epoch ms). On `unknown-kid` (a rotation race) trigger
      // exactly ONE rate-bounded refresh and re-verify once; anything but `ok` → refuse (AC3
      // covers expired / wrong-audience / wrong-issuer / invalid-signature / not-yet-valid /
      // spoofed-header — replay is exp/nbf-bound inside the verifier, no jti ledger).
      const verifyOptions = {
        expectedIssuer,
        expectedAudience,
        now: now(),
        ...(deps.allowedAlgorithms ? { allowedAlgorithms: deps.allowedAlgorithms } : {}),
        ...(deps.clockToleranceSeconds !== undefined
          ? { clockToleranceSeconds: deps.clockToleranceSeconds }
          : {}),
      };
      // The cache's JwksKey (kid-carrying) is a JsonWebKey the pure verifier consumes read-only;
      // the cast bridges JwksKey's `readonly kid` vs JsonWebKey's writable one under array
      // covariance — the verifier never mutates a key.
      const keys = (await jwksCache.getKeys()) as readonly JsonWebKey[];
      let result = verifyAccessJwt(token, keys, verifyOptions);
      if (result.status === "unknown-kid") {
        const refreshed = (await jwksCache.refreshForUnknownKid(result.kid ?? "")) as readonly JsonWebKey[];
        result = verifyAccessJwt(token, refreshed, verifyOptions);
      }
      if (result.status !== "ok") return null;

      // (5) Authorization: map the VERIFIED email through the operator mapping's existing `login`
      // selector (Cloudflare gains no separate vocabulary — AC5). The file is re-read per request
      // so a revoked/edited/deleted entry denies on the next request without a restart (AC6). A
      // token with no email claim, or an unmapped/revoked email → refuse (AC3/AC6).
      const email = result.claims.email;
      if (typeof email !== "string" || email.trim() === "") return null;
      const grant = loadMapping(env).lookup(email);
      if (!grant) return null;

      // (6) Resolve the granted project's OWN member dirs, server-authoritatively. A grant naming
      // no registered project (or one with no dirs) yields no scope → refuse rather than widen.
      // The dirs come from the registry, never from the request.
      const project = lookupProject(grant.projectKey);
      if (!project || project.projectDirs.length === 0) return null;

      // Hand a candidate to the EXISTING validation path. subject = the verified email; provenance
      // names the Access channel and carries only the non-secret Access subject id (never the
      // token or cookie). memberDirs are the project's own dirs; the server re-checks they are a
      // subset of the project before assembling any data. confirmedIdentityHeaders records that
      // the JWT header was CONFIRMED against the team JWKS, not silently ignored.
      const sub = typeof result.claims.sub === "string" ? result.claims.sub : undefined;
      return {
        subject: email,
        capabilities: grant.capabilities,
        projectScope: {
          projectKey: grant.projectKey,
          memberDirs: [...project.projectDirs],
        },
        provenance: {
          adapter: CLOUDFLARE_ACCESS_ADAPTER_KIND,
          detail: sub ? `sub=${sub}` : undefined,
        },
        confirmedIdentityHeaders: [CF_ACCESS_JWT_HEADER],
      };
    },
  };
}
