// FG-799 (AC1): the per-project ai_attribution reader/writer.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  readAiAttribution,
  writeAiAttribution,
  formatAiAttribution,
} from "./ai-attribution.js";
import { parseAiAttributionConfig, scalarValue, stripComment } from "./ai-attribution-parse.js";

// FG-799 (RF-1): import the shipped hook reader's parse helpers to compare them, value
// by value, against the TS copy. The specifier is a runtime-built URL (not a static
// string) so tsc types it `any` rather than demanding a .d.ts for the plain `.mjs`;
// the reader's CLI block is guarded by an import.meta.url check, so importing it here
// has no side effect.
type ParseHelpers = {
  parseAiAttributionConfig(text: string | null): { mode: "allow" | "suppress"; recognized: boolean };
  scalarValue(rest: string): string;
  stripComment(s: string): string;
};
const readerUrl = new URL("../../scripts/git-hooks/read-ai-attribution.mjs", import.meta.url).href;
const hookReader = (await import(readerUrl)) as ParseHelpers;

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), "forge-ai-attr-"));
}

function writeConfig(dir: string, yaml: string): void {
  mkdirSync(join(dir, ".forge"), { recursive: true });
  writeFileSync(join(dir, ".forge", "config.yml"), yaml);
}

// FG-799 (follow-up): the shared parser table. readAiAttribution and the standalone
// hook reader are BOTH this one algorithm — the whole point of collapsing the bash grep
// and the `yaml` reader onto a single parse. This tier pins the TypeScript side (the
// parser + readAiAttribution) over the table; the integration tier spawns the .mjs
// reader over the SAME rows and pins it to readAiAttribution end-to-end (a unit test may
// not spawn child processes). RF-5 (root key with leading indentation) and RF-6
// (mismatched quotes) are the two edges the old grep and reader DISAGREED on.
type Row = { label: string; config?: string | "unreadable"; mode: "allow" | "suppress" };

export const AI_ATTRIBUTION_TABLE: Row[] = [
  { label: "absent config", config: undefined, mode: "suppress" },
  { label: "allow", config: "ai_attribution: allow\n", mode: "allow" },
  { label: "suppress", config: "ai_attribution: suppress\n", mode: "suppress" },
  { label: "quoted allow", config: 'ai_attribution: "allow"\n', mode: "allow" },
  { label: "single-quoted allow", config: "ai_attribution: 'allow'\n", mode: "allow" },
  { label: "allow with trailing comment", config: "ai_attribution: allow # ok\n", mode: "allow" },
  { label: "root key with leading indentation (RF-5)", config: "  ai_attribution: allow\n", mode: "allow" },
  { label: "nested key (RF-1)", config: "nested:\n  ai_attribution: allow\n", mode: "suppress" },
  { label: "mismatched quotes (RF-6)", config: 'ai_attribution: "allow\'\n', mode: "suppress" },
  { label: "unknown value", config: "ai_attribution: banana\n", mode: "suppress" },
  { label: "unreadable file", config: "unreadable", mode: "suppress" },
];

test("FG-799: readAiAttribution resolves every table input to the shared parser's mode (RF-1/3/5/6)", () => {
  for (const row of AI_ATTRIBUTION_TABLE) {
    const dir = tmpProject();
    if (row.config === "unreadable") {
      // config.yml as a DIRECTORY makes readFileSync throw regardless of uid (chmod 000
      // is moot under a root container).
      mkdirSync(join(dir, ".forge", "config.yml"), { recursive: true });
    } else if (row.config !== undefined) {
      writeConfig(dir, row.config);
      // the pure parser and the file-reading wrapper must agree on the text case
      assert.equal(parseAiAttributionConfig(row.config).mode, row.mode, `parser mode for ${row.label}`);
    }
    assert.equal(readAiAttribution(dir).mode, row.mode, `readAiAttribution mode for ${row.label}`);
    rmSync(dir, { recursive: true, force: true });
  }
});

// FG-799 (RF-1): the shipped hook reader duplicates the parse by necessity (bare node,
// no node_modules), so the two copies must agree at the level where bytes matter — the
// EXACT values the parse helpers return, not just the resolved mode. The mode-only table
// above is blind to a divergence that fails closed either way: the malformed-quote
// sentinel once differed (space in the reader, NUL in the TS copy) yet both mapped to
// suppress, so no mode assertion could catch it. This pins the helpers by value.
const SCALAR_EDGE_INPUTS = [
  "allow",
  "suppress",
  " allow ",
  '"allow"',
  "'allow'",
  "allow # trailing",
  '"allow',      // opens a double quote it never closes → the malformed-quote sentinel
  "'allow",      // opens a single quote it never closes → the sentinel
  '"allow\'',    // mismatched quotes → the sentinel
  "",
  "   ",
  "# comment-only",
  'x "y" # z',
];

test("FG-799 (RF-1): the hook reader's parse helpers return byte-identical values to the TS copy", () => {
  for (const input of SCALAR_EDGE_INPUTS) {
    assert.equal(hookReader.scalarValue(input), scalarValue(input), `scalarValue divergence on ${JSON.stringify(input)}`);
    assert.equal(hookReader.stripComment(input), stripComment(input), `stripComment divergence on ${JSON.stringify(input)}`);
  }
  // The malformed-quote sentinel is the exact byte that drifted: pin it explicitly and
  // confirm it still fails closed (matches no recognized mode) on BOTH copies.
  const sentinel = scalarValue('"x');
  assert.equal(hookReader.scalarValue('"x'), sentinel, "the malformed-quote sentinel must be byte-identical across copies");
  assert.notEqual(sentinel, "allow");
  assert.notEqual(sentinel, "suppress");

  // And the top-level parse agrees deeply on every config in the shared table.
  for (const row of AI_ATTRIBUTION_TABLE) {
    if (typeof row.config !== "string") continue;
    assert.deepEqual(
      hookReader.parseAiAttributionConfig(row.config),
      parseAiAttributionConfig(row.config),
      `parseAiAttributionConfig divergence on ${row.label}`,
    );
  }
});

test("readAiAttribution: absent config → suppress (default)", () => {
  const dir = tmpProject();
  assert.deepEqual(readAiAttribution(dir), { mode: "suppress", source: "default" });
  rmSync(dir, { recursive: true, force: true });
});

test("readAiAttribution: allow is read from project config", () => {
  const dir = tmpProject();
  writeConfig(dir, "ai_attribution: allow\n");
  assert.deepEqual(readAiAttribution(dir), { mode: "allow", source: "project-config" });
  rmSync(dir, { recursive: true, force: true });
});

test("readAiAttribution: explicit suppress reads as project-config source", () => {
  const dir = tmpProject();
  writeConfig(dir, "ai_attribution: suppress\n");
  assert.deepEqual(readAiAttribution(dir), { mode: "suppress", source: "project-config" });
  rmSync(dir, { recursive: true, force: true });
});

test("readAiAttribution: unrecognized/malformed value fails closed to the suppress default", () => {
  const dir = tmpProject();
  writeConfig(dir, "ai_attribution: banana\n");
  assert.deepEqual(readAiAttribution(dir), { mode: "suppress", source: "default" });
  writeConfig(dir, ":\n  not: yaml: at all\n"); // malformed
  assert.deepEqual(readAiAttribution(dir), { mode: "suppress", source: "default" });
  rmSync(dir, { recursive: true, force: true });
});

test("readAiAttribution: a NESTED (non-top-level) ai_attribution key reads as the suppress default (RF-1)", () => {
  // The reader honors ONLY the top-level key. An indented key under some other mapping
  // is not the toggle, so it resolves to suppress — and the commit-msg hook's column-0
  // grep must agree (proven in fg799-commit-hook-toggle.integration.test.ts).
  const dir = tmpProject();
  writeConfig(dir, "nested:\n  ai_attribution: allow\n");
  assert.deepEqual(readAiAttribution(dir), { mode: "suppress", source: "default" });
  rmSync(dir, { recursive: true, force: true });
});

test("readAiAttribution: quoted and trailing-comment allow forms read as allow (RF-3 parity)", () => {
  // The same YAML forms the hook's grep must accept: "allow", 'allow', allow # comment.
  for (const yaml of ['ai_attribution: "allow"\n', "ai_attribution: 'allow'\n", "ai_attribution: allow # approved\n"]) {
    const dir = tmpProject();
    writeConfig(dir, yaml);
    assert.deepEqual(readAiAttribution(dir), { mode: "allow", source: "project-config" }, `reader must treat ${JSON.stringify(yaml)} as allow`);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeAiAttribution: round-trips and PRESERVES other keys", () => {
  const dir = tmpProject();
  writeConfig(dir, "project_key: pk-abc\nbacklog:\n  prefix: FG\n");

  writeAiAttribution(dir, "allow");
  assert.equal(readAiAttribution(dir).mode, "allow");

  const parsed = parseYaml(readFileSync(join(dir, ".forge", "config.yml"), "utf8")) as Record<string, unknown>;
  assert.equal(parsed["project_key"], "pk-abc", "project_key preserved");
  assert.deepEqual(parsed["backlog"], { prefix: "FG" }, "backlog subtree preserved");
  assert.equal(parsed["ai_attribution"], "allow", "snake_case key written to YAML");

  // Flipping back is a clean read-modify-write, still preserving neighbors.
  writeAiAttribution(dir, "suppress");
  const parsed2 = parseYaml(readFileSync(join(dir, ".forge", "config.yml"), "utf8")) as Record<string, unknown>;
  assert.equal(parsed2["ai_attribution"], "suppress");
  assert.equal(parsed2["project_key"], "pk-abc");
  rmSync(dir, { recursive: true, force: true });
});

test("writeAiAttribution: creates .forge/config.yml when absent", () => {
  const dir = tmpProject();
  writeAiAttribution(dir, "allow");
  assert.equal(readAiAttribution(dir).mode, "allow");
  rmSync(dir, { recursive: true, force: true });
});

test("formatAiAttribution: the exact strings config-show / doctor print", () => {
  assert.equal(formatAiAttribution({ mode: "suppress", source: "default" }), "ai attribution: suppress (default)");
  assert.equal(
    formatAiAttribution({ mode: "allow", source: "project-config" }),
    "ai attribution: allow (.forge/config.yml)",
  );
});
