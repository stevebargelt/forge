// FG-346 acceptance matrix — the wired host model-policy setup flow driven end to
// end with FAKED provider discovery and a REAL temp FORGE_HOME, so writePolicy and
// reload go through the actual filesystem and the production loader. Proves the two
// round-trip guarantees: (1) the written YAML loads via the production load path
// (loader version gate + Zod); (2) the printed summary equals the summary recomputed
// from the RELOADED policy, not from the raw answers.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runHostModelPolicySetup,
  type HostModelPolicyDeps,
  type Prompt,
} from "./setup-model-policy.js";
import { loadModelPolicy } from "./loader.js";
import { computeRoutingSummary, renderRoutingSummary } from "./model-policy-routing-summary.js";
import type { AuthProbe } from "./provider-doctor.js";

// Faked provider discovery: mixed Anthropic (available) + OpenAI (unknown, carried
// through) — exactly the mixed-provider research case the ticket motivates.
const MIXED: AuthProbe[] = [
  { provider: "anthropic", mode: "subscription", status: "available", detail: "OAuth volume has credentials" },
  { provider: "openai", mode: "subscription", status: "unknown", detail: "no ~/.codex/auth.json — run `codex login`" },
];

function scriptedPrompt(answers: string[], confirm: boolean): Prompt {
  let i = 0;
  return {
    ask: async () => (i < answers.length ? answers[i++]! : ""),
    confirm: async () => confirm,
  };
}

type Harness = {
  deps: HostModelPolicyDeps;
  writes: string[];
  seedCopies: number;
  dir: string;
};

async function withHarness(
  overrides: Partial<HostModelPolicyDeps>,
  run: (h: Harness) => Promise<void>,
): Promise<void> {
  const prev = process.env.FORGE_HOME;
  const dir = mkdtempSync(join(tmpdir(), "fg346-integ-"));
  process.env.FORGE_HOME = dir;
  const h: Harness = { writes: [], seedCopies: 0, dir, deps: undefined as unknown as HostModelPolicyDeps };
  h.deps = {
    isTTY: true,
    reconfigure: false,
    dryRun: false,
    yes: false,
    selection: undefined,
    policyPresent: false,
    probes: MIXED,
    prompt: scriptedPrompt([], true),
    writePolicy: (y) => {
      h.writes.push(y);
      writeFileSync(join(dir, "model-policy.yml"), y);
    },
    copySeed: () => {
      h.seedCopies++;
      writeFileSync(join(dir, "model-policy.yml"), "schema_version: 2\n");
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
    log: () => {},
    ...overrides,
  };
  try {
    await run(h);
  } finally {
    if (prev === undefined) delete process.env.FORGE_HOME;
    else process.env.FORGE_HOME = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("FG-346 interactive mixed Anthropic/OpenAI: writes a valid policy; summary equals a recompute from the reloaded file", async () => {
  await withHarness({ prompt: scriptedPrompt([], true) }, async (h) => {
    const res = await runHostModelPolicySetup(h.deps);
    assert.equal(res.action, "generated");
    assert.equal(h.writes.length, 1);

    // Guarantee 1: the written file loads via the PRODUCTION loader (gate + Zod).
    const reloaded = loadModelPolicy({});
    assert.ok(reloaded, "written policy must load via the production loader");
    assert.equal(reloaded!.schema_version, 2);
    assert.match(readFileSync(join(h.dir, "model-policy.yml"), "utf8"), /schema_version: 2/);

    // The mixed-provider pin actually resolves to the OpenAI codex profile.
    const summary = Object.fromEntries(res.summaryLines!.map((l) => [l.label, l.profile]));
    assert.equal(summary["research skeptic"], "openai-subscription-codex");

    // Guarantee 2: the printed summary equals one recomputed from the RELOADED policy.
    const recomputed = renderRoutingSummary(computeRoutingSummary(reloaded!, {}));
    assert.equal(res.summaryText, recomputed);
  });
});

test("FG-346 no available provider: advisory, nothing written", async () => {
  const allDown: AuthProbe[] = [
    { provider: "anthropic", mode: "subscription", status: "unavailable", detail: "x" },
    { provider: "openai", mode: "subscription", status: "unavailable", detail: "x" },
  ];
  await withHarness({ probes: allDown }, async (h) => {
    const res = await runHostModelPolicySetup(h.deps);
    assert.equal(res.action, "no-provider");
    assert.equal(h.writes.length, 0);
    assert.equal(existsSync(join(h.dir, "model-policy.yml")), false);
  });
});

test("FG-346 cancellation: no write", async () => {
  await withHarness({ prompt: scriptedPrompt([], false) }, async (h) => {
    const res = await runHostModelPolicySetup(h.deps);
    assert.equal(res.action, "cancelled");
    assert.equal(h.writes.length, 0);
  });
});

test("FG-346 invalid selection: no write", async () => {
  await withHarness({ prompt: scriptedPrompt(["bogus", "bogus", "bogus", "bogus"], true) }, async (h) => {
    const res = await runHostModelPolicySetup(h.deps);
    assert.equal(res.action, "invalid-selection");
    assert.equal(h.writes.length, 0);
  });
});

test("FG-346 existing-policy preservation: bare setup never overwrites", async () => {
  await withHarness({ policyPresent: true }, async (h) => {
    // Seed an existing file to prove it is untouched.
    writeFileSync(join(h.dir, "model-policy.yml"), "# my edits\nschema_version: 2\n");
    const before = readFileSync(join(h.dir, "model-policy.yml"), "utf8");
    const res = await runHostModelPolicySetup(h.deps);
    assert.equal(res.action, "preserved");
    assert.equal(h.writes.length, 0);
    assert.equal(readFileSync(join(h.dir, "model-policy.yml"), "utf8"), before, "existing policy untouched");
  });
});

test("FG-346 non-interactive execution: complete flags generate deterministically", async () => {
  await withHarness(
    { isTTY: false, selection: { defaultProfile: "anthropic-subscription-sonnet", reasoning: "anthropic-subscription-opus" } },
    async (h) => {
      const res = await runHostModelPolicySetup(h.deps);
      assert.equal(res.action, "generated");
      assert.equal(h.writes.length, 1);
      const reloaded = loadModelPolicy({});
      assert.ok(reloaded);
      assert.equal(reloaded!.defaults.profile, "anthropic-subscription-sonnet");
      assert.equal(reloaded!.defaults.activity.reasoning, "anthropic-subscription-opus");
      // Determinism: same flags → byte-identical YAML.
      const first = h.writes[0];
      const res2 = await runHostModelPolicySetup(h.deps);
      assert.equal(res2.action, "generated");
      assert.equal(h.writes[1], first, "same flags produce identical YAML");
    },
  );
});

test("FG-346 non-interactive without flags: retains the seed default, does not block", async () => {
  await withHarness({ isTTY: false, selection: undefined }, async (h) => {
    const res = await runHostModelPolicySetup(h.deps);
    assert.equal(res.action, "seed-retained");
    assert.equal(h.writes.length, 0);
    assert.equal(h.seedCopies, 1);
  });
});
