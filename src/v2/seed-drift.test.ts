import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectSeedDrift, renderSeedDrift } from "./seed-drift.js";

// Build a (repoSeeds, forgeHome) pair under a temp root and run the detector
// against them — never touches the real ~/.forge or the package seeds.
function fixture(): { repo: string; home: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "seed-drift-"));
  const repo = join(root, "seeds");
  const home = join(root, "forge-home");
  mkdirSync(join(repo, "runtimes"), { recursive: true });
  mkdirSync(join(repo, "constraints"), { recursive: true });
  mkdirSync(join(home, "runtimes"), { recursive: true });
  mkdirSync(join(home, "constraints"), { recursive: true });
  return { repo, home, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("detectSeedDrift: identical seeds report current and ok", () => {
  const { repo, home, cleanup } = fixture();
  try {
    writeFileSync(join(repo, "runtimes", "pi-apikey.yml"), "provider: ${UPSTREAM_PROVIDER}\n");
    writeFileSync(join(home, "runtimes", "pi-apikey.yml"), "provider: ${UPSTREAM_PROVIDER}\n");
    const r = detectSeedDrift(repo, home);
    assert.equal(r.ok, true);
    assert.equal(r.stale.length, 0);
    assert.equal(r.entries.find((e) => e.path.endsWith("pi-apikey.yml"))?.status, "current");
  } finally {
    cleanup();
  }
});

test("detectSeedDrift: a drifted RUNTIME seed fails readiness (autoRefreshable)", () => {
  const { repo, home, cleanup } = fixture();
  try {
    writeFileSync(join(repo, "runtimes", "pi-apikey.yml"), "provider: ${UPSTREAM_PROVIDER}\n");
    writeFileSync(join(home, "runtimes", "pi-apikey.yml"), "provider: anthropic\n"); // stale
    const r = detectSeedDrift(repo, home);
    assert.equal(r.ok, false);
    const e = r.stale.find((x) => x.path.endsWith("pi-apikey.yml"));
    assert.equal(e?.status, "drifted");
    assert.equal(e?.autoRefreshable, true);
  } finally {
    cleanup();
  }
});

test("detectSeedDrift: a missing installed runtime is reported missing", () => {
  const { repo, home, cleanup } = fixture();
  try {
    writeFileSync(join(repo, "runtimes", "pi-oauth.yml"), "kind: pi\n");
    const r = detectSeedDrift(repo, home); // not installed in home
    assert.equal(r.ok, false);
    assert.equal(r.stale.find((x) => x.path.endsWith("pi-oauth.yml"))?.status, "missing");
  } finally {
    cleanup();
  }
});

test("detectSeedDrift: drifted PROSE seed warns but keeps ok=true", () => {
  const { repo, home, cleanup } = fixture();
  try {
    writeFileSync(join(repo, "constraints", "no-ai-attribution.md"), "rule v2\n");
    writeFileSync(join(home, "constraints", "no-ai-attribution.md"), "rule v1\n"); // local/old
    const r = detectSeedDrift(repo, home);
    assert.equal(r.ok, true); // prose drift alone is a warning, not a fail
    assert.equal(r.stale.length, 1);
    assert.equal(r.stale[0]?.autoRefreshable, false);
  } finally {
    cleanup();
  }
});

test("renderSeedDrift: empty when nothing is stale; FAIL marker on runtime drift", () => {
  const { repo, home, cleanup } = fixture();
  try {
    writeFileSync(join(repo, "runtimes", "a.yml"), "x\n");
    writeFileSync(join(home, "runtimes", "a.yml"), "x\n");
    assert.equal(renderSeedDrift(detectSeedDrift(repo, home)), "");

    writeFileSync(join(home, "runtimes", "a.yml"), "y\n"); // now drifted
    const section = renderSeedDrift(detectSeedDrift(repo, home));
    assert.match(section, /Seed drift/);
    assert.match(section, /\[FAIL\]/);
    assert.match(section, /forge upgrade/);
  } finally {
    cleanup();
  }
});
