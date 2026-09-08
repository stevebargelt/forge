// FG-784 (step 2) UNIT tier — spawns nothing, fetches nothing. Drives the JWKS cache through an
// INJECTED fake fetcher and an INJECTED fake clock, so every cache/rate/fail-closed behaviour is
// exercised deterministically. The real HTTP path lives in jwks.integration.test.ts.
//
// Security focus: the cache is the origin's only source of signing keys, so its every "I can't
// prove these are current" path must yield NO keys (fail closed) and its refresh-on-unknown-kid
// must NOT amplify an inbound-token storm into an outbound-fetch storm (architect risk 1).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildCertsUrl,
  extractJwks,
  createJwksCache,
  type JwksFetcher,
  type JwksKey,
} from "./jwks.js";

/** A key set whose kids we control, so "unknown kid" is meaningful. */
function keySet(...kids: string[]): JwksKey[] {
  return kids.map((kid) => ({ kty: "RSA", kid, n: `n-${kid}`, e: "AQAB" }));
}

/** A fake fetcher over a mutable script of responses. Each call pops the next response; a
 *  `null` entry throws (simulating an unreachable endpoint). Records the call count so a test
 *  can assert EXACTLY how many outbound fetches happened. */
function scriptedFetcher(responses: Array<JwksKey[] | null>): {
  fetcher: JwksFetcher;
  calls: () => number;
} {
  let i = 0;
  let calls = 0;
  const fetcher: JwksFetcher = async () => {
    calls += 1;
    const next = i < responses.length ? responses[i] : responses[responses.length - 1];
    i += 1;
    if (next == null) throw new Error("unreachable JWKS endpoint");
    return next;
  };
  return { fetcher, calls: () => calls };
}

/** A mutable fake clock. */
function fakeClock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

// ── buildCertsUrl ───────────────────────────────────────────────────────────────────────
test("buildCertsUrl expands a bare team name to the canonical certs endpoint", () => {
  assert.equal(
    buildCertsUrl("acme"),
    "https://acme.cloudflareaccess.com/cdn-cgi/access/certs",
  );
});

test("buildCertsUrl accepts a full team host and a full https base URL", () => {
  assert.equal(
    buildCertsUrl("acme.cloudflareaccess.com"),
    "https://acme.cloudflareaccess.com/cdn-cgi/access/certs",
  );
  assert.equal(
    buildCertsUrl("https://acme.cloudflareaccess.com"),
    "https://acme.cloudflareaccess.com/cdn-cgi/access/certs",
  );
});

test("buildCertsUrl rejects an empty domain and a non-https scheme (never fetch keys over plaintext)", () => {
  assert.throws(() => buildCertsUrl(""), /required/);
  assert.throws(() => buildCertsUrl("   "), /required/);
  assert.throws(() => buildCertsUrl("http://acme.cloudflareaccess.com"), /https/);
});

// ── extractJwks ─────────────────────────────────────────────────────────────────────────
test("extractJwks keeps only object entries carrying a kty, and truncates a hostile oversize set", () => {
  const body = {
    keys: [
      { kty: "RSA", kid: "a", n: "x", e: "AQAB" },
      { kid: "no-kty" }, // dropped: no kty
      "not-an-object", // dropped
      null, // dropped
      { kty: "EC", kid: "b" },
    ],
    public_cert: { kid: "ignored" },
  };
  const keys = extractJwks(body);
  assert.deepEqual(keys.map((k) => k.kid), ["a", "b"]);

  const huge = { keys: Array.from({ length: 50 }, (_, n) => ({ kty: "RSA", kid: `k${n}` })) };
  assert.equal(extractJwks(huge).length, 16); // MAX_JWKS_KEYS
});

test("extractJwks fails closed to [] on a non-conforming body", () => {
  assert.deepEqual(extractJwks(null), []);
  assert.deepEqual(extractJwks({}), []);
  assert.deepEqual(extractJwks({ keys: "nope" }), []);
  assert.deepEqual(extractJwks("garbage"), []);
});

// ── positive cache: served within TTL without re-fetching ─────────────────────────────────
test("cached keys are served within the TTL with no re-fetch", async () => {
  const clock = fakeClock();
  const { fetcher, calls } = scriptedFetcher([keySet("k1")]);
  const cache = createJwksCache({
    teamDomain: "acme",
    fetcher,
    now: clock.now,
    ttlMs: 10_000,
    refreshWindowMs: 1_000,
  });

  const first = await cache.getKeys();
  assert.deepEqual(first.map((k) => k.kid), ["k1"]);
  assert.equal(calls(), 1);

  // Well inside the TTL: repeated reads hit the cache, never the network.
  clock.advance(5_000);
  await cache.getKeys();
  await cache.getKeys();
  assert.equal(calls(), 1);
});

// ── refresh-on-unknown-kid is rate-bounded (amplification defense) ─────────────────────────
test("an unknown kid triggers exactly ONE refresh within the window under a storm of unknown kids", async () => {
  const clock = fakeClock();
  // Seed fetch returns k1; the refresh fetch would return k1,k2 — but the storm must not cause
  // more than one refresh fetch regardless of how many distinct unknown kids arrive.
  const { fetcher, calls } = scriptedFetcher([keySet("k1"), keySet("k1", "k2")]);
  const cache = createJwksCache({
    teamDomain: "acme",
    fetcher,
    now: clock.now,
    ttlMs: 60_000,
    refreshWindowMs: 30_000,
  });

  await cache.getKeys(); // seed: fetch #1
  assert.equal(calls(), 1);

  // Advance past the window so the FIRST unknown-kid refresh is allowed.
  clock.advance(30_000);

  // A storm of DISTINCT unknown kids, all inside one window after the first refresh.
  for (let n = 0; n < 100; n++) {
    await cache.refreshForUnknownKid(`attacker-kid-${n}`);
  }
  // Exactly one refresh fetch happened for the whole storm.
  assert.equal(calls(), 2);
});

test("a persistent unknown kid is negative-cached and does not re-fetch every window", async () => {
  const clock = fakeClock();
  // Every fetch returns the same set lacking the queried kid.
  const { fetcher, calls } = scriptedFetcher([keySet("k1")]);
  const cache = createJwksCache({
    teamDomain: "acme",
    fetcher,
    now: clock.now,
    ttlMs: 60_000,
    refreshWindowMs: 10_000,
  });
  await cache.getKeys(); // fetch #1
  assert.equal(calls(), 1);

  clock.advance(10_000);
  await cache.refreshForUnknownKid("ghost"); // fetch #2, still absent -> negative-cached
  assert.equal(calls(), 2);

  // Same kid again inside the same window: negative cache short-circuits, no fetch.
  await cache.refreshForUnknownKid("ghost");
  assert.equal(calls(), 2);
});

test("a genuine rotation resolves via one refresh, then re-serves the new key from cache", async () => {
  const clock = fakeClock();
  const { fetcher, calls } = scriptedFetcher([keySet("old"), keySet("old", "new")]);
  const cache = createJwksCache({
    teamDomain: "acme",
    fetcher,
    now: clock.now,
    ttlMs: 60_000,
    refreshWindowMs: 5_000,
  });
  const before = await cache.getKeys();
  assert.deepEqual(before.map((k) => k.kid), ["old"]);

  clock.advance(5_000);
  const after = await cache.refreshForUnknownKid("new");
  assert.deepEqual(after.map((k) => k.kid), ["old", "new"]);
  assert.equal(calls(), 2);

  // The rotated-in key is now cached; a follow-up read does not re-fetch.
  const again = await cache.refreshForUnknownKid("new");
  assert.deepEqual(again.map((k) => k.kid), ["old", "new"]);
  assert.equal(calls(), 2);
});

// ── fail-closed paths ─────────────────────────────────────────────────────────────────────
test("an unreachable fetcher with an EMPTY cache yields no keys (fail closed, never 'accept any')", async () => {
  const clock = fakeClock();
  const { fetcher, calls } = scriptedFetcher([null]);
  const cache = createJwksCache({ teamDomain: "acme", fetcher, now: clock.now });

  const keys = await cache.getKeys();
  assert.deepEqual(keys, []);
  assert.equal(calls(), 1);
});

test("stale keys during an unreachable rotation fail CLOSED — the stale set is dropped, not served", async () => {
  const clock = fakeClock();
  // First fetch succeeds (old key); the refresh after TTL expiry is unreachable.
  const { fetcher, calls } = scriptedFetcher([keySet("old"), null]);
  const cache = createJwksCache({
    teamDomain: "acme",
    fetcher,
    now: clock.now,
    ttlMs: 10_000,
    refreshWindowMs: 1_000,
  });

  const fresh = await cache.getKeys();
  assert.deepEqual(fresh.map((k) => k.kid), ["old"]);

  // Past the TTL: the cache is stale. A refresh is attempted but the endpoint is down.
  clock.advance(10_001);
  const afterExpiry = await cache.getKeys();
  assert.deepEqual(afterExpiry, []); // NOT the stale ["old"] set
  assert.equal(calls(), 2); // it did try
});

test("the fetch WINDOW bounds attempts even when the cache is empty and the endpoint is down", async () => {
  const clock = fakeClock();
  const { fetcher, calls } = scriptedFetcher([null]);
  const cache = createJwksCache({
    teamDomain: "acme",
    fetcher,
    now: clock.now,
    ttlMs: 10_000,
    refreshWindowMs: 5_000,
  });

  await cache.getKeys(); // attempt #1 (fails)
  await cache.getKeys(); // inside the window -> no new attempt
  await cache.getKeys();
  assert.equal(calls(), 1);

  clock.advance(5_000); // window elapsed
  await cache.getKeys(); // attempt #2
  assert.equal(calls(), 2);
});

test("concurrent getKeys on an empty cache collapse to a single in-flight fetch", async () => {
  const clock = fakeClock();
  let calls = 0;
  let releaseFetch!: () => void;
  const fetchGate = new Promise<void>((resolve) => {
    releaseFetch = resolve;
  });
  const fetcher: JwksFetcher = async () => {
    calls += 1;
    await fetchGate;
    return keySet("k1");
  };
  const cache = createJwksCache({ teamDomain: "acme", fetcher, now: clock.now });

  const keys = Promise.all([cache.getKeys(), cache.getKeys(), cache.getKeys()]);
  assert.equal(calls, 1); // one request is in flight
  releaseFetch();

  const [a, b, c] = await keys;
  assert.deepEqual(a.map((k) => k.kid), ["k1"]);
  assert.deepEqual(b.map((k) => k.kid), ["k1"]);
  assert.deepEqual(c.map((k) => k.kid), ["k1"]);
  assert.equal(calls, 1); // de-duplicated
});
