// FG-596 structural guard — close the unkeyed-run-emission class by invariant.
//
// Every run-PRODUCING call in the campaign drive path (`insertRun` / `startRun` —
// the calls that INSERT a new run row) must live INSIDE a reserveCampaignDriveDispatch
// createRun callback, so the run is stamped with the deterministic dispatch key + attempt
// generation and its insert + item linkage + lifecycle CAS commit atomically. A BARE
// insertRun/startRun in the drive path reopens the orphan-crash-window + duplicate-on-
// re-drive defect this ticket closed (the startRun-throw catch was the last such site).
//
// This guard scans src/campaign/executor.ts and FAILS if any insertRun/startRun call
// appears OUTSIDE a reserved region. It is a source content guard (like
// dashboard-offline-guard.test.ts): it matches CODE, not comments or strings — a comment
// that merely names insertRun is fine; an executable call is not.
//
// A reserved region is EITHER a reserveCampaignDriveDispatch(...) call expression, OR the body
// of prepareCampaignItemDispatch — the ONE lane-aware materialization authority (FG-564 FIX
// round 5). Its per-lane `createRun` closures are the sole run-shape emitters and are invoked
// ONLY inside reserveCampaignDriveDispatch (by BOTH the normal drive and the recover adapter),
// so their emissions stay keyed + atomic exactly as an inline createRun does. Any insertRun/
// startRun OUTSIDE both regions is still a bare emission and fails.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const EXECUTOR = fileURLToPath(new URL("./executor.ts", import.meta.url));

// Blank out comments and string/template literals, preserving byte offsets and newlines,
// so paren-matching and call detection see CODE only. Escaped chars inside strings are
// consumed so a `\"`/`` \` `` never ends the literal early.
function blankStringsAndComments(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  type State = "code" | "line" | "block" | "sq" | "dq" | "tpl";
  let state: State = "code";
  while (i < n) {
    const c = src[i]!;
    const c2 = i + 1 < n ? src[i + 1] : "";
    if (state === "code") {
      if (c === "/" && c2 === "/") { out += "  "; i += 2; state = "line"; continue; }
      if (c === "/" && c2 === "*") { out += "  "; i += 2; state = "block"; continue; }
      if (c === "'") { out += " "; i++; state = "sq"; continue; }
      if (c === '"') { out += " "; i++; state = "dq"; continue; }
      if (c === "`") { out += " "; i++; state = "tpl"; continue; }
      out += c; i++; continue;
    }
    if (state === "line") {
      out += c === "\n" ? "\n" : " ";
      if (c === "\n") state = "code";
      i++; continue;
    }
    if (state === "block") {
      if (c === "*" && c2 === "/") { out += "  "; i += 2; state = "code"; continue; }
      out += c === "\n" ? "\n" : " "; i++; continue;
    }
    // string literal: sq / dq / tpl
    const quote = state === "sq" ? "'" : state === "dq" ? '"' : "`";
    if (c === "\\") { out += "  "; i += 2; continue; }
    if (c === quote) { out += " "; i++; state = "code"; continue; }
    out += c === "\n" ? "\n" : " ";
    i++;
  }
  return out;
}

// Ranges [open, close] of every reserveCampaignDriveDispatch( ... ) call expression,
// matched on the code-only text so a call inside one is "reserved".
function reservationRanges(code: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const marker = "reserveCampaignDriveDispatch";
  let from = 0;
  for (;;) {
    const at = code.indexOf(marker, from);
    if (at < 0) break;
    from = at + marker.length;
    let j = from;
    while (j < code.length && code[j] !== "(") j++;
    if (j >= code.length) continue; // a bare identifier reference, not a call
    let depth = 0;
    let k = j;
    for (; k < code.length; k++) {
      if (code[k] === "(") depth++;
      else if (code[k] === ")") {
        depth--;
        if (depth === 0) break;
      }
    }
    ranges.push([at, k]);
  }
  return ranges;
}

// The [open, close] brace range of a named function's BODY, matched on code-only text. From
// the declaration, skip the parameter list `( ... )` (paren-matched), then brace-match the
// body `{ ... }`. Empty array if the function is not present.
function functionBodyRange(code: string, name: string): Array<[number, number]> {
  const marker = `function ${name}`;
  const at = code.indexOf(marker);
  if (at < 0) return [];
  // Skip the parameter list.
  let j = at + marker.length;
  while (j < code.length && code[j] !== "(") j++;
  let depth = 0;
  for (; j < code.length; j++) {
    if (code[j] === "(") depth++;
    else if (code[j] === ")") { depth--; if (depth === 0) { j++; break; } }
  }
  // Find the body's opening brace and brace-match it.
  while (j < code.length && code[j] !== "{") j++;
  const open = j;
  depth = 0;
  for (; j < code.length; j++) {
    if (code[j] === "{") depth++;
    else if (code[j] === "}") { depth--; if (depth === 0) break; }
  }
  return [[open, j]];
}

function lineAt(src: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < src.length; i++) if (src[i] === "\n") line++;
  return line;
}

test("FG-596 guard: every insertRun/startRun in the campaign drive path is inside a reserveCampaignDriveDispatch createRun callback", () => {
  const src = readFileSync(EXECUTOR, "utf8");
  const code = blankStringsAndComments(src);

  const ranges = [
    ...reservationRanges(code),
    ...functionBodyRange(code, "prepareCampaignItemDispatch"),
  ];
  assert.ok(ranges.length > 0, "found no reserveCampaignDriveDispatch call — executor.ts layout changed; re-scope this guard");

  // Run-CREATION calls only: insertRun(, startRun( / doStartRun( — NOT updateRunStatus (a
  // mutation of an existing run, not an emission). \b keeps startRun( distinct from
  // doStartRun( (no boundary between "do" and "startRun").
  const CALL = /\b(?:insertRun|startRun|doStartRun)\s*\(/g;
  const violations: string[] = [];
  let seen = 0;
  for (let m = CALL.exec(code); m !== null; m = CALL.exec(code)) {
    seen++;
    const at = m.index;
    const inside = ranges.some(([open, close]) => at >= open && at <= close);
    if (!inside) {
      violations.push(`  line ${lineAt(src, at)}: ${src.slice(at, src.indexOf("\n", at))}`.trimEnd());
    }
  }
  assert.ok(seen > 0, "found no insertRun/startRun call — executor.ts layout changed; re-scope this guard");

  assert.equal(
    violations.length,
    0,
    `BARE run emission in the campaign drive path — every insertRun/startRun MUST run inside a reserveCampaignDriveDispatch createRun callback (FG-596), so the run is keyed + atomic. Route these through the reservation:\n${violations.join("\n")}`,
  );
});
