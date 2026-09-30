// FG-834 part 2: the Edit RACI mode on Setup › Routing, in a real browser against the REAL
// dashboard server (GET /api/raci, POST /api/raci/propose|apply) over a scratch FORGE_HOME
// and a registered git checkout that already carries a project override.
//
// `forge` is a recording shim (FORGE_BIN): it logs every argv and execs the real
// `bin/forge`, so the gate, the diff, the override write and the audit line are the CLI's
// own. Touching REFUSE_APPLY makes it answer `raci apply` with the gate refusal a weakened
// host force rule produces, to prove the refusal is shown and never bypassed.
//
// Screenshots go to a fresh temp dir unless FG834_SCREENSHOT_DIR names one.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import { chromium, type Browser, type Page } from "playwright-core";
import { CHROME_LAUNCH_ARGS, requireChrome } from "../../src/util/chrome-bin.js";

const SHOTS = process.env.FG834_SCREENSHOT_DIR ?? mkdtempSync(join(tmpdir(), "fg834-screenshots-"));

const TEST_PORT = 18841;
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = realpathSync(resolve(HERE, "..", ".."));
const REAL_FORGE = join(REPO_ROOT, "bin", "forge");
const SEEDS = join(REPO_ROOT, "seeds");

const HOST_RACI = readFileSync(join(SEEDS, "forge-raci.md"), "utf8");
const BACKEND_ANCHOR = "responsible: red-backend\naccountable: human\npath: invoke";
assert.ok(HOST_RACI.includes(BACKEND_ANCHOR), "the seed RACI carries the review_backend anchor this suite edits");
// The override the checkout starts with differs from the host in one hint, so the two are
// distinguishable and review_backend still routes to red-backend.
const OVERRIDE = HOST_RACI.replace("classification_hints: api review, data review, business-logic audit", "classification_hints: api review, data review, business-logic audit, schema review");
const EDITED = OVERRIDE.replace(BACKEND_ANCHOR, "responsible: backend-specialist\naccountable: human\npath: invoke");
const KEY_HOLDER: { key: string; dir: string; home: string; rig: string } = { key: "", dir: "", home: "", rig: "" };

let browser: Browser | undefined;
let server: Server | undefined;

const callLog = () => join(KEY_HOLDER.rig, "calls.log");
const refuseFlag = () => join(KEY_HOLDER.rig, "refuse-apply");
const overridePath = () => join(KEY_HOLDER.dir, ".forge", "forge-raci.md");

function recordedCalls(): string[][] {
  const calls: string[][] = [];
  for (const line of readFileSync(callLog(), "utf8").split("\n")) {
    if (line === "CALL") calls.push([]);
    else if (line.startsWith("ARG\t")) calls[calls.length - 1]?.push(line.slice(4));
  }
  return calls;
}

before(async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "fg834-raci-editor-")));
  const forgeHome = join(home, ".forge");
  mkdirSync(forgeHome, { recursive: true });
  process.env.HOME = home;
  process.env.FORGE_HOME = forgeHome;
  process.env.FORGE_DB_PATH = join(forgeHome, "forge.db");
  process.env.FORGE_PROJECT_SCAN_ROOTS = mkdtempSync(join(tmpdir(), "fg834-scan-"));
  process.env.PORT = String(TEST_PORT);
  process.env.HOST = "127.0.0.1";
  delete process.env.FORGE_DASHBOARD_ALLOW_REMOTE_MUTATIONS;
  delete process.env.FORGE_DASHBOARD_ORIGIN;

  // The host the gate validates against: the seed RACI, every seed agent installed, every
  // seed workflow known.
  writeFileSync(join(forgeHome, "forge-raci.md"), HOST_RACI);
  for (const agent of readdirSync(join(SEEDS, "agents"))) mkdirSync(join(forgeHome, "agents", agent), { recursive: true });
  mkdirSync(join(forgeHome, "workflows"), { recursive: true });
  for (const wf of readdirSync(join(SEEDS, "workflows"))) copyFileSync(join(SEEDS, "workflows", wf), join(forgeHome, "workflows", wf));

  const projectDir = join(home, "code", "atlas");
  mkdirSync(projectDir, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: projectDir, stdio: "ignore" });
  execFileSync("git", ["remote", "add", "origin", "git@github.com:stevebargelt/fg834-atlas.git"], { cwd: projectDir, stdio: "ignore" });
  const dir = realpathSync(projectDir);

  const { getDb, writeTransaction } = await import("../../src/store/db.js");
  const { repositoryCheckoutIdentity } = await import("../../src/util/repository-identity.js");
  writeTransaction(() => {
    getDb()
      .prepare(`INSERT INTO runs (id, workflow, title, status, created_at, project_dir) VALUES (?,?,?,?,?,?)`)
      .run("run-834", "feature", "raci editor fixture", "complete", "2026-08-07T13:00:00Z", dir);
  });

  // The checkout's existing override, applied from a terminal: the audit tail's first line.
  const seedFile = join(home, "override.md");
  writeFileSync(seedFile, OVERRIDE);
  execFileSync(REAL_FORGE, ["raci", "apply", seedFile, "--project", dir, "--confirm", "--json"], { env: process.env, stdio: "ignore" });

  const rig = mkdtempSync(join(tmpdir(), "fg834-rig-"));
  const shim = join(rig, "forge");
  writeFileSync(join(rig, "calls.log"), "");
  const refusal = JSON.stringify({
    written: false,
    reason: "validation_failed",
    proposal: { ok: false, validation: { raci: { ok: true, findings: [] }, route: { ok: false, findings: [{ code: "force_rule_weakened", route: "review_backend", message: 'the candidate drops host force rule "no-self-review" from review_backend' }] } } },
  });
  writeFileSync(shim, [
    "#!/bin/sh",
    `{ printf 'CALL\\n'; for a in "$@"; do printf 'ARG\\t%s\\n' "$a"; done; } >> "${join(rig, "calls.log")}"`,
    `if [ "$2" = "apply" ] && [ -f "${join(rig, "refuse-apply")}" ]; then printf '%s\\n' '${refusal}'; exit 1; fi`,
    `exec "${REAL_FORGE}" "$@"`,
  ].join("\n"));
  chmodSync(shim, 0o755);
  process.env.FORGE_BIN = shim;

  Object.assign(KEY_HOLDER, { key: repositoryCheckoutIdentity(dir).key, dir, home, rig });

  ({ server } = await import("../src/server.js"));
  for (let attempt = 0; attempt < 75; attempt += 1) {
    try {
      await fetch(`${BASE}/`);
      break;
    } catch {
      if (attempt === 74) throw new Error("dashboard test server did not start");
      await new Promise((r) => setTimeout(r, 40));
    }
  }
  mkdirSync(SHOTS, { recursive: true });
  browser = await chromium.launch({ executablePath: requireChrome("the dashboard browser tier"), headless: true, args: CHROME_LAUNCH_ARGS });
});

after(async () => {
  await browser?.close();
  server?.closeAllConnections?.();
  await new Promise<void>((closed) => (server ? server.close(() => closed()) : closed()));
});

const routingHash = (edit = false) =>
  `#routing?project=${encodeURIComponent(KEY_HOLDER.key)}&checkout=${encodeURIComponent(KEY_HOLDER.dir)}${edit ? "&mode=edit" : ""}`;

async function open(hash: string): Promise<{ page: Page; errors: string[] }> {
  const page = await browser!.newPage({ viewport: { width: 1400, height: 1000 }, reducedMotion: "reduce" });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${BASE}/${hash}`);
  await page.locator(".app-shell").waitFor();
  return { page, errors };
}

const dryRunPill = (page: Page) => page.locator(".raci-pane .raci-pill");
async function waitDryRun(page: Page, state: "dry_run_ok" | "invalid"): Promise<void> {
  await page.locator(`.raci-pane .raci-pill[data-raci-state="${state}"]`).waitFor({ timeout: 20_000 });
}
async function proposeGreen(page: Page): Promise<void> {
  await page.locator('[data-raci="propose"]:not([disabled])').waitFor({ timeout: 20_000 });
  await page.locator('[data-raci="propose"]').click();
  await page.locator('.raci-proposal .raci-pill[data-raci-state="gate_passed"]').waitFor({ timeout: 20_000 });
}
const applyButton = (page: Page) => page.locator('[data-raci="apply"]');

test("FG-834: edit a route → the changed tag and the diff → Apply refused without the typed key → applied with it; the new route and the audit tail re-read", async () => {
  const { page, errors } = await open(routingHash());
  const edit = page.locator('.gov-source-actions [data-raci="edit"]');
  await edit.waitFor();
  assert.equal(await page.locator(".raci-textarea").count(), 0, "view mode is the read-only workbench");
  await page.locator('.raci-recorded td:has-text("cli")').waitFor();

  // FG-692: the Edit RACI button is a real, focusable button; Enter opens edit mode.
  await edit.focus();
  await page.keyboard.press("Enter");
  await page.waitForURL(/mode=edit$/);
  await waitDryRun(page, "dry_run_ok");
  // FG-692: in edit mode the Edit RACI control is the pressed, disabled current state — never an enabled no-op.
  const current = page.locator('.gov-source-actions [data-raci="edit"]');
  assert.equal(await current.getAttribute("aria-pressed"), "true");
  assert.equal(await current.isDisabled(), true, "the current-mode control is not an enabled button with no action");
  assert.equal(await page.locator(".raci-textarea").evaluate((ta) => ta.tagName), "TEXTAREA", "a real <textarea>, not contenteditable");
  assert.equal(await page.locator(".raci-textarea").inputValue(), OVERRIDE, "the editor opens on the project's override");
  assert.equal(await page.locator(".gov-source-actions .raci-pill").getAttribute("data-raci-state"), "unedited");
  assert.match(await page.locator(".gov-source-card").innerText(), /project override[\s\S]*starting candidate: this project's override · start from the host default instead/);

  // The authoring controls are fully keyboard-operable: chip → textarea → Propose.
  const rolesChip = page.locator('[data-section="roles"]');
  await rolesChip.focus();
  await page.keyboard.press("Enter");
  assert.equal(await page.locator(".raci-textarea").evaluate((ta) => document.activeElement === ta), true);
  await page.keyboard.press("Control+A");
  await page.keyboard.type(EDITED);
  await page.locator('.gov-source-actions .raci-pill[data-raci-state="edited"]').waitFor();
  assert.match(await page.locator(".gov-source-actions .raci-pill").innerText(), /EDITED · NOT PROPOSED/i);
  const changed = page.locator('tr[data-route="review_backend"]');
  await changed.locator(".raci-tag-changed").waitFor({ timeout: 20_000 });
  assert.match(await changed.innerText(), /backend-specialist \(was red-backend\)/);
  await waitDryRun(page, "dry_run_ok");
  await page.screenshot({ path: join(SHOTS, "fg834-editing.png"), fullPage: true });

  const propose = page.locator('[data-raci="propose"]');
  await propose.focus();
  await page.keyboard.press("Enter");
  await page.locator('.raci-proposal .raci-pill[data-raci-state="gate_passed"]').waitFor({ timeout: 20_000 });
  const diff = await page.locator(".raci-diff").innerText();
  assert.match(diff, /^- responsible: red-backend$/m);
  assert.match(diff, /^\+ responsible: backend-specialist$/m);
  assert.match(await page.locator(".raci-summary").innerText(), /\+0 added\s+~1 changed\s+−0 removed\s+force rules: .* no host rule weakened/);
  assert.match(await page.locator(".raci-proposal .raci-pill").innerText(), /GATE PASSED · CANDIDATE [0-9a-f]{8} · 1[45] MIN LEFT/i);
  assert.match(await page.locator(".raci-apply").innerText(), new RegExp(`Type the project key to confirm · ${KEY_HOLDER.key}`));
  assert.match(await page.locator("#raci-apply-hint").innerText(), /forge raci apply <candidate> --project .* --confirm --by dashboard --source dashboard --rationale <rationale> --json · the CLI re-runs the gate before writing/);

  // Refused without the typed key: the button stays disabled, and the server refuses too.
  const rationale = "Backend reviews go to the specialist first; the red stays as a followup.";
  await page.locator('[data-raci="rationale"]').focus();
  await page.keyboard.type(rationale);
  await page.locator('[data-raci="confirm-key"]').focus();
  await page.keyboard.type(KEY_HOLDER.key.slice(0, 12));
  assert.equal(await applyButton(page).isDisabled(), true);
  assert.match(await page.locator(".raci-apply-reason").innerText(), /type the project key exactly/);
  const direct = await page.evaluate(async ({ key, dir, candidate, typed }) => {
    const res = await fetch("/api/raci/apply", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectKey: key, projectDir: dir, candidate, proposedSha256: "x", confirmKey: typed, rationale: "why" }),
    });
    return { status: res.status, body: await res.json() };
  }, { key: KEY_HOLDER.key, dir: KEY_HOLDER.dir, candidate: EDITED, typed: KEY_HOLDER.key.slice(0, 12) });
  assert.equal(direct.status, 400);
  assert.equal(direct.body.refusal, "confirm_key_mismatch");
  assert.equal(recordedCalls().filter((argv) => argv[1] === "apply").length, 0, "nothing was applied without the key");
  await page.screenshot({ path: join(SHOTS, "fg834-proposed.png"), fullPage: true });

  await page.locator('[data-raci="confirm-key"]').focus();
  await page.keyboard.press("Control+A");
  await page.keyboard.type(KEY_HOLDER.key);
  assert.equal(await applyButton(page).isDisabled(), false);
  await applyButton(page).focus();
  await page.keyboard.press("Enter");
  await page.locator(".raci-applied").waitFor({ timeout: 20_000 });
  await page.waitForURL((url) => !url.hash.includes("mode=edit"));
  const applied = await page.locator(".raci-applied").innerText();
  assert.match(applied, /APPLIED · EXIT 0/i);
  assert.match(applied, /Applied RACI source -> .*\.forge\/forge-raci\.md/);
  assert.match(applied, /~1 route \(review_backend\)/);

  await page.locator('#route-review_backend:has-text("backend-specialist")').waitFor({ timeout: 20_000 });
  const newest = page.locator(".raci-recorded tbody tr").first();
  await newest.locator('td:has-text("dashboard")').waitFor({ timeout: 20_000 });
  const row = await newest.innerText();
  assert.match(row, /dashboard\s+apply\s+~1 route \(review_backend\)\s+Backend reviews go to the specialist first/);
  assert.match(row, /\d{4}-\d{2}-\d{2} \d{2}:\d{2}Z/);
  assert.equal(await page.locator(".raci-recorded tbody tr").count(), 2);

  const apply = recordedCalls().filter((argv) => argv[1] === "apply");
  assert.equal(apply.length, 1);
  assert.deepEqual([apply[0]![0], apply[0]![1], ...apply[0]!.slice(3)], ["raci", "apply", "--project", KEY_HOLDER.dir, "--confirm", "--by", "dashboard", "--source", "dashboard", "--rationale", rationale, "--json"]);
  assert.equal(readFileSync(overridePath(), "utf8"), EDITED, "the CLI wrote exactly the proposed bytes");
  await page.setViewportSize({ width: 400, height: 900 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false, "the 400px editor does not create horizontal page overflow");
  assert.deepEqual(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length })), { local: 0, session: 0 });
  await page.screenshot({ path: join(SHOTS, "fg834-keyboard-400px.png"), fullPage: true });
  await page.screenshot({ path: join(SHOTS, "fg834-applied.png"), fullPage: true });
  assert.deepEqual(errors, []);
  await page.close();
});

test("FG-834: a validation error is shown inline by line; Propose is disabled and the table keeps the last green routes", async () => {
  const { page, errors } = await open(routingHash(true));
  await waitDryRun(page, "dry_run_ok");
  const base = await page.locator(".raci-textarea").inputValue();
  const lines = base.split("\n");
  const at = lines.findIndex((l) => l === "### route: review_backend") + 9;
  assert.equal(lines[at], "force_rules: none");
  lines.splice(at + 1, 0, "followups: red-backend, manual-qa, red-backend");
  const errorLine = at + 2;
  await page.locator(".raci-textarea").fill(lines.join("\n"));
  await waitDryRun(page, "invalid");
  assert.equal(await dryRunPill(page).innerText(), "✗ 1 error · routes from last green dry-run".toUpperCase());
  assert.equal(await page.locator("#raci-errnote li").first().innerText(), `line ${errorLine} · route review_backend: unknown field "followups"`);
  assert.equal(await page.locator(".raci-errline").getAttribute("data-line"), String(errorLine));
  assert.equal(await page.locator(".raci-textarea").getAttribute("aria-invalid"), "true");
  assert.equal(await page.locator('[data-raci="propose"]').isDisabled(), true);
  assert.equal(await page.locator("#raci-propose-hint").innerText(), "fix the 1 validation error to propose");
  assert.ok(await page.locator('tr[data-route="strategy"]').count(), "the routes table stays from the last green dry-run");

  // The Routes chip scrolls the textarea to the section; the error band follows the scroll.
  await page.locator('[data-section="followups"]').click();
  const caret = await page.locator(".raci-textarea").evaluate((ta: HTMLTextAreaElement) => ta.value.slice(0, ta.selectionStart).split("\n").length);
  assert.match(lines[caret - 1]!, /^required_followups: /);
  for (let i = 0; i < 12; i += 1) await page.locator('[data-section="roles"]').click();
  const scrolled = await page.locator(".raci-textarea").evaluate((ta) => ta.scrollTop);
  assert.ok(scrolled > 0, "a chip scrolls the textarea");
  await page.locator(".raci-textarea").evaluate((ta, line) => { ta.scrollTop = (line - 4) * 20; ta.dispatchEvent(new Event("scroll")); }, errorLine);
  await page.waitForTimeout(100);
  const band = await page.locator(".raci-errline").boundingBox();
  const code = await page.locator(".raci-code").boundingBox();
  assert.ok(band && code && band.y > code.y && band.y < code.y + 12 + 5 * 20, "the error band sits on its line after a scroll");
  await page.screenshot({ path: join(SHOTS, "fg834-editing-error.png"), fullPage: true });
  assert.deepEqual(errors, []);
  await page.close();
});

test("FG-834: a reload keeps edit mode but not the draft; nothing is stored in the browser; the chips are keyboard-operable", async () => {
  const { page, errors } = await open(routingHash(true));
  await waitDryRun(page, "dry_run_ok");
  const onDisk = readFileSync(overridePath(), "utf8");
  assert.equal(await page.locator(".raci-textarea").inputValue(), onDisk);
  await page.locator(".raci-textarea").fill(`${onDisk}\nunsaved prose\n`);
  await page.locator('.gov-source-actions .raci-pill[data-raci-state="edited"]').waitFor();
  const storage = await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }));
  assert.deepEqual(storage, { local: 0, session: 0 });

  await page.reload();
  await page.locator(".raci-textarea").waitFor();
  assert.match(page.url(), /mode=edit$/);
  assert.equal(await page.locator(".raci-textarea").inputValue(), onDisk, "the unsaved text is gone: a reload reopens the starting candidate");
  assert.equal(await page.locator(".gov-source-actions .raci-pill").getAttribute("data-raci-state"), "unedited");
  assert.match(await page.locator(".raci-reload-hint").innerText(), /a reload reopens the editor on the starting candidate/);

  const chip = page.locator('[data-section="informed"]');
  await chip.focus();
  await page.keyboard.press("Enter");
  const onLine = await page.locator(".raci-textarea").evaluate((ta: HTMLTextAreaElement) => {
    const before = ta.value.slice(0, ta.selectionStart).split("\n");
    return { focused: document.activeElement === ta, line: ta.value.split("\n")[before.length - 1] };
  });
  assert.equal(onLine.focused, true, "the chip moves focus into the textarea");
  assert.match(onLine.line ?? "", /^informed: /);
  assert.equal(await chip.getAttribute("aria-pressed"), "true");

  await page.locator('[data-raci="view"]').focus();
  await page.keyboard.press("Enter");
  await page.waitForURL((url) => !url.hash.includes("mode=edit"));
  await page.locator(".gov-view .gov-table").waitFor();
  assert.equal(await page.locator(".raci-textarea").count(), 0);
  assert.deepEqual(errors, []);
  await page.close();
});

test("FG-834: Reset to host default is the same propose/apply loop over the host text — the override is rewritten, never deleted", async () => {
  const { page, errors } = await open(routingHash(true));
  await waitDryRun(page, "dry_run_ok");
  await page.locator('[data-raci="reset"]').click();
  assert.equal(await page.locator(".raci-textarea").inputValue(), HOST_RACI);
  await page.locator('.gov-source-card:has-text("starting candidate: the host default")').waitFor();
  const row = page.locator('tr[data-route="review_backend"]');
  await row.locator(".raci-tag-changed").waitFor({ timeout: 20_000 });
  assert.match(await row.innerText(), /red-backend \(was backend-specialist\)/);
  await proposeGreen(page);
  assert.match(await page.locator(".raci-diff").innerText(), /^\+ responsible: red-backend$/m);
  await page.locator('[data-raci="confirm-key"]').fill(KEY_HOLDER.key);
  await page.locator('[data-raci="rationale"]').fill("Back to the host default.");
  await applyButton(page).click();
  await page.locator(".raci-applied").waitFor({ timeout: 20_000 });
  assert.ok(existsSync(overridePath()), "never a delete");
  assert.equal(readFileSync(overridePath(), "utf8"), HOST_RACI, "the override now holds the host default's bytes");
  await page.locator('.raci-recorded tbody tr:first-child td:has-text("Back to the host default.")').waitFor({ timeout: 20_000 });
  assert.equal(recordedCalls().filter((argv) => argv[1] === "apply").length, 2);
  assert.deepEqual(errors, []);
  await page.close();
});

test("FG-834: a CLI gate refusal on apply (a weakened host force rule) is shown, never bypassed; an edit after a propose invalidates it", async () => {
  writeFileSync(refuseFlag(), "");
  try {
    const { page, errors } = await open(routingHash(true));
    await waitDryRun(page, "dry_run_ok");
    const before = readFileSync(overridePath(), "utf8");
    await page.locator(".raci-textarea").fill(before.replace(BACKEND_ANCHOR, "responsible: backend-specialist\naccountable: human\npath: invoke"));
    await waitDryRun(page, "dry_run_ok");
    await proposeGreen(page);
    await page.locator('[data-raci="confirm-key"]').fill(KEY_HOLDER.key);
    await page.locator('[data-raci="rationale"]').fill("Try the specialist.");
    await applyButton(page).click();
    const failure = page.locator(".raci-apply .raci-result-fail");
    await failure.waitFor({ timeout: 20_000 });
    const text = await failure.innerText();
    assert.match(text, /APPLY REFUSED · EXIT 1 · GATE_FAILED/i);
    assert.match(text, /\[force_rule_weakened\] \[route: review_backend\] the candidate drops host force rule "no-self-review"/);
    assert.equal(readFileSync(overridePath(), "utf8"), before, "nothing was written");
    assert.equal(await page.locator(".raci-applied").count(), 0);

    // Any edit after the propose: back to "edited · not proposed", the proposal superseded, Apply disabled.
    await page.locator(".raci-textarea").press("End");
    await page.locator(".raci-textarea").type(" ");
    await page.locator('.gov-source-actions .raci-pill[data-raci-state="edited"]').waitFor();
    assert.equal(await page.locator(".raci-proposal .raci-pill").getAttribute("data-raci-state"), "superseded");
    assert.equal(await applyButton(page).isDisabled(), true);
    assert.match(await page.locator(".raci-apply-reason").innerText(), /propose this exact candidate first/);

    assert.deepEqual(errors, []);
    await page.close();
  } finally {
    rmSync(refuseFlag(), { force: true });
  }
});
