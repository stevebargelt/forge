// FG-795 — guard the Sonnet 5 default swap in the forge-shipped seeds.
//
// Every forge-shipped default now names Claude Sonnet 5 (claude-sonnet-5 /
// us.anthropic.claude-sonnet-5) instead of Sonnet 4.6. This test locks that
// in so the swap cannot silently regress:
//   (a) no seeds/runtimes/*.yml nor seeds/model-policy.example.yml contains the
//       substring 'sonnet-4-6' (covers both short and Bedrock-prefixed ids), and
//   (b) each seeds/runtimes/*.yml still parses + validates under RuntimeSchema
//       (the same loader path seed-parity.test.ts exercises).
//
// Pure fs read — no subprocess, unit tier.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { RuntimeSchema } from "./schema.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const seedsDir = join(repoRoot, "seeds");
const runtimesDir = join(seedsDir, "runtimes");

function ymlFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .sort();
}

function issues(r: { success: boolean; error?: { issues: unknown[] } }): string {
  return r.success ? "" : JSON.stringify(r.error!.issues, null, 2);
}

// (a) no shipped seed still names Sonnet 4.6.
for (const file of ymlFiles(runtimesDir)) {
  test(`seed runtime free of sonnet-4-6: ${file}`, () => {
    const raw = readFileSync(join(runtimesDir, file), "utf8");
    assert.ok(
      !raw.includes("sonnet-4-6"),
      `${file} still contains 'sonnet-4-6' — Sonnet 5 default regressed`,
    );
  });
}

test("seed model-policy.example.yml free of sonnet-4-6", () => {
  const raw = readFileSync(join(seedsDir, "model-policy.example.yml"), "utf8");
  assert.ok(
    !raw.includes("sonnet-4-6"),
    "model-policy.example.yml still contains 'sonnet-4-6' — Sonnet 5 default regressed",
  );
});

// FG-803: no shipped seed names a legacy Opus id. The bare-Opus-5 pattern must
// not match claude-opus-5-5 (the current default) — hence the lookahead.
const OPUS_4_8 = /claude-opus-4-8\b/;
const BARE_OPUS_5 = /claude-opus-5(?![-.\d])/;
const LEGACY_OPUS = [OPUS_4_8, BARE_OPUS_5];

test("legacy-Opus patterns spare claude-opus-5-5 but catch the legacy ids", () => {
  for (const re of LEGACY_OPUS) assert.ok(!re.test("spec-writer: claude-opus-5-5"), `${re} matched claude-opus-5-5`);
  assert.ok(OPUS_4_8.test("spec-writer: claude-opus-4-8"));
  assert.ok(BARE_OPUS_5.test("{ model: claude-opus-5, cost_tier: premium }"));
  assert.ok(BARE_OPUS_5.test("spec-writer: claude-opus-5\n"));
});

for (const file of [...ymlFiles(runtimesDir).map((f) => join("runtimes", f)), "model-policy.example.yml"]) {
  test(`seed free of legacy Opus ids: ${file}`, () => {
    const raw = readFileSync(join(seedsDir, file), "utf8");
    for (const re of LEGACY_OPUS) {
      assert.ok(!re.test(raw), `${file} matches ${re} — Opus 5.5 default regressed`);
    }
  });
}

// (b) the runtime seeds still load + validate through the existing schema.
for (const file of ymlFiles(runtimesDir)) {
  test(`seed runtime still validates under RuntimeSchema: ${file}`, () => {
    const raw = parseYaml(readFileSync(join(runtimesDir, file), "utf8"));
    const r = RuntimeSchema.safeParse(raw);
    assert.ok(r.success, `${file} failed RuntimeSchema:\n${issues(r)}`);
  });
}
