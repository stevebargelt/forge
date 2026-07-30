// FG-640: the FG-541 evidence-mapping table, kept HONEST mechanically.
//
// The operator amendment of 2026-07-28 is specific: FG-541 may be marked superseded only once
// every row of this mapping cites a SHIPPED, ENFORCING mechanism — not merely because a ticket
// was filed. A prose table is exactly the artifact that rots quietly, so the citations are
// checked rather than trusted:
//
//   - every cited path exists;
//   - every cited `symbol()` is actually defined in the file the same cell cites;
//   - every cited gate condition is a real `DispositionGateConditionId`;
//   - all four FG-541 requirements are present, and none has an empty cell.
//
// A row whose citation is deleted or renamed reddens here, so "durable, with citations" stays a
// fact about the repository rather than a claim in a doc.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DISPOSITION_GATE_CONDITIONS } from "./review-gate.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CONCEPTS = resolve(repoRoot, "docs", "concepts.md");

const REQUIRED_ROWS = [
  "Local-only fixer commits",
  "No silent publication of unrelated work",
  "Exact-head CI",
  "Trusted-tip equality",
];

type Row = { requirement: string; cells: string[] };

function mappingRows(): Row[] {
  const doc = readFileSync(CONCEPTS, "utf8");
  const start = doc.indexOf("## FG-541 evidence mapping");
  assert.ok(start >= 0, "docs/concepts.md carries no FG-541 evidence mapping — this guard is inert");
  const rest = doc.slice(start);
  const end = rest.indexOf("\n## ", 1);
  const section = end >= 0 ? rest.slice(0, end) : rest;

  const rows: Row[] = [];
  for (const line of section.split("\n")) {
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.length < 5) continue;
    if (cells[0] === "FG-541 requirement" || cells.every((c) => /^-+$/.test(c))) continue;
    rows.push({ requirement: cells[0]!.replace(/\*\*/g, ""), cells });
  }
  return rows;
}

/** Every `path/like/this.ts` inside a cell. */
function citedPaths(cell: string): string[] {
  return [...cell.matchAll(/`(src\/[\w./-]+\.tsx?)`/g)].map((m) => m[1] as string);
}

/** Every `` `symbol` `` that reads like a function reference in a cell. */
function citedSymbols(cell: string): string[] {
  return [...cell.matchAll(/`(\w+)`/g)].map((m) => m[1] as string).filter((s) => /^[a-z][A-Za-z0-9]+$/.test(s));
}

const ROWS = mappingRows();

test("FG-640: the FG-541 mapping covers all four requirements, with no empty cell", () => {
  assert.deepEqual(
    ROWS.map((r) => r.requirement),
    REQUIRED_ROWS,
    "every FG-541 requirement must have exactly one row, in the ticket's order",
  );
  for (const row of ROWS) {
    for (const [i, cell] of row.cells.entries()) {
      assert.notEqual(cell, "", `${row.requirement}: column ${i} is empty — a blank cell is not a citation`);
      assert.doesNotMatch(
        cell,
        /^(tbd|todo|pending|n\/a|when shipped)$/i,
        `${row.requirement}: column ${i} is a placeholder (${cell}), not a shipped mechanism`,
      );
    }
  }
});

test("FG-640: every path the FG-541 mapping cites exists", () => {
  let cited = 0;
  for (const row of ROWS) {
    for (const cell of row.cells) {
      for (const path of citedPaths(cell)) {
        cited += 1;
        assert.ok(existsSync(resolve(repoRoot, path)), `${row.requirement} cites ${path}, which does not exist`);
      }
    }
  }
  assert.ok(cited >= REQUIRED_ROWS.length * 2, `only ${cited} path citations across ${ROWS.length} rows — a row citing nothing is not evidence`);
});

test("FG-640: every symbol the FG-541 mapping cites is defined in a file the same cell cites", () => {
  for (const row of ROWS) {
    for (const cell of row.cells) {
      const paths = citedPaths(cell);
      if (paths.length === 0) continue;
      const sources = paths.map((p) => readFileSync(resolve(repoRoot, p), "utf8"));
      for (const symbol of citedSymbols(cell)) {
        assert.ok(
          sources.some((src) =>
            new RegExp(`\\b(function|const|check) ${symbol}\\b`).test(src) ||
            new RegExp(`^\\s*${symbol}[:(]`, "m").test(src) ||
            src.includes(`"${symbol}"`),
          ),
          `${row.requirement} cites \`${symbol}\`, which is not defined in any of ${paths.join(", ")}`,
        );
      }
    }
  }
});

test("FG-640: every gate condition the FG-541 mapping cites is a real condition id", () => {
  const known = new Set<string>(DISPOSITION_GATE_CONDITIONS);
  for (const row of ROWS) {
    // The cell's FORMAT is part of the guard: it opens with the condition id, then prose.
    // A row that buries its condition mid-sentence is one a reader cannot skim, and one this
    // check could only validate by guessing which backticked word was meant.
    const gateCell = row.cells[row.cells.length - 1] as string;
    const id = /^`(\w+)`/.exec(gateCell)?.[1];
    assert.ok(id !== undefined, `${row.requirement}: the gate column must OPEN with \`<condition_id>\`; got: ${gateCell}`);
    assert.ok(known.has(id), `${row.requirement} cites gate condition '${id}', which the gate does not define`);
  }
});

// ── the Test column: the cited TEST still exists, not just the file it lived in ──
//
// The path check above proves `src/v2/review-run.test.ts` is a real file. It says nothing about
// the test named in the same breath, and a quoted title is exactly the kind of citation that
// survives its own subject: rename or delete the test and the row still reads like evidence.
// "Every row cites a shipped, ENFORCING mechanism" is the operator amendment's bar for marking
// FG-541 superseded, and a citation pointing at a test that no longer runs does not clear it.

/** Every `("…")` quoted fragment in a cell — how the mapping abbreviates a test title. */
function citedTestTitles(cell: string): string[] {
  return [...cell.matchAll(/\("([^"]+)"\)/g)]
    .map((m) => (m[1] as string).replace(/(?:…|\.\.\.)\s*$/, "").trim())
    .filter((t) => t !== "");
}

/** Every `test("…")` / `test(`…`)` title declared in a file. */
function declaredTestTitles(source: string): string[] {
  return [...source.matchAll(/^\s*test\(\s*(?:`([^`]*)`|"((?:[^"\\]|\\.)*)")/gm)].map((m) =>
    (m[1] ?? m[2] ?? "").replace(/\\"/g, '"'),
  );
}

test("FG-640: every test the FG-541 mapping quotes still exists in a file the same cell cites", () => {
  let cited = 0;
  for (const row of ROWS) {
    // Column 3 is the Test column; the header is asserted above, so the index is pinned.
    const cell = row.cells[3] as string;
    const titles = citedTestTitles(cell);
    if (titles.length === 0) continue;
    const paths = citedPaths(cell);
    assert.ok(paths.length > 0, `${row.requirement} quotes a test title but cites no test file to find it in`);
    const declared = paths.flatMap((p) => declaredTestTitles(readFileSync(resolve(repoRoot, p), "utf8")));
    for (const title of titles) {
      cited += 1;
      assert.ok(
        declared.some((d) => d.includes(title)),
        `${row.requirement} cites the test "${title}", which no longer exists in ${paths.join(", ")} — ` +
          `a citation that outlived its test is not durable evidence`,
      );
    }
  }
  assert.ok(cited >= 3, `only ${cited} test titles quoted across ${ROWS.length} rows — the guard has nothing to hold`);
});
