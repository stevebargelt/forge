// forge RACI — record-block parser.
//
// Grammar (brutal + simple — see docs/prds/raci-routing-policy.md,
// "Constrained RACI Format"):
//   - A route block starts with `### route: <route_key>`. Route keys are unique.
//   - Fields are `key: value` on ONE line; fixed lowercase names; no multiline.
//   - Required fields: classification_hints, responsible, accountable, path,
//     consulted, required_followups, informed, force_rules.
//   - command is required iff path: cli; forbidden otherwise.
//   - Lists are comma-separated symbols; `none` is the only empty-list sentinel.
//   - informed targets may be conditional: `name:when=condition`.
//   - accountable must be `human`.
//   - Free prose OUTSIDE route blocks (before the first header, or after a
//     block's contiguous field run) is ignored.
//
// This parser enforces the GRAMMAR only. Semantic checks that need the host or
// the force-rule baseline — do force_rules resolve to a known constraint id?
// does responsible name an installed agent? — belong to raci validate /
// route validate (#277/#278), not here.

import { type RouteRecord, type RoutePath, type InformedTarget, ROUTE_PATHS } from "./types.js";

const ROUTE_HEADER_RE = /^### route: (.+)$/;
const FIELD_RE = /^([a-z_]+): (.+)$/;
const WHEN_SEP = ":when=";
/** A symbol: lowercase letters, digits, hyphen, underscore. Route keys, agent
 *  roles, workflow names, evidence sources, informed targets + conditions. */
const SYMBOL_RE = /^[a-z0-9_-]+$/;

const REQUIRED_FIELDS = [
  "classification_hints",
  "responsible",
  "accountable",
  "path",
  "consulted",
  "required_followups",
  "informed",
  "force_rules",
] as const;

const KNOWN_FIELDS = new Set<string>([...REQUIRED_FIELDS, "command"]);

export class RaciParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RaciParseError";
  }
}

/** Parse a RACI record-block document into route records. Throws RaciParseError
 *  on the first grammar violation. */
export function parseRaci(content: string): RouteRecord[] {
  const lines = content.split("\n");
  const routes: RouteRecord[] = [];
  const seenKeys = new Set<string>();

  let i = 0;
  while (i < lines.length) {
    const header = ROUTE_HEADER_RE.exec(lines[i]!);
    if (!header) {
      i++; // prose outside any block — ignored
      continue;
    }

    const routeKey = header[1]!.trim();
    if (!SYMBOL_RE.test(routeKey)) {
      throw new RaciParseError(`malformed route key "${routeKey}" (expected [a-z0-9_-]+)`);
    }
    if (seenKeys.has(routeKey)) {
      throw new RaciParseError(`duplicate route key: ${routeKey}`);
    }
    seenKeys.add(routeKey);

    // Collect the contiguous field run: blank lines are skipped, field lines
    // recorded, and the first non-blank non-field line ends the block (its
    // remainder, until the next header, is ignored prose).
    const fields = new Map<string, string>();
    i++;
    for (; i < lines.length; i++) {
      const line = lines[i]!;
      if (ROUTE_HEADER_RE.test(line)) break; // next block starts
      if (line.trim() === "") continue; // blank — skip, does not end the block
      const fm = FIELD_RE.exec(line);
      if (!fm) break; // prose — block ends here
      const key = fm[1]!;
      if (!KNOWN_FIELDS.has(key)) {
        throw new RaciParseError(`route ${routeKey}: unknown field "${key}"`);
      }
      if (fields.has(key)) {
        throw new RaciParseError(`route ${routeKey}: duplicate field "${key}"`);
      }
      fields.set(key, fm[2]!.trim());
    }

    routes.push(buildRoute(routeKey, fields));
  }

  return routes;
}

function buildRoute(routeKey: string, fields: Map<string, string>): RouteRecord {
  for (const f of REQUIRED_FIELDS) {
    if (!fields.has(f)) {
      throw new RaciParseError(`route ${routeKey}: missing required field "${f}"`);
    }
  }

  const accountable = fields.get("accountable")!;
  if (accountable !== "human") {
    throw new RaciParseError(
      `route ${routeKey}: accountable must be "human" (got "${accountable}")`,
    );
  }

  const responsible = fields.get("responsible")!;
  if (!SYMBOL_RE.test(responsible)) {
    throw new RaciParseError(
      `route ${routeKey}: responsible "${responsible}" is malformed (expected [a-z0-9_-]+)`,
    );
  }

  const path = fields.get("path")!;
  if (!(ROUTE_PATHS as readonly string[]).includes(path)) {
    throw new RaciParseError(
      `route ${routeKey}: invalid path "${path}" (expected one of ${ROUTE_PATHS.join(", ")})`,
    );
  }

  const hasCommand = fields.has("command");
  if (path === "cli" && !hasCommand) {
    throw new RaciParseError(`route ${routeKey}: path "cli" requires a command`);
  }
  if (path !== "cli" && hasCommand) {
    throw new RaciParseError(`route ${routeKey}: command is only allowed for path "cli"`);
  }

  return {
    route: routeKey,
    // classification_hints are advisory free phrases (spaces allowed), so they
    // skip the symbol charset check — but still reject empty items / mixed none.
    classificationHints: splitList(routeKey, "classification_hints", fields.get("classification_hints")!),
    responsible,
    accountable: "human",
    path: path as RoutePath,
    ...(hasCommand ? { command: fields.get("command")! } : {}),
    consulted: parseSymbolList(routeKey, "consulted", fields.get("consulted")!),
    requiredFollowups: parseSymbolList(routeKey, "required_followups", fields.get("required_followups")!),
    informed: parseInformed(routeKey, fields.get("informed")!),
    forceRules: parseSymbolList(routeKey, "force_rules", fields.get("force_rules")!),
  };
}

/** Split a comma-separated list. `none` is the only empty-list sentinel and must
 *  stand alone. Empty items (stray/leading/trailing commas) are rejected — the
 *  grammar is brutal, not forgiving. Item-level charset is NOT checked here
 *  (classification_hints are free phrases); see parseSymbolList for symbol fields. */
function splitList(routeKey: string, field: string, value: string): string[] {
  if (value === "none") return [];
  const items = value.split(",").map((s) => s.trim());
  for (const item of items) {
    if (item === "") {
      throw new RaciParseError(
        `route ${routeKey}: field "${field}" has an empty list item — check for stray/leading/trailing commas; use "none" for an empty list`,
      );
    }
    if (item === "none") {
      throw new RaciParseError(
        `route ${routeKey}: field "${field}" mixes "none" with other values — "none" must stand alone`,
      );
    }
  }
  return items;
}

/** A symbol-only list: every item must match SYMBOL_RE. */
function parseSymbolList(routeKey: string, field: string, value: string): string[] {
  const items = splitList(routeKey, field, value);
  for (const item of items) {
    if (!SYMBOL_RE.test(item)) {
      throw new RaciParseError(
        `route ${routeKey}: field "${field}" has a malformed symbol "${item}" (expected [a-z0-9_-]+)`,
      );
    }
  }
  return items;
}

/** informed targets: `name` or `name:when=condition`. Both name and condition
 *  must be symbols. */
function parseInformed(routeKey: string, value: string): InformedTarget[] {
  return splitList(routeKey, "informed", value).map((item) => {
    const idx = item.indexOf(WHEN_SEP);
    const name = idx === -1 ? item : item.slice(0, idx);
    const when = idx === -1 ? undefined : item.slice(idx + WHEN_SEP.length);
    if (!SYMBOL_RE.test(name)) {
      throw new RaciParseError(
        `route ${routeKey}: informed target "${name}" is malformed (expected [a-z0-9_-]+)`,
      );
    }
    if (when !== undefined && !SYMBOL_RE.test(when)) {
      throw new RaciParseError(
        `route ${routeKey}: informed condition "${when}" on "${name}" is malformed (expected [a-z0-9_-]+)`,
      );
    }
    return when === undefined ? { name } : { name, when };
  });
}
