// FG-745 browser regression: the Projects grid must derive visibility SOLELY from the
// /api/projects payload — it renders an `unclassified` record (visible fail-safe) with a
// badge and a working classify affordance, never shows a recorded artifact as a peer
// card, and shows a one-run/no-remote independent project normally. Nothing is stubbed:
// the real dashboard server, the real store and the co-located `bin/forge` classify CLI
// stand behind every read and the classify write.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { chromium, type Browser, type Page } from "playwright-core";
import { requireChrome } from "../../src/util/chrome-bin.js";

const PORT = 18871;
const BASE = `http://127.0.0.1:${PORT}`;
const home = mkdtempSync(join(tmpdir(), "forge-fg745-browser-"));
const forgeHome = join(home, ".forge");
const checkouts = join(home, "checkouts");

mkdirSync(forgeHome, { recursive: true });
mkdirSync(checkouts, { recursive: true });
process.env.HOME = home;
process.env.FORGE_HOME = forgeHome;
process.env.FORGE_DB_PATH = join(forgeHome, "forge.db");
process.env.FORGE_PROJECT_SCAN_ROOTS = checkouts;
process.env.PORT = String(PORT);
process.env.HOST = "127.0.0.1";
// No stub: the classify affordance shells the co-located `bin/forge`, which is the
// point — a classify that "worked" against a recording binary would prove nothing
// about whether the purpose row was actually written and the card actually suppressed.
delete process.env.FORGE_BIN;

// A no-remote checkout: identity falls back to the git common dir / path, and the
// project must still be visible (AC4 — no remote-presence heuristic decides visibility).
function checkout(dir: string, withRemote: boolean): string {
  mkdirSync(dir);
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  if (withRemote) {
    execFileSync("git", ["remote", "add", "origin", "git@github.com:acme/fg745.git"], { cwd: dir, stdio: "ignore" });
  }
  return realpathSync(dir);
}

// (a) A genuinely independent project: one run, NO remote. Never recorded, so it is
//     `unclassified` — visible, flagged, and repairable (AC4/AC8).
const independent = checkout(join(checkouts, "fg745-independent"), false);
// (b) A recorded disposable artifact with a durable owner — must NOT appear (AC1/AC3).
const artifact = checkout(join(checkouts, "fg745-artifact"), true);
// (c) An unclassified legacy directory the operator will classify AWAY through the UI
//     (AC3/AC8): after classification it ceases to be a top-level project.
const legacy = checkout(join(checkouts, "fg745-legacy"), false);

const now = new Date().toISOString();

const { insertRun } = await import("../../src/store/runs.js");
const { recordWorkspacePurpose } = await import("../../src/store/workspace-purpose.js");

insertRun({ id: "run-fg745-independent", workflow: "feature", title: "independent one-run project", status: "complete", createdAt: now, completedAt: now, projectDir: independent });
insertRun({ id: "run-fg745-artifact", workflow: "feature", title: "disposable clone run", status: "complete", createdAt: now, completedAt: now, projectDir: artifact });
insertRun({ id: "run-fg745-legacy", workflow: "feature", title: "legacy workspace run", status: "complete", createdAt: now, completedAt: now, projectDir: legacy });

// The artifact declares its purpose+owner at (simulated) creation — a RECORDED FACT,
// not inferred from its path or its remote. operatorProjects() suppresses it.
assert.equal(
  recordWorkspacePurpose({
    path: artifact,
    kind: "disposable_clone",
    owner: { projectIdentity: "repo-owner-fg745", runId: "run-fg745-artifact" },
    source: "creation",
  }),
  true,
  "fixture: the disposable artifact's purpose row was recorded",
);

let browser: Browser;
let server: Server;

before(async () => {
  ({ server } = await import("../src/server.js"));
  for (let attempt = 0; attempt < 75; attempt += 1) {
    try {
      await fetch(`${BASE}/`);
      break;
    } catch (error) {
      if (attempt === 74) throw error;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  }
  browser = await chromium.launch({ executablePath: requireChrome("the dashboard browser tier"), headless: true });
});

after(async () => {
  await browser?.close();
  server?.closeAllConnections?.();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

async function newPage(): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("close", () => assert.deepEqual(errors, [], `browser errors: ${errors.join("; ")}`));
  return page;
}

type ApiProject = { key: string; label: string; classification?: string; primaryCheckout: string };

test("the API omits a recorded artifact and flags an unclassified independent/legacy project", async () => {
  const projects = (await (await fetch(`${BASE}/api/projects`)).json()) as ApiProject[];
  const byDir = new Map(projects.map((p) => [p.primaryCheckout, p]));
  assert.ok(byDir.has(independent), "the one-run/no-remote independent project is visible");
  assert.ok(byDir.has(legacy), "the unclassified legacy directory is visible");
  assert.ok(!byDir.has(artifact), "the recorded disposable artifact is NOT a top-level project");
  assert.equal(byDir.get(independent)!.classification, "unclassified", "an unrecorded independent project is flagged unclassified");
});

test("the grid renders the visible projects, flags unclassified, and never shows the artifact", async () => {
  const page = await newPage();
  await page.goto(`${BASE}/#projects`);
  await page.locator(".project-card").first().waitFor();

  // Exactly the two visible projects — the client renders what the API returns and
  // never re-filters. The suppressed artifact has no card.
  await assert.doesNotReject(page.locator(".project-card").nth(1).waitFor({ timeout: 5000 }));
  assert.equal(await page.locator(".project-card").count(), 2, "only the two operator-visible projects render");
  assert.equal(await page.locator(".project-unclassified-badge").count(), 2, "both unrecorded projects carry the visible unclassified badge");
  // The classify affordance is offered (disclosed on demand from the card head).
  assert.equal(await page.locator(".project-classify-toggle").count(), 2, "each unclassified card offers the classify/repair path");
  await page.locator(".project-classify-toggle").first().click();
  assert.ok(await page.locator(".project-classify-select").first().isVisible(), "the classify form expands on demand");
  await page.close();
});

// RF-3 regression: the new classify controls must be keyboard-operable INDEPENDENTLY of
// the project card. The card activates on Enter/Space (role="button"); before the fix its
// handler also swallowed key events that BUBBLED from a focused descendant — so activating
// the classify toggle from the keyboard both suppressed the toggle (preventDefault) and
// navigated the card away (onPick → activity view). The toggle must open its own form and
// leave the Projects grid mounted.
test("RF-3: keyboard-activating the classify toggle opens its form and does NOT activate the card", async () => {
  const page = await newPage();
  await page.goto(`${BASE}/#projects`);
  await page.locator(".project-card").first().waitFor();

  const card = page.locator(".project-card", { has: page.locator(`.project-path`, { hasText: independent }) });
  await card.waitFor();

  const toggle = card.locator(".project-classify-toggle");
  await toggle.focus();
  await page.keyboard.press("Enter");

  // The toggle activated in place: its classify form is disclosed.
  await card.locator(".project-classify-select").waitFor({ timeout: 3000 });
  assert.ok(
    await card.locator(".project-classify-select").isVisible(),
    "keyboard activation of the toggle opened its own form",
  );
  // The card did NOT navigate: the Projects grid is still mounted (onPick never fired).
  assert.equal(
    await page.locator(".projects-grid").count(),
    1,
    "the card's Enter/Space handler ignored the key event bubbling from the toggle",
  );
  await page.close();
});

// The classify affordance's EFFECT on membership is proven against the shared seam
// (listProjects + operatorProjects — the same one `forge projects list` and the
// dashboard consume) rather than the dashboard's /api/projects, whose short-lived
// server-side projectCache would otherwise mask a just-written change for its TTL.
const { listProjects, operatorProjects } = await import("../../src/util/projects.js");
const { getDb: openStore } = await import("../../src/store/db.js");

function recordedKind(dir: string): string | null {
  const row = openStore()
    .prepare("SELECT kind FROM workspace_purposes WHERE path = ?")
    .get(dir) as { kind: string } | undefined;
  return row?.kind ?? null;
}

test("classifying a legacy workspace as an artifact writes through the real CLI and drops it from operator membership", async () => {
  const page = await newPage();
  await page.goto(`${BASE}/#projects`);
  await page.locator(".project-card").first().waitFor();

  // Find the legacy card by its recorded path (rendered in a checkout row).
  const legacyCard = page.locator(".project-card", { has: page.locator(`.project-path`, { hasText: legacy }) });
  await legacyCard.waitFor();

  await legacyCard.locator(".project-classify-toggle").click();
  await legacyCard.locator(".project-classify-select").selectOption("disposable_clone");
  const classified = page.waitForResponse((r) => r.url().endsWith("/api/projects/classify") && r.request().method() === "POST");
  await legacyCard.locator(".project-classify-submit").click();
  assert.equal((await classified).status(), 200, "the classify claim succeeded through the co-located forge CLI");

  // Immediate, in-scope confirmation (the grid card re-projects on the next uncached read).
  await legacyCard.locator(".project-classify-done").waitFor({ timeout: 5000 });

  // The write actually landed in the store, and the SHARED membership seam now
  // suppresses the workspace — the CLI and dashboard both consume this (AC3/AC7).
  assert.equal(recordedKind(legacy), "disposable_clone", "the purpose row was written by the real classify CLI");
  const members = operatorProjects(listProjects()).map((p) => p.primaryCheckout);
  assert.ok(!members.includes(legacy), "the classified legacy workspace is no longer an operator project");
  assert.ok(members.includes(independent), "an unrelated independent project is untouched by the classification");
  await page.close();
});

test("classifying an independent project as an operator project keeps it in operator membership", async () => {
  const page = await newPage();
  await page.goto(`${BASE}/#projects`);
  await page.locator(".project-card").first().waitFor();

  const card = page.locator(".project-card", { has: page.locator(`.project-path`, { hasText: independent }) });
  await card.waitFor();
  await card.locator(".project-unclassified-badge").waitFor({ timeout: 3000 });

  await card.locator(".project-classify-toggle").click();
  const classified = page.waitForResponse((r) => r.url().endsWith("/api/projects/classify") && r.request().method() === "POST");
  // Default option is "operator" — submit keeps the project first-class.
  await card.locator(".project-classify-submit").click();
  assert.equal((await classified).status(), 200, "the operator classification succeeded");
  await card.locator(".project-classify-done").waitFor({ timeout: 5000 });

  assert.equal(recordedKind(independent), "operator", "the independent project was recorded as an operator project");
  const members = operatorProjects(listProjects());
  const record = members.find((p) => p.primaryCheckout === independent);
  assert.ok(record, "the operator-classified project remains an operator project");
  assert.equal(record!.classification, "operator", "and is no longer flagged unclassified");
  await page.close();
});

// RF-1: a successful classify removes the whole form, including the focused submit
// button, and renders the status confirmation in its place. A keyboard operator must
// not be stranded on the detached button (focus falling back to <body>) — focus lands
// on the confirmation, which is programmatically focusable and announced (role=status).
test("RF-1: after a keyboard-driven classify, focus lands on the confirmation, not <body>", async () => {
  const page = await newPage();
  await page.goto(`${BASE}/#projects`);
  await page.locator(".project-card").first().waitFor();

  const card = page.locator(".project-card", { has: page.locator(`.project-path`, { hasText: legacy }) });
  await card.waitFor();

  // Open the form and drive the submit from the KEYBOARD, so the focused element at the
  // moment of success is the submit button that is about to be removed.
  await card.locator(".project-classify-toggle").click();
  await card.locator(".project-classify-select").selectOption("disposable_clone");
  const submit = card.locator(".project-classify-submit");
  await submit.focus();
  const classified = page.waitForResponse((r) => r.url().endsWith("/api/projects/classify") && r.request().method() === "POST");
  await page.keyboard.press("Enter");
  assert.equal((await classified).status(), 200, "the keyboard-driven classify succeeded");

  const doneEl = card.locator(".project-classify-done");
  await doneEl.waitFor({ timeout: 5000 });
  // The confirmation replaced the form; focus must have followed it there.
  await page.waitForFunction(
    () => document.activeElement?.classList.contains("project-classify-done") ?? false,
    undefined,
    { timeout: 3000 },
  );
  assert.ok(
    await doneEl.evaluate((el) => el === document.activeElement),
    "focus moved to the status confirmation, so the keyboard operator is not stranded on <body>",
  );
  await page.close();
});
