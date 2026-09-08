// FG-782 (step 4) — integration tier. Proves loadIdentityMapping() re-reads the operator file
// on EVERY call against a REAL file under an injected FORGE_HOME, so an operator edit or delete
// revokes access on the next request WITHOUT restarting Forge (FG-782 AC4). This is the tier
// that touches the filesystem; the pure parse/validate rules are unit-tested in mapping.test.ts.
//
// Acceptance coverage (FG-782 AC4):
//   * a login authorized in the file loads to its single project;
//   * DELETING that login's line is honored on the very next load — no restart, no cache;
//   * EDITING the line to a different project / capability is honored on the next load;
//   * a MISSING file fails closed to no grant.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadIdentityMapping,
  resolveIdentityMappingPath,
  IDENTITY_MAPPING_FILENAME,
} from "./mapping.js";

/** An env map with an injected FORGE_HOME pointing at a fresh temp dir. We pass this to the
 *  loader explicitly rather than mutating process.env, so the test never depends on — or
 *  corrupts — the ambient environment, and two cases can run against two homes. */
function tempForgeHome(): { env: NodeJS.ProcessEnv; path: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "fg782-mapping-"));
  const env = { FORGE_HOME: dir } as NodeJS.ProcessEnv;
  return { env, path: join(dir, IDENTITY_MAPPING_FILENAME), dir };
}

function writeMapping(path: string, body: string): void {
  writeFileSync(path, body, "utf8");
}

test("resolveIdentityMappingPath honors an injected FORGE_HOME", () => {
  const { env, path, dir } = tempForgeHome();
  assert.equal(resolveIdentityMappingPath(env), path);
  assert.equal(resolveIdentityMappingPath(env), join(dir, IDENTITY_MAPPING_FILENAME));
  rmSync(dir, { recursive: true, force: true });
});

test("a missing file fails closed to no grant (AC3 basis)", () => {
  const { env, dir } = tempForgeHome();
  // No file written under this FORGE_HOME.
  const m = loadIdentityMapping(env);
  assert.equal(m.size, 0);
  assert.equal(m.lookup("alice@example.ts.net"), null);
  rmSync(dir, { recursive: true, force: true });
});

test("an authorized login loads to its single project + read capability", () => {
  const { env, path, dir } = tempForgeHome();
  writeMapping(
    path,
    [
      "version: 1",
      "identities:",
      "  - login: alice@example.ts.net",
      "    project: repo-alpha",
      "    capabilities: [read]",
    ].join("\n"),
  );
  const grant = loadIdentityMapping(env).lookup("alice@example.ts.net");
  assert.ok(grant, "alice is authorized");
  assert.equal(grant.projectKey, "repo-alpha");
  assert.deepEqual([...grant.capabilities], ["read"]);
  rmSync(dir, { recursive: true, force: true });
});

test("DELETING an entry is honored on the next load — revocation without restart (AC4)", () => {
  const { env, path, dir } = tempForgeHome();
  writeMapping(
    path,
    [
      "identities:",
      "  - login: alice@example.ts.net",
      "    project: repo-alpha",
      "    capabilities: [read]",
      "  - login: bob@example.ts.net",
      "    project: repo-bravo",
      "    capabilities: [read]",
    ].join("\n"),
  );

  // Before: both are authorized on a live load.
  const before = loadIdentityMapping(env);
  assert.equal(before.lookup("alice@example.ts.net")?.projectKey, "repo-alpha");
  assert.equal(before.lookup("bob@example.ts.net")?.projectKey, "repo-bravo");

  // Operator revokes bob by removing his line — no process restart.
  writeMapping(
    path,
    [
      "identities:",
      "  - login: alice@example.ts.net",
      "    project: repo-alpha",
      "    capabilities: [read]",
    ].join("\n"),
  );

  // After: the SAME loader, re-reading the file, denies bob and still allows alice.
  const after = loadIdentityMapping(env);
  assert.equal(after.lookup("bob@example.ts.net"), null, "bob is revoked on the next request, no restart");
  assert.equal(after.lookup("alice@example.ts.net")?.projectKey, "repo-alpha", "alice unaffected");
  rmSync(dir, { recursive: true, force: true });
});

test("EDITING an entry (project + capability) is honored on the next load", () => {
  const { env, path, dir } = tempForgeHome();
  writeMapping(
    path,
    [
      "identities:",
      "  - login: alice@example.ts.net",
      "    project: repo-alpha",
      "    capabilities: [read]",
    ].join("\n"),
  );
  assert.equal(loadIdentityMapping(env).lookup("alice@example.ts.net")?.projectKey, "repo-alpha");

  // Operator retargets alice to a different project; capability is invalidated to a forged one.
  writeMapping(
    path,
    [
      "identities:",
      "  - login: alice@example.ts.net",
      "    project: repo-omega",
      "    capabilities: [mutate]",
    ].join("\n"),
  );
  // The forged capability now taints alice's entry → she is dropped on the next load.
  assert.equal(
    loadIdentityMapping(env).lookup("alice@example.ts.net"),
    null,
    "the edited-in forged capability revokes access on the next request",
  );

  // Operator fixes the capability back to read but keeps the new project.
  writeMapping(
    path,
    [
      "identities:",
      "  - login: alice@example.ts.net",
      "    project: repo-omega",
      "    capabilities: [read]",
    ].join("\n"),
  );
  assert.equal(
    loadIdentityMapping(env).lookup("alice@example.ts.net")?.projectKey,
    "repo-omega",
    "the retarget to repo-omega is honored on the next load",
  );
  rmSync(dir, { recursive: true, force: true });
});

test("a file emptied to nothing fails closed on the next load", () => {
  const { env, path, dir } = tempForgeHome();
  writeMapping(
    path,
    [
      "identities:",
      "  - login: alice@example.ts.net",
      "    project: repo-alpha",
      "    capabilities: [read]",
    ].join("\n"),
  );
  assert.equal(loadIdentityMapping(env).size, 1);

  writeMapping(path, ""); // operator truncates the file
  assert.equal(loadIdentityMapping(env).size, 0, "an emptied file grants nobody");
  assert.equal(loadIdentityMapping(env).lookup("alice@example.ts.net"), null);
  rmSync(dir, { recursive: true, force: true });
});
