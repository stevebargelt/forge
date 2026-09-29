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

test("the queue-state (blocked-vs-waiting) detail text is not painted in the sub-AA --fg-faint token (RF-4)", () => {
  // The .queue-wait-meta/.queue-wait-note rule shares one declaration block; querying
  // the second selector (the one immediately before `{`) reads it for both.
  const body = ruleBody(renderShell(), ".queue-wait-note");
  assert.match(body, /color: var\(--fg-dim\)/, "queue-state detail must use the AA-contrast token");
  assert.doesNotMatch(body, /color: var\(--fg-faint\)/, "queue-state detail is 2.74:1 on the card in --fg-faint");
});

function tokenHex(css: string, token: string): string {
  const m = css.match(new RegExp(`${token}: (#[0-9a-fA-F]{6});`));
  assert.ok(m?.[1], `no hex value for ${token}`);
  return m[1];
}

function contrast(a: string, b: string): number {
  const channel = (hex: string, i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const lum = (hex: string) => 0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5);
  return (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
}

test("the Roles list's inactive sort-header buttons are painted in a token with >= 4.5:1 contrast on --bg (FG-828 RF-1)", () => {
  const shell = renderShell();
  const body = ruleBody(shell, ".roles-table .sort-header");
  const m = body.match(/color: var\((--[a-z-]+)\)/);
  assert.ok(m?.[1], "the inactive sort header must set its own colour, not inherit the th's --fg-faint");
  const ratio = contrast(tokenHex(shell, m[1]), tokenHex(shell, "--bg"));
  assert.ok(ratio >= 4.5, `${m[1]} is ${ratio.toFixed(2)}:1 on --bg`);
  assert.match(shell, /\.roles-table th\[aria-sort="ascending"\] \.sort-header, \.roles-table th\[aria-sort="descending"\] \.sort-header \{ color: var\(--fg\); \}/,
    "the active header keeps the full --fg colour");
});
