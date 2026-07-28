// FG-636 environment shape: the gate's verification child must not inherit
// forge's own control-plane switches. `pinnedVerificationEnv` used to be
// `{ ...process.env, PATH }`, so all 32 reserved `FORGE_*` switches reached the
// candidate's test suite and reconfigured the code under verification — one
// inherited FORGE_WORKTREES=1 produced nine false failures on a candidate with
// no code change. Both callers (integration-gate.ts, review-loop.ts) are fixed
// by this one function, and the review-loop's result is persisted as covering
// evidence, so a false verdict there outlives the run.
//
// Every assertion here fails against the pre-fix module.

import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname } from "node:path";
import { pinnedVerificationEnv } from "./host-readiness.js";

function withEnv(vars: Record<string, string>, fn: () => void): void {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("FG-636 — the whole FORGE_* namespace is withheld from the verification child", () => {
  withEnv(
    {
      FORGE_WORKTREES: "1",
      FORGE_NO_WORKTREES: "1",
      FORGE_WORKTREE_IGNORE_DIRTY: "1",
      FORGE_HOME: "/tmp/fg636-not-the-candidates-business",
      FORGE_TEST_MISMATCHED_NODE: "/tmp/fg636-mismatched",
    },
    () => {
      const env = pinnedVerificationEnv("fg636");
      const leaked = Object.keys(env).filter((k) => k.startsWith("FORGE_"));
      assert.deepEqual(leaked, [], `FORGE_* leaked into the verification env: ${leaked.join(", ")}`);
    },
  );
});

test("FG-636 — the operator's general environment still passes through", () => {
  withEnv({ FORGE_WORKTREES: "1", FG636_OPERATOR_VAR: "keep-me" }, () => {
    const env = pinnedVerificationEnv("fg636");
    // The documented intent of inheriting process.env is preserved — this is a
    // denylist on forge's namespace, not a conversion to setupEnv's allowlist,
    // because an allowlist would break an arbitrary project's test suite.
    assert.equal(env["FG636_OPERATOR_VAR"], "keep-me");
    assert.equal(env["HOME"], process.env["HOME"]);
    assert.equal(env["FORGE_WORKTREES"], undefined);
  });
});

test("FG-636 — stripping the namespace does not disturb the pinned PATH", () => {
  withEnv({ FORGE_WORKTREES: "1" }, () => {
    const env = pinnedVerificationEnv("fg636");
    assert.ok(env["PATH"], "the verification env must still pin a PATH");
    assert.equal(env["PATH"]?.split(":")[0], dirname(process.execPath));
  });
});
