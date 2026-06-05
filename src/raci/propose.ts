// forge RACI — orchestrator-mediated authoring core (#279, Story 6).
//
// The PRIMARY edit channel: an operator describes a routing change in
// conversation, the orchestrator translates it to a candidate RACI, and this
// module runs the full gate BEFORE anything is written —
//   raci validate (host-independent) -> compile (IN MEMORY) -> route validate
//   (host resolution + drift) -> rendered diff + route-change summary.
//
// `proposeRaciChange` is PURE: no filesystem, no policy file written. It compiles
// the candidate in memory and validates against that object, so `propose` can
// prove a candidate is safe without ever touching ~/.forge/routing-policy.yml.
// The actual write + audit (the confirm-gate) lives in the CLI layer.

import { isDeepStrictEqual } from "node:util";
import { validateRaci, type RaciValidation } from "./validate.js";
import { compileRaciDocument } from "./compile.js";
import { validateRoutePolicy, type RouteValidation, type HostEnv } from "./route-validate.js";
import type { RoutingPolicy, PolicyRoute } from "./policy-schema.js";

// Executable fields surfaced for a modified route (advisory classification_hints
// are intentionally excluded — this is the behavioral surface, not Story 8's
// effective-governance view).
const EXECUTABLE_FIELDS = [
  "responsible",
  "path",
  "command",
  "consulted",
  "required_followups",
  "informed",
  "force_rules",
] as const satisfies ReadonlyArray<keyof PolicyRoute>;

export type FieldChange = { field: string; before: unknown; after: unknown };
export type ModifiedRoute = { route: string; fields: FieldChange[] };

export type RouteChangeSummary = {
  added: string[];
  removed: string[];
  modified: ModifiedRoute[];
};

export type RaciProposal = {
  /** The gate verdict: true iff the candidate passes BOTH validators. The only
   *  signal `apply` honors before writing. */
  ok: boolean;
  validation: {
    raci: RaciValidation;
    route: RouteValidation;
  };
  /** Unified line diff, current RACI -> candidate RACI. */
  raciDiff: string;
  /** What the edit changes about the COMPILED routes (current -> candidate). */
  routeChanges: RouteChangeSummary;
};

/** Run the full authoring gate on a candidate RACI without writing anything.
 *  `current` is the existing RACI source ("" when none is installed). */
export function proposeRaciChange(current: string, candidate: string, host: HostEnv): RaciProposal {
  // 1. Authoring-view lint (host-independent). Catches grammar, vocab, and a
  //    non-compiling candidate.
  const raci = validateRaci(candidate);

  // 2. Compile the candidate IN MEMORY, then operational-lint that object. If the
  //    candidate doesn't compile, raci already reported it; route validation has
  //    no object to resolve, so it fails with the compile error rather than
  //    pretending to pass.
  let route: RouteValidation;
  let candidatePolicy: RoutingPolicy | undefined;
  try {
    candidatePolicy = compileRaciDocument(candidate);
    route = validateRoutePolicy(candidatePolicy, host, candidate);
  } catch (e) {
    route = {
      ok: false,
      mode: "with-raci",
      findings: [{ code: "candidate_compile_error", message: e instanceof Error ? e.message : String(e) }],
    };
  }

  return {
    ok: raci.ok && route.ok,
    validation: { raci, route },
    raciDiff: current === candidate ? "" : unifiedDiff(current, candidate),
    routeChanges: summarizeRouteChanges(compileQuietly(current), candidatePolicy),
  };
}

/** Compile a RACI source to its routes, swallowing errors. Used only for the
 *  change SUMMARY (current side) — a non-compiling/absent current simply has no
 *  prior routes, so every candidate route reads as added. */
function compileQuietly(source: string): RoutingPolicy | undefined {
  if (source.trim() === "") return undefined;
  try {
    return compileRaciDocument(source);
  } catch {
    return undefined;
  }
}

/** Summarize how the compiled routes change from `before` to `after`: added,
 *  removed, and per-route modified (changed executable fields only). Reused by the
 *  read-only governance view (#281) to diff host vs project. */
export function summarizeRouteChanges(
  before: RoutingPolicy | undefined,
  after: RoutingPolicy | undefined,
): RouteChangeSummary {
  const beforeRoutes = before?.routes ?? {};
  const afterRoutes = after?.routes ?? {};
  const added: string[] = [];
  const removed: string[] = [];
  const modified: ModifiedRoute[] = [];

  for (const key of Object.keys(afterRoutes)) {
    const a = afterRoutes[key];
    const b = beforeRoutes[key];
    if (b === undefined) {
      added.push(key);
    } else if (a !== undefined && !isDeepStrictEqual(a, b)) {
      modified.push({ route: key, fields: changedFields(b, a) });
    }
  }
  for (const key of Object.keys(beforeRoutes)) {
    if (!(key in afterRoutes)) removed.push(key);
  }

  added.sort();
  removed.sort();
  modified.sort((x, y) => x.route.localeCompare(y.route));
  return { added, removed, modified };
}

function changedFields(before: PolicyRoute, after: PolicyRoute): FieldChange[] {
  const changes: FieldChange[] = [];
  for (const field of EXECUTABLE_FIELDS) {
    const b = before[field];
    const a = after[field];
    if (!isDeepStrictEqual(b, a)) changes.push({ field, before: b, after: a });
  }
  return changes;
}

/** Minimal LCS-based unified line diff, hunked so a small edit in a large RACI
 *  stays a readable confirm surface (the whole point of the gate). Output: `  `
 *  context, `- ` removed, `+ ` added; runs of unchanged lines beyond `context`
 *  of any change collapse to a `  ⋮` elision marker. */
export function unifiedDiff(a: string, b: string, context = 3): string {
  const aLines = a === "" ? [] : a.split("\n");
  const bLines = b === "" ? [] : b.split("\n");
  const n = aLines.length;
  const m = bLines.length;

  // lcs[i][j] = LCS length of aLines[i..] and bLines[j..].
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    const row = lcs[i]!;
    const next = lcs[i + 1]!;
    for (let j = m - 1; j >= 0; j--) {
      row[j] = aLines[i] === bLines[j] ? next[j + 1]! + 1 : Math.max(next[j]!, row[j + 1]!);
    }
  }

  // 1. Full tagged line stream.
  type Tagged = { sign: " " | "-" | "+"; text: string };
  const tagged: Tagged[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (aLines[i] === bLines[j]) {
      tagged.push({ sign: " ", text: aLines[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      tagged.push({ sign: "-", text: aLines[i]! });
      i++;
    } else {
      tagged.push({ sign: "+", text: bLines[j]! });
      j++;
    }
  }
  while (i < n) tagged.push({ sign: "-", text: aLines[i++]! });
  while (j < m) tagged.push({ sign: "+", text: bLines[j++]! });

  // 2. Keep changed lines and any context-line within `context` of a change;
  //    collapse the rest.
  const keep = new Array<boolean>(tagged.length).fill(false);
  tagged.forEach((t, idx) => {
    if (t.sign === " ") return;
    for (let k = Math.max(0, idx - context); k <= Math.min(tagged.length - 1, idx + context); k++) keep[k] = true;
  });

  const out: string[] = [];
  let elided = false;
  tagged.forEach((t, idx) => {
    if (keep[idx]) {
      out.push(`${t.sign} ${t.text}`);
      elided = false;
    } else if (!elided) {
      out.push("  ⋮");
      elided = true;
    }
  });
  return out.join("\n");
}
