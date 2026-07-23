// Project override resolution (#280) — host default vs project, full replacement.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveRaciPath,
  resolvePolicyPath,
  projectRaciPath,
  projectPolicyPath,
} from "./project.js";
import { RACI_PATH, ROUTING_POLICY_PATH } from "../util/paths.js";

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "forge-proj-"));
  mkdirSync(join(dir, ".forge"), { recursive: true });
  return dir;
}

test("resolveRaciPath: a project override wins over the host default", () => {
  const dir = project();
  writeFileSync(projectRaciPath(dir), "### route: x");
  const r = resolveRaciPath(dir);
  assert.deepEqual(r, { source: "project", path: projectRaciPath(dir), exists: true });
  rmSync(dir, { recursive: true, force: true });
});

test("resolveRaciPath: no override falls back to the host default", () => {
  const dir = project(); // .forge exists but no forge-raci.md
  const r = resolveRaciPath(dir);
  assert.equal(r.source, "host");
  assert.equal(r.path, RACI_PATH);
  rmSync(dir, { recursive: true, force: true });
});

test("resolveRaciPath: no project context is the host default", () => {
  const r = resolveRaciPath(undefined);
  assert.equal(r.source, "host");
  assert.equal(r.path, RACI_PATH);
});

test("resolvePolicyPath: a project override wins over the host default", () => {
  const dir = project();
  writeFileSync(projectPolicyPath(dir), "version: 1");
  const r = resolvePolicyPath(dir);
  assert.deepEqual(r, { source: "project", path: projectPolicyPath(dir), exists: true });
  rmSync(dir, { recursive: true, force: true });
});

test("resolvePolicyPath: no override + no published generation FAILS CLOSED (no flat fallback)", () => {
  // FG-583: with no project override and no complete seed generation published, the
  // resolver must NOT fall back to the mutable flat routing-policy.yml — that policy
  // set may belong to no published generation. It fails closed (exists:false) with a
  // non-existent path so every consumer resolves policy_not_found.
  const dir = project();
  writeFileSync(ROUTING_POLICY_PATH, "version: 1"); // a flat policy exists on disk...
  try {
    const r = resolvePolicyPath(dir); // ...but no generation is published
    assert.equal(r.source, "host");
    assert.equal(r.exists, false, "must fail closed, not read the flat host policy");
    assert.notEqual(r.path, ROUTING_POLICY_PATH, "must NOT hand back the flat routing-policy.yml");
    assert.equal(existsSync(r.path), false, "the returned path must not exist (fail-closed for every consumer)");
  } finally {
    rmSync(ROUTING_POLICY_PATH, { force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolvePolicyPath: a project RACI override with no compiled policy does NOT fall back to host", () => {
  const dir = project();
  writeFileSync(projectRaciPath(dir), "### route: x"); // override source exists...
  const r = resolvePolicyPath(dir); // ...but no routing-policy.yml
  assert.equal(r.source, "project", "must stay project, not silently fall back to host");
  assert.equal(r.exists, false);
  assert.equal(r.uncompiledOverride, true);
  assert.equal(r.path, projectPolicyPath(dir));
  rmSync(dir, { recursive: true, force: true });
});
