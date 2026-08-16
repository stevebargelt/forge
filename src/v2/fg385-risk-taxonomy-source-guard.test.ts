// FG-385: the risk-taxonomy source guard. The change-class/risk-signal → lens risk
// taxonomy must live in EXACTLY ONE module — src/v2/risk-reds-planner.ts. A second copy
// anywhere else (review-wiring.ts, review-contract.ts, review-shipping.ts,
// reviewer-context-packet.ts, or any other production source) is a two-renderings defect:
// one taxonomy recommends a review panel and the copy recommends another, and a shipping
// record can then be true of one and false of the other.
//
// The taxonomy's vocabulary is the `risk-signal:` namespace: every taxonomy key, and every
// reference to one, is a `risk-signal:` string literal. So a second lens-selection / risk-
// signal→lens mapping cannot exist without naming that vocabulary, and the vocabulary is
// what this guard scans for. Modeled on fg722-lifecycle-source-guard.test.ts — an
// OCCURRENCE-PRECISE multiset allowlist, whitespace/multiline-robust, with self-tests.
//
// THE DETECTOR requires a real string-literal quote — double or single — immediately before
// `risk-signal:`. That is the equivalent of fg722's `.parentId` member-access requirement:
// it is what keeps PROSE that merely quotes the vocabulary with backticks (this file's own
// comments, the planner's header) from tripping the gate. A reintroduced taxonomy is CODE,
// and its keys are `"risk-signal:…"` / `'risk-signal:…'` string literals — those are caught.
//
// THE ALLOWLIST is the inventory: the ten vocabulary constants in risk-reds-planner.ts, and
// nothing else. Occurrence-precise (RF-1/RF-2 in fg722's terms): the entry declares its
// exact count, so a stale entry (count → 0) fails, and a SECOND `risk-signal:` literal added
// to the planner (count → 11) fails too, forcing the maintainer to re-count deliberately.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// This file lives at src/v2/; the guard scans the whole src/ tree, so climb one level.
const SRC_ROOT = fileURLToPath(new URL("../", import.meta.url));

// A `risk-signal:` token written as a real string literal (double or single quoted). NOT a
// backtick — backticks are how the prose in this file and the planner header name the
// vocabulary without being code.
const RISK_SIGNAL_LITERAL = /["']risk-signal:/;

const DETECTORS: readonly RegExp[] = [RISK_SIGNAL_LITERAL];

interface AllowEntry {
  /** Label-relative file path (e.g. "src/v2/risk-reds-planner.ts"). Never a line number. */
  readonly file: string;
  /** The specific construction allowed in that file. */
  readonly pattern: RegExp;
  /** Why this occurrence is the SANCTIONED taxonomy, not a second copy. */
  readonly reason: string;
  /** The EXACT number of occurrences this entry accounts for (default 1). */
  readonly count?: number;
}

const ALLOWLIST: readonly AllowEntry[] = [
  {
    file: "src/v2/risk-reds-planner.ts",
    pattern: /["']risk-signal:/,
    count: 10,
    reason:
      "THE ONE taxonomy: the ten `risk-signal:` vocabulary constants (S_LIFECYCLE … S_DOCS_ONLY) that key the sole change-class→lens table. This is the single sanctioned location.",
  },
];

interface Hit {
  readonly file: string;
  readonly line: number;
  readonly text: string;
  readonly claimedBy: number[];
}

interface Span {
  readonly start: number;
  readonly end: number;
}

function normalize(body: string): { text: string; lineAt: number[] } {
  const out: string[] = [];
  const lineAt: number[] = [];
  let line = 1;
  let pendingWs = false;
  for (const ch of body) {
    if (ch === "\n") line += 1;
    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n" || ch === "\f" || ch === "\v") {
      pendingWs = true;
      continue;
    }
    if (pendingWs && out.length > 0) {
      out.push(" ");
      lineAt.push(line);
    }
    pendingWs = false;
    out.push(ch);
    lineAt.push(line);
  }
  return { text: out.join(""), lineAt };
}

function allMatches(text: string, pattern: RegExp): Span[] {
  const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  const spans: Span[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    spans.push({ start: m.index, end: m.index + m[0].length });
    if (m.index === re.lastIndex) re.lastIndex += 1;
  }
  return spans;
}

function gatherSourceFiles(dir: string, root: string = dir): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...gatherSourceFiles(full, root));
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !/\.(test|integration|worktree)\.ts$/.test(entry.name)) {
      // Test files are excluded: they legitimately build `risk-signal:` fixtures (the
      // fail-closed unrecognized-signal test), and this is also what keeps THIS file out
      // of its own scan.
      results.push(relative(root, full));
    }
  }
  return results;
}

function scan(dir: string): { files: string[]; hits: Hit[] } {
  const files = gatherSourceFiles(dir);
  const hits: Hit[] = [];
  for (const rel of files) {
    const label = `src/${rel}`;
    const { text, lineAt } = normalize(readFileSync(join(dir, rel), "utf8"));
    const entrySpans = ALLOWLIST.map((entry, idx) =>
      entry.file === label ? { idx, spans: allMatches(text, entry.pattern) } : { idx, spans: [] as Span[] },
    );
    for (const detector of DETECTORS) {
      for (const hit of allMatches(text, detector)) {
        const claimedBy = entrySpans
          .filter(({ spans }) => spans.some((s) => s.start <= hit.start && s.end >= hit.end))
          .map(({ idx }) => idx);
        hits.push({
          file: label,
          line: lineAt[hit.start] ?? 0,
          text: text.slice(Math.max(0, hit.start - 6), Math.min(text.length, hit.end + 40)).trim(),
          claimedBy,
        });
      }
    }
  }
  return { files, hits };
}

function assertGateHolds(dir: string): void {
  const { files, hits } = scan(dir);
  assert.ok(
    files.length > 0,
    `FG-385 risk-taxonomy source guard scanned no .ts files under ${dir} — the path or the layout changed and the gate is no longer guarding anything.`,
  );
  const unallowed = hits.filter((hit) => hit.claimedBy.length === 0).map((hit) => `${hit.file}:${hit.line}: ${hit.text}`);
  assert.deepEqual(
    unallowed,
    [],
    `FG-385: a risk-signal→lens taxonomy vocabulary reference appears outside the single sanctioned module (src/v2/risk-reds-planner.ts). ` +
      `The change-class→lens risk taxonomy must live in EXACTLY ONE place — do not restate it in review-wiring.ts / review-contract.ts / ` +
      `review-shipping.ts / reviewer-context-packet.ts or elsewhere. Import from the planner instead:\n${unallowed.join("\n")}`,
  );
  const overclaimed = hits
    .filter((hit) => hit.claimedBy.length > 1)
    .map((hit) => `${hit.file}:${hit.line}: ${hit.text}`);
  assert.deepEqual(overclaimed, [], `FG-385: an occurrence is claimed by more than one ALLOWLIST entry:\n${overclaimed.join("\n")}`);
  const countMismatch: string[] = [];
  ALLOWLIST.forEach((entry, idx) => {
    const actual = hits.filter((hit) => hit.claimedBy.length === 1 && hit.claimedBy[0] === idx).length;
    const expected = entry.count ?? 1;
    if (actual !== expected) countMismatch.push(`${entry.file} :: ${entry.pattern} — expected ${expected}, found ${actual}`);
  });
  assert.deepEqual(
    countMismatch,
    [],
    `FG-385 allowlist occurrence count mismatch — set-equality is broken. Either a NEW \`risk-signal:\` literal was added to the planner ` +
      `(found > expected: re-count deliberately) or an entry is now stale (found 0):\n${countMismatch.join("\n")}`,
  );
}

function withFixture(files: Record<string, string>, fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "fg385-src-guard-"));
  try {
    for (const [rel, body] of Object.entries(files)) {
      const full = join(dir, rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, body);
    }
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- the gate ---

test("FG-385: the risk taxonomy vocabulary lives in exactly one module", () => {
  assertGateHolds(SRC_ROOT);
});

test("FG-385: the sanctioned location actually carries the taxonomy (non-vacuous)", () => {
  const { hits } = scan(SRC_ROOT);
  const inPlanner = hits.filter((h) => h.file === "src/v2/risk-reds-planner.ts");
  assert.equal(inPlanner.length, 10, "risk-reds-planner.ts must carry exactly the ten vocabulary constants — the guard is pinned to the real taxonomy, not an empty allowlist");
});

// ------------------------------------------------- the gate guards itself ---

test("FG-385 guard: the vacuity precondition fails an empty scan", () => {
  const empty = mkdtempSync(join(tmpdir(), "fg385-src-guard-empty-"));
  try {
    assert.throws(() => assertGateHolds(empty), /scanned no \.ts files/, "an empty scan must fail the gate, not pass it");
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test("FG-385 guard: a reintroduced second taxonomy in another file fails the gate", () => {
  // The regression this guard exists to catch: a copy of the risk-signal→lens mapping in
  // (say) review-wiring.ts. It cannot exist without naming the vocabulary.
  withFixture(
    {
      "v2/review-wiring.ts": [
        "const SECOND_TAXONOMY: Record<string, string[]> = {",
        '  "risk-signal:lifecycle-reconciliation": ["backend", "narrow"],',
        '  "risk-signal:auth-credential-secret": ["security"],',
        "};",
      ].join("\n"),
    },
    (dir) => {
      assert.throws(
        () => assertGateHolds(dir),
        /taxonomy vocabulary reference appears outside/,
        "a second risk-signal→lens taxonomy must fail the gate",
      );
    },
  );
});

test("FG-385 guard (single-quote): a single-quoted reintroduced token fails the gate", () => {
  withFixture(
    { "v2/review-shipping.ts": "const k = 'risk-signal:done-gate-change';" },
    (dir) => {
      assert.throws(() => assertGateHolds(dir), /taxonomy vocabulary reference appears outside/, "single-quoted token must be caught");
    },
  );
});

test("FG-385 guard (multiline): a whitespace-split taxonomy literal fails the gate", () => {
  withFixture(
    {
      "v2/reviewer-context-packet.ts": [
        "const t = {",
        '  "risk-signal:db-durable-state":',
        '    ["backend"],',
        "};",
      ].join("\n"),
    },
    (dir) => {
      assert.throws(() => assertGateHolds(dir), /taxonomy vocabulary reference appears outside/, "a multiline reintroduction must fail the gate");
    },
  );
});

test("FG-385 guard: backtick PROSE naming the vocabulary does not trip the gate", () => {
  // The planner header and this file describe the `risk-signal:` vocabulary in prose using
  // backticks. That must be quiet — only real string literals (double/single quote) count.
  withFixture(
    {
      "v2/prose.ts": [
        "// The taxonomy keys are the `risk-signal:` vocabulary; do not restate them here.",
        "const note = 42;",
      ].join("\n"),
    },
    (dir) => {
      assert.deepEqual(scan(dir).hits, [], "dot-less backtick prose mentioning the vocabulary must not be flagged");
    },
  );
});

test("FG-385 guard: the allowlist is path-scoped — the same construction elsewhere still fails", () => {
  withFixture(
    { "v2/impostor.ts": 'const k = "risk-signal:lifecycle-reconciliation";' },
    (dir) => {
      assert.throws(() => assertGateHolds(dir), /taxonomy vocabulary reference appears outside/, "allowlist entries must be path-scoped, not global patterns");
    },
  );
});

test("FG-385 guard: a SECOND token added to the planner (over its declared count) fails the gate", () => {
  withFixture(
    {
      "v2/risk-reds-planner.ts": [
        'const S_LIFECYCLE = "risk-signal:lifecycle-reconciliation";',
        'const S_GIT_PUBLICATION = "risk-signal:git-worktree-publication";',
        'const S_AUTH_CREDENTIAL = "risk-signal:auth-credential-secret";',
        'const S_ROUTING_POLICY = "risk-signal:routing-policy-runtime";',
        'const S_DB_STATE = "risk-signal:db-durable-state";',
        'const S_TEST_INFRA = "risk-signal:test-validation-infra";',
        'const S_DONE_GATE = "risk-signal:done-gate-change";',
        'const S_DASHBOARD = "risk-signal:dashboard-decision-surface";',
        'const S_CROSS_MODULE = "risk-signal:cross-module-contract";',
        'const S_DOCS_ONLY = "risk-signal:docs-only";',
        'const SNEAKED = "risk-signal:eleventh-signal";',
      ].join("\n"),
    },
    (dir) => {
      assert.throws(
        () => assertGateHolds(dir),
        /occurrence count mismatch[\s\S]*expected 10, found 11/,
        "an eleventh token in the planner must fail until the count is re-declared deliberately",
      );
    },
  );
});

test("FG-385 guard: the guard does not scan itself", () => {
  const self = relative(SRC_ROOT, fileURLToPath(import.meta.url));
  const scanned = gatherSourceFiles(SRC_ROOT);
  assert.ok(!scanned.includes(self), `${self} must be excluded from its own scan`);
  // The exclusion is load-bearing: this file's fixtures really do contain the token.
  const own = readFileSync(fileURLToPath(import.meta.url), "utf8");
  assert.ok(RISK_SIGNAL_LITERAL.test(own), "this guard's fixtures should contain a matching construction, so self-exclusion is proven necessary");
});
