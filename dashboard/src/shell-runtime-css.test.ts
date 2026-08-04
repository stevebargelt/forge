// FG-648 review fixes: the runtime panel's stylesheet invariants, pinned against
// the rendered shell rather than the source layout, so a later edit that moves a
// rule cannot quietly re-introduce what these findings removed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FORGE_HOME = mkdtempSync(join(tmpdir(), "forge-shell-runtime-css-"));

const { renderShell } = await import("./shell.js");

/** The block body of a rule, e.g. `.runtime-caption` → its declarations. */
function ruleBody(css: string, selector: string): string {
  const at = css.indexOf(`${selector} {`);
  assert.ok(at >= 0, `no rule for ${selector}`);
  return css.slice(at, css.indexOf("}", at));
}

test(".sr-only is declared exactly once — a second copy loses the cascade and half-applies", () => {
  const occurrences = [...renderShell().matchAll(/^\s*\.sr-only\s*\{/gm)];
  assert.equal(occurrences.length, 1, `.sr-only is declared ${occurrences.length} times`);
});

test("the chart's bar animation is disabled under prefers-reduced-motion", () => {
  const shell = renderShell();
  assert.match(shell, /\.runtime-bar \{ transition: height/, "the bar transition itself is the thing being guarded");
  const guard = shell.match(/@media \(prefers-reduced-motion: reduce\) \{[^}]*\}/);
  assert.ok(guard, "no prefers-reduced-motion rule at all");
  assert.match(guard[0], /\.runtime-bar \{ transition: none; \}/);
});

test("no viewport breakpoint sizes the chart's labels — that is measured in the client", () => {
  const shell = renderShell();
  const chartFontRules = [...shell.matchAll(/\.runtime-chart svg text \{[^}]*font-size[^}]*\}/g)];
  assert.deepEqual(chartFontRules.map((m) => m[0]), [],
    "a CSS font-size outranks the measured presentation attribute and reinstates the breakpoint cliff");
});

test("the chart's caption text is not painted in the sub-AA --fg-faint token", () => {
  const shell = renderShell();
  for (const selector of [".runtime-caption", ".runtime-table caption", ".runtime-bucket-values"]) {
    const body = ruleBody(shell, selector);
    assert.match(body, /color: var\(--fg-dim\)/, `${selector} must use the AA-contrast token`);
    assert.doesNotMatch(body, /color: var\(--fg-faint\)/, `${selector} is 2.74:1 on --bg-elev in --fg-faint`);
  }
});
