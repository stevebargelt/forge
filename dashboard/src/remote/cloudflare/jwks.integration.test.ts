// FG-784 (step 2) INTEGRATION tier — exercises the REAL outbound-fetch path of the default JWKS
// fetcher against a local fake HTTP endpoint (node:http on 127.0.0.1). No Cloudflare account, no
// network egress. The unit tier (jwks.test.ts) covers the cache/rate/fail-closed logic with a
// fake fetcher; here we prove createDefaultJwksFetcher actually performs the GET, parses the
// certs body, and fails closed (throws) on transport/HTTP/parse errors — which the cache then
// turns into "no keys".

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { AddressInfo } from "node:net";

import { createDefaultJwksFetcher, createJwksCache } from "./jwks.js";

/** Stand up a one-off HTTP server whose handler a test supplies, returning its base URL and a
 *  close fn. */
async function startServer(
  handler: (url: string) => { status: number; body: string } | { hang: true },
): Promise<{ base: string; close: () => Promise<void>; hits: () => number }> {
  let hits = 0;
  const server: Server = createServer((req, res) => {
    hits += 1;
    const out = handler(req.url ?? "/");
    if ("hang" in out) return; // never respond -> client times out
    res.writeHead(out.status, { "content-type": "application/json" });
    res.end(out.body);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    hits: () => hits,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

const CERTS_BODY = JSON.stringify({
  keys: [
    { kty: "RSA", kid: "real-1", n: "abc", e: "AQAB", alg: "RS256" },
    { kty: "RSA", kid: "real-2", n: "def", e: "AQAB", alg: "RS256" },
  ],
  public_cert: { kid: "real-1", cert: "-----BEGIN CERTIFICATE-----" },
});

test("default fetcher performs a real GET and parses the certs keys", async () => {
  const srv = await startServer(() => ({ status: 200, body: CERTS_BODY }));
  try {
    const fetch = createDefaultJwksFetcher();
    const keys = await fetch(`${srv.base}/cdn-cgi/access/certs`);
    assert.deepEqual(keys.map((k) => k.kid), ["real-1", "real-2"]);
    assert.equal(srv.hits(), 1);
  } finally {
    await srv.close();
  }
});

test("default fetcher throws on a non-2xx status (cache reads this as a failed refresh)", async () => {
  const srv = await startServer(() => ({ status: 503, body: "unavailable" }));
  try {
    const fetch = createDefaultJwksFetcher();
    await assert.rejects(() => fetch(`${srv.base}/cdn-cgi/access/certs`), /HTTP 503/);
  } finally {
    await srv.close();
  }
});

test("default fetcher throws on an unparseable body", async () => {
  const srv = await startServer(() => ({ status: 200, body: "<<not json>>" }));
  try {
    const fetch = createDefaultJwksFetcher();
    await assert.rejects(() => fetch(`${srv.base}/cdn-cgi/access/certs`));
  } finally {
    await srv.close();
  }
});

test("default fetcher aborts a hung endpoint within its timeout (fail closed)", async () => {
  const srv = await startServer(() => ({ hang: true }));
  try {
    const fetch = createDefaultJwksFetcher(150); // short timeout for the test
    await assert.rejects(() => fetch(`${srv.base}/cdn-cgi/access/certs`));
  } finally {
    await srv.close();
  }
});

test("the cache over the real fetcher serves keys and honours the TTL across real requests", async () => {
  const srv = await startServer(() => ({ status: 200, body: CERTS_BODY }));
  try {
    // Point the real default fetcher at the local server, but drive the cache with the module's
    // production fetcher + a controllable clock to prove real HTTP + cache TTL together.
    const realFetcher = createDefaultJwksFetcher();
    let t = 0;
    const cache = createJwksCache({
      teamDomain: "acme",
      fetcher: (_url) => realFetcher(`${srv.base}/cdn-cgi/access/certs`),
      now: () => t,
      ttlMs: 10_000,
      refreshWindowMs: 1_000,
    });

    const first = await cache.getKeys();
    assert.deepEqual(first.map((k) => k.kid), ["real-1", "real-2"]);
    assert.equal(srv.hits(), 1);

    t = 5_000; // inside TTL
    await cache.getKeys();
    assert.equal(srv.hits(), 1); // no second HTTP request
  } finally {
    await srv.close();
  }
});
