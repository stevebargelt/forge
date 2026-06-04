import type { Command } from "commander";
import { join, resolve } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parse as parseYaml, stringify as yamlStringify } from "yaml";
import { ROUTING_POLICY_PATH, RACI_PATH, AGENTS_DIR, WORKFLOWS_DIR, ensureForgeDirs } from "../../util/paths.js";
import { validateRoutePolicy, type HostEnv, type RouteValidation, type RouteFinding } from "../../raci/route-validate.js";
import { compileRaciDocument } from "../../raci/compile.js";
import { RoutingPolicySchema, type PolicyRoute } from "../../raci/policy-schema.js";

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

export type RouteExplanation =
  | { ok: true; route: PolicyRoute }
  | { ok: false; findings: RouteFinding[] };

/** Explain a route from a policy by EXACT key. No prompt classification — the
 *  caller (orchestrator) classifies to a work-type key, this looks it up. */
export function explainRoute(policyInput: unknown, routeKey: string): RouteExplanation {
  const parsed = RoutingPolicySchema.safeParse(policyInput);
  if (!parsed.success) {
    return {
      ok: false,
      findings: parsed.error.issues.map((i) => ({
        code: "schema_error",
        message: `${i.path.join(".") || "(root)"}: ${i.message}`,
      })),
    };
  }
  const route = parsed.data.routes[routeKey];
  if (!route) {
    const known = Object.keys(parsed.data.routes).sort().join(", ");
    return {
      ok: false,
      findings: [{ code: "unknown_route", message: `no route "${routeKey}" in the policy. Known routes: ${known}` }],
    };
  }
  return { ok: true, route };
}

function renderRoute(routeKey: string, r: PolicyRoute): string {
  const lines = [`route: ${routeKey}`];
  lines.push(`  responsible:        ${r.responsible}`);
  lines.push(`  path:               ${r.path}`);
  if (r.command) lines.push(`  command:            ${r.command}`);
  lines.push(`  consulted:          ${r.consulted.join(", ") || "(none)"}`);
  lines.push(`  required_followups: ${r.required_followups.join(", ") || "(none)"}`);
  lines.push(
    `  informed:           ${r.informed.map((t) => (t.when ? `${t.name}:when=${t.when}` : t.name)).join(", ") || "(none)"}`,
  );
  lines.push(`  force_rules:        ${r.force_rules.join(", ") || "(none)"}`);
  if (r.classification_hints?.length) lines.push(`  classification_hints: ${r.classification_hints.join(", ")}`);
  return lines.join("\n");
}

export function registerRoute(program: Command): void {
  const route = program.command("route").description("Work with the derived routing policy.");

  route
    .command("compile")
    .argument("[raciPath]", "RACI source to compile (default: ~/.forge/forge-raci.md)")
    .option("-o, --out <path>", "output path (default: ~/.forge/routing-policy.yml)")
    .option("--json", "emit the compiled policy as JSON to stdout instead of writing a file")
    .description("Compile the RACI source into routing-policy.yml. Validates as it compiles.")
    .action((raciArg: string | undefined, opts: { out?: string; json?: boolean }) => {
      const raciPath = raciArg ? resolve(raciArg) : RACI_PATH;
      if (!existsSync(raciPath)) {
        process.stderr.write(`forge route compile: RACI source not found: ${raciPath}\n`);
        process.exit(1);
      }
      let policy;
      try {
        policy = compileRaciDocument(readFileSync(raciPath, "utf8"));
      } catch (e) {
        process.stderr.write(`forge route compile: ${(e as Error).message}\n`);
        process.exit(1);
      }
      if (opts.json) {
        console.log(JSON.stringify(policy, null, 2));
        return;
      }
      const out = opts.out ? resolve(opts.out) : ROUTING_POLICY_PATH;
      ensureForgeDirs();
      writeFileSync(out, yamlStringify(policy));
      console.log(`Compiled ${Object.keys(policy.routes).length} routes -> ${out}`);
    });

  route
    .command("explain")
    .argument("<routeKey>", "the route/work-type key to explain (exact match)")
    .argument("[policyPath]", "policy to read (default: ~/.forge/routing-policy.yml)")
    .option("--json", "emit the full route as JSON")
    .description("Explain a route from the compiled policy by exact key. Does NOT classify prompts.")
    .action((routeKey: string, policyArg: string | undefined, opts: { json?: boolean }) => {
      const path = policyArg ? resolve(policyArg) : ROUTING_POLICY_PATH;
      if (!existsSync(path)) {
        if (opts.json) {
          console.log(JSON.stringify({ ok: false, findings: [{ code: "policy_not_found", message: `routing policy not found: ${path} (run: forge route compile)` }] }, null, 2));
        } else {
          process.stderr.write(`forge route explain: routing policy not found: ${path}\n  Run: forge route compile\n`);
        }
        process.exit(1);
      }
      let policyObj: unknown;
      try {
        policyObj = parseYaml(readFileSync(path, "utf8"));
      } catch (e) {
        process.stderr.write(`forge route explain: cannot parse ${path}: ${(e as Error).message}\n`);
        process.exit(1);
      }
      const res = explainRoute(policyObj, routeKey);
      if (opts.json) {
        console.log(JSON.stringify(res, null, 2));
      } else if (res.ok) {
        console.log(renderRoute(routeKey, res.route));
      } else {
        console.log(res.findings.map((f) => `[${f.code}] ${f.message}`).join("\n"));
      }
      if (!res.ok) process.exit(1);
    });

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
