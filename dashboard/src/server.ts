// forge-dashboard — tiny HTTP server.
//
// - GET /                serves the SPA shell (HTML + inline client JS)
// - GET /api/feed        recent agent outputs across all projects (?projectDir filter)
// - GET /api/in-flight   currently-running / awaiting-gate tasks (?projectDir filter)
// - GET /api/projects    project registry: name, color, last activity, live sessions (#154)
// - GET /api/task/:id    full task detail (result + stdout/stderr logs + verdicts + gates)
//
// All reads. No writes. Mutating actions (gate/next/retry) shell to the
// `forge` CLI binary — wired in a later iteration; the MVP is read-only.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { recentActivity, inFlight, taskDetail, projectsForDashboard, usageRollup, usageTimeSeries } from "./queries.js";
import type { GroupBy } from "./queries.js";
import { renderShell } from "./shell.js";

const PORT = Number(process.env.PORT ?? 8024);
const HOST = process.env.HOST ?? "127.0.0.1";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = resolve(HERE, "..", "client");

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  try {
    handle(req, res);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: msg }));
  }
});

function handle(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);
  const path = url.pathname;

  if (req.method !== "GET") {
    res.writeHead(405, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  if (path === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(renderShell());
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
    const projectDir = url.searchParams.get("projectDir") ?? undefined;
    const data = recentActivity(limit, since, projectDir);
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(data));
    return;
  }

  if (path === "/api/in-flight") {
    const projectDir = url.searchParams.get("projectDir") ?? undefined;
    const data = inFlight(projectDir);
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(data));
    return;
  }

  if (path === "/api/projects") {
    const data = projectsForDashboard();
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(data));
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
    const projectDir = url.searchParams.get("projectDir") ?? undefined;
    const limit = clamp(Number(url.searchParams.get("limit") ?? 50), 1, 200);
    const data = usageRollup(raw as GroupBy, since, projectDir, limit);
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(data));
    return;
  }

  if (path === "/api/usage/timeseries") {
    const since = url.searchParams.get("since") ?? "30d";
    const projectDir = url.searchParams.get("projectDir") ?? undefined;
    const data = usageTimeSeries(since, projectDir);
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(data));
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

  res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "not found" }));
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

server.listen(PORT, HOST, () => {
  console.log(`forge-dashboard listening at http://${HOST}:${PORT}`);
});
