// FG-583 — the ROUTING-POLICY AUTHORITY MODEL, proven end to end.
//
// THE INVARIANT. When the effective routing source is HOST, the policy in force is
// the one COMPILED INTO the published seed generation — NEVER the flat
// ~/.forge/routing-policy.yml (retained only for the FG-579 drift detector / doctor
// registry, never a dispatch source). This file proves it three ways:
//
//   1. FLAT-POLICY MUTATION. Publish a generation, mutate the flat
//      ~/.forge/routing-policy.yml to a UNIQUE marker, and prove that NEITHER an
//      anchored resolution NOR a fresh host resolution NOR the governance view ever
//      reflects the marker — the generation's policy is authoritative.
//   2. NO-GENERATION, BY CONSUMER CLASS. A DISPATCH gate (route preflight) refuses;
//      an OPERATOR view (governanceView, the routingGovernance core) reports the
//      NAMED no-generation state — never an empty matrix read from a missing flat path.
//   3. HOST-DEFAULT MATRIX. routingGovernance/governanceView populates from the
//      generation when one is present, and reports the named state when none is.
//
// Every test uses a DISPOSABLE FORGE_HOME. The real ~/.forge is NEVER touched.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify as yamlStringify } from "yaml";
import { publishSeedGeneration, resolveSeedGeneration, GENERATION_ROUTING_POLICY } from "../v2/seed-generation.js";
import { compileRaciDocument } from "./compile.js";
import { resolvePolicyPath } from "./project.js";
import { governanceView, loadPolicy } from "./governance.js";
import { defaultRouteKeyValidator } from "../cli/route-preflight.js";
import { ROUTING_POLICY_PATH } from "../util/paths.js";

// A single-route RACI whose derived policy the generation carries. `responsible`
// is the field we watch: the generation compiles it to `engineer`; the flat mutant
// below rewrites it to a unique marker that must never surface.
const RACI = `### route: implementation_full

classification_hints: feature, refactor
responsible: engineer
accountable: human
path: workflow
consulted: none
required_followups: none
informed: user_summary
force_rules: none`;

const FLAT_MARKER = "flat-marker-never-read";
const MUTANT_RACI = RACI.replace("responsible: engineer", `responsible: ${FLAT_MARKER}`);

function workflowYaml(name: string): string {
  return [`name: ${name}`, `description: "workflow ${name}"`, `steps:`, `  - id: only`, `    agent: architecture-advisor`, ``].join("\n");
}
function runtimeYaml(name: string): string {
  return [
    `name: ${name}`,
    `description: "runtime ${name}"`,
    `runtime_kind: claude-code`,
    `log_format: claude-stream-json`,
    `prompt_strategy: claude-stdin-package`,
    `auth_strategy: env-provider-api-key`,
    `image: agent-dev-worker:latest`,
    `models:`,
    `  default: test-model`,
    ``,
  ].join("\n");
}

/** A release asset tree <root>/seeds/{workflows,runtimes} the generation is sourced
 *  from. `trustedAssetRoot` injection makes publishSeedGeneration accept it. */
function buildAssetRoot(base: string): string {
  const root = join(base, "release");
  mkdirSync(join(root, "seeds", "workflows"), { recursive: true });
  mkdirSync(join(root, "seeds", "runtimes"), { recursive: true });
  writeFileSync(join(root, "seeds", "workflows", "feature.yml"), workflowYaml("feature"));
  writeFileSync(join(root, "seeds", "runtimes", "claude-apikey.yml"), runtimeYaml("claude-apikey"));
  return root;
}

let tmp: string;
let home: string;
let projectDir: string;
let savedHome: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "fg583-authority-"));
  home = join(tmp, "forge-home");
  projectDir = join(tmp, "project"); // no .forge → host resolution
  mkdirSync(home, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  savedHome = process.env.FORGE_HOME;
  process.env.FORGE_HOME = home;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.FORGE_HOME;
  else process.env.FORGE_HOME = savedHome;
  rmSync(tmp, { recursive: true, force: true });
});

/** Publish a generation carrying the RACI-derived routing policy, and write a
 *  MUTANT flat routing-policy.yml alongside it. Returns the held anchor. */
function publishWithFlatMutant() {
  const assets = buildAssetRoot(tmp);
  const raciPath = join(tmp, "forge-raci.md");
  writeFileSync(raciPath, RACI);
  publishSeedGeneration({ home, assetsDir: assets, trustedAssetRoot: () => assets, raciPath });
  // The flat file exists on disk and is itself a VALID policy — so if any consumer
  // wrongly read it, the marker WOULD surface. It must not.
  writeFileSync(ROUTING_POLICY_PATH, yamlStringify(compileRaciDocument(MUTANT_RACI)));
  const anchor = resolveSeedGeneration(home);
  assert.ok(anchor, "a complete generation is published");
  return anchor!;
}

test("FG-583 flat-policy mutation: a fresh HOST resolution reads the GENERATION's policy, never the flat marker", () => {
  publishWithFlatMutant();
  const resolved = resolvePolicyPath(undefined);
  assert.equal(resolved.source, "host");
  assert.notEqual(resolved.path, ROUTING_POLICY_PATH, "the resolved policy path is the generation's, NOT the flat file");
  assert.ok(resolved.path.endsWith(GENERATION_ROUTING_POLICY));
  assert.equal(resolved.exists, true);
  const policy = loadPolicy(resolved.path);
  assert.ok(policy);
  assert.equal(policy!.routes["implementation_full"]!.responsible, "engineer", "the generation's policy is authoritative");
  assert.notEqual(policy!.routes["implementation_full"]!.responsible, FLAT_MARKER, "the flat marker was never read");
});

test("FG-583 flat-policy mutation: an ANCHORED resolution stays on the generation's policy, never the flat marker", () => {
  const anchor = publishWithFlatMutant();
  const resolved = resolvePolicyPath(undefined, anchor);
  assert.equal(resolved.generationRoot, anchor.root, "the anchored resolution pins the held generation");
  const policy = loadPolicy(resolved.path);
  assert.equal(policy!.routes["implementation_full"]!.responsible, "engineer");
  assert.notEqual(policy!.routes["implementation_full"]!.responsible, FLAT_MARKER);
});

test("FG-583 flat-policy mutation: the OPERATOR governance view resolves from the generation, never the flat marker", () => {
  publishWithFlatMutant();
  const view = governanceView({});
  assert.ok(view.ok, "governance resolves from the generation");
  if (view.ok) {
    assert.equal(view.routes["implementation_full"]!.responsible, "engineer");
    assert.notEqual(view.routes["implementation_full"]!.responsible, FLAT_MARKER);
    assert.notEqual(view.path, ROUTING_POLICY_PATH, "the governance path is the generation's, not the flat file");
  }
});

test("FG-583 no-generation, DISPATCH consumer: the route-preflight gate REFUSES with the named state (never reads flat)", () => {
  // A flat routing-policy.yml exists on disk, but with NO generation a dispatch gate
  // must refuse rather than route from it.
  writeFileSync(ROUTING_POLICY_PATH, yamlStringify(compileRaciDocument(MUTANT_RACI)));
  const res = defaultRouteKeyValidator("implementation_full", projectDir);
  assert.equal(res.ok, false, "a dispatch gate refuses on a no-generation host");
  if (!res.ok) assert.match(res.message, /no seed generation is published/);
});

test("FG-583 no-generation, OPERATOR consumer: the governance view reports the NAMED state, not an empty matrix", () => {
  writeFileSync(ROUTING_POLICY_PATH, yamlStringify(compileRaciDocument(MUTANT_RACI)));
  const view = governanceView({});
  assert.equal(view.ok, false, "no effective host policy without a generation");
  if (!view.ok) {
    assert.equal(view.findings[0]!.code, "no_seed_generation");
    assert.match(view.findings[0]!.message, /forge upgrade/);
  }
});

test("FG-583 host-default matrix: routingGovernance/governanceView populates from the generation when one is present", () => {
  const assets = buildAssetRoot(tmp);
  const raciPath = join(tmp, "forge-raci.md");
  writeFileSync(raciPath, RACI);
  publishSeedGeneration({ home, assetsDir: assets, trustedAssetRoot: () => assets, raciPath });

  const view = governanceView({});
  assert.ok(view.ok, "the matrix populates from the generation");
  if (view.ok) {
    assert.ok(view.routes["implementation_full"], "the host-default route-matrix is populated from the generation");
    assert.equal(view.source, "host");
  }
});
