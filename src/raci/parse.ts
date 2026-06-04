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
    classificationHints: parseList(fields.get("classification_hints")!),
    responsible: fields.get("responsible")!,
    accountable: "human",
    path: path as RoutePath,
    ...(hasCommand ? { command: fields.get("command")! } : {}),
    consulted: parseList(fields.get("consulted")!),
    requiredFollowups: parseList(fields.get("required_followups")!),
    informed: parseInformed(fields.get("informed")!),
    forceRules: parseList(fields.get("force_rules")!),
  };
}

/** Comma-separated symbols; `none` is the only empty-list sentinel. */
function parseList(value: string): string[] {
  if (value === "none") return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parseInformed(value: string): InformedTarget[] {
  return parseList(value).map((item) => {
    const idx = item.indexOf(WHEN_SEP);
    if (idx === -1) return { name: item };
    return { name: item.slice(0, idx), when: item.slice(idx + WHEN_SEP.length) };
  });
}
