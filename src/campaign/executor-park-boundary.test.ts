// FG-516 (finding B) — STRUCTURAL GUARD. The repeated two-step park pattern
// (tryTransitionCampaign(running→paused) … notifyCampaignPause(...)) hand-wired at
// ~19 sites is why every review round found another variant that notified without a
// committed pause. The fix replaces the pattern with ONE boundary — parkCampaign —
// that performs the CAS itself and notifies only when it committed. This test makes
// the variant class UNREPRESENTABLE: it scans the executor source and asserts that
//   (a) tryTransitionCampaign(campaignId, "running", "paused") is called ONLY inside
//       the parkCampaign boundary, and
//   (b) notifyCampaignPause is CALLED only inside parkCampaign.
// A new hand-wired park site fails CI here before it can ship. Same spirit as the
// test-tier subprocess/purity content guard (src/test-tiers.test.ts).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const EXECUTOR_SRC = fileURLToPath(new URL("./executor.ts", import.meta.url));

// The line range [start, end] of the `async function parkCampaign(` definition —
// its body is the ONLY place the guarded calls may appear. parkCampaign is a
// top-level function, so its closing brace sits at column 0.
function parkCampaignRange(lines: string[]): { start: number; end: number } {
  const start = lines.findIndex((l) => /async function parkCampaign\s*\(/.test(l));
  assert.ok(start >= 0, "parkCampaign boundary function must exist in executor.ts");
  const end = lines.findIndex((l, i) => i > start && l === "}");
  assert.ok(end > start, "parkCampaign closing brace (column 0) must be found");
  return { start, end };
}

function isComment(line: string): boolean {
  const t = line.trim();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

test("FG-516: tryTransitionCampaign(running→paused) is called ONLY inside the parkCampaign boundary", () => {
  const lines = readFileSync(EXECUTOR_SRC, "utf8").split("\n");
  const { start, end } = parkCampaignRange(lines);
  const offenders: string[] = [];
  lines.forEach((line, i) => {
    if (isComment(line)) return;
    if (/tryTransitionCampaign\s*\(\s*campaignId\s*,\s*"running"\s*,\s*"paused"\s*\)/.test(line)) {
      if (i < start || i > end) offenders.push(`executor.ts:${i + 1}: ${line.trim()}`);
    }
  });
  assert.deepEqual(
    offenders,
    [],
    `Every running→paused transition must go through parkCampaign. Hand-wired sites:\n${offenders.join("\n")}`,
  );
});

test("FG-516: notifyCampaignPause is CALLED only inside the parkCampaign boundary", () => {
  const lines = readFileSync(EXECUTOR_SRC, "utf8").split("\n");
  const { start, end } = parkCampaignRange(lines);
  const offenders: string[] = [];
  lines.forEach((line, i) => {
    if (isComment(line)) return;
    // A CALL — not the `async function notifyCampaignPause(` definition line.
    if (/\bnotifyCampaignPause\s*\(/.test(line) && !/function\s+notifyCampaignPause/.test(line)) {
      if (i < start || i > end) offenders.push(`executor.ts:${i + 1}: ${line.trim()}`);
    }
  });
  assert.deepEqual(
    offenders,
    [],
    `notifyCampaignPause may only be called from parkCampaign. Direct call sites:\n${offenders.join("\n")}`,
  );
});
