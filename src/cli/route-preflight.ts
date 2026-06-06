// #297: mechanical route-resolution preflight for the dispatch commands
// (`forge invoke` / `forge new`). #287 hardened the orchestrator PROSE to resolve
// the route before dispatch, but the CLI still allowed raw role dispatch from
// memory (the repeated Pixtron miss). This makes the tool path enforce it: a
// dispatch must either carry a resolved route key (`--route <key>`, validated
// against the compiled policy) or explicitly acknowledge being unrouted
// (`--unrouted`); otherwise it WARNS loudly before spawning (or FAILS under
// FORGE_ROUTE_PREFLIGHT=error).
//
// CLI-layer only: the programmatic invoke()/pipeline spawn paths are not gated —
// this guards the orchestrator's dispatch ENTRY POINTS, where the miss happens.

import { resolvePolicyPath } from "../raci/project.js";
import { explainRouteFile } from "./commands/route.js";

export type PreflightEnforce = "warn" | "error";

export type RoutePreflightInput = {
  command: string;       // "forge invoke" | "forge new" — for the message
  route?: string;        // --route <key>
  unrouted?: boolean;    // --unrouted (explicit acknowledgment)
  projectDir: string;    // resolves the project-or-host compiled policy
  enforce?: PreflightEnforce; // default "warn"
};

export type RoutePreflightResult =
  | { kind: "routed"; routeKey: string }   // --route valid → proceed
  | { kind: "acknowledged" }               // --unrouted → proceed silently
  | { kind: "warn"; message: string }      // unrouted → warn, proceed
  | { kind: "error"; message: string };    // bogus --route, or unrouted under enforce=error → fail

/** Validate a route key against the effective (project-or-host) compiled policy. */
export type RouteKeyValidator = (routeKey: string, projectDir: string) => { ok: true } | { ok: false; message: string };

export function defaultRouteKeyValidator(routeKey: string, projectDir: string): { ok: true } | { ok: false; message: string } {
  const resolved = resolvePolicyPath(projectDir);
  if ("uncompiledOverride" in resolved && resolved.uncompiledOverride) {
    return { ok: false, message: `the project routing override under ${projectDir}/.forge is not compiled — run: forge route compile` };
  }
  const res = explainRouteFile(resolved.path, routeKey);
  return res.ok ? { ok: true } : { ok: false, message: res.findings.map((f) => f.message).join("; ") };
}

function unroutedMessage(command: string): string {
  return (
    `${command}: dispatching WITHOUT a resolved route (#287/#297 route-before-dispatch). ` +
    `Routing a role from memory silently bypasses the compiled routing policy and any project override.\n` +
    `  Resolve the route first:  forge route explain <route-key> --json   then re-run with --route <route-key>\n` +
    `  Or, if this dispatch is intentionally unrouted, pass --unrouted to acknowledge it.`
  );
}

export function routePreflight(
  input: RoutePreflightInput,
  validate: RouteKeyValidator = defaultRouteKeyValidator,
): RoutePreflightResult {
  if (input.route !== undefined) {
    const v = validate(input.route, input.projectDir);
    return v.ok
      ? { kind: "routed", routeKey: input.route }
      : { kind: "error", message: `${input.command}: --route "${input.route}" is not a valid route key — ${v.message}` };
  }
  if (input.unrouted) return { kind: "acknowledged" };
  const message = unroutedMessage(input.command);
  return (input.enforce ?? "warn") === "error" ? { kind: "error", message } : { kind: "warn", message };
}

/** Apply the preflight at a CLI dispatch site: print + exit on error, print on
 *  warn, proceed silently when routed/acknowledged. Returns true to proceed. */
export function applyRoutePreflight(input: RoutePreflightInput, validate?: RouteKeyValidator): boolean {
  const r = routePreflight(input, validate);
  if (r.kind === "error") {
    process.stderr.write(`${r.message}\n`);
    process.exit(2);
  }
  if (r.kind === "warn") process.stderr.write(`${r.message}\n`);
  return true;
}

/** Enforce level from the environment (default warn). FORGE_ROUTE_PREFLIGHT=error
 *  turns an unrouted dispatch into a hard failure for hosts that want teeth. */
export function preflightEnforceFromEnv(): PreflightEnforce {
  return process.env.FORGE_ROUTE_PREFLIGHT === "error" ? "error" : "warn";
}
