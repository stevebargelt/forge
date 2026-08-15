// #252: `forge setup` — get a new/work-laptop host ready for forge-on-forge
// without hand-writing YAML. Guided-creates the active host config from the
// installed seed when absent (the one safe, host-local, never-committed
// mutation), ensures the routing policy is compiled, then runs the #229 read-only
// release check and reports whether the Codex review-loop path is configured. No
// live agent run; the DB is never touched. `--dry-run` previews without writing.

import type { Command } from "commander";
import { existsSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { FORGE_HOME, RACI_PATH, ROUTING_POLICY_PATH } from "../../util/paths.js";
import { compilePolicyFile } from "../../raci/host-policy.js";
import { gatherReleaseInputs } from "./doctor.js";
import { buildReleaseReport } from "../../v2/release-doctor.js";
import {
  planConfigProvision,
  modelPolicyStep,
  modelPolicyVersionStep,
  routingPolicyStep,
  reviewLoopReadiness,
  buildSetupReport,
  renderSetupReport,
  type SetupStep,
} from "../../v2/setup.js";
import { buildModelPolicyStatus } from "../../v2/model-policy-status.js";

const MODEL_POLICY_PATH = join(FORGE_HOME, "model-policy.yml");
const MODEL_POLICY_SEED = join(FORGE_HOME, "model-policy.example.yml");

// Create the active model policy from the installed example when absent. Never
// overwrites an existing host policy (preserves personal edits). Returns the step
// for the report; performs the copy unless dryRun.
export function provisionModelPolicy(dryRun: boolean): SetupStep {
  const action = planConfigProvision({
    activePresent: existsSync(MODEL_POLICY_PATH),
    seedPresent: existsSync(MODEL_POLICY_SEED),
    dryRun,
  });
  if (action === "created") copyFileSync(MODEL_POLICY_SEED, MODEL_POLICY_PATH);
  return modelPolicyStep(action);
}

// Ensure routing-policy.yml exists/compiled from the host RACI. routing-policy is
// derived (never hand-maintained), so setup recompiles it like upgrade does.
export function provisionRoutingPolicy(dryRun: boolean): SetupStep {
  const presentBefore = existsSync(ROUTING_POLICY_PATH);
  if (!existsSync(RACI_PATH)) {
    return routingPolicyStep({
      presentBefore,
      ensuredOk: presentBefore,
      detail: presentBefore
        ? "present (no host RACI to recompile from)"
        : "no routing-policy and no host RACI — run `forge upgrade` to install seeds",
    });
  }
  const res = compilePolicyFile(RACI_PATH, ROUTING_POLICY_PATH, { write: !dryRun });
  return routingPolicyStep({ presentBefore, ensuredOk: res.ok, detail: res.ok ? "" : res.error });
}

export function registerSetup(program: Command): void {
  program
    .command("setup")
    .description("Get this host ready for forge: create active model/routing policy from seed if absent, then run the read-only release check (#252)")
    .option("--dry-run", "report what setup would create/change without writing")
    .option("--review-profile <name>", "review-loop reviewer profile to verify (default: codex-subscription)")
    .action((opts: { dryRun?: boolean; reviewProfile?: string }) => {
      const dryRun = opts.dryRun ?? false;
      // Provision FIRST so the release check below sees the just-created policy.
      // FG-560: after provisioning, classify the (now-present) host policy's schema
      // version so setup reflects schema_version 2 — read-only, `forge upgrade` owns
      // any migration.
      const provisioning = [
        provisionModelPolicy(dryRun),
        modelPolicyVersionStep(buildModelPolicyStatus({ forgeHome: FORGE_HOME })),
        provisionRoutingPolicy(dryRun),
      ];
      const inputs = gatherReleaseInputs(undefined, { projectDir: process.cwd() });
      const release = buildReleaseReport(inputs);
      const reviewLoop = reviewLoopReadiness(inputs, opts.reviewProfile ?? "codex-subscription");
      const report = buildSetupReport(provisioning, release, reviewLoop);
      console.log(renderSetupReport(report));
      if (dryRun) console.log("\n(dry run — no files written)");
      process.exitCode = report.ready ? 0 : 1;
    });
}
