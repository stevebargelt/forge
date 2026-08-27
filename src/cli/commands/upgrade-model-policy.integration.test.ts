// FG-560 (step 7): `forge upgrade` model-policy migration — the discovery × per-file
// composition, exercised against the real filesystem (and, end-to-end, the real
// discovery/DB path). Proves: the dry-run forecast equals the real run file-for-file;
// a migratable file is migrated ATOMICALLY while needs-human / unreachable files are
// left untouched; a partial fleet is reported per-file and never unit-rolled-back;
// and the overall result is NON-SUCCESS while action remains.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  migrateDiscoveredPolicies,
  runUpgrade,
  unresolvedReasons,
  type ModelPolicyFileReport,
  type UpgradeStepOutcomes,
} from "./upgrade.js";
import type { PolicyDiscovery, DiscoveredPolicy } from "../../v2/model-policy-discovery.js";

const V1_MIGRATABLE = `# a legacy host policy — no schema_version
on_unavailable: fail
model_profiles:
  sub:
    provider: anthropic
    auth: subscription
    map:
      reasoning: { model: claude-opus-5, cost_tier: premium }
      review: { model: claude-sonnet-4-6, cost_tier: standard }
      fast: { model: claude-haiku-4-5, cost_tier: cheap }
      default: { model: claude-sonnet-4-6, cost_tier: standard }
defaults:
  profile: sub
  activity:
    reasoning: sub
    fast: sub
`;

// Not default-only (has review + default), no reasoning/fast source → needs a human.
const V1_NEEDS_HUMAN = `schema_version: 2
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

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "fg560-upgrade-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** runUpgrade signals failure via process.exitCode; a leaked 1 would fail this whole
 *  file. Capture what it set (and swallow the --json stdout blob) and restore. */
function drive<T>(fn: () => T): T {
  const before = process.exitCode;
  const realLog = console.log;
  process.exitCode = undefined;
  console.log = () => {};
  try {
    return fn();
  } finally {
    console.log = realLog;
    process.exitCode = before;
  }
}

function hostPolicy(state: DiscoveredPolicy["state"], policyPath: string | null): DiscoveredPolicy {
  return {
    scope: "host",
    state,
    projectDir: root,
    canonicalDir: null,
    policyPath,
    identityKey: "host",
    projectKey: null,
    evidenceSources: [],
    lastSeenAt: null,
  };
}

function projectPolicy(state: DiscoveredPolicy["state"], dir: string, policyPath: string | null): DiscoveredPolicy {
  return {
    scope: "project",
    state,
    projectDir: dir,
    canonicalDir: state === "has-policy" ? dir : null,
    policyPath,
    identityKey: `id:${dir}`,
    projectKey: null,
    evidenceSources: ["runs"],
    lastSeenAt: "2026-08-01T00:00:00.000Z",
  };
}

function writePolicy(name: string, content: string): string {
  const dir = join(root, name, ".forge");
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "model-policy.yml");
  writeFileSync(p, content, "utf8");
  return p;
}

test("dry-run forecast equals the real-run outcome file-for-file across a mixed fleet", () => {
  const hostPathDry = writePolicy("host-dry", V1_MIGRATABLE);
  const projPathDry = writePolicy("proj-dry", V1_MIGRATABLE);
  const humanPathDry = writePolicy("human-dry", V1_NEEDS_HUMAN);

  const discovery = (hostPath: string, projPath: string, humanPath: string): PolicyDiscovery => ({
    host: hostPolicy("has-policy", hostPath),
    projects: [
      projectPolicy("has-policy", join(root, "proj-dry"), projPath),
      projectPolicy("has-policy", join(root, "human-dry"), humanPath),
      projectPolicy("unreachable-deleted", "/gone/clone", null),
    ],
    completeness: "historical-best-effort",
    registeredInspected: 2,
    registeredUnreachable: 1,
    registeredNoPath: 0,
  });

  const dry = migrateDiscoveredPolicies(discovery(hostPathDry, projPathDry, humanPathDry), true);
  // Dry run wrote nothing.
  assert.equal(readFileSync(hostPathDry, "utf8"), V1_MIGRATABLE);
  assert.equal(readFileSync(projPathDry, "utf8"), V1_MIGRATABLE);

  // A fresh set of identical files for the REAL run.
  const hostPathReal = writePolicy("host-real", V1_MIGRATABLE);
  const projPathReal = writePolicy("proj-real", V1_MIGRATABLE);
  const humanPathReal = writePolicy("human-real", V1_NEEDS_HUMAN);
  const real = migrateDiscoveredPolicies(
    {
      host: hostPolicy("has-policy", hostPathReal),
      projects: [
        projectPolicy("has-policy", join(root, "proj-real"), projPathReal),
        projectPolicy("has-policy", join(root, "human-real"), humanPathReal),
        projectPolicy("unreachable-deleted", "/gone/clone", null),
      ],
      completeness: "historical-best-effort",
      registeredInspected: 2,
      registeredUnreachable: 1,
      registeredNoPath: 0,
    },
    false,
  );

  // Same per-file verdicts; the ONLY difference is would-migrate vs migrated.
  const actions = (files: ModelPolicyFileReport[]) => files.map((f) => `${f.scope}:${f.verdict ?? f.action}`);
  assert.deepEqual(actions(dry.files), actions(real.files));
  assert.equal(dry.outcome, "action-required"); // the needs-human + unreachable remain
  assert.equal(real.outcome, "action-required");

  // Real run migrated the two migratable files atomically…
  assert.match(readFileSync(hostPathReal, "utf8"), /schema_version: 2/);
  assert.match(readFileSync(hostPathReal, "utf8"), /spec-writer:/);
  assert.match(readFileSync(projPathReal, "utf8"), /fast-orchestrator:/);
  // …and left the needs-human file BYTE-IDENTICAL (never half-migrated, never rolled back).
  assert.equal(readFileSync(humanPathReal, "utf8"), V1_NEEDS_HUMAN);

  // The migratable files STAY migrated even though the fleet outcome is action-required
  // — per-file, never unit-rolled-back.
  const hostReport = real.files.find((f) => f.scope === "host")!;
  assert.equal(hostReport.action, "migrated");
  const humanReport = real.files.find((f) => f.policyPath === humanPathReal)!;
  assert.equal(humanReport.action, "needs-human-decision");
  const unreachableReport = real.files.find((f) => f.discoveryState === "unreachable-deleted")!;
  assert.equal(unreachableReport.action, "unreachable");
});

test("a clean migratable fleet migrates and the overall result is SUCCESS", () => {
  const hostPath = writePolicy("host-clean", V1_MIGRATABLE);
  const res = migrateDiscoveredPolicies(
    {
      host: hostPolicy("has-policy", hostPath),
      projects: [projectPolicy("reachable-no-policy", join(root, "legacy-proj"), null)],
      completeness: "historical-best-effort",
      registeredInspected: 1,
      registeredUnreachable: 0,
      registeredNoPath: 0,
    },
    false,
  );
  assert.equal(res.outcome, "migrated");
  // A fully-migrated + no-policy fleet has no unresolved reason.
  const outcomes = baseOutcomes({ modelPolicy: res.outcome });
  assert.deepEqual(unresolvedReasons(outcomes), []);
});

test("end-to-end runUpgrade migrates the host policy and reports it per-file in --json", () => {
  const forgeHome = process.env.FORGE_HOME!;
  const hostPath = join(forgeHome, "model-policy.yml");
  writeFileSync(hostPath, V1_MIGRATABLE, "utf8");
  try {
    // A deliberately minimal release (no install-seeds.sh) — other steps report
    // their own states; we assert ONLY the model-policy fields, which run
    // unconditionally after the seed-generation block.
    const emptyAssets = mkdtempSync(join(tmpdir(), "fg560-assets-"));
    const result = drive(() =>
      runUpgrade(
        { skipProject: true, skipGit: true, skipNpm: true, json: true },
        { mode: "release", assetsDir: emptyAssets, devDir: join(root, "no-dev") },
      ),
    );
    assert.equal(result.modelPolicy, "migrated");
    const hostReport = result.modelPolicies.find((f) => f.scope === "host");
    assert.ok(hostReport, "host policy appears in the per-file report");
    assert.equal(hostReport!.action, "migrated");
    // The file on disk is now a valid v2 policy with the added aliases.
    const out = readFileSync(hostPath, "utf8");
    assert.match(out, /schema_version: 2/);
    assert.match(out, /spec-writer:/);
    // The model-policy step contributed NO unresolved reason (a clean migration).
    assert.ok(!result.unresolved.some((r) => r.includes("model-policy migration")));
    rmSync(emptyAssets, { recursive: true, force: true });
  } finally {
    rmSync(hostPath, { force: true });
  }
});

test("end-to-end runUpgrade leaves a needs-human host policy untouched and reports NON-SUCCESS", () => {
  const forgeHome = process.env.FORGE_HOME!;
  const hostPath = join(forgeHome, "model-policy.yml");
  writeFileSync(hostPath, V1_NEEDS_HUMAN, "utf8");
  try {
    const emptyAssets = mkdtempSync(join(tmpdir(), "fg560-assets-"));
    const result = drive(() =>
      runUpgrade(
        { skipProject: true, skipGit: true, skipNpm: true, json: true },
        { mode: "release", assetsDir: emptyAssets, devDir: join(root, "no-dev") },
      ),
    );
    assert.equal(result.modelPolicy, "action-required");
    // File left byte-identical.
    assert.equal(readFileSync(hostPath, "utf8"), V1_NEEDS_HUMAN);
    // The model-policy action-required reason is present → NON-SUCCESS.
    assert.ok(result.unresolved.some((r) => r.includes("model-policy migration")));
    assert.equal(result.ok, false);
    rmSync(emptyAssets, { recursive: true, force: true });
  } finally {
    rmSync(hostPath, { force: true });
  }
});

// A minimal all-resolved outcomes object with one field overridden — used to assert
// the model-policy step's contribution to `unresolvedReasons` in isolation.
function baseOutcomes(over: Partial<UpgradeStepOutcomes>): UpgradeStepOutcomes {
  return {
    gitPull: "skipped",
    npmInstall: "skipped",
    assetInstall: "installed",
    hostEditMigration: "nothing-to-back-up",
    seedGeneration: "not-run",
    modelPolicy: "none",
    authoredRetention: "none",
    routingPolicy: "no-raci",
    projectInit: "skipped",
    docsSurfaces: "not-run",
    slashCommands: "not-run",
    adapterSurfaces: "not-run",
    imageRebuild: "skipped",
    releaseCheck: "skipped-dry-run",
    ...over,
  };
}
