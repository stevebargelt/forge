// L1 docs-drift parity tests (#239).
//
// The cheapest drift layer: assert the SHIPPED seed files on disk parse under
// the CURRENT schema and use CURRENT vocabulary. schema.test.ts validates the
// schemas against inline fixtures; this validates the real artifacts users get.
//
// Would have caught this session's `model:`->`activity:` example drift
// mechanically — a renamed primitive in schema.ts that a seed still spells the
// old way fails here, in the normal test suite, with no LLM.
//
// Data-driven: globs the seed dirs, so a newly-added workflow/runtime is
// covered automatically. No static file list to rot.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { WorkflowSchema, RuntimeSchema, ModelPolicySchema } from "./schema.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const seedsDir = join(repoRoot, "seeds");

function ymlFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .sort();
}

function issues(r: { success: boolean; error?: { issues: unknown[] } }): string {
  return r.success ? "" : JSON.stringify(r.error!.issues, null, 2);
}

// ------------------------------------------------------------------
// seeds/workflows/* parse under WorkflowSchema
// ------------------------------------------------------------------

const workflowsDir = join(seedsDir, "workflows");
for (const file of ymlFiles(workflowsDir)) {
  test(`seed workflow parses: ${file}`, () => {
    const raw = parseYaml(readFileSync(join(workflowsDir, file), "utf8"));
    const r = WorkflowSchema.safeParse(raw);
    assert.ok(r.success, `${file} failed WorkflowSchema:\n${issues(r)}`);
  });

  // Vocabulary parity: `model:` on a step/red still PARSES (preprocess aliases
  // it to `activity:`), so safeParse above can't catch it. Inspect the raw YAML
  // directly. This is the exact drift that slipped through last session.
  test(`seed workflow uses current vocab (no deprecated model:): ${file}`, () => {
    const raw = parseYaml(readFileSync(join(workflowsDir, file), "utf8")) as {
      steps?: Array<{ id?: string; model?: unknown; reds?: Array<{ model?: unknown }> }>;
    };
    for (const step of raw.steps ?? []) {
      assert.ok(
        !("model" in step),
        `step '${step.id}' uses deprecated 'model:' — rename to 'activity:'`,
      );
      for (const red of step.reds ?? []) {
        assert.ok(
          !("model" in red),
          `a red on step '${step.id}' uses deprecated 'model:' — rename to 'activity:'`,
        );
      }
    }
  });
}

// ------------------------------------------------------------------
// seeds/runtimes/* parse under RuntimeSchema
// ------------------------------------------------------------------

const runtimesDir = join(seedsDir, "runtimes");
for (const file of ymlFiles(runtimesDir)) {
  test(`seed runtime parses: ${file}`, () => {
    const raw = parseYaml(readFileSync(join(runtimesDir, file), "utf8"));
    const r = RuntimeSchema.safeParse(raw);
    assert.ok(r.success, `${file} failed RuntimeSchema:\n${issues(r)}`);
  });
}

// ------------------------------------------------------------------
// seeds/model-policy.example.yml parses under ModelPolicySchema
// ------------------------------------------------------------------

test("seed model-policy.example.yml parses under ModelPolicySchema", () => {
  const raw = parseYaml(readFileSync(join(seedsDir, "model-policy.example.yml"), "utf8"));
  const r = ModelPolicySchema.safeParse(raw);
  assert.ok(r.success, `model-policy.example.yml failed ModelPolicySchema:\n${issues(r)}`);
});
