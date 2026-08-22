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
      { isTTY: false, selection: undefined, copySeed: () => copySeedExclusive(seedPath, destPath) },
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
test("RF-3: no seed to copy → reports no-seed, nothing written, not a phantom created policy", async () => {
  await withDeps(
    { isTTY: false, selection: undefined, copySeed: () => false },
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
