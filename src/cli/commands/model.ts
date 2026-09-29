import type { Command } from "commander";
import { resolve } from "node:path";
import { ensureForgeDirs } from "../../util/paths.js";
import { renderActivityUnmapped } from "../../v2/model-provenance.js";
import { modelResolveReport } from "../../v2/model-resolve-report.js";

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
}
