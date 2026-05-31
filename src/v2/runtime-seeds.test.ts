// Acceptance: every installed runtime YAML seed at seeds/runtimes/ parses
// + Zod-validates. Adding a new runtime YAML to seeds/runtimes/ means
// adding it here too.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { RuntimeSchema, ModelPolicySchema } from "./schema.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(here, "..", "..");
const SEEDS_RUNTIMES_DIR = join(REPO_ROOT, "seeds", "runtimes");

const RUNTIMES = ["claude-bedrock", "claude-oauth", "claude-apikey"];

for (const name of RUNTIMES) {
  test(`runtime seed '${name}.yml' parses + Zod-validates`, () => {
    const path = join(SEEDS_RUNTIMES_DIR, `${name}.yml`);
    const raw = readFileSync(path, "utf8");
    const parsed = parseYaml(raw);
    const r = RuntimeSchema.safeParse(parsed);
    assert.ok(
      r.success,
      r.success ? "" : JSON.stringify(r.error.issues, null, 2)
    );
    assert.equal(r.data!.name, name, "runtime name should match filename");
  });
}

test("model-policy.example.yml parses + Zod-validates", () => {
  const path = join(REPO_ROOT, "seeds", "model-policy.example.yml");
  const raw = readFileSync(path, "utf8");
  const parsed = parseYaml(raw);
  const r = ModelPolicySchema.safeParse(parsed);
  assert.ok(r.success, r.success ? "" : JSON.stringify(r.error.issues, null, 2));
});
