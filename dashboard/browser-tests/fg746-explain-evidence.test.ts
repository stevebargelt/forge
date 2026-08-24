// FG-746 (C5/AC6): run/task Explain renders the candidate-bound verification evidence.
//
// The /api/task/:id/explain payload carries a `verificationEvidence` sidecar alongside
// the (unmodified) TaskExplain. RunExplainPanel renders a "Verification evidence" block
// listing commit, command/gate, source (host|ci), outcome, and timestamp — and degrades
// to nothing when the sidecar is absent/empty. This mounts the panel directly (via the
// same vendored import map the shell uses) so the block is under test without driving the
// whole Run Map open.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import { CHROME_LAUNCH_ARGS, requireChrome } from "../../src/util/chrome-bin.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = resolve(HERE, "..", "client");
const SHOTS = process.env.FG746_SCREENSHOT_DIR ?? join(tmpdir(), "fg746-screenshots");
mkdirSync(SHOTS, { recursive: true });

const RECORDED_AT = "2026-08-22T09:00:00.000Z";
const EVIDENCE = [
  { id: 1, ticketId: "FG-920", commitSha: "eee4444eee4444", gateName: "npm run test:all", command: "npm run test:all", source: "host", exitCode: 0, runId: "run-x", recordedAt: RECORDED_AT, ciUrl: null },
  { id: 2, ticketId: "FG-920", commitSha: "eee4444eee4444", gateName: "test-extended", command: "npm run test:extended", source: "ci", exitCode: 0, runId: null, recordedAt: RECORDED_AT, ciUrl: "https://ci.example/920" },
];

function explainPayload(taskId: string, withEvidence: boolean): unknown {
  return {
    version: 1,
    taskId,
    role: "engineer",
    status: "complete",
    warnings: [],
    verificationEvidence: withEvidence ? EVIDENCE : [],
  };
}

function mountPage(taskId: string): string {
  // A minimal page that mounts RunExplainPanel via the SAME vendored bare specifiers the
  // shell's import map wires up. No CSP here (this is a test fixture), so the inline
  // module is admitted directly.
  return `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<script type="importmap">{"imports":{"preact":"/client/vendor/preact/preact.js","preact/hooks":"/client/vendor/preact/hooks.js","htm":"/client/vendor/htm/htm.js","marked":"/client/vendor/marked/marked.js"}}</script>
</head><body><div id="root"></div>
<script type="module">
import { h, render } from "preact";
import htm from "htm";
import { RunExplainPanel } from "/client/run-explain-panel.js";
const html = htm.bind(h);
render(html\`<\${RunExplainPanel} taskId=${JSON.stringify(taskId)} onClose=\${() => {}} />\`, document.getElementById("root"));
</script></body></html>`;
}

function createFixtureServer(): Server {
  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    // /mount/:taskId serves the mount page; :taskId=task-evidence carries evidence,
    // task-empty carries none.
    const mountMatch = url.pathname.match(/^\/mount\/([^/]+)$/);
    if (mountMatch) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(mountPage(mountMatch[1]!));
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
    const explainMatch = url.pathname.match(/^\/api\/task\/([^/]+)\/explain$/);
    if (explainMatch) {
      const taskId = decodeURIComponent(explainMatch[1]!);
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(explainPayload(taskId, taskId === "task-evidence")));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" }).end("[]");
  });
}

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

async function openMount(taskId: string): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 }, reducedMotion: "reduce" });
  await page.goto(`${baseUrl}/mount/${encodeURIComponent(taskId)}`);
  await page.locator(".rx-panel").waitFor({ timeout: 5000 });
  return page;
}

test("FG-746 (AC6): Explain renders a Verification evidence block with commit, gate/command, source, outcome, timestamp", async () => {
  const page = await openMount("task-evidence");
  const block = page.locator('[data-testid="rx-verification-evidence"]');
  await block.waitFor({ timeout: 5000 });
  const text = await block.innerText();
  assert.match(text, /npm run test:all/, "the host gate command renders");
  assert.match(text, /test-extended/, "the CI gate renders");
  assert.match(text, /host/, "the host source renders");
  assert.match(text, /ci/, "the ci source renders");
  assert.match(text, /eee4444eee/, "the commit sha renders");
  assert.match(text, /pass/, "the passing outcome renders");
  assert.match(text, /2026-08-22/, "the timestamp renders");
  const rows = await page.locator('[data-testid="rx-verif-row"]').count();
  assert.equal(rows, 2, "both evidence rows render");
  await page.screenshot({ path: join(SHOTS, "explain-verification-evidence.png") });
  await page.close();
});

test("FG-746 (AC6): Explain degrades cleanly — no Verification evidence block when the sidecar is empty", async () => {
  const page = await openMount("task-empty");
  // The panel is up; give any evidence block a beat to (not) appear.
  await page.waitForTimeout(300);
  assert.equal(await page.locator('[data-testid="rx-verification-evidence"]').count(), 0, "no evidence block renders when there is no evidence");
  await page.close();
});
