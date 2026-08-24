// FG-759 RF-2: the project card hosts its own interactive controls (the primary
// "Open <label>" chip, the one-click "This is my project" claim, the classify toggle,
// the working-dirs toggle, the GitHub link). Interactive content nested inside a
// role=button is invalid ARIA and confuses assistive tech, so the card is a PLAIN
// container — the focusable primary "open project" control is a real <button> (the label
// chip). The whole-card click stays as a mouse convenience but must never fire when the
// click originates inside an interactive descendant. ProjectCard cannot be imported
// (main.js calls render() at module scope), so this guards the shipped source.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const main = readFileSync(new URL("../client/main.js", import.meta.url), "utf8");

function projectCardSource(): string {
  const start = main.indexOf("function ProjectCard(");
  assert.notEqual(start, -1, "ProjectCard is gone — re-audit the project-card interaction guards");
  const end = main.indexOf("\nfunction ", start + 1);
  return main.slice(start, end === -1 ? undefined : end);
}

function cardRootTag(card: string): string {
  // The opening tag of the card's root <div class="project-card ...">.
  const open = card.indexOf("<div class=");
  assert.notEqual(open, -1, "the card renders a root <div> container");
  return card.slice(open, card.indexOf(">", open) + 1);
}

test("the card container is NOT an ARIA button and carries no card-level keyboard/label semantics", () => {
  const root = cardRootTag(projectCardSource());
  assert.doesNotMatch(root, /role=(["'`])button\1/, "the card container must not be role=button — it hosts interactive controls");
  assert.doesNotMatch(root, /\btabIndex\b/, "the card container must not be a tab stop (no card-level tabIndex)");
  assert.doesNotMatch(root, /\baria-label\b/, "the card container must not carry an 'Open …' aria-label — that belongs to the open control");
  assert.doesNotMatch(root, /\bonKeyDown\b/, "the card container must not duplicate the open action with a card-level key handler");
});

test("the primary 'open project' control is a real, focusable <button> labeled 'Open …'", () => {
  const card = projectCardSource();
  // A <button> is natively focusable; its aria-label names the open action.
  assert.match(
    card,
    /<button[^>]*class=(["'`])[^"'`]*project-open[^"'`]*\1/,
    "the label chip is rendered as a <button> primary open control (.project-open)",
  );
  const openBtn = card.slice(card.indexOf("project-open"));
  assert.match(openBtn.slice(0, 400), /aria-label=\$\{`Open \$\{project\.label\}`\}/, "the open control is labeled 'Open <label>'");
  // It opens the project.
  assert.match(card, /const openProject = \(event\) => \{[^}]*onPick\(project, null\)/s, "the open control activates onPick");
});

test("no interactive element (button/a/input) is a descendant of an element declaring role=button", () => {
  const card = projectCardSource();
  // Structural guarantee for the RF-2 ARIA defect: since nothing in the card declares
  // role=button anymore, no interactive control can be nested inside one.
  assert.doesNotMatch(card, /role=(["'`])button\1/, "the card contains no role=button — so no interactive control is nested in one");
});

test("the card's onClick does not open the project when the click originates in an interactive descendant", () => {
  const card = projectCardSource();
  const onClick = card.slice(card.indexOf("const onClick ="), card.indexOf("return html`"));
  assert.match(
    onClick,
    /event\.target\.closest\((["'`])[^"'`]*button[^"'`]*\1\)/,
    "the card activation is guarded against clicks that originate inside an interactive control (button/link/etc.)",
  );
  assert.match(onClick, /return/, "…and that guard short-circuits before onPick opens the card");
});

test("the one-click claim control stops its own click from bubbling to the card", () => {
  const card = projectCardSource();
  const claim = card.slice(card.indexOf("const claimAsProject"), card.indexOf("const checkouts"));
  assert.match(claim, /event\.stopPropagation\(\)/, "the claim handler stops propagation so it classifies without opening the card");
});

test("a successful one-click claim confirms success and announces it, not a silent reload", () => {
  const card = projectCardSource();
  const claim = card.slice(card.indexOf("const claimAsProject"), card.indexOf("const checkouts"));
  // RF-2: on a successful POST the handler records a success state — not just a reload.
  assert.match(
    claim,
    /if \(result\.ok\) \{[^}]*setClaimed\(true\)/s,
    "a successful claim sets a local success state so the write is perceivable before the cached list refreshes",
  );
  // The success state renders an announced (role=status), focusable confirmation, and the
  // claim button is no longer offered once claimed.
  assert.match(
    card,
    /unclassified && claimed[\s\S]*?class="project-claim-done"[\s\S]*?role="status"[\s\S]*?tabindex="-1"/,
    "the success confirmation is a role=status, focusable element rendered on claim",
  );
  assert.match(
    card,
    /unclassified && !claimed[\s\S]*?class="project-claim"/,
    "the 'This is my project' button is hidden once the claim succeeds",
  );
  // A failed claim still surfaces the error verbatim.
  assert.match(claim, /setClaimError\(result\.error\)/, "a failed claim still shows the existing error");
});

// RF-3: the success confirmation must fit inside a normal-width card. A long nowrap
// sentence runs past the card edge (same overflow class as the github-badge clip).
// Keep the confirmation concise AND let it wrap rather than pinning it to one line.
test("the claim-success confirmation stays inside the card (concise, not nowrap)", () => {
  const shell = readFileSync(new URL("./shell.ts", import.meta.url), "utf8");
  const block = shell.slice(shell.indexOf(".project-claim-done {"));
  const rule = block.slice(0, block.indexOf("}"));
  assert.doesNotMatch(
    rule,
    /white-space:\s*nowrap/,
    ".project-claim-done must not force nowrap — it overflows a normal-width card",
  );

  const card = projectCardSource();
  const done = card.match(/class="project-claim-done"[\s\S]*?>([^<]*)</);
  const text = done?.[1] ?? "";
  assert.notEqual(done, null, "the claim-done confirmation renders text");
  assert.ok(
    text.trim().length <= 32,
    "the confirmation is a short label, not a full sentence that needs nowrap",
  );
});
