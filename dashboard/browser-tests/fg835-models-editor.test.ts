// FG-835 part 2b: Setup › Models, in a real browser against the REAL dashboard server
// (GET /api/model-policy, POST /api/model-policy/propose|apply) over a scratch FORGE_HOME
// carrying every seed role and the seed runtimes as a published generation, so the gate
// validates exactly as it does on a host, plus a registered git checkout.
//
// `forge` is a recording shim (FORGE_BIN): it logs every argv and execs the real
// `bin/forge`, so the gate, the resolution diff, the atomic write, the backup and the
// audit line are the CLI's own.
//
// Screenshots go to a fresh temp dir unless FG835_SCREENSHOT_DIR names one.

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

const SHOTS = process.env.FG835_SCREENSHOT_DIR ?? mkdtempSync(join(tmpdir(), "fg835-screenshots-"));

const TEST_PORT = 18843;
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = realpathSync(resolve(HERE, "..", ".."));
const REAL_FORGE = join(REPO_ROOT, "bin", "forge");
const SEEDS = join(REPO_ROOT, "seeds");

const policy = (opts: { defaultModel?: string; extraProfile?: string } = {}) => [
  "schema_version: 2",
  "# the operator's own note — quick edit keeps it",
  "on_unavailable: fail",
  "model_profiles:",
  "  default:",
  "    provider: anthropic",
  "    auth: subscription",
  "    map:",
  `      default: { model: ${opts.defaultModel ?? "claude-opus-5-5"}, cost_tier: premium }`,
  "      review: { model: claude-opus-5-5, cost_tier: premium, effort: low }",
  "      design: { model: claude-fable-5-1, cost_tier: premium }",
  "  spec-writer:",
  "    provider: anthropic",
  "    auth: subscription",
  "    map:",
  "      default: { model: claude-opus-5-5, cost_tier: premium }",
  "      reasoning: { model: claude-opus-5-5, cost_tier: premium }",
  "  fast-orchestrator:",
  "    provider: anthropic",
  "    auth: subscription",
  "    map:",
  "      default: { model: claude-haiku-4-5-20251001, cost_tier: cheap }",
  ...(opts.extraProfile ? [opts.extraProfile] : []),
  "defaults:",
  "  profile: default",
  "  activity: {}",
  "overrides:",
  "  agents:",
  "    architecture-advisor: spec-writer",
  "",
].join("\n");

const FIRST = policy({ defaultModel: "claude-sonnet-5" });
const START = policy();
const REVIEW_ONLY = "  review-only:\n    provider: anthropic\n    auth: subscription\n    map:\n      review: { model: claude-sonnet-5, cost_tier: standard }";
const RIG: { home: string; forgeHome: string; key: string; dir: string; rig: string } = { home: "", forgeHome: "", key: "", dir: "", rig: "" };

let browser: Browser | undefined;
let server: Server | undefined;

const hostPolicy = () => join(RIG.forgeHome, "model-policy.yml");
const projectPolicy = () => join(RIG.dir, ".forge", "model-policy.yml");

function recordedCalls(): string[][] {
  const calls: string[][] = [];
  for (const line of readFileSync(join(RIG.rig, "calls.log"), "utf8").split("\n")) {
    if (line === "CALL") calls.push([]);
    else if (line.startsWith("ARG\t")) calls[calls.length - 1]?.push(line.slice(4));
  }
  return calls;
}
const applies = () => recordedCalls().filter((argv) => argv[2] === "apply");

before(async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "fg835-models-editor-")));
  const forgeHome = join(home, ".forge");
  mkdirSync(forgeHome, { recursive: true });
  process.env.HOME = home;
  process.env.FORGE_HOME = forgeHome;
  process.env.FORGE_DB_PATH = join(forgeHome, "forge.db");
  process.env.FORGE_PROJECT_SCAN_ROOTS = mkdtempSync(join(tmpdir(), "fg835-scan-"));
  process.env.PORT = String(TEST_PORT);
  process.env.HOST = "127.0.0.1";
  delete process.env.FORGE_DASHBOARD_ALLOW_REMOTE_MUTATIONS;
  delete process.env.FORGE_DASHBOARD_ORIGIN;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.CLAUDE_CODE_USE_BEDROCK;
  delete process.env.AWS_PROFILE;

  // The host the gate validates against: every seed role installed, the seed runtimes
  // published as the current generation.
  for (const role of readdirSync(join(SEEDS, "agents"))) {
    const seed = join(SEEDS, "agents", role, "CLAUDE.md");
    if (!existsSync(seed)) continue;
    mkdirSync(join(forgeHome, "agents", role), { recursive: true });
    copyFileSync(seed, join(forgeHome, "agents", role, "CLAUDE.md"));
  }
  mkdirSync(join(forgeHome, "runtimes"), { recursive: true });
  for (const rt of readdirSync(join(SEEDS, "runtimes"))) copyFileSync(join(SEEDS, "runtimes", rt), join(forgeHome, "runtimes", rt));
  const { publishFlatAsGeneration } = await import("../../src/v2/seed-generation.testkit.js");
  publishFlatAsGeneration(forgeHome);

  const projectDir = join(home, "code", "atlas");
  mkdirSync(projectDir, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: projectDir, stdio: "ignore" });
  execFileSync("git", ["remote", "add", "origin", "git@github.com:stevebargelt/fg835-atlas.git"], { cwd: projectDir, stdio: "ignore" });
  const dir = realpathSync(projectDir);
  const { getDb, writeTransaction } = await import("../../src/store/db.js");
  const { repositoryCheckoutIdentity } = await import("../../src/util/repository-identity.js");
  writeTransaction(() => {
    getDb()
      .prepare(`INSERT INTO runs (id, workflow, title, status, created_at, project_dir) VALUES (?,?,?,?,?,?)`)
      .run("run-835", "feature", "models editor fixture", "complete", "2026-09-30T07:00:00Z", dir);
  });

  // The host file's history, from a terminal: a first file, then the starting policy
  // applied over it — one backup and one `cli` audit line before the page ever opens.
  writeFileSync(join(forgeHome, "model-policy.yml"), FIRST);
  const seedFile = join(home, "start.yml");
  writeFileSync(seedFile, START);
  execFileSync(REAL_FORGE, ["model", "policy", "apply", seedFile, "--confirm", "--json"], { env: process.env, stdio: "ignore" });

  const rig = mkdtempSync(join(tmpdir(), "fg835-rig-"));
  const shim = join(rig, "forge");
  writeFileSync(join(rig, "calls.log"), "");
  writeFileSync(shim, [
    "#!/bin/sh",
    `{ printf 'CALL\\n'; for a in "$@"; do printf 'ARG\\t%s\\n' "$a"; done; } >> "${join(rig, "calls.log")}"`,
    `exec "${REAL_FORGE}" "$@"`,
  ].join("\n"));
  chmodSync(shim, 0o755);
  process.env.FORGE_BIN = shim;
  Object.assign(RIG, { home, forgeHome, key: repositoryCheckoutIdentity(dir).key, dir, rig });

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

async function open(hash: string, width = 1400): Promise<{ page: Page; errors: string[] }> {
  const page = await browser!.newPage({ viewport: { width, height: 1000 }, reducedMotion: "reduce" });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${BASE}/${hash}`);
  await page.locator(".app-shell").waitFor();
  return { page, errors };
}

const scoped = (extra = "") => `#models?project=${encodeURIComponent(RIG.key)}&checkout=${encodeURIComponent(RIG.dir)}${extra}`;
const editorPill = (page: Page) => page.locator('.raci-pane:first-child .raci-label-row .raci-pill');
const textarea = (page: Page) => page.locator(".raci-textarea");
const modelSelect = (page: Page, profile: string, alias: string) => page.locator(`.mp-quick-row[data-profile="${profile}"][data-alias="${alias}"] select`);
const resolutionRow = (page: Page, role: string, activity: string) => page.locator(`.mp-resolution tr[data-role="${role}"][data-activity="${activity}"]`);
const applyButton = (page: Page) => page.locator('[data-raci="apply"]');

async function waitEditor(page: Page, state: "dry_run_ok" | "invalid"): Promise<void> {
  await page.locator(`.raci-pane:first-child .raci-label-row .raci-pill[data-raci-state="${state}"]`).waitFor({ timeout: 30_000 });
}
async function proposeGreen(page: Page): Promise<void> {
  await page.locator('[data-mp="propose"]:not([disabled])').waitFor({ timeout: 30_000 });
  await page.locator('[data-mp="propose"]').click();
  await page.locator('.mp-proposal .raci-pill[data-raci-state="gate_passed"]').waitFor({ timeout: 30_000 });
}

test("FG-835: quick edit one profile's model → the resolution diff → Apply refused without the typed target → applied with it; the table, Harness and the audit tail re-read", async () => {
  const { page, errors } = await open("#models");
  await page.locator(".mp-source").waitFor();
  const source = await page.locator(".mp-source").innerText();
  assert.ok(source.includes(realpathSync(hostPolicy())), "the source line names the host file");
  assert.match(source, /schema_version 2 · 3 profiles · \d+ roles resolved/);
  assert.match(source, /target of an apply from here:\s*host/);
  assert.match(await resolutionRow(page, "architecture-advisor", "reasoning").innerText(), /spec-writer\s+claude-opus-5-5/);
  assert.match(await page.locator(".mp-recorded tbody tr").first().innerText(), /\bcli\b/);
  assert.equal(await page.locator(".mp-backups tbody tr").count(), 1);
  assert.equal(await textarea(page).count(), 0, "view mode has no editor");

  const edit = page.locator('[data-mp="edit"]');
  await edit.focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction((re) => new RegExp(re).test(location.hash), /mode=edit/.source);
  await waitEditor(page, "dry_run_ok");
  assert.equal(await textarea(page).evaluate((ta) => ta.tagName), "TEXTAREA");
  assert.equal(await textarea(page).inputValue(), START, "the editor opens on the policy in force");
  assert.equal(await page.locator('.mp-policy-label .raci-pill').getAttribute("data-raci-state"), "unedited");

  await modelSelect(page, "spec-writer", "reasoning").selectOption("claude-fable-5-1");
  const edited = START.replace("      reasoning: { model: claude-opus-5-5, cost_tier: premium }", "      reasoning: { model: claude-fable-5-1, cost_tier: premium }");
  assert.notEqual(edited, START);
  assert.equal(await textarea(page).inputValue(), edited, "quick edit rewrote exactly that line of the YAML");
  await page.locator('.mp-policy-label .raci-pill[data-raci-state="edited"]').waitFor();
  assert.match(await page.locator(".mp-policy-label .raci-pill").innerText(), /EDITED · NOT PROPOSED/i);
  await page.locator('.mp-quick-row[data-profile="spec-writer"][data-alias="reasoning"] .raci-tag-changed').waitFor();
  const changed = resolutionRow(page, "architecture-advisor", "reasoning");
  await changed.locator(".mp-tag-changed").waitFor({ timeout: 30_000 });
  assert.match(await changed.innerText(), /claude-fable-5-1\s+was claude-opus-5-5/);
  assert.equal(await page.locator('.raci-pill[data-raci-state="last_green"]').count(), 1);
  await waitEditor(page, "dry_run_ok");
  await page.screenshot({ path: join(SHOTS, "fg835-quick-edit.png"), fullPage: true });

  await proposeGreen(page);
  assert.match(await page.locator(".mp-proposal .raci-pill").innerText(), /GATE PASSED · CANDIDATE [0-9a-f]{8} · 1[45] MIN LEFT/i);
  assert.match(await page.locator(".mp-summary").innerText(), /~1 resolution changed/);
  assert.match(await page.locator(".mp-summary").innerText(), /runtime seeds: all present · auth: every profile satisfiable on this host/);
  const diff = page.locator(".mp-diff tbody tr");
  assert.equal(await diff.count(), 1);
  assert.equal(await diff.first().innerText(), "architecture-advisor · reasoning\tspec-writer → claude-opus-5-5 · subscription · claude-oauth · tier premium\tspec-writer → claude-fable-5-1 · subscription · claude-oauth · tier premium");
  assert.match(await page.locator(".raci-apply").innerText(), /Type the target to confirm · host/);
  assert.match(await page.locator(".raci-apply .hint").innerText(), /shells forge model policy apply <candidate> --confirm --by dashboard --source dashboard --rationale … · re-runs the gate before writing · never --allow-undispatchable/);

  const rationale = "Architecture plans go to the deeper model; spec-writer profile only.";
  await page.locator('[data-raci="rationale"]').fill(rationale);
  await page.locator('[data-raci="confirm-key"]').fill("ho");
  assert.equal(await applyButton(page).isDisabled(), true);
  assert.match(await page.locator(".raci-apply-reason").innerText(), /type the target exactly/);
  const direct = await page.evaluate(async (candidate) => {
    const res = await fetch("/api/model-policy/apply", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: "host", candidate, proposedSha256: "x", confirmKey: "ho", rationale: "why" }),
    });
    return { status: res.status, body: await res.json() };
  }, edited);
  assert.equal(direct.status, 400);
  assert.equal(direct.body.refusal, "confirm_key_mismatch");
  assert.equal(applies().length, 0, "nothing was applied without the typed target");
  await page.screenshot({ path: join(SHOTS, "fg835-proposed.png"), fullPage: true });

  await page.locator('[data-raci="confirm-key"]').fill("host");
  assert.equal(await applyButton(page).isDisabled(), false);
  await applyButton(page).click();
  await page.locator(".mp-applied").waitFor({ timeout: 30_000 });
  await page.waitForFunction(() => location.hash === "#models");
  const applied = await page.locator(".mp-applied").innerText();
  assert.match(applied, /APPLIED · EXIT 0/i);
  assert.ok(applied.includes(`Applied model policy -> ${realpathSync(hostPolicy())}`));
  assert.match(applied, /Previous file kept as .*model-policy\.yml\.bak-/);
  assert.match(applied, /Resolution changes: ~1 resolution \(architecture-advisor · reasoning\)/);
  assert.equal(readFileSync(hostPolicy(), "utf8"), edited, "the CLI wrote exactly the proposed bytes");

  await resolutionRow(page, "architecture-advisor", "reasoning").locator('td:has-text("claude-fable-5-1")').waitFor({ timeout: 30_000 });
  const newest = page.locator(".mp-recorded tbody tr").first();
  await newest.locator('td:has-text("dashboard")').waitFor({ timeout: 30_000 });
  assert.match(await newest.innerText(), /\d{4}-\d{2}-\d{2} \d{2}:\d{2}Z\s+dashboard\s+~1 resolution \(architecture-advisor · reasoning\)\s+Architecture plans go to the deeper model/);
  assert.equal(await page.locator(".mp-backups tbody tr").count(), 2, "the replaced file is kept as a backup");
  const apply = applies();
  assert.equal(apply.length, 1);
  assert.deepEqual([apply[0]![0], apply[0]![1], apply[0]![2], ...apply[0]!.slice(4)], ["model", "policy", "apply", "--confirm", "--by", "dashboard", "--source", "dashboard", "--rationale", rationale, "--json"]);
  assert.ok(recordedCalls().every((argv) => !argv.includes("--allow-undispatchable") && !argv.includes("--force")));
  await page.screenshot({ path: join(SHOTS, "fg835-applied.png"), fullPage: true });

  await resolutionRow(page, "architecture-advisor", "reasoning").locator(".mp-role-link").click();
  await page.waitForFunction((re) => new RegExp(re).test(location.hash), /#roles\/architecture-advisor\/harness/.source);
  const harness = page.locator(".role-harness-table");
  await harness.waitFor({ timeout: 30_000 });
  await harness.locator('td:has-text("claude-fable-5-1")').waitFor({ timeout: 30_000 });
  assert.deepEqual(errors, []);
  await page.close();
});

test("FG-835: a validation error is shown inline by line; Propose is disabled and the table keeps the last green resolution", async () => {
  const { page, errors } = await open("#models?mode=edit");
  await waitEditor(page, "dry_run_ok");
  const lines = (await textarea(page).inputValue()).split("\n");
  const at = lines.indexOf("  spec-writer:") + 2;
  assert.equal(lines[at], "    auth: subscription");
  lines.splice(at + 1, 0, "    runtime: claude-cod");
  await textarea(page).fill(lines.join("\n"));
  await waitEditor(page, "invalid");
  assert.equal(await editorPill(page).innerText(), "✗ 1 ERROR");
  const note = await page.locator("#raci-errnote li").first().innerText();
  assert.match(note, new RegExp(`^line ${at + 2} · profile 'spec-writer' needs runtime 'claude-cod', which the current seed generation .* does not carry`));
  assert.equal(await page.locator(".raci-errline").getAttribute("data-line"), String(at + 2));
  assert.equal(await textarea(page).getAttribute("aria-invalid"), "true");
  assert.equal(await page.locator('[data-mp="propose"]').isDisabled(), true);
  assert.equal(await page.locator("#mp-propose-hint").innerText(), "fix the 1 validation error to propose");
  assert.equal(await page.locator('.raci-pill[data-raci-state="last_green"]').count(), 1, "the resolution stays from the last green dry-run");
  await page.screenshot({ path: join(SHOTS, "fg835-editing-error.png"), fullPage: true });
  assert.deepEqual(errors, []);
  await page.close();
});

test("FG-835: an undispatchable candidate is refused as the CLI returns it — placed on the override's line, the proposal superseded, Apply disabled", async () => {
  const { page, errors } = await open("#models?mode=edit");
  await waitEditor(page, "dry_run_ok");
  const onDisk = readFileSync(hostPolicy(), "utf8");
  const withProfile = onDisk.replace("defaults:\n", `${REVIEW_ONLY}\ndefaults:\n`);
  await textarea(page).fill(withProfile);
  await waitEditor(page, "dry_run_ok");
  await proposeGreen(page);
  assert.equal(await page.locator(".mp-diff tbody tr").innerText(), "(no resolution change)");

  await page.locator('[data-mp="add-override"]').selectOption("engineer");
  await page.locator('.mp-quick-row[data-role="engineer"] select').waitFor();
  assert.match(await textarea(page).inputValue(), /^ {4}engineer: default$/m, "+ add a role override pins the role to the default profile");
  await page.locator('.mp-quick-row[data-role="engineer"] select').selectOption("review-only");
  const text = await textarea(page).inputValue();
  assert.match(text, /^ {4}engineer: review-only$/m);
  await waitEditor(page, "invalid");
  const note = await page.locator("#raci-errnote li").first().innerText();
  assert.ok(note.startsWith(`line ${text.split("\n").indexOf("    engineer: review-only") + 1} · role 'engineer' becomes undispatchable for its default activity 'default': profile 'review-only' has no mapping for capability 'default'`), note);
  assert.ok(note.endsWith("Pass --allow-undispatchable to accept this."), "the CLI's own refusal, word for word");
  assert.equal(await page.locator(".mp-proposal .raci-pill").getAttribute("data-raci-state"), "superseded");
  assert.equal(await page.locator('[data-mp="propose"]').isDisabled(), true);
  await page.locator('[data-raci="confirm-key"]').fill("host");
  await page.locator('[data-raci="rationale"]').fill("try it");
  assert.equal(await applyButton(page).isDisabled(), true);
  assert.match(await page.locator(".raci-apply-reason").innerText(), /propose this exact candidate first/);

  const direct = await page.evaluate(async (candidate) => {
    const res = await fetch("/api/model-policy/propose", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ target: "host", candidate }) });
    return { status: res.status, body: await res.json() };
  }, text);
  assert.equal(direct.status, 409);
  assert.equal(direct.body.refusal, "gate_failed");
  assert.match(direct.body.error, /\[default_undispatchable\] role 'engineer' becomes undispatchable/);
  assert.equal(readFileSync(hostPolicy(), "utf8"), onDisk, "nothing was written");
  assert.ok(recordedCalls().every((argv) => !argv.includes("--allow-undispatchable")), "the dashboard never passes --allow-undispatchable");
  await page.screenshot({ path: join(SHOTS, "fg835-undispatchable.png"), fullPage: true });
  assert.deepEqual(errors, []);
  await page.close();
});

test("FG-835: Restore… loads a backup as the candidate and proposes it — then the same typed-target apply; never a file copy", async () => {
  const { page, errors } = await open("#models");
  const newest = page.locator(".mp-backups tbody tr").first();
  await newest.waitFor();
  const name = (await newest.getAttribute("data-backup"))!;
  const backup = readFileSync(join(RIG.forgeHome, name), "utf8");
  assert.equal(backup, START, "the newest backup is the file the first apply replaced");
  const listed = await page.evaluate(async () => (await (await fetch("/api/model-policy")).json()).backups.entries);
  assert.ok(listed.every((b: Record<string, unknown>) => !("text" in b)), "the list carries no backup's content");
  const backupReads: string[] = [];
  page.on("request", (req) => { if (req.url().includes("/api/model-policy?") && req.url().includes("backup=")) backupReads.push(new URL(req.url()).searchParams.get("backup")!); });
  await newest.locator('[data-mp="restore"]').click();
  await page.waitForFunction((re) => new RegExp(re).test(location.hash), /mode=edit/.source);
  await page.locator('.mp-proposal .raci-pill[data-raci-state="gate_passed"]').waitFor({ timeout: 30_000 });
  assert.deepEqual(backupReads, [name], "Restore… reads exactly the one backup it restores");
  assert.equal(await textarea(page).inputValue(), backup);
  assert.match(await page.locator(".raci-reload-hint").innerText(), new RegExp(`starting candidate: backup ${name.replace(/\./g, "\\.")}`));
  assert.equal(await page.locator(".mp-diff tbody tr").first().innerText(), "architecture-advisor · reasoning\tspec-writer → claude-fable-5-1 · subscription · claude-oauth · tier premium\tspec-writer → claude-opus-5-5 · subscription · claude-oauth · tier premium");
  await page.locator('[data-raci="confirm-key"]').fill("host");
  await page.locator('[data-raci="rationale"]').fill("Back to the previous policy.");
  await applyButton(page).click();
  await page.locator(".mp-applied").waitFor({ timeout: 30_000 });
  assert.equal(readFileSync(hostPolicy(), "utf8"), backup, "the host file now holds the backup's bytes");
  await page.locator('.mp-recorded tbody tr:first-child td:has-text("Back to the previous policy.")').waitFor({ timeout: 30_000 });
  assert.equal(await page.locator(".mp-backups tbody tr").count(), 3);
  assert.equal(applies().length, 2, "a restore is an apply through the gate");
  assert.deepEqual(errors, []);
  await page.close();
});

test("FG-835: a backup larger than a candidate may be shows Restore… disabled with its size and the limit; the server refuses to read it", async () => {
  const name = "model-policy.yml.bak-2000-01-01T00:00:00.000Z";
  const path = join(RIG.forgeHome, name);
  writeFileSync(path, `# ${"x".repeat(70 * 1024)}\n`);
  try {
    const { page, errors } = await open("#models");
    const row = page.locator(`.mp-backups tbody tr[data-backup="${name}"]`);
    await row.waitFor();
    assert.equal(await row.locator('[data-mp="restore"]').isDisabled(), true);
    const reason = await row.locator(".mp-restore-blocked").innerText();
    assert.match(reason, /^70\.0 KB is over the 64\.0 KB a candidate may be — restore it from a terminal$/);
    assert.equal(await row.locator('[data-mp="restore"]').getAttribute("title"), reason);
    const direct = await page.evaluate(async (n) => (await fetch(`/api/model-policy?backup=${encodeURIComponent(n)}`)).status, name);
    assert.equal(direct, 413);
    await page.screenshot({ path: join(SHOTS, "fg835-backup-oversized.png"), fullPage: true });
    assert.deepEqual(errors, []);
    await page.close();
  } finally {
    rmSync(path, { force: true });
  }
});

test("FG-835: a reload keeps edit mode but not the draft; nothing is stored in the browser; Config links here", async () => {
  const { page, errors } = await open("#models?mode=edit");
  await waitEditor(page, "dry_run_ok");
  const onDisk = readFileSync(hostPolicy(), "utf8");
  assert.equal(await textarea(page).inputValue(), onDisk);
  await textarea(page).fill(`${onDisk}# unsaved\n`);
  await page.locator('.mp-policy-label .raci-pill[data-raci-state="edited"]').waitFor();
  assert.deepEqual(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length })), { local: 0, session: 0 });
  await page.reload();
  await textarea(page).waitFor();
  assert.match(page.url(), /#models\?mode=edit$/);
  assert.equal(await textarea(page).inputValue(), onDisk, "a reload reopens the starting candidate");
  assert.equal(await page.locator(".mp-policy-label .raci-pill").getAttribute("data-raci-state"), "unedited");
  assert.match(await page.locator(".raci-reload-hint").innerText(), /starting candidate: the policy in force · Unsaved edits live only in this page: a reload reopens the editor on the starting candidate\./);

  await page.locator('[data-mp="view"]').click();
  await page.waitForFunction(() => location.hash === "#models");
  await page.goto(`${BASE}/#config?project=${encodeURIComponent(RIG.key)}&checkout=${encodeURIComponent(RIG.dir)}`);
  const link = page.locator('#cp-row-model-policy a[data-cp="models"]');
  await link.waitFor({ timeout: 30_000 });
  assert.equal(await link.getAttribute("href"), `#models?project=${encodeURIComponent(RIG.key)}`, "FG-843: #models carries the project; the checkout rides only on Routing, Config and Notes");
  assert.deepEqual(errors, []);
  await page.close();
});

test("FG-835: keyboard only at 400px — switch the target to a project override, quick edit, propose, type the project key, apply", async () => {
  const { page, errors } = await open(scoped(), 400);
  await page.locator(".mp-source").waitFor();
  assert.match(await page.locator(".mp-target").innerText(), /target of an apply from here:\s*host\s*·\s*write a project override for .* instead/);
  const toProject = page.locator('[data-mp="target-project"]');
  await toProject.focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction((re) => new RegExp(re).test(location.hash), /target=project/.source);
  await page.locator('.mp-target[data-target="project"]').waitFor();
  assert.ok((await page.locator(".mp-target").innerText()).includes(RIG.key));

  await page.locator('[data-mp="edit"]').focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction((re) => new RegExp(re).test(location.hash), /mode=edit&target=project/.source);
  await waitEditor(page, "dry_run_ok");
  const select = modelSelect(page, "fast-orchestrator", "default");
  await select.focus();
  const before = await select.inputValue();
  const optionsBefore = await select.locator("option").allTextContents();
  await page.keyboard.press("ArrowDown");
  await page.locator('.mp-quick-row[data-profile="fast-orchestrator"][data-alias="default"] .raci-tag-changed').waitFor();
  const chosen = await select.inputValue();
  assert.notEqual(chosen, before, "the picker is operable from the keyboard");
  const optionsAfter = await select.locator("option").allTextContents();
  assert.ok(optionsAfter.includes(before), `the prior model ${before} stays offered after the change`);
  assert.deepEqual(optionsAfter, optionsBefore, "a change neither drops an option nor reorders the list");
  await page.keyboard.press("ArrowUp");
  await page.waitForFunction(() => !document.querySelector('.mp-quick-row[data-profile="fast-orchestrator"][data-alias="default"] .raci-tag-changed'));
  assert.equal(await select.inputValue(), before, "the operator can step back to the prior model");
  await waitEditor(page, "dry_run_ok");
  await page.keyboard.press("ArrowDown");
  await page.locator('.mp-quick-row[data-profile="fast-orchestrator"][data-alias="default"] .raci-tag-changed').waitFor();
  assert.equal(await select.inputValue(), chosen);
  assert.match(await textarea(page).inputValue(), new RegExp(`default: \\{ model: ${chosen.replace(/[.]/g, "\\.")}, cost_tier: cheap \\}`));
  await waitEditor(page, "dry_run_ok");

  await page.locator('[data-mp="propose"]').focus();
  await page.keyboard.press("Enter");
  await page.locator('.mp-proposal .raci-pill[data-raci-state="gate_passed"]').waitFor({ timeout: 30_000 });
  assert.match(await page.locator(".raci-apply").innerText(), new RegExp(`Type the target to confirm · ${RIG.key}`));
  assert.ok((await page.locator(".raci-apply .hint").innerText()).includes(`--project ${RIG.dir} --confirm --by dashboard`));
  await page.locator('[data-raci="confirm-key"]').focus();
  await page.keyboard.type(RIG.key);
  await page.keyboard.press("Tab");
  await page.keyboard.type("Atlas runs its fast profile on another model.");
  await applyButton(page).focus();
  assert.equal(await applyButton(page).isDisabled(), false);
  await page.keyboard.press("Enter");
  await page.locator(".mp-applied").waitFor({ timeout: 30_000 });
  assert.ok(existsSync(projectPolicy()), "the project override was written");
  assert.match(readFileSync(projectPolicy(), "utf8"), new RegExp(`model: ${chosen.replace(/[.]/g, "\\.")}, cost_tier: cheap`));
  assert.match(await page.locator(".mp-source").innerText(), /project/);
  assert.ok((await page.locator(".mp-source").innerText()).includes(realpathSync(projectPolicy())));
  const last = applies().at(-1)!;
  assert.deepEqual(last.slice(4, 6), ["--project", RIG.dir]);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false, "no horizontal page overflow at 400px");
  assert.deepEqual(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length })), { local: 0, session: 0 });
  await page.screenshot({ path: join(SHOTS, "fg835-keyboard-400px.png"), fullPage: true });
  assert.deepEqual(errors, []);
  await page.close();
});

test("FG-835: a resolution row's role link opens its Harness tab under the scope the row was resolved at — the project override's, or unscoped for the host file", async () => {
  // A project override that pins architecture-advisor to another profile than the host file does.
  writeFileSync(projectPolicy(), policy().replace("    architecture-advisor: spec-writer", "    architecture-advisor: fast-orchestrator"));
  const { page, errors } = await open(scoped("&target=project"));
  const row = resolutionRow(page, "architecture-advisor", "reasoning");
  await row.locator('td:text-is("claude-haiku-4-5-20251001")').waitFor({ timeout: 30_000 });
  const scopedHash = `#roles/architecture-advisor/harness?project=${encodeURIComponent(RIG.key)}&checkout=${encodeURIComponent(RIG.dir)}`;
  assert.equal(await row.locator(".mp-role-link").getAttribute("href"), scopedHash);
  await row.locator(".mp-role-link").click();
  await page.waitForFunction((h) => location.hash === h, scopedHash);
  const model = page.locator('.role-harness-table tr[data-activity="reasoning"] td[data-col="model"]');
  await model.waitFor({ timeout: 30_000 });
  assert.equal(await model.innerText(), "claude-haiku-4-5-20251001", "the Harness tab re-reads the same project override the row came from");
  await page.reload();
  await page.locator('.role-harness-table tr[data-activity="reasoning"] td[data-col="model"]').waitFor({ timeout: 30_000 });
  assert.equal(await model.innerText(), "claude-haiku-4-5-20251001", "the scope rides the hash, so a reload or a shared link reads the same policy");

  // The host file, viewed under the same project scope: its rows are unscoped, and so is the link.
  await page.goto(`${BASE}/${scoped("&target=host")}`);
  const hostRow = resolutionRow(page, "architecture-advisor", "reasoning");
  await hostRow.locator('td:text-is("claude-opus-5-5")').waitFor({ timeout: 30_000 });
  assert.equal(await hostRow.locator(".mp-role-link").getAttribute("href"), "#roles/architecture-advisor/harness");
  await hostRow.locator(".mp-role-link").click();
  await page.waitForFunction(() => location.hash === "#roles/architecture-advisor/harness");
  await page.locator('.role-harness-table tr[data-activity="reasoning"] td[data-col="model"]:text-is("claude-opus-5-5")').waitFor({ timeout: 30_000 });
  await page.screenshot({ path: join(SHOTS, "fg835-harness-scoped.png"), fullPage: true });
  assert.deepEqual(errors, []);
  await page.close();
});
