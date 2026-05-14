// Parse + serialize roundtrip tests.
//
// Acceptance bar: parsing the real BACKLOG.md and serializing it back
// produces byte-identical output. If this test fails on a real-world edit,
// either the file format drifted (intentional, update parser) or the parser
// is wrong (unintentional, fix it).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseBacklog } from "./parse.js";
import { serializeBacklog } from "./serialize.js";
import { SECTION_ORDER } from "./types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const BACKLOG_PATH = join(HERE, "..", "..", "BACKLOG.md");

test("parse(BACKLOG.md) → serialize() roundtrips byte-for-byte", () => {
  const original = readFileSync(BACKLOG_PATH, "utf8");
  const parsed = parseBacklog(original);
  const roundtripped = serializeBacklog(parsed);
  assert.equal(roundtripped, original);
});

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

  // Roundtrip.
  const round = serializeBacklog(b);
  assert.equal(round, minimal);
});
