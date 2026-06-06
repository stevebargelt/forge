// #297: the dispatch route-resolution preflight. The core decision is pure +
// testable (injected validator); a separate case exercises the real validator
// against a temp project policy.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { routePreflight, defaultRouteKeyValidator, type RouteKeyValidator } from "./route-preflight.js";

const ALWAYS_OK: RouteKeyValidator = () => ({ ok: true });
const ALWAYS_BAD: RouteKeyValidator = () => ({ ok: false, message: "no route \"x\" in the policy" });
const IN = { command: "forge invoke", projectDir: "/proj" };

test("#297: a valid --route key → routed (proceed)", () => {
  const r = routePreflight({ ...IN, route: "implementation_quick" }, ALWAYS_OK);
  assert.deepEqual(r, { kind: "routed", routeKey: "implementation_quick" });
});

test("#297: a bogus --route key → error naming the key (fails before spawn)", () => {
  const r = routePreflight({ ...IN, route: "made_up_key" }, ALWAYS_BAD);
  assert.equal(r.kind, "error");
  assert.match((r as { message: string }).message, /--route "made_up_key" is not a valid route/);
});

test("#297: --unrouted → acknowledged (proceed silently)", () => {
  assert.deepEqual(routePreflight({ ...IN, unrouted: true }, ALWAYS_OK), { kind: "acknowledged" });
});

test("#297: no route + no ack → WARN by default, naming the rule and the route command", () => {
  const r = routePreflight({ ...IN }, ALWAYS_OK);
  assert.equal(r.kind, "warn");
  const msg = (r as { message: string }).message;
  assert.match(msg, /without a resolved route/i);
  assert.match(msg, /#287|#297/);
  assert.match(msg, /forge route explain/);
  assert.match(msg, /--route/);
  assert.match(msg, /--unrouted/);
});

test("#297: no route + no ack under enforce=error → hard error (requires an explicit choice)", () => {
  const r = routePreflight({ ...IN, enforce: "error" }, ALWAYS_OK);
  assert.equal(r.kind, "error");
});

test("#297: --route takes precedence over enforce=error (a resolved route always proceeds)", () => {
  const r = routePreflight({ ...IN, route: "x", enforce: "error" }, ALWAYS_OK);
  assert.equal(r.kind, "routed");
});

test("#297: defaultRouteKeyValidator validates against the project compiled policy", () => {
  const projectDir = mkdtempSync(join(tmpdir(), "forge-preflight-"));
  try {
    mkdirSync(join(projectDir, ".forge"), { recursive: true });
    writeFileSync(join(projectDir, ".forge", "routing-policy.yml"), [
      "version: 1",
      "governance:",
      "  accountable: human",
      "routes:",
      "  bug_fix:",
      "    responsible: engineer",
      "    path: invoke_chain",
      "    consulted: []",
      "    required_followups: []",
      "    informed: []",
      "    force_rules: []",
    ].join("\n") + "\n");

    assert.deepEqual(defaultRouteKeyValidator("bug_fix", projectDir), { ok: true });
    const bad = defaultRouteKeyValidator("no_such_route", projectDir);
    assert.equal(bad.ok, false);
    assert.match((bad as { message: string }).message, /no route "no_such_route"/);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("#297: defaultRouteKeyValidator rejects an uncompiled project override", () => {
  const projectDir = mkdtempSync(join(tmpdir(), "forge-preflight-uncompiled-"));
  try {
    mkdirSync(join(projectDir, ".forge"), { recursive: true });
    // A project RACI override exists but no compiled routing-policy.yml.
    writeFileSync(join(projectDir, ".forge", "forge-raci.md"), "# project raci override\n");
    const r = defaultRouteKeyValidator("bug_fix", projectDir);
    assert.equal(r.ok, false);
    assert.match((r as { message: string }).message, /not compiled|forge route compile/);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});
