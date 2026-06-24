// parseBacklog tests against the legacy fixture and inline inputs.
//
// serialize.ts has been removed — roundtrip tests are intentionally gone.
// The fixture (legacy-backlog.md) is kept so migrate's reader is exercised
// by the first two tests, and to prevent bit-rot in parse.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseBacklog } from "./parse.js";
import { SECTION_ORDER } from "./types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const BACKLOG_PATH = join(HERE, "__fixtures__", "legacy-backlog.md");

test("parser identifies sections + ticket counts on BACKLOG.md", () => {
  const original = readFileSync(BACKLOG_PATH, "utf8");
  const b = parseBacklog(original);

  // Notes is non-empty.
  assert.ok(b.notes.length > 0);
  // Preamble starts with the top-level heading.
  assert.match(b.preamble, /^# forge — backlog/);

  // Every section is keyed (may be empty).
  for (const name of SECTION_ORDER) {
    assert.ok(b.sections.has(name), `section ${name} should be present`);
  }

  // Active should be non-empty (real running project).
  const active = b.sections.get("Active")!;
  assert.ok(active.length > 0, "Active should contain tickets");

  // Done (recent) should have #116 (v2 cutover) and #132 (backlog CLI).
  const doneRecent = b.sections.get("Done (recent)")!;
  const doneIds = doneRecent.map((t) => t.id);
  assert.ok(doneIds.includes(116), "Done (recent) should contain #116");
  assert.ok(doneIds.includes(132), "Done (recent) should contain #132");
});

test("parser preserves ticket bodies as raw markdown (no interpretation)", () => {
  const original = readFileSync(BACKLOG_PATH, "utf8");
  const b = parseBacklog(original);

  // #116 is in Done (recent) — verify its body preserved the v2-cutover prose.
  const doneRecent = b.sections.get("Done (recent)")!;
  const t116 = doneRecent.find((t) => t.id === 116);
  assert.ok(t116, "Done (recent) should contain #116");
  assert.match(t116!.body, /v2 runner core/);
  assert.match(t116!.body, /YAML/);
});

test("## inside ticket body does not split the section", () => {
  const input = [
    "# forge — backlog",
    "",
    "Intro.",
    "",
    "## Notes for next session",
    "",
    "Notes here.",
    "",
    "## Active",
    "",
    "### #1 — ticket with subheading",
    "**Why:** Body content.",
    "",
    "## Sub-heading",
    "",
    "More body under subheading.",
    "",
    "### #2 — next ticket",
    "**Why:** Second body.",
    "",
  ].join("\n");

  const b = parseBacklog(input);
  const active = b.sections.get("Active")!;
  assert.equal(active.length, 2);
  assert.match(active[0]!.body, /## Sub-heading/);
  assert.match(active[0]!.body, /More body under subheading/);
  assert.equal(active[1]!.id, 2);
});

test("## inside notes block is not treated as a section boundary", () => {
  const input = [
    "# forge — backlog",
    "",
    "Intro.",
    "",
    "## Notes for next session",
    "",
    "Some notes.",
    "",
    "## A random heading inside notes",
    "",
    "More notes content.",
    "",
    "## Active",
    "",
    "### #1 — ticket",
    "**Why:** Body.",
    "",
  ].join("\n");

  const b = parseBacklog(input);
  assert.match(b.notes, /## A random heading inside notes/);
  assert.match(b.notes, /More notes content/);

  const active = b.sections.get("Active")!;
  assert.equal(active.length, 1);
});

test("parser throws when Notes heading is missing", () => {
  const bad = "# title\n\nsome stuff but no notes section\n\n## Active\n";
  assert.throws(() => parseBacklog(bad), /Notes for next session/);
});

test("parser handles a minimal hand-written backlog", () => {
  const minimal = [
    "# forge — backlog",
    "",
    "Intro paragraph.",
    "",
    "## Notes for next session",
    "",
    "Some notes here.",
    "",
    "## Active",
    "",
    "### #1 — first ticket",
    "**Why:** Body content.",
    "",
    "### #2 — second ticket",
    "**Why:** Other body.",
    "",
  ].join("\n");

  const b = parseBacklog(minimal);
  const active = b.sections.get("Active")!;
  assert.equal(active.length, 2);
  assert.equal(active[0]!.id, 1);
  assert.equal(active[0]!.title, "first ticket");
  assert.equal(active[1]!.id, 2);
  assert.equal(active[1]!.title, "second ticket");
});
