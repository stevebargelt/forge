// FG-784 (step 1): a PURE Cloudflare Access JWT (Cf-Access-Jwt-Assertion) verifier.
//
// THREAT MODEL. cloudflared derives a self-contained JWT from the browser's CF_Authorization
// cookie and forwards it to the loopback origin as `Cf-Access-Jwt-Assertion`. The header's
// PRESENCE is never authentication: a direct caller to 127.0.0.1 can set the same header with a
// forged token. This module is the cryptographic gate that turns a candidate token into trusted
// claims — or refuses. It answers the classic hand-rolled-verifier failure modes STRUCTURALLY:
//
//   * ALG CONFUSION. `alg` is checked against an explicit allowlist (RS256 default; ES256 only if
//     the caller opts in) BEFORE any key is looked up. `alg:none` and every HS* are rejected
//     structurally — this verifier only ever treats a JWK as an ASYMMETRIC public key and never
//     as an HMAC secret, so the "sign HS256 with the RSA public key as the MAC secret" attack has
//     no code path to reach. The selected key's `kty` must also match the alg family (RS256→RSA,
//     ES256→EC/P-256), closing the "point an RS256 header at an EC key" variant.
//   * CLAIM FORGERY. issuer, audience (string OR array), and the temporal claims exp/nbf/iat are
//     all enforced against the injected `now`. A missing/expired/not-yet-valid/wrong-iss/wrong-aud
//     token fails closed. Replay is EXP/NBF-BOUND by design (a captured token replays only within
//     its own validity window) — there is deliberately no jti ledger here (architect constraint).
//   * KEY-ROTATION RACE. A token whose `kid` is not in the supplied key set is reported DISTINCTLY
//     (`unknown-kid`) from a cryptographic/claim failure (`invalid`), so the adapter (step 4) can
//     trigger exactly one rate-bounded JWKS refresh and re-verify — without this module fetching
//     anything itself.
//
// PURITY. `verifyAccessJwt` is a pure function of (token, jwks, options): no fs, no fetch, no
// network, no `Date.now()` — the only clock is the injected `now`. That keeps the AC3 unit tests
// network-free and deterministic, and keeps this file free of the JWKS-cache concerns (step 2).
//
// IMPLEMENTATION. node:crypto only (createPublicKey({format:"jwk"}) + crypto.verify) — no new
// dependency, so no package.json / supply-chain / platform serialization step is introduced.

import {
  createPublicKey,
  createVerify,
  verify as cryptoVerify,
  type JsonWebKey,
} from "node:crypto";

/** The signature algorithms this verifier can be configured to accept. RS256 is the Cloudflare
 *  Access default; ES256 is supported only when the caller explicitly allows it. Deliberately NO
 *  `none` and NO HS* — an asymmetric-only allowlist is what makes alg-confusion unreachable. */
export const SUPPORTED_JWT_ALGORITHMS = ["RS256", "ES256"] as const;
export type SupportedJwtAlgorithm = (typeof SUPPORTED_JWT_ALGORITHMS)[number];

/** The default allowlist: RS256 only. ES256 must be opted into explicitly, so a deployment that
 *  never intends to use EC keys can never be pushed onto that path by a crafted `alg` header. */
export const DEFAULT_ALLOWED_ALGORITHMS: readonly SupportedJwtAlgorithm[] = ["RS256"];

/** The subset of Cloudflare Access claims this verifier surfaces with named types. Identity
 *  selection (which claim maps to an operator) is the ADAPTER's job (step 4); the verifier only
 *  proves the token and hands back its validated claims. The index signature keeps forward-compat
 *  claims (`custom`, `country`, …) available without loosening the typed fields. */
export interface AccessJwtClaims {
  /** Issuer — `https://<team>.cloudflareaccess.com`. Cross-checked against `expectedIssuer`. */
  readonly iss: string;
  /** Audience — the Access application's AUD tag(s). May be a single string or an array. */
  readonly aud: string | readonly string[];
  /** Expiry (seconds since epoch). Required — a token with no expiry is refused (fail closed). */
  readonly exp: number;
  /** Not-before (seconds). Optional; when present the token is refused until `now >= nbf`. */
  readonly nbf?: number;
  /** Issued-at (seconds). Optional; when present a token issued in the future is refused. */
  readonly iat?: number;
  /** The end-user's verified email — Cloudflare Access's primary identity claim. */
  readonly email?: string;
  /** The end-user's stable Access subject id. */
  readonly sub?: string;
  /** Access group memberships, when the Access policy emits them. */
  readonly groups?: readonly string[];
  readonly [claim: string]: unknown;
}

/** Options for {@link verifyAccessJwt}. `now` is REQUIRED and injected — the verifier never reads
 *  the wall clock, so tests are deterministic and the module stays pure. */
export interface VerifyAccessJwtOptions {
  /** The exact issuer the token must carry — `https://<team>.cloudflareaccess.com`. */
  readonly expectedIssuer: string;
  /** The Access application AUD tag(s) the token must include. A token's `aud` (string or array)
   *  satisfies this if it intersects the expected set. Absent/empty expected AUD is a caller error
   *  (the adapter must never accept-any-audience) — treated here as: nothing matches → refuse. */
  readonly expectedAudience: string | readonly string[];
  /** Current time as epoch MILLISECONDS. Injected — the only clock this module reads. */
  readonly now: number;
  /** The algorithms to accept. Defaults to {@link DEFAULT_ALLOWED_ALGORITHMS} (RS256 only). Any
   *  value outside {@link SUPPORTED_JWT_ALGORITHMS} is ignored (cannot widen past asymmetric). */
  readonly allowedAlgorithms?: readonly SupportedJwtAlgorithm[];
  /** Clock-skew tolerance in SECONDS applied to exp/nbf/iat. Defaults to 60s — real edge clocks
   *  drift. Bounded and non-negative; a negative value is clamped to 0. */
  readonly clockToleranceSeconds?: number;
}

/** Why an `invalid` result refused. Internal/diagnostic only — the adapter must NEVER log the
 *  token itself, but this coarse reason (which carries no token bytes) is safe to record. */
export type JwtInvalidReason =
  | "malformed" // not three base64url segments / undecodable / non-object header or payload
  | "unsupported-alg" // alg is none / HS* / not in the configured allowlist
  | "key-type-mismatch" // the matched JWK's kty does not match the header alg family
  | "signature-invalid" // the signature did not verify against the matched key
  | "issuer-mismatch" // iss != expectedIssuer
  | "audience-mismatch" // aud does not intersect expectedAudience
  | "expired" // now (minus tolerance) >= exp, or exp missing/non-numeric
  | "not-yet-valid" // now (plus tolerance) < nbf, or iat is in the future
  | "claims-invalid"; // required claim missing or wrong-typed

/** The discriminated verification outcome. `unknown-kid` is reported DISTINCTLY so the adapter can
 *  refresh JWKS and retry exactly once; it is NOT a success and yields no claims. */
export type VerifyAccessJwtResult =
  | { readonly status: "ok"; readonly claims: AccessJwtClaims }
  | { readonly status: "unknown-kid"; readonly kid: string | null }
  | { readonly status: "invalid"; readonly reason: JwtInvalidReason };

/** A parsed JWT header — only the fields we gate on. */
interface JwtHeader {
  readonly alg?: unknown;
  readonly kid?: unknown;
  readonly typ?: unknown;
}

/** Strict base64url: only the URL-safe alphabet, no padding, no standard-base64 `+`/`/`/`=`. A
 *  segment that carries any other character is rejected as malformed rather than being silently
 *  normalized (which is how some decoders let a mutated token slip through). */
const BASE64URL_SEGMENT = /^[A-Za-z0-9_-]+$/;

/** Decode one base64url segment to bytes, or null if it is not strict base64url. */
function decodeSegmentBytes(segment: string): Buffer | null {
  if (segment.length === 0 || !BASE64URL_SEGMENT.test(segment)) return null;
  // Charset is proven URL-safe above, so Buffer's base64url decode cannot fall back to lenient
  // standard-base64 handling of `+`/`/`; the result is exactly this segment's bytes.
  return Buffer.from(segment, "base64url");
}

/** Decode a segment to a JSON object, or null on any structural failure (not base64url, not JSON,
 *  or JSON that is not a plain object — a bare array/number/string header is not a valid JWT part). */
function decodeSegmentJson(segment: string): Record<string, unknown> | null {
  const bytes = decodeSegmentBytes(segment);
  if (!bytes) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

/** Narrow the caller's allowlist to the supported, asymmetric-only set. An empty/absent list falls
 *  back to the RS256 default; nothing here can widen the set to `none`/HS*. */
function resolveAllowedAlgorithms(
  requested: readonly SupportedJwtAlgorithm[] | undefined,
): ReadonlySet<SupportedJwtAlgorithm> {
  const source = requested && requested.length > 0 ? requested : DEFAULT_ALLOWED_ALGORITHMS;
  const allowed = new Set<SupportedJwtAlgorithm>();
  for (const alg of source) {
    if ((SUPPORTED_JWT_ALGORITHMS as readonly string[]).includes(alg)) allowed.add(alg);
  }
  return allowed;
}

/** The JWK key-type each supported alg REQUIRES. A matched JWK whose `kty`/`crv` disagrees with the
 *  header alg is refused (`key-type-mismatch`) — closing the "RS256 header, EC key" confusion. */
function keyMatchesAlg(jwk: JsonWebKey, alg: SupportedJwtAlgorithm): boolean {
  if (alg === "RS256") return jwk.kty === "RSA";
  // ES256 is P-256 ECDSA specifically.
  return jwk.kty === "EC" && jwk.crv === "P-256";
}

/** Find the JWK to verify against. Preference order:
 *   1. a JWK whose `kid` equals the token header's `kid` (the normal case);
 *   2. if the header carries a kid but NO JWK matches it → return `unknownKid` so the adapter can
 *      refresh (a rotation race), NOT a silent fall-through to another key;
 *   3. if the header carries no kid, the sole alg-compatible key (if unambiguous) is used. */
function selectKey(
  jwks: readonly JsonWebKey[],
  headerKid: string | null,
  alg: SupportedJwtAlgorithm,
): { jwk: JsonWebKey } | { unknownKid: string } | { none: true } {
  if (headerKid !== null) {
    const byKid = jwks.filter((k) => typeof k.kid === "string" && k.kid === headerKid);
    if (byKid.length === 0) return { unknownKid: headerKid };
    // Among keys sharing the kid, require alg-family compatibility.
    const compatible = byKid.find((k) => keyMatchesAlg(k, alg));
    return compatible ? { jwk: compatible } : { none: true };
  }
  // No kid in the header: only acceptable if exactly one alg-compatible key exists, so there is no
  // ambiguity about which key authenticated the token.
  const compatible = jwks.filter((k) => keyMatchesAlg(k, alg));
  return compatible.length === 1 ? { jwk: compatible[0]! } : { none: true };
}

/** Verify the RS256/ES256 signature of `signingInput` against a JWK-derived public key. Any error
 *  (bad key material, wrong-shaped signature) is caught and treated as a failed verification —
 *  never thrown — so a malformed key or signature fails CLOSED rather than crashing the request. */
function verifySignature(
  jwk: JsonWebKey,
  alg: SupportedJwtAlgorithm,
  signingInput: string,
  signature: Buffer,
): boolean {
  try {
    const keyObject = createPublicKey({ key: jwk as JsonWebKey, format: "jwk" });
    const data = Buffer.from(signingInput, "ascii");
    if (alg === "RS256") {
      // RSASSA-PKCS1-v1_5 over SHA-256 — node's default RSA padding, matching Cloudflare Access.
      const verifier = createVerify("RSA-SHA256");
      verifier.update(data);
      verifier.end();
      return verifier.verify(keyObject, signature);
    }
    // ES256: ECDSA P-256 SHA-256. JWS signatures are the raw R||S concatenation (IEEE P1363), NOT
    // the DER encoding node defaults to — so `dsaEncoding: "ieee-p1363"` is required or every valid
    // ES256 token would spuriously fail.
    return cryptoVerify(
      "sha256",
      data,
      { key: keyObject, dsaEncoding: "ieee-p1363" },
      signature,
    );
  } catch {
    return false;
  }
}

/** True if the token's `aud` (string or array) intersects the expected AUD set. An empty expected
 *  set matches NOTHING — the caller (adapter) is responsible for supplying a configured AUD, and a
 *  missing one must refuse every token rather than accept-any-audience. */
function audienceMatches(
  tokenAud: unknown,
  expected: string | readonly string[],
): boolean {
  const expectedSet = new Set(
    (Array.isArray(expected) ? expected : [expected]).filter(
      (a): a is string => typeof a === "string" && a.length > 0,
    ),
  );
  if (expectedSet.size === 0) return false;
  const audValues = Array.isArray(tokenAud) ? tokenAud : [tokenAud];
  for (const a of audValues) {
    if (typeof a === "string" && expectedSet.has(a)) return true;
  }
  return false;
}

/**
 * Verify a Cloudflare Access JWT against an already-resolved JWK set. PURE: no network, no fs, no
 * wall-clock read — the only clock is `options.now` (epoch ms). Returns a discriminated result:
 *   - `{ status: "ok", claims }`         the signature and every checked claim passed;
 *   - `{ status: "unknown-kid", kid }`   the header names a kid absent from `jwks` (rotation race);
 *   - `{ status: "invalid", reason }`    a structural / signature / claim failure — fail closed.
 *
 * Every failure path returns rather than throws, so a caller never has to wrap this in try/catch to
 * stay fail-closed.
 */
export function verifyAccessJwt(
  token: string,
  jwks: readonly JsonWebKey[],
  options: VerifyAccessJwtOptions,
): VerifyAccessJwtResult {
  if (typeof token !== "string" || token.length === 0) {
    return { status: "invalid", reason: "malformed" };
  }
  const parts = token.split(".");
  if (parts.length !== 3) return { status: "invalid", reason: "malformed" };
  const [headerSeg, payloadSeg, signatureSeg] = parts as [string, string, string];

  const header = decodeSegmentJson(headerSeg) as JwtHeader | null;
  if (!header) return { status: "invalid", reason: "malformed" };

  // ── ALG ALLOWLIST (before any key lookup) ────────────────────────────────────────────────────
  // `alg` must be a string in the configured asymmetric allowlist. `none`, every HS*, and anything
  // else are rejected structurally here — the key-lookup and HMAC paths are simply never reached.
  const allowed = resolveAllowedAlgorithms(options.allowedAlgorithms);
  if (typeof header.alg !== "string" || !allowed.has(header.alg as SupportedJwtAlgorithm)) {
    return { status: "invalid", reason: "unsupported-alg" };
  }
  const alg = header.alg as SupportedJwtAlgorithm;
  const headerKid = typeof header.kid === "string" && header.kid.length > 0 ? header.kid : null;

  // The signature segment must be strict base64url and decode to bytes.
  const signature = decodeSegmentBytes(signatureSeg);
  if (!signature) return { status: "invalid", reason: "malformed" };

  // ── KEY SELECTION ────────────────────────────────────────────────────────────────────────────
  const selected = selectKey(jwks, headerKid, alg);
  if ("unknownKid" in selected) {
    return { status: "unknown-kid", kid: selected.unknownKid };
  }
  if ("none" in selected) {
    // A kid matched but its key type disagreed with the alg, or there was no unambiguous keyless
    // match. Either way the token cannot be authenticated by these keys — refuse.
    return { status: "invalid", reason: "key-type-mismatch" };
  }

  // ── SIGNATURE ────────────────────────────────────────────────────────────────────────────────
  const signingInput = `${headerSeg}.${payloadSeg}`;
  if (!verifySignature(selected.jwk, alg, signingInput, signature)) {
    return { status: "invalid", reason: "signature-invalid" };
  }

  // ── CLAIMS (only after the signature proved the payload is authentic) ────────────────────────
  const payload = decodeSegmentJson(payloadSeg) as (AccessJwtClaims & Record<string, unknown>) | null;
  if (!payload) return { status: "invalid", reason: "malformed" };

  if (typeof payload.iss !== "string" || payload.iss !== options.expectedIssuer) {
    return { status: "invalid", reason: "issuer-mismatch" };
  }
  if (!audienceMatches(payload.aud, options.expectedAudience)) {
    return { status: "invalid", reason: "audience-mismatch" };
  }

  const toleranceMs = Math.max(0, options.clockToleranceSeconds ?? 60) * 1000;
  const now = options.now;

  // exp is REQUIRED — a token with no (or non-numeric) expiry is refused, so nothing rides forever.
  if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) {
    return { status: "invalid", reason: "expired" };
  }
  if (now - toleranceMs >= payload.exp * 1000) {
    return { status: "invalid", reason: "expired" };
  }
  // nbf: if present, the token is not valid until now >= nbf (minus tolerance).
  if (payload.nbf !== undefined) {
    if (typeof payload.nbf !== "number" || !Number.isFinite(payload.nbf)) {
      return { status: "invalid", reason: "claims-invalid" };
    }
    if (now + toleranceMs < payload.nbf * 1000) {
      return { status: "invalid", reason: "not-yet-valid" };
    }
  }
  // iat: if present, reject a token stamped in the future beyond tolerance (clock-forgery guard).
  if (payload.iat !== undefined) {
    if (typeof payload.iat !== "number" || !Number.isFinite(payload.iat)) {
      return { status: "invalid", reason: "claims-invalid" };
    }
    if (now + toleranceMs < payload.iat * 1000) {
      return { status: "invalid", reason: "not-yet-valid" };
    }
  }

  return { status: "ok", claims: payload };
}
