// FG-516 (finding B) — STRUCTURAL GUARD, now enforced BY CONSTRUCTION. The repeated
// two-step park pattern (tryTransitionCampaign(running→paused) … notifyCampaignPause)
// hand-wired at ~19 sites is why every review round found another variant that notified
// without a committed pause. Earlier guards tried to SCAN executor.ts for every call
// shape of the raw CAS — and lost the arms race twice: first to a namespace import
// (`import * as campaigns; campaigns.tryTransitionCampaign(…)`), then to computed access
// (`campaigns["tryTransitionCampaign"](…)`). Any token/regex scan of call shapes can be
// evaded by a new spelling.
//
// The fix ends the arms race: the running→paused CAS now lives ONLY in ./park.js
// (parkCampaign). executor.ts imports the boundary (parkCampaign) plus two non-park
// lifecycle wrappers (completeCampaign, resumeCampaignToRunning) and NEVER imports the
// raw tryTransitionCampaign symbol. With no binding for the CAS in module scope, NO call
// shape — bare, aliased, namespace-member, or computed — can reach it from executor.ts.
// This test now asserts that CONSTRUCTION at the import level, which is trivial and
// evasion-proof:
//   (a) the exact identifier token `tryTransitionCampaign` does not appear in executor
//       code at all (word-boundary, so `tryTransitionCampaignToRunning` — a DIFFERENT
//       store symbol executor legitimately keeps — does NOT trip it);
//   (b) executor.ts has no namespace (`* as`) import, dynamic `import(…)`, or `require(…)`
//       of the campaigns store module — the only ways to reach the CAS behind a computed
//       or member access without naming it. Computed access `campaigns["tryTransition…"]`
//       is impossible without one of these bindings, so banning them bans it too;
//   (c) `notifyCampaignPause` is neither imported nor defined in executor.ts — it is
//       private to park.ts, so executor cannot notify except THROUGH parkCampaign.
// park.ts itself is guarded lightly: it must contain exactly ONE running→paused CAS call
// site (the boundary). park.ts is small and owned, so a simple ordered-token scan is fine
// HERE. Negative self-tests below prove (a)/(b) flag every historical bypass and do NOT
// flag the legitimate `tryTransitionCampaignToRunning`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const EXECUTOR_SRC = fileURLToPath(new URL("./executor.ts", import.meta.url));
const PARK_SRC = fileURLToPath(new URL("./park.ts", import.meta.url));

// Two position-preserving projections of a source (same length & newlines, so byte
// offsets and line numbers are shared):
//   codeOnly   — comments AND string/template contents blanked (identifier scans:
//                nothing in a string or comment can false-flag)
//   noComments — comments blanked, strings KEPT (so import module specifiers and a
//                CAS call's "running"/"paused" argument literals are still readable)
type Projection = { codeOnly: string; noComments: string };

// A stack-based tokenizer, robust to nested template literals (` … ${ … ` … ` … } … `)
// and escapes. A regex-only stripper mishandles those and can silently corrupt the
// projections.
function project(src: string): Projection {
  const n = src.length;
  const code: string[] = new Array(n);
  const noC: string[] = new Array(n);
  const blank = (ch: string): string => (ch === "\n" ? "\n" : " ");
  const asCode = (i: number): void => {
    code[i] = src[i]!;
    noC[i] = src[i]!;
  };
  const asString = (i: number): void => {
    code[i] = blank(src[i]!);
    noC[i] = src[i]!;
  };
  const asComment = (i: number): void => {
    code[i] = blank(src[i]!);
    noC[i] = blank(src[i]!);
  };

  type Frame = { type: "code" | "tmpl"; expr: boolean; depth: number };
  const stack: Frame[] = [{ type: "code", expr: false, depth: 0 }];
  let i = 0;
  while (i < n) {
    const top = stack[stack.length - 1]!;
    const c = src[i]!;
    const c2 = i + 1 < n ? src[i + 1]! : "";
    if (top.type === "tmpl") {
      if (c === "\\") {
        asString(i);
        if (i + 1 < n) asString(i + 1);
        i += 2;
        continue;
      }
      if (c === "`") {
        asString(i);
        stack.pop();
        i++;
        continue;
      }
      if (c === "$" && c2 === "{") {
        asString(i);
        asString(i + 1);
        stack.push({ type: "code", expr: true, depth: 0 });
        i += 2;
        continue;
      }
      asString(i);
      i++;
      continue;
    }
    // top.type === 'code'
    if (c === "/" && c2 === "/") {
      while (i < n && src[i] !== "\n") {
        asComment(i);
        i++;
      }
      continue;
    }
    if (c === "/" && c2 === "*") {
      asComment(i);
      asComment(i + 1);
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        asComment(i);
        i++;
      }
      if (i < n) {
        asComment(i);
        asComment(i + 1);
        i += 2;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      asString(i);
      i++;
      while (i < n && src[i] !== c) {
        if (src[i] === "\\") {
          asString(i);
          if (i + 1 < n) asString(i + 1);
          i += 2;
          continue;
        }
        asString(i);
        i++;
      }
      if (i < n) {
        asString(i);
        i++;
      }
      continue;
    }
    if (c === "`") {
      asString(i);
      stack.push({ type: "tmpl", expr: false, depth: 0 });
      i++;
      continue;
    }
    if (top.expr && c === "{") {
      top.depth++;
      asCode(i);
      i++;
      continue;
    }
    if (top.expr && c === "}") {
      if (top.depth === 0) {
        asString(i); // the closing `}` of a ${…} — template syntax
        stack.pop();
        i++;
        continue;
      }
      top.depth--;
      asCode(i);
      i++;
      continue;
    }
    asCode(i);
    i++;
  }
  return { codeOnly: code.join(""), noComments: noC.join("") };
}

// Index of the matching close for the open bracket at `open`, balanced over `s`.
function matchBracket(s: string, open: number, openCh: string, closeCh: string): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === openCh) depth++;
    else if (s[i] === closeCh) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function lineOf(src: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < src.length; i++) if (src[i] === "\n") line++;
  return line;
}

// (a) Every occurrence of the EXACT identifier `tryTransitionCampaign` in executor CODE
// (comments/strings blanked). The trailing `\b` sits between "Campaign" and the next
// char: in `tryTransitionCampaignToRunning` that char is a word char, so no boundary and
// no match — the legitimate resume/start symbol is not flagged. A computed-access spelling
// `campaigns["tryTransitionCampaign"]` hides the token inside a STRING (blanked in
// codeOnly), so it is invisible here — but it is impossible without the namespace binding
// that check (b) bans, so it cannot exist regardless.
function rawCasTokenOffenders(codeOnly: string, src: string): string[] {
  const offenders: string[] = [];
  const re = /\btryTransitionCampaign\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(codeOnly)) !== null) {
    offenders.push(`${lineOf(src, m.index)}: raw CAS symbol 'tryTransitionCampaign' referenced in code`);
  }
  return offenders;
}

// (b) Any namespace (`import * as`), dynamic `import(…)`, or `require(…)` of the campaigns
// store module. These are the ONLY ways to reach a store export without naming it — i.e.
// the only substrate for a computed or member-aliased CAS call. Matches on noComments so
// the module specifier string is readable; scopes to a path mentioning `campaigns`.
function campaignsIndirectionOffenders(noComments: string, src: string): string[] {
  const offenders: string[] = [];
  const push = (idx: number, why: string): void => {
    offenders.push(`${lineOf(src, idx)}: ${why}`);
  };
  const ns = /import\s+\*\s+as\s+[A-Za-z_$][\w$]*\s+from\s+["'][^"']*campaigns[^"']*["']/g;
  const dyn = /\bimport\s*\(\s*["'][^"']*campaigns[^"']*["']/g;
  const req = /\brequire\s*\(\s*["'][^"']*campaigns[^"']*["']/g;
  let m: RegExpExecArray | null;
  while ((m = ns.exec(noComments)) !== null) push(m.index, "namespace `import * as` of the campaigns store module");
  while ((m = dyn.exec(noComments)) !== null) push(m.index, "dynamic import() of the campaigns store module");
  while ((m = req.exec(noComments)) !== null) push(m.index, "require() of the campaigns store module");
  return offenders;
}

// (c) `notifyCampaignPause` must be neither imported nor defined in executor CODE — it is
// private to park.ts. Any code-level occurrence (import, declaration, or call) is a
// violation; comment mentions are blanked in codeOnly and allowed.
function notifyPresenceOffenders(codeOnly: string, src: string): string[] {
  const offenders: string[] = [];
  const re = /\bnotifyCampaignPause\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(codeOnly)) !== null) {
    offenders.push(`${lineOf(src, m.index)}: 'notifyCampaignPause' present in executor code (must be private to park.ts)`);
  }
  return offenders;
}

// All executor-side construction violations combined — used by the real-source tests and
// the negative self-tests alike, so the fixtures exercise the exact production checks.
function executorOffenders(src: string): string[] {
  const { codeOnly, noComments } = project(src);
  return [
    ...rawCasTokenOffenders(codeOnly, src),
    ...campaignsIndirectionOffenders(noComments, src),
    ...notifyPresenceOffenders(codeOnly, src),
  ];
}

// park.ts guard: count running→paused CAS call sites (arg list has "running" THEN
// "paused"). Balanced-paren extraction so a multiline call still reads as one site.
function parkRunningPausedCasCount(src: string): number {
  const { codeOnly, noComments } = project(src);
  let count = 0;
  const re = /\btryTransitionCampaign\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(codeOnly)) !== null) {
    const parenOpen = m.index + m[0].length - 1;
    const parenClose = matchBracket(codeOnly, parenOpen, "(", ")");
    if (parenClose < 0) continue;
    const args = noComments.slice(parenOpen + 1, parenClose);
    if (/"running"[\s\S]*?"paused"/.test(args) || /'running'[\s\S]*?'paused'/.test(args)) count++;
  }
  return count;
}

test("FG-516: executor.ts holds no reference path to the raw running→paused CAS", () => {
  const src = readFileSync(EXECUTOR_SRC, "utf8");
  const offenders = executorOffenders(src);
  assert.deepEqual(
    offenders,
    [],
    `executor.ts must reach the park CAS ONLY through parkCampaign (import park.js). Violations:\n${offenders.join("\n")}`,
  );
});

test("FG-516: park.ts owns exactly one running→paused CAS call site (the boundary)", () => {
  const src = readFileSync(PARK_SRC, "utf8");
  assert.equal(
    parkRunningPausedCasCount(src),
    1,
    "park.ts must contain exactly one running→paused tryTransitionCampaign call — the parkCampaign boundary itself",
  );
});

// Negative self-test: the construction checks must FLAG every historical bypass — a bare
// call, an aliased import, a direct namespace member call, and (the reason scanning lost
// the arms race) a computed member access — and must NOT flag the legitimate
// `tryTransitionCampaignToRunning`, which is a different store symbol executor keeps.
// Fixture strings only; no real code changes.
test("FG-516 (guard self-test): construction checks catch bare / aliased / namespace / computed bypasses", () => {
  const bare = 'const ok = tryTransitionCampaign(cid, "running", "paused");';
  assert.ok(executorOffenders(bare).length > 0, "a bare CAS call must be flagged (token present)");

  const aliasedImport = [
    'import { tryTransitionCampaign as ttc } from "../store/campaigns.js";',
    'const ok = ttc(cid, "running", "paused");',
  ].join("\n");
  // The import statement itself NAMES the token, so (a) flags it even though the call uses ttc.
  assert.ok(executorOffenders(aliasedImport).length > 0, "an aliased import of the CAS must be flagged");

  const namespaceCall = [
    'import * as campaigns from "../store/campaigns.js";',
    'const ok = campaigns.tryTransitionCampaign(cid, "running", "paused");',
  ].join("\n");
  const nsOff = executorOffenders(namespaceCall);
  assert.ok(nsOff.length > 0, "a namespace member call must be flagged");
  assert.ok(
    nsOff.some((o) => /namespace `import \* as`/.test(o)),
    "the namespace import itself must be flagged by check (b)",
  );

  // The bypass that beat the previous scanner: the identifier hides inside a string, so a
  // token scan (a) never sees it. But computed access is impossible without the namespace
  // binding, which (b) bans — so the construction guard still catches it.
  const computed = [
    'import * as campaigns from "../store/campaigns.js";',
    'const ok = campaigns["tryTransitionCampaign"](cid, "running", "paused");',
  ].join("\n");
  const compOff = executorOffenders(computed);
  assert.ok(compOff.length > 0, "computed access must be flagged (via its required namespace import)");
  assert.ok(
    compOff.some((o) => /namespace `import \* as`/.test(o)),
    "computed access is caught by banning the namespace import it depends on",
  );

  // Dynamic import() / require() indirection is likewise banned.
  const dynamic = 'const m = await import("../store/campaigns.js"); m.tryTransitionCampaign(cid, "running", "paused");';
  assert.ok(
    executorOffenders(dynamic).some((o) => /dynamic import\(\)/.test(o)),
    "a dynamic import() of the campaigns store must be flagged",
  );

  // The legitimate resume/start symbol and the park wrappers must NOT be flagged.
  const clean = [
    'import { tryTransitionCampaignToRunning } from "../store/campaigns.js";',
    'import { parkCampaign, completeCampaign, resumeCampaignToRunning } from "./park.js";',
    "if (!tryTransitionCampaignToRunning(id)) return;",
    'await parkCampaign(cid, itemId, "blocked");',
    "if (completeCampaign(cid)) return;",
    "if (!resumeCampaignToRunning(id)) return;",
  ].join("\n");
  assert.deepEqual(
    executorOffenders(clean),
    [],
    "tryTransitionCampaignToRunning and the park.js wrappers must NOT be flagged",
  );

  // And a mention of the CAS in a COMMENT must not false-flag (comments are blanked).
  const commented = "// executor never imports tryTransitionCampaign; it calls parkCampaign\nconst x = 1;";
  assert.deepEqual(executorOffenders(commented), [], "a comment mention of the CAS must not be flagged");
});

// Self-test for the park.ts counter: it counts running→paused sites, ignores the reverse
// paused→running resume and the running→complete transition, and handles multiline calls.
test("FG-516 (guard self-test): the park.ts CAS counter counts only running→paused sites", () => {
  const oneBoundary = [
    "async function parkCampaign(cid, itemId, kind) {",
    '  const committed = tryTransitionCampaign(cid, "running", "paused");',
    "  return committed;",
    "}",
    'export function completeCampaign(cid) { return tryTransitionCampaign(cid, "running", "complete"); }',
    'export function resumeCampaignToRunning(cid) { return tryTransitionCampaign(cid, "paused", "running"); }',
  ].join("\n");
  assert.equal(parkRunningPausedCasCount(oneBoundary), 1, "exactly the running→paused site is counted");

  const multiline = [
    "tryTransitionCampaign(",
    "  cid,",
    '  "running",',
    '  "paused",',
    ");",
  ].join("\n");
  assert.equal(parkRunningPausedCasCount(multiline), 1, "a multiline running→paused call counts as one site");

  const twoParks = oneBoundary + '\ntryTransitionCampaign(other, "running", "paused");';
  assert.equal(parkRunningPausedCasCount(twoParks), 2, "a second running→paused site is counted (would fail the guard)");
});
