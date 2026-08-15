import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  classifyModelPolicyContent,
  migrateModelPolicyFile,
  type MigrateIO,
} from "./model-policy-migration.js";
import { ModelPolicySchema } from "./schema.js";

// A v1 (legacy) fixture: no schema_version, comments throughout, custom providers +
// models, custom agent overrides, an unknown operator-added key, a PRE-EXISTING
// spec-writer choice that differs from the canonical source (must be preserved), and
// a pi-groq default-only profile (must NOT trip needs-human-decision).
const V1_FIXTURE = `# forge model policy — legacy v1 (hand-written, no schema_version)
# operator's own notes: keep these verbatim

# global default when a profile has no working auth
on_unavailable: fail

model_profiles:
  # personal subscription
  claude-subscription:
    provider: anthropic
    auth: subscription
    # an unknown key an operator added — must survive migration
    notes: do-not-touch
    map:
      reasoning: { model: claude-opus-5, cost_tier: premium }
      review: { model: claude-sonnet-4-6, cost_tier: standard }
      fast: { model: claude-haiku-4-5, cost_tier: cheap }
      default: { model: claude-sonnet-4-6, cost_tier: standard }
      # the operator already picked a spec-writer, and it DIFFERS from reasoning —
      # migration must never overwrite it
      spec-writer: { model: claude-sonnet-4-6, cost_tier: standard }
  # a custom provider/model an operator wired by hand
  local-ollama:
    provider: ollama
    runtime: pi-apikey
    auth: api
    map:
      reasoning: { model: qwen2.5-coder:32b, cost_tier: cheap, tool_capable: true }
      fast: { model: qwen2.5-coder:7b, cost_tier: cheap, tool_capable: true }
      default: { model: qwen2.5-coder:7b, cost_tier: cheap, tool_capable: true }
  # default-only catch-all by design — OUT OF SCOPE for alias migration
  pi-groq:
    provider: groq
    runtime: pi-apikey
    auth: api
    map:
      default: { model: moonshotai/kimi-k2-instruct, cost_tier: standard, tool_capable: true }

defaults:
  profile: claude-subscription
  activity:
    reasoning: claude-subscription
    review: claude-subscription
    fast: local-ollama

overrides:
  agents:
    red-security: claude-subscription
    red-wide: local-ollama

allowed_profiles:
  - claude-subscription
  - local-ollama
`;

function writeTmp(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "mp-migrate-"));
  const path = join(dir, "model-policy.yml");
  writeFileSync(path, content, "utf8");
  return path;
}

test("v1 fixture migrates: schema_version stamped, aliases added, everything else preserved", () => {
  const path = writeTmp(V1_FIXTURE);
  const res = migrateModelPolicyFile(path);
  assert.equal(res.migration.verdict, "migratable");
  assert.equal(res.written, true);
  const out = readFileSync(path, "utf8");

  // schema_version stamped.
  assert.match(out, /schema_version: 2/);

  // Every comment from the source survives (content, not exact position).
  for (const line of V1_FIXTURE.split("\n")) {
    const t = line.trim();
    if (t.startsWith("#")) assert.ok(out.includes(t), `comment preserved: ${t}`);
  }

  // Unknown key + custom provider/model preserved.
  assert.match(out, /notes: do-not-touch/);
  assert.match(out, /provider: ollama/);
  assert.match(out, /qwen2\.5-coder:32b/);

  // The pre-existing spec-writer choice is NOT overwritten (still sonnet, not opus).
  assert.match(out, /spec-writer: \{ model: claude-sonnet-4-6, cost_tier: standard \}/);

  // fast-orchestrator was added to claude-subscription, copied from `fast` (haiku).
  assert.match(out, /fast-orchestrator: \{ model: claude-haiku-4-5, cost_tier: cheap \}/);

  // The added aliases resolve as EXACT map hits, and defaults.activity gained them.
  const policy = loadPolicyFrom(path);
  const subMap = policy.model_profiles["claude-subscription"]!.map;
  assert.ok(subMap["spec-writer"], "spec-writer present in profile map");
  assert.ok(subMap["fast-orchestrator"], "fast-orchestrator present in profile map");
  assert.equal(policy.defaults.activity["spec-writer"], "claude-subscription");
  assert.equal(policy.defaults.activity["fast-orchestrator"], "local-ollama");
});

// The migrated file must be a valid, loadable v2 policy — parse + schema-validate.
function loadPolicyFrom(path: string) {
  const parsed = ModelPolicySchema.safeParse(parseYaml(readFileSync(path, "utf8")));
  assert.ok(parsed.success, "migrated file validates as a v2 policy");
  return parsed.data;
}

test("re-migration is a byte-stable no-op (verdict=current)", () => {
  const path = writeTmp(V1_FIXTURE);
  migrateModelPolicyFile(path);
  const afterFirst = readFileSync(path, "utf8");

  const second = migrateModelPolicyFile(path);
  assert.equal(second.migration.verdict, "current");
  assert.equal(second.written, false);
  assert.equal(readFileSync(path, "utf8"), afterFirst, "second migration is byte-identical");

  // A third pass is likewise a no-op.
  const third = migrateModelPolicyFile(path);
  assert.equal(third.migration.verdict, "current");
  assert.equal(readFileSync(path, "utf8"), afterFirst);
});

test("dry-run forecast equals the applied result file-for-file", () => {
  const dryPath = writeTmp(V1_FIXTURE);
  const realPath = writeTmp(V1_FIXTURE);

  const forecast = migrateModelPolicyFile(dryPath, { dryRun: true });
  assert.equal(forecast.written, false);
  assert.equal(readFileSync(dryPath, "utf8"), V1_FIXTURE, "dry-run writes nothing");

  const applied = migrateModelPolicyFile(realPath);
  assert.equal(applied.written, true);

  // Same verdict, and the forecast's migratedContent equals the bytes on disk.
  assert.equal(forecast.migration.verdict, applied.migration.verdict);
  assert.equal(forecast.migration.migratedContent, readFileSync(realPath, "utf8"));
});

test("a default-only profile (pi-groq) classifies current, never needs-human-decision", () => {
  const onlyDefault = `schema_version: 2
model_profiles:
  pi-groq:
    provider: groq
    runtime: pi-apikey
    auth: api
    map:
      default: { model: moonshotai/kimi-k2-instruct, cost_tier: standard, tool_capable: true }
defaults:
  profile: pi-groq
`;
  const m = classifyModelPolicyContent(onlyDefault);
  assert.equal(m.verdict, "current");
  assert.equal(m.humanDecisions.length, 0);
  assert.equal(m.migratedContent, null);
});

test("needs-human-decision: a mapping with a `default` but no reasoning/fast source", () => {
  // Not default-only (has `review` and `default`), so refusing to copy `default` is
  // the whole point — the file is left UNCHANGED.
  const ambiguous = `schema_version: 2
model_profiles:
  weird:
    provider: anthropic
    auth: api
    map:
      review: { model: claude-sonnet-4-6, cost_tier: standard }
      default: { model: claude-sonnet-4-6, cost_tier: standard }
defaults:
  profile: weird
`;
  const m = classifyModelPolicyContent(ambiguous);
  assert.equal(m.verdict, "needs-human-decision");
  assert.ok(m.humanDecisions.length >= 1);
  assert.equal(m.migratedContent, null, "no bytes are produced for a human-decision file");
});

test("changed-if-applied: an already-v2 file still missing an alias entry", () => {
  const v2MissingAlias = `schema_version: 2
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
`;
  const m = classifyModelPolicyContent(v2MissingAlias);
  assert.equal(m.verdict, "changed-if-applied");
  assert.ok(m.migratedContent);
  assert.match(m.migratedContent!, /spec-writer: \{ model: claude-opus-5, cost_tier: premium \}/);
  assert.match(m.migratedContent!, /fast-orchestrator: \{ model: claude-haiku-4-5, cost_tier: cheap \}/);
});

test("newer-unsupported: schema_version above current is left untouched", () => {
  const newer = `schema_version: 99
model_profiles:
  sub:
    provider: anthropic
    auth: subscription
    map:
      default: { model: x, cost_tier: cheap }
defaults:
  profile: sub
`;
  const m = classifyModelPolicyContent(newer);
  assert.equal(m.verdict, "newer-unsupported");
  assert.equal(m.migratedContent, null);
});

test("atomic-write recovery: a failed rename leaves the original byte-identical and loadable", () => {
  const path = writeTmp(V1_FIXTURE);
  const before = readFileSync(path, "utf8");

  const failingRename: MigrateIO = {
    readFileSync: (p, e) => readFileSync(p, e),
    writeFileSync: (p, d, e) => writeFileSync(p, d, e),
    renameSync: () => {
      throw new Error("simulated rename failure");
    },
    unlinkSync: (p) => rmSync(p, { force: true }),
  };

  assert.throws(() => migrateModelPolicyFile(path, { io: failingRename }), /simulated rename failure/);

  // Original untouched and still a valid legacy file.
  assert.equal(readFileSync(path, "utf8"), before, "original is byte-identical after a failed write");
  // No stray temp files left behind.
  const dir = join(path, "..");
  const strays = readdirSync(dir).filter((f) => f.includes(".migrate-"));
  assert.deepEqual(strays, [], "temp file cleaned up");
});

test("atomic-write recovery: a validation failure (corrupt temp bytes) never replaces the original", () => {
  const path = writeTmp(V1_FIXTURE);
  const before = readFileSync(path, "utf8");

  // Corrupt the bytes at write time — the temp will fail v2 validation, so the
  // rename must never happen.
  const corruptingWrite: MigrateIO = {
    readFileSync: (p, e) => readFileSync(p, e),
    writeFileSync: (p, _d, e) => writeFileSync(p, "schema_version: 2\nnot: a valid policy\n", e),
    renameSync: (f, t) => {
      throw new Error(`rename should NOT be reached: ${f} -> ${t}`);
    },
    unlinkSync: (p) => rmSync(p, { force: true }),
  };

  assert.throws(() => migrateModelPolicyFile(path, { io: corruptingWrite }), /failed schema validation/);
  assert.equal(readFileSync(path, "utf8"), before, "original untouched on validation failure");
  assert.ok(existsSync(path));
});

test("unparseable YAML throws rather than guessing", () => {
  assert.throws(() => classifyModelPolicyContent("model_profiles: [unterminated"), /cannot parse YAML|parse/i);
});
