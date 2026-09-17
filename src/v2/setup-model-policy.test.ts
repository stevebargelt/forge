// FG-346: the orchestrator's branch matrix, every IO injected. No TTY, no real
// provider — a temp FORGE_HOME backs writePolicy/reload so the summary is genuinely
// recomputed from the written file via the production loader.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runHostModelPolicySetup,
  type HostModelPolicyDeps,
  type Prompt,
} from "./setup-model-policy.js";
import { copySeedExclusive } from "../cli/commands/setup.js";
import { loadModelPolicy } from "./loader.js";
import { ModelPolicySchema } from "./schema.js";
import type { AuthProbe } from "./provider-doctor.js";

const PROBES: AuthProbe[] = [
  { provider: "anthropic", mode: "subscription", status: "available", detail: "ok" },
  { provider: "openai", mode: "subscription", status: "unknown", detail: "run `codex login`" },
];

// Zero offerable providers (everything unavailable) — the seed-copy fallback case.
const ALL_DOWN: AuthProbe[] = [
  { provider: "anthropic", mode: "subscription", status: "unavailable", detail: "x" },
  { provider: "openai", mode: "subscription", status: "unavailable", detail: "x" },
];

// Bedrock-only host: only the AWS Bedrock profile is available.
const BEDROCK_ONLY: AuthProbe[] = [
  { provider: "anthropic", mode: "bedrock", status: "available", detail: "AWS profile + CLAUDE_CODE_USE_BEDROCK=1" },
  { provider: "anthropic", mode: "subscription", status: "unavailable", detail: "no ~/.claude subscription" },
  { provider: "openai", mode: "subscription", status: "unavailable", detail: "no ~/.codex/auth.json" },
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
      return true;
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
// `forge setup --yes` never blocks on a prompt (the protected invariant). FG-796:
// with providers available and no selection flags, that path now GENERATES from
// detected availability (never a verbatim seed copy).
test("RF-1/FG-796: --yes on a TTY generates from availability, never prompting or copying the seed", async () => {
  await withDeps(
    // isTTY:true (a real TTY) + yes:true + no selection → must NOT prompt.
    { isTTY: true, yes: true, selection: undefined, prompt: scriptedPrompt([], true) },
    async (deps, state) => {
      const res = await runHostModelPolicySetup(deps);
      assert.equal(res.action, "generated", "took the deterministic generate path, not the interactive Q&A");
      assert.equal(state.writes.length, 1, "one generated policy written");
      assert.equal(state.seedCopies, 0, "no verbatim seed copy when providers are available");
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

// RF-4: the seed-fallback copy is ALSO exclusive. This exercises the SHIPPED copySeed
// impl (copySeedExclusive) against a real dest that appeared concurrently: it must
// throw EEXIST rather than overwrite, and the orchestrator must report it as preserved.
// Discriminating — a bare copyFileSync would clobber the existing content and this test
// would fail on both the content assert and action === "preserved".
test("RF-4: the seed-fallback copy preserves a concurrently-created policy, never clobbers", async () => {
  const seedDir = mkdtempSync(join(tmpdir(), "fg346-rf4-"));
  const seedPath = join(seedDir, "model-policy.example.yml");
  const destPath = join(seedDir, "model-policy.yml");
  writeFileSync(seedPath, "SEED CONTENT\n");
  writeFileSync(destPath, "EXISTING HOST POLICY\n"); // appeared after the policyPresent snapshot
  try {
    await withDeps(
      // FG-796: the verbatim seed-copy fallback only runs when ZERO providers are
      // offerable, so this concurrency case is exercised with all providers down.
      { probes: ALL_DOWN, isTTY: false, selection: undefined, copySeed: () => copySeedExclusive(seedPath, destPath) },
      async (deps) => {
        const res = await runHostModelPolicySetup(deps);
        assert.equal(res.action, "preserved", "concurrent create reported as preserved, not clobbered");
        assert.equal(res.wrote, false);
        assert.match(res.advisory ?? "", /concurrently|preserved/);
        assert.equal(
          readFileSync(destPath, "utf8"),
          "EXISTING HOST POLICY\n",
          "existing policy content preserved — the seed did not overwrite it",
        );
      },
    );
  } finally {
    rmSync(seedDir, { recursive: true, force: true });
  }
});

// RF-1: a non-interactive --reconfigure with selection flags OVERWRITES the existing
// policy. It must PREVIEW the proposed policy first — the operator's output has to show
// exactly what will replace their policy before it lands, not just after. Discriminating:
// before the fix the non-interactive reconfigure path wrote with no preview logged at all.
test("RF-1: non-interactive --reconfigure previews the proposed policy before overwriting", async () => {
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
    {
      isTTY: false,
      yes: true,
      reconfigure: true,
      policyPresent: true,
      loadExisting: () => existing,
      selection: { defaultProfile: "anthropic-subscription-sonnet" },
    },
    async (deps, state) => {
      const res = await runHostModelPolicySetup(deps);
      assert.equal(res.action, "generated");
      assert.equal(state.writes.length, 1, "the reconfigure still writes");
      const preview = state.logs.join("\n");
      // The proposed policy is logged (the preview) — and it reflects the NEW selection.
      assert.match(preview, /Proposed .*model-policy\.yml.*reconfigure/i, "an overwrite preview was printed");
      assert.match(preview, /profile: anthropic-subscription-sonnet/, "preview shows the proposed (new) policy");
      // The preview precedes the write: the written yaml also appears in what was logged.
      assert.ok(preview.includes(state.writes[0]!.trim()), "the previewed yaml equals what was written");
    },
  );
});

// RF-3: the seed-copy fallback is a NO-OP when no seed exists (a damaged/incomplete
// install). The orchestrator must NOT report a created/retained policy that was never
// written — it reports "no-seed" with a named advisory. Discriminating: before the fix
// copySeed's void return let the caller infer success from the callback merely existing,
// so a run with no seed reported status "created" for a file that does not exist.
test("RF-3/FG-796: zero providers + no seed to copy → no-seed, nothing written, not a phantom created policy", async () => {
  await withDeps(
    { probes: ALL_DOWN, isTTY: false, selection: undefined, copySeed: () => false },
    async (deps, state) => {
      const res = await runHostModelPolicySetup(deps);
      assert.equal(res.action, "no-seed", "honest: no policy was created");
      assert.equal(res.wrote, false);
      assert.notEqual(res.step.status, "created", "never reports created when nothing was copied");
      assert.match(res.advisory ?? "", /no model policy was created/i);
      assert.match(res.step.next ?? "", /forge upgrade/);
      assert.equal(state.writes.length, 0);
    },
  );
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

// FG-796 (AC1): non-interactive with no flags GENERATES from detected availability
// (the deterministic all-Enter equivalent), not a verbatim seed copy.
test("FG-796/AC1: non-interactive + no flags generates from availability, no verbatim seed copy", async () => {
  await withDeps({ isTTY: false, selection: undefined }, async (deps, state) => {
    const res = await runHostModelPolicySetup(deps);
    assert.equal(res.action, "generated");
    assert.equal(state.writes.length, 1, "one generated policy written");
    assert.equal(state.seedCopies, 0, "no verbatim seed copy when providers are available");
  });
});

test("FG-796/AC1: non-interactive + no flags + --dry-run previews the generated policy, no write or copy", async () => {
  await withDeps({ isTTY: false, dryRun: true, selection: undefined }, async (deps, state) => {
    const res = await runHostModelPolicySetup(deps);
    assert.equal(res.action, "generated-dry-run");
    assert.equal(state.writes.length, 0);
    assert.equal(state.seedCopies, 0);
    assert.ok(state.logs.some((l) => /model_profiles/.test(l)), "the generated policy was previewed");
  });
});

// FG-796 (AC1): bedrock-only host — every default lands on the Bedrock profile and
// NO pin names an unavailable provider.
test("FG-796/AC1: bedrock-only host generates a Bedrock-only policy with no unavailable-provider pin", async () => {
  await withDeps({ probes: BEDROCK_ONLY, isTTY: false, selection: undefined }, async (deps, state) => {
    const res = await runHostModelPolicySetup(deps);
    assert.equal(res.action, "generated");
    assert.equal(state.seedCopies, 0);
    const policy = loadModelPolicy({});
    assert.ok(policy, "the generated policy loads");
    assert.match(policy!.defaults.profile, /^anthropic-bedrock-/, "defaults.profile is a Bedrock profile");
    for (const [cap, prof] of Object.entries(policy!.defaults.activity)) {
      assert.match(prof, /^anthropic-bedrock-/, `defaults.activity.${cap} is a Bedrock profile`);
    }
    for (const [role, prof] of Object.entries(policy!.overrides.agents)) {
      assert.match(prof, /^anthropic-bedrock-/, `pin ${role} names a Bedrock profile, never codex/subscription`);
      assert.doesNotMatch(prof, /codex|subscription/, `pin ${role} names no unavailable provider`);
    }
  });
});

// FG-796 (AC1): subscription-only host — the codex skeptic pin is NOT added (codex
// is not offered), and defaults land on the subscription profile.
test("FG-796/AC1: subscription-only host omits the codex skeptic pin", async () => {
  const subOnly: AuthProbe[] = [
    { provider: "anthropic", mode: "subscription", status: "available", detail: "ok" },
    { provider: "openai", mode: "subscription", status: "unavailable", detail: "no ~/.codex/auth.json" },
  ];
  await withDeps({ probes: subOnly, isTTY: false, selection: undefined }, async (deps) => {
    const res = await runHostModelPolicySetup(deps);
    assert.equal(res.action, "generated");
    const policy = loadModelPolicy({})!;
    assert.match(policy.defaults.profile, /^anthropic-subscription-/);
    for (const prof of Object.values(policy.overrides.agents)) {
      assert.doesNotMatch(prof, /openai|codex/, "no codex pin without codex availability");
    }
  });
});

// FG-796 (AC1): subscription + codex host — the codex skeptic pin IS added.
test("FG-796/AC1: subscription+codex host pins the research skeptic to codex", async () => {
  const subCodex: AuthProbe[] = [
    { provider: "anthropic", mode: "subscription", status: "available", detail: "ok" },
    { provider: "openai", mode: "subscription", status: "available", detail: "ok" },
  ];
  await withDeps({ probes: subCodex, isTTY: false, selection: undefined }, async (deps) => {
    const res = await runHostModelPolicySetup(deps);
    assert.equal(res.action, "generated");
    const policy = loadModelPolicy({})!;
    assert.equal(policy.overrides.agents["research-skeptic"], "openai-subscription-codex", "skeptic pinned to codex when available");
  });
});

// FG-796 (AC1): nothing detected — non-interactive fallback copies the seed VERBATIM
// with a printed notice naming why; interactive stays advisory.
test("FG-796/AC1: nothing detected, non-interactive → seed-copy fallback with a printed notice", async () => {
  await withDeps({ probes: ALL_DOWN, isTTY: false }, async (deps, state) => {
    const res = await runHostModelPolicySetup(deps);
    assert.equal(res.action, "seed-retained");
    assert.equal(res.wrote, true);
    assert.equal(state.seedCopies, 1, "seed copied as the zero-provider fallback");
    assert.equal(state.writes.length, 0, "no generated policy — nothing to author from");
    assert.ok(
      state.logs.some((l) => /no usable provider detected/i.test(l) && /VERBATIM/i.test(l)),
      "printed a notice naming why the seed was copied verbatim",
    );
  });
});

test("FG-796/AC1: nothing detected, interactive → advisory, nothing written or copied", async () => {
  await withDeps({ probes: ALL_DOWN, isTTY: true }, async (deps, state) => {
    const res = await runHostModelPolicySetup(deps);
    assert.equal(res.action, "no-provider");
    assert.equal(res.wrote, false);
    assert.equal(state.writes.length, 0);
    assert.equal(state.seedCopies, 0);
  });
});

// FG-796 (AC5): a seed-shaped host policy (subscription default + codex pins) is
// repaired by an interactive --reconfigure with only Enter on a bedrock-only host —
// the preselected defaults are Bedrock and the codex/subscription pins are dropped.
test("FG-796/AC5: reconfigure over a seed-shaped policy on a bedrock-only host preselects Bedrock, drops the codex pins", async () => {
  const seedShaped = ModelPolicySchema.parse({
    schema_version: 2,
    model_profiles: {
      "claude-subscription": { provider: "anthropic", auth: "subscription", map: { default: { model: "claude-sonnet-4-6", cost_tier: "standard" } } },
      "claude-bedrock": { provider: "anthropic", auth: "bedrock", map: { default: { model: "us.anthropic.claude-sonnet-4-6", cost_tier: "standard" } } },
      "codex-subscription": { provider: "openai", auth: "subscription", map: { default: { model: "gpt-5.6-terra", cost_tier: "standard" } } },
    },
    defaults: { profile: "claude-subscription", activity: { default: "claude-subscription", review: "claude-subscription" } },
    overrides: { agents: { "red-wide": "codex-subscription", "research-skeptic": "codex-subscription", "red-security": "claude-bedrock" } },
  });
  await withDeps(
    { probes: BEDROCK_ONLY, isTTY: true, reconfigure: true, policyPresent: true, loadExisting: () => seedShaped, prompt: scriptedPrompt([], true) },
    async (deps, state) => {
      const res = await runHostModelPolicySetup(deps);
      assert.equal(res.action, "generated");
      assert.equal(state.writes.length, 1);
      const written = state.writes[0]!;
      assert.doesNotMatch(written, /codex-subscription|claude-subscription/, "seed-shaped subscription/codex profile names are gone");
      const policy = loadModelPolicy({})!;
      assert.match(policy.defaults.profile, /^anthropic-bedrock-/, "reconfigure preselected Bedrock for the default");
      for (const prof of Object.values(policy.overrides.agents)) {
        assert.match(prof, /^anthropic-bedrock-/, "every surviving pin names an available Bedrock profile");
      }
    },
  );
});
