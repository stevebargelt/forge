// FG-679: the RENDERED Current-activity surface, in a real Chrome.
//
// The prior lesson on this repo is that "surface X" acceptance needs HUMAN-OUTPUT
// assertions — a field present in an API response is not a surface. So every
// assertion below is over the DOM an operator actually reads:
//
//   BD-1  one `Current activity` surface with three DISTINCT sections, a host
//         launch rendered under `Host verification`, and NO agent task rendered
//         as running when the only work in flight is that launch.
//   BD-4  FOUR launch statuses render FOUR distinct strings, each BYTE-IDENTICAL
//         to `statusLine`'s output, and none of them renders as a generic
//         `failed` badge — asserted on the text AND on the badge class.
//   BD-12 a stale observation renders literally `unobserved since <t>`, and is
//         neither `running` nor any terminal status.
//   BD-5/6/8  the exact candidate sha with EVERY required context (state, URL,
//         observation time); `CI not observed` vs `CI not running` vs `stale`;
//         and an advanced candidate makes the old-sha evidence DISAPPEAR.
//   BD-10 no host filesystem path is rendered or linked.
//
// Screenshots of the populated, empty and stale states are written to
// FG679_SCREENSHOT_DIR (default: the OS temp dir) and named in the assertions'
// failure output, so the visual change is attachable.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import { renderShell } from "../src/shell.js";
import { requireChrome } from "../../src/util/chrome-bin.js";
import { statusLine, type CurrentActivity } from "@forge/current-activity";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = resolve(HERE, "..", "client");
const SHOTS = process.env.FG679_SCREENSHOT_DIR ?? join(tmpdir(), "fg679-screenshots");
mkdirSync(SHOTS, { recursive: true });

const NOW = "2026-08-05T12:00:00.000Z";
const SHA_OLD = "a".repeat(40);
const SHA_NEW = "b".repeat(40);

// The four BD-4 facts, as the derivation would carry them.
const FOUR = [
  { id: "launch-sig-aaaaaa", status: { state: "signaled", signal: "SIGTERM", sender: "unrecorded" } },
  { id: "launch-143-bbbbbb", status: { state: "terminated_unattributed", code: 143 } },
  { id: "launch-owner-cccccc", status: { state: "owner_gone", cause: "unrecorded", sender: "unrecorded" } },
  { id: "launch-unk-dddddd", status: { state: "unknown" } },
] as const;

type Activity = CurrentActivity;

function launch(over: Partial<Activity["hostVerification"][number]> & { launchId: string }): Activity["hostVerification"][number] {
  return {
    launchId: over.launchId,
    name: over.name ?? over.launchId,
    command: over.command ?? ["npm", "run", "test:worktree"],
    commandLine: over.commandLine ?? "npm run test:worktree",
    projectDir: over.projectDir ?? null,
    projectLabel: over.projectLabel ?? "forge",
    associationKind: over.associationKind ?? "explicit",
    unassociated: over.unassociated ?? false,
    placement: over.placement ?? "run",
    runId: over.runId ?? "run-fg679",
    taskId: over.taskId ?? null,
    ticketId: over.ticketId ?? "FG-679",
    campaignId: over.campaignId ?? null,
    itemId: over.itemId ?? null,
    startedAt: over.startedAt ?? "2026-08-05T11:50:00.000Z",
    observedAt: over.observedAt ?? "2026-08-05T11:59:00.000Z",
    status: over.status ?? { state: "running" },
    recordedStatus: over.recordedStatus ?? over.status ?? { state: "running" },
    statusLabel: over.statusLabel ?? statusLine(over.status ?? { state: "running" }),
    observation: over.observation ?? "fresh",
  };
}

const ci = (sha: string, state: "running" | "not_running" | "stale", label: string) => ({
  runId: "run-fg679",
  projectDir: null,
  projectLabel: "forge",
  attemptId: "attempt-1",
  ticketId: "FG-679",
  candidateSha: sha,
  observedAt: "2026-08-05T11:59:40.000Z",
  outcome: state === "not_running" ? "success" : "pending",
  unavailableReason: null,
  contexts: [
    { context: "test", state: state === "not_running" ? "success" : "pending", url: "https://example.invalid/checks/1", observedAt: "2026-08-05T11:59:30.000Z" },
    { context: "test-extended", state: state === "not_running" ? "success" : "queued", url: "https://example.invalid/checks/2", observedAt: "2026-08-05T11:59:31.000Z" },
  ],
  state,
  label,
});

const base = (over: Partial<Activity>): Activity => ({
  generatedAt: NOW,
  scope: { runId: "run-fg679", projectDirs: null },
  agents: over.agents ?? [],
  hostVerification: over.hostVerification ?? [],
  requiredCi: over.requiredCi ?? { state: "not_observed", label: "CI not observed", observations: [] },
  unassociated: over.unassociated ?? [],
});

/** The payload the fixture server serves for /api/current-activity. */
let served: Activity = base({});

let server: Server;
let browser: Browser;
let baseUrl = "";

before(async () => {
  server = createFixtureServer();
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  baseUrl = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ executablePath: requireChrome("the dashboard browser tier"), headless: true });
});

after(async () => {
  await browser?.close();
  server?.closeAllConnections?.();
  await new Promise<void>((closed) => server?.close(() => closed()));
});

/** Section headings as AUTHORED. `innerText` would return the CSS-uppercased form. */
async function sectionHeadings(page: Page): Promise<string[]> {
  return page.locator("section.current-activity .ca-heading").evaluateAll((els) => els.map((e) => e.textContent ?? ""));
}

async function open(): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1200 }, reducedMotion: "reduce" });
  await page.goto(`${baseUrl}/`);
  await page.locator("section.current-activity").waitFor();
  return page;
}

test("FG-679 BD-1: ONE Current activity surface with three DISTINCT sections; a host launch renders under Host verification and NO agent reads as running", async () => {
  served = base({ hostVerification: [launch({ launchId: "launch-worktree-8pagjk" })] });
  const page = await open();

  assert.equal(await page.locator("section.current-activity").count(), 1, "exactly one Current activity surface");
  // textContent, not innerText: the shell uppercases headings via CSS
  // `text-transform`, and the assertion is about the words the surface carries.
  assert.equal(await page.locator("#current-activity-heading").textContent(), "Current activity");
  assert.deepEqual(await sectionHeadings(page), ["Agents", "Host verification", "Required CI"], "three distinct sections, in order");

  // The launch is under Host verification — and only there.
  const hostSection = page.locator("section.current-activity section.ca-section").nth(1);
  await hostSection.locator(".ca-launch-row").first().waitFor();
  assert.match(await hostSection.innerText(), /launch-worktree-8pagjk/);
  assert.match(await hostSection.innerText(), /npm run test:worktree/);

  // The Agents section says so explicitly rather than being silently empty, and NO
  // agent task is rendered as running.
  const agentSection = page.locator("section.current-activity section.ca-section").nth(0);
  assert.match(await agentSection.innerText(), /No agent task in flight\./);
  assert.equal(await agentSection.locator(".ca-row").count(), 0);

  await page.screenshot({ path: join(SHOTS, "fg679-populated.png"), fullPage: true });
  await page.close();
});

test("FG-679 BD-4: four launch statuses render four DISTINCT strings, byte-identical to statusLine, and NONE is a generic `failed` badge", async () => {
  served = base({ hostVerification: FOUR.map((f) => launch({ launchId: f.id, status: f.status as never })) });
  const page = await open();
  const hostSection = page.locator("section.current-activity section.ca-section").nth(1);
  await hostSection.locator(".ca-launch-row").nth(3).waitFor();

  const badges = hostSection.locator(".ca-launch-row > .badge");
  const texts = await badges.allInnerTexts();
  assert.equal(texts.length, 4);
  assert.equal(new Set(texts).size, 4, `four DISTINCT rendered strings, got ${JSON.stringify(texts)}`);

  // Byte-identical to the ONE human rendering.
  assert.deepEqual(texts, FOUR.map((f) => statusLine(f.status as never)));
  assert.equal(texts[0], "terminated by SIGTERM (signal sender not recorded — origin unknown)");
  assert.equal(texts[1], "exited 143 (signal-range code, no signal evidence — origin unknown)");

  // None renders as a generic `failed` badge — neither in the text nor in the class
  // that colours it.
  const classes = await badges.evaluateAll((els) => els.map((e) => e.className));
  assert.equal(new Set(classes).size, 4, `four distinct badge classes, got ${JSON.stringify(classes)}`);
  for (const c of classes) assert.doesNotMatch(c, /\bstatus-failed\b|\bfailed\b/, `badge class must not be a generic failure: ${c}`);
  for (const t of texts) {
    assert.notEqual(t.trim().toLowerCase(), "failed");
    assert.doesNotMatch(t, /^\s*failed\b/i);
  }

  await page.screenshot({ path: join(SHOTS, "fg679-four-statuses.png"), fullPage: true });
  await page.close();
});

test("FG-679 BD-12: a stale observation renders literally `unobserved since <t>` — neither running nor any terminal status", async () => {
  const observedAt = "2026-08-05T06:00:00.000Z";
  served = base({
    hostVerification: [launch({
      launchId: "launch-stale-eeeeee",
      status: { state: "unknown" },
      recordedStatus: { state: "running" },
      statusLabel: `unobserved since ${observedAt}`,
      observation: "unobserved",
      observedAt,
    })],
  });
  const page = await open();
  const badge = page.locator("section.current-activity .ca-launch-row > .badge").first();
  await badge.waitFor();

  const text = await badge.innerText();
  assert.equal(text, `unobserved since ${observedAt}`);
  assert.notEqual(text, "running");
  for (const terminal of [
    statusLine({ state: "exited_ok", code: 0 }),
    statusLine({ state: "exited_error", code: 1 }),
    statusLine({ state: "signaled", signal: "SIGTERM", sender: "unrecorded" }),
    statusLine({ state: "terminated_unattributed", code: 143 }),
    statusLine({ state: "owner_gone", cause: "unrecorded", sender: "unrecorded" }),
    statusLine({ state: "unknown" }),
  ]) {
    assert.notEqual(text, terminal, "a stale observation is never rendered as a terminal disposition");
  }
  assert.match(await badge.getAttribute("class") ?? "", /launch-state-unobserved/);

  await page.screenshot({ path: join(SHOTS, "fg679-stale.png"), fullPage: true });
  await page.close();
});

test("FG-679 BD-5: the Required CI section names the exact candidate sha and enumerates EVERY context with state, URL and observation time", async () => {
  served = base({ requiredCi: { state: "observed", label: "1 observed", observations: [ci(SHA_OLD, "running", "CI running")] } });
  const page = await open();
  const ciSection = page.locator("section.current-activity section.ca-section").nth(2);
  await ciSection.locator(".ca-ci-row").waitFor();
  const text = await ciSection.innerText();

  assert.match(text, new RegExp(SHA_OLD), "the FULL candidate sha is named");
  assert.equal(await ciSection.locator(".ca-ci-context").count(), 2, "EVERY required context is enumerated — a summary verdict does not satisfy BD-5");
  assert.deepEqual(await ciSection.locator(".ca-ctx-name").allInnerTexts(), ["test", "test-extended"]);
  assert.deepEqual(await ciSection.locator(".ca-ctx-state").allInnerTexts(), ["pending", "queued"]);
  assert.deepEqual(
    await ciSection.locator(".ca-ctx-url").evaluateAll((els) => els.map((e) => (e as HTMLAnchorElement).href)),
    ["https://example.invalid/checks/1", "https://example.invalid/checks/2"],
  );
  assert.match(text, /observed 2026-08-05T11:59:30\.000Z/);
  assert.match(text, /observed 2026-08-05T11:59:31\.000Z/);
  await page.close();
});

test("FG-679 BD-6: when the candidate moves, the old-sha evidence DISAPPEARS from the surface", async () => {
  served = base({ requiredCi: { state: "observed", label: "1 observed", observations: [ci(SHA_OLD, "running", "CI running")] } });
  const page = await open();
  await page.locator(".ca-ci-row").waitFor();
  assert.match(await page.locator("section.current-activity").innerText(), new RegExp(SHA_OLD));

  // The observer declares a NEWER candidate; the reader presents only the newest.
  served = base({ requiredCi: { state: "observed", label: "1 observed", observations: [ci(SHA_NEW, "running", "CI running")] } });
  await page.waitForFunction((sha) => document.querySelector("section.current-activity")?.textContent?.includes(sha), SHA_NEW, { timeout: 10_000 });

  const text = await page.locator("section.current-activity").innerText();
  assert.match(text, new RegExp(SHA_NEW));
  assert.doesNotMatch(text, new RegExp(SHA_OLD), "the superseded sha must be GONE — never carried forward, never relabeled");
  await page.close();
});

test("FG-679 BD-8: `CI not observed`, `CI not running` and `stale` are three DIFFERENT rendered facts", async () => {
  served = base({});
  let page = await open();
  await page.locator(".ca-ci-empty").waitFor();
  const notObserved = await page.locator(".ca-ci-empty").innerText();
  assert.equal(notObserved, "CI not observed");
  await page.screenshot({ path: join(SHOTS, "fg679-empty.png"), fullPage: true });
  await page.close();

  served = base({ requiredCi: { state: "observed", label: "1 observed", observations: [ci(SHA_NEW, "not_running", "CI not running")] } });
  page = await open();
  await page.locator(".ca-ci-row > .badge").waitFor();
  const notRunning = await page.locator(".ca-ci-row > .badge").innerText();
  assert.equal(notRunning, "CI not running");
  assert.notEqual(notRunning, notObserved, "not-observed and not-running are different facts");
  await page.close();

  served = base({ requiredCi: { state: "observed", label: "1 observed", observations: [ci(SHA_NEW, "stale", "stale — CI last observed 2026-08-05T09:00:00.000Z")] } });
  page = await open();
  await page.locator(".ca-ci-row > .badge").waitFor();
  const stale = await page.locator(".ca-ci-row > .badge").innerText();
  assert.match(stale, /^stale — CI last observed /);
  assert.notEqual(stale, notRunning);
  assert.notEqual(stale, notObserved);
  assert.match(await page.locator(".ca-ci-row > .badge").getAttribute("class") ?? "", /ci-state-stale/);
  await page.close();
});

test("FG-679 BD-3/BD-14: an unassociated launch is LABELED, and a host-level bucket renders separately", async () => {
  served = base({
    hostVerification: [launch({ launchId: "launch-cwd-ffffff", associationKind: "cwd", unassociated: true, placement: "project", runId: null })],
    unassociated: [launch({ launchId: "launch-orphan-gggggg", associationKind: "none", unassociated: true, placement: "host", runId: null, projectLabel: null, ticketId: null })],
  });
  const page = await open();
  await page.locator(".ca-assoc-badge").first().waitFor();

  assert.equal(await page.locator(".ca-assoc-badge").first().textContent(), "unassociated");
  assert.deepEqual(await sectionHeadings(page), ["Agents", "Host verification", "Required CI", "Unassociated activity"]);
  const bucket = page.locator("section.current-activity section.ca-section").nth(3);
  assert.match(await bucket.innerText(), /launch-orphan-gggggg/);
  assert.match(await bucket.innerText(), /will not guess an owner from a launch name, its argv, or its log/);
  await page.close();
});

test("FG-679 BD-10: no host filesystem path is rendered or linked, and the surface is read-only", async () => {
  served = base({
    hostVerification: [launch({ launchId: "launch-worktree-hhhhhh" })],
    requiredCi: { state: "observed", label: "1 observed", observations: [ci(SHA_NEW, "running", "CI running")] },
  });
  const page = await open();
  await page.locator(".ca-launch-row").waitFor();

  const text = await page.locator("section.current-activity").innerText();
  assert.doesNotMatch(text, /\/Users\//, "no host path in the rendered text");
  assert.doesNotMatch(text, /\/home\/[a-z]/, "no host path in the rendered text");
  assert.doesNotMatch(text, /\.forge\/launches/, "no launch directory path is rendered");

  // Every link is an off-host check URL — no file:// and no local path link.
  const hrefs = await page.locator("section.current-activity a").evaluateAll((els) => els.map((e) => (e as HTMLAnchorElement).href));
  for (const href of hrefs) {
    assert.match(href, /^https?:\/\//, `a rendered link must not address a host path: ${href}`);
  }

  // Read-only: no start/stop/retry affordance anywhere in the surface.
  assert.equal(await page.locator("section.current-activity button").count(), 0, "the surface exposes no action buttons");
  await page.close();
});

test("FG-679: the screenshots for the populated, empty and stale states exist", () => {
  for (const name of ["fg679-populated.png", "fg679-empty.png", "fg679-stale.png", "fg679-four-statuses.png"]) {
    assert.ok(existsSync(join(SHOTS, name)), `expected screenshot ${join(SHOTS, name)}`);
  }
  console.log(`FG-679 screenshots: ${SHOTS}`);
});

function createFixtureServer(): Server {
  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(renderShell());
      return;
    }
    if (url.pathname.startsWith("/client/")) {
      const filePath = resolve(CLIENT_DIR, url.pathname.slice("/client/".length));
      if (!filePath.startsWith(`${CLIENT_DIR}/`) || !existsSync(filePath)) {
        res.writeHead(404).end();
        return;
      }
      const contentType = filePath.endsWith(".js") ? "application/javascript; charset=utf-8"
        : filePath.endsWith(".png") ? "image/png"
          : filePath.endsWith(".svg") ? "image/svg+xml"
            : "application/octet-stream";
      res.writeHead(200, { "Content-Type": contentType }).end(readFileSync(filePath));
      return;
    }
    if (url.pathname === "/api/current-activity") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(served));
      return;
    }
    if (url.pathname === "/api/usage/limits") {
      res.writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify({ generatedAt: new Date(0).toISOString(), services: [] }));
      return;
    }
    if (url.pathname === "/api/ops") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
        runs: { total: 0, active: 0, terminal: 0, clean: 0, withFailures: 0, successRate: 0 },
        taskCount: 0, counts: { idleKills: 0, cancels: 0, retries: 0, redBlocks: 0 },
        failureKinds: [], durations: [],
      }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" }).end("[]");
  });
}
