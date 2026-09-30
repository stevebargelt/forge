import type { Command } from "commander";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ensureForgeDirs } from "../../util/paths.js";
import { renderActivityUnmapped } from "../../v2/model-provenance.js";
import { modelResolveReport } from "../../v2/model-resolve-report.js";
import {
  applyModelPolicy,
  policyTarget,
  renderPolicyProposal,
  type PolicyApplyResult,
} from "../../v2/model-policy-gate.js";

export function registerModel(program: Command): void {
  const model = program
    .command("model")
    .description("Inspect model / profile resolution (AWN-7 policy mode)");

  model
    .command("resolve")
    .argument("<agent>", "agent role to resolve for (e.g. engineer, red-security)")
    .description("Dry-run: explain which profile + model a task for <agent> would resolve to, and why")
    .option(
      "--activity <capability>",
      "capability the task needs (review | reasoning | fast | ...); default: the agent's built-in default activity"
    )
    .option("--profile <name>", "force a profile (highest precedence), as `forge invoke --profile` would")
    .option("--project <dir>", "project dir whose .forge/model-policy.yml applies (default: cwd)")
    .option("--check", "probe whether the resolved auth has working credentials in this environment")
    .option("--json", "emit JSON instead of a human summary")
    .action(
      (
        agent: string,
        opts: { activity?: string; profile?: string; project?: string; check?: boolean; json?: boolean }
      ) => {
        ensureForgeDirs();
        const projectDir = resolve(opts.project ?? process.cwd());

        const report = modelResolveReport(agent, {
          activity: opts.activity,
          profile: opts.profile,
          check: opts.check,
          ctx: { projectDir },
        });
        if (!report.ok) {
          // Fail-loud resolution errors (unknown --profile, unmapped capability).
          if (opts.json) console.log(JSON.stringify({ error: report.error }, null, 2));
          else console.error(`✗ resolution failed: ${report.error}`);
          process.exitCode = 1;
          return;
        }
        const { resolution, legacy, mappingSummary, unmapped, probe, effort, effectiveToolCapable, dispatchable, toolCapabilityNote } = report;

        if (opts.json) {
          console.log(JSON.stringify(report.json, null, 2));
          return;
        }

        const line = (k: string, v: string) => console.log(`  ${k.padEnd(15)}${v}`);
        console.log(`forge model resolve ${agent}`);
        line("mode:", legacy ? "legacy (no model-policy.yml — runtime.models)" : "policy");
        line("capability:", resolution.alias ?? "(n/a)");
        line("model:", resolution.model);
        if (!legacy) {
          line("profile:", resolution.profile ?? "");
          line("provider:", resolution.provider ?? "");
          line("auth:", `${resolution.auth} (effective)`);
          line("cost tier:", resolution.costTier ?? "");
          if (effort) line("effort:", effort);
        }
        line("runtime:", resolution.runtime);
        line("resolved by:", resolution.resolvedBy);
        // FG-560: the mapping-path axis, on its OWN line so it never reads as part
        // of the profile-selection provenance above. A default fallback is labelled
        // distinctly by mappingPathSummary.
        if (mappingSummary) line("mapping:", mappingSummary);
        if (!legacy) {
          if (toolCapabilityNote) {
            console.log(`  ${toolCapabilityNote}`);
          } else if (effectiveToolCapable !== undefined) {
            const capableStr = resolution.toolCapable !== undefined
              ? (resolution.toolCapable ? "yes" : "no")
              : `unset (inferred: ${effectiveToolCapable ? "yes" : "no — pi runtime defaults non-capable"})`;
            line("tool capable:", capableStr);
            const dispStr = dispatchable
              ? "yes"
              : unmapped
                ? "no (activity_unmapped — see below)"
                : `no (fix: set tool_capable: true on the capability entry, or use a non-pi profile)`;
            line("dispatchable:", dispStr);
          }
        }
        if (probe) {
          const icon = probe.status === "available" ? "✓" : probe.status === "unavailable" ? "✗" : "?";
          console.log("");
          console.log(`  availability: ${icon} ${probe.mode} — ${probe.status} (${probe.detail})`);
        }
        // FG-560: the fail-closed refusal, rendered readably. Dispatch would REFUSE
        // this resolution (an explicit activity that only resolves via map.default),
        // so name it here as a dry-run — same fields the --json block carries.
        if (unmapped) {
          console.log("");
          for (const l of renderActivityUnmapped(unmapped)) console.log(`  ${l}`);
        }
      }
    );

  // FG-835: the model-policy write gate. propose never writes; apply without --confirm
  // is propose. Both run the SAME gate (applyModelPolicy) so a green propose and apply's
  // re-run cannot disagree on identical bytes and host state.
  const policy = model
    .command("policy")
    .description("Propose / apply a replacement model-policy.yml through the validation gate (FG-835)");

  type PolicyOpts = { project?: string; json?: boolean; confirm?: boolean; by?: string; allowUndispatchable?: boolean; expectSha256?: string };

  const runPolicyGate = (verb: "propose" | "apply", candidateArg: string, opts: PolicyOpts) => {
    const candidatePath = resolve(candidateArg);
    if (!existsSync(candidatePath)) {
      process.stderr.write(`forge model policy ${verb}: candidate not found: ${candidatePath}\n`);
      process.exitCode = 1;
      return;
    }
    const target = policyTarget(opts.project ? resolve(opts.project) : undefined);
    let result: PolicyApplyResult;
    try {
      result = applyModelPolicy(readFileSync(candidatePath, "utf8"), {
        target,
        candidateLabel: candidatePath,
        allowUndispatchable: opts.allowUndispatchable ?? false,
        confirm: verb === "apply" && (opts.confirm ?? false),
        by: opts.by,
        expectTargetSha256: opts.expectSha256,
      });
    } catch (e) {
      process.stderr.write(`forge model policy ${verb}: failed to write (policy not replaced): ${(e as Error).message}\n`);
      process.exitCode = 1;
      return;
    }

    if (opts.json) {
      console.log(JSON.stringify({ written: result.written, reason: result.reason, detail: result.detail, backup: result.backup, auditLog: result.auditLog, audit: result.audit, ...result.proposal }, null, 2));
    } else {
      console.log(`forge model policy ${verb}`);
      console.log(renderPolicyProposal(result.proposal));
      if (verb === "apply") {
        console.log("");
        if (result.written) {
          console.log(`Applied -> ${target.path}${result.backup ? ` (previous file backed up to ${result.backup})` : ""}.`);
          console.log(`Audited to ${result.auditLog}. Takes effect on the next dispatch.`);
        } else if (result.reason === "not_confirmed") {
          console.log("Not applied — gate passed. Re-run with --confirm to write.");
        } else if (result.reason !== "validation_failed") {
          console.log(`Not applied — ${result.reason}: ${result.detail}. Nothing was written.`);
        } else {
          console.log("Not applied — gate FAILED. Fix the findings above; nothing was written.");
        }
      }
    }
    if (!result.written && result.reason !== "not_confirmed") process.exitCode = 1;
  };

  policy
    .command("propose")
    .argument("<candidate>", "candidate model-policy.yml")
    .option("--project <dir>", "gate against the project's .forge/model-policy.yml (default: the host ~/.forge/model-policy.yml)")
    .option("--allow-undispatchable", "accept a candidate that leaves an installed role undispatchable for its default activity")
    .option("--json", "emit the structured proposal as JSON")
    .description(
      "Validate a candidate model policy (schema_version, name grammar, runtime seeds in the current generation, host-satisfiable auth) and print the resolution diff for every installed role × activity. Never writes; exits 1 when the gate fails."
    )
    .action((candidate: string, opts: PolicyOpts) => runPolicyGate("propose", candidate, opts));

  policy
    .command("apply")
    .argument("<candidate>", "candidate model-policy.yml")
    .option("--project <dir>", "replace the project's .forge/model-policy.yml (default: the host ~/.forge/model-policy.yml)")
    .option("--confirm", "actually write (without it, behaves exactly as propose)")
    .option("--by <who>", "who is applying, recorded in the audit log (default: the OS user)")
    .option("--expect-sha256 <sha>", "refuse (target_changed) unless the target still carries these bytes — the targetSha256 of a reviewed `propose --json` (\"absent\" for no file)")
    .option("--allow-undispatchable", "accept a candidate that leaves an installed role undispatchable for its default activity")
    .option("--json", "emit the structured apply result as JSON")
    .description(
      "Re-run the propose gate and, with --confirm, atomically replace the effective model-policy.yml, keeping a timestamped backup beside it and appending a JSONL line to model-policy-audit.log."
    )
    .action((candidate: string, opts: PolicyOpts) => runPolicyGate("apply", candidate, opts));
}
