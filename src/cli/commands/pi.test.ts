// #266: forge pi login stores a long-lived OAuth credential — the host dir + file
// must be private (0700 / 0600). The interactive docker login isn't unit-testable,
// but the permission enforcement is (FORGE_PI_DIR seam).

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, statSync, rmSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureSecurePiAgentDir, securePiAuthFile } from "./pi.js";

let prev: string | undefined;
let base: string;

beforeEach(() => {
  prev = process.env.FORGE_PI_DIR;
  base = mkdtempSync(join(tmpdir(), "forge-pi-perm-"));
  process.env.FORGE_PI_DIR = join(base, "pi-agent"); // FORGE_PI_DIR IS the agent dir
});
afterEach(() => {
  if (prev === undefined) delete process.env.FORGE_PI_DIR;
  else process.env.FORGE_PI_DIR = prev;
  rmSync(base, { recursive: true, force: true });
});

const mode = (p: string) => statSync(p).mode & 0o777;

test("#266: ensureSecurePiAgentDir creates the credential dir at 0700", () => {
  const dir = ensureSecurePiAgentDir();
  assert.equal(dir, process.env.FORGE_PI_DIR);
  assert.ok(existsSync(dir));
  assert.equal(mode(dir), 0o700, "credential dir must be private");
});

test("#266: ensureSecurePiAgentDir tightens an existing over-permissive dir", () => {
  mkdirSync(process.env.FORGE_PI_DIR!, { recursive: true });
  chmodSync(process.env.FORGE_PI_DIR!, 0o755); // simulate a loose dir
  ensureSecurePiAgentDir();
  assert.equal(mode(process.env.FORGE_PI_DIR!), 0o700);
});

test("#266: securePiAuthFile chmods a saved credential to 0600 and reports present", () => {
  ensureSecurePiAgentDir();
  const f = join(process.env.FORGE_PI_DIR!, "auth.json");
  writeFileSync(f, '{"providers":{"anthropic":{"type":"oauth"}}}');
  chmodSync(f, 0o644); // loose starting mode regardless of umask
  assert.equal(securePiAuthFile(), true);
  assert.equal(mode(f), 0o600, "saved OAuth credential must be 0600");
});

test("#266: securePiAuthFile is a no-op returning false when no credential exists", () => {
  ensureSecurePiAgentDir();
  assert.equal(securePiAuthFile(), false);
});
