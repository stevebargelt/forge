// forge-dashboard — tiny HTTP server.
//
// - GET /                serves the SPA shell (HTML + inline client JS)
// - GET /api/feed        recent agent outputs across all projects (?projectDir filter)
// - GET /api/in-flight   currently-running / awaiting-gate tasks (?projectDir filter)
// - GET /api/projects    project registry: name, color, last activity, live sessions (#154)
// - GET /api/task/:id    full task detail (result + stdout/stderr logs + verdicts + gates)
// - GET /api/verifications/in-progress   host verification (review-loop / campaign reconcile) currently running (FG-487)
// - GET /api/review-loop/phases          active review-loop runs with a distinguishable phase (?projectDir filter, FG-487)
// - GET /api/host-verifications           host_verifications evidence rows, ?ticketId=|&projectDir= or ?itemId= (FG-487)
// - GET /api/host-verifications/recent    most recent host_verifications rows, unscoped (?limit) (FG-487)
//
// All reads. No writes. Mutating actions (gate/next/retry) shell to the
// `forge` CLI binary — wired in a later iteration; the MVP is read-only.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  recentActivity, inFlight, taskDetail, projectsForDashboard, usageRollup, usageTimeSeries, usageModelMix, opsMetrics, routingGovernance,
  inProgressVerifications, reviewLoopRunPhases, hostVerificationsForTicket, hostVerificationsForCampaignItem, recentHostVerifications,
  resolveProjectScope,
} from "./queries.js";
import type { GroupBy, ProjectScope } from "./queries.js";
import { renderShell, contentSecurityPolicy, cspNonce } from "./shell.js";
import { listTickets } from "@forge/backlog";
import { getPlanUsage } from "./plan-usage.js";
import { finishUnhandledRequest } from "./http-error.js";

const PORT = Number(process.env.PORT ?? 8024);
const HOST = process.env.HOST ?? "127.0.0.1";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = resolve(HERE, "..", "client");

export const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  void handle(req, res).catch(() => finishUnhandledRequest(res));
});

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);
  const path = url.pathname;

  if (req.method !== "GET") {
    res.writeHead(405, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  if (path === "/") {
    serveShell(res);
    return;
  }

  // Static client JS. Whitelisted paths only — no path-traversal risk because
  // we re-resolve and verify containment under CLIENT_DIR.
  if (path.startsWith("/client/")) {
    const rel = path.slice("/client/".length);
    const filePath = resolve(CLIENT_DIR, rel);
    if (!filePath.startsWith(CLIENT_DIR + "/")) {
      res.writeHead(403, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "forbidden" }));
      return;
    }
    if (!existsSync(filePath)) {
      res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "not found" }));
      return;
    }
    const body = readFileSync(filePath);
    const ct =
      filePath.endsWith(".js")  ? "application/javascript; charset=utf-8" :
      filePath.endsWith(".svg") ? "image/svg+xml" :
      filePath.endsWith(".css") ? "text/css; charset=utf-8" :
      filePath.endsWith(".png") ? "image/png" :
      filePath.endsWith(".ico") ? "image/x-icon" :
      "application/octet-stream";
    res.writeHead(200, { "Content-Type": ct, "Cache-Control": "no-cache" }).end(body);
    return;
  }

  if (path === "/api/feed") {
    const since = url.searchParams.get("since") ?? undefined;
    const limit = clamp(Number(url.searchParams.get("limit") ?? 100), 1, 500);
    const data = recentActivity(limit, since, scopeFromUrl(url));
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(data));
    return;
  }

  if (path === "/api/in-flight") {
    const data = inFlight(scopeFromUrl(url));
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(data));
    return;
  }

  if (path === "/api/projects") {
    const data = projectsForDashboard();
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(data));
    return;
  }

  if (path === "/api/governance") {
    // Read-only: the effective routing policy for the (optional) project, the
    // host-vs-project diff, drift/uncompiled/invalid warnings, and recent audit.
    const projectDir = url.searchParams.get("projectDir") ?? undefined;
    if (url.searchParams.has("projectKey") && !projectDir) {
      res.writeHead(409, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Select an exact checkout for project routing governance." }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(routingGovernance(projectDir)));
    return;
  }

  if (path === "/api/backlog") {
    const projectDir = url.searchParams.get("projectDir") ?? undefined;
    const projectKey = url.searchParams.get("projectKey") ?? undefined;
    const project = !projectDir && projectKey ? projectsForDashboard().find((entry) => entry.key === projectKey) : undefined;
    const checkouts = project
      ? project.checkouts.filter((checkout) => checkout.exists)
      : projectDir
        ? [{ projectDir, branch: undefined }]
        : [];
    if (checkouts.length === 0) {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ notes: "", tickets: [] }));
      return;
    }
    const notesByCheckout: Array<{ checkoutDir: string; checkoutBranch: string | null; notes: string }> = [];
    const tickets: Array<Record<string, unknown>> = [];
    for (const checkout of checkouts) {
      const notesPath = join(checkout.projectDir, "backlog", "notes.md");
      const notes = existsSync(notesPath) ? readFileSync(notesPath, "utf8") : "";
      if (notes.trim()) notesByCheckout.push({ checkoutDir: checkout.projectDir, checkoutBranch: checkout.branch ?? null, notes });
      try {
        for (const ticket of listTickets(checkout.projectDir)) {
          tickets.push({ ...ticket, checkoutDir: checkout.projectDir, checkoutBranch: checkout.branch ?? null });
        }
      } catch {
        // A checkout may disappear between registry resolution and reading.
      }
    }
    const notes = checkouts.length === 1 ? notesByCheckout[0]?.notes ?? "" : "";
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ notes, notesByCheckout, tickets }));
    return;
  }

  if (path === "/api/ops") {
    const since = url.searchParams.get("since") ?? "30d";
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(opsMetrics(since, scopeFromUrl(url))));
    return;
  }

  if (path === "/api/usage") {
    const raw = url.searchParams.get("groupBy") ?? "project";
    const validGroupBy: GroupBy[] = ["role", "workflow", "project", "model", "alias"];
    if (!validGroupBy.includes(raw as GroupBy)) {
      res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "invalid groupBy" }));
      return;
    }
    const since = url.searchParams.get("since") ?? "30d";
    const limit = clamp(Number(url.searchParams.get("limit") ?? 50), 1, 200);
    const data = usageRollup(raw as GroupBy, since, scopeFromUrl(url), limit);
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(data));
    return;
  }

  if (path === "/api/usage/limits") {
    const refresh = url.searchParams.get("refresh") === "1";
    const data = await getPlanUsage(refresh);
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(data));
    return;
  }

  if (path === "/api/usage/timeseries") {
    const since = url.searchParams.get("since") ?? "30d";
    const data = usageTimeSeries(since, scopeFromUrl(url));
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(data));
    return;
  }

  if (path === "/api/usage/model-mix") {
    const raw = url.searchParams.get("groupBy") ?? "project";
    const validGroupBy: GroupBy[] = ["role", "workflow", "project", "model", "alias"];
    if (!validGroupBy.includes(raw as GroupBy)) {
      res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "invalid groupBy" }));
      return;
    }
    const since = url.searchParams.get("since") ?? "30d";
    const data = usageModelMix(raw as GroupBy, since, scopeFromUrl(url));
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(data));
    return;
  }


  // FG-487: host-side verification visibility — review-loop verification
  // phases (incl. FG-501 CI-wait), campaign reconcile's real-exec gates, and
  // the host_verifications evidence they record. See queries.ts's FG-487
  // section for the events-spine contract these read.
  if (path === "/api/verifications/in-progress") {
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(inProgressVerifications(Date.now(), scopeFromUrl(url))));
    return;
  }

  if (path === "/api/review-loop/phases") {
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(reviewLoopRunPhases(Date.now(), scopeFromUrl(url))));
    return;
  }

  if (path === "/api/host-verifications/recent") {
    const limit = clamp(Number(url.searchParams.get("limit") ?? 50), 1, 500);
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(recentHostVerifications(limit, scopeFromUrl(url))));
    return;
  }

  if (path === "/api/host-verifications") {
    const itemId = url.searchParams.get("itemId");
    const ticketId = url.searchParams.get("ticketId");
    if (itemId) {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(hostVerificationsForCampaignItem(itemId, scopeFromUrl(url))));
      return;
    }
    if (ticketId) {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(hostVerificationsForTicket(ticketId, scopeFromUrl(url))));
      return;
    }
    res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "ticketId or itemId required" }));
    return;
  }

  const taskMatch = path.match(/^\/api\/task\/(.+)$/);
  if (taskMatch) {
    const detail = taskDetail(taskMatch[1]!);
    if (!detail) {
      res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "not found" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(detail));
    return;
  }

  if (!path.startsWith("/api/")) {
    serveShell(res);
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "not found" }));
}

// FG-580: every HTML response carries `Content-Security-Policy: script-src 'self'
// 'nonce-…'` so the browser enforces first-party-only script execution (no CDN JS) at
// runtime. The same nonce is emitted into the shell's inline importmap so it is admitted.
function serveShell(res: ServerResponse): void {
  const nonce = cspNonce();
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": contentSecurityPolicy(nonce),
  }).end(renderShell(nonce));
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function scopeFromUrl(url: URL): ProjectScope {
  return resolveProjectScope(
    url.searchParams.get("projectKey") ?? undefined,
    url.searchParams.get("projectDir") ?? undefined,
  );
}

server.listen(PORT, HOST, () => {
  console.log(`forge-dashboard listening at http://${HOST}:${PORT}`);
});
