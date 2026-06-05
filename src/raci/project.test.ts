// Project override resolution (#280) — host default vs project, full replacement.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
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

test("resolvePolicyPath: no override falls back to the host default", () => {
  const dir = project();
  const r = resolvePolicyPath(dir);
  assert.equal(r.source, "host");
  assert.equal(r.path, ROUTING_POLICY_PATH);
  rmSync(dir, { recursive: true, force: true });
});
