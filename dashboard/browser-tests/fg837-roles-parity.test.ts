// FG-837: the Roles list and a role page laid out after Paperclip (the approved
// roles-mock / role-page-mock), in a real browser — the list's row shape (36px tile, name
// over a one-line subtitle, mono model over profile, family · activity, relative time, mount
// pill) with no row past two text lines; the family filter tabs filtering client-side and
// riding the hash beside FG-828's sort; the role page's grouped left sub-nav at 900px and
// wider collapsing to the FG-817 tablist under it; keyboard reach of family tabs, sort
// headers and sub-nav entries; and computed AA contrast on every new text element.
//
// The fixture is the mock's own 23 roles (same descriptions, models and last-task times),
// so a screenshot here and the mock at the same viewport compare like for like.
// Screenshots go to a fresh temp dir unless FG837_SCREENSHOT_DIR names one.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import { renderShell } from "../src/shell.js";
import { CHROME_LAUNCH_ARGS, requireChrome } from "../../src/util/chrome-bin.js";

const PORT = 18842;
const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = realpathSync(resolve(HERE, "..", "client"));
const SHOTS = process.env.FG837_SCREENSHOT_DIR ?? mkdtempSync(join(tmpdir(), "fg837-screenshots-"));
mkdirSync(SHOTS, { recursive: true });

const HOUR = 3_600_000;
const ago = (hours: number) => new Date(Date.now() - hours * HOUR).toISOString();
const GEN = { id: "gen-vkdg0z2acl", root: "/h/seed-generations/gen-vkdg0z2acl", sourceAssetRoot: "/h/releases/r1" };
const PROTOCOL_SHA = "487dd8acab33" + "0".repeat(52);

// [role, description, default activity, profile, model, mount, last task] — roles-mock.html's data.
const MOCK_ROLES: Array<[string, string, string, string, string, string, string | null]> = [
  ["agentic-platform-builder", "You are a full-stack engineer for cross-cutting platform work. You implement plan steps that touch multiple layers at once \u2014 frontend AND ba", "default", "claude-subscription", "claude-opus-5-5", "rw", "2026-09-08T18:47:24.116Z"],
  ["architecture-advisor", "You are a **systems architect**. Your job is to surface what would make a feature hard, slow, expensive, or impossible \u2014 and to decide where", "reasoning", "claude-subscription", "claude-opus-5-5", "rw", "2026-09-09T02:56:12.971Z"],
  ["backend-specialist", "You implement the plan, one step at a time, in the mounted /project directory \u2014 through a backend lens. You write server-side code: API hand", "default", "claude-subscription", "claude-opus-5-5", "rw", "2026-09-09T04:00:34.893Z"],
  ["documentation-maintainer", "You are the docs analog of the engineer. You maintain operator-facing durable documentation so it stays *true* as the system changes. You wo", "default", "claude-sonnet-subscription", "claude-sonnet-5", "rw", "2026-09-29T15:59:32.927Z"],
  ["engineer", "You implement the plan, one step at a time, in the mounted /project directory. Use --dangerously-skip-permissions for shell access; the cont", "default", "claude-subscription", "claude-opus-5-5", "rw", "2026-09-29T15:25:58.192Z"],
  ["frontend-specialist", "You implement the plan, one step at a time, in the mounted /project directory \u2014 through a frontend lens. You write HTML / CSS / TS / framewo", "default", "claude-subscription", "claude-opus-5-5", "rw", "2026-09-08T22:17:36.418Z"],
  ["manual-qa", "You are an exploratory tester. You act like a real user: open the app, click through flows, try edge cases, and report what breaks. Your out", "default", "claude-subscription", "claude-opus-5-5", "rw", "2026-08-10T02:25:00.880Z"],
  ["prompt-author", "You are a prompt author. Your job is to interview the human and produce a `PROMPT.md` file that will seed a `forge design` session \u2014 typical", "design", "claude-subscription", "claude-opus-5-5", "rw", "2026-05-28T19:28:32.684Z"],
  ["red-backend", "You are a backend-specialist red auditor. You read the artifact under review with default disbelief through a backend lens \u2014 transaction saf", "review", "codex-subscription", "gpt-5.6-terra", "ro", "2026-09-29T15:58:34.937Z"],
  ["red-frontend", "You are a frontend-specialist red auditor. You read the artifact under review with default disbelief through a frontend lens \u2014 accessibility", "review", "codex-subscription", "gpt-5.6-terra", "ro", "2026-09-29T15:58:34.955Z"],
  ["red-narrow", "You are a narrow-aperture red auditor. You receive one or more anti-prompts as `failureModes` in your task package; your job is to demonstra", "review", "codex-subscription", "gpt-5.6-terra", "ro", "2026-09-09T03:05:25.486Z"],
  ["red-security", "You are a security-specialist red auditor. You read the artifact under review with default disbelief through a security lens \u2014 auth flows, s", "review", "codex-subscription", "gpt-5.6-terra", "ro", "2026-09-29T15:58:34.964Z"],
  ["red-wide", "You are a wide-aperture red auditor. You read the artifact under review with default disbelief and look for the assumption that is wrong, th", "review", "codex-subscription", "gpt-5.6-terra", "ro", "2026-09-29T15:58:34.974Z"],
  ["research-framer", "You are a research framer. You receive a research question and decompose it into 3-7 concrete, independently researchable lanes (claims). Ea", "default", "claude-subscription", "claude-opus-5-5", "rw", "2026-06-21T23:35:58.012Z"],
  ["research-primary", "You are a supporting-evidence researcher. Your role is to find concrete evidence that SUPPORTS a specific claim. You search thoroughly and r", "default", "claude-subscription", "claude-opus-5-5", "rw", "2026-06-21T23:37:37.663Z"],
  ["research-skeptic", "You are a counter-evidence researcher. Your role is to find concrete evidence that CHALLENGES, refutes, or complicates a specific claim. You", "default", "codex-subscription", "gpt-5.6-terra", "rw", "2026-06-21T23:37:37.674Z"],
  ["research-specialist", "You are a research specialist. You receive one claim and you must validate it against concrete evidence (code, docs, observed behavior). You", "default", "claude-subscription", "claude-opus-5-5", "rw", "2026-09-28T18:44:15.452Z"],
  ["review-rechecker", "You are the evidence-led review lifecycle's rechecker (FG-639, Stage 8). You have exactly TWO bounded jobs, and nothing outside them is your", "review", "codex-subscription", "gpt-5.6-terra", "ro", "2026-09-29T15:24:03.069Z"],
  ["security-advisor", "You implement the plan, one step at a time, in the mounted /project directory \u2014 through a security lens. You write security-critical code: a", "default", "claude-subscription", "claude-opus-5-5", "rw", "2026-09-09T03:47:39.652Z"],
  ["shipping-reviewer", "You are the **acceptance reviewer** \u2014 product-owner lens + tech-lead lens. Your job is to determine whether the engineer's implementation sa", "review", "codex-subscription", "gpt-5.6-terra", "ro", "2026-09-09T04:15:03.953Z"],
  ["synthesizer", "You are a synthesizer. You receive all per-claim investigator outputs and produce an integrated synthesis grounded only in the evidence prov", "default", "claude-subscription", "claude-opus-5-5", "rw", "2026-06-21T23:42:25.812Z"],
  ["tech-lead", "You translate a design or architecture document into a step-by-step implementation plan. Each step is independently testable; each lists the", "reasoning", "claude-subscription", "claude-opus-5-5", "rw", "2026-09-09T03:08:22.864Z"],
  ["test-engineer", "You write integration and E2E tests that prove the implementation works through real user flows. Your output is **durable test files written", "default", "codex-subscription", "gpt-5.6-terra", "rw", "2026-09-29T15:43:47.808Z"],
];

function entry([role, description, activity, profile, model, mount, lastTaskAt]: (typeof MOCK_ROLES)[number]) {
  return {
    role, description, defaultActivity: activity, profile, effort: null, model, resolvedBy: "defaults.profile", resolutionError: null,
    mountMode: mount, mountModeSource: mount === "ro" ? "declared as a red in a seed-generation workflow" : "a blue dispatch mounts /project read-write",
    settings: role !== "red-wide", protocolSha: PROTOCOL_SHA, lastTaskAt,
  };
}

const ROLES = {
  generatedAt: new Date().toISOString(),
  agentsDir: "~/.forge/agents",
  generation: GEN,
  seedInstall: { kind: "healthy", reason: null },
  modelPolicy: { source: "host", path: "~/.forge/model-policy.yml", error: null },
  storeError: null,
  roles: MOCK_ROLES.map(entry),
};

// Only builders and reds: every other family tab is hidden.
const TWO_FAMILIES = { ...ROLES, roles: ROLES.roles.filter((r) => r.role === "engineer" || r.role.startsWith("red-")) };

const TASKS = [
  { taskId: "task-engineer-99246f", runId: "run-829", runTitle: "FG-829 role glyph tiles", projectDir: "/repos/forge", phase: "build", status: "complete", agentModel: "claude-opus-5-5", createdAt: ago(3), startedAt: ago(3), completedAt: ago(2.8) },
  { taskId: "task-engineer-7e0267", runId: "run-827b", runTitle: "FG-827 follow-up", projectDir: "/repos/forge", phase: "build", status: "complete", agentModel: "claude-opus-5-5", createdAt: ago(5), startedAt: ago(5), completedAt: ago(4.8) },
  { taskId: "task-engineer-cec711", runId: "run-827", runTitle: "FG-827 roles second pass", projectDir: "/repos/forge", phase: "build", status: "complete", agentModel: "claude-opus-5-5", createdAt: ago(6), startedAt: ago(6), completedAt: ago(5.8) },
];
const ACTIVITIES = ["default", "reasoning", "review", "fast", "spec-writer", "fast-orchestrator"];
const CONSTRAINTS = ["no-ai-attribution", "no-env-fabrication", "atlas-stack-rn", "coding-conventions"];

function detail(role: string) {
  const e = ROLES.roles.find((r) => r.role === role)!;
  const tasks = role === "engineer" ? TASKS : [];
  const prompt = `# ${role}\n\n${e.description}\n`;
  return {
    role,
    generatedAt: new Date().toISOString(),
    generation: GEN,
    storeError: null,
    overview: {
      source: `~/.forge/agents/${role}/CLAUDE.md; model policy ~/.forge/model-policy.yml; tasks and model_calls in forge.db`,
      description: e.description,
      resolution: { activity: e.defaultActivity, profile: e.profile, effort: null, model: e.model, provider: "anthropic", auth: "subscription", runtime: "claude-oauth", resolvedBy: e.resolvedBy, mappingPath: "exact", error: null },
      modelPolicy: ROLES.modelPolicy,
      mountMode: { mode: e.mountMode, source: e.mountModeSource },
      latestTask: tasks[0] ? { taskId: tasks[0].taskId, runId: tasks[0].runId, runTitle: tasks[0].runTitle, status: tasks[0].status, createdAt: tasks[0].createdAt, completedAt: tasks[0].completedAt } : null,
      skills: ["browser-tools"],
      recentTasks: tasks,
      ops: { since: "30d", terminal: 3, complete: 3, failed: 0, successRate: 1, timed: 3, medianMs: 720_000 },
      usage: { since: "30d", inputTokens: 1_234_567, outputTokens: 45_678, cacheReadTokens: 0, cacheCreationTokens: 0, requests: 212 },
      protocolSha: e.protocolSha,
    },
    instructions: {
      source: `composeSystemPrompt over ~/.forge/agents/${role}/CLAUDE.md`, ok: true, context: `forge invoke ${role}`, prompt, sha256: "9c".repeat(32),
      sections: [{ kind: "base", title: "Role seed (CLAUDE.md)", start: 0, end: prompt.length }],
      files: [{ id: "entry", label: "CLAUDE.md", kind: "entry", path: `~/.forge/agents/${role}/CLAUDE.md`, markdown: prompt, bytes: prompt.length, edit: "published by forge upgrade" }],
      protocol: null, constraintsSkipped: [],
    },
    skills: {
      source: "container: the claude-oauth runtime's skill mounts",
      mounted: [{ name: "browser-tools", description: "Drive a headless Chrome.", descriptionSource: "x", source: "host", host: "~/pi-skills/browser-tools", hostPath: "/h/pi-skills/browser-tools", present: true, container: "/home/agent/.claude/skills/browser-tools", mode: "ro", optional: true, referencedBySeed: true }],
      hostOnly: ["forge-backlog", "forge-campaign", "forge-review-loop", "status"].map((name) => ({ name, path: `/h/skills/${name}/SKILL.md`, description: `The ${name} skill.` })),
      available: [], availableNote: "The skill registry will list skills this role could mount.", runtimeError: null,
    },
    capabilities: {
      source: "model policy; routing policy; constraints",
      activities: ACTIVITIES.map((activity, i) => ({ activity, isDefault: i === 0, profile: e.profile, model: e.model, dispatchable: true, resolvedBy: e.resolvedBy, error: null })),
      routingPolicy: { path: `${GEN.root}/routing-policy.yml`, available: true },
      routes: role === "engineer" ? [{ route: "implementation_quick", path: "workflow", relations: ["responsible"] }] : [],
      resultContract: { declared: true, fields: [{ name: "status", source: "x" }], source: "x", note: null },
      mountMode: { mode: e.mountMode, source: e.mountModeSource },
      constraints: CONSTRAINTS.map((id) => ({ id, file: `/h/constraints/${id}.md`, level: "force", heading: null, scope: "host", active: true, note: null })),
      constraintsError: null,
    },
    harness: {
      source: `forge model resolve ${role} --activity <a>`,
      activities: [{ activity: e.defaultActivity, isDefault: true, profile: e.profile, provider: "anthropic", model: e.model, auth: "subscription", runtime: "claude-oauth", image: "agent-dev-worker:latest", costTier: "standard", effort: null, resolvedBy: e.resolvedBy, mapping: "exact", mappingPath: "exact", outcome: "resolved", dispatchable: true, error: null, resolve: {} }],
      policyError: null,
      container: {
        source: "runtimes/claude-oauth.yml",
        mounts: [{ path: "/task", mode: "rw", source: "${TASK_DIR}", optional: false, caption: "runtime mounts[]" }],
        authVolume: { authMode: "oauth-volume", volume: "forge-claude-oauth-v2", path: "/home/agent", mode: "rw", source: "runtime auth.mode" },
        skillMounts: [], idleTimeout: { seconds: 600, effectiveMs: 600000, override: null, source: "runtime" },
        network: { mode: "docker default (bridge)", source: "spawn.ts" },
      },
      edit: { settings: "seeds/agents/x/settings.json", runtime: "seeds/runtimes/claude-oauth.yml", policy: "model-policy.yml" },
      settings: { path: `~/.forge/agents/${role}/settings.json`, present: true, text: "{}\n", tools: [], error: null },
      runtime: { name: "claude-oauth", source: "host", path: "x", text: "name: claude-oauth\n", kind: "claude-code", authStrategy: "oauth-volume", authMode: "oauth-volume", image: "agent-dev-worker:latest", skillMounts: [], error: null },
      authStrategy: "oauth-volume", runtimeBoundBy: "model policy defaults.profile",
    },
    secrets: { source: "the dispatch mount set", text: "none: containers receive no project secrets" },
    tools: {
      source: "settings.json", settingsPresent: true, declared: ["read"], enforced: false, note: "declared, not enforced", mcp: "none",
      effective: { mounts: [{ path: "/task", mode: "rw", optional: false }], network: { mode: "bridge", source: "x" }, toolchain: { image: "x", source: null, entries: null, note: "unknown" }, mcp: "none" },
    },
    tasks: { source: "tasks WHERE agent_role = role", rows: tasks, limit: 50 },
    receipts: { source: "manifest.json receipts", dispatches: [], generations: [], backups: [] },
    usage: { source: "model_calls", windows: [], pricing: { source: null, note: "no pricing source" }, ceilings: "none" },
  };
}

let server: Server;
let browser: Browser;
let rolesReads = 0;
let fixtureRoles: Record<string, unknown> = ROLES;
const baseUrl = `http://127.0.0.1:${PORT}`;

before(async () => {
  server = createFixtureServer();
  await new Promise<void>((ready) => server.listen(PORT, "127.0.0.1", ready));
  browser = await chromium.launch({ executablePath: requireChrome("the dashboard browser tier"), headless: true, args: CHROME_LAUNCH_ARGS });
});

after(async () => {
  await browser?.close();
  server?.closeAllConnections?.();
  await new Promise<void>((closed) => server?.close(() => closed()));
});

async function open(hash: string, ready: string, width = 1200): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // tsx's esbuild transform wraps named arrows inside page.evaluate bodies in `__name(...)`.
  await page.addInitScript("window.__name = (f) => f;");
  await page.goto(`${baseUrl}/${hash}`);
  await page.locator(ready).first().waitFor();
  return { page, errors };
}

const hashOf = (page: Page) => new URL(page.url()).hash;
const order = (page: Page) => page.locator(".roles-table tbody tr[data-role]").evaluateAll((trs) => trs.map((tr) => tr.getAttribute("data-role")));
const pressedFamily = (page: Page) => page.locator('.roles-family-tab[aria-pressed="true"]').getAttribute("data-family");

async function waitFor<T>(read: () => Promise<T>, expected: T, what: string): Promise<void> {
  const deadline = Date.now() + 8000;
  let last: T = await read();
  while (Date.now() < deadline) {
    last = await read();
    if (JSON.stringify(last) === JSON.stringify(expected)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.deepEqual(last, expected, what);
}

test("FG-837: every list row has the mock's shape — 36px tile, name over a one-line subtitle, mono model over profile, family · activity, relative time, mount pill — and none runs past two lines", async () => {
  const { page, errors } = await open("#roles", ".roles-table tbody tr[data-role]");
  const rows = await page.locator(".roles-table tbody tr[data-role]").evaluateAll((trs) => trs.map((tr) => {
    const tile = tr.querySelector(".role-tile")!.getBoundingClientRect();
    const sub = tr.querySelector(".role-subtitle") as HTMLElement;
    const s = getComputedStyle(sub);
    // Distinct line boxes per cell, measured on the text itself.
    const lines = Array.from(tr.querySelectorAll("td")).map((td) => {
      const tops: number[] = [];
      const walker = document.createTreeWalker(td, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (!n.textContent?.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(n);
        for (const r of Array.from(range.getClientRects())) {
          if (r.width > 0 && !tops.some((t) => Math.abs(t - r.top) < 4)) tops.push(r.top);
        }
      }
      return tops.length;
    });
    return {
      role: tr.getAttribute("data-role"),
      tile: [Math.round(tile.width), Math.round(tile.height)],
      name: tr.querySelector(".roles-ident a")?.textContent,
      nameWeight: getComputedStyle(tr.querySelector(".roles-ident a")!).fontWeight,
      subtitle: sub.textContent,
      subtitleOneLine: s.whiteSpace === "nowrap" && s.textOverflow === "ellipsis" && s.overflow === "hidden",
      modelFont: getComputedStyle(tr.querySelector(".role-model")!).fontFamily,
      model: tr.querySelector(".role-model")?.textContent,
      profile: tr.querySelector(".role-profile")?.textContent,
      fam: tr.querySelector(".roles-fam")?.textContent,
      when: tr.querySelector('[data-col="last-task"]')?.textContent,
      pill: tr.querySelector('[data-col="mount"] .role-pill')?.className,
      mount: tr.querySelector('[data-col="mount"]')?.textContent,
      maxLines: Math.max(...lines),
      href: tr.querySelector("a")?.getAttribute("href"),
    };
  }));
  assert.equal(rows.length, 23);
  for (const r of rows) {
    assert.deepEqual(r.tile, [36, 36], `${r.role} tile`);
    assert.equal(r.name, r.role);
    assert.equal(r.nameWeight, "600", `${r.role} name is semibold`);
    assert.equal(r.subtitleOneLine, true, `${r.role} subtitle never wraps`);
    assert.match(r.modelFont, /monospace/, `${r.role} model is mono`);
    assert.match(r.when!, /^(\d+[smhd] ago|never)$/, `${r.role} time is relative`);
    assert.ok(r.maxLines <= 2, `${r.role} renders ${r.maxLines} text lines`);
    assert.equal(r.href, `#roles/${r.role}`);
  }
  const byRole = Object.fromEntries(rows.map((r) => [r.role, r]));
  assert.deepEqual([byRole["architecture-advisor"]!.subtitle, byRole["architecture-advisor"]!.model, byRole["architecture-advisor"]!.profile, byRole["architecture-advisor"]!.fam],
    ["You are a systems architect.", "claude-opus-5-5", "claude-subscription", "plan · reasoning"], "markdown stripped to the first sentence");
  assert.equal(byRole["prompt-author"]!.subtitle, "You are a prompt author.");
  assert.deepEqual([byRole["engineer"]!.pill, byRole["engineer"]!.mount], ["role-pill role-pill-rw", "read-write"]);
  assert.deepEqual([byRole["red-wide"]!.pill, byRole["red-wide"]!.mount], ["role-pill role-pill-ro", "read-only"]);
  assert.equal(await page.locator('tr[data-role="red-wide"] .roles-flag').textContent(), "no settings.json", "the missing settings.json is a badge after the name");
  assert.equal(await page.locator(".roles-index .role-description, .roles-index .role-description-full").count(), 0, "no description paragraphs");
  assert.equal(await page.locator("[data-roles-count]").textContent(), "23 roles");
  assert.equal(await page.locator("[data-roles-sort]").textContent(), "sorted by name ▲");
  assert.equal(await page.locator(".roles-lede").textContent(), "What each role is and runs on. A seed changes only through forge upgrade.");
  assert.deepEqual(await page.locator(".roles-family-tab").allTextContents(), ["All", "Builders", "Reds", "Research", "Testers", "Reviewers", "Planners", "Authors"]);
  const footerAfter = await page.evaluate(() => Boolean(document.querySelector(".roles-panel")!.compareDocumentPosition(document.querySelector("[data-caption='roles']")!) & Node.DOCUMENT_POSITION_FOLLOWING));
  assert.equal(footerAfter, true, "the Source line is a footer under the panel");
  // The whole row is the link: a click on the time cell opens the role.
  await page.locator('tr[data-role="manual-qa"] [data-col="last-task"]').click({ force: true });
  await waitFor(async () => hashOf(page), "#roles/manual-qa", "a click anywhere on the row opens it");
  await page.evaluate(() => history.back());
  await page.locator(".roles-table tbody tr[data-role]").first().waitFor();
  await page.screenshot({ path: join(SHOTS, "fg837-roles-list-1200.png"), fullPage: true });
  assert.deepEqual(errors, []);
  await page.close();
});

test("FG-837: at 900px every Roles row still fits its text into at most two rendered lines", async () => {
  const { page, errors } = await open("#roles", ".roles-table tbody tr[data-role]", 900);
  const rows = await page.locator(".roles-table tbody tr[data-role]").evaluateAll((trs) => trs.map((tr) => {
    const lines = Array.from(tr.querySelectorAll("td")).map((td) => {
      const tops: number[] = [];
      const walker = document.createTreeWalker(td, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.textContent?.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const rect of Array.from(range.getClientRects())) {
          if (rect.width > 0 && !tops.some((top) => Math.abs(top - rect.top) < 4)) tops.push(rect.top);
        }
      }
      return tops.length;
    });
    return [tr.getAttribute("data-role"), Math.max(...lines)] as const;
  }));
  for (const [role, maxLines] of rows) assert.ok(maxLines <= 2, String(role) + " renders " + maxLines + " text lines at 900px");
  await page.screenshot({ path: join(SHOTS, "fg837-roles-list-900.png"), fullPage: true });
  assert.deepEqual(errors, []);
  await page.close();
});

test("FG-837: family tabs filter client-side, ride the hash beside sort/dir, compose with a header sort, and survive a reload", async () => {
  rolesReads = 0;
  const { page, errors } = await open("#roles", ".roles-table tbody tr[data-role]");
  assert.equal(await pressedFamily(page), "all");
  await page.locator('.roles-family-tab[data-family="red"]').click();
  await waitFor(async () => hashOf(page), "#roles?family=red", "a family tab writes family=");
  await waitFor(() => pressedFamily(page), "red", "Reds is pressed");
  await waitFor(() => order(page), ["red-backend", "red-frontend", "red-narrow", "red-security", "red-wide"], "only reds");
  assert.equal(await page.locator("[data-roles-count]").textContent(), "5 roles");
  assert.equal(await pressedFamily(page), "red");

  await page.locator('th[data-sort="lastTask"] button').click();
  await waitFor(async () => hashOf(page), "#roles?family=red&sort=lastTask&dir=asc", "a sort keeps the family");
  await waitFor(() => page.locator('th[data-sort="lastTask"]').getAttribute("aria-sort"), "ascending", "aria-sort follows");
  await waitFor(() => order(page), ["red-narrow", "red-backend", "red-frontend", "red-security", "red-wide"], "reds, oldest first");
  assert.equal(await page.locator('th[data-sort="lastTask"]').getAttribute("aria-sort"), "ascending");

  await page.locator('.roles-family-tab[data-family="research"]').click();
  await waitFor(async () => hashOf(page), "#roles?family=research&sort=lastTask&dir=asc", "a family change keeps the sort");
  await waitFor(() => order(page), ["research-framer", "research-primary", "research-skeptic", "synthesizer", "research-specialist"], "research, oldest first");
  assert.equal(rolesReads, 1, "filtering and sorting never refetch");

  await page.reload();
  await page.locator(".roles-table tbody tr[data-role]").first().waitFor();
  assert.equal(hashOf(page), "#roles?family=research&sort=lastTask&dir=asc");
  await waitFor(() => order(page), ["research-framer", "research-primary", "research-skeptic", "synthesizer", "research-specialist"], "restored on reload");
  assert.equal(await pressedFamily(page), "research");

  await page.locator('.roles-family-tab[data-family="all"]').click();
  await waitFor(async () => hashOf(page), "#roles?sort=lastTask&dir=asc", "All drops family and keeps the sort");
  await waitFor(async () => (await order(page)).length, 23, "All shows every role");

  await page.goto(`${baseUrl}/#roles?family=wizards&sort=role`);
  await waitFor(async () => hashOf(page), "#roles?sort=role", "an unknown family is dropped");
  assert.equal(await pressedFamily(page), "all");

  fixtureRoles = TWO_FAMILIES;
  await page.goto(`${baseUrl}/#roles`);
  await page.reload();
  await page.locator(".roles-table tbody tr[data-role]").first().waitFor();
  assert.deepEqual(await page.locator(".roles-family-tab").allTextContents(), ["All", "Builders", "Reds"], "a family with no roles has no tab");
  fixtureRoles = ROLES;
  assert.deepEqual(errors, []);
  await page.close();
});

test("FG-837: keyboard — Tab walks the family tabs into the sort headers, Enter and Space operate both (FG-692)", async () => {
  const { page, errors } = await open("#roles", ".roles-table tbody tr[data-role]");
  await page.locator('.roles-family-tab[data-family="all"]').focus();
  const seen: string[] = [];
  for (let i = 0; i < 9; i += 1) {
    seen.push(await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      return el?.getAttribute("data-family") ?? el?.closest("th")?.getAttribute("data-sort") ?? el?.tagName ?? "";
    }));
    await page.keyboard.press("Tab");
  }
  assert.deepEqual(seen, ["all", "build", "red", "research", "test", "review", "plan", "author", "role"], "family tabs, then the first sort header");
  const names = await page.locator(".roles-family-tab").evaluateAll((bs) => bs.map((b) => [b.tagName, b.getAttribute("aria-pressed")]));
  assert.ok(names.every(([tag, pressed]) => tag === "BUTTON" && (pressed === "true" || pressed === "false")), "each tab is a toggle button announced pressed or not");
  assert.equal(await page.locator(".roles-family-tabs").getAttribute("aria-label"), "Family");

  await page.locator('.roles-family-tab[data-family="test"]').focus();
  await page.keyboard.press("Enter");
  await waitFor(async () => hashOf(page), "#roles?family=test", "Enter selects a family");
  await waitFor(() => pressedFamily(page), "test", "Testers is pressed");
  await page.locator('th[data-sort="profile"] button').focus();
  await page.keyboard.press("Space");
  await waitFor(async () => hashOf(page), "#roles?family=test&sort=profile&dir=asc", "Space sorts within the family");
  await waitFor(() => page.locator('th[data-sort="profile"]').getAttribute("aria-sort"), "ascending", "aria-sort follows");
  await page.locator('.roles-family-tab[data-family="build"]').focus();
  await page.keyboard.press("Space");
  await waitFor(async () => hashOf(page), "#roles?family=build&sort=profile&dir=asc", "Space selects a family and keeps the sort");

  await page.locator('th[data-sort="mount"] button').focus();
  await page.keyboard.press("Tab");
  const focusRing = await page.evaluate(() => {
    const a = document.activeElement as HTMLElement;
    const tr = a.closest("tr[data-role]") as HTMLElement | null;
    return { inRow: !!tr && a.matches(".roles-ident a:focus-visible"), rowOutline: tr ? getComputedStyle(tr).outlineStyle : "" };
  });
  assert.ok(focusRing.inRow, "Tab from the last sort header lands on the first row's link");
  assert.equal(focusRing.rowOutline, "solid", "with :has() the focused row is outlined");
  const ringRules = await page.evaluate(() => {
    const out: Array<{ supports: string | null; outline: string }> = [];
    const walk = (rules: CSSRuleList, supports: string | null) => {
      for (const r of Array.from(rules)) {
        if (r instanceof CSSSupportsRule) walk(r.cssRules, r.conditionText);
        else if (r instanceof CSSStyleRule && r.selectorText === ".roles-ident a:focus-visible") out.push({ supports, outline: r.style.getPropertyValue("outline") });
      }
    };
    for (const sheet of Array.from(document.styleSheets)) walk(sheet.cssRules, null);
    return out;
  });
  assert.ok(ringRules.some((r) => r.supports === null && r.outline.includes("solid")), "the link's own focus outline is unconditional, so a browser without :has() still shows focus");
  assert.ok(ringRules.every((r) => r.outline !== "none" || (r.supports ?? "").includes(":has(")), "the link outline is only dropped where :has() carries the row outline");
  assert.deepEqual(errors, []);
  await page.close();
});

test("FG-837: the role page at 1200px — header line, a grouped left sub-nav (Role, Runtime, Governance, Audit) with 15px icons, Overview strip, four cards and Recent tasks", async () => {
  const { page, errors } = await open("#roles/engineer", ".role-overview");
  const nav = await page.locator("nav.role-subnav").evaluate((n) => ({
    label: n.getAttribute("aria-label"),
    groups: Array.from(n.querySelectorAll(".role-subnav-group")).map((g) => [
      g.querySelector(".role-subnav-label")!.textContent,
      Array.from(g.querySelectorAll("a")).map((a) => a.textContent!.trim()),
    ]),
    current: Array.from(n.querySelectorAll('[aria-current="page"]')).map((a) => a.getAttribute("data-tab")),
    icons: Array.from(n.querySelectorAll("a svg")).map((s) => [Math.round(s.getBoundingClientRect().width), Math.round(s.getBoundingClientRect().height), s.getAttribute("aria-hidden")]),
  }));
  assert.equal(nav.label, "Role views");
  assert.deepEqual(nav.groups, [
    ["Role", ["Overview", "Instructions", "Skills"]],
    ["Runtime", ["Harness / Runtime", "Secrets", "Tools"]],
    ["Governance", ["Capabilities / Trust", "Receipts"]],
    ["Audit", ["Tasks", "Usage"]],
  ]);
  assert.deepEqual(nav.current, ["overview"]);
  assert.ok(nav.icons.length === 10 && nav.icons.every((i) => i[0] === 15 && i[1] === 15 && i[2] === "true"), "ten 15px decorative icons");
  assert.equal(await page.locator('[role="tab"]').count(), 0, "no tablist beside the sub-nav");
  const navBox = await page.locator("nav.role-subnav").boundingBox();
  const mainBox = await page.locator(".role-main").boundingBox();
  assert.ok(navBox!.x + navBox!.width <= mainBox!.x + 1, "the sub-nav is a left column");

  const tile = await page.locator(".role-head .role-tile").boundingBox();
  assert.deepEqual([Math.round(tile!.width), Math.round(tile!.height)], [48, 48]);
  assert.equal(await page.locator(".role-head h1").textContent(), "engineer");
  assert.equal(await page.locator("[data-role-meta]").textContent(), "claude-oauth · claude-opus-5-5 · build · read-write");
  assert.equal(await page.locator(".role-hint").textContent(), "A seed changes only through forge upgrade. Read why it runs where it does: forge model resolve engineer");
  assert.equal(await page.locator(".role-panel-title").textContent(), "Overview");

  const strip = page.locator("[data-latest-task]");
  assert.deepEqual(await strip.evaluate((s) => [s.querySelector(".badge")!.textContent, s.querySelector(".role-latest-id")!.textContent, s.querySelector(".role-latest-title")!.textContent]),
    ["complete", "task-engineer-99246f", "FG-829 role glyph tiles"]);
  assert.equal(await strip.locator("[data-relative]").textContent(), "3h ago");
  const cards = await page.locator(".role-card-grid .role-card").evaluateAll((cs) => cs.map((c) => [
    c.querySelector(".role-card-title")!.textContent, c.querySelector(".role-card-link")?.textContent ?? null,
    Object.fromEntries(Array.from(c.querySelectorAll(".role-kv div")).map((d) => [d.querySelector("dt")!.textContent, d.querySelector("dd")!.textContent])),
  ]));
  assert.deepEqual(cards.slice(0, 3), [
    ["Identity", "Instructions →", { Family: "build", "Default activity": "default", Mount: "read-write", "Seed generation": "gen-vkdg0z2acl", "Protocol sha": "487dd8acab33" }],
    ["Harness / Runtime", "Configure →", { Runtime: "claude-oauth", Profile: "claude-subscription", Model: "claude-opus-5-5", Auth: "subscription", "Resolved by": "defaults.profile" }],
    ["Capabilities", "Trust →", { Activities: ACTIVITIES.join(", "), Routes: "implementation_quick (responsible)", Constraints: CONSTRAINTS.join(" · ") }],
  ]);
  assert.deepEqual(cards[3]!.slice(0, 2), ["Skills", "Manage →"]);
  assert.deepEqual(await page.locator(".role-skill-chips .role-chip").allTextContents(), ["browser-tools", "host: forge-backlog · forge-campaign · forge-review-loop · status"]);
  const two = await page.locator(".role-card-grid .role-card").evaluateAll((cs) => cs.slice(0, 4).map((c) => Math.round(c.getBoundingClientRect().x)));
  assert.equal(new Set(two).size, 2, "the four cards sit in two columns");
  assert.equal(two[0], two[2]);
  assert.deepEqual(await page.locator(".role-task-row").evaluateAll((rs) => rs.map((r) => [r.querySelector("a")!.textContent, r.querySelector(".role-task-title")!.textContent, r.querySelector(".role-task-meta")!.textContent])), [
    ["task-engineer-99246f", "FG-829 role glyph tiles", "complete · 3h ago"],
    ["task-engineer-7e0267", "FG-827 follow-up", "complete · 5h ago"],
    ["task-engineer-cec711", "FG-827 roles second pass", "complete · 6h ago"],
  ]);
  await page.screenshot({ path: join(SHOTS, "fg837-engineer-overview-1200.png"), fullPage: true });
  await page.locator(".role-section-head .role-card-link").click();
  await waitFor(async () => hashOf(page), "#roles/engineer/tasks", "See all opens Tasks");
  await waitFor(() => page.locator('nav.role-subnav [aria-current="page"]').evaluateAll((as) => as.map((a) => a.getAttribute("data-tab"))), ["tasks"], "the sub-nav follows");
  assert.deepEqual(errors, []);
  await page.close();
});

test("FG-837: the sub-nav is reached by Tab and followed by Enter; aliases, breadcrumbs and Escape still work beside it", async () => {
  const { page, errors } = await open("#roles/engineer/configuration", ".role-harness");
  assert.equal(hashOf(page), "#roles/engineer/harness", "the configuration alias lands on harness");
  assert.deepEqual(await page.locator('nav.role-subnav [aria-current="page"]').evaluateAll((as) => as.map((a) => a.getAttribute("data-tab"))), ["harness"]);
  await page.locator('nav.role-subnav a[data-tab="overview"]').focus();
  const walk: string[] = [];
  for (let i = 0; i < 10; i += 1) {
    walk.push((await page.evaluate(() => document.activeElement?.getAttribute("data-tab"))) ?? "");
    await page.keyboard.press("Tab");
  }
  assert.deepEqual(walk, ["overview", "instructions", "skills", "harness", "secrets", "tools", "capabilities", "receipts", "tasks", "usage"], "Tab walks the groups in order");
  await page.locator('nav.role-subnav a[data-tab="receipts"]').focus();
  await page.keyboard.press("Enter");
  await waitFor(async () => hashOf(page), "#roles/engineer/receipts", "Enter follows the entry");
  await page.locator(".role-receipts").waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("data-tab")), "receipts", "focus stays on the entry");
  assert.deepEqual(await page.locator(".breadcrumbs li").allTextContents(), ["Roles", "engineer", "Receipts"]);
  await page.keyboard.press("Escape");
  await waitFor(async () => hashOf(page), "#roles", "Escape returns to the list");
  assert.deepEqual(errors, []);
  await page.close();
});

test("FG-837: under 900px the sub-nav collapses to the FG-817 tablist, and back when widened", async () => {
  const { page, errors } = await open("#roles/engineer/skills", ".role-skills", 820);
  assert.equal(await page.locator("nav.role-subnav").count(), 0);
  const tabs = await page.locator('.object-tabs[role="tablist"] [role="tab"]').evaluateAll((ts) => ts.map((t) => [t.getAttribute("data-tab"), t.getAttribute("aria-selected")]));
  assert.equal(tabs.length, 10);
  assert.deepEqual(tabs.find(([, sel]) => sel === "true"), ["skills", "true"]);
  await page.locator('[role="tab"][data-tab="skills"]').focus();
  await page.keyboard.press("ArrowRight");
  await waitFor(async () => hashOf(page), "#roles/engineer/capabilities", "the tablist keeps its arrow keys");
  await page.screenshot({ path: join(SHOTS, "fg837-engineer-820.png"), fullPage: true });
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.locator("nav.role-subnav").waitFor();
  assert.equal(await page.locator('[role="tab"]').count(), 0);
  assert.deepEqual(await page.locator('nav.role-subnav [aria-current="page"]').evaluateAll((as) => as.map((a) => a.getAttribute("data-tab"))), ["capabilities"]);
  assert.deepEqual(errors, []);
  await page.close();
});

test("FG-837: every new text element meets WCAG AA (4.5:1) against the surface it is painted on", async () => {
  const measure = (page: Page, selectors: string[]) => page.evaluate((sels) => {
    const rgb = (c: string) => (c.match(/[\d.]+/g) ?? []).map(Number);
    const lum = (c: string) => {
      const [r, g, b] = rgb(c).slice(0, 3).map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    const surface = (el: Element | null): string => {
      for (let n = el; n; n = n.parentElement) {
        const bg = getComputedStyle(n).backgroundColor;
        const a = rgb(bg)[3];
        if (bg !== "transparent" && (a === undefined || a >= 1)) return bg;
      }
      return getComputedStyle(document.body).backgroundColor;
    };
    return sels.map((sel) => {
      const els = Array.from(document.querySelectorAll(sel));
      if (els.length === 0) return [sel, 0] as [string, number];
      const worst = Math.min(...els.map((el) => {
        const a = lum(getComputedStyle(el).color);
        const b = lum(surface(el));
        return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      }));
      return [sel, Number(worst.toFixed(2))] as [string, number];
    });
  }, selectors);

  const { page, errors } = await open("#roles", ".roles-table tbody tr[data-role]");
  const list = await measure(page, [
    ".roles-lede", ".roles-family-tab", ".roles-family-tab-current", ".roles-toolbar-meta", ".roles-table .sort-header", ".roles-ident a",
    ".role-subtitle", ".roles-flag", ".role-model", ".role-profile", ".roles-fam", ".roles-when", ".role-pill-rw", ".role-pill-ro", "[data-caption='roles']",
  ]);
  await page.goto(`${baseUrl}/#roles/engineer`);
  await page.locator(".role-overview").waitFor();
  const role = await measure(page, [
    ".role-subnav-label", ".role-subnav-item", ".role-subnav-current", ".role-meta", ".role-hint", ".role-panel-title", ".role-latest-id", ".role-latest-title",
    ".role-latest-when", ".role-card-title", ".role-card-link", ".role-kv dt", ".role-kv dd", ".role-chip", ".role-chip-host", ".role-task-main a", ".role-task-title", ".role-task-meta", ".role-caption",
  ]);
  for (const [sel, ratio] of [...list, ...role]) {
    assert.ok(ratio >= 4.5, `${sel} is ${ratio}:1`);
  }
  assert.deepEqual(errors, []);
  await page.close();
});

function createFixtureServer(): Server {
  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const json = (body: unknown, status = 200) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
    if (url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(renderShell());
      return;
    }
    if (url.pathname.startsWith("/client/")) {
      const candidate = resolve(CLIENT_DIR, url.pathname.slice("/client/".length));
      if (!existsSync(candidate)) {
        res.writeHead(404).end();
        return;
      }
      const filePath = realpathSync(candidate);
      if (!filePath.startsWith(`${CLIENT_DIR}/`)) {
        res.writeHead(404).end();
        return;
      }
      const contentType = filePath.endsWith(".js") ? "application/javascript; charset=utf-8"
        : filePath.endsWith(".svg") ? "image/svg+xml"
          : filePath.endsWith(".png") ? "image/png"
            : "application/octet-stream";
      res.writeHead(200, { "Content-Type": contentType }).end(readFileSync(filePath));
      return;
    }
    if (url.pathname === "/api/roles") {
      rolesReads += 1;
      json(fixtureRoles);
      return;
    }
    const one = url.pathname.match(/^\/api\/roles\/([^/]+)$/);
    if (one) {
      const role = decodeURIComponent(one[1]!);
      if (!ROLES.roles.some((r) => r.role === role)) return json({ error: "no such role" }, 404);
      json(detail(role));
      return;
    }
    if (url.pathname === "/api/attention-inbox") {
      json({ generatedAt: new Date().toISOString(), scope: { runId: null, projectDirs: null }, degraded: [], items: [], empty: true, counts: { open: 0, high: 0 } });
      return;
    }
    if (url.pathname === "/api/runs") {
      json({ runs: [], activeCount: 0, nextCursor: null, generatedAt: new Date().toISOString() });
      return;
    }
    if (url.pathname === "/api/projects") {
      json([]);
      return;
    }
    if (url.pathname === "/api/usage/limits") {
      json({ generatedAt: new Date(0).toISOString(), services: [] });
      return;
    }
    if (url.pathname === "/api/ops") {
      json({
        runs: { total: 0, active: 0, terminal: 0, clean: 0, withFailures: 0, successRate: 0 },
        taskCount: 0, counts: { idleKills: 0, cancels: 0, retries: 0, redBlocks: 0 },
        failureKinds: [], durations: [],
      });
      return;
    }
    if (["/api/in-flight", "/api/feed", "/api/verifications/in-progress", "/api/review-loop/phases"].includes(url.pathname)
      || url.pathname.startsWith("/api/usage")) {
      json([]);
      return;
    }
    json({ error: "not in this fixture" }, 404);
  });
}
