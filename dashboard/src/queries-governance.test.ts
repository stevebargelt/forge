// Tests for routingGovernance (#285) — the dashboard read model over the shared
// governanceView() core. Seed a temp FORGE_HOME, then exercise host default,
// project override diff, drift, and audit-tail augmentation. Read-only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const tmpHome = mkdtempSync(join(tmpdir(), "forge-gov-"));
process.env.FORGE_HOME = tmpHome;

const { routingGovernance } = await import("./queries.js");
const { compileRaciDocument } = await import("../../src/raci/compile.js");
const { stringify: yamlStringify } = await import("yaml");

const SEED = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "..", "seeds", "forge-raci.md"),
  "utf8",
);
const compiledYaml = (raci: string) => yamlStringify(compileRaciDocument(raci));

// Seed the host policy + RACI so host-source resolution and the host-vs-project
// diff are deterministic (not dependent on the developer's real ~/.forge).
writeFileSync(join(tmpHome, "forge-raci.md"), SEED);
writeFileSync(join(tmpHome, "routing-policy.yml"), compiledYaml(SEED));

const IQ = "responsible: engineer\naccountable: human\npath: invoke_chain";
const mutated = SEED.replace(IQ, "responsible: backend-specialist\naccountable: human\npath: invoke_chain");

function projectWith(raci: string, policyRaci: string): string {
  const dir = mkdtempSync(join(tmpdir(), "forge-gov-proj-"));
  mkdirSync(join(dir, ".forge"), { recursive: true });
  writeFileSync(join(dir, ".forge", "forge-raci.md"), raci);
  writeFileSync(join(dir, ".forge", "routing-policy.yml"), compiledYaml(policyRaci));
  return dir;
}

test("routingGovernance: host default returns source=host and the route matrix", () => {
  const g = routingGovernance();
  assert.ok(g.ok);
  assert.equal(g.source, "host");
  assert.ok(Object.keys(g.routes).length > 0);
  assert.equal(g.routes.implementation_quick!.responsible, "engineer");
  assert.ok(!g.diff, "host view has no override diff");
});

test("routingGovernance: a project override returns source=project with a host-vs-project diff", () => {
  const proj = projectWith(mutated, mutated); // RACI and policy both mutated — consistent
  const g = routingGovernance(proj);
  assert.ok(g.ok);
  assert.equal(g.source, "project");
  assert.equal(g.routes.implementation_quick!.responsible, "backend-specialist");
  assert.ok(g.diff);
  const mod = g.diff!.modified.find((m) => m.route === "implementation_quick");
  assert.ok(mod && mod.fields.some((f) => f.field === "responsible" && f.after === "backend-specialist"));
});

test("routingGovernance: a stale project policy surfaces a drift warning", () => {
  // RACI says backend-specialist, but the compiled policy is the old seed (engineer).
  const proj = projectWith(mutated, SEED);
  const g = routingGovernance(proj);
  assert.ok(g.ok);
  assert.ok(g.drift && g.drift.length > 0);
  assert.ok(g.drift!.some((f) => f.code === "policy_drift" && f.route === "implementation_quick"));
});

test("routingGovernance: an uncompiled project override is an unhealthy (not ok) view", () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-gov-proj-"));
  mkdirSync(join(dir, ".forge"), { recursive: true });
  writeFileSync(join(dir, ".forge", "forge-raci.md"), SEED); // RACI but no compiled policy
  const g = routingGovernance(dir);
  assert.equal(g.ok, false);
  assert.ok(!g.ok && g.findings.some((f) => f.code === "override_not_compiled"));
});

test("routingGovernance: recent RACI audit entries are surfaced newest-first", () => {
  const entry = (ts: string, modified: string[]) =>
    JSON.stringify({
      timestamp: ts,
      action: "apply",
      current_raci: join(tmpHome, "forge-raci.md"),
      candidate: "cand.md",
      routes_added: [],
      routes_removed: [],
      routes_modified: modified,
      validation: { raci: true, route: true },
    }) + "\n";
  appendFileSync(join(tmpHome, "raci-audit.log"), entry("2026-06-01T00:00:00.000Z", ["research"]));
  appendFileSync(join(tmpHome, "raci-audit.log"), entry("2026-06-02T00:00:00.000Z", ["implementation_quick"]));

  const g = routingGovernance();
  assert.equal(g.recentAudit.length, 2);
  assert.equal(g.recentAudit[0]!.timestamp, "2026-06-02T00:00:00.000Z", "newest first");
  assert.deepEqual(g.recentAudit[0]!.routes_modified, ["implementation_quick"]);
});
