// FG-591 step 14 — the operator Kanban board AS AN OPERATOR DRIVES IT: real Chrome,
// real dashboard server, real store, real `forge` CLI behind every write.
//
// The other FG-591 suites stop at a boundary. fg591-queue-board-state.test.ts pins the
// pure projection functions, fg591-queue-projection/-routes pin the payload, and
// fg591-queue-mutation pins the argv the POST routes build. NONE of them can see the
// three things this file exists for, because each one only happens when a human hand
// is on the board:
//
//   1. A DRAG IS A REORDER. planRelativeMove is unit-tested, but nothing has ever proven
//      that dropping a card actually reaches it — that the `draggable` attribute is set
//      on the right element, that dataTransfer survives, that the drop index is the one
//      the card occupies, and that the relative intent then travels through the POST
//      route, through the CLI, into the durable rank, and back onto the screen in the new
//      order. That whole chain is only observable through a real browser drag.
//
//   2. A REFUSAL IS THE OPERATOR'S ANSWER. A not-ready enqueue must put the CONCRETE
//      refinement proposal on screen — not "failed", not a spinner that stops. The
//      proposal is written by evaluateReadiness, carried by the CLI's exit-1 stdout,
//      relayed by the mutation route and rendered by the alert. Four components, one
//      operator-visible sentence, no test between the ends.
//
//   3. BLOCKED AND "WAITING TO OVERLAP" MUST NOT LOOK THE SAME. A genuine blocker moves a
//      card to the derived Blocked column WITHOUT touching its rank; a temporary
//      scheduling incompatibility leaves the card Queued with an explanation. Mislabeling
//      the second as the first is the AC's named defect, and it is a RENDERING defect —
//      the payload can be perfectly correct while both render as one red badge.
//
// A Chrome-less environment FAILS this file at its `before` hook (FG-642) — it never
// skips. The plan step's acceptance text asked for a clean skip; that is the exact
// regression FG-642 closed (four of five suites silently skipped to green in every agent
// container for months) and dashboard/src/fg642-browser-tier-fail-first.integration.test.ts
// asserts zero skips across this tier. Fail-first is the repo's binding convention, so
// this suite follows the convention rather than the sentence.
//
// This lane runs under `npm run test:browser -w dashboard` (test:extended), not `npm test`.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import Database from "better-sqlite3";
import { chromium, type Browser, type Locator, type Page } from "playwright-core";
import { requireChrome } from "../../src/util/chrome-bin.js";

const TEST_PORT = 18811;
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const SHOT_DIR = process.env.FG591_SHOT_DIR;

// --- env before ANY forge module is evaluated: the store handle, the dashboard's
// read-only handle and the `forge` child this board shells out to must all land on this
// test's private store (the fg591-queue-routes precedent). ---
const testHome = mkdtempSync(join(tmpdir(), "fg591-board-browser-"));
const forgeHome = join(testHome, ".forge");
const reposRoot = join(testHome, "checkouts");
mkdirSync(forgeHome, { recursive: true });
mkdirSync(reposRoot, { recursive: true });

process.env.HOME = testHome;
process.env.FORGE_HOME = forgeHome;
process.env.FORGE_DB_PATH = join(forgeHome, "forge.db");
process.env.FORGE_PROJECT_SCAN_ROOTS = reposRoot;
process.env.PORT = String(TEST_PORT);
process.env.HOST = "127.0.0.1";
// No stub. The board's writes go through the co-located `bin/forge`, which is the
// point: a drag that "worked" against a recording binary would prove nothing about
// whether the rank actually moved.
delete process.env.FORGE_BIN;

const { getDb, writeTransaction } = await import("../../src/store/db.js");
const { upsertTicket, setStorageMode, upsertBlockerEvidence } = await import("../../src/store/tickets.js");
const { rankTicket, enqueueTicket, dequeueTicket, queueVersion } = await import("../../src/store/queue.js");
const { setDispatcherPolicy, acquireDispatcherLease, DEFAULT_LEASE_TTL_MS } = await import(
  "../../src/store/dispatcher-policy.js"
);
const { recordEvaluation } = await import("../../src/store/dispatcher-evidence.js");
const { repositoryCheckoutIdentity } = await import("../../src/util/repository-identity.js");
const { authorityTestkitBinEnv } = await import("../../src/backlog/container-authority.testkit-spawn.js");

// Inside an agent container the compiled-in authority mount exists and `forge queue`
// refuses every mutation under container authority by design (FG-609). The child the
// dashboard spawns is pointed at a neutral mount through the same published seam every
// other CLI-driving suite uses; on a host this changes nothing.
Object.assign(process.env, authorityTestkitBinEnv());

const PK = "pk-fg591-board-browser";
const AT = "2026-08-06T09:00:00Z";

// A body evaluateReadiness (FG-382) calls READY: Problem, Goal, bulleted AC.
const READY_BODY = ["## Problem", "It hurts.", "", "## Goal", "Stop it.", "", "## Acceptance Criteria", "- it works"].join("\n");
// The same body MINUS the acceptance criteria. evaluateReadiness returns
// `needs_refinement` with exactly one gap and one proposal, and that proposal is the
// sentence this suite requires to reach the screen.
const NOT_READY_BODY = ["## Problem", "It hurts.", "", "## Goal", "Stop it."].join("\n");
const EXPECTED_PROPOSAL = "Add an ## Acceptance Criteria section with testable bullet points.";

const SCHEDULING_DETAIL = "waiting for FG-9 to finish";

const projectDir = join(reposRoot, "board");

// ── the fixture, written through the REAL store modules ──────────────────────
//
// Nothing about the queue is hand-seeded: ranks come from rankTicket, membership from
// enqueueTicket (which re-evaluates readiness on the CURRENT revision), the blocker from
// upsertBlockerEvidence and the dispatcher's policy / lease / evaluation from their own
// modules. Only the `runs` row and the project_identity mapping are direct INSERTs —
// they are the dashboard's registry input, not queue truth (the fg608 precedent).
{
  mkdirSync(projectDir, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: projectDir, stdio: "ignore" });
  execFileSync("git", ["remote", "add", "origin", "git@github.com:stevebargelt/fg591-board-browser.git"], {
    cwd: projectDir,
    stdio: "ignore",
  });

  const database = getDb();
  writeTransaction(() => {
    database
      .prepare(`INSERT INTO project_identity (project_key, repo_evidence_key, repo_evidence_source, created_at) VALUES (?,?,?,?)`)
      .run(PK, repositoryCheckoutIdentity(projectDir).key, "remote", AT);
    database
      .prepare(`INSERT INTO runs (id,workflow,title,status,created_at,project_dir) VALUES (?,?,?,?,?,?)`)
      .run("run-fg591-board", "feature", "board browser fixture", "complete", AT, projectDir);
  });
  setStorageMode(PK, "db", AT);

  const seed = (id: string, body: string): void => {
    upsertTicket({
      projectKey: PK,
      ticketId: id,
      type: "story",
      status: "active",
      title: `title ${id}`,
      body,
      created: "2026-01-01",
      closed: null,
      closedCommit: null,
      epic: null,
      frontmatter: null,
      importedAt: AT,
      importedFrom: null,
    } as never);
  };

  // FG-201..FG-204 queued and ready — the four cards the operator reorders.
  // FG-205 ranked but NOT ready and NOT queued — the enqueue-refusal case.
  // FG-206 a queue member that finished — the derived Done column.
  for (const id of ["FG-201", "FG-202", "FG-203", "FG-204", "FG-206"]) seed(id, READY_BODY);
  seed("FG-205", NOT_READY_BODY);
  for (const id of ["FG-201", "FG-202", "FG-203", "FG-204", "FG-205", "FG-206"]) rankTicket(PK, id, undefined, AT);
  for (const id of ["FG-201", "FG-202", "FG-203", "FG-204", "FG-206"]) {
    const result = enqueueTicket(PK, id, { by: "operator" }, AT);
    assert.ok(result.ok, `fixture enqueue ${id} refused: ${result.ok ? "" : result.reason}`);
  }
  writeTransaction(() => {
    getDb().prepare(`UPDATE tickets SET status = 'done' WHERE project_key = ? AND ticket_id = ?`).run(PK, "FG-206");
  });

  setDispatcherPolicy({ armed: true, maxActiveRuns: 2, capacityScope: "host", updatedBy: "operator@test" });
  const lease = acquireDispatcherLease({
    projectKey: PK,
    owner: "dispatcher-browser",
    ttlMs: DEFAULT_LEASE_TTL_MS,
    host: "testhost",
    pid: process.pid,
  });
  assert.ok(lease.granted === true, "the fixture dispatcher lease was refused");

  // The pass that granted nothing, and WHY: FG-201 is ready, unblocked, unclaimed and
  // simply cannot overlap what is running. That is scan evidence, per-evaluation and
  // self-clearing — deliberately NOT a blocker_evidence row, which is durable,
  // per-ticket and partly container-visible.
  recordEvaluation({
    projectKey: PK,
    dispatcherOwner: "dispatcher-browser",
    dispatcherGeneration: lease.lease.generation,
    reason: "incompatible_only",
    detail: "the top candidate cannot safely overlap the active set",
    capacityScope: "host",
    capacityLimit: 2,
    capacityUsed: 1,
    scanEvidence: [{ ticketId: "FG-201", rank: 1, reason: "incompatible", detail: SCHEDULING_DETAIL }],
  });
}

let browser: Browser | undefined;
let server: Server | undefined;
let projectLabel = "";

before(async () => {
  // FIRST, before a server or a fixture page exists: a machine that cannot run this
  // tier says so by name and fails, rather than reporting green on nothing.
  const chromeBin = requireChrome("the dashboard browser tier");

  ({ server } = await import("../src/server.js"));
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await fetch(`${BASE}/`);
      break;
    } catch {
      if (attempt === 99) throw new Error("dashboard test server did not start");
      await new Promise((r) => setTimeout(r, 40));
    }
  }

  // The card label is derived host-side, so read it rather than restating the rule —
  // a label-format change must not silently turn the navigation into a no-op.
  const projects = (await (await fetch(`${BASE}/api/projects`)).json()) as Array<{ label: string; projectDirs: string[] }>;
  const match = projects.find((p) => p.projectDirs.includes(projectDir));
  assert.ok(match, `the dashboard did not resolve a project for ${projectDir}`);
  projectLabel = match.label;

  if (SHOT_DIR) mkdirSync(SHOT_DIR, { recursive: true });
  browser = await chromium.launch({ executablePath: chromeBin, headless: true });
});

after(async () => {
  await browser?.close();
  server?.closeAllConnections?.();
  await new Promise<void>((closed) => (server ? server.close(() => closed()) : closed()));
});

// ── durable truth, read on a SECOND connection ───────────────────────────────
//
// Never the CLI's own report and never the board's: the whole claim is that a drag
// reached the durable rank, so the rank is read back independently of both.

function durableQueueOrder(): string[] {
  const db = new Database(join(forgeHome, "forge.db"), { readonly: true });
  try {
    return (
      db
        .prepare(
          `SELECT t.ticket_id FROM queue_membership m
             JOIN tickets t ON t.project_key = m.project_key AND t.ticket_id = m.ticket_id
            WHERE m.project_key = ?
            ORDER BY t.priority_rank ASC, t.ticket_id ASC`,
        )
        .all(PK) as { ticket_id: string }[]
    ).map((r) => r.ticket_id);
  } finally {
    db.close();
  }
}

function durableRanks(): Record<string, number | null> {
  const db = new Database(join(forgeHome, "forge.db"), { readonly: true });
  try {
    const rows = db
      .prepare(`SELECT ticket_id, priority_rank FROM tickets WHERE project_key = ?`)
      .all(PK) as { ticket_id: string; priority_rank: number | null }[];
    return Object.fromEntries(rows.map((r) => [r.ticket_id, r.priority_rank]));
  } finally {
    db.close();
  }
}

function isQueueMember(ticketId: string): boolean {
  const db = new Database(join(forgeHome, "forge.db"), { readonly: true });
  try {
    return db.prepare(`SELECT 1 FROM queue_membership WHERE project_key = ? AND ticket_id = ?`).get(PK, ticketId) !== undefined;
  } finally {
    db.close();
  }
}

// ── driving the real UI ──────────────────────────────────────────────────────

async function newPage(): Promise<Page> {
  // Tall on purpose: a real operator drag auto-scrolls, but a synthesized one cannot
  // drop on a card that is below the fold. The board's six columns plus the dispatcher
  // panel need the room, and a viewport that hid the fourth card would make this suite
  // pass or fail on layout height rather than on behaviour.
  const page = await browser!.newPage({ viewport: { width: 1500, height: 1800 } });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("close", () => assert.deepEqual(errors, [], `browser errors: ${errors.join("; ")}`));
  return page;
}

/** Exactly as an operator arrives: Projects → this project → the queue tab. */
async function openBoard(): Promise<Page> {
  const page = await newPage();
  await page.goto(`${BASE}/#projects`);
  await page.getByRole("button", { name: `Open all ${projectLabel} checkouts` }).click();
  await page.getByRole("button", { name: "queue", exact: true }).click();
  await page.locator(".queue-view").waitFor();
  await page.locator(".queue-column-queued .queue-card").first().waitFor();
  return page;
}

function column(page: Page, view: string): Locator {
  return page.locator(`.queue-column-${view}`);
}

async function renderedIds(page: Page, view: string): Promise<string[]> {
  const ids = await column(page, view).locator(".queue-card-id").allTextContents();
  return ids.map((s) => s.trim());
}

/** The queue version the board LOADED — the value every reorder carries (D11). */
async function shownVersion(page: Page): Promise<number> {
  return Number((await page.locator(".queue-version .mono").innerText()).trim());
}

async function shot(page: Page, name: string): Promise<void> {
  if (SHOT_DIR) await page.screenshot({ path: join(SHOT_DIR, `${name}.png`), fullPage: true });
}

/** A move is only "applied" once the durable order says so. The POST, the CLI child and
 *  the board's re-read are all asynchronous, so this waits on the STORE rather than on a
 *  timeout — and reports what it saw instead of expiring anonymously. */
async function waitForQueueOrder(expected: string[], what: string): Promise<void> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (JSON.stringify(durableQueueOrder()) === JSON.stringify(expected)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.deepEqual(durableQueueOrder(), expected, `${what}: the durable queue order never became the expected one`);
}

// ─── 1. the drag ─────────────────────────────────────────────────────────────

test("FG-591 AC3/AC8: a real browser DRAG-reorder travels through the CLI into the durable rank and re-renders in the new order", async () => {
  const page = await openBoard();

  assert.deepEqual(await renderedIds(page, "queued"), ["FG-201", "FG-202", "FG-203", "FG-204"], "the fixture's rank order");
  assert.deepEqual(durableQueueOrder(), ["FG-201", "FG-202", "FG-203", "FG-204", "FG-206"]);
  await shot(page, "fg591-board-before-drag");

  const cards = column(page, "queued").locator(".queue-card");
  // The drag is only possible at all because the card carries the attribute. Asserted
  // rather than assumed: a `draggable` lost in a refactor turns every drag below into a
  // silent no-op that a payload test cannot see.
  assert.equal(await cards.first().getAttribute("draggable"), "true", "a queued card must be draggable");

  // FG-201 (position 1) dropped onto FG-203 (position 3) — the relative intent that
  // becomes `forge queue rank-after FG-201 FG-203 --expect-version <loaded>`.
  await cards.nth(0).dragTo(cards.nth(2));

  await waitForQueueOrder(["FG-202", "FG-203", "FG-201", "FG-204", "FG-206"], "drag-reorder");

  // AND IT COMES BACK. A mutation the CLI accepted re-reads the board, so the operator
  // sees the order they just composed rather than the one they dragged away from.
  await assertRendersQueued(page, ["FG-202", "FG-203", "FG-201", "FG-204"]);

  // The ranks are DENSE and 1-based afterwards, and the ranked-but-unqueued ticket kept
  // the slot it occupied — a reorder permutes the queue, it does not renumber the world.
  const ranks = durableRanks();
  assert.deepEqual(
    ["FG-202", "FG-203", "FG-201", "FG-204"].map((id) => ranks[id]),
    [1, 2, 3, 4],
    "the queue's members are densely ranked in the new order",
  );
  assert.equal(ranks["FG-205"], 5, "the ranked-but-unqueued ticket keeps its slot");

  await shot(page, "fg591-board-after-drag");
  await page.close();
});

/** Wait for the board to render a given queued order, then assert it. The board re-reads
 *  after an accepted mutation; this is the render half of the same claim. */
async function assertRendersQueued(page: Page, expected: string[]): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (JSON.stringify(await renderedIds(page, "queued")) === JSON.stringify(expected)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.deepEqual(await renderedIds(page, "queued"), expected, "the board did not re-render in the new rank order");
}

// ─── 2. the same reorder without a mouse ─────────────────────────────────────

test("FG-591 AC3: the KEYBOARD reorder submits the same relative intent — a queue only a mouse can plan is not a queue", async () => {
  const page = await openBoard();
  const before = durableQueueOrder();
  assert.deepEqual(before, ["FG-202", "FG-203", "FG-201", "FG-204", "FG-206"], "carried over from the drag");

  // Grab the top card and move it down one: Enter to grab, ArrowDown to move.
  const top = column(page, "queued").locator(".queue-card").first();
  await top.focus();
  assert.equal(await top.getAttribute("aria-grabbed"), "false", "a focusable reorder handle reports its grab state");
  await page.keyboard.press("Enter");
  await page.locator(".queue-card-grabbed").waitFor();
  await page.keyboard.press("ArrowDown");

  await waitForQueueOrder(["FG-203", "FG-202", "FG-201", "FG-204", "FG-206"], "keyboard reorder");
  await assertRendersQueued(page, ["FG-203", "FG-202", "FG-201", "FG-204"]);
  await page.close();
});

// ─── 3. the queue moved underneath the board ─────────────────────────────────

test("FG-591 D11: a reorder composed against a STALE version is REFUSED on screen, and changes nothing", async () => {
  const page = await openBoard();
  const loaded = await shownVersion(page);
  const before = durableQueueOrder();

  // The queue moves while this board sits open — a second operator, the CLI, another
  // tab. Net membership is identical; only the version advances, which is exactly the
  // case a full-ordering replay would silently clobber.
  dequeueTicket(PK, "FG-204");
  const restored = enqueueTicket(PK, "FG-204", { by: "another operator" });
  assert.ok(restored.ok, "the out-of-band re-enqueue must succeed");
  assert.ok(queueVersion(PK) > loaded, "the durable queue version must have advanced");
  assert.deepEqual(durableQueueOrder(), before, "the out-of-band churn must leave the ORDER alone");

  // The board is still showing the version it loaded — stated as an assertion so a poll
  // that intervened names itself instead of failing this test somewhere stranger.
  assert.equal(await shownVersion(page), loaded, "the board is still composed against the version it loaded");

  const cards = column(page, "queued").locator(".queue-card");
  await cards.nth(0).dragTo(cards.nth(2));

  const alert = page.locator(".queue-alert-err");
  await alert.waitFor();
  const text = await alert.innerText();
  assert.match(text, /was NOT applied/, "a refused move must say it was not applied");
  assert.match(text, /moved underneath/i, "the CLI's own refusal must reach the operator");
  assert.match(text, new RegExp(`version ${loaded}`), "the refusal names the version the board carried");
  // A refusal is never swallowed into a silent reload: the operator is asked to reload
  // deliberately, because the order they composed the move against no longer exists.
  await page.locator(".queue-alert-actions button", { hasText: "reload board" }).waitFor();

  assert.deepEqual(durableQueueOrder(), before, "a refused reorder must leave the order byte-identical");
  await shot(page, "fg591-board-stale-version-refusal");
  await page.close();
});

// ─── 4. the refusal that has to be readable ──────────────────────────────────

test("FG-591 AC4: enqueueing a NOT-READY ticket shows the concrete refinement proposal, not a generic failure", async () => {
  const page = await openBoard();
  assert.ok((await renderedIds(page, "backlog")).includes("FG-205"), "the not-ready ticket is visible in Backlog");
  assert.equal(isQueueMember("FG-205"), false, "FG-205 starts outside the queue");

  await page.locator("#queue-enqueue-id").fill("FG-205");
  await page.locator(".queue-controls button", { hasText: "enqueue" }).click();

  const alert = page.locator(".queue-alert-err");
  await alert.waitFor();
  const text = await alert.innerText();
  // THE PROPOSAL ITSELF, verbatim from evaluateReadiness, through the CLI's exit-1
  // output and the mutation route, onto the screen. This is the sentence that tells the
  // operator what to DO; a refusal without it is a dead end.
  assert.ok(text.includes(EXPECTED_PROPOSAL), `the refinement proposal must reach the screen; saw:\n${text}`);
  assert.match(text, /Missing Acceptance Criteria section/, "and the gap it came from");
  assert.match(text, /needs_refinement/, "and the outcome at the CURRENT revision");
  assert.doesNotMatch(text, /^Refused\.\s*$/, "a bare 'refused' is the operator blindness this ticket closes");

  // A refused enqueue writes no membership: the board's optimism never outruns the store.
  assert.equal(isQueueMember("FG-205"), false, "a refused enqueue must not create membership");
  assert.equal((await renderedIds(page, "queued")).includes("FG-205"), false, "nor a card in the Queued column");

  await shot(page, "fg591-board-not-ready-refusal");
  await page.close();
});

// ─── 5. blocked vs. waiting-to-overlap, on screen ────────────────────────────

test("FG-591 AC6: a queued ticket that becomes BLOCKED keeps its rank and moves to the DERIVED Blocked column", async () => {
  let page = await openBoard();
  const ranksBefore = durableRanks();
  const rank = ranksBefore["FG-202"];
  assert.equal(typeof rank, "number");
  assert.ok((await renderedIds(page, "queued")).includes("FG-202"), "FG-202 starts in Queued");
  assert.equal(await column(page, "blocked").locator(".queue-card").count(), 0, "and nothing is blocked yet");

  // The blocker arrives the way blockers arrive: durable, per-ticket evidence whose queue
  // projection blocks. No column is toggled — there is no column to toggle.
  upsertBlockerEvidence({
    projectKey: PK,
    ticketId: "FG-202",
    source: "queue-dependency:FG-9",
    kind: "dependency",
    reason: "FG-9 must ship first",
    detail: null,
    bodyHash: null,
    queueProjection: "blocked",
    createdAt: AT,
  } as never);

  // The operator looks again. Deliberately a fresh arrival rather than page.reload():
  // the project scope is client state, so a bare reload lands on the no-project board
  // and would assert nothing about the projection.
  await page.close();
  page = await openBoard();
  await column(page, "blocked").locator(".queue-card").first().waitFor();

  assert.deepEqual(await renderedIds(page, "blocked"), ["FG-202"], "it is in the derived Blocked column");
  assert.equal((await renderedIds(page, "queued")).includes("FG-202"), false, "and no longer in Queued");

  // AC6's real content: it did not lose its place. Nothing about a blocker touches rank
  // or membership, so clearing it returns the card to exactly this position.
  assert.deepEqual(durableRanks(), ranksBefore, "a blocker must not move a single rank");
  const blockedCard = column(page, "blocked").locator(".queue-card").first();
  assert.match(await blockedCard.innerText(), new RegExp(`#${rank}\\b`), "the card still shows its rank");
  assert.match(await blockedCard.innerText(), /queued/, "and is still a queue member");
  assert.match(await blockedCard.innerText(), /FG-9 must ship first/, "with the blocker's own reason");

  // THE DISTINCTION THAT MUST SURVIVE RENDERING. FG-201 is waiting on the same kind of
  // thing an operator might call "blocked" — it cannot run yet — but it is a temporary
  // scheduling incompatibility, so it stays QUEUED with an explanation and a different
  // label. One badge for both is the AC's named defect.
  const waiting = column(page, "queued").locator(".queue-card", { hasText: "FG-201" });
  const waitingText = await waiting.innerText();
  assert.match(waitingText, /Waiting to overlap/, "a scheduling wait has its own label");
  assert.match(waitingText, new RegExp(SCHEDULING_DETAIL), "and names what it is waiting for, in the AC's own words");
  assert.match(waitingText, /temporary/, "and says it self-clears");
  assert.doesNotMatch(waitingText, /Blocked/, "a scheduling wait must never be labeled Blocked");
  assert.equal(await waiting.locator(".queue-wait-badge-scheduling").count(), 1, "with a distinct tone from a blocker");
  assert.equal(await blockedCard.locator(".queue-wait-badge-blocker").count(), 1);

  // Both derived columns say so on screen: neither is a stored, toggleable status.
  for (const view of ["in_progress", "blocked", "done"]) {
    assert.equal(await column(page, view).locator(".queue-derived-badge").count(), 1, `${view} must be marked derived`);
  }
  assert.deepEqual(await renderedIds(page, "done"), ["FG-206"], "and Done is derived from the lifecycle status");

  await shot(page, "fg591-board-blocked-vs-scheduling");
  await page.close();
});

// ─── 6. the dispatcher panel is READ-ONLY here ───────────────────────────────

test("FG-591 D2/AC16: the dispatcher panel reports, and says where arming lives — no arm or capacity control exists on this surface", async () => {
  const page = await openBoard();
  const panel = page.locator(".queue-dispatcher");
  await panel.waitFor();
  const text = await panel.innerText();

  assert.match(text, /armed/, "the armed state is reported");
  assert.match(text, /incompatible_only/, "the durable reason the last pass granted nothing");
  assert.match(text, /host/, "and the scope the ceiling is counted in");

  // D2: an explicit affordance naming the command, not a disabled button. A disabled
  // button says "you may not"; this says "here is how", which is the useful thing.
  const cliOnly = page.locator(".queue-cli-only");
  await cliOnly.waitFor();
  assert.match(await cliOnly.innerText(), /forge queue dispatcher arm/, "the CLI-only affordance names the command");

  // Nothing on this page can arm dispatch or change the ceiling — asserted over every
  // control the board renders, enabled or not. Queue membership is planning intent; this
  // unauthenticated surface never authorizes unattended container execution.
  const controls = await page.locator("button, input, select, [role=button]").allInnerTexts();
  for (const label of controls) {
    assert.doesNotMatch(label, /\barm\b|disarm|max.?active|lease.?ttl|capacity|cancel/i, `an arming-shaped control exists: ${label}`);
  }
  assert.equal(await panel.locator("button, input, select").count(), 0, "the dispatcher panel carries no control at all");

  await shot(page, "fg591-board-dispatcher-panel");
  await page.close();
});
