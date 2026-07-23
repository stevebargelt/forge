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
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveControllerOwner, dispatchStartRun, type StartRunSeams } from "./continue.js";
import type { SeedGeneration } from "../../v2/seed-generation.js";

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

// FG-583 (the one-generation anchor invariant on the `forge continue` dispatch path).
//
// The defect: `forge continue`'s start_run dispatch loaded the workflow, then kicked
// runNext WITHOUT a held seed generation — two independent reads of the live seed
// pointer with a window between them. A promotion interleaved in that window could
// make one supported dispatch consume an A/B surface (workflow from generation A, the
// wave's runtime/policy loads from generation B), violating the invariant that a
// single dispatch stays anchored to ONE complete generation.
//
// Red-before-green: against the pre-fix code (no shared anchor, per-load live resolve)
// runNext would observe the interleaved genB while the workflow came from genA. The
// fix resolves the generation ONCE and threads the SAME anchor into both loads.
test("FG-583 interleaving: start_run resolves the seed generation ONCE and threads the SAME anchor to loadWorkflow and runNext", async () => {
  const genA = { root: "/seed-generations/gen-A" } as unknown as SeedGeneration;
  const genB = { root: "/seed-generations/gen-B" } as unknown as SeedGeneration;

  // Model a promotion interleaved DURING the dispatch: a per-call live resolve would
  // return genA first, then genB. A correct dispatch resolves ONCE, so genB never wins.
  let resolveCalls = 0;
  const resolveSeedGeneration = () => (resolveCalls++ === 0 ? genA : genB);

  const workflow = { name: "feature", steps: [] };
  const seenByLoad: Array<SeedGeneration | null | undefined> = [];
  const loadWorkflow = (_name: string, ctx: { seedGeneration?: SeedGeneration | null }) => {
    seenByLoad.push(ctx.seedGeneration);
    return workflow;
  };

  const startRun = () => ({ runId: "run-1" });

  const seenByNext: Array<SeedGeneration | null | undefined> = [];
  let nextWorkflow: unknown;
  const runNext = (opts: { workflow: unknown; seedGeneration?: SeedGeneration | null }) => {
    seenByNext.push(opts.seedGeneration);
    nextWorkflow = opts.workflow;
    return Promise.resolve({});
  };

  const seams = { resolveSeedGeneration, loadWorkflow, startRun, runNext } as unknown as StartRunSeams;
  const out = dispatchStartRun(
    { kind: "start_run", workflow: "feature", title: "t" } as never,
    "dispatch-key-1",
    seams,
  );

  assert.equal(out.runId, "run-1");
  assert.equal(resolveCalls, 1, "the seed generation is resolved exactly ONCE — not once per load");
  assert.deepEqual(seenByLoad, [genA], "loadWorkflow received the single anchored generation (genA)");
  assert.deepEqual(seenByNext, [genA], "runNext received the SAME anchor (genA) — never the interleaved genB");
  assert.strictEqual(seenByLoad[0], seenByNext[0], "the identical anchor object threads to both loads");
  assert.notStrictEqual(seenByNext[0], genB, "the interleaved promotion (genB) is never consumed by this dispatch");
  assert.strictEqual(nextWorkflow, workflow, "the wave dispatches the workflow loaded under the same anchor");

  // Let the fire-and-forget runNext promise settle so no rejection escapes the test.
  await Promise.resolve();
});

// FG-583: a `forge continue` start_run on a host with NO complete seed generation must
// inherit the SAME named refusal every other dispatch path gets from the loader's single
// resolve point — it must NOT fall back to a flat surface or gate the state per-consumer.
//
// This drives the REAL seams (no injected mocks): resolveSeedGeneration reads a disposable,
// empty $FORGE_HOME and returns null; that one anchor threads into the REAL loadWorkflow,
// which refuses at its single resolve point with the named no-generation state. startRun /
// runNext are never reached — the refusal fires at the load. The disposable home is used so
// the real ~/.forge is never touched.
test("FG-583 no-generation: a continue start_run on a host with no published generation REFUSES with the named seed-generation state", () => {
  const home = mkdtempSync(join(tmpdir(), "forge-continue-home-"));
  const project = mkdtempSync(join(tmpdir(), "forge-continue-proj-"));
  const prevHome = process.env.FORGE_HOME;
  process.env.FORGE_HOME = home;
  try {
    assert.throws(
      () =>
        dispatchStartRun(
          { kind: "start_run", workflow: "feature", title: "t", project } as never,
          "dispatch-key-2",
        ),
      /refusing to dispatch — no complete seed generation is published/,
      "continue must inherit the loader's named no-generation refusal — never dispatch under a flat/absent surface",
    );
  } finally {
    if (prevHome === undefined) delete process.env.FORGE_HOME;
    else process.env.FORGE_HOME = prevHome;
  }
});
