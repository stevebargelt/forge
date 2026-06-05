// Acceptance: every installed runtime YAML seed at seeds/runtimes/ parses
// + Zod-validates. Adding a new runtime YAML to seeds/runtimes/ means
// adding it here too.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { RuntimeSchema, ModelPolicySchema, resolveRuntimeMetadata } from "./schema.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(here, "..", "..");
const SEEDS_RUNTIMES_DIR = join(REPO_ROOT, "seeds", "runtimes");

const RUNTIMES = ["claude-bedrock", "claude-oauth", "claude-apikey", "codex-subscription"];

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

// #292: every seed must DECLARE its execution metadata explicitly (the seam's
// whole point — no relying on inference). resolveRuntimeMetadata then returns the
// declared values verbatim.
const EXPECTED_METADATA: Record<string, ReturnType<typeof resolveRuntimeMetadata>> = {
  "claude-bedrock": { runtimeKind: "claude-code", logFormat: "claude-stream-json", promptStrategy: "claude-stdin-package", authStrategy: "aws-bedrock" },
  "claude-oauth": { runtimeKind: "claude-code", logFormat: "claude-stream-json", promptStrategy: "claude-stdin-package", authStrategy: "oauth-volume" },
  "claude-apikey": { runtimeKind: "claude-code", logFormat: "claude-stream-json", promptStrategy: "claude-stdin-package", authStrategy: "env-provider-api-key" },
  "codex-subscription": { runtimeKind: "codex", logFormat: "codex-jsonl", promptStrategy: "stdin-prepend", authStrategy: "codex-auth" },
};

for (const [name, expected] of Object.entries(EXPECTED_METADATA)) {
  test(`runtime seed '${name}.yml' declares #292 execution metadata explicitly`, () => {
    const parsed = parseYaml(readFileSync(join(SEEDS_RUNTIMES_DIR, `${name}.yml`), "utf8"));
    const rt = RuntimeSchema.parse(parsed);
    assert.ok(rt.log_format, "log_format must be declared, not left to inference");
    assert.ok(rt.runtime_kind && rt.prompt_strategy && rt.auth_strategy, "all four metadata fields declared");
    assert.deepEqual(resolveRuntimeMetadata(rt), expected);
  });
}

test("model-policy.example.yml parses + Zod-validates", () => {
  const path = join(REPO_ROOT, "seeds", "model-policy.example.yml");
  const raw = readFileSync(path, "utf8");
  const parsed = parseYaml(raw);
  const r = ModelPolicySchema.safeParse(parsed);
  assert.ok(r.success, r.success ? "" : JSON.stringify(r.error.issues, null, 2));
});
