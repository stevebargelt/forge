import type { Command } from "commander";
import { dirname, join, resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parse as parseYaml, stringify as yamlStringify } from "yaml";
import { ROUTING_POLICY_PATH, RACI_PATH, AGENTS_DIR, WORKFLOWS_DIR } from "../../util/paths.js";
import {
  validateRoutePolicy,
  checkForceRuleWeakening,
  type HostEnv,
  type RouteValidation,
  type RouteFinding,
} from "../../raci/route-validate.js";
import { compileRaciDocument } from "../../raci/compile.js";
import { RoutingPolicySchema, type PolicyRoute } from "../../raci/policy-schema.js";
import {
  governanceView,
  loadPolicy,
  overrideNotCompiledFinding,
  type GovernanceView,
} from "../../raci/governance.js";
import {
  resolvePolicyPath,
  resolveRaciPath,
  projectPolicyPath,
  describeNoEffectiveHostPolicy,
  type RoutingSource,
} from "../../raci/project.js";

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

/** Read a policy file and explain a route. A missing OR corrupt policy is a
 *  STRUCTURED result, never a thrown/printed error — so `--json` stays
 *  machine-readable for the orchestrator across every failure mode. */
export function explainRouteFile(policyPath: string, routeKey: string): RouteExplanation {
  if (!existsSync(policyPath)) {
    return {
      ok: false,
      findings: [{ code: "policy_not_found", message: `routing policy not found: ${policyPath} (run: forge route compile)` }],
    };
  }
  let policyObj: unknown;
  try {
    policyObj = parseYaml(readFileSync(policyPath, "utf8"));
  } catch (e) {
    return {
      ok: false,
      findings: [{ code: "policy_parse_error", message: `cannot parse ${policyPath}: ${(e as Error).message}` }],
    };
  }
  return explainRoute(policyObj, routeKey);
}

export type ResolvedSource = RoutingSource | "explicit";
export type ProjectRouteValidation = RouteValidation & { source: ResolvedSource; path: string };

/** FG-583 (finding 1b): resolve where a `route compile` invocation would WRITE, and
 *  whether that target is the authoritative flat host routing-policy.yml — which is
 *  NEVER effective for dispatch (the effective host policy is compiled INTO the seed
 *  generation, published only by `forge upgrade`). Host-targeting is recognized by the
 *  RESOLVED TARGET, not the absence of --project: a default host compile AND an
 *  explicit-path compile of the host RACI (e.g. `forge route compile ~/.forge/forge-raci.md`)
 *  both resolve to the flat host file, so both must refuse-and-direct. A project
 *  override policy and an explicit `-o` export path are honored (neither is the flat
 *  host file). */
export function resolveCompileTarget(opts: { source: ResolvedSource; projectDir: string; out?: string }): {
  out: string;
  hostFlatTarget: boolean;
} {
  const out = opts.out
    ? resolve(opts.out)
    : opts.source === "project"
      ? projectPolicyPath(opts.projectDir)
      : ROUTING_POLICY_PATH;
  return { out, hostFlatTarget: out === ROUTING_POLICY_PATH };
}

/** Resolve the effective policy (project override or host), validate it, and —
 *  when it is a PROJECT override — additionally enforce that it does not weaken a
 *  force rule the host policy mandates (#280). The drift RACI is the effective
 *  RACI for the same context unless one is given explicitly. Host paths are
 *  injectable so the override comparison is testable without real ~/.forge. */
export function validateRoutingResolved(opts: {
  projectDir?: string;
  explicitPolicy?: string;
  explicitRaci?: string;
  host?: HostEnv;
  hostPolicyPath?: string;
}): ProjectRouteValidation {
  const host = opts.host ?? realHost;

  const resolved: { source: ResolvedSource; path: string; uncompiledOverride?: boolean; noGeneration?: boolean; incompletePolicy?: string } = opts.explicitPolicy
    ? { source: "explicit", path: resolve(opts.explicitPolicy) }
    : resolvePolicyPath(opts.projectDir);

  // FG-583: the force-weakening baseline is the generation's host policy, never the
  // flat file. Injectable for tests; when absent, resolve from the generation. A
  // no-generation OR torn/tampered host policy (finding 2) yields no trustworthy
  // baseline — "" so loadPolicy returns undefined and the weakening check is skipped
  // rather than run against mis-routing bytes.
  const hostResolved = resolvePolicyPath(undefined);
  const hostPolicyPath = opts.hostPolicyPath ?? (hostResolved.noGeneration || hostResolved.incompletePolicy ? "" : hostResolved.path);

  // An uncompiled project override must fail here, not silently validate the host
  // policy (or a missing path) — tell the operator to compile the override.
  if (resolved.source === "project" && resolved.uncompiledOverride && opts.projectDir !== undefined) {
    return {
      ok: false,
      mode: "with-raci",
      findings: [overrideNotCompiledFinding(opts.projectDir)],
      source: "project",
      path: resolved.path,
    };
  }

  // FG-583: a host resolution with no complete seed generation — OR a torn/tampered
  // generation policy (finding 2) — has NO usable effective routing policy to
  // validate. Report the NAMED state (finding 4: absent vs incomplete/torn), never
  // read the flat file.
  if (resolved.source === "host" && (resolved.noGeneration || resolved.incompletePolicy)) {
    const code = resolved.incompletePolicy ? "incomplete_seed_generation" : "no_seed_generation";
    return {
      ok: false,
      mode: "with-raci",
      findings: [{ code, message: describeNoEffectiveHostPolicy(resolved) }],
      source: "host",
      path: resolved.path,
    };
  }

  // Drift RACI: explicit wins; otherwise the effective RACI for this context, but
  // only when it exists (an absent RACI means standalone, not an error).
  let raciArg: string | undefined;
  if (opts.explicitRaci !== undefined) {
    raciArg = resolve(opts.explicitRaci);
  } else {
    const r = resolveRaciPath(opts.projectDir);
    raciArg = r.exists ? r.path : undefined;
  }

  const base = validateRoutePolicyFile(resolved.path, { raciPath: raciArg, host });
  let findings = base.findings;

  if (resolved.source === "project" && resolved.path !== hostPolicyPath) {
    const hostPolicy = loadPolicy(hostPolicyPath);
    const projectPolicy = loadPolicy(resolved.path);
    if (hostPolicy && projectPolicy) {
      findings = [...findings, ...checkForceRuleWeakening(hostPolicy, projectPolicy)];
    }
  }

  return { ok: findings.length === 0, mode: base.mode, findings, source: resolved.source, path: resolved.path };
}

function renderGovernance(view: Extract<GovernanceView, { ok: true }>): string {
  const lines: string[] = [];
  if (view.drift && view.drift.length) {
    const fix = `forge route compile${view.source === "project" ? " --project <dir>" : ""}`;
    lines.push(`# ⚠ DRIFT — the compiled policy is STALE vs its RACI source; the table below may NOT match the live rules. Run: ${fix}`);
    for (const f of view.drift) {
      lines.push(`#   [${f.code}]${f.route ? ` [route: ${f.route}]` : ""} ${f.message}`);
    }
    lines.push("");
  }
  lines.push(`# effective governance — source: ${view.source} (${view.path})`);
  lines.push(`# accountable: ${view.accountable} (header invariant — always human)`);
  lines.push("");
  for (const [key, route] of Object.entries(view.routes)) {
    lines.push(renderRoute(key, route));
    lines.push("");
  }
  if (view.diff) {
    lines.push("# host -> project override diff:");
    const { added, removed, modified } = view.diff;
    if (added.length === 0 && removed.length === 0 && modified.length === 0) {
      lines.push("  (project routing is identical to host)");
    } else {
      if (added.length) lines.push(`  added (project-only):  ${added.join(", ")}`);
      if (removed.length) lines.push(`  removed (host-only):   ${removed.join(", ")}`);
      for (const m of modified) {
        lines.push(`  modified: ${m.route}`);
        for (const f of m.fields) {
          lines.push(`              ${f.field}: ${JSON.stringify(f.before)} (host) -> ${JSON.stringify(f.after)} (project)`);
        }
      }
    }
  }
  return lines.join("\n").trimEnd();
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
    .argument("[raciPath]", "explicit RACI source (default: project override under --project/.forge, else ~/.forge/forge-raci.md)")
    .option("--project <dir>", "compile the project's RACI override under <dir>/.forge (default: cwd)")
    .option("-o, --out <path>", "output path (default: the routing-policy.yml beside the resolved RACI source)")
    .option("--json", "emit the compiled policy as JSON to stdout instead of writing a file")
    .description("Compile the RACI source into routing-policy.yml. Validates as it compiles. Resolves the project override when present (full replacement).")
    .action((raciArg: string | undefined, opts: { project?: string; out?: string; json?: boolean }) => {
      const projectDir = resolve(opts.project ?? process.cwd());
      const resolved = raciArg
        ? { source: "explicit" as const, path: resolve(raciArg) }
        : resolveRaciPath(projectDir);
      if (!existsSync(resolved.path)) {
        process.stderr.write(`forge route compile: RACI source not found: ${resolved.path}\n`);
        process.exit(1);
      }
      let policy;
      try {
        policy = compileRaciDocument(readFileSync(resolved.path, "utf8"));
      } catch (e) {
        process.stderr.write(`forge route compile: ${(e as Error).message}\n`);
        process.exit(1);
      }
      if (opts.json) {
        console.log(JSON.stringify(policy, null, 2));
        return;
      }
      // FG-583 (finding 1b): the HOST routing policy is NOT effective as a flat file
      // — it lives COMPILED INSIDE the seed generation, published exclusively by
      // `forge upgrade`. Any compile whose TARGET is the authoritative flat host policy
      // would silently change nothing a run reads — the exact defect to eliminate.
      // resolveCompileTarget recognizes host-targeting by the RESOLVED TARGET, so it
      // catches the default host compile AND an explicit-path compile of the host RACI.
      const { out, hostFlatTarget } = resolveCompileTarget({ source: resolved.source, projectDir, out: opts.out });
      if (hostFlatTarget) {
        console.log(
          `RACI compiles cleanly (${Object.keys(policy.routes).length} routes), but the host routing policy is NOT written as a flat file.\n` +
            `The effective host policy is compiled INTO the seed generation and published atomically by \`forge upgrade\`.\n` +
            `To make this routing change effective for dispatch, run: forge upgrade`,
        );
        return;
      }
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, yamlStringify(policy));
      console.log(`Compiled ${Object.keys(policy.routes).length} routes (${resolved.source}) -> ${out}`);
    });

  route
    .command("explain")
    .argument("<routeKey>", "the route/work-type key to explain (exact match)")
    .argument("[policyPath]", "explicit policy to read (default: project override under --project/.forge, else host)")
    .option("--project <dir>", "resolve the project override under <dir>/.forge (default: cwd)")
    .option("--json", "emit the full route as JSON")
    .description("Explain a route from the compiled policy by exact key. Resolves the project override when present. Does NOT classify prompts.")
    .action((routeKey: string, policyArg: string | undefined, opts: { project?: string; json?: boolean }) => {
      const projectDir = resolve(opts.project ?? process.cwd());
      const resolved = policyArg
        ? { source: "explicit" as const, path: resolve(policyArg) }
        : resolvePolicyPath(projectDir);

      // A project RACI override with no compiled policy must NOT fall back to host
      // — that would route the live prompt path from the wrong policy.
      if (!policyArg && "uncompiledOverride" in resolved && resolved.uncompiledOverride) {
        const finding = overrideNotCompiledFinding(projectDir);
        if (opts.json) {
          console.log(JSON.stringify({ source: "project", path: resolved.path, ok: false, findings: [finding] }, null, 2));
        } else {
          process.stderr.write(`[${finding.code}] ${finding.message}\n`);
        }
        process.exit(1);
      }

      // FG-583: host resolution with no published generation — OR a torn/tampered
      // generation policy (finding 2) — has no effective policy. Report the NAMED
      // state (finding 4: absent vs incomplete/torn), never read the flat file.
      if (!policyArg && "source" in resolved && resolved.source === "host" && (resolved.noGeneration || resolved.incompletePolicy)) {
        const code = resolved.incompletePolicy ? "incomplete_seed_generation" : "no_seed_generation";
        const finding = { code, message: describeNoEffectiveHostPolicy(resolved) };
        if (opts.json) {
          console.log(JSON.stringify({ source: "host", path: resolved.path, ok: false, findings: [finding] }, null, 2));
        } else {
          process.stderr.write(`[${finding.code}] ${finding.message}\n`);
        }
        process.exit(1);
      }

      const res = explainRouteFile(resolved.path, routeKey);
      if (opts.json) {
        console.log(JSON.stringify({ source: resolved.source, path: resolved.path, ...res }, null, 2));
      } else if (res.ok) {
        console.log(`# source: ${resolved.source} (${resolved.path})`);
        console.log(renderRoute(routeKey, res.route));
      } else {
        process.stderr.write(`${res.findings.map((f) => `[${f.code}] ${f.message}`).join("\n")}\n`);
      }
      if (!res.ok) process.exit(1);
    });

  route
    .command("governance")
    .option("--project <dir>", "resolve the project override under <dir>/.forge (default: cwd)")
    .option("--json", "emit the structured governance view as JSON")
    .description(
      "Read-only effective-governance view: the routes the resolved policy compiles to (executable fields), plus a host-vs-project diff for an override. Never writes, validates, or merges.",
    )
    .action((opts: { project?: string; json?: boolean }) => {
      const projectDir = resolve(opts.project ?? process.cwd());
      const view = governanceView({ projectDir });
      if (opts.json) {
        console.log(JSON.stringify(view, null, 2));
      } else if (view.ok) {
        console.log(renderGovernance(view));
      } else {
        process.stderr.write(`${view.findings.map((f) => `[${f.code}] ${f.message}`).join("\n")}\n`);
      }
      // Drift is a non-silent failure: the table is shown, but exit non-zero so a
      // stale policy can't pass unnoticed in automation either.
      const drifted = view.ok && (view.drift?.length ?? 0) > 0;
      if (!view.ok || drifted) process.exit(1);
    });

  route
    .command("validate")
    .argument("[policyPath]", "explicit policy to validate (default: project override under --project/.forge, else host)")
    .option("--project <dir>", "resolve the project override under <dir>/.forge (default: cwd)")
    .option("--raci <path>", "RACI source to check drift against (default: the effective RACI for the context)")
    .option("--json", "emit structured { ok, mode, source, path, findings } as JSON")
    .description(
      "Lint the derived routing policy against this host (agents/workflows/CLI actions/evidence) and check drift. Resolves the project override and enforces that overrides don't weaken force rules. Never generates the policy.",
    )
    .action((policyArg: string | undefined, opts: { project?: string; raci?: string; json?: boolean }) => {
      const projectDir = resolve(opts.project ?? process.cwd());
      const v = validateRoutingResolved({
        projectDir,
        explicitPolicy: policyArg ? resolve(policyArg) : undefined,
        explicitRaci: opts.raci ? resolve(opts.raci) : undefined,
      });

      if (opts.json) {
        console.log(JSON.stringify({ ok: v.ok, mode: v.mode, source: v.source, path: v.path, findings: v.findings }, null, 2));
      } else {
        console.log(`# source: ${v.source} (${v.path})`);
        console.log(renderHuman(v.path, v));
      }
      if (!v.ok) process.exit(1);
    });
}
