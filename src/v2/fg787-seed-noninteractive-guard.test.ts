// FG-787: every container-agent seed carries the same non-interactive rule and
// the completion invariant. Synthesizer has no tools and is the one exclusion.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const seedsDir = fileURLToPath(new URL("../../seeds/agents/", import.meta.url));
const HEADING = "## Non-interactive — don't wait past your turn";
const INVARIANT_PREFIX = "The completion invariant: **`result.json` must be written before your final turn ends.**";

function seeds(): Array<{ role: string; text: string }> {
  return readdirSync(seedsDir)
    .filter((role) => existsSync(`${seedsDir}${role}/CLAUDE.md`))
    .map((role) => ({ role, text: readFileSync(`${seedsDir}${role}/CLAUDE.md`, "utf8") }));
}

function paragraphAfter(text: string, marker: string): string | undefined {
  const at = text.indexOf(marker);
  if (at < 0) return undefined;
  const body = text.slice(at + marker.length).replace(/^\s+/, "");
  return body.slice(0, body.indexOf("\n\n"));
}

test("FG-787 seeds: every seed with the non-interactive section words it identically", () => {
  const withSection = seeds().filter((s) => s.text.includes(HEADING));
  assert.ok(withSection.length > 0);
  const reference = paragraphAfter(readFileSync(`${seedsDir}engineer/CLAUDE.md`, "utf8"), HEADING);
  for (const s of withSection) assert.equal(paragraphAfter(s.text, HEADING), reference, `${s.role} non-interactive rule drifted`);
});

// test-engineer words the invariant's follow-on sentence for its own role, so
// the guard pins the binding sentence rather than the whole line.
test("FG-787 seeds: every container-agent seed carries the completion invariant", () => {
  for (const s of seeds()) {
    if (s.role === "synthesizer") continue;
    assert.ok(s.text.includes(HEADING), `${s.role} lacks the non-interactive section`);
    assert.ok(s.text.split("\n").some((l) => l.startsWith(INVARIANT_PREFIX)), `${s.role} lacks the completion invariant`);
  }
});
