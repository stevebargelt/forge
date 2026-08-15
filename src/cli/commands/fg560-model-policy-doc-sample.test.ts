// FG-560 / RF-2: the quick-start policy sample in docs/how-to-model-policy.md must
// stay copy-pasteable without failing closed.
//
// The doc states, one section down from the sample, that an EXPLICIT named activity
// which falls through to `map.default` is refused `activity_unmapped` before the
// container starts. The orchestrator dispatches `spec-writer` and `fast-orchestrator`
// by name (`forge invoke … --model spec-writer`), so a sample whose profile map omits
// those aliases builds a policy where those named activities fail closed — which is the
// exact failure FG-560 exists to prevent. `forge upgrade` SEEDS those same aliases
// (ALIAS_PAIRS), so the advertised current-schema sample must already carry every one.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { ALIAS_PAIRS } from "../../v2/model-policy-migration.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const DOC = "docs/how-to-model-policy.md";

/** Every fenced ```yaml block in the doc, in order. */
function yamlBlocks(md: string): string[] {
  return [...md.matchAll(/```yaml\n([\s\S]*?)```/g)].map((m) => m[1]!);
}

/** The quick-start sample is the one that actually defines model_profiles. */
function quickStartPolicy(): Record<string, unknown> {
  const md = readFileSync(join(repoRoot, DOC), "utf8");
  const block = yamlBlocks(md).find((b) => /model_profiles:/.test(b));
  assert.ok(block, `no model_profiles sample found in ${DOC}`);
  return parseYaml(block) as Record<string, unknown>;
}

test("FG-560/RF-2: the quick-start sample's primary profile maps every orchestrator activity alias — no explicit activity falls to activity_unmapped", () => {
  const policy = quickStartPolicy();
  const profiles = policy.model_profiles as Record<string, { map?: Record<string, unknown> }>;
  const primary = (policy.defaults as { profile?: string } | undefined)?.profile;
  assert.ok(primary && profiles[primary], "defaults.profile must name a defined profile");

  const map = profiles[primary]!.map ?? {};
  // A profile that maps named activities at all (has more than just `default`) must
  // map every alias the orchestrator dispatches by name — otherwise a copy of the
  // sample refuses those activities. The default-ONLY catch-all profiles the doc
  // shows (e.g. claude-bedrock here) are intentionally out of scope, exactly as the
  // activity_unmapped rule and the migration both carve out.
  const named = Object.keys(map).filter((k) => k !== "default");
  assert.ok(named.length > 0, "the primary profile is expected to map named activities");
  for (const { dest } of ALIAS_PAIRS) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(map, dest),
      `the sample's ${primary} map omits "${dest}" — an operator copying it would have that explicit activity refused activity_unmapped. forge upgrade seeds this alias; the advertised sample must carry it too.`
    );
  }
});

test("FG-560/RF-2: the sample also lists the orchestrator activity aliases under defaults.activity", () => {
  const policy = quickStartPolicy();
  const activity = (policy.defaults as { activity?: Record<string, unknown> } | undefined)?.activity ?? {};
  for (const { dest } of ALIAS_PAIRS) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(activity, dest),
      `defaults.activity omits "${dest}" — the sample should route the orchestrator's named activities as explicitly as it maps them.`
    );
  }
});
