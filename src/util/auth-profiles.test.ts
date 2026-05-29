import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { statSync } from "node:fs";
import {
  sanitizeProfileName,
  profilePath,
  writeProfile,
  readProfile,
  removeProfile,
  listProfileNames,
  profileExpiry,
  profileDomains,
  profileStatus,
  AUTH_DIR,
  type StorageState,
} from "./auth-profiles.js";

// Build a Supabase-shaped localStorage value with a top-level expires_at.
function supabaseValue(expiresAt: number): string {
  return JSON.stringify({
    access_token: "h.p.s",
    token_type: "bearer",
    expires_in: 3600,
    expires_at: expiresAt,
    refresh_token: "r",
    user: { id: "u" },
  });
}

// A value with NO expires_at but an access_token JWT carrying exp (fallback path).
function jwtOnlyValue(exp: number): string {
  const payload = Buffer.from(JSON.stringify({ exp })).toString("base64url");
  return JSON.stringify({ access_token: `h.${payload}.s`, refresh_token: "r" });
}

function state(opts: Partial<StorageState> = {}): StorageState {
  return { cookies: opts.cookies ?? [], origins: opts.origins ?? [] };
}

afterEach(() => {
  for (const n of listProfileNames()) removeProfile(n);
});

test("sanitizeProfileName slugs and blocks traversal", () => {
  assert.equal(sanitizeProfileName("QA Admin"), "qa-admin");
  assert.equal(sanitizeProfileName("../../etc/passwd"), "etc-passwd");
  assert.equal(sanitizeProfileName("a/b\\c"), "a-b-c");
  assert.throws(() => sanitizeProfileName("..."));
  assert.throws(() => sanitizeProfileName("   "));
});

test("profilePath stays inside AUTH_DIR", () => {
  assert.ok(profilePath("qa").startsWith(AUTH_DIR));
  assert.ok(profilePath("../../escape").startsWith(AUTH_DIR));
});

test("profileExpiry reads top-level expires_at", () => {
  const s = state({ origins: [{ origin: "https://a.test", localStorage: [{ name: "sb-x-auth-token", value: supabaseValue(1000) }] }] });
  assert.equal(profileExpiry(s), 1000);
});

test("profileExpiry falls back to JWT exp when no expires_at", () => {
  const s = state({ origins: [{ origin: "https://a.test", localStorage: [{ name: "sb-x-auth-token", value: jwtOnlyValue(2000) }] }] });
  assert.equal(profileExpiry(s), 2000);
});

test("profileExpiry takes the earliest across ls + cookies", () => {
  const s = state({
    origins: [{ origin: "https://a.test", localStorage: [{ name: "t", value: supabaseValue(5000) }] }],
    cookies: [{ name: "c", value: "v", domain: "a.test", path: "/", expires: 3000, httpOnly: true, secure: true }],
  });
  assert.equal(profileExpiry(s), 3000);
});

test("profileExpiry ignores session cookies and non-JSON values", () => {
  const s = state({
    origins: [{ origin: "https://a.test", localStorage: [{ name: "theme", value: "dark" }] }],
    cookies: [{ name: "c", value: "v", domain: "a.test", path: "/", expires: -1, httpOnly: false, secure: false }],
  });
  assert.equal(profileExpiry(s), null);
});

test("profileDomains unions origins and cookie domains, sorted+deduped", () => {
  const s = state({
    origins: [{ origin: "https://b.test", localStorage: [] }, { origin: "https://a.test", localStorage: [] }],
    cookies: [{ name: "c", value: "v", domain: "a.test", path: "/", expires: -1, httpOnly: false, secure: false }],
  });
  assert.deepEqual(profileDomains(s), ["a.test", "https://a.test", "https://b.test"]);
});

test("write/read roundtrip, mode 600, listed by name", () => {
  const s = state({ origins: [{ origin: "https://a.test", localStorage: [{ name: "t", value: supabaseValue(9999) }] }] });
  const path = writeProfile("My Profile", s);
  assert.equal(path, profilePath("my-profile"));
  assert.deepEqual(readProfile("my-profile"), s);
  assert.deepEqual(listProfileNames(), ["my-profile"]);
  const mode = statSync(path).mode & 0o777;
  assert.equal(mode, 0o600);
});

test("readProfile returns null for missing profile", () => {
  assert.equal(readProfile("nope"), null);
});

test("removeProfile reports existence", () => {
  writeProfile("temp", state());
  assert.equal(removeProfile("temp"), true);
  assert.equal(removeProfile("temp"), false);
});

test("profileStatus flags expired vs valid against injected now", () => {
  const nowMs = 10_000_000;
  const nowSec = nowMs / 1000; // 10000
  writeProfile("fresh", state({ origins: [{ origin: "https://a.test", localStorage: [{ name: "t", value: supabaseValue(nowSec + 3600) }] }] }));
  writeProfile("stale", state({ origins: [{ origin: "https://a.test", localStorage: [{ name: "t", value: supabaseValue(nowSec - 1) }] }] }));

  const fresh = profileStatus("fresh", nowMs);
  assert.equal(fresh.exists, true);
  assert.equal(fresh.expired, false);
  assert.equal(fresh.expiresInSeconds, 3600);
  assert.deepEqual(fresh.domains, ["https://a.test"]);

  const stale = profileStatus("stale", nowMs);
  assert.equal(stale.expired, true);
});

test("profileStatus on a missing profile is not expired, marked absent", () => {
  const s = profileStatus("ghost", 10_000_000);
  assert.equal(s.exists, false);
  assert.equal(s.expired, false);
  assert.equal(s.expiresAt, null);
});

test("profileStatus with unknown expiry is not flagged expired", () => {
  writeProfile("dateless", state({ origins: [{ origin: "https://a.test", localStorage: [{ name: "theme", value: "dark" }] }] }));
  const s = profileStatus("dateless", 10_000_000);
  assert.equal(s.expiresAt, null);
  assert.equal(s.expired, false);
});
