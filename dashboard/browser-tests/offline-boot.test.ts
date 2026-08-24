// FG-580 (AC-6, offline boot) — the SMOKE THAT MUST DRIVE A BUILT RELEASE, not the source.
//
// AC-6 requires proof that the DASHBOARD SHIPPED IN A PROMOTED RELEASE boots and renders
// offline. So this test:
//   1. BUILDS a disposable promoted release (buildRelease) from a throwaway committed
//      checkout — never touching the real repo, ~/.forge, or the operator's dashboard.
//   2. STARTS the dashboard SERVER from the RELEASE (`<release>/forge dashboard start`), so
//      assetRoot() resolves the release's OWN dashboard/ (sibling layout, tsconfig-paths) and
//      the release serves its first-party /client/* + vendor/** and its CSP header.
//   3. Drives a real browser against THAT release with every executable-JS / CDN origin
//      (esm.sh) BLOCKED, while the loopback release server (incl. data endpoints) stays
//      reachable. It asserts the primary page BOOTS and a hooks-using view RENDERS entirely
//      from the release's vendored libs — zero esm.sh fetch — and that the release serves the
//      `Content-Security-Policy: script-src 'self'` runtime invariant.
//   4. Runs the paired MUTATION PROOF against the RELEASE copy: 404 a vendored lib with CDN
//      blocked → the offline boot does NOT render.
//
// The block is enforced in the BROWSER: every request to an origin other than the loopback
// release server is aborted AND recorded, so a lingering esm.sh import would (a) fail the
// module load — nothing renders — and (b) show up in the recorded external-origin list.
//
// This test needs Chrome, and since FG-642 it gets one everywhere the tier runs: agent
// containers ship /usr/local/bin/chromium and CI provisions Playwright's chromium. A
// Chrome-less environment FAILS the `before` hook with a named precondition — it never skips.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { findGitRoot } from "../../src/util/git-root.js";
import { CHROME_LAUNCH_ARGS, requireChrome } from "../../src/util/chrome-bin.js";
import { makeDisposableSourceRoot, removeDisposableSourceRoot, type DisposableSource } from "../../src/v2/fg571-harness.js";
import { thawReleaseTree, type BuildReleaseResult } from "../../src/v2/release.js";

let disposable: DisposableSource | undefined;
let built: BuildReleaseResult | undefined;
let server: ChildProcess | undefined;
let browser: Browser | undefined;
let outParent = "";
let dashHome = "";
let baseUrl = "";

before(async () => {
  // Resolved BEFORE the expensive release build: a Chrome-less environment must fail on the
  // precondition, not after minutes of copying node_modules.
  const chrome = requireChrome("the dashboard browser tier");

  // 1) A disposable committed checkout, and a release built FROM it into a dir OUTSIDE it.
  disposable = await makeDisposableSourceRoot(findGitRoot(process.cwd()));
  outParent = mkdtempSync(join(tmpdir(), "fg580-offline-out-"));
  built = disposable.build({ outDir: join(outParent, "release"), rand: "offln" });

  // 2) Boot the dashboard server FROM THE RELEASE on a disposable port + FORGE_HOME. The
  //    release entry execs its pinned interpreter, so this needs no node on PATH.
  const port = 8300 + Math.floor(Math.random() * 600);
  baseUrl = `http://127.0.0.1:${port}`;
  dashHome = mkdtempSync(join(tmpdir(), "fg580-offline-fh-"));
  server = spawn(built.entryPath, ["dashboard", "start", "--port", String(port)], {
    env: { ...process.env, FORGE_HOME: dashHome },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  server.stderr?.on("data", (d) => { stderr += String(d); });

  // Wait for the release-served shell to answer.
  const deadline = Date.now() + 20000;
  for (;;) {
    try {
      const res = await fetch(`${baseUrl}/`);
      if (res.status === 200) break;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`release dashboard did not boot on ${baseUrl} (stderr: ${stderr})`);
    await new Promise((r) => setTimeout(r, 200));
  }

  browser = await chromium.launch({ executablePath: chrome, headless: true, args: CHROME_LAUNCH_ARGS });
});

after(async () => {
  await browser?.close();
  if (server?.pid) { try { process.kill(-server.pid, "SIGKILL"); } catch { /* group already gone */ } }
  if (disposable) removeDisposableSourceRoot(disposable);
  // The built release is FROZEN (read-only dirs), so restore write bits before removing.
  if (outParent) { thawReleaseTree(outParent); rmSync(outParent, { recursive: true, force: true }); }
  if (dashHome) rmSync(dashHome, { recursive: true, force: true });
});

test("FG-580 AC-6: the RELEASE-served dashboard boots and renders offline — CDN/esm.sh blocked, vendored libs serve first-party", async () => {
  const external: string[] = [];
  const pageErrors: string[] = [];
  const page: Page = await browser!.newPage({ viewport: { width: 1280, height: 900 } });
  page.on("pageerror", (e) => pageErrors.push(e.message));
  // BLOCK every non-loopback origin. A vendored graph needs zero of them; a stray esm.sh
  // import would be aborted here (and recorded), so the render below would fail.
  await page.route("**/*", (route) => {
    const url = route.request().url();
    if (url.startsWith(baseUrl) || url.startsWith("data:") || url.startsWith("blob:")) {
      route.continue();
    } else {
      external.push(url);
      route.abort();
    }
  });

  const response = await page.goto(`${baseUrl}/`, { waitUntil: "networkidle" });

  // The release serves the runtime CSP invariant (no CDN-executed JS enforced by the browser).
  const csp = response?.headers()["content-security-policy"] ?? "";
  assert.match(csp, /script-src 'self'/, `the release-served HTML carries a script-src 'self' CSP (got: ${JSON.stringify(csp)})`);

  // The primary page booted: the topbar + brand mark + view tabs rendered from the release's
  // OWN vendored preact/htm graph. If it had failed to load, main.js would have thrown at
  // import and #app stayed empty — under the CSP a mis-nonced importmap would do the same.
  await page.locator("header.topbar h1 img.brand-mark").waitFor();
  assert.equal(await page.locator("header.topbar h1 img.brand-mark").getAttribute("alt"), "forge", "the topbar brand mark rendered from the vendored preact/htm graph");
  assert.ok((await page.locator("nav.view-tabs .tab").count()) >= 4, "the view tabs rendered");

  // Exercise a HOOKS-using view (usage) — a distinct component tree driven by useState —
  // to prove preact/hooks resolves through the import map in a subview, not just at boot.
  await page.getByRole("button", { name: "usage" }).click();
  await page.locator("section.usage-section, .plan-empty, .plan-services").first().waitFor();

  // Offline proof: NOTHING reached an external / CDN origin, and specifically no esm.sh.
  assert.deepEqual(external, [], `the offline release dashboard fetched external origins: ${external.join(", ")}`);
  assert.equal(external.filter((u) => /esm\.sh/.test(u)).length, 0, "no esm.sh fetch");
  assert.deepEqual(pageErrors, [], `browser errors during offline boot: ${pageErrors.join("; ")}`);
  await page.close();
});

test("FG-580 AC-6 (mutation proof, RELEASE copy): with a vendored client lib 404'd, the offline boot RENDER fails", async () => {
  // The offline-boot guarantee is load-bearing on the vendored bytes: simulate a torn
  // closure by making the release 404 a required vendored lib (preact). The import map still
  // points at it, but the module cannot load with CDN blocked, so the app never renders its
  // topbar. This is the AC's "omit one vendored client lib → offline-boot reds", against the
  // RELEASE copy.
  const external: string[] = [];
  const page: Page = await browser!.newPage({ viewport: { width: 1280, height: 900 } });
  await page.route("**/*", (route) => {
    const url = route.request().url();
    if (url === `${baseUrl}/client/vendor/preact/preact.js`) {
      route.fulfill({ status: 404, body: "" }); // vendored lib omitted from the closure
      return;
    }
    if (url.startsWith(baseUrl) || url.startsWith("data:") || url.startsWith("blob:")) route.continue();
    else { external.push(url); route.abort(); }
  });

  await page.goto(`${baseUrl}/`, { waitUntil: "networkidle" });
  // The topbar must NOT appear — the vendored preact failed to load, so main.js could not
  // render. A short bounded wait that is expected to time out.
  const rendered = await page
    .locator("header.topbar h1")
    .waitFor({ timeout: 1500 })
    .then(() => true)
    .catch(() => false);
  assert.equal(rendered, false, "with the vendored preact 404'd, the offline boot must NOT render (offline-boot reds)");
  assert.deepEqual(external, [], "and it still did not fall back to any external/CDN origin");
  await page.close();
});
