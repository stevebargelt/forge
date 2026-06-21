import type { Command } from "commander";
import { resolve } from "node:path";
import { ensureForgeDirs } from "../../util/paths.js";
import { resolveModel, type ModelResolution } from "../../v2/model-resolution.js";
import { probeAuth, type AuthProbe } from "../../v2/provider-doctor.js";
import { loadRuntime } from "../../v2/loader.js";
import { resolveRuntimeMetadata } from "../../v2/schema.js";
import { requiresStructuredResult } from "../../v2/role-capabilities.js";

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

        let resolution: ModelResolution;
        try {
          resolution = resolveModel({
            agentRole: agent,
            stepAlias: opts.activity,
            cliProfile: opts.profile,
            runtimeName: "claude",
            ctx: { projectDir },
          });
        } catch (e) {
          // Fail-loud resolution errors (unknown --profile, unmapped capability).
          const msg = (e as Error).message;
          if (opts.json) console.log(JSON.stringify({ error: msg }, null, 2));
          else console.error(`✗ resolution failed: ${msg}`);
          process.exitCode = 1;
          return;
        }

        const probe: AuthProbe | undefined =
          opts.check && resolution.auth ? probeAuth(resolution.provider, resolution.auth) : undefined;

        const legacy = resolution.resolvedBy === "legacy";

        // FG-339: compute tool capability and dispatchability for policy-mode resolutions.
        let effectiveToolCapable: boolean | undefined;
        let dispatchable: boolean | undefined;
        let toolCapabilityNote: string | undefined;
        if (!legacy) {
          try {
            const rt = loadRuntime(resolution.runtime);
            const runtimeMeta = resolveRuntimeMetadata(rt);
            effectiveToolCapable = resolution.toolCapable ?? (runtimeMeta.runtimeKind !== "pi");
            dispatchable = !requiresStructuredResult(agent) || effectiveToolCapable;
          } catch {
            toolCapabilityNote = `(could not resolve runtime '${resolution.runtime}' — tool capability unknown)`;
          }
        }

        if (opts.json) {
          console.log(JSON.stringify({
            ...resolution,
            ...(probe ? { availability: probe } : {}),
            ...(!legacy && effectiveToolCapable !== undefined ? { toolCapable: resolution.toolCapable, effectiveToolCapable, dispatchable } : {}),
          }, null, 2));
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
        }
        line("runtime:", resolution.runtime);
        line("resolved by:", resolution.resolvedBy);
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
              : `no (fix: set tool_capable: true on the capability entry, or use a non-pi profile)`;
            line("dispatchable:", dispStr);
          }
        }
        if (probe) {
          const icon = probe.status === "available" ? "✓" : probe.status === "unavailable" ? "✗" : "?";
          console.log("");
          console.log(`  availability: ${icon} ${probe.mode} — ${probe.status} (${probe.detail})`);
        }
      }
    );
}
