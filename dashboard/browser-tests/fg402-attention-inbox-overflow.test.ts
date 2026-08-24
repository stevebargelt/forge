// FG-692 (FG-402 RF-3): the Human Attention Inbox rows must not overflow a narrow
// dashboard viewport. The three-column row grid (badges | body | aside) had no mobile
// override and no shrinkable content column, so long reason/action text forced a
// horizontal scrollbar on a phone-width viewport.
//
// A rendered-width check (the AC's stated alternative to a full browser flow): the REAL
// shell CSS is served, the REAL inbox-row markup (mirrors attention-inbox-view.js) is
// injected, and the page is asserted not to scroll horizontally at 360px. The client
// app is not booted — the defect and its fix are purely in the row's CSS.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { chromium, type Browser, type Page } from "playwright-core";
import { renderShell } from "../src/shell.js";
import { CHROME_LAUNCH_ARGS, requireChrome } from "../../src/util/chrome-bin.js";

// A row whose reason and requested action are long, unbroken-ish strings — the content
// that overflowed before the responsive override and the min-width:0 content column.
const ROW = `
  <div class="item inbox-row">
    <div class="inbox-row-badges">
      <span class="badge inbox-kind-waiting_gate">Waiting on gate</span>
      <span class="badge inbox-sev inbox-sev-high">high</span>
    </div>
    <div class="inbox-row-body">
      <div class="inbox-row-head"><strong>FG-1234</strong><span class="faint"> · </span><span class="inbox-reason">a gate is awaiting an operator decision on this run and the reason string is deliberately-long-and-mostly-unbroken-to-stress-the-content-column</span></div>
      <div class="faint inbox-action">advance or reject the awaiting_gate task from the run map before the campaign can continue past this held step</div>
      <div class="faint mono inbox-meta">forge-review-loop · some-project-with-a-longish-label</div>
    </div>
    <div class="inbox-row-aside">
      <div class="muted mono inbox-age">3h</div>
      <a class="inbox-link" href="#run-map/run-abc">Open run</a>
    </div>
  </div>`;

let server: Server;
let browser: Browser;
let baseUrl = "";

before(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(renderShell());
  });
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

async function injectInbox(page: Page): Promise<void> {
  await page.evaluate((rowHtml) => {
    const main = document.querySelector("main") ?? document.body;
    main.innerHTML = `<section class="attention-inbox"><div class="inbox-list">${rowHtml}${rowHtml}${rowHtml}</div></section>`;
  }, ROW);
}

test("FG-692 (FG-402 RF-3): inbox rows do not overflow a 360px viewport", async () => {
  const page = await browser.newPage({ viewport: { width: 360, height: 720 }, reducedMotion: "reduce" });
  await page.goto(baseUrl);
  await injectInbox(page);
  await page.locator(".inbox-row").first().waitFor();

  // No horizontal page scroll — the whole point: the row grid must not force the
  // document wider than the phone-width viewport.
  const overflow = await page.evaluate(() => ({
    docScroll: document.documentElement.scrollWidth,
    inner: window.innerWidth,
    rowsWiderThanViewport: Array.from(document.querySelectorAll(".inbox-row")).filter(
      (el) => el.getBoundingClientRect().width > window.innerWidth + 0.5,
    ).length,
  }));
  assert.ok(
    overflow.docScroll <= overflow.inner + 0.5,
    `the inbox forced a ${overflow.docScroll}px document into a ${overflow.inner}px viewport`,
  );
  assert.equal(overflow.rowsWiderThanViewport, 0, "no inbox row is wider than the viewport");
  await page.close();
});

test("FG-692 (FG-402 RF-3): the responsive override collapses the row to a single column on a narrow viewport", async () => {
  const page = await browser.newPage({ viewport: { width: 360, height: 720 }, reducedMotion: "reduce" });
  await page.goto(baseUrl);
  await injectInbox(page);
  const row = page.locator(".inbox-row").first();
  await row.waitFor();
  const cols = await row.evaluate((el) => getComputedStyle(el).gridTemplateColumns);
  // A single track (one width value) — the three-column layout has been overridden.
  assert.equal(cols.trim().split(/\s+/).length, 1, `expected a single grid column at 360px, got "${cols}"`);
  await page.close();
});
