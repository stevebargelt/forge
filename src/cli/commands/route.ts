import type { Command } from "commander";
import { join, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { ROUTING_POLICY_PATH, RACI_PATH, AGENTS_DIR, WORKFLOWS_DIR } from "../../util/paths.js";
import { validateRoutePolicy, type HostEnv, type RouteValidation } from "../../raci/route-validate.js";

// `forge route validate [policyPath] [--raci path] [--json]` — operational-policy
// lint of the DERIVED routing-policy.yml (#278). Resolves symbols against THIS
// host and, when a RACI source is present, checks drift against the compiled
// RACI. Never generates the policy: a missing policy is a finding, not a silent
// compile from RACI. An absent RACI is not a failure (a policy may travel alone).

/** Real host lookups against ~/.forge. */
const realHost: HostEnv = {
  agentInstalled: (role) => existsSync(join(AGENTS_DIR, role)),
  workflowKnown: (name) => existsSync(join(WORKFLOWS_DIR, `${name}.yml`)),
};

/** Read + lint a routing policy file. Host is injectable for testing. */
export function validateRoutePolicyFile(
  policyPath: string,
  opts: { raciPath?: string; host?: HostEnv } = {},
): RouteValidation {
  const host = opts.host ?? realHost;

  // Resolve the RACI source (for drift), if any. An explicit --raci that's
  // missing is an error; an absent default RACI just means standalone.
  let raciSource: string | undefined;
  if (opts.raciPath !== undefined) {
    if (!existsSync(opts.raciPath)) {
      return {
        ok: false,
        mode: "with-raci",
        findings: [{ code: "raci_not_found", message: `RACI file not found: ${opts.raciPath}` }],
      };
    }
    raciSource = readFileSync(opts.raciPath, "utf8");
  } else if (existsSync(RACI_PATH)) {
    raciSource = readFileSync(RACI_PATH, "utf8");
  }
  const mode: RouteValidation["mode"] = raciSource !== undefined ? "with-raci" : "standalone";

  if (!existsSync(policyPath)) {
    return {
      ok: false,
      mode,
      findings: [
        {
          code: "policy_not_found",
          message: `routing policy not found: ${policyPath} (route validate does not generate it — compile the RACI first)`,
        },
      ],
    };
  }

  let policyObj: unknown;
  try {
    policyObj = parseYaml(readFileSync(policyPath, "utf8"));
  } catch (e) {
    return {
      ok: false,
      mode,
      findings: [{ code: "policy_parse_error", message: `cannot parse ${policyPath}: ${(e as Error).message}` }],
    };
  }

  return validateRoutePolicy(policyObj, host, raciSource);
}

export function renderHuman(path: string, v: RouteValidation): string {
  if (v.ok) return `Routing policy ${path}: OK — no findings (${v.mode}).`;
  const lines = [`Routing policy ${path}: ${v.findings.length} finding(s) (${v.mode}):`, ""];
  for (const f of v.findings) {
    const where = f.route ? ` [route: ${f.route}]` : "";
    lines.push(`  [${f.code}]${where} ${f.message}`);
  }
  return lines.join("\n");
}

export function registerRoute(program: Command): void {
  const route = program.command("route").description("Work with the derived routing policy.");

  route
    .command("validate")
    .argument("[policyPath]", "routing-policy.yml to validate (default: ~/.forge/routing-policy.yml)")
    .option("--raci <path>", "RACI source to check drift against (default: ~/.forge/forge-raci.md if present)")
    .option("--json", "emit structured { ok, mode, path, findings } as JSON")
    .description(
      "Lint the derived routing policy against this host (agents/workflows/CLI actions/evidence) and, when a RACI source is present, check drift. Never generates the policy.",
    )
    .action((policyArg: string | undefined, opts: { raci?: string; json?: boolean }) => {
      const path = policyArg ? resolve(policyArg) : ROUTING_POLICY_PATH;
      const raciPath = opts.raci ? resolve(opts.raci) : undefined;
      const v = validateRoutePolicyFile(path, { raciPath });

      if (opts.json) {
        console.log(JSON.stringify({ ok: v.ok, mode: v.mode, path, findings: v.findings }, null, 2));
      } else {
        console.log(renderHuman(path, v));
      }
      if (!v.ok) process.exit(1);
    });
}
