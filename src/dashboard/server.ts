import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse, Server } from "node:http";
import { URL } from "node:url";
import { spawn as cpSpawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { dashboardHtml } from "./html.js";
import * as queries from "./queries.js";

let _server: Server | null = null;

// FORGE-DEC-015: dashboard mutations shell out to the forge CLI; in-process
// gate/dispatch logic stays out of this file. The interactivity flag gates the
// POST handlers — when off, the read-only dashboard works exactly as before.
function isInteractive(): boolean {
  return process.env.FORGE_DASHBOARD_INTERACTIVE === "1";
}

// Tiny CSRF mitigation per FORGE-DEC-015: HTML <form> POSTs from a malicious
// localhost-adjacent context can't set custom headers, so we require one for
// every mutating request. Plain JSON fetches from this dashboard's own client
// JS attach the header (see html.ts).
const CSRF_HEADER = "x-forge-request";

export function startDashboard(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      const path = url.pathname;
      const method = req.method ?? "GET";

      if (method === "GET") {
        return handleGet(path, res);
      }
      if (method === "POST") {
        return handlePost(path, req, res);
      }

      res.writeHead(405, { "Content-Type": "application/json" })
         .end(JSON.stringify({ error: "Method not allowed" }));
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

function handleGet(path: string, res: ServerResponse): void {
  if (path === "/") {
    const html = dashboardHtml();
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(html);
    return;
  }

  if (path === "/api/meta") {
    res
      .writeHead(200, { "Content-Type": "application/json" })
      .end(JSON.stringify({ interactive: isInteractive() }));
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
}

function handlePost(path: string, req: IncomingMessage, res: ServerResponse): void {
  // CSRF mitigation — every mutation requires a custom header.
  const requestHeader = req.headers[CSRF_HEADER];
  if (!requestHeader || requestHeader === "") {
    res.writeHead(403, { "Content-Type": "application/json" })
       .end(JSON.stringify({ error: "Missing X-Forge-Request header" }));
    return;
  }
  if (!isInteractive()) {
    res.writeHead(503, { "Content-Type": "application/json" })
       .end(JSON.stringify({
         error: "Dashboard is read-only. Set FORGE_DASHBOARD_INTERACTIVE=1 before launching the dashboard to enable mutations.",
       }));
    return;
  }

  void readBody(req).then((body) => {
    const gateMatch = path.match(/^\/api\/gate\/([^/]+)$/);
    if (gateMatch) return handleGate(gateMatch[1]!, body, res);
    const nextMatch = path.match(/^\/api\/next\/([^/]+)$/);
    if (nextMatch) return handleNext(nextMatch[1]!, body, res);
    if (path === "/api/runs") return handleNewRun(body, res);

    res.writeHead(404, { "Content-Type": "application/json" })
       .end(JSON.stringify({ error: "Not found" }));
  }).catch((err: Error) => {
    res.writeHead(400, { "Content-Type": "application/json" })
       .end(JSON.stringify({ error: err.message || "Invalid request" }));
  });
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          resolve(parsed as Record<string, unknown>);
        } else {
          reject(new Error("Body must be a JSON object"));
        }
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

async function handleGate(taskId: string, body: Record<string, unknown>, res: ServerResponse): Promise<void> {
  const decision = body.decision;
  if (decision !== "advance" && decision !== "reject" && decision !== "request-changes") {
    return jsonError(res, 400, "decision must be one of: advance, reject, request-changes");
  }
  const rationale = typeof body.rationale === "string" ? body.rationale.trim() : "";
  const force = body.force === true;
  const args = ["gate", taskId, decision];
  if (rationale) args.push("--rationale", rationale);
  if (force) args.push("--force");
  const out = await invokeForge(args);
  if (out.exitCode !== 0) return jsonError(res, 500, out.stderr || `forge gate exited ${out.exitCode}`);
  jsonOk(res, { taskId, decision, summary: tail(out.stdout) });
}

async function handleNext(runId: string, body: Record<string, unknown>, res: ServerResponse): Promise<void> {
  const project = typeof body.project === "string" ? body.project : "";
  const args = ["next", runId];
  if (project) args.push("--project", project);
  const out = await invokeForge(args);
  if (out.exitCode !== 0) return jsonError(res, 500, out.stderr || `forge next exited ${out.exitCode}`);
  jsonOk(res, { runId, summary: tail(out.stdout) });
}

async function handleNewRun(_body: Record<string, unknown>, res: ServerResponse): Promise<void> {
  // Stub per OVERNIGHT-SCOPE: real new-run form is deferred to a follow-up.
  // The dashboard surfaces the equivalent CLI command in the modal instead.
  jsonError(res, 501, "POST /api/runs is not implemented yet — use `forge new` from a terminal.");
}

function jsonOk(res: ServerResponse, payload: Record<string, unknown>): void {
  res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(payload));
}
function jsonError(res: ServerResponse, status: number, error: string): void {
  res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify({ error }));
}

function tail(text: string, lines = 6): string {
  const arr = text.trim().split(/\r?\n/);
  return arr.slice(Math.max(0, arr.length - lines)).join("\n");
}

// Locate the forge CLI entry. The dashboard subprocess reuses the same Node /
// tsx that's running the parent, via the bin script in package.json.
function forgeBin(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..", "bin", "forge");
}

type RunOutput = { exitCode: number; stdout: string; stderr: string };

// Test seam: lets server.test.ts inject a fake forge subprocess instead of the
// real one. Default = run the real CLI via cpSpawn.
let _runForgeOverride: ((args: string[]) => Promise<RunOutput>) | undefined;
export function _setRunForgeOverrideForTest(fn: ((args: string[]) => Promise<RunOutput>) | undefined): void {
  _runForgeOverride = fn;
}

async function invokeForge(args: string[]): Promise<RunOutput> {
  if (_runForgeOverride) return _runForgeOverride(args);
  return new Promise((resolve) => {
    const proc = cpSpawn(process.execPath, [forgeBin(), ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    proc.stdout.on("data", (c: Buffer) => out.push(c));
    proc.stderr.on("data", (c: Buffer) => err.push(c));
    proc.on("close", (code) => {
      resolve({
        exitCode: code ?? 1,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      });
    });
    proc.on("error", (e: Error) => {
      resolve({ exitCode: 1, stdout: "", stderr: e.message });
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
