// #286 — init/upgrade keep the derived routing policy compiled from the RACI seed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { compilePolicyFile, ensureHostRoutingPolicy } from "./host-policy.js";
import { validateRoutePolicyFile } from "../cli/commands/route.js";
import type { HostEnv } from "./route-validate.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SEED_PATH = join(HERE, "..", "..", "seeds", "forge-raci.md");
const all: HostEnv = { agentInstalled: () => true, workflowKnown: () => true };

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "forge-hp-"));
}

test("compilePolicyFile: seed compiles to a policy that route validate accepts clean", () => {
  const dir = tmp();
  const out = join(dir, "routing-policy.yml");
  const res = compilePolicyFile(SEED_PATH, out);
  assert.ok(res.ok && res.routes > 0);
  assert.ok(existsSync(out));
  // The whole point of #286: no drift after compile.
  const v = validateRoutePolicyFile(out, { raciPath: SEED_PATH, host: all });
  assert.equal(v.ok, true, JSON.stringify(v.findings));
});

test("compilePolicyFile: an invalid RACI returns a clear error, writes nothing", () => {
  const dir = tmp();
  const badRaci = join(dir, "bad.md");
  writeFileSync(badRaci, "### route: x\nresponsible: orchestrator\naccountable: not-human\npath: in_session");
  const out = join(dir, "routing-policy.yml");
  const res = compilePolicyFile(badRaci, out);
  assert.equal(res.ok, false);
  assert.ok(!res.ok && res.error.length > 0);
  assert.equal(existsSync(out), false, "a failed compile must not write a partial policy");
});

test("compilePolicyFile: write:false validates in memory without touching disk", () => {
  const dir = tmp();
  const out = join(dir, "routing-policy.yml");
  const res = compilePolicyFile(SEED_PATH, out, { write: false });
  assert.ok(res.ok && res.routes > 0 && res.wrote === false);
  assert.equal(existsSync(out), false);
});

test("ensureHostRoutingPolicy: fresh host installs the seed RACI and compiles a clean policy", () => {
  const dir = tmp();
  const raciPath = join(dir, "forge-raci.md");
  const policyPath = join(dir, "routing-policy.yml");
  const res = ensureHostRoutingPolicy({ raciPath, policyPath, seedRaciPath: SEED_PATH });
  assert.ok(res.ok);
  assert.match(res.status, /installed RACI seed/);
  assert.ok(existsSync(raciPath), "the seed RACI is installed");
  const v = validateRoutePolicyFile(policyPath, { raciPath, host: all });
  assert.equal(v.ok, true, JSON.stringify(v.findings));
});

test("ensureHostRoutingPolicy: existing host RACI is recompiled (left clean), not overwritten", () => {
  const dir = tmp();
  const raciPath = join(dir, "forge-raci.md");
  const policyPath = join(dir, "routing-policy.yml");
  writeFileSync(raciPath, readFileSync(SEED_PATH, "utf8"));
  const res = ensureHostRoutingPolicy({ raciPath, policyPath, seedRaciPath: SEED_PATH });
  assert.ok(res.ok);
  assert.doesNotMatch(res.status, /installed RACI seed/, "must not reinstall over an existing RACI");
  const v = validateRoutePolicyFile(policyPath, { raciPath, host: all });
  assert.equal(v.ok, true, JSON.stringify(v.findings));
});

test("ensureHostRoutingPolicy: a standalone policy (no RACI) is left untouched", () => {
  const dir = tmp();
  const raciPath = join(dir, "forge-raci.md"); // does NOT exist
  const policyPath = join(dir, "routing-policy.yml");
  writeFileSync(policyPath, "version: 1\ngovernance:\n  accountable: human\nroutes: {}\n");
  const before = readFileSync(policyPath, "utf8");
  const res = ensureHostRoutingPolicy({ raciPath, policyPath, seedRaciPath: SEED_PATH });
  assert.ok(res.ok);
  assert.match(res.status, /standalone/);
  assert.equal(readFileSync(policyPath, "utf8"), before, "the standalone policy must be untouched");
  assert.equal(existsSync(raciPath), false, "must not install a RACI over a standalone policy");
});

test("ensureHostRoutingPolicy: dry-run writes nothing but reports the intended compile", () => {
  const dir = tmp();
  const raciPath = join(dir, "forge-raci.md");
  const policyPath = join(dir, "routing-policy.yml");
  const res = ensureHostRoutingPolicy({ raciPath, policyPath, seedRaciPath: SEED_PATH, dryRun: true });
  assert.ok(res.ok && (res.routes ?? 0) > 0);
  assert.match(res.status, /would/);
  assert.equal(existsSync(raciPath), false);
  assert.equal(existsSync(policyPath), false);
});
