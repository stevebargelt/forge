// FG-560 (step 11): `forge doctor` READ-ONLY model-policy migration status.
//
// The load-bearing acceptance: a v1 host policy is FLAGGED and directed at `forge
// upgrade`, and doctor leaves the file BYTE-IDENTICAL — doctor never migrates
// (that is `forge upgrade`'s sole authority). Driven through the REAL registered
// command against the disposable $FORGE_HOME from test-setup; docker probes fail
// gracefully, so no docker is required.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import { FORGE_HOME } from "../../util/paths.js";
import { registerDoctor } from "./doctor.js";

const HOST_POLICY = join(FORGE_HOME, "model-policy.yml");

// A v1 file: no schema_version, and a profile that maps `reasoning`/`fast` (so the
// FG-560 alias additions are DERIVABLE — the file is `migratable`, not needs-human).
const V1_POLICY = `# my host policy — hand-edited, keep the comments
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

async function runDoctor(args: string[]): Promise<{ out: string; exitCode: number | undefined }> {
  const program = new Command();
  program.exitOverride();
  registerDoctor(program);
  const lines: string[] = [];
  const realLog = console.log;
  const savedExit = process.exitCode;
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  process.exitCode = undefined;
  try {
    await program.parseAsync(["node", "forge", "doctor", ...args]);
    return { out: lines.join("\n"), exitCode: process.exitCode };
  } finally {
    console.log = realLog;
    process.exitCode = savedExit;
  }
}

beforeEach(() => rmSync(HOST_POLICY, { force: true }));
afterEach(() => rmSync(HOST_POLICY, { force: true }));

test("FG-560 doctor (human): a v1 host policy is FLAGGED and directed at `forge upgrade`", async () => {
  writeFileSync(HOST_POLICY, V1_POLICY);
  const { out } = await runDoctor([]);
  assert.match(out, /Model-policy status/);
  assert.match(out, /read-only/);
  assert.match(out, /legacy v1|schema_version/);
  assert.match(out, /forge upgrade/);
});

test("FG-560 doctor: reporting a v1 host policy leaves it BYTE-IDENTICAL (doctor NEVER writes)", async () => {
  writeFileSync(HOST_POLICY, V1_POLICY);
  const before = readFileSync(HOST_POLICY);
  const beforeMtime = statSync(HOST_POLICY).mtimeMs;

  await runDoctor([]);
  await runDoctor(["--json"]);

  const after = readFileSync(HOST_POLICY);
  assert.ok(before.equals(after), "doctor must not rewrite a single byte of the policy file");
  assert.equal(statSync(HOST_POLICY).mtimeMs, beforeMtime, "doctor must not even touch the file's mtime");
});

test("FG-560 doctor (--json): modelPolicyStatus rides in the payload with the host verdict a script can branch on", async () => {
  writeFileSync(HOST_POLICY, V1_POLICY);
  const { out } = await runDoctor(["--json"]);
  const parsed = JSON.parse(out) as {
    modelPolicyStatus?: {
      host?: { verdict?: string; action?: string };
      hostNeedsUpgrade?: boolean;
      completeness?: string;
    };
  };
  assert.ok(parsed.modelPolicyStatus, "--json must carry a modelPolicyStatus block");
  assert.equal(parsed.modelPolicyStatus!.host!.verdict, "migratable");
  assert.equal(parsed.modelPolicyStatus!.host!.action, "forge-upgrade");
  assert.equal(parsed.modelPolicyStatus!.hostNeedsUpgrade, true);
  // The honesty marker is carried, never a fleet-completeness claim.
  assert.equal(parsed.modelPolicyStatus!.completeness, "historical-best-effort");
});

test("FG-560 doctor: no host policy → a clean legacy-mode status, no `forge upgrade` push", async () => {
  // No policy written → reachable-no-policy. Must not flag a migration.
  const { out } = await runDoctor([]);
  assert.match(out, /Model-policy status/);
  assert.match(out, /legacy mode/);
});
