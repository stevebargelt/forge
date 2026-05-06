import { createServer } from "node:http";
import type { Server } from "node:http";
import { URL } from "node:url";
import { dashboardHtml } from "./html.js";
import * as queries from "./queries.js";

let _server: Server | null = null;

export function startDashboard(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      const path = url.pathname;
      const method = req.method ?? "GET";

      if (method !== "GET") {
        res.writeHead(404).end(JSON.stringify({ error: "Not found" }));
        return;
      }

      if (path === "/") {
        const html = dashboardHtml();
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(html);
        return;
      }

      if (path === "/api/runs") {
        const runs = queries.listRunsForDashboard();
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ runs }));
        return;
      }

      const runMatch = path.match(/^\/api\/runs\/([^/]+)$/);
      if (runMatch) {
        const id = runMatch[1];
        const data = queries.getRunWithShouldPoll(id!);
        if (!data) {
          res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Not found" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(data));
        return;
      }

      const taskMatch = path.match(/^\/api\/tasks\/([^/]+)$/);
      if (taskMatch) {
        const id = taskMatch[1];
        const data = queries.getTaskDetail(id!);
        if (!data) {
          res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Not found" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(data));
        return;
      }

      res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Not found" }));
    });

    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        console.error(`Error: port ${port} is already in use`);
        process.exit(1);
      }
      reject(err);
    });

    server.listen(port, "127.0.0.1", () => {
      _server = server;
      resolve();
    });
  });
}

export function shutdown(): void {
  if (_server) {
    _server.close(() => {
      queries.closeDb();
      process.exit(0);
    });
  }
}

export function closeServerForTest(): Promise<void> {
  return new Promise((resolve) => {
    if (_server) { _server.close(() => resolve()); _server = null; }
    else resolve();
  });
}
