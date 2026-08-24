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
//
// FG-694 (wave B) RESHAPED HOME, and this suite moved with it — every BD above is
// still asserted, through the surface as it is now:
//
//   - an EMPTY section does not render at all (AC6), so the assertions read the
//     sections that exist rather than counting on three fixed slots. `No agent task
//     in flight.` is gone from Home on purpose; it is a claim Home now only makes by
//     saying `Nothing currently running.` after a successful read.
//   - a current CI candidate is ONE compact line (AC4); the exact sha, the per-context
//     state, the check URLs and the observation times are behind a <details>
//     disclosure. So the BD-5 assertions OPEN the disclosure first. That is the point
//     of AC5 — the evidence MOVED, it was not deleted — and this test is what proves
//     it: every field FG-679 required is still here, one click away.
//
// The FG-694 POST-SHIP CORRECTION then moved this panel OFF HOME. Home and Activity
// each have one visible activity surface — `In flight` — and fold only the compact
// host/CI WAITS into it. What is asserted here is the DIAGNOSTIC panel behind
// Activity's explicit disclosure; it never owns agent rows.
// Every BD above still holds of it, unchanged, which is what makes "the evidence moved,
// it was not deleted" a checkable claim rather than a reassurance. Home's own shape is
// asserted in fg694-home-in-flight.test.ts.
//
// `forge status` (renderCurrentActivityLines) is unchanged and remains the surface
// where the three sections are a fixed shape read top to bottom.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import { renderShell } from "../src/shell.js";
import { CHROME_LAUNCH_ARGS, requireChrome } from "../../src/util/chrome-bin.js";
import { makeInMemoryDb } from "../../src/store/db.js";
import { deriveCurrentActivity } from "../../src/v2/current-activity.js";
import { statusLine, type CurrentActivity } from "@forge/current-activity";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = resolve(HERE, "..", "client");
const SHOTS = process.env.FG679_SCREENSHOT_DIR ?? join(tmpdir(), "fg679-screenshots");
mkdirSync(SHOTS, { recursive: true });

const NOW = "2026-08-05T12:00:00.000Z";
const SHA_OLD = "a".repeat(40);
const SHA_NEW = "b".repeat(40);
const FG694_NOW = new Date("2026-08-08T12:00:00.000Z");
const FG694_HISTORICAL = ["FG-686", "FG-576", "MG-51", "FG-591", "FG-689", "FG-584", "FG-685", "FG-610", "FG-655", "FG-684"];
const FG694_CURRENT_SHA = "c".repeat(40);

/**
 * AC8's reported production shape, intentionally constructed in the browser
 * fixture through the real derivation.  Supplying only its already-filtered API
 * result would let a renderer test pass even if the selection layer had quietly
 * started carrying historical observations forward again.
 */
function fg694ReportedShape(): Activity {
  const db = makeInMemoryDb();
  const ago = (ms: number): string => new Date(FG694_NOW.getTime() - ms).toISOString();
  const addRun = (id: string, status: string): void => {
    db.prepare(`INSERT INTO runs (id, workflow, title, status, created_at, project_dir) VALUES (?, 'feature', ?, ?, ?, ?)`)
      .run(id, `run ${id}`, status, ago(7 * 24 * 3_600_000), "/repos/forge");
  };
  const addReview = (id: string, runId: string, ticketId: string, state: string): void => {
    db.prepare(`INSERT INTO reviews (id, run_id, ticket_id, workspace_dir, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, runId, ticketId, "/repos/forge", state, ago(3_600_000), ago(60_000));
  };
  const addCi = (runId: string, ticketId: string, sha: string, observedAt: string): void => {
    const contexts = Array.from({ length: 10 }, (_value, i) => ({
      context: `check-${i}`,
      state: i < 7 ? "success" : "pending",
      url: `https://github.com/o/r/actions/runs/${ticketId}-${i}`,
      observedAt,
    }));
    db.prepare(`INSERT INTO events (run_id, task_id, event_type, payload, created_at) VALUES (?, NULL, 'review_loop.ci_observed', ?, ?)`)
      .run(runId, JSON.stringify({
        attemptId: `attempt-${ticketId}`,
        ticketId,
        projectDir: "/repos/forge",
        candidateSha: sha,
        observedAt,
        outcome: "pending",
        unavailableReason: null,
        contexts,
      }), observedAt);
  };

  const terminal = ["complete", "failed", "abandoned"];
  FG694_HISTORICAL.forEach((ticket, i) => {
    const runId = `run-${ticket.toLowerCase()}`;
    addRun(runId, terminal[i % terminal.length]!);
    addReview(`review-${ticket}`, runId, ticket, "settled");
    addCi(runId, ticket, `${i}`.repeat(2).padEnd(40, "a"), ago(2 * 3_600_000 + i * 60_000));
  });
  addRun("run-fg694", "active");
  addReview("review-FG-694", "run-fg694", "FG-694", "verifying");
  addCi("run-fg694", "FG-694", FG694_CURRENT_SHA, ago(30_000));

  try {
    return deriveCurrentActivity(db, { now: FG694_NOW }) as Activity;
  } finally {
    db.close();
  }
}

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
    // FG-700: this file's launches ARE the host-verification fixtures, so the default
    // DECLARES that purpose rather than leaving it to be inferred from the association
    // — which is the inference FG-700 removed.
    purpose: over.purpose ?? "host_verification",
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

// FG-731: a registered CI wait fixture, mirroring CiWaitActivity from the derivation.
function ciWait(over: Partial<Activity["ciWaits"][number]> & { waitId: string }): Activity["ciWaits"][number] {
  return {
    waitId: over.waitId,
    kind: over.kind ?? "workflow_dispatch",
    url: over.url ?? "https://github.com/o/r/actions/runs/999",
    startedAt: over.startedAt ?? "2026-08-05T11:50:00.000Z",
    observedAt: over.observedAt ?? "2026-08-05T11:59:40.000Z",
    placement: over.placement ?? "host",
    runId: over.runId ?? null,
    ticketId: over.ticketId ?? "FG-704",
    projectDir: over.projectDir ?? null,
    projectLabel: over.projectLabel ?? "forge",
    lifecycleState: over.lifecycleState ?? "running",
    observedState: over.observedState ?? "running",
    observedReason: over.observedReason ?? null,
    m: over.m ?? 1,
    n: over.n ?? 4,
    observation: over.observation ?? "fresh",
    displayState: over.displayState ?? "running",
    statusLabel: over.statusLabel ?? "CI running 1/4",
  };
}

const base = (over: Partial<Activity>): Activity => ({
  generatedAt: NOW,
  scope: { runId: "run-fg679", projectDirs: null },
  agents: over.agents ?? [],
  hostVerification: over.hostVerification ?? [],
  launches: over.launches ?? [],
  // FG-694: the honest default for a fixture that declares no CI at all is "nothing
  // in scope could be waiting on required checks" — not "we observed no CI", which
  // is a claim about an observer that was never asked.
  requiredCi: over.requiredCi ?? { state: "no_current_candidate", label: "no current CI candidate", observations: [] },
  ciWaits: over.ciWaits ?? [],
  operatorWaits: over.operatorWaits ?? [],
  unassociated: over.unassociated ?? [],
});

/** The payload the fixture server serves for /api/current-activity. */
let served: Activity = base({});
/** The task feed is separate from Current activity on purpose: Home owns agent rows,
 * while Activity owns the diagnostic operator-wait evidence. */
let inFlight: unknown[] = [];
/** FG-694 AC7: the STATUS the fixture answers with. 404 is the reproduced version
 *  skew — a dashboard server that predates the route. */
let currentActivityStatus = 200;
/** FG-694 AC7 (RF-3): a 200 body served VERBATIM. A structurally malformed payload —
 *  an entry that is `null` where a row belongs — has to reach the client exactly as a
 *  partial write or a skewed server would produce it, rather than being normalized by
 *  the fixture's own typing on the way out. */
let servedRawBody: string | null = null;

let server: Server;
let browser: Browser;
let baseUrl = "";

before(async () => {
  server = createFixtureServer();
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  baseUrl = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ executablePath: requireChrome("the dashboard browser tier"), headless: true, args: CHROME_LAUNCH_ARGS });
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

/** The view the `Current activity` panel lives on since the FG-694 post-ship
 *  correction. It was on Home, above `In flight`; Home now has ONE activity surface and
 *  folds only the compact waits into it (dashboard/browser-tests/fg694-home-in-flight),
 *  so the diagnostic panel every assertion here is about renders on Activity. Nothing
 *  below changed except WHERE it is read — which is exactly what "the evidence moved,
 *  it was not deleted" has to mean if it means anything. */
const ACTIVITY_VIEW = "#activity";

async function open(): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1200 }, reducedMotion: "reduce" });
  await page.goto(`${baseUrl}/${ACTIVITY_VIEW}`);
  await page.locator("details.activity-diagnostics > summary").click();
  await page.locator("section.in-flight").first().waitFor();
  await page.waitForFunction(() => document.querySelector(".ca-loading") === null);
  return page;
}

/** FG-694: the per-context evidence lives behind a disclosure. Opening it is what an
 *  operator does to diagnose, and what AC5 says must still be possible. */
async function openCiDetails(page: Page): Promise<void> {
  await page.locator(".ca-ci-summary").first().waitFor();
  await page.locator("details.ca-ci-item").evaluateAll((els) => els.forEach((e) => ((e as HTMLDetailsElement).open = true)));
  await page.locator(".ca-ci-evidence").first().waitFor();
}

test("FG-679 BD-1: ONE Current activity surface with DISTINCT sections; a host launch renders under Host verification and NO agent reads as running", async () => {
  served = base({ hostVerification: [launch({ launchId: "launch-worktree-8pagjk" })] });
  const page = await open();

  assert.equal(await page.locator("section.current-activity").count(), 1, "exactly one Current activity surface");
  // textContent, not innerText: the shell uppercases headings via CSS
  // `text-transform`, and the assertion is about the words the surface carries.
  assert.equal(await page.locator("#current-activity-heading").textContent(), "Current activity");
  // FG-694 AC6: only the POPULATED section renders. The launch is host verification
  // and is labeled as such — that is BD-1's claim, and it does not need two empty
  // siblings to make it.
  assert.deepEqual(await sectionHeadings(page), ["Host verification"]);

  const hostSection = page.locator("section.current-activity section.ca-section").first();
  await hostSection.locator(".ca-launch-row").first().waitFor();
  assert.match(await hostSection.innerText(), /launch-worktree-8pagjk/);
  assert.match(await hostSection.innerText(), /npm run test:worktree/);

  // NO agent task is rendered as running — a launch is never represented as one.
  assert.equal(await page.locator(".ca-agent-row").count(), 0);
  // …and Home does not claim it LOOKED and found no agent, either: with a launch in
  // flight there is nothing to say about agents (FG-694 AC6/AC7).
  const surface = await page.locator("section.current-activity").innerText();
  assert.doesNotMatch(surface, /No agent task in flight/);
  assert.doesNotMatch(surface, /Nothing currently running/, "something IS running");

  await page.screenshot({ path: join(SHOTS, "fg679-populated.png"), fullPage: true });
  await page.close();
});

test("FG-700 AC7: the served mixed-launch payload renders one real verification separately from every associated launch diagnostic", async () => {
  // This is the live 2026-08-10 shape at the browser boundary.  The payload has
  // already passed through the shared derivation (covered at its own boundary);
  // this assertion proves the Activity view does not undo that classification while
  // rendering it.  In particular, all of these rows carry the same run association
  // as the one verification, so a renderer that grouped by association would fail.
  const diagnostics = [
    launch({ launchId: "launch-engineer-fg700", name: "engineer", purpose: "agent_invoke", commandLine: "forge invoke engineer" }),
    launch({ launchId: "launch-tester-fg700", name: "test-engineer", purpose: "agent_invoke", commandLine: "forge invoke test-engineer" }),
    launch({ launchId: "launch-docs-fg700", name: "documentation-maintainer", purpose: "agent_invoke", commandLine: "forge invoke documentation-maintainer" }),
    launch({ launchId: "launch-review-start-fg700", name: "review-start", purpose: "review", commandLine: "forge review start FG-700" }),
    launch({ launchId: "launch-review-continue-fg700", name: "review-continue", purpose: "review", commandLine: "forge review continue FG-700" }),
    launch({ launchId: "launch-campaign-fg700", name: "campaign", purpose: "campaign", commandLine: "forge campaign drive-item camp item" }),
  ];
  served = base({
    hostVerification: [launch({ launchId: "launch-verify-fg700", name: "real verification", purpose: "host_verification" })],
    launches: diagnostics,
  });

  const page = await open();
  assert.deepEqual(await sectionHeadings(page), ["Host verification", "Launch activity"]);
  const sections = page.locator("section.current-activity section.ca-section");
  const verification = sections.nth(0);
  const diagnosticsSection = sections.nth(1);
  assert.equal(await verification.locator(".ca-launch-row").count(), 1, "exactly one declared verification is an in-flight wait");
  assert.match(await verification.innerText(), /launch-verify-fg700/);

  const diagnosticText = await diagnosticsSection.innerText();
  assert.equal(await diagnosticsSection.locator(".ca-launch-row").count(), diagnostics.length, "no associated launch is lost when its label narrows");
  for (const row of diagnostics) {
    assert.match(diagnosticText, new RegExp(row.launchId));
  }
  assert.doesNotMatch(diagnosticText, /launch-verify-fg700/, "the verification is represented exactly once");
  assert.doesNotMatch(await verification.innerText(), /launch-(engineer|tester|docs|review|campaign)-fg700/,
    "association never promotes an agent, review, or campaign launch into Host verification");
  await page.screenshot({ path: join(SHOTS, "fg700-mixed-launches.png"), fullPage: true });
  await page.close();
});

test("FG-679 BD-4: four launch statuses render four DISTINCT strings, byte-identical to statusLine, and NONE is a generic `failed` badge", async () => {
  served = base({ hostVerification: FOUR.map((f) => launch({ launchId: f.id, status: f.status as never })) });
  const page = await open();
  const hostSection = page.locator("section.current-activity section.ca-section").first();
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

test("FG-679 BD-5 / FG-694 AC4-AC5/AC8: the reported ten-run historical-noise shape leaves one compact current CI row, with evidence only behind its disclosure", async () => {
  const derived = fg694ReportedShape();
  // The real selection layer must discard the ten terminal candidates BEFORE Home
  // sees the payload.  Keep agents and launches populated too, so the browser
  // proves the compact hierarchy's authored order under the reported CI load.
  served = {
    ...derived,
    agents: [{
      runId: "run-fg694", runTitle: "make Home compact and honest", workflow: "feature",
      projectDir: "/repos/forge", projectLabel: "forge", taskId: "task-build-aef6ae",
      agentRole: "engineer", agentModel: null, phase: "build", status: "running", startedAt: "2026-08-08T11:50:00.000Z",
    }],
    hostVerification: [launch({ launchId: "launch-fg694-current", runId: "run-fg694", ticketId: "FG-694" })],
  };
  const page = await open();
  assert.deepEqual(await sectionHeadings(page), ["Host verification", "CI checks"], "agent work belongs only to In flight; diagnostic sections retain their fixed order");
  const ciSection = page.locator("section.current-activity section.ca-section").nth(1);
  await ciSection.locator(".ca-ci-summary").waitFor();

  // AC4/AC8: ONE compact line after the reported ten terminal rows were supplied
  // to the derivation, and no audit payload on the summary.
  assert.equal(await ciSection.locator(".ca-ci-summary").count(), 1);
  const compact = await ciSection.locator(".ca-ci-summary").innerText();
  assert.match(compact, /FG-694/, "the current candidate is named by its ticket");
  assert.match(compact, /CI running/);
  assert.match(compact, /7\/10 complete/, "the compact row retains a useful progress summary");
  assert.doesNotMatch(compact, new RegExp(FG694_CURRENT_SHA), "the full sha is drill-down detail");
  assert.doesNotMatch(compact, /github\.com\/o\/r\/actions/, "check URLs are drill-down detail");
  assert.doesNotMatch(compact, /2026-08-08T11:59:30/, "raw observation timestamps are drill-down detail");
  const wholeSurface = await page.locator("section.current-activity").innerText();
  for (const ticket of FG694_HISTORICAL) assert.doesNotMatch(wholeSurface, new RegExp(ticket), `${ticket} is historical noise, never current Home content`);

  // AC5: the evidence MOVED, it was not deleted. Everything BD-5 requires is one
  // disclosure away.
  await openCiDetails(page);
  const text = await ciSection.innerText();

  assert.match(text, new RegExp(FG694_CURRENT_SHA), "the FULL candidate sha is named");
  assert.equal(await ciSection.locator(".ca-ci-context").count(), 10, "EVERY required context is reachable — a summary verdict does not satisfy AC5");
  assert.deepEqual(await ciSection.locator(".ca-ctx-name").allInnerTexts(), Array.from({ length: 10 }, (_value, i) => `check-${i}`));
  assert.equal((await ciSection.locator(".ca-ctx-url").all()).length, 10, "every context retains its diagnostic URL");
  assert.match(text, /observed 2026-08-08T11:59:30\.000Z/);
  await page.screenshot({ path: join(SHOTS, "fg694-historical-noise-current.png"), fullPage: true });
  await page.close();
});

test("FG-679 BD-6: when the candidate moves, the old-sha evidence DISAPPEARS from the surface", async () => {
  served = base({ requiredCi: { state: "observed", label: "1 observed", observations: [ci(SHA_OLD, "running", "CI running")] } });
  const page = await open();
  await openCiDetails(page);
  assert.match(await page.locator("section.current-activity").innerText(), new RegExp(SHA_OLD));

  // The observer declares a NEWER candidate; the reader presents only the newest.
  served = base({ requiredCi: { state: "observed", label: "1 observed", observations: [ci(SHA_NEW, "running", "CI running")] } });
  await page.waitForFunction((sha) => document.querySelector("section.current-activity")?.textContent?.includes(sha), SHA_NEW, { timeout: 10_000 });

  // Read the WHOLE surface with the disclosure open — a superseded sha hidden behind
  // a collapsed <details> would still be carried forward, which is what BD-6 forbids.
  await openCiDetails(page);
  const text = await page.locator("section.current-activity").innerText();
  assert.match(text, new RegExp(SHA_NEW));
  assert.doesNotMatch(text, new RegExp(SHA_OLD), "the superseded sha must be GONE — never carried forward, never relabeled");
  await page.close();
});

// The FIVE absences this surface can be in, asserted together and deliberately in
// ONE test: they are only meaningful against each other, and `forge` pins this
// suite's test count in src/util/fg642-browser-tier-consistency.test.ts, so a new
// top-level test here is a change to the browser tier's shape rather than to its
// coverage. Nothing current / current-but-unobserved / settled / stale / could-not-read.
test("FG-679 BD-8 / FG-694 AC6+AC7: no-candidate, not-observed, settled, stale and could-not-read stay DIFFERENT rendered facts", async () => {
  // (a) NOTHING current at all. In flight owns the one calm empty state; the
  //     diagnostic disclosure renders no empty panel or subsections.
  served = base({ requiredCi: { state: "no_current_candidate", label: "no current CI candidate", observations: [] } });
  let page = await open();
  assert.equal(await page.locator("section.current-activity").count(), 0);
  assert.match(await page.locator("section.in-flight").first().innerText(), /No live tasks/);
  assert.deepEqual(await sectionHeadings(page), [], "the headings themselves must not render when empty");
  await page.screenshot({ path: join(SHOTS, "fg679-empty.png"), fullPage: true });
  await page.close();

  // (b) There IS current work owed an observation, and none exists. Home says the
  //     STATUS is unavailable. `CI not observed` was, host-wide, reading as a claim
  //     about the checks — it stays on the diagnostic surface (`forge status`).
  served = base({ requiredCi: { state: "not_observed", label: "CI not observed", observations: [] } });
  page = await open();
  await page.locator(".ca-ci-row > .badge").waitFor();
  const notObserved = await page.locator(".ca-ci-row > .badge").innerText();
  assert.equal(notObserved, "CI status unavailable");
  assert.doesNotMatch(await page.locator("section.current-activity").innerText(), /CI not observed/);
  assert.doesNotMatch(await page.locator("section.current-activity").innerText(), /Nothing currently running/);
  assert.equal(await page.locator("details.ca-ci-item").count(), 0, "nothing was observed, so there is nothing to open");
  await page.close();

  // (c) The observer's newest look found every required context settled.
  served = base({ requiredCi: { state: "observed", label: "1 observed", observations: [ci(SHA_NEW, "not_running", "CI not running")] } });
  page = await open();
  await page.locator(".ca-ci-summary .badge").waitFor();
  const settled = await page.locator(".ca-ci-summary .badge").innerText();
  assert.equal(settled, "CI passed");
  assert.notEqual(settled, notObserved, "not-observed and a settled candidate are different facts");
  await openCiDetails(page);
  assert.deepEqual(await page.locator(".ca-ctx-state").allInnerTexts(), ["success", "success"], "the per-context evidence survives");
  await page.close();

  // (d) The newest observation is too old to be evidence about NOW. Compact, that is
  //     "we do not know" — and the disclosure still carries WHEN we last knew, which
  //     is the distinction BD-8 is about and the place diagnosis happens.
  served = base({ requiredCi: { state: "observed", label: "1 observed", observations: [ci(SHA_NEW, "stale", "stale — CI last observed 2026-08-05T09:00:00.000Z")] } });
  page = await open();
  await page.locator(".ca-ci-summary .badge").waitFor();
  const stale = await page.locator(".ca-ci-summary .badge").innerText();
  assert.equal(stale, "CI status unavailable");
  assert.notEqual(stale, settled);
  assert.match(await page.locator(".ca-ci-summary .badge").getAttribute("class") ?? "", /ci-compact-unavailable/);
  await openCiDetails(page);
  assert.match(await page.locator(".ca-ci-evidence").innerText(), /observed 2026-08-05T11:59:40\.000Z/,
    "stale and never-observed are told apart by the evidence, which is still there");
  await page.close();

  // (e) FG-694 AC7 — the reproduced version skew: a dashboard server started before
  //     FG-679 serves this client and 404s /api/current-activity. The client used to
  //     ignore that and render `loading…`, `No agent task in flight`, `No host launch
  //     observed in flight` AND `CI not observed` simultaneously, while `forge status`
  //     showed an active orchestrator task. A read that FAILED has observed nothing.
  currentActivityStatus = 404;
  try {
    page = await open();
    await page.locator(".ca-unavailable").waitFor();
    const text = await page.locator("section.current-activity").innerText();
    assert.match(text, /Current activity unavailable/);
    assert.match(text, /predates the route/);
    for (const claim of ["No agent task in flight", "No host launch observed", "CI not observed", "Nothing currently running"]) {
      assert.doesNotMatch(text, new RegExp(claim), `a failed read may not claim "${claim}"`);
    }
    assert.notEqual(text, notObserved, "could-not-read is not the same fact as observed-nothing");
    assert.equal(await page.locator("section.current-activity .ca-retry").count(), 1, "the diagnostic recovery is not a page reload");
    assert.equal(await page.locator(".ca-heading").count(), 0);
    await page.screenshot({ path: join(SHOTS, "fg694-unavailable.png"), fullPage: true });
    await page.close();
  } finally {
    currentActivityStatus = 200;
  }
});

test("FG-694 AC7 (RF-3): a 200 whose ENTRIES are malformed renders the unavailable state — the surface never breaks mid-render", async () => {
  // A syntactically valid 200 carrying `agents: [null]`. The container-only validator
  // called this `ready`, and the row build then threw on `a.taskId` — leaving the
  // operator with neither the activity nor the explicit unavailable state and its
  // Retry. A thrown render is the one outcome AC7 has no state for.
  servedRawBody = JSON.stringify({
    generatedAt: NOW,
    scope: { runId: null, projectDirs: null },
    agents: [null],
    hostVerification: [],
    requiredCi: { state: "no_current_candidate", label: "no current CI candidate", observations: [] },
    unassociated: [],
  });
  try {
    // Not `open()`: the listener has to be attached BEFORE the first render, which is
    // where the throw happened.
    const page = await browser.newPage({ viewport: { width: 1280, height: 1200 }, reducedMotion: "reduce" });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(`${baseUrl}/${ACTIVITY_VIEW}`);
    await page.locator("details.activity-diagnostics > summary").click();
    await page.locator("section.current-activity").waitFor();
    await page.locator(".ca-unavailable").waitFor();

    const text = await page.locator("section.current-activity").innerText();
    assert.match(text, /Current activity unavailable/);
    assert.match(text, /could not read/, "the detail is about the READ, never about the work");
    for (const claim of ["No agent task in flight", "No host launch observed", "CI not observed", "Nothing currently running"]) {
      assert.doesNotMatch(text, new RegExp(claim), `a malformed read may not claim "${claim}"`);
    }
    assert.equal(await page.locator("section.current-activity .ca-retry").count(), 1, "the diagnostic recovery is not a page reload");
    assert.equal(await page.locator(".ca-agent-row").count(), 0, "no row was built from the malformed entry");
    assert.deepEqual(errors, [], "the render did not throw");

    await page.screenshot({ path: join(SHOTS, "fg694-rf3-malformed-entry.png"), fullPage: true });
    await page.close();
  } finally {
    servedRawBody = null;
  }
});

test("FG-694 AC7 (RF-5): a 200 whose CI CONTEXTS are malformed renders the unavailable state — the surface never breaks mid-render", async () => {
  // The same defect one level deeper, and the reason RF-3's first fix was not enough:
  // the observation object validated, its `contexts` members did not, and
  // `ciContextRows` threw `Cannot read properties of null (reading 'context')` while
  // composing the compact CI line. In a browser that is a blank surface, not an error
  // state — the operator sees neither the activity nor the Retry.
  servedRawBody = JSON.stringify({
    generatedAt: NOW,
    scope: { runId: null, projectDirs: null },
    agents: [],
    hostVerification: [],
    requiredCi: {
      state: "observed",
      label: "1 observed",
      observations: [{ candidateSha: "a".repeat(40), contexts: [null] }],
    },
    unassociated: [],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1200 }, reducedMotion: "reduce" });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(`${baseUrl}/${ACTIVITY_VIEW}`);
    await page.locator("details.activity-diagnostics > summary").click();
    await page.locator("section.current-activity").waitFor();
    await page.locator(".ca-unavailable").waitFor();

    const text = await page.locator("section.current-activity").innerText();
    assert.match(text, /Current activity unavailable/);
    assert.match(text, /could not read/, "the detail is about the READ, never about the checks");
    for (const claim of ["No agent task in flight", "No host launch observed", "CI not observed", "Nothing currently running"]) {
      assert.doesNotMatch(text, new RegExp(claim), `a malformed read may not claim "${claim}"`);
    }
    assert.equal(await page.locator("section.current-activity .ca-retry").count(), 1, "the diagnostic recovery is not a page reload");
    assert.equal(await page.locator(".ca-ci-item").count(), 0, "no CI row was built from the malformed contexts");
    assert.equal(await page.locator(".ca-ci-context").count(), 0, "and no per-context row either");
    assert.deepEqual(errors, [], "the render did not throw");

    await page.screenshot({ path: join(SHOTS, "fg694-rf5-malformed-context.png"), fullPage: true });
    await page.close();
  } finally {
    servedRawBody = null;
  }
});

test("FG-679 BD-3/BD-14: an unassociated launch is LABELED, and a host-level bucket renders separately", async () => {
  served = base({
    hostVerification: [launch({ launchId: "launch-cwd-ffffff", associationKind: "cwd", unassociated: true, placement: "project", runId: null })],
    unassociated: [launch({ launchId: "launch-orphan-gggggg", associationKind: "none", unassociated: true, placement: "host", runId: null, projectLabel: null, ticketId: null })],
  });
  const page = await open();
  await page.locator(".ca-assoc-badge").first().waitFor();

  assert.equal(await page.locator(".ca-assoc-badge").first().textContent(), "unassociated");
  // FG-694 AC6: the two POPULATED sections, in order. The host-level bucket is still
  // its own section — an unassociated launch is never folded into the main one.
  assert.deepEqual(await sectionHeadings(page), ["Host verification", "Unassociated activity"]);
  const bucket = page.locator("section.current-activity section.ca-section").nth(1);
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

  // Read-only: no start/stop/cancel affordance anywhere in the surface. FG-694 adds
  // exactly one control, Retry, and only in the unavailable state — it re-READS.
  assert.equal(await page.locator("section.current-activity button").count(), 0, "the surface exposes no action buttons");
  await page.close();
});

test("FG-694 correction: agent rows have one dashboard owner — In flight, never Diagnostics", async () => {
  served = base({
    agents: [{
      runId: "run-fg679",
      runTitle: "surface in-flight host verification",
      workflow: "feature",
      projectDir: null,
      projectLabel: "forge",
      taskId: "task-build-aef6ae",
      agentRole: "engineer",
      agentModel: null,
      phase: "build",
      status: "running",
      startedAt: "2026-08-05T11:50:00.000Z",
    }],
  });
  const page = await open();
  assert.equal(await page.locator("section.in-flight").count(), 1, "Activity has one visible live-work surface");
  assert.equal(await page.locator("section.current-activity .ca-agent-row").count(), 0);
  assert.deepEqual(await sectionHeadings(page), [], "an agent-only payload does not create a diagnostic section");
  await page.close();
});

test("FG-731: a registered CI wait renders in the Current activity panel with kind/state, and no_runs/unavailable/completed stay DISTINCT", async () => {
  // The FG-704 blind spot at the browser boundary: a workflow_dispatch run bound to no
  // tracked candidate sha, plus three more waits proving the states never collapse.
  served = base({
    ciWaits: [
      ciWait({ waitId: "wait-running", kind: "workflow_dispatch", displayState: "running", statusLabel: "CI running 1/4", m: 1, n: 4 }),
      ciWait({ waitId: "wait-norun", kind: "push_actions", ticketId: "FG-731", displayState: "no_runs", statusLabel: "no CI is running", observedState: "no_runs", m: null, n: null }),
      ciWait({ waitId: "wait-unavail", kind: "pr_checks", ticketId: "FG-590", displayState: "unavailable", statusLabel: "CI state unavailable — gh rate limited", observedState: "unavailable", m: null, n: null }),
      ciWait({ waitId: "wait-done", kind: "workflow_dispatch", ticketId: "FG-728", displayState: "completed_awaiting_advance", statusLabel: "CI completed — awaiting advance", lifecycleState: "completed_awaiting_advance", observedState: "completed", m: null, n: null }),
    ],
  });
  const page = await open();

  assert.ok((await sectionHeadings(page)).includes("CI waits"), "the CI waits section renders");
  const section = page.locator("section.current-activity section.ca-section", { has: page.locator(".ca-registered-ci-wait-row") });
  await section.locator(".ca-registered-ci-wait-row").first().waitFor();
  assert.equal(await section.locator(".ca-registered-ci-wait-row").count(), 4, "one aggregate line per wait — a summary, not a check-by-check history");

  const text = await section.innerText();
  // The FG-704 run's kind and a live m/n count.
  assert.match(text, /workflow_dispatch/);
  assert.match(text, /CI running 1\/4/);
  // no_runs and unavailable are DISTINCT strings and neither is a fake success or idle.
  assert.match(text, /no CI is running/);
  assert.match(text, /CI state unavailable/);
  assert.notEqual("no CI is running", "CI state unavailable");
  // completed-awaiting-advance renders as itself — not dropped, not "running".
  assert.match(text, /CI completed — awaiting advance/);
  // A history dump would show the 40-char sha / per-check URLs; the summary must not.
  assert.doesNotMatch(text, /https:\/\//, "the run URL is not dumped into the compact summary line");

  assert.doesNotMatch(text, /Nothing currently running/, "a live wait means the workspace is NOT idle");

  await page.screenshot({ path: join(SHOTS, "fg731-ci-waits.png"), fullPage: true });
  await page.close();
});

test("FG-731: a wait STALE past its freshness cutoff STILL renders — its label degrades to unavailable, it is NEVER dropped or shown running", async () => {
  // The #1 risk at the browser boundary: a dead-waiter wait whose last observation aged
  // out must keep the surface non-idle, not vanish from it the way a stale launch does.
  served = base({
    ciWaits: [
      ciWait({
        waitId: "wait-dead",
        kind: "workflow_dispatch",
        observation: "unobserved",
        displayState: "unavailable",
        statusLabel: "CI state unavailable — last observed 2026-08-05T11:30:00.000Z",
        observedState: "running",
        m: 3,
        n: 7,
      }),
    ],
  });
  const page = await open();

  const section = page.locator("section.current-activity section.ca-section", { has: page.locator(".ca-registered-ci-wait-row") });
  await section.locator(".ca-registered-ci-wait-row").first().waitFor();
  assert.equal(await section.locator(".ca-registered-ci-wait-row").count(), 1, "the wait is STILL present — freshness never removes it");
  const text = await section.innerText();
  assert.match(text, /CI state unavailable/);
  assert.doesNotMatch(text, /CI running|3\/7/, "NEVER a fabricated running, never the stale m/n");
  assert.doesNotMatch(await page.locator("section.current-activity").innerText(), /Nothing currently running/);
  await page.close();
});

test("FG-734: Waiting on operator renders alongside a running agent and never lets the workspace read IDLE", async () => {
  inFlight = [{
    taskId: "task-building", runId: "run-building", runTitle: "live implementation", workflow: "feature",
    phase: "build", agentRole: "engineer", agentModel: null, status: "running", startedAt: "2026-08-19T11:45:00.000Z",
    projectDir: null, projectLabel: "forge", orchestrator: null, reconcile: null,
  }];
  served = base({
    agents: [{
      runId: "run-building", runTitle: "live implementation", workflow: "feature", projectDir: null, projectLabel: "forge",
      taskId: "task-building", agentRole: "engineer", agentModel: null, phase: "build", status: "running", startedAt: "2026-08-19T11:45:00.000Z",
    }],
    operatorWaits: [{
      kind: "waiting_on_operator", source: "human_gate", waitKey: "task-human", placement: "run", runId: "run-human", taskId: "task-human",
      ticketId: "FG-734", campaignId: null, itemId: null, projectDir: null, projectLabel: "forge", startedAt: "2026-08-19T11:40:00.000Z",
      reason: "human gate at step approve (tech-lead) in workflow feature", requestedAction: "advance or reject the gate", blockerKind: "human_gate", statusLabel: "Waiting on operator",
    }],
  });
  const page = await open();

  assert.ok((await sectionHeadings(page)).includes("Waiting on operator"));
  const section = page.locator("section.current-activity section.ca-section", { has: page.locator(".ca-operator-wait-row") });
  await section.locator(".ca-operator-wait-row").waitFor();
  const text = await section.innerText();
  assert.match(text, /Waiting on operator/);
  assert.match(text, /FG-734/);
  assert.match(text, /advance or reject the gate/);
  assert.doesNotMatch(await page.locator("section.current-activity").innerText(), /Nothing currently running|IDLE/);

  // Home owns the real running-agent row. The same operator wait reaches that surface
  // as a compact row, so a decision pause cannot erase concurrent implementation work.
  await page.goto(`${baseUrl}/`);
  const home = page.locator("section.home-view section.in-flight");
  await home.locator(".item").first().waitFor();
  assert.match(await home.innerText(), /task-building/);
  assert.match(await home.innerText(), /Waiting on operator/);
  assert.doesNotMatch(await home.innerText(), /No live tasks|IDLE/);
  await page.close();
});

test("FG-679: the screenshots for the populated, empty and stale states exist", () => {
  for (const name of ["fg679-populated.png", "fg679-empty.png", "fg679-stale.png", "fg679-four-statuses.png", "fg694-unavailable.png", "fg694-historical-noise-current.png", "fg731-ci-waits.png"]) {
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
      if (currentActivityStatus !== 200) {
        res.writeHead(currentActivityStatus, { "Content-Type": "text/plain" }).end("not found");
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" })
        .end(servedRawBody ?? JSON.stringify(served));
      return;
    }
    if (url.pathname === "/api/in-flight") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(inFlight));
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
