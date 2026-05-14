import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse, Server } from "node:http";
import { URL } from "node:url";
import { spawn as cpSpawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { dashboardHtml } from "./html.js";
import * as queries from "./queries.js";
import { validateNewRunBody, buildForgeNewArgv, WORKFLOW_SPECS, WORKFLOW_ORDER, WORKFLOW_GROUPS, UNIVERSAL_FIELDS } from "./workflowSchema.js";
import { AUTH_ERROR_PREFIX, getAuthState } from "../util/creds.js";
import { getTask } from "../store/tasks.js";
import { getRun } from "../store/runs.js";

let _server: Server | null = null;

// FORGE-DEC-015: dashboard mutations shell out to the forge CLI; in-process
// gate/dispatch logic stays out of this file. The dashboard is unconditionally
// interactive — #89 dropped FORGE_DASHBOARD_INTERACTIVE in 2026-05-09 once
// interactive use was proven and the flag was just friction. CSRF header
// (X-Forge-Request) remains the actual defense against drive-by browser POSTs.

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
    // Preserve the interactive=true field for backwards compat with any
    // dashboard tab still loaded from before #89; the flag is dead but
    // returning the field as always-true means old clients keep working.
    res
      .writeHead(200, { "Content-Type": "application/json" })
      .end(JSON.stringify({ interactive: true }));
    return;
  }

  if (path === "/api/workflows") {
    // Workflow schema for the new-run modal — order, fields, validation hints.
    // GET-only so no CSRF / interactive gate; the schema is dashboard-internal
    // and pulling it out keeps html.ts decoupled from workflow definitions.
    res
      .writeHead(200, { "Content-Type": "application/json" })
      .end(JSON.stringify({
        order: WORKFLOW_ORDER,
        groups: WORKFLOW_GROUPS,
        universal: UNIVERSAL_FIELDS,
        workflows: WORKFLOW_SPECS,
      }));
    return;
  }

  if (path === "/api/runs") {
    const runs = queries.listRunsForDashboard();
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ runs }));
    return;
  }

  if (path === "/api/auth-mode") {
    // #97 — dashboard auth indicator. Read-only snapshot of the active mode +
    // identity hint + health, computed from the dashboard process's env. Re-
    // evaluated on every GET so the indicator catches SSO expiry without a
    // dashboard restart (the dashboard polls this on a schedule client-side).
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(getAuthState()));
    return;
  }

  const runMatch = path.match(/^\/api\/runs\/([^/]+)$/);
  if (runMatch) {
    const id = runMatch[1];
    void queries.getRunWithShouldPoll(id!).then((data) => {
      if (!data) {
        res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Not found" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(data));
    }).catch((e: Error) => {
      res.writeHead(500, { "Content-Type": "application/json" })
         .end(JSON.stringify({ error: e.message || "Failed to load run" }));
    });
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
  // CSRF mitigation — every mutation requires a custom header. This is the
  // actual defense against drive-by browser POSTs; the interactive flag was
  // belt-and-suspenders and got dropped in #89.
  const requestHeader = req.headers[CSRF_HEADER];
  if (!requestHeader || requestHeader === "") {
    res.writeHead(403, { "Content-Type": "application/json" })
       .end(JSON.stringify({ error: "Missing X-Forge-Request header" }));
    return;
  }

  void readBody(req).then((body) => {
    const gateMatch = path.match(/^\/api\/gate\/([^/]+)$/);
    if (gateMatch) return handleGate(gateMatch[1]!, body, res);
    const nextMatch = path.match(/^\/api\/next\/([^/]+)$/);
    if (nextMatch) return handleNext(nextMatch[1]!, body, res);
    const retryMatch = path.match(/^\/api\/retry\/([^/]+)$/);
    if (retryMatch) return handleRetry(retryMatch[1]!, res);
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

  // #108: chain into next() on a successful advance so the user doesn't have
  // to click "Run Next" right after "Advance." The CLI keeps gate/next as
  // composable primitives; this is a dashboard-only convenience.
  //
  // Skip the chain when:
  //   - decision wasn't advance (reject / request-changes land in different
  //     states by design; the human should decide what's next)
  //   - the run finalized (terminal advance — nothing left to dispatch)
  //   - we can't resolve the runId (defensive; surface gate result anyway)
  if (decision !== "advance") {
    return jsonOk(res, { taskId, decision, summary: tail(out.stdout) });
  }
  const task = getTask(taskId);
  if (!task) {
    return jsonOk(res, { taskId, decision, summary: tail(out.stdout) });
  }
  const run = getRun(task.runId);
  if (!run || run.status === "complete") {
    return jsonOk(res, { taskId, decision, summary: tail(out.stdout) });
  }
  // project_dir is persisted on the run row from earlier; forge next reads
  // it without needing --project on the chain.
  const nextOut = await invokeForge(["next", task.runId]);
  if (nextOut.exitCode !== 0) {
    // Gate succeeded; dispatch failed. Surface both to the user — the gate
    // decision is durable in the DB, only the dispatch needs another nudge.
    if (nextOut.stderr.includes(AUTH_ERROR_PREFIX)) {
      return jsonError(res, 400, `Advanced ${taskId} but dispatch failed: ${nextOut.stderr.trim()}`);
    }
    return jsonError(res, 500, `Advanced ${taskId} but dispatch failed: ${nextOut.stderr || `forge next exited ${nextOut.exitCode}`}`);
  }
  jsonOk(res, {
    taskId,
    decision,
    summary: tail(out.stdout),
    dispatched: true,
    dispatchSummary: tail(nextOut.stdout),
  });
}

async function handleNext(runId: string, body: Record<string, unknown>, res: ServerResponse): Promise<void> {
  const project = typeof body.project === "string" ? body.project : "";
  const args = ["next", runId];
  if (project) args.push("--project", project);
  const out = await invokeForge(args);
  if (out.exitCode !== 0) {
    if (out.stderr.includes(AUTH_ERROR_PREFIX)) {
      return jsonError(res, 400, out.stderr.trim());
    }
    return jsonError(res, 500, out.stderr || `forge next exited ${out.exitCode}`);
  }
  jsonOk(res, { runId, summary: tail(out.stdout) });
}

async function handleRetry(taskId: string, res: ServerResponse): Promise<void> {
  const out = await invokeForge(["retry", taskId]);
  if (out.exitCode !== 0) return jsonError(res, 500, out.stderr || `forge retry exited ${out.exitCode}`);
  jsonOk(res, { taskId, summary: tail(out.stdout) });
}

async function handleNewRun(body: Record<string, unknown>, res: ServerResponse): Promise<void> {
  const workflow = typeof body.workflow === "string" ? body.workflow : "";
  if (!workflow) {
    return jsonValidation(res, [{ field: "workflow", message: "workflow is required." }]);
  }

  const validation = validateNewRunBody(workflow, body);
  if (!validation.ok) {
    return jsonValidation(res, validation.errors);
  }

  const argv = buildForgeNewArgv(workflow, validation.values);
  const out = await invokeForge(argv);
  if (out.exitCode !== 0) {
    // Route auth pre-flight failures to a 400 so the frontend can render a
    // useful toast (#79). The CLI's stderr will contain the AUTH_ERROR_PREFIX
    // string for any failure that came from validateCredsForNewRun.
    if (out.stderr.includes(AUTH_ERROR_PREFIX)) {
      return jsonError(res, 400, out.stderr.trim());
    }
    return jsonError(res, 500, out.stderr || `forge new exited ${out.exitCode}`);
  }

  // Parse the new run id from `forge new`'s stdout — the first line is "Created run <id>".
  const match = out.stdout.match(/Created run (\S+)/);
  const runId = match ? match[1] : undefined;
  jsonOk(res, { runId, summary: tail(out.stdout, 8) });
}

function jsonValidation(res: ServerResponse, errors: { field: string; message: string }[]): void {
  res.writeHead(400, { "Content-Type": "application/json" })
     .end(JSON.stringify({ error: "Validation failed", errors }));
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
