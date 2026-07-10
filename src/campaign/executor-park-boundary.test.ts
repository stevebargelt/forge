// FG-516 (finding B) — STRUCTURAL GUARD. The repeated two-step park pattern
// (tryTransitionCampaign(running→paused) … notifyCampaignPause(...)) hand-wired at
// ~19 sites is why every review round found another variant that notified without a
// committed pause. The fix replaces the pattern with ONE boundary — parkCampaign —
// that performs the CAS itself and notifies only when it committed. This test makes
// the variant class UNREPRESENTABLE: it scans the executor source and asserts that
//   (a) notifyCampaignPause is CALLED only inside the parkCampaign boundary, and
//   (b) any tryTransitionCampaign(… "running" … "paused" …) park CAS is called only
//       inside that boundary.
// A new hand-wired park site fails CI here before it can ship. Same spirit as the
// test-tier subprocess/purity content guard (src/test-tiers.test.ts).
//
// ROBUSTNESS (FG-516 review rounds 2–3): the earlier guard matched a single-line literal
// `tryTransitionCampaign(campaignId, "running", "paused")` and so was trivially evaded
// by (i) `campaign.id` instead of the `campaignId` local, (ii) splitting the call over
// multiple lines, or (iii) an aliased import of the CAS. Round 3 closed a further hole:
// a re-binding of the CAS through a namespace import (`import * as campaigns` →
// `const ttc = campaigns.tryTransitionCampaign`), a bare value alias (`const ttc =
// tryTransitionCampaign`), or a destructuring rename (`const { tryTransitionCampaign:
// ttc } = campaigns`) hid the call behind a fresh identifier the base scan never saw.
// (A DIRECT namespace member call `campaigns.tryTransitionCampaign(…)` was already
// caught — the `\b` sits at the dot — but the alias BINDINGS were not.) This version is
// token-based: it strips comments/strings so a mention in prose can't false-flag,
// extracts the parkCampaign span by BALANCED BRACES (not a call-shape regex), matches
// the CAS call across lines and independent of the first argument's spelling, follows
// import aliases / namespace-member aliases / destructuring renames of the CAS symbol,
// and only cares that the running→paused string pair appears inside the call's balanced
// parens. The paused→running RESUME transition (a different, legitimate operation
// living outside parkCampaign) is deliberately NOT matched — order matters. Negative
// self-tests prove the matcher DOES catch every bypass above.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const EXECUTOR_SRC = fileURLToPath(new URL("./executor.ts", import.meta.url));

// Two position-preserving projections of a source (same length & newlines, so byte
// offsets and line numbers are shared):
//   codeOnly   — comments AND string/template contents blanked (identifier scans,
//                paren/brace balancing — nothing in a string or comment can interfere)
//   noComments — comments blanked, strings KEPT (so a CAS call's "running"/"paused"
//                argument literals are still readable)
type Projection = { codeOnly: string; noComments: string };

// A stack-based tokenizer, robust to nested template literals (` … ${ … ` … ` … } … `)
// and escapes — executor.ts uses both. A regex-only stripper mishandles those and can
// silently corrupt the projections.
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

  // Frame stack. 'code' = ordinary code / a template-expr ${…} body; 'tmpl' = inside
  // backticks. Template-expr bodies push a 'code' frame with a brace counter so the
  // matching `}` pops back to the template.
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

// The [start, end] byte span of the `async function parkCampaign(` definition, found
// by balancing the parameter parens then the body braces — never by a call-shape
// regex. Balances on codeOnly so a `{`/`}`/`(`/`)` inside a string or comment (or the
// `opts?: { … }` parameter TYPE, which is real code and correctly balanced) can't
// mislead it.
function parkCampaignSpan(codeOnly: string): { start: number; end: number } {
  const decl = /async\s+function\s+parkCampaign\s*\(/.exec(codeOnly);
  assert.ok(decl, "parkCampaign boundary function must exist");
  const start = decl.index;
  const parenOpen = decl.index + decl[0].length - 1;
  const parenClose = matchBracket(codeOnly, parenOpen, "(", ")");
  assert.ok(parenClose > parenOpen, "parkCampaign parameter list must balance");
  const bodyOpen = codeOnly.indexOf("{", parenClose + 1);
  assert.ok(bodyOpen > parenClose, "parkCampaign body opening brace must be found");
  const bodyClose = matchBracket(codeOnly, bodyOpen, "{", "}");
  assert.ok(bodyClose > bodyOpen, "parkCampaign body must balance");
  return { start, end: bodyClose };
}

function lineOf(src: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < src.length; i++) if (src[i] === "\n") line++;
  return line;
}

function snippet(src: string, from: number, to: number): string {
  return src.slice(from, to).replace(/\s+/g, " ").trim();
}

// Every local identifier that resolves to `name`, INCLUDING `name` itself. The
// base-name scan already catches a direct member call `NS.name(…)` (the `\b` sits at
// the dot), but a re-binding hides the call behind a fresh identifier the base scan
// never sees. We enumerate those bindings:
//   import { name as X }         → X   (import alias)
//   const/let/var X = name       → X   (bare value alias)
//   const/let/var X = NS.name    → X   (namespace-member value alias)
//   const { name: X } = NS       → X   (destructuring rename)
// The value-alias forms use a `(?!\s*\()` lookahead so a real CALL (`const c =
// name(…)`, whose result is a value, not the function) is NOT mistaken for an alias.
// Scans codeOnly so a mention inside a string/comment can't invent an alias.
function resolvedNames(codeOnly: string, name: string): string[] {
  const names = new Set<string>([name]);
  const id = "[A-Za-z_$][\\w$]*";
  const collect = (re: RegExp): void => {
    let m: RegExpExecArray | null;
    while ((m = re.exec(codeOnly)) !== null) names.add(m[1]!);
  };
  collect(new RegExp(name + "\\s+as\\s+(" + id + ")", "g"));
  collect(new RegExp("(?:const|let|var)\\s+(" + id + ")\\s*=\\s*(?:" + id + "\\s*\\.\\s*)?" + name + "\\b(?!\\s*\\()", "g"));
  collect(new RegExp("\\{[^{}]*\\b" + name + "\\s*:\\s*(" + id + ")", "g"));
  return [...names];
}

// CALL sites of `notifyCampaignPause` that fall OUTSIDE the parkCampaign span. The
// function DECLARATION (`function notifyCampaignPause`) is excluded — it legitimately
// lives at module scope; only CALLS are constrained to the boundary.
function notifyCallOffenders(src: string): string[] {
  const { codeOnly, noComments } = project(src);
  const span = parkCampaignSpan(codeOnly);
  const offenders: string[] = [];
  const re = /\bnotifyCampaignPause\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(codeOnly)) !== null) {
    const before = codeOnly.slice(Math.max(0, m.index - 24), m.index);
    if (/\bfunction\s+$/.test(before)) continue; // the declaration, not a call
    if (m.index < span.start || m.index > span.end) {
      offenders.push(`executor.ts:${lineOf(src, m.index)}: ${snippet(noComments, m.index, m.index + 60)}`);
    }
  }
  return offenders;
}

// tryTransitionCampaign park CAS calls — arg list contains "running" THEN "paused"
// (the running→paused park; the reverse paused→running resume is intentionally not a
// park and legitimately lives outside the boundary) — that fall OUTSIDE the span.
// Matches across lines, ignores the first argument's spelling, and follows import
// aliases, namespace-member value aliases, and destructuring renames of the CAS symbol.
function parkCasOffenders(src: string): string[] {
  const { codeOnly, noComments } = project(src);
  const span = parkCampaignSpan(codeOnly);
  const names = resolvedNames(codeOnly, "tryTransitionCampaign");
  const offenders: string[] = [];
  for (const name of names) {
    const re = new RegExp("\\b" + name + "\\s*\\(", "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(codeOnly)) !== null) {
      const parenOpen = m.index + m[0].length - 1;
      const parenClose = matchBracket(codeOnly, parenOpen, "(", ")");
      if (parenClose < 0) continue;
      const args = noComments.slice(parenOpen + 1, parenClose);
      if (!/"running"[\s\S]*?"paused"/.test(args) && !/'running'[\s\S]*?'paused'/.test(args)) continue;
      if (m.index < span.start || m.index > span.end) {
        offenders.push(`executor.ts:${lineOf(src, m.index)}: ${snippet(noComments, m.index, parenClose + 1)}`);
      }
    }
  }
  return offenders;
}

test("FG-516: notifyCampaignPause is CALLED only inside the parkCampaign boundary", () => {
  const src = readFileSync(EXECUTOR_SRC, "utf8");
  const offenders = notifyCallOffenders(src);
  assert.deepEqual(
    offenders,
    [],
    `notifyCampaignPause may only be called from parkCampaign. Direct call sites:\n${offenders.join("\n")}`,
  );
});

test("FG-516: the running→paused park CAS is called ONLY inside the parkCampaign boundary", () => {
  const src = readFileSync(EXECUTOR_SRC, "utf8");
  const offenders = parkCasOffenders(src);
  assert.deepEqual(
    offenders,
    [],
    `Every running→paused park transition must go through parkCampaign. Hand-wired sites:\n${offenders.join("\n")}`,
  );
});

// Negative self-test: the matcher must FLAG every bypass reviewers listed — campaign.id,
// a multiline call, an aliased import, a direct namespace member call, a namespace-member
// value alias, a bare value alias, and a destructuring rename — and must NOT flag the
// legitimate in-boundary calls or the paused→running resume. Fixture strings only; no
// real code changes.
test("FG-516 (guard self-test): the matcher catches campaign.id / multiline / aliased-import park bypasses", () => {
  const fixture = [
    'import { tryTransitionCampaign as ttc, tryTransitionCampaign } from "../store/campaigns.js";',
    'import * as campaigns from "../store/campaigns.js";',
    "",
    "async function parkCampaign(campaignId, itemId, kind, opts) {",
    // In-boundary calls — MUST NOT be flagged.
    '  const committed = tryTransitionCampaign(campaignId, "running", "paused");',
    "  if (committed) {",
    '    await notifyCampaignPause(campaignId, itemId, kind);',
    "  }",
    "  return committed;",
    "}",
    "",
    "async function sneakyDotId(campaign, itemId) {",
    "  // bypass 1: campaign.id instead of the campaignId local",
    '  const ok = tryTransitionCampaign(campaign.id, "running", "paused");',
    '  if (ok) await notifyCampaignPause(campaign.id, itemId, "blocked");',
    "}",
    "",
    "async function sneakyMultiline(cid) {",
    "  // bypass 2: the CAS split across several lines",
    "  tryTransitionCampaign(",
    "    cid,",
    '    "running",',
    '    "paused",',
    "  );",
    "}",
    "",
    "async function sneakyAliased(anyId) {",
    "  // bypass 3: the CAS reached through an aliased import",
    '  return ttc(anyId, "running", "paused");',
    "}",
    "",
    "async function sneakyNamespaceCall(nsId) {",
    "  // bypass 4: a direct namespace member call",
    '  return campaigns.tryTransitionCampaign(nsId, "running", "paused");',
    "}",
    "",
    "async function sneakyNamespaceAlias(naId) {",
    "  // bypass 5: a value alias bound off the namespace member",
    "  const nsAlias = campaigns.tryTransitionCampaign;",
    '  return nsAlias(naId, "running", "paused");',
    "}",
    "",
    "async function sneakyBareAlias(baId) {",
    "  // bypass 6: a bare value alias of the imported symbol",
    "  const bareAlias = tryTransitionCampaign;",
    '  return bareAlias(baId, "running", "paused");',
    "}",
    "",
    "async function sneakyDestructured(deId) {",
    "  // bypass 7: a destructuring rename off the namespace",
    "  const { tryTransitionCampaign: renamed } = campaigns;",
    '  return renamed(deId, "running", "paused");',
    "}",
    "",
    "function resumeSomewhere(id) {",
    "  // legitimate paused→running resume — the REVERSE direction — must NOT be flagged",
    '  return tryTransitionCampaign(id, "paused", "running");',
    "}",
  ].join("\n");

  const cas = parkCasOffenders(fixture);
  // Seven park bypasses flagged; the in-boundary CAS and the paused→running resume are not.
  assert.equal(cas.length, 7, `expected exactly the 7 park bypasses, got:\n${cas.join("\n")}`);
  assert.ok(
    cas.some((o) => /campaign\.id/.test(o)),
    "the campaign.id bypass must be flagged",
  );
  assert.ok(
    cas.some((o) => /tryTransitionCampaign\( cid/.test(o)),
    "the multiline bypass must be flagged",
  );
  assert.ok(
    cas.some((o) => /ttc\(anyId/.test(o)),
    "the aliased-import bypass must be flagged",
  );
  assert.ok(
    cas.some((o) => /tryTransitionCampaign\(nsId/.test(o)),
    "the direct namespace member call must be flagged",
  );
  assert.ok(
    cas.some((o) => /nsAlias\(naId/.test(o)),
    "the namespace-member value alias must be flagged",
  );
  assert.ok(
    cas.some((o) => /bareAlias\(baId/.test(o)),
    "the bare value alias must be flagged",
  );
  assert.ok(
    cas.some((o) => /renamed\(deId/.test(o)),
    "the destructuring rename must be flagged",
  );
  assert.ok(
    !cas.some((o) => /"paused", "running"/.test(o)),
    "the paused→running resume must NOT be flagged",
  );

  const notify = notifyCallOffenders(fixture);
  assert.equal(notify.length, 1, `expected the single out-of-boundary notify call, got:\n${notify.join("\n")}`);
  assert.ok(/campaign\.id/.test(notify[0]!), "the out-of-boundary notifyCampaignPause call must be flagged");
});

// Sanity: a source whose ONLY park calls are inside the boundary yields no offenders —
// proves the matcher does not false-positive on the legitimate shape.
test("FG-516 (guard self-test): the matcher passes a clean in-boundary-only source", () => {
  const clean = [
    "async function parkCampaign(campaignId, itemId, kind, opts) {",
    '  const committed = tryTransitionCampaign(campaignId, "running", "paused");',
    '  if (committed) await notifyCampaignPause(campaignId, itemId, kind);',
    "  return committed;",
    "}",
    "function resume(id) {",
    '  return tryTransitionCampaign(id, "paused", "running");',
    "}",
  ].join("\n");
  assert.deepEqual(parkCasOffenders(clean), []);
  assert.deepEqual(notifyCallOffenders(clean), []);
});
