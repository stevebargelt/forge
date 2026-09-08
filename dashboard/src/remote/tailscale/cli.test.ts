// FG-782 (step 5) UNIT tier — no spawned process, no daemon, no fs. Exercises the PURE
// whois / serve-status parsers and the whois/serveStatus decision logic through an INJECTED
// synchronous runner (a plain function, not a process). The real-spawn path lives in
// cli.integration.test.ts.
//
// Security focus: the seam is an identity ORACLE, so every negative shape must fail CLOSED —
// malformed JSON, empty output, a missing login, a daemon-down runner, and a non-IP peer all
// yield null (never a fallback identity), and a Funnel-enabled serve status is DETECTED
// (funnel: true) for AC5.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseWhois,
  parseServeStatus,
  whois,
  serveStatus,
  type TailscaleRunner,
  type TailscaleCommandResult,
} from "./cli.js";

/** A runner that returns a fixed result and records every argv it was invoked with, so a test
 *  can assert the exact command the seam issued (argv array, never a shell string). */
function stubRunner(result: TailscaleCommandResult): { runner: TailscaleRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: TailscaleRunner = (args) => {
    calls.push([...args]);
    return result;
  };
  return { runner, calls };
}

const WHOIS_JSON = JSON.stringify({
  Node: { Name: "steve-mbp.tail1234.ts.net.", ID: "n123" },
  UserProfile: { LoginName: "steve@example.com", DisplayName: "Steve" },
});

// ── parseWhois: happy path ──────────────────────────────────────────────────────────────
test("parseWhois extracts login, node, and derives tailnet from a whois JSON blob", () => {
  const who = parseWhois(WHOIS_JSON);
  assert.deepEqual(who, {
    login: "steve@example.com",
    node: "steve-mbp.tail1234.ts.net",
    tailnet: "tail1234.ts.net",
  });
});

test("parseWhois tolerates an absent Node (login is the only load-bearing field)", () => {
  const who = parseWhois(JSON.stringify({ UserProfile: { LoginName: "a@b.com" } }));
  assert.deepEqual(who, { login: "a@b.com", node: undefined, tailnet: undefined });
});

// ── parseWhois: every negative shape fails CLOSED (returns null) ─────────────────────────
test("parseWhois returns null on malformed JSON, empty, and non-object output", () => {
  assert.equal(parseWhois("not json {"), null);
  assert.equal(parseWhois(""), null);
  assert.equal(parseWhois("   "), null);
  assert.equal(parseWhois("null"), null);
  assert.equal(parseWhois('"a string"'), null);
  assert.equal(parseWhois("42"), null);
});

test("parseWhois returns null when the login is missing or empty (no anonymous identity)", () => {
  assert.equal(parseWhois(JSON.stringify({ Node: { Name: "h.ts.net" } })), null);
  assert.equal(parseWhois(JSON.stringify({ UserProfile: {} })), null);
  assert.equal(parseWhois(JSON.stringify({ UserProfile: { LoginName: "" } })), null);
  assert.equal(parseWhois(JSON.stringify({ UserProfile: { LoginName: "   " } })), null);
  assert.equal(parseWhois(JSON.stringify({ UserProfile: { LoginName: 123 } })), null);
});

// ── parseServeStatus: Funnel detection (AC5) ─────────────────────────────────────────────
test("parseServeStatus flags funnel:true when any AllowFunnel entry is enabled (AC5)", () => {
  const raw = JSON.stringify({
    AllowFunnel: { "steve-mbp.tail1234.ts.net:443": true },
    Web: { "steve-mbp.tail1234.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:8025" } } } },
  });
  const status = parseServeStatus(raw);
  assert.ok(status);
  assert.equal(status.funnel, true);
  assert.deepEqual(status.proxies, [
    { host: "steve-mbp.tail1234.ts.net:443", target: "http://127.0.0.1:8025" },
  ]);
});

test("parseServeStatus reports funnel:false and the proxied loopback target for a Serve-only mapping", () => {
  const raw = JSON.stringify({
    AllowFunnel: { "steve-mbp.tail1234.ts.net:443": false },
    Web: { "steve-mbp.tail1234.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:8025" } } } },
  });
  const status = parseServeStatus(raw);
  assert.ok(status);
  assert.equal(status.funnel, false);
  assert.deepEqual(status.proxies, [
    { host: "steve-mbp.tail1234.ts.net:443", target: "http://127.0.0.1:8025" },
  ]);
});

test("parseServeStatus returns null on unparseable/empty serve output (caller must not read null as funnel-off)", () => {
  assert.equal(parseServeStatus(""), null);
  assert.equal(parseServeStatus("not json"), null);
  assert.equal(parseServeStatus("null"), null);
});

test("parseServeStatus treats an empty serve config as no funnel and no proxies", () => {
  const status = parseServeStatus(JSON.stringify({}));
  assert.deepEqual(status, { funnel: false, proxies: [] });
});

// ── whois(): daemon down / non-IP peer fail closed; happy path issues the argv command ────
test("whois issues `whois --json <peer>` as an argv array and returns the confirmed identity", () => {
  const { runner, calls } = stubRunner({ ok: true, code: 0, stdout: WHOIS_JSON });
  const who = whois("100.101.102.103", runner);
  assert.deepEqual(calls, [["whois", "--json", "100.101.102.103"]]);
  assert.equal(who?.login, "steve@example.com");
});

test("whois fails closed when the daemon is unreachable (runner not ok) — no fallback identity", () => {
  const { runner } = stubRunner({ ok: false, code: 1, stdout: "" });
  assert.equal(whois("100.101.102.103", runner), null);
});

test("whois fails closed when the daemon returns unparseable output", () => {
  const { runner } = stubRunner({ ok: true, code: 0, stdout: "failed to look up address" });
  assert.equal(whois("100.101.102.103", runner), null);
});

test("whois refuses a non-IP / flag-shaped peer address WITHOUT invoking the CLI", () => {
  for (const bad of ["", "   ", "--help", "-x", "127.0.0.1; rm -rf /", "not an ip"]) {
    const { runner, calls } = stubRunner({ ok: true, code: 0, stdout: WHOIS_JSON });
    assert.equal(whois(bad, runner), null, `expected refusal for ${JSON.stringify(bad)}`);
    assert.equal(calls.length, 0, `must not invoke the CLI for ${JSON.stringify(bad)}`);
  }
});

test("whois accepts an IPv6 peer with a zone id", () => {
  const { runner, calls } = stubRunner({ ok: true, code: 0, stdout: WHOIS_JSON });
  const who = whois("fe80::1%eth0", runner);
  assert.deepEqual(calls, [["whois", "--json", "fe80::1%eth0"]]);
  assert.equal(who?.login, "steve@example.com");
});

// ── serveStatus(): daemon down fails closed; happy path issues the argv command ──────────
test("serveStatus issues `serve status --json` and parses the funnel flag", () => {
  const raw = JSON.stringify({ AllowFunnel: { "h:443": true }, Web: {} });
  const { runner, calls } = stubRunner({ ok: true, code: 0, stdout: raw });
  const status = serveStatus(runner);
  assert.deepEqual(calls, [["serve", "status", "--json"]]);
  assert.equal(status?.funnel, true);
});

test("serveStatus fails closed (null) when the daemon is unreachable", () => {
  const { runner } = stubRunner({ ok: false, code: 1, stdout: "" });
  assert.equal(serveStatus(runner), null);
});
