// FG-829: role glyph tiles in a real browser — every Roles list row carries a 20px tile
// painted in its family colour (every red red, nothing else red, an unknown role neutral
// with the layers glyph), a role page's header carries the 36px tile beside its title,
// Home's In flight rows and Activity's Recent agent outputs carry the 20px tile inside
// the role-name link, and each tile beside a visible name is hidden from assistive tech
// while the link keeps the role name as its accessible name. The tile is inline SVG: the
// fixture records every request to prove none is made for it.
//
// Screenshots go to a fresh temp dir unless FG829_SCREENSHOT_DIR names one.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import { renderShell } from "../src/shell.js";
import { CHROME_LAUNCH_ARGS, requireChrome } from "../../src/util/chrome-bin.js";

const PORT = 18834;
const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = realpathSync(resolve(HERE, "..", "client"));
const SEEDS = resolve(HERE, "..", "..", "seeds", "agents");
const SHOTS = process.env.FG829_SCREENSHOT_DIR ?? mkdtempSync(join(tmpdir(), "fg829-screenshots-"));
mkdirSync(SHOTS, { recursive: true });

const RGB: Record<string, string> = {
  red: "rgb(224, 87, 79)",
  build: "rgb(59, 108, 255)",
  test: "rgb(57, 184, 111)",
  review: "rgb(229, 154, 43)",
  research: "rgb(142, 92, 255)",
  plan: "rgb(38, 191, 177)",
  author: "rgb(245, 180, 0)",
  neutral: "rgb(154, 154, 163)",
};
const FAMILY_OF: Record<string, string> = {
  "red-wide": "red", "red-narrow": "red", "red-frontend": "red", "red-backend": "red", "red-security": "red",
  engineer: "build", "agentic-platform-builder": "build", "backend-specialist": "build", "frontend-specialist": "build", "security-advisor": "build",
  "test-engineer": "test", "manual-qa": "test",
  "shipping-reviewer": "review", "review-rechecker": "review",
  "research-framer": "research", "research-primary": "research", "research-skeptic": "research", "research-specialist": "research", synthesizer: "research",
  "architecture-advisor": "plan", "tech-lead": "plan",
  "documentation-maintainer": "author", "prompt-author": "author",
};

const SEED_ROLES = readdirSync(SEEDS, { withFileTypes: true })
  .filter((e) => e.isDirectory() && existsSync(join(SEEDS, e.name, "CLAUDE.md")))
  .map((e) => e.name)
  .sort();
const UNKNOWN = "scout";
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

const ROLES = {
  generatedAt: new Date().toISOString(),
  agentsDir: "/h/agents",
  generation: { id: "gen-1", root: "/h/seed-generations/gen-1", sourceAssetRoot: "/h/releases/r1" },
  seedInstall: { kind: "healthy", reason: null },
  modelPolicy: { source: "host", path: "/h/model-policy.yml", error: null },
  storeError: null,
  roles: [...SEED_ROLES, UNKNOWN].map((role) => ({
    role, description: `The ${role} role.`, defaultActivity: "default", profile: "claude-subscription", effort: null, model: "claude-sonnet-5",
    resolvedBy: "defaults.profile", resolutionError: null, mountMode: role.startsWith("red-") ? "ro" : "rw", mountModeSource: "fixture",
    settings: true, protocolSha: null, lastTaskAt: null,
  })),
};

function detail(role: string) {
  return {
    role,
    generatedAt: new Date().toISOString(),
    generation: ROLES.generation,
    storeError: null,
    overview: {
      source: `/h/agents/${role}/CLAUDE.md`,
      description: `The ${role} role.`,
      resolution: { activity: "default", profile: "claude-subscription", effort: null, model: "claude-sonnet-5", resolvedBy: "defaults.profile", error: null },
      mountMode: { mode: "rw", source: "fixture" },
      latestTask: null,
      skills: [],
      recentTasks: [],
      ops: null,
      usage: null,
      protocolSha: null,
    },
  };
}

const TASK = (taskId: string, agentRole: string) => ({
  taskId, runId: "run-1", runTitle: "Tile the roles", workflow: "feature", phase: "build", agentRole, agentModel: null,
  status: "running", startedAt: ago(60_000), projectDir: "/repos/forge", projectLabel: "forge", orchestrator: null, reconcile: null,
});
const IN_FLIGHT = [TASK("task-eng", "engineer"), TASK("task-red", "red-narrow"), TASK("task-unknown", UNKNOWN)];
const FEED = [
  { ...TASK("task-done", "test-engineer"), status: "complete", completedAt: ago(1000), durationMs: 5000, result: { status: "complete", notes: "ok" } },
  { ...TASK("task-review", "shipping-reviewer"), status: "complete", completedAt: ago(2000), durationMs: 5000, result: { status: "complete", notes: "ok" } },
];

let server: Server;
let browser: Browser;
const requests: string[] = [];
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

async function open(hash: string, ready: string): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${baseUrl}/${hash}`);
  await page.locator(ready).first().waitFor();
  return { page, errors };
}

type TileFacts = {
  role: string | null; family: string | null; glyph: string | null; ariaHidden: string | null; roleAttr: string | null;
  width: number; height: number; fill: string; fillOpacity: string; stroke: string; glyphStroke: string; beside: string;
};

// The tile's paint read back from the rendered DOM — computed style, not the attributes
// the module wrote — and the text of the element it decorates.
function tileFacts(page: Page, selector: string): Promise<TileFacts[]> {
  return page.locator(selector).evaluateAll((svgs) => svgs.map((svg) => {
    const box = svg.getBoundingClientRect();
    const rect = svg.querySelector(":scope > rect")!;
    const glyph = svg.querySelector(":scope > svg")!;
    return {
      role: svg.getAttribute("data-role"),
      family: svg.getAttribute("data-family"),
      glyph: svg.getAttribute("data-glyph"),
      ariaHidden: svg.getAttribute("aria-hidden"),
      roleAttr: svg.getAttribute("role"),
      width: box.width,
      height: box.height,
      fill: getComputedStyle(rect).fill,
      fillOpacity: getComputedStyle(rect).fillOpacity,
      stroke: getComputedStyle(rect).stroke,
      glyphStroke: getComputedStyle(glyph).stroke,
      beside: (svg.parentElement?.textContent ?? "").trim(),
    };
  }));
}

test("FG-829: every Roles list row shows a 20px tile in its family colour — every red red, nothing else red", async () => {
  requests.length = 0;
  const { page, errors } = await open("#roles", ".roles-table tbody tr");
  const rows = await page.locator(".roles-table tbody tr").evaluateAll((trs) => trs.map((tr) => tr.getAttribute("data-role")));
  assert.equal(rows.length, SEED_ROLES.length + 1);
  const tiles = await tileFacts(page, ".roles-table tbody tr .role-tile");
  assert.equal(tiles.length, rows.length, "one tile per row");
  for (const t of tiles) {
    const family = FAMILY_OF[t.role!] ?? "neutral";
    assert.equal(t.family, family, `${t.role} family`);
    assert.equal(t.fill, RGB[family], `${t.role} background`);
    assert.equal(t.stroke, RGB[family], `${t.role} border`);
    assert.equal(t.glyphStroke, RGB[family], `${t.role} glyph`);
    assert.equal(Number(t.fillOpacity), 0.13, `${t.role} background alpha`);
    assert.equal(t.fill === RGB.red, t.role!.startsWith("red-"), `${t.role}: reds are red and nothing else is`);
    assert.deepEqual([t.width, t.height], [36, 36], `${t.role} size (FG-837: the list row tile is 36px)`);
    assert.equal(t.beside, t.role, `${t.role}: the tile sits beside its visible name`);
  }
  const reds = tiles.filter((t) => t.family === "red").map((t) => t.role);
  assert.deepEqual(reds, ["red-backend", "red-frontend", "red-narrow", "red-security", "red-wide"]);
  const unknown = tiles.find((t) => t.role === UNKNOWN)!;
  assert.deepEqual([unknown.family, unknown.glyph, unknown.fill], ["neutral", "layers", RGB.neutral], "an unknown role is neutral with the layers glyph");
  const images = requests.filter((p) => /\.(svg|png|gif|jpe?g|webp)$/.test(p));
  assert.deepEqual(images.filter((p) => !/^\/client\/(logo-mark\.svg|favicon-\d+\.png|apple-touch-icon\.png)$/.test(p)), [], "the shell's brand assets only: no image request for a tile");
  await page.screenshot({ path: join(SHOTS, "fg829-roles-list.png"), fullPage: true });
  assert.deepEqual(errors, []);
  await page.close();
});

// FG-837: the header tile is 48px and sits beside the title block (name over the meta line).
test("FG-829: a role page header shows the 48px tile beside its title", async () => {
  const { page, errors } = await open("#roles/engineer", ".role-page .role-head .role-tile");
  await page.locator(".role-overview").waitFor();
  const [tile] = await tileFacts(page, ".role-page .role-head .role-tile");
  assert.deepEqual([tile!.role, tile!.family, tile!.glyph, tile!.width, tile!.height], ["engineer", "build", "wrench", 48, 48]);
  assert.deepEqual([tile!.fill, tile!.glyphStroke], [RGB.build, RGB.build]);
  assert.equal(tile!.ariaHidden, "true");
  assert.equal(await page.locator(".role-page .page-title").textContent(), "engineer", "the title text is unchanged");
  assert.equal(await page.locator(".role-page .role-head .role-tile").count(), 1);
  const titleBox = await page.locator(".role-page .page-title").boundingBox();
  const tileBox = await page.locator(".role-page .role-head .role-tile").boundingBox();
  assert.ok(titleBox!.y >= tileBox!.y && titleBox!.y + titleBox!.height <= tileBox!.y + tileBox!.height + 1 && tileBox!.x + tileBox!.width <= titleBox!.x, "the tile sits beside the title line");
  await page.locator(".role-page .role-head").screenshot({ path: join(SHOTS, "fg829-engineer-header.png") });
  await page.screenshot({ path: join(SHOTS, "fg829-engineer-page.png"), fullPage: true });

  await page.goto(`${baseUrl}/#roles/red-security`);
  await page.locator('.role-page[data-role="red-security"] .role-head .role-tile').waitFor();
  const [red] = await tileFacts(page, ".role-page .role-head .role-tile");
  assert.deepEqual([red!.family, red!.glyph, red!.fill, red!.width], ["red", "shield", RGB.red, 48]);
  assert.deepEqual(errors, []);
  await page.close();
});

test("FG-829: task rows show the 20px tile beside the role name inside its link", async () => {
  const { page, errors } = await open("#home", "section.in-flight .item");
  const inFlight = await tileFacts(page, "section.in-flight .item a.task-link .role-tile");
  assert.deepEqual(inFlight.map((t) => [t.role, t.family, t.fill, t.width, t.height, t.beside]), [
    ["engineer", "build", RGB.build, 20, 20, "engineer"],
    ["red-narrow", "red", RGB.red, 20, 20, "red-narrow"],
    [UNKNOWN, "neutral", RGB.neutral, 20, 20, UNKNOWN],
  ]);
  await page.locator("section.in-flight").screenshot({ path: join(SHOTS, "fg829-task-rows-in-flight.png") });

  await page.goto(`${baseUrl}/#activity`);
  await page.locator(".card a.agent .role-tile").first().waitFor();
  const feed = await tileFacts(page, ".card a.agent .role-tile");
  assert.deepEqual(feed.map((t) => [t.role, t.family, t.fill, t.width, t.beside]), [
    ["test-engineer", "test", RGB.test, 20, "test-engineer"],
    ["shipping-reviewer", "review", RGB.review, 20, "shipping-reviewer"],
  ]);
  await page.screenshot({ path: join(SHOTS, "fg829-task-rows-activity.png"), fullPage: true });
  assert.deepEqual(errors, []);
  await page.close();
});

test("FG-829: aria — a tile beside a visible name is hidden, and the link's name stays the role", async () => {
  const { page, errors } = await open("#roles", ".roles-table tbody tr");
  const exposed = await page.locator(".role-tile").evaluateAll((svgs) => svgs.filter((s) => s.getAttribute("aria-hidden") !== "true" || s.hasAttribute("role") || s.hasAttribute("aria-label")).length);
  assert.equal(exposed, 0, "every list tile is aria-hidden with no role or label");
  assert.equal(await page.locator(".roles-table").getByRole("img").count(), 0, "no tile is exposed as an image");
  const link = page.getByRole("link", { name: "red-wide", exact: true });
  assert.equal(await link.getAttribute("href"), "#roles/red-wide", "the row link's accessible name is the role alone");
  const snapshot = await page.locator('.roles-table tr[data-role="engineer"] td').first().ariaSnapshot();
  assert.match(snapshot, /link "engineer"/);
  assert.doesNotMatch(snapshot, /img/);

  await page.goto(`${baseUrl}/#home`);
  await page.locator("section.in-flight .item").first().waitFor();
  assert.equal(await page.locator("section.in-flight .role-tile:not([aria-hidden=true])").count(), 0);
  assert.equal(await page.getByRole("link", { name: "engineer", exact: true }).count(), 1, "the task link's accessible name is the role");
  assert.deepEqual(errors, []);
  await page.close();
});

test("FG-829: a standalone tile is a labelled 20px image, not a hidden decoration", async () => {
  const { page, errors } = await open("#roles", ".roles-table tbody tr");
  await page.evaluate(async (roleGlyphViewUrl) => {
    const [{ h, render }, roleGlyphView] = await Promise.all([
      import("preact"),
      import(roleGlyphViewUrl),
    ]);
    const { RoleTile } = roleGlyphView;
    const host = document.body.appendChild(document.createElement("div"));
    host.id = "fg829-standalone-tile";
    render(h(RoleTile, { role: "engineer", standalone: true }), host);
  }, "/client/role-glyph-view.js");
  const [tile] = await tileFacts(page, "#fg829-standalone-tile .role-tile");
  assert.deepEqual(
    [tile!.role, tile!.family, tile!.glyph, tile!.roleAttr, tile!.ariaHidden, tile!.width, tile!.height, tile!.fill, tile!.glyphStroke],
    ["engineer", "build", "wrench", "img", null, 20, 20, RGB.build, RGB.build]
  );
  const standalone = page.locator("#fg829-standalone-tile .role-tile");
  assert.equal(await standalone.getAttribute("aria-label"), "engineer");
  assert.equal(await standalone.locator("script, use, [onload], [onclick], [href], [xlink\\:href]").count(), 0, "the rendered standalone SVG remains inert");
  await standalone.screenshot({ path: join(SHOTS, "fg829-standalone-engineer.png") });
  assert.deepEqual(errors, []);
  await page.close();
});

function createFixtureServer(): Server {
  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    requests.push(url.pathname);
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
      json(ROLES);
      return;
    }
    const roleMatch = url.pathname.match(/^\/api\/roles\/([^/]+)$/);
    if (roleMatch) {
      const role = decodeURIComponent(roleMatch[1]!);
      if (!ROLES.roles.some((r) => r.role === role)) return json({ error: "unknown role" }, 404);
      json(detail(role));
      return;
    }
    if (url.pathname === "/api/in-flight") {
      json(IN_FLIGHT);
      return;
    }
    if (url.pathname === "/api/feed") {
      json(FEED);
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
    if (["/api/verifications/in-progress", "/api/review-loop/phases"].includes(url.pathname) || url.pathname.startsWith("/api/usage")) {
      json([]);
      return;
    }
    json({ error: "not in this fixture" }, 404);
  });
}
