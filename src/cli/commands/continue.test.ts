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
// Round 4 (HIGH — fencing soundness): the session precedence level trusts ONLY
// CLAUDE_CODE_SESSION_ID, the one VERIFIED per-Claude-Code-session var. The round-3
// resolver also probed speculative aliases (CLAUDE_SESSION_ID, CLAUDE_CODE_SESSION,
// ANTHROPIC_SESSION_ID); those are not confirmed per-session, so two distinct controllers
// could alias to the SAME owner and defeat the fence. The alias tests below were RED
// against round 3 (each alias resolved an owner) and are green now (they fail closed).
//
// Red-before-green: each assertion was observed RED against a resolver that falls back
// to HOSTNAME (the round-2 behavior) — the fail-closed and no-hostname cases fail there.

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveControllerOwner } from "./continue.js";

test("precedence 1: an explicit --owner wins over FORGE_CONTROLLER_ID and a session id", () => {
  const r = resolveControllerOwner(
    { owner: "explicit-ctl" },
    { FORGE_CONTROLLER_ID: "env-ctl", CLAUDE_CODE_SESSION_ID: "sess" } as NodeJS.ProcessEnv,
  );
  assert.deepEqual(r, { ok: true, owner: "explicit-ctl", source: "explicit" });
});

test("precedence 2: FORGE_CONTROLLER_ID resolves when there is no --owner", () => {
  const r = resolveControllerOwner(
    {},
    { FORGE_CONTROLLER_ID: "env-ctl", CLAUDE_CODE_SESSION_ID: "sess" } as NodeJS.ProcessEnv,
  );
  assert.deepEqual(r, { ok: true, owner: "env-ctl", source: "controller-env" });
});

test("precedence 3: CLAUDE_CODE_SESSION_ID resolves when there is no --owner / FORGE_CONTROLLER_ID", () => {
  const r = resolveControllerOwner({}, { CLAUDE_CODE_SESSION_ID: "sess-123" } as NodeJS.ProcessEnv);
  assert.deepEqual(r, { ok: true, owner: "claude-session@sess-123", source: "session" });
});

// FG-563 fixer round 4 (HIGH — fencing soundness): only CLAUDE_CODE_SESSION_ID is trusted
// as the session identity. The round-3 speculative aliases (CLAUDE_SESSION_ID,
// CLAUDE_CODE_SESSION, ANTHROPIC_SESSION_ID) are NOT confirmed per-session, so they must NO
// LONGER resolve an owner — they fall through to fail-closed. Red-before-green: each alias
// resolved `claude-session@<id>` against the round-3 resolver; now every one fails closed.
test("FIX (round 4): the removed speculative aliases do NOT resolve an owner — they fail closed", () => {
  for (const alias of ["CLAUDE_SESSION_ID", "CLAUDE_CODE_SESSION", "ANTHROPIC_SESSION_ID"]) {
    const r = resolveControllerOwner({}, { [alias]: "sess-x" } as NodeJS.ProcessEnv);
    assert.equal(r.ok, false, `${alias} is speculative and must not resolve a controller owner`);
  }
});

test("FIX (round 4): a set CLAUDE_CODE_SESSION_ID resolves even when only aliases are also present", () => {
  const r = resolveControllerOwner(
    {},
    { CLAUDE_SESSION_ID: "ignored", CLAUDE_CODE_SESSION_ID: "real-sess", ANTHROPIC_SESSION_ID: "ignored2" } as NodeJS.ProcessEnv,
  );
  assert.deepEqual(r, { ok: true, owner: "claude-session@real-sess", source: "session" });
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

test("FIX (round 4): a blank CLAUDE_CODE_SESSION_ID does not satisfy the session level — fails closed", () => {
  const r = resolveControllerOwner({}, { CLAUDE_CODE_SESSION_ID: "   " } as NodeJS.ProcessEnv);
  assert.equal(r.ok, false, "a whitespace-only session id is not a stable identity");
});
