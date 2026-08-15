// FG-560 (step 11): the read-only status COMPOSITION — discovery ⊕ classifier.
// Verifies the composition logic with injected discovery + file reads, so no
// store or filesystem is needed. The classifier itself is real (its own tests
// cover it); these tests prove the state → action → wording mapping and that a
// single unreadable project never blanks the whole status.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildModelPolicyStatus, renderModelPolicyStatus } from "./model-policy-status.js";
import type { DiscoveredPolicy, PolicyDiscovery } from "./model-policy-discovery.js";

const V1 = `
model_profiles:
  claude-subscription:
    provider: anthropic
    auth: subscription
    map:
      reasoning: { model: claude-opus-4-8, cost_tier: premium }
      fast:      { model: claude-haiku-4-5, cost_tier: cheap }
      default:   { model: claude-sonnet-4-6, cost_tier: standard }
defaults:
  profile: claude-subscription
  activity: {}
`;

const V2_CURRENT = `
schema_version: 2
model_profiles:
  pi-groq:
    provider: groq
    auth: api
    runtime: pi
    map:
      default: { model: llama-3.3-70b, cost_tier: cheap }
defaults:
  profile: pi-groq
  activity: {}
`;

const V3_NEWER = `
schema_version: 3
model_profiles:
  x: { provider: anthropic, auth: subscription, map: { default: { model: m, cost_tier: cheap } } }
defaults: { profile: x, activity: {} }
`;

function host(state: DiscoveredPolicy["state"], policyPath: string | null): DiscoveredPolicy {
  return {
    scope: "host", state, projectDir: "/home/x/.forge", canonicalDir: "/home/x/.forge",
    policyPath, identityKey: "host", projectKey: null, evidenceSources: [], lastSeenAt: null,
  };
}
function project(state: DiscoveredPolicy["state"], policyPath: string | null, dir: string | null): DiscoveredPolicy {
  return {
    scope: "project", state, projectDir: dir, canonicalDir: dir,
    policyPath, identityKey: `id:${dir}`, projectKey: null, evidenceSources: ["runs"], lastSeenAt: "2026-08-01T00:00:00Z",
  };
}
function discovery(over: Partial<PolicyDiscovery>): PolicyDiscovery {
  return {
    host: host("reachable-no-policy", null),
    projects: [],
    completeness: "historical-best-effort",
    registeredInspected: 0, registeredUnreachable: 0, registeredNoPath: 0,
    ...over,
  };
}

test("host v1 → needs `forge upgrade` (migratable), hostNeedsUpgrade true", () => {
  const s = buildModelPolicyStatus({}, {
    discover: () => discovery({ host: host("has-policy", "/home/x/.forge/model-policy.yml") }),
    readFile: () => V1,
  });
  assert.equal(s.host.verdict, "migratable");
  assert.equal(s.host.schemaVersionFound, null); // v1 has no schema_version
  assert.equal(s.host.action, "forge-upgrade");
  assert.equal(s.hostNeedsUpgrade, true);
  assert.match(s.host.detail, /legacy v1|schema_version/);
});

test("host v2 current → no action, hostNeedsUpgrade false", () => {
  const s = buildModelPolicyStatus({}, {
    discover: () => discovery({ host: host("has-policy", "/home/x/.forge/model-policy.yml") }),
    readFile: () => V2_CURRENT,
  });
  assert.equal(s.host.verdict, "current");
  assert.equal(s.host.action, "none");
  assert.equal(s.hostNeedsUpgrade, false);
});

test("newer-unsupported anywhere → flagged 'upgrade Forge'", () => {
  const s = buildModelPolicyStatus({}, {
    discover: () => discovery({ host: host("has-policy", "/home/x/.forge/model-policy.yml") }),
    readFile: () => V3_NEWER,
  });
  assert.equal(s.host.verdict, "newer-unsupported");
  assert.equal(s.host.action, "upgrade-forge");
  assert.equal(s.anyNewerUnsupported, true);
  const text = renderModelPolicyStatus(s);
  assert.match(text, /upgrade Forge/);
});

test("no host policy → legacy-mode note, no action", () => {
  const s = buildModelPolicyStatus({}, {
    discover: () => discovery({ host: host("reachable-no-policy", null) }),
    readFile: () => { throw new Error("should not read"); },
  });
  assert.equal(s.host.verdict, null);
  assert.equal(s.host.action, "none");
  assert.match(s.host.detail, /legacy mode/);
});

test("a single unreadable project policy is reported as an error row, never blanking the status", () => {
  const s = buildModelPolicyStatus({}, {
    discover: () => discovery({
      host: host("has-policy", "/home/x/.forge/model-policy.yml"),
      projects: [project("has-policy", "/p/.forge/model-policy.yml", "/p")],
    }),
    readFile: (p) => {
      if (p === "/home/x/.forge/model-policy.yml") return V2_CURRENT;
      throw new Error("EACCES: permission denied");
    },
  });
  assert.equal(s.host.verdict, "current");
  assert.equal(s.projects.length, 1);
  assert.equal(s.projects[0]!.verdict, null);
  assert.match(s.projects[0]!.error ?? "", /EACCES/);
});

test("project states with no file (unreachable / known-but-no-path) classify without a read", () => {
  const s = buildModelPolicyStatus({}, {
    discover: () => discovery({
      projects: [
        project("unreachable-deleted", null, "/gone"),
        project("known-but-no-path", null, null),
      ],
    }),
    readFile: () => { throw new Error("should not read a file for a no-file state"); },
  });
  assert.equal(s.projects[0]!.action, "none");
  assert.match(s.projects[0]!.detail, /no longer resolves/);
  assert.equal(s.projects[1]!.action, "none");
  assert.match(s.projects[1]!.detail, /no recorded path/);
});

test("render: a v1 host is directed at `forge upgrade`, and completeness is never claimed as a fleet inventory", () => {
  const s = buildModelPolicyStatus({}, {
    discover: () => discovery({ host: host("has-policy", "/home/x/.forge/model-policy.yml"), projects: [] }),
    readFile: () => V1,
  });
  const text = renderModelPolicyStatus(s);
  assert.match(text, /read-only/);
  assert.match(text, /forge upgrade/);
  assert.match(text, /best-effort|historical/);
});
