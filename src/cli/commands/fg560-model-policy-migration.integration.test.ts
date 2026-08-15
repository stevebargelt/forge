// FG-560 release acceptance: one mixed discovery fleet proves that `forge upgrade`
// applies only safe, per-file policy migrations and leaves every other member honest.

import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { migrateDiscoveredPolicies } from "./upgrade.js";
import type { DiscoveredPolicy, PolicyDiscovery } from "../../v2/model-policy-discovery.js";
import { migrateModelPolicyFile, type MigrateIO } from "../../v2/model-policy-migration.js";
import { ModelPolicySchema } from "../../v2/schema.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "testdata", "model-policy");
const SHIPPED_SEED = join(HERE, "../../../seeds/model-policy.example.yml");

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "fg560-fleet-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function fixture(name: string): string { return readFileSync(join(FIXTURES, name), "utf8"); }

function writePolicy(project: string, content: string): string {
  const path = join(root, project, ".forge", "model-policy.yml");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
  return path;
}

function discovered(state: DiscoveredPolicy["state"], project: string | null, policyPath: string | null, scope: "host" | "project" = "project"): DiscoveredPolicy {
  const projectDir = project === null ? root : join(root, project);
  return {
    scope, state, projectDir, canonicalDir: state === "has-policy" ? projectDir : null,
    policyPath, identityKey: `${scope}:${projectDir}`, projectKey: scope === "host" ? null : project,
    evidenceSources: scope === "host" ? [] : ["runs"], lastSeenAt: scope === "host" ? null : "2026-08-15T00:00:00.000Z",
  };
}

function actions(result: ReturnType<typeof migrateDiscoveredPolicies>): string[] {
  return result.files.map((f) => `${f.projectDir}:${f.verdict ?? f.action}`);
}

test("FG-560: mixed fleet dry-run forecasts the applied upgrade file-for-file and remains idempotent", () => {
  // The host is the corrected shipped seed itself; the registered projects supply
  // absent, v1, customized-v1, unreachable, and newer-version fleet members.
  const hostPath = writePolicy("host", readFileSync(SHIPPED_SEED, "utf8"));
  const absentDir = join(root, "absent");
  mkdirSync(absentDir, { recursive: true });
  const v1Path = writePolicy("v1", fixture("v1-migratable.yml"));
  const customPath = writePolicy("custom", fixture("v1-customized-aliases.yml"));
  const futurePath = writePolicy("future", fixture("future-version.yml"));
  const before = new Map([[hostPath, readFileSync(hostPath, "utf8")], [v1Path, readFileSync(v1Path, "utf8")], [customPath, readFileSync(customPath, "utf8")], [futurePath, readFileSync(futurePath, "utf8")]]);

  const fleet: PolicyDiscovery = {
    host: discovered("has-policy", "host", hostPath, "host"),
    projects: [
      discovered("reachable-no-policy", "absent", null),
      discovered("has-policy", "v1", v1Path),
      discovered("has-policy", "custom", customPath),
      discovered("unreachable-deleted", "deleted", null),
      discovered("has-policy", "future", futurePath),
    ],
    completeness: "historical-best-effort", registeredInspected: 4, registeredUnreachable: 1, registeredNoPath: 0,
  };

  const dry = migrateDiscoveredPolicies(fleet, true);
  const byteForecasts = new Map(
    [v1Path, customPath].map((path) => [path, migrateModelPolicyFile(path, { dryRun: true }).migration.migratedContent]),
  );
  assert.equal(dry.outcome, "action-required");
  assert.deepEqual(dry.files.map((f) => f.action), ["current", "no-policy", "would-migrate", "would-migrate", "unreachable", "newer-unsupported"]);
  for (const [path, bytes] of before) assert.equal(readFileSync(path, "utf8"), bytes, `dry-run must not write ${path}`);

  const applied = migrateDiscoveredPolicies(fleet, false);
  assert.equal(applied.outcome, "action-required", "unreachable/newer files keep the overall result non-success");
  assert.deepEqual(actions(dry), actions(applied), "forecast and apply classify every fleet member identically");
  assert.deepEqual(applied.files.map((f) => f.action), ["current", "no-policy", "migrated", "migrated", "unreachable", "newer-unsupported"]);

  assert.equal(readFileSync(hostPath, "utf8"), before.get(hostPath), "corrected shipped seed is already current and byte-stable");
  assert.equal(readFileSync(futurePath, "utf8"), before.get(futurePath), "future policy is never downgraded");
  assert.match(readFileSync(v1Path, "utf8"), /^schema_version: 2/m);
  assert.match(readFileSync(v1Path, "utf8"), /spec-writer:/);
  assert.match(readFileSync(v1Path, "utf8"), /fast-orchestrator:/);
  for (const [path, forecast] of byteForecasts) {
    assert.equal(readFileSync(path, "utf8"), forecast, `applied bytes equal the dry-run forecast: ${path}`);
  }

  const customized = readFileSync(customPath, "utf8");
  for (const comment of fixture("v1-customized-aliases.yml").split("\n").filter((line) => line.trim().startsWith("#"))) {
    assert.ok(customized.includes(comment.trim()), `custom comment preserved: ${comment.trim()}`);
  }
  assert.match(customized, /unknown_operator_key: retain-me/);
  assert.match(customized, /spec-writer: \{ model: operator-spec-model, cost_tier: premium, tool_capable: true \}/);
  assert.match(customized, /fast-orchestrator: \{ model: operator-fast-model, cost_tier: standard, tool_capable: true \}/);
  assert.ok(customized.indexOf("unknown_operator_key") < customized.indexOf("model_profiles"), "top-level key ordering survives");
  assert.ok(customized.indexOf("reasoning:") < customized.indexOf("spec-writer:"), "map ordering survives");

  const afterFirst = new Map([[hostPath, readFileSync(hostPath, "utf8")], [v1Path, readFileSync(v1Path, "utf8")], [customPath, readFileSync(customPath, "utf8")], [futurePath, readFileSync(futurePath, "utf8")]]);
  const second = migrateDiscoveredPolicies(fleet, false);
  assert.equal(second.outcome, "action-required");
  assert.deepEqual(second.files.map((f) => f.action), ["current", "no-policy", "current", "current", "unreachable", "newer-unsupported"]);
  for (const [path, bytes] of afterFirst) assert.equal(readFileSync(path, "utf8"), bytes, `second upgrade is byte-stable: ${path}`);
});

test("FG-560: a corrupt temporary write leaves the valid source policy authoritative", () => {
  const path = writePolicy("atomic", `schema_version: 2
model_profiles:
  sub:
    provider: anthropic
    auth: subscription
    map:
      reasoning: { model: claude-opus-5, cost_tier: premium }
      fast: { model: claude-haiku-4-5, cost_tier: cheap }
      default: { model: claude-sonnet-4-6, cost_tier: standard }
defaults:
  profile: sub
`);
  const before = readFileSync(path, "utf8");
  const corruptTemp: MigrateIO = {
    readFileSync: (p, enc) => readFileSync(p, enc),
    writeFileSync: (p, _data, enc) => writeFileSync(p, "schema_version: 2\nnot: valid\n", enc),
    renameSync: () => assert.fail("invalid temporary bytes must never be renamed"),
    unlinkSync: (p) => rmSync(p, { force: true }),
  };
  assert.throws(() => migrateModelPolicyFile(path, { io: corruptTemp }), /failed schema validation/);
  assert.equal(readFileSync(path, "utf8"), before, "original bytes remain authoritative after validation failure");
  assert.ok(ModelPolicySchema.safeParse(parseYaml(readFileSync(path, "utf8"))).success, "original policy remains loadable");
});
