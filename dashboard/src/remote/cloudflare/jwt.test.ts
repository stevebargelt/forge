// FG-784 (step 1) UNIT tier — spawns nothing, fetches nothing. Exercises the PURE Cloudflare
// Access JWT verifier with a LOCALLY generated RS256 (and one ES256) keypair, so every AC3
// negative token case is proven to fail CLOSED and the two success shapes are proven to pass.
//
// Security focus: this is the cryptographic identity gate. Each classic hand-rolled-verifier
// failure mode gets an executed test — alg:none, HS256 alg-confusion (the RSA public key used as
// the HMAC secret), wrong issuer, wrong audience (string AND array), expired, not-yet-valid,
// tampered signature, and an unknown kid — and unknown-kid is proven to be reported DISTINCTLY
// from an invalid signature so the adapter's refresh-and-retry is only triggered on a real
// rotation race, never on a forgery.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  generateKeyPairSync,
  createSign,
  createHmac,
  type JsonWebKey,
  type KeyObject,
} from "node:crypto";

import {
  verifyAccessJwt,
  DEFAULT_ALLOWED_ALGORITHMS,
  type AccessJwtClaims,
} from "./jwt.js";

// ── fixtures ────────────────────────────────────────────────────────────────────────────────────

const ISS = "https://team.cloudflareaccess.com";
const AUD = "aud-tag-deadbeef";
// A fixed injected clock: 2026-01-01T00:00:00Z. All token temporal claims are relative to this.
const NOW_MS = Date.UTC(2026, 0, 1, 0, 0, 0);
const NOW_S = Math.floor(NOW_MS / 1000);

const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const RSA_KID = "rsa-key-1";
const rsaPublicJwk: JsonWebKey = { ...rsa.publicKey.export({ format: "jwk" }), kid: RSA_KID };
const RSA_JWKS: JsonWebKey[] = [rsaPublicJwk];

const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
const EC_KID = "ec-key-1";
const ecPublicJwk: JsonWebKey = { ...ec.publicKey.export({ format: "jwk" }), kid: EC_KID };

function b64url(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/** Build and RS256-sign a JWT from a header + payload against a private key. */
function signRs256(
  payload: Record<string, unknown>,
  opts: { kid?: string | null; alg?: string; privateKey?: KeyObject } = {},
): string {
  const header: Record<string, unknown> = { alg: opts.alg ?? "RS256", typ: "JWT" };
  if (opts.kid !== null) header.kid = opts.kid ?? RSA_KID;
  const signingInput = `${b64url(header)}.${b64url(payload)}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(opts.privateKey ?? rsa.privateKey).toString("base64url");
  return `${signingInput}.${signature}`;
}

/** A well-formed, currently-valid claim set. */
function validClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: ISS,
    aud: AUD,
    exp: NOW_S + 3600,
    nbf: NOW_S - 60,
    iat: NOW_S - 60,
    email: "operator@example.com",
    sub: "abc123",
    ...overrides,
  };
}

const OPTS = { expectedIssuer: ISS, expectedAudience: AUD, now: NOW_MS } as const;

// ── happy paths ───────────────────────────────────────────────────────────────────────────────

test("a well-formed RS256 token verifies to its claims", () => {
  const token = signRs256(validClaims());
  const result = verifyAccessJwt(token, RSA_JWKS, OPTS);
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  const claims: AccessJwtClaims = result.claims;
  assert.equal(claims.email, "operator@example.com");
  assert.equal(claims.iss, ISS);
  assert.equal(claims.sub, "abc123");
});

test("aud as an ARRAY that contains the expected AUD verifies", () => {
  const token = signRs256(validClaims({ aud: ["other-app", AUD] }));
  const result = verifyAccessJwt(token, RSA_JWKS, OPTS);
  assert.equal(result.status, "ok");
});

test("expectedAudience as an array matches when the token's single aud is one of them", () => {
  const token = signRs256(validClaims({ aud: AUD }));
  const result = verifyAccessJwt(token, RSA_JWKS, {
    ...OPTS,
    expectedAudience: ["another", AUD],
  });
  assert.equal(result.status, "ok");
});

test("a token with no kid but exactly one alg-compatible key verifies", () => {
  const [{ kid: _drop, ...keyless }] = RSA_JWKS as [JsonWebKey & { kid?: string }];
  const token = signRs256(validClaims(), { kid: null });
  const result = verifyAccessJwt(token, [keyless], OPTS);
  assert.equal(result.status, "ok");
});

test("a valid ES256 token verifies only when ES256 is explicitly allowed", () => {
  const header = { alg: "ES256", typ: "JWT", kid: EC_KID };
  const payload = validClaims();
  const signingInput = `${b64url(header)}.${b64url(payload)}`;
  const signer = createSign("SHA256");
  signer.update(signingInput);
  signer.end();
  // IEEE-P1363 (raw r||s) is the JWS signature encoding.
  const sig = signer.sign({ key: ec.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
  const token = `${signingInput}.${sig}`;

  // Default allowlist (RS256 only) refuses an ES256 token structurally.
  const refused = verifyAccessJwt(token, [ecPublicJwk], OPTS);
  assert.equal(refused.status, "invalid");
  if (refused.status === "invalid") assert.equal(refused.reason, "unsupported-alg");

  // Opting ES256 in lets the same token verify.
  const allowed = verifyAccessJwt(token, [ecPublicJwk], { ...OPTS, allowedAlgorithms: ["RS256", "ES256"] });
  assert.equal(allowed.status, "ok");
});

// ── AC3 negative token cases — each must fail CLOSED ────────────────────────────────────────────

test("AC3: a missing/empty token is refused", () => {
  assert.equal(verifyAccessJwt("", RSA_JWKS, OPTS).status, "invalid");
  // A non-three-segment string is malformed, not ok.
  assert.equal(verifyAccessJwt("not.a.jwt.token", RSA_JWKS, OPTS).status, "invalid");
  assert.equal(verifyAccessJwt("onlyonesegment", RSA_JWKS, OPTS).status, "invalid");
});

test("AC3: alg:none is rejected structurally, before any key lookup", () => {
  const header = { alg: "none", typ: "JWT", kid: RSA_KID };
  const token = `${b64url(header)}.${b64url(validClaims())}.`;
  const result = verifyAccessJwt(token, RSA_JWKS, OPTS);
  assert.equal(result.status, "invalid");
  if (result.status === "invalid") assert.equal(result.reason, "unsupported-alg");
});

test("AC3: alg-confusion — an HS256 token signed with the RSA public key as the HMAC secret is refused", () => {
  // The classic hand-rolled-verifier break: attacker takes the PUBLIC key (which they have) and
  // uses it as the HMAC secret for an HS256 token. A verifier that keys off `alg` and would run
  // HMAC-verify with the public key would accept it. Our allowlist has no HS* member, so this is
  // rejected as unsupported-alg BEFORE any key material is ever consulted.
  const publicPem = rsa.publicKey.export({ type: "spki", format: "pem" }) as string;
  const header = { alg: "HS256", typ: "JWT", kid: RSA_KID };
  const signingInput = `${b64url(header)}.${b64url(validClaims())}`;
  const mac = createHmac("sha256", publicPem).update(signingInput).digest("base64url");
  const token = `${signingInput}.${mac}`;
  const result = verifyAccessJwt(token, RSA_JWKS, OPTS);
  assert.equal(result.status, "invalid");
  if (result.status === "invalid") assert.equal(result.reason, "unsupported-alg");
});

test("AC3: a wrong-issuer token is refused", () => {
  const token = signRs256(validClaims({ iss: "https://evil.cloudflareaccess.com" }));
  const result = verifyAccessJwt(token, RSA_JWKS, OPTS);
  assert.equal(result.status, "invalid");
  if (result.status === "invalid") assert.equal(result.reason, "issuer-mismatch");
});

test("AC3: a wrong-audience token is refused — string aud", () => {
  const token = signRs256(validClaims({ aud: "some-other-aud" }));
  const result = verifyAccessJwt(token, RSA_JWKS, OPTS);
  assert.equal(result.status, "invalid");
  if (result.status === "invalid") assert.equal(result.reason, "audience-mismatch");
});

test("AC3: a wrong-audience token is refused — array aud, none matching", () => {
  const token = signRs256(validClaims({ aud: ["a", "b", "c"] }));
  const result = verifyAccessJwt(token, RSA_JWKS, OPTS);
  assert.equal(result.status, "invalid");
  if (result.status === "invalid") assert.equal(result.reason, "audience-mismatch");
});

test("AC3: an expired token (exp in the past) is refused", () => {
  const token = signRs256(validClaims({ exp: NOW_S - 3600 }));
  const result = verifyAccessJwt(token, RSA_JWKS, OPTS);
  assert.equal(result.status, "invalid");
  if (result.status === "invalid") assert.equal(result.reason, "expired");
});

test("AC3: a token with no exp claim is refused (nothing rides forever)", () => {
  const claims = validClaims();
  delete (claims as Record<string, unknown>).exp;
  const token = signRs256(claims);
  const result = verifyAccessJwt(token, RSA_JWKS, OPTS);
  assert.equal(result.status, "invalid");
  if (result.status === "invalid") assert.equal(result.reason, "expired");
});

test("AC3: a not-yet-valid token (nbf in the future) is refused", () => {
  const token = signRs256(validClaims({ nbf: NOW_S + 3600, iat: NOW_S + 3600 }));
  const result = verifyAccessJwt(token, RSA_JWKS, OPTS);
  assert.equal(result.status, "invalid");
  if (result.status === "invalid") assert.equal(result.reason, "not-yet-valid");
});

test("AC3: a token issued in the future (iat ahead of now) is refused", () => {
  // nbf absent so the iat guard is what trips.
  const claims = validClaims({ iat: NOW_S + 3600 });
  delete (claims as Record<string, unknown>).nbf;
  const token = signRs256(claims);
  const result = verifyAccessJwt(token, RSA_JWKS, OPTS);
  assert.equal(result.status, "invalid");
  if (result.status === "invalid") assert.equal(result.reason, "not-yet-valid");
});

test("AC3: a tampered signature is refused (signature-invalid, NOT ok)", () => {
  const token = signRs256(validClaims());
  const [h, p, sig] = token.split(".") as [string, string, string];
  // Flip the last base64url char of the signature to a different valid char.
  const mutated = sig.slice(0, -1) + (sig.endsWith("A") ? "B" : "A");
  const result = verifyAccessJwt(`${h}.${p}.${mutated}`, RSA_JWKS, OPTS);
  assert.equal(result.status, "invalid");
  if (result.status === "invalid") assert.equal(result.reason, "signature-invalid");
});

test("AC3: a tampered PAYLOAD (re-encoded claims, original signature) is refused", () => {
  const token = signRs256(validClaims());
  const [h, , sig] = token.split(".") as [string, string, string];
  const forgedPayload = b64url(validClaims({ email: "attacker@evil.com", sub: "root" }));
  const result = verifyAccessJwt(`${h}.${forgedPayload}.${sig}`, RSA_JWKS, OPTS);
  assert.equal(result.status, "invalid");
  if (result.status === "invalid") assert.equal(result.reason, "signature-invalid");
});

test("AC3: an unknown kid is reported DISTINCTLY from invalid — enabling one JWKS refresh", () => {
  const token = signRs256(validClaims(), { kid: "rotated-away-kid" });
  const result = verifyAccessJwt(token, RSA_JWKS, OPTS);
  assert.equal(result.status, "unknown-kid");
  if (result.status === "unknown-kid") assert.equal(result.kid, "rotated-away-kid");
  // Crucially: it is NOT reported as an invalid signature, so the adapter can safely refresh.
  assert.notEqual(result.status, "invalid");
});

test("unknown-kid is distinct from a real forgery: a bad signature under a KNOWN kid stays invalid", () => {
  const token = signRs256(validClaims());
  const [h, p, sig] = token.split(".") as [string, string, string];
  const mutated = sig.slice(0, -1) + (sig.endsWith("A") ? "B" : "A");
  const result = verifyAccessJwt(`${h}.${p}.${mutated}`, RSA_JWKS, OPTS);
  assert.equal(result.status, "invalid"); // NOT unknown-kid — no pointless refresh on a forgery
});

// ── structural strictness ───────────────────────────────────────────────────────────────────────

test("a header/payload segment using standard-base64 (+/=) instead of base64url is malformed", () => {
  // Force a '+' or '/' into the header segment: standard base64 of a header that contains bytes
  // producing those chars. Simpler: append a padding '=' which base64url never uses.
  const token = signRs256(validClaims());
  const [h, p, sig] = token.split(".") as [string, string, string];
  const padded = `${h}=`;
  const result = verifyAccessJwt(`${padded}.${p}.${sig}`, RSA_JWKS, OPTS);
  assert.equal(result.status, "invalid");
  if (result.status === "invalid") assert.equal(result.reason, "malformed");
});

test("an empty expected-audience refuses every token (never accept-any-audience)", () => {
  const token = signRs256(validClaims());
  const result = verifyAccessJwt(token, RSA_JWKS, { ...OPTS, expectedAudience: [] });
  assert.equal(result.status, "invalid");
  if (result.status === "invalid") assert.equal(result.reason, "audience-mismatch");
});

test("RF-3: clock tolerance is <=5s — a token 30s past exp is REFUSED, a 2s-past one is inside tolerance", () => {
  // exp 2s in the past, default (5s) tolerance -> still valid (ordinary NTP drift).
  const barelyExpired = signRs256(validClaims({ exp: NOW_S - 2 }));
  assert.equal(verifyAccessJwt(barelyExpired, RSA_JWKS, OPTS).status, "ok");
  // exp 30s in the past -> refused. The old 60s default would have accepted this; 5s does not.
  const expired30s = signRs256(validClaims({ exp: NOW_S - 30 }));
  const r = verifyAccessJwt(expired30s, RSA_JWKS, OPTS);
  assert.equal(r.status, "invalid");
  if (r.status === "invalid") assert.equal(r.reason, "expired");
});

test("RF-3: clock tolerance is configurable only DOWNWARD — a caller cannot widen exp acceptance", () => {
  // A caller asking for 120s is clamped to the 5s bound, so a token 30s past exp is STILL refused.
  const expired30s = signRs256(validClaims({ exp: NOW_S - 30 }));
  assert.equal(
    verifyAccessJwt(expired30s, RSA_JWKS, { ...OPTS, clockToleranceSeconds: 120 }).status,
    "invalid",
  );
  // Downward is honoured: 0s tolerance refuses a token even 1s past exp.
  const expired1s = signRs256(validClaims({ exp: NOW_S - 1 }));
  assert.equal(
    verifyAccessJwt(expired1s, RSA_JWKS, { ...OPTS, clockToleranceSeconds: 0 }).status,
    "invalid",
  );
});

test("DEFAULT_ALLOWED_ALGORITHMS is RS256-only (ES256 is opt-in)", () => {
  assert.deepEqual([...DEFAULT_ALLOWED_ALGORITHMS], ["RS256"]);
});
