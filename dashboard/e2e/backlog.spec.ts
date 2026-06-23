// E2E tests for the Backlog tab (FG-363).
//
// All API calls are intercepted via page.route() so no forge.db is needed.
// The server only serves / and /client/* (no DB access for those routes).
//
// Flow: navigate to /#projects → click fixture project card → click backlog tab
// → assert notes / ticket list / filters / search / detail.

import { test, expect } from "@playwright/test";

// ---- fixtures ----

const FIXTURE_PROJECT = {
  projectDir: "/tmp/forge-pw-fixture-project",
  label: "test-project",
  color: "#4A90D9",
  lastRunAt: new Date(Date.now() - 60_000).toISOString(),
  runCount: 3,
  inFlightCount: 0,
  liveSessions: 0,
  description: "Fixture project for backlog E2E tests",
  readmeFirstLine: null,
};

const FIXTURE_NOTES = "# Session handoff\n\nSome notes here for testing.";

const FIXTURE_TICKETS = [
  {
    id: "FG-100",
    type: "epic",
    status: "active",
    title: "Test Epic",
    body: "Epic body content here.",
  },
  {
    id: "FG-101",
    type: "story",
    status: "active",
    title: "Test Story With Epic",
    epic: "FG-100",
    body: "Story body content for the detail view.",
  },
  {
    id: "FG-102",
    type: "idea",
    status: "active",
    title: "Test Idea About Improvement",
    body: "Idea body content.",
  },
  {
    id: "FG-103",
    type: "story",
    status: "blocked",
    title: "Blocked Story",
    body: "This story is blocked.",
  },
];

const OPS_EMPTY = {
  runs: { total: 0, active: 0, terminal: 0, clean: 0, withFailures: 0, successRate: 0 },
  failureKinds: [],
  counts: { retries: 0, cancels: 0, redBlocks: 0, idleKills: 0 },
  durations: [],
  taskCount: 0,
};

const GOV_EMPTY = {
  ok: true,
  routes: {},
  source: "host",
  diff: null,
  drift: null,
  audit: [],
  findings: [],
};

// ---- shared setup ----

test.beforeEach(async ({ page }) => {
  // Mock every API route so no DB access happens on the server.
  await page.route("/api/feed**", (r) => r.fulfill({ json: [] }));
  await page.route("/api/in-flight**", (r) => r.fulfill({ json: [] }));
  await page.route("/api/projects**", (r) => r.fulfill({ json: [FIXTURE_PROJECT] }));
  await page.route("/api/backlog**", (r) =>
    r.fulfill({ json: { notes: FIXTURE_NOTES, tickets: FIXTURE_TICKETS } }),
  );
  await page.route("/api/governance**", (r) => r.fulfill({ json: GOV_EMPTY }));
  await page.route("/api/ops**", (r) => r.fulfill({ json: OPS_EMPTY }));
  // /api/usage, /api/usage/timeseries, /api/usage/model-mix
  await page.route("/api/usage**", (r) => r.fulfill({ json: [] }));
});

// Navigate to Projects, click the fixture project, then open the Backlog tab.
async function openBacklogView(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/#projects");
  // Wait for the project card to render.
  await expect(page.locator(".project-card")).toBeVisible({ timeout: 10_000 });
  // Click the project card — sets projectFilter and switches to activity view.
  await page.locator(".project-card").first().click();
  // Click the backlog tab.
  await page.locator("button", { hasText: "backlog" }).click();
  // Wait for the backlog view to populate (notes or ticket groups).
  await expect(
    page.locator(".backlog-notes, .backlog-group, .backlog-empty").first(),
  ).toBeVisible({ timeout: 10_000 });
}

// ---- tests ----

test("Backlog tab: notes render as markdown with section heading", async ({ page }) => {
  await openBacklogView(page);
  await expect(page.locator(".backlog-notes")).toBeVisible();
  await expect(page.locator(".backlog-notes-body")).toContainText("Session handoff");
});

test("Backlog tab: ticket list shows all ticket groups (epic, story, idea)", async ({ page }) => {
  await openBacklogView(page);
  // All 4 fixture tickets should be visible as cards.
  await expect(page.locator(".backlog-ticket-card")).toHaveCount(FIXTURE_TICKETS.length);
  // Epic and Story group headings should appear.
  await expect(page.locator(".backlog-group")).toHaveCount(3); // epics + stories + ideas
});

test("Backlog tab: type filter narrows the ticket list", async ({ page }) => {
  await openBacklogView(page);
  // Click the "Story" type filter button.
  await page.locator("button[aria-label='Filter by type: Story']").click();
  // Only story tickets remain (FG-101 + FG-103 = 2 stories).
  const storyCount = FIXTURE_TICKETS.filter((t) => t.type === "story").length;
  await expect(page.locator(".backlog-ticket-card")).toHaveCount(storyCount);
});

test("Backlog tab: title/body search narrows the ticket list", async ({ page }) => {
  await openBacklogView(page);
  // Search for "Improvement" — only matches "Test Idea About Improvement".
  await page.fill("#backlog-search", "Improvement");
  await expect(page.locator(".backlog-ticket-card")).toHaveCount(1);
  await expect(page.locator(".backlog-ticket-card")).toContainText("Improvement");
});

test("Backlog tab: clicking a ticket opens detail with markdown body", async ({ page }) => {
  await openBacklogView(page);
  // Open FG-101 (Test Story With Epic).
  await page.locator("[aria-label*='FG-101']").click();
  // Detail overlay should appear.
  await expect(page.locator(".detail-overlay")).toBeVisible();
  await expect(page.locator(".detail")).toContainText("Test Story With Epic");
  // Markdown body should be rendered.
  await expect(page.locator(".detail .md")).toContainText("Story body content for the detail view");
  // Close detail.
  await page.locator(".detail .close").click();
  await expect(page.locator(".detail-overlay")).not.toBeVisible();
});
