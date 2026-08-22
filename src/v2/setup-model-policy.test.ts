// FG-346: the orchestrator's branch matrix, every IO injected. No TTY, no real
// provider — a temp FORGE_HOME backs writePolicy/reload so the summary is genuinely
// recomputed from the written file via the production loader.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runHostModelPolicySetup,
  type HostModelPolicyDeps,
  type Prompt,
} from "./setup-model-policy.js";
import { loadModelPolicy } from "./loader.js";
import { ModelPolicySchema } from "./schema.js";
import type { AuthProbe } from "./provider-doctor.js";

const PROBES: AuthProbe[] = [
  { provider: "anthropic", mode: "subscription", status: "available", detail: "ok" },
  { provider: "openai", mode: "subscription", status: "unknown", detail: "run `codex login`" },
];

function scriptedPrompt(answers: string[], confirm: boolean): Prompt {
  let i = 0;
  return {
    ask: async () => (i < answers.length ? answers[i++]! : ""),
    confirm: async () => confirm,
  };
}

type State = { writes: string[]; seedCopies: number; logs: string[]; dir: string };

async function withDeps(
  overrides: Partial<HostModelPolicyDeps>,
  run: (deps: HostModelPolicyDeps, state: State) => Promise<void>,
): Promise<void> {
  const prev = process.env.FORGE_HOME;
  const dir = mkdtempSync(join(tmpdir(), "fg346-orch-"));
  process.env.FORGE_HOME = dir;
  const state: State = { writes: [], seedCopies: 0, logs: [], dir };
  const deps: HostModelPolicyDeps = {
    isTTY: true,
    reconfigure: false,
    dryRun: false,
    yes: false,
    selection: undefined,
    policyPresent: false,
    probes: PROBES,
    prompt: scriptedPrompt([], true),
    writePolicy: (y) => {
      state.writes.push(y);
      writeFileSync(join(dir, "model-policy.yml"), y);
    },
    copySeed: () => {
      state.seedCopies++;
    },
    reload: () => {
      try {
        return loadModelPolicy({});
      } catch {
        return undefined;
      }
    },
    summaryCtx: {},
    loadExisting: () => {
      try {
        return loadModelPolicy({});
      } catch {
        return undefined;
      }
    },
    log: (m) => state.logs.push(m),
    ...overrides,
  };
  try {
    await run(deps, state);
  } finally {
    if (prev === undefined) delete process.env.FORGE_HOME;
    else process.env.FORGE_HOME = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("interactive absent-policy happy path: writes exactly one policy and summarizes from the reload", async () => {
  await withDeps({ prompt: scriptedPrompt([], true) }, async (deps, state) => {
    const res = await runHostModelPolicySetup(deps);
    assert.equal(res.action, "generated");
    assert.equal(res.wrote, true);
    assert.equal(state.writes.length, 1, "exactly one write");
    assert.ok(res.summaryText && /Forge model routing:/.test(res.summaryText), "summary rendered");
    // The written file is a valid policy via the production loader.
    assert.doesNotThrow(() => loadModelPolicy({}));
  });
});

test("cancellation: confirm=false writes nothing", async () => {
  await withDeps({ prompt: scriptedPrompt([], false) }, async (deps, state) => {
    const res = await runHostModelPolicySetup(deps);
    assert.equal(res.action, "cancelled");
    assert.equal(res.wrote, false);
    assert.equal(state.writes.length, 0);
    assert.equal(existsSync(join(state.dir, "model-policy.yml")), false);
  });
});

test("invalid selection: a persistently bogus answer writes nothing", async () => {
  await withDeps({ prompt: scriptedPrompt(["nope", "nope", "nope", "nope"], true) }, async (deps, state) => {
    const res = await runHostModelPolicySetup(deps);
    assert.equal(res.action, "invalid-selection");
    assert.equal(res.wrote, false);
    assert.equal(state.writes.length, 0);
  });
});

test("existing host policy + no --reconfigure: preserved, writer never called", async () => {
  await withDeps({ policyPresent: true }, async (deps, state) => {
    const res = await runHostModelPolicySetup(deps);
    assert.equal(res.action, "preserved");
    assert.equal(res.wrote, false);
    assert.equal(state.writes.length, 0);
    assert.equal(state.seedCopies, 0);
    assert.match(res.step.detail, /preserved/);
  });
});

test("--reconfigure preview: writes and preserves the unmodified default choice", async () => {
  const existing = ModelPolicySchema.parse({
    schema_version: 2,
    model_profiles: {
      "anthropic-subscription-opus": {
        provider: "anthropic",
        auth: "subscription",
        map: { default: { model: "claude-opus-5", cost_tier: "premium" } },
      },
    },
    defaults: { profile: "anthropic-subscription-opus", activity: { default: "anthropic-subscription-opus" } },
  });
  await withDeps(
    { policyPresent: true, reconfigure: true, loadExisting: () => existing, prompt: scriptedPrompt([], true) },
    async (deps, state) => {
      const res = await runHostModelPolicySetup(deps);
      assert.equal(res.action, "generated");
      assert.equal(state.writes.length, 1);
      // The unmodified default (accepted with Enter) is preserved from the existing policy.
      assert.match(state.writes[0]!, /profile: anthropic-subscription-opus/);
    },
  );
});

// RF-1: --yes must force the deterministic non-interactive path EVEN on a TTY, so
// `forge setup --yes` never blocks on a prompt (the protected invariant). With no
// selection flags and no existing policy that path retains the seed default.
test("RF-1: --yes on a TTY takes the non-interactive path, never prompting", async () => {
  await withDeps(
    // isTTY:true (a real TTY) + yes:true + no selection → must NOT prompt.
    { isTTY: true, yes: true, selection: undefined, prompt: scriptedPrompt([], true) },
    async (deps, state) => {
      const res = await runHostModelPolicySetup(deps);
      assert.equal(res.action, "seed-retained", "took the deterministic seed-default path, not the interactive Q&A");
      assert.equal(state.writes.length, 0, "no generated policy written");
      assert.equal(state.seedCopies, 1, "seed copied as the non-interactive fallback");
    },
  );
});

test("RF-1: --yes on a TTY with complete flags generates deterministically without a prompt", async () => {
  await withDeps(
    { isTTY: true, yes: true, selection: { defaultProfile: "anthropic-subscription-sonnet" }, prompt: scriptedPrompt([], true) },
    async (deps, state) => {
      const res = await runHostModelPolicySetup(deps);
      assert.equal(res.action, "generated");
      assert.equal(state.writes.length, 1);
      assert.match(state.writes[0]!, /profile: anthropic-subscription-sonnet/);
    },
  );
});

// RF-2: an interactive reconfigure must PRESERVE existing activity mappings and agent
// pins outside the six prompted entries (Enter accepts the shown defaults for the six).
test("RF-2: reconfigure preserves existing mappings/pins outside the six prompted entries", async () => {
  const existing = ModelPolicySchema.parse({
    schema_version: 2,
    model_profiles: {
      "anthropic-subscription-opus": {
        provider: "anthropic",
        auth: "subscription",
        map: { default: { model: "claude-opus-5", cost_tier: "premium" } },
      },
      "anthropic-subscription-sonnet": {
        provider: "anthropic",
        auth: "subscription",
        map: { default: { model: "claude-sonnet-5", cost_tier: "standard" } },
      },
    },
    defaults: {
      profile: "anthropic-subscription-opus",
      // "spec-writer" is an activity key OUTSIDE the four prompted capabilities.
      activity: { default: "anthropic-subscription-opus", "spec-writer": "anthropic-subscription-sonnet" },
    },
    // "tech-lead" is an agent pin OUTSIDE the two prompted role pins.
    overrides: { agents: { "tech-lead": "anthropic-subscription-sonnet" } },
  });
  await withDeps(
    { policyPresent: true, reconfigure: true, loadExisting: () => existing, prompt: scriptedPrompt([], true) },
    async (deps, state) => {
      const res = await runHostModelPolicySetup(deps);
      assert.equal(res.action, "generated");
      assert.equal(state.writes.length, 1);
      const written = state.writes[0]!;
      assert.match(written, /spec-writer: anthropic-subscription-sonnet/, "unprompted spec-writer activity preserved");
      assert.match(written, /tech-lead: anthropic-subscription-sonnet/, "unprompted tech-lead pin preserved");
    },
  );
});

// RF-3: the writer creates exclusively, so a policy that appeared between the
// absent-policy snapshot and this write (a concurrent bare setup) refuses rather
// than clobbering. The orchestrator reports it as preserved, not overwritten.
test("RF-3: an EEXIST from the exclusive-create writer is reported as preserved, not clobbered", async () => {
  const writePolicy = () => {
    throw Object.assign(new Error("EEXIST: file already exists"), { code: "EEXIST" });
  };
  await withDeps({ writePolicy, prompt: scriptedPrompt([], true) }, async (deps) => {
    const res = await runHostModelPolicySetup(deps);
    assert.equal(res.action, "preserved");
    assert.equal(res.wrote, false);
    assert.match(res.advisory ?? "", /concurrently|preserved/);
  });
});

test("non-interactive + complete flags: deterministic generate, one write, no prompt", async () => {
  await withDeps(
    { isTTY: false, selection: { defaultProfile: "anthropic-subscription-sonnet" } },
    async (deps, state) => {
      const res = await runHostModelPolicySetup(deps);
      assert.equal(res.action, "generated");
      assert.equal(state.writes.length, 1);
      assert.match(state.writes[0]!, /profile: anthropic-subscription-sonnet/);
    },
  );
});

test("non-interactive + no flags: retains the seed default with an advisory, no generated write", async () => {
  await withDeps({ isTTY: false, selection: undefined }, async (deps, state) => {
    const res = await runHostModelPolicySetup(deps);
    assert.equal(res.action, "seed-retained");
    assert.equal(state.writes.length, 0, "no generated policy written");
    assert.equal(state.seedCopies, 1, "seed copied as the fallback");
    assert.match(res.advisory ?? "", /seed default/);
  });
});

test("non-interactive + no flags + --dry-run: no seed copy, no write", async () => {
  await withDeps({ isTTY: false, dryRun: true, selection: undefined }, async (deps, state) => {
    const res = await runHostModelPolicySetup(deps);
    assert.equal(res.action, "seed-retained");
    assert.equal(state.writes.length, 0);
    assert.equal(state.seedCopies, 0);
  });
});

test("no offerable provider: advisory, nothing written or copied", async () => {
  const allDown: AuthProbe[] = [
    { provider: "anthropic", mode: "subscription", status: "unavailable", detail: "x" },
    { provider: "openai", mode: "subscription", status: "unavailable", detail: "x" },
  ];
  await withDeps({ probes: allDown, isTTY: false }, async (deps, state) => {
    const res = await runHostModelPolicySetup(deps);
    assert.equal(res.action, "no-provider");
    assert.equal(res.wrote, false);
    assert.equal(state.writes.length, 0);
    assert.equal(state.seedCopies, 0);
  });
});
