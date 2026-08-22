// #252: CLI wiring for `forge setup` — the provisioning IO (create active
// model-policy from the seed; recompile routing). Runs against the temp FORGE_HOME
// from test-setup; no docker, no live agent, no DB.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync, readFileSync, rmSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FORGE_HOME } from "../../util/paths.js";
import { provisionModelPolicy, writeHostPolicy, copySeedExclusive } from "./setup.js";

const ACTIVE = join(FORGE_HOME, "model-policy.yml");
const SEED = join(FORGE_HOME, "model-policy.example.yml");
const SEED_BODY = "# seed\non_unavailable: fail\nschema_version: 2\nmodel_profiles:\n  p:\n    provider: anthropic\n    auth: subscription\n    map:\n      default: { model: m, cost_tier: standard }\ndefaults:\n  profile: p\n  activity: {}\n";

function clean(): void {
  rmSync(ACTIVE, { force: true });
  rmSync(SEED, { force: true });
}

test("#252 provisionModelPolicy: absent active + present seed → creates the active policy from the seed", () => {
  clean();
  writeFileSync(SEED, SEED_BODY);
  try {
    const step = provisionModelPolicy(/* dryRun */ false);
    assert.equal(step.status, "created");
    assert.ok(existsSync(ACTIVE), "active model-policy.yml should now exist");
    assert.equal(readFileSync(ACTIVE, "utf8"), SEED_BODY, "content copied verbatim from the seed");
  } finally {
    clean();
  }
});

test("#252 provisionModelPolicy: present active policy is PRESERVED, never overwritten", () => {
  clean();
  writeFileSync(SEED, SEED_BODY);
  writeFileSync(ACTIVE, "# my personal edits\n" + SEED_BODY);
  try {
    const step = provisionModelPolicy(false);
    assert.equal(step.status, "ok");
    assert.match(readFileSync(ACTIVE, "utf8"), /my personal edits/, "personal host config preserved");
  } finally {
    clean();
  }
});

test("#252 provisionModelPolicy: dry-run does NOT write the active policy", () => {
  clean();
  writeFileSync(SEED, SEED_BODY);
  try {
    const step = provisionModelPolicy(/* dryRun */ true);
    assert.equal(step.status, "would-create");
    assert.equal(existsSync(ACTIVE), false, "dry-run must not create the file");
  } finally {
    clean();
  }
});

test("#252 provisionModelPolicy: no seed installed → fail step pointing at forge upgrade", () => {
  clean();
  try {
    const step = provisionModelPolicy(false);
    assert.equal(step.status, "fail");
    assert.match(step.next ?? "", /forge upgrade/);
    assert.equal(existsSync(ACTIVE), false);
  } finally {
    clean();
  }
});

// RF-2: --reconfigure overwrites the live policy in place — do it atomically (temp +
// fsync + rename) so an interrupted or concurrent read never observes a torn file.
// Discriminating: a bare writeFileSync would truncate the destination before writing;
// this asserts the destination is replaced whole and no temp artifact is left behind.
test("RF-2: writeHostPolicy(reconfigure=true) replaces the destination atomically, no temp left behind", () => {
  const dir = mkdtempSync(join(tmpdir(), "rf2-atomic-"));
  const dest = join(dir, "model-policy.yml");
  try {
    writeFileSync(dest, "OLD POLICY CONTENT\n");
    writeHostPolicy(dest, "NEW POLICY CONTENT\n", /* reconfigure */ true);
    assert.equal(readFileSync(dest, "utf8"), "NEW POLICY CONTENT\n", "destination replaced whole");
    // No leftover temp file (the .<name>.<pid>.<rand>.tmp scratch) — rename consumed it.
    assert.deepEqual(
      readdirSync(dir),
      ["model-policy.yml"],
      "only the destination remains — the atomic temp was renamed, not orphaned",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// RF-2 companion: absent-policy authoring keeps the exclusive-create "wx" flag, so a
// concurrently-created policy fails EEXIST rather than being clobbered (the orchestrator
// reports that as preserved). Only --reconfigure is an intentional overwrite.
test("RF-2: writeHostPolicy(reconfigure=false) creates exclusively and refuses to clobber", () => {
  const dir = mkdtempSync(join(tmpdir(), "rf2-excl-"));
  const dest = join(dir, "model-policy.yml");
  try {
    writeHostPolicy(dest, "FIRST\n", /* reconfigure */ false);
    assert.equal(readFileSync(dest, "utf8"), "FIRST\n", "created when absent");
    assert.throws(
      () => writeHostPolicy(dest, "SECOND\n", /* reconfigure */ false),
      (e: NodeJS.ErrnoException) => e.code === "EEXIST",
      "an existing policy is not clobbered by the non-reconfigure write",
    );
    assert.equal(readFileSync(dest, "utf8"), "FIRST\n", "existing content preserved");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// RF-3: copySeedExclusive reports whether it actually copied. With no seed present it
// writes nothing and returns false, so the orchestrator can report "no policy created"
// instead of a phantom success.
test("RF-3: copySeedExclusive returns false and writes nothing when the seed is absent", () => {
  const dir = mkdtempSync(join(tmpdir(), "rf3-seed-"));
  const seed = join(dir, "model-policy.example.yml");
  const dest = join(dir, "model-policy.yml");
  try {
    assert.equal(copySeedExclusive(seed, dest), false, "no seed → returned false");
    assert.equal(existsSync(dest), false, "nothing written");
    writeFileSync(seed, "SEED\n");
    assert.equal(copySeedExclusive(seed, dest), true, "seed present → copied, returned true");
    assert.equal(readFileSync(dest, "utf8"), "SEED\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
