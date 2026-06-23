import type { Command } from "commander";
import { resolve } from "node:path";
import { detectEnvFabrication, type AntiShimFlag } from "../../ops/anti-shim.js";

// `forge check-agent-diff [--project <dir>] [--json]` — read-only scan for
// environment fabrication signatures (FG-375). The orchestrator runs this
// after an implementer/test agent to flag forge_shim, dependency_surgery, and
// stub_module patterns. Never mutates anything; the orchestrator decides.

export function renderHuman(result: { clean: boolean; flags: AntiShimFlag[] }): string {
  if (result.clean) return "clean — no environment fabrication signatures detected.";
  const lines: string[] = [`${result.flags.length} environment fabrication flag(s):`, ""];
  for (const f of result.flags) {
    lines.push(`  [${f.kind}]  ${f.path}`);
    lines.push(`    ${f.detail}`);
    lines.push("");
  }
  return lines.join("\n");
}

export function registerCheckAgentDiff(program: Command): void {
  program
    .command("check-agent-diff")
    .description(
      "Inspect a project for environment fabrication signatures (forge_shim, dependency_surgery, stub_module). Read-only — never mutates.",
    )
    .option("--project <dir>", "project directory to inspect (default: cwd)")
    .option("--json", "emit structured { clean, flags } as JSON")
    .action((opts: { project?: string; json?: boolean }) => {
      const projectDir = resolve(opts.project ?? process.cwd());
      const result = detectEnvFabrication(projectDir);

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(renderHuman(result));
    });
}
