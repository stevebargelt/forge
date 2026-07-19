// FG-563 fixer round 3 — HIGH-3: the code-enforced controller-identity resolver.
//
// The round-2 default owner was `orchestrator@HOSTNAME` — STABLE PER HOST — so two
// same-host orchestrator sessions resolved to the SAME owner and the owner-scoped
// primitives could not fence them (F18 violation). resolveControllerOwner replaces
// that with a strict precedence that identifies the CONTROLLER, never the host, and
// FAILS CLOSED rather than falling back to any host-stable value. These are the
// precedence + fail-closed regressions; the fencing behavior the fail-closed owner
// enables is proven on the real path in continuation-consumer.real-path.integration.test.
//
// Red-before-green: each assertion was observed RED against a resolver that falls back
// to HOSTNAME (the round-2 behavior) — the fail-closed and no-hostname cases fail there.

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveControllerOwner } from "./continue.js";

test("precedence 1: an explicit --owner wins over FORGE_CONTROLLER_ID and a session id", () => {
  const r = resolveControllerOwner(
    { owner: "explicit-ctl" },
    { FORGE_CONTROLLER_ID: "env-ctl", CLAUDE_SESSION_ID: "sess" } as NodeJS.ProcessEnv,
  );
  assert.deepEqual(r, { ok: true, owner: "explicit-ctl", source: "explicit" });
});

test("precedence 2: FORGE_CONTROLLER_ID resolves when there is no --owner", () => {
  const r = resolveControllerOwner(
    {},
    { FORGE_CONTROLLER_ID: "env-ctl", CLAUDE_SESSION_ID: "sess" } as NodeJS.ProcessEnv,
  );
  assert.deepEqual(r, { ok: true, owner: "env-ctl", source: "controller-env" });
});

test("precedence 3: a Claude session id resolves when there is no --owner / FORGE_CONTROLLER_ID", () => {
  const r = resolveControllerOwner({}, { CLAUDE_CODE_SESSION_ID: "sess-123" } as NodeJS.ProcessEnv);
  assert.deepEqual(r, { ok: true, owner: "claude-session@sess-123", source: "session" });
});

test("FAILS CLOSED: no --owner, no FORGE_CONTROLLER_ID, no session id — refuses, and NEVER uses HOSTNAME", () => {
  const r = resolveControllerOwner({}, { HOSTNAME: "my-host" } as NodeJS.ProcessEnv);
  assert.equal(r.ok, false);
  assert.ok(!r.ok && /no stable controller identity/i.test(r.error), "the error explains why it refused");
  assert.ok(!r.ok && !r.error.includes("my-host"), "the hostname is NEVER surfaced or used as the owner");
});

test("FAILS CLOSED: blank/whitespace values do not satisfy any precedence level", () => {
  const r = resolveControllerOwner(
    { owner: "   " },
    { FORGE_CONTROLLER_ID: "", CLAUDE_SESSION_ID: "  ", CLAUDE_CODE_SESSION_ID: "" } as NodeJS.ProcessEnv,
  );
  assert.equal(r.ok, false, "a whitespace owner/env value is not a stable identity");
});

test("session identity: the first non-empty candidate env var wins, in order", () => {
  const r = resolveControllerOwner(
    {},
    { CLAUDE_CODE_SESSION: "c3", ANTHROPIC_SESSION_ID: "a4" } as NodeJS.ProcessEnv,
  );
  assert.equal(r.ok && r.owner, "claude-session@c3", "CLAUDE_CODE_SESSION precedes ANTHROPIC_SESSION_ID");
});
