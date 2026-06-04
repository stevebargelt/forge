// forge RACI — authoring-view lint (the core of `forge raci validate`, #277).
//
// Host-INDEPENDENT validation of the RACI SOURCE document. Makes NO claim about
// what is installed on a host — no agent/workflow/command resolution, no project
// override drift. That is route validate (#278). Checks:
//   - grammar (via parseRaci; the first violation is reported)
//   - accountable=human (parser-enforced; kept as a defensive finding)
//   - informed names are in the fixed controlled vocabulary (vocab.ts)
//   - force_rules resolve to the static baseline — DORMANT while the baseline is
//     empty; we do not pretend resolution exists
//   - the document still compiles to a schema-valid policy (sanity)
//
// Symbol SHAPE (responsible / consulted / required_followups / force_rules) and
// classification_hints presence are guaranteed by parseRaci, so they are not
// re-checked here.

import { parseRaci, RaciParseError } from "./parse.js";
import { compileRaciDocument } from "./compile.js";
import { INFORMED_TARGETS, FORCE_RULES_BASELINE } from "./vocab.js";

export type RaciFinding = {
  code: string;
  message: string;
  route?: string;
};

export type RaciValidation = {
  ok: boolean;
  findings: RaciFinding[];
};

/** Lint a RACI source document. Returns a JSON-serializable result. */
export function validateRaci(content: string): RaciValidation {
  // 1. Grammar. parseRaci throws on the first violation; report it and stop —
  //    there are no parsed routes to run semantic checks against.
  let routes;
  try {
    routes = parseRaci(content);
  } catch (e) {
    if (e instanceof RaciParseError) {
      return { ok: false, findings: [{ code: "parse_error", message: e.message }] };
    }
    throw e;
  }

  const findings: RaciFinding[] = [];

  // 2. Per-route semantic checks (collected across all routes).
  for (const r of routes) {
    // Defensive — parseRaci already rejects non-human accountable.
    if (r.accountable !== "human") {
      findings.push({ code: "accountable_not_human", route: r.route, message: 'accountable must be "human"' });
    }

    for (const t of r.informed) {
      if (!INFORMED_TARGETS.has(t.name)) {
        findings.push({
          code: "informed_unknown",
          route: r.route,
          message: `informed target "${t.name}" is not in the controlled vocabulary`,
        });
      }
    }

    // Force-rule resolution only when a baseline exists. Empty baseline => the
    // check is dormant (we don't pretend resolution exists).
    if (FORCE_RULES_BASELINE.size > 0) {
      for (const fr of r.forceRules) {
        if (!FORCE_RULES_BASELINE.has(fr)) {
          findings.push({
            code: "force_rule_unknown",
            route: r.route,
            message: `force rule "${fr}" is not in the static baseline`,
          });
        }
      }
    }
  }

  // 3. Sanity: the document must still compile to a schema-valid policy.
  try {
    compileRaciDocument(content);
  } catch (e) {
    findings.push({ code: "compile_error", message: e instanceof Error ? e.message : String(e) });
  }

  return { ok: findings.length === 0, findings };
}
