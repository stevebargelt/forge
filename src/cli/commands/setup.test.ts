// #252: CLI wiring for `forge setup` — the provisioning IO (create active
// model-policy from the seed; recompile routing). Runs against the temp FORGE_HOME
// from test-setup; no docker, no live agent, no DB.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { FORGE_HOME } from "../../util/paths.js";
import { provisionModelPolicy } from "./setup.js";

const ACTIVE = join(FORGE_HOME, "model-policy.yml");
const SEED = join(FORGE_HOME, "model-policy.example.yml");
const SEED_BODY = "# seed\non_unavailable: fail\nmodel_profiles:\n  p:\n    provider: anthropic\n    auth: subscription\n    map:\n      default: { model: m, cost_tier: standard }\ndefaults:\n  profile: p\n  activity: {}\n";

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
