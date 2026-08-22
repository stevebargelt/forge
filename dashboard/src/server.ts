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
// - GET /api/reviews                      the review ledger: reviews + their findings, read-only (?limit, FG-638)
// - GET /api/shipping-audit               per-ticket readiness + shipping-review + mechanical-check projection for ONE project, read-only (?projectKey|?projectDir, FG-386)
// - GET /api/agent-runtime                average agent runtime over time, overall + per role (?window=1d|7d|30d|90d|all, FG-648)
// - GET /api/completed-runs               completed forge RUNS per bucket over the same window grid — a count, not a duration (FG-683)
// - GET /api/queue                        the operator work-queue board: five projections + dispatcher panel + capacity context (?projectKey|?projectDir, FG-591)
// - GET /api/orchestrators                interactive orchestrators for ONE project, liveness-joined; the only route that can carry a remote-control URL (?projectKey|?projectDir REQUIRED, FG-576)
//
// - POST /api/queue/enqueue|dequeue|rank|reorder   the operator's QUEUE PLANNING writes (FG-591)
//
// Every GET is a read. The four POSTs above are the ONLY mutating routes on this
// surface, and they do not write the DB either: each shells exactly one named `forge
// queue` verb (FORGE-DEC-015), guarded same-origin and behind a non-simple content
// type. Arming autonomous dispatch and setting max_active_runs are deliberately NOT
// exposed here (FG-591 D2) — that is authority to run repo-writing containers
// unattended, and it stays CLI-only. See queue-mutation.ts.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  recentActivity, inFlight, taskDetail, projectsForDashboard, operatorProjectsForDashboard, usageRollup, usageTimeSeries, usageModelMix, opsMetrics, routingGovernance,
  inProgressVerifications, reviewLoopRunPhases, hostVerificationsForTicket, hostVerificationsForCampaignItem, recentHostVerifications,
  resolveProjectScope, backlogTruthForProject, reviewLedger, agentRuntimeTrends, completedRunTrends, isAgentRuntimeWindow, AGENT_RUNTIME_WINDOWS,
  currentActivity, launchDetail, launchLogTail, queueBoard, scopedOrchestratorView, shippingAudit, effectiveConfigGraph,
} from "./queries.js";
import type { BacklogTicket, GroupBy, ProjectRecord, ProjectScope } from "./queries.js";
import { isLaunchId } from "@forge/current-activity";
import { budgetedLivenessProbe, RECONCILE_FANOUT_BUDGET_MS } from "@forge/reconcile-candidate";
import { assembleCampaignReport, assembleCampaignSummaries } from "@forge/campaign-report";
import type { ReportResult } from "@forge/campaign-report";
import { runInReadOnlyDbScope } from "@forge/store-db";
import type { Campaign } from "@forge/types";
import { renderShell, contentSecurityPolicy, cspNonce } from "./shell.js";
import { getPlanUsage } from "./plan-usage.js";
import { finishUnhandledRequest, degradedGraphErrorPayload } from "./http-error.js";
import { handleQueueMutation, isQueueMutationPath } from "./queue-mutation.js";
import {
  guardBindAddress,
  guardMutationRequest,
  resolveForgeBinary,
  runForgeVerb,
} from "./queue-mutation.js";

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

  // FG-591 (D1, FORGE-DEC-015): the ONLY non-GET routes on this surface. Everything
  // else — including a CORS PREFLIGHT for these very paths — still falls through to
  // the 405 below, and no `Access-Control-Allow-*` header is emitted anywhere on this
  // server. That absence is what makes a cross-origin preflight fail closed, so the
  // browser never sends the real request.
  //
  // The project is resolved through the dashboard's OWN registry, exactly as
  // /api/queue resolves it, and passed as a THUNK: the registry read costs a bounded
  // `git` evidence probe, and a request refused for being cross-origin or for
  // carrying a forgeable content type must not pay for it (nor look, from a guard's
  // point of view, like a route that spawned something before refusing).
  if (req.method === "POST" && isQueueMutationPath(path)) {
    const projectDir = url.searchParams.get("projectDir") ?? undefined;
    const projectKey = url.searchParams.get("projectKey") ?? undefined;
    await handleQueueMutation(req, res, path, {
      resolveOwner: () => resolveOwnerProject(projectsForDashboard(), projectKey, projectDir),
      requestedProjectDir: projectDir,
    });
    return;
  }

  // FG-745 (AC8): the bounded operator classify/repair mutation for an unclassified
  // legacy or manually-created workspace. Same DEC-015 shape as the queue mutations —
  // it shells exactly `forge projects classify` (the atomic REFUSE-on-conflict claim)
  // and writes no DB row itself — behind the same bind-address + cross-origin guards.
  if (req.method === "POST" && path === PROJECTS_CLASSIFY_PATH) {
    await handleProjectsClassify(req, res);
    return;
  }

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
    // FG-742: /api/in-flight `docker inspect`s each eligible running task synchronously
    // (FG-290's reconcile annotation, BD-13's recorded serving-path exception). On the
    // single-threaded dashboard process that fan-out blocks the event loop, and a
    // concurrent /api/current-activity poll queued behind a slow/hung docker daemon then
    // exceeds its 8s client deadline. A per-request budget bounds how long this poll can
    // hold the loop, isolating the current-activity read from a slow sibling. current-
    // activity itself stays outbound-call-free (BD-7) and takes no probe.
    const data = inFlight(scopeFromUrl(url), budgetedLivenessProbe(RECONCILE_FANOUT_BUDGET_MS));
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(data));
    return;
  }

  // FG-679. THREE NEW SERVING PATHS, DELIBERATELY SEPARATE FROM /api/in-flight.
  //
  // BD-7 forbids any outbound call — GitHub, shell, `git`, tmux, Forge CLI — from a
  // serving or polling path, and the criterion has to be provable by a RUNTIME GUARD
  // rather than by inspection. `/api/in-flight` already `execFileSync`s `docker
  // inspect` per running task (FG-290's reconcile-candidate annotation, a recorded
  // pre-existing exception — BD-13), so folding these in would make that guard
  // unassertable. They stay separate so the guard can be scoped to exactly the paths
  // this ticket adds — and it must not be widened to cover /api/in-flight, nor
  // narrowed to pass over a path that does shell out.
  if (path === "/api/current-activity") {
    const runId = url.searchParams.get("runId") ?? undefined;
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(currentActivity(scopeFromUrl(url), runId)));
    return;
  }

  // BD-10: addressed by launch IDENTITY. No host filesystem path is accepted here,
  // and none is returned — an id outside the launch charset (`..`, a separator, an
  // absolute path) is refused with a 400 BEFORE it can become a path, by the same
  // definition src/v2/launch.ts's launchDir enforces.
  const launchLogMatch = path.match(/^\/api\/launches\/([^/]+)\/log$/);
  if (launchLogMatch) {
    const id = decodeLaunchId(launchLogMatch[1]!);
    if (!isLaunchId(id)) {
      res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "invalid launch id" }));
      return;
    }
    const tail = launchLogTail(id);
    if (!tail) {
      res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "not found" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(tail));
    return;
  }

  const launchMatch = path.match(/^\/api\/launches\/([^/]+)$/);
  if (launchMatch) {
    const id = decodeLaunchId(launchMatch[1]!);
    if (!isLaunchId(id)) {
      res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "invalid launch id" }));
      return;
    }
    const detail = launchDetail(id);
    if (!detail) {
      res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "not found" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(detail));
    return;
  }

  if (path === "/api/projects") {
    // FG-745: operator-project MEMBERSHIP — the same set `forge projects list`
    // returns (AC7). A classified artifact is omitted; an unclassified legacy dir is
    // included and carries `classification: "unclassified"` so the client can flag it
    // and offer the classify affordance; a one-run/no-remote independent project stays
    // included (no heuristic decides visibility). Current Activity is unaffected: it
    // reads the unfiltered projectsForDashboard() scope, so an active artifact's runs
    // and live session remain visible under its owner (AC5).
    const data = operatorProjectsForDashboard();
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

  if (path === "/api/config-graph") {
    // FG-349: read-only EFFECTIVE config graph (Control-Plane Sources +
    // provider/runtime capabilities) for the selected checkout. Pure GET — NOT a
    // POST-mutation route, no subprocess. Checkout-specific: a projectKey without
    // an exact projectDir is refused, like /api/governance.
    const projectDir = url.searchParams.get("projectDir") ?? undefined;
    if (url.searchParams.has("projectKey") && !projectDir) {
      res.writeHead(409, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Select an exact checkout for the control-plane config graph." }));
      return;
    }
    // Build the payload BEFORE writeHead so a degraded read never leaves a
    // half-written response / blank page.
    let payload: string;
    try {
      payload = JSON.stringify(effectiveConfigGraph(projectDir));
    } catch (err) {
      console.error("/api/config-graph: building the config graph failed:", err);
      // Route the degraded-response error string through the same redaction
      // boundary the config-graph object uses — an exception message is a surfaced
      // string and must not leak a secret outside the redaction guarantee.
      payload = degradedGraphErrorPayload(err);
    }
    res.writeHead(200, { "Content-Type": "application/json" }).end(payload);
    return;
  }

  if (path === "/api/backlog") {
    const projectDir = url.searchParams.get("projectDir") ?? undefined;
    const projectKey = url.searchParams.get("projectKey") ?? undefined;
    const projects = projectsForDashboard();
    const project = !projectDir && projectKey ? projects.find((entry) => entry.key === projectKey) : undefined;
    // Notes are operational context and remain per-selection: a projectKey
    // request keeps every checkout's session handoff (multi-checkout); an exact
    // projectDir request keeps that one checkout's session-specific notes.
    // FG-380 state, read per checkout from the filesystem — orthogonal to ticket
    // truth, which moved to the host store below.
    const checkouts = project
      ? project.checkouts.filter((checkout) => checkout.exists)
      : projectDir
        ? [{ projectDir, branch: undefined }]
        : [];
    if (checkouts.length === 0) {
      res.writeHead(200, { "Content-Type": "application/json" }).end(
        JSON.stringify({ notes: "", tickets: [], ticketsProjectKey: null, ticketsStorageMode: null }),
      );
      return;
    }
    const notesByCheckout: Array<{ checkoutDir: string; checkoutBranch: string | null; notes: string }> = [];
    for (const checkout of checkouts) {
      const notesPath = join(checkout.projectDir, "backlog", "notes.md");
      const notes = existsSync(notesPath) ? readFileSync(notesPath, "utf8") : "";
      if (notes.trim()) notesByCheckout.push({ checkoutDir: checkout.projectDir, checkoutBranch: checkout.branch ?? null, notes });
    }

    // FG-608: ticket truth is HOST-WIDE, keyed by project_key — the same rows for
    // every checkout of one repository. The canonical main/master ticket-source
    // resolution this replaced was branch-local by construction; that concept is
    // gone, so selecting a feature checkout, a linked worktree or the canonical
    // repo all answer identically and no branch-local ticket file is ever read.
    //
    // The project is resolved from the dashboard's OWN registry — by key for a
    // projectKey request, by observed path for an exact projectDir request — and
    // backlogTruthForProject derives the project_key from that resolved record's
    // repository evidence. The request's projectKey parameter is never used as a
    // store key: trusting it would turn a per-project board into a cross-project
    // one (FG-591), which this slice is explicitly not.
    const owner = resolveOwnerProject(projects, projectKey, projectDir);
    let tickets: BacklogTicket[] = [];
    // null means "this project has no ticket truth" — unregistered (never
    // imported), or not resolvable to a project at all. Distinct from a
    // registered project whose board is simply empty, which reports its key.
    let ticketsProjectKey: string | null = null;
    let ticketsStorageMode: "db" | "markdown" | null = null;
    let ticketsError: string | undefined;
    if (owner) {
      try {
        const truth = backlogTruthForProject(owner);
        tickets = truth.tickets;
        ticketsProjectKey = truth.projectKey;
        ticketsStorageMode = truth.storageMode;
      } catch (err) {
        // ONLY "the store disappeared between resolution and reading" is absorbed
        // silently — that one is expected and an empty backlog is the truthful
        // answer for it. Every other throw (a store that won't open, a schema
        // that predates the ticket tables) means we do NOT know this project's
        // tickets, and rendering [] as if we did is how FG-607 turned a five-line
        // change into four red test files with no diagnostic. Still 200 with what
        // we have — a dashboard panel must not take the page down — but the error
        // is named on stderr and in the payload rather than vanishing, and the
        // notes half of this response is unaffected by a ticket-read failure.
        if (isMissingPath(err)) {
          tickets = [];
        } else {
          ticketsError = err instanceof Error ? err.message : String(err);
          console.error(`/api/backlog: reading tickets for project ${owner.key} failed:`, err);
        }
      }
    }
    const notes = checkouts.length === 1 ? notesByCheckout[0]?.notes ?? "" : "";
    res.writeHead(200, { "Content-Type": "application/json" }).end(
      JSON.stringify({
        notes,
        notesByCheckout,
        tickets,
        ticketsProjectKey,
        ticketsStorageMode,
        ...(ticketsError ? { ticketsError } : {}),
      }),
    );
    return;
  }

  // FG-591: the operator work queue board. READ-ONLY, like every route here — the
  // five board views are PROJECTIONS over orthogonal durable fields (rank,
  // membership, lifecycle) with in progress / blocked / done DERIVED on this read
  // and never stored. The board itself is direct SQL on the dashboard's own
  // read-only handle — no subprocess, no outbound call, no write.
  //
  // The ONE binary this path reaches is the shared project registry's bounded,
  // 30s-cached `git` evidence read, resolving WHICH project the request is about —
  // the same resolution /api/backlog and /api/projects already perform, and the
  // same answer they must give (a board that resolved projects differently from
  // the backlog panel beside it would be the worse failure). That is a recorded
  // pre-existing property of the registry, not something this route introduces, so
  // the FG-679 BD-7 guard stays scoped to its own three paths — neither widened to
  // cover this one nor narrowed to excuse it.
  //
  // Arming autonomous dispatch and setting max_active_runs are deliberately NOT
  // here and not anywhere on this surface (D2) — they authorize unattended
  // repo-writing containers, which is a materially larger capability than a read.
  if (path === "/api/queue") {
    const projectDir = url.searchParams.get("projectDir") ?? undefined;
    const projectKey = url.searchParams.get("projectKey") ?? undefined;
    // The payload is built BEFORE any byte is written: a read that throws after
    // writeHead cannot be reported, and a recoverable "old store" would become a
    // closed socket and a blank page (the /api/reviews precedent).
    let payload: string;
    try {
      const projects = projectsForDashboard();
      const owner = resolveOwnerProject(projects, projectKey, projectDir);
      payload = JSON.stringify(queueBoard(owner ?? null, projects));
    } catch (err) {
      // A store written before FG-591 has no dispatcher tables, and a read-only
      // open never migrates one into existence (db.ts's policy) — that case is
      // absorbed per-read and reported in `degraded`. Anything reaching here is a
      // whole-board failure: report it in the payload and keep the page up, but
      // never render it as an empty board, which would read as "nothing queued".
      const message = err instanceof Error ? err.message : String(err);
      console.error("/api/queue: reading the queue board failed:", err);
      payload = JSON.stringify({ error: message });
    }
    res.writeHead(200, { "Content-Type": "application/json" }).end(payload);
    return;
  }

  // FG-576 step 11 (AC7 / AC11 / FG-448 / D13): the interactive orchestrators of ONE
  // project, joined to the launcher-owned liveness record, and the ONLY route that
  // can ever carry a remote-control URL.
  //
  // PROJECT-SCOPED BY CONSTRUCTION. A scope parameter is REQUIRED and it is resolved
  // through the dashboard's OWN registry, exactly as /api/queue and /api/backlog
  // resolve it — an unscoped or unregistered request is refused rather than widened,
  // because "every orchestrator on the host" is precisely the cross-project payload a
  // live control credential must never be assembled into. The URL is additionally
  // withheld entirely off a loopback bind (queries.ts, remoteControlWithheldReason):
  // 200, rows intact, no link, no error.
  //
  // no-store: a credential-bearing response must not sit in an intermediary or in
  // the browser's disk cache after the session it belongs to has ended.
  if (path === "/api/orchestrators") {
    const projectDir = url.searchParams.get("projectDir") ?? undefined;
    const projectKey = url.searchParams.get("projectKey") ?? undefined;
    if (!projectDir && !projectKey) {
      res.writeHead(400, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(
        JSON.stringify({
          error:
            "a project scope is required: pass ?projectKey= or ?projectDir=. This route is never answered across projects.",
        }),
      );
      return;
    }
    const owner = resolveOwnerProject(projectsForDashboard(), projectKey, projectDir);
    if (!owner) {
      res.writeHead(404, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(
        JSON.stringify({ error: "no registered project matches this request." }),
      );
      return;
    }
    // An exact checkout stays exact; a projectKey request covers that repository's
    // own observed paths and nothing else.
    const scope = projectDir ?? owner.projectDirs;
    let payload: string;
    try {
      payload = JSON.stringify(scopedOrchestratorView(scope));
    } catch (err) {
      // Keep the page up, name the failure — but never render an empty list as if
      // it were the answer, which would read as "no orchestrator is running".
      const message = err instanceof Error ? err.message : String(err);
      console.error("/api/orchestrators: reading orchestrator receipts failed:", err);
      payload = JSON.stringify({ error: message });
    }
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(payload);
    return;
  }

  if (path === "/api/ops") {
    const since = url.searchParams.get("since") ?? "30d";
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(opsMetrics(since, scopeFromUrl(url))));
    return;
  }

  if (path === "/api/agent-runtime") {
    const window = url.searchParams.get("window") ?? "7d";
    if (!isAgentRuntimeWindow(window)) {
      res.writeHead(400, { "Content-Type": "application/json" }).end(
        JSON.stringify({ error: `invalid window; expected one of ${AGENT_RUNTIME_WINDOWS.join(", ")}` }),
      );
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(agentRuntimeTrends(window, scopeFromUrl(url))));
    return;
  }

  // FG-683: the throughput sibling of /api/agent-runtime — same windows, same
  // scope, same UTC bucket grid, but a count of completed RUNS per bucket. A
  // separate route rather than a mode of that one, so the duration response shape
  // and its default behaviour are untouched for every existing caller.
  if (path === "/api/completed-runs") {
    const window = url.searchParams.get("window") ?? "7d";
    if (!isAgentRuntimeWindow(window)) {
      res.writeHead(400, { "Content-Type": "application/json" }).end(
        JSON.stringify({ error: `invalid window; expected one of ${AGENT_RUNTIME_WINDOWS.join(", ")}` }),
      );
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(completedRunTrends(window, scopeFromUrl(url))));
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

  if (path === "/api/reviews") {
    const limit = clamp(Number(url.searchParams.get("limit") ?? 25), 1, 200);
    // The payload is built BEFORE any byte is written. A read that throws after
    // writeHead cannot be reported — the headers are already out and the second
    // write dies on ERR_HTTP_HEADERS_SENT, which is how a recoverable "old store"
    // turns into a closed socket and a blank page.
    let payload: string;
    try {
      payload = JSON.stringify({ reviews: reviewLedger(scopeFromUrl(url), limit) });
    } catch (err) {
      // A store written before FG-638 has no `reviews` table, and a read-only open
      // never migrates one into existence (db.ts's policy). That is a legitimate
      // state, not a server fault: report it in the payload and keep the page up,
      // exactly as /api/backlog does for a pre-ticket-tables store.
      const message = err instanceof Error ? err.message : String(err);
      console.error("/api/reviews: reading the review ledger failed:", err);
      payload = JSON.stringify({ reviews: [], error: message });
    }
    res.writeHead(200, { "Content-Type": "application/json" }).end(payload);
    return;
  }

  if (path === "/api/shipping-audit") {
    const projectDir = url.searchParams.get("projectDir") ?? undefined;
    const projectKey = url.searchParams.get("projectKey") ?? undefined;
    const limit = clamp(Number(url.searchParams.get("limit") ?? 200), 1, 500);
    // Built BEFORE any byte is written — the /api/reviews precedent: a read that
    // throws after writeHead cannot be reported and becomes a blank page.
    let payload: string;
    try {
      const owner = resolveOwnerProject(projectsForDashboard(), projectKey, projectDir);
      payload = JSON.stringify(shippingAudit(owner ?? null, limit));
    } catch (err) {
      // A store predating FG-382/384 has no readiness/reviews tables, and a
      // read-only open never migrates them into existence (db.ts's policy). That
      // is a legitimate state, not a fault: report it and keep the page up.
      const message = err instanceof Error ? err.message : String(err);
      console.error("/api/shipping-audit: reading the shipping audit failed:", err);
      payload = JSON.stringify({ projectKey: null, rows: [], degraded: [], error: message });
    }
    res.writeHead(200, { "Content-Type": "application/json" }).end(payload);
    return;
  }

  // FG-395: the read-only Campaigns projection — recent campaign summaries for the
  // owner project (here), and one campaign's full report (below). Both REUSE the
  // campaign report contract (src/campaign/report.ts) rather than re-deriving
  // done-audit / readiness / verdict / next-action / git-state in dashboard SQL,
  // and both run the assembly inside runInReadOnlyDbScope so the reused store reads
  // can NEVER open the shared ~/.forge/forge.db writable or run a migration against
  // it: the store's getDb() default is read-WRITE (db.ts:702), and the scope forces
  // the read-only handle for the no-arg calls assembleCampaignReport makes.
  if (path === "/api/campaigns") {
    const projectDir = url.searchParams.get("projectDir") ?? undefined;
    const projectKey = url.searchParams.get("projectKey") ?? undefined;
    // A non-numeric ?limit=abc makes Number() NaN, and clamp(NaN) stays NaN — which
    // slice(0, NaN) coerces to 0, silently reporting an empty list as success. Fall
    // back to the default so a garbage limit lists truthfully rather than empty.
    const rawLimit = Number(url.searchParams.get("limit") ?? 50);
    const limit = clamp(Number.isFinite(rawLimit) ? rawLimit : 50, 1, 200);
    // Built BEFORE any byte is written — the /api/reviews precedent: a read that
    // throws after writeHead cannot be reported and becomes a blank page.
    let payload: string;
    try {
      // Owner resolution uses the dashboard's OWN registry, exactly as /api/queue
      // and /api/shipping-audit resolve it. An unregistered projectDir still filters
      // to campaigns recorded against that exact path (the fallback set) rather than
      // widening to every project's campaigns; an unscoped request lists all.
      const owner = resolveOwnerProject(projectsForDashboard(), projectKey, projectDir);
      const scoped = projectKey !== undefined || projectDir !== undefined;
      const acceptedDirs = new Set<string>(
        owner
          ? [...owner.projectDirs, ...owner.checkouts.map((c) => c.projectDir)]
          : projectDir
            ? [projectDir]
            : [],
      );
      const accepts = (c: Campaign): boolean =>
        !scoped ? true : c.projectDir !== undefined && acceptedDirs.has(c.projectDir);
      const campaigns = runInReadOnlyDbScope(() => assembleCampaignSummaries(accepts, limit));
      payload = JSON.stringify({ projectKey: owner?.key ?? null, campaigns });
    } catch (err) {
      // A store predating the campaign tables has no rows to read, and a read-only
      // open never migrates them into existence (db.ts's policy). Report it and keep
      // the page up, exactly as /api/shipping-audit does for a pre-tables store.
      const message = err instanceof Error ? err.message : String(err);
      console.error("/api/campaigns: reading campaign summaries failed:", err);
      // A read that THREW is an unavailable/malformed store, not a legit-empty one:
      // report 503 so a status-only consumer never reads it as a successful list. The
      // body shape is unchanged, so the client's degraded-state rendering still works.
      res
        .writeHead(503, { "Content-Type": "application/json" })
        .end(JSON.stringify({ projectKey: null, campaigns: [], error: message }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" }).end(payload);
    return;
  }

  // FG-395: one campaign's full detail. There is NO separate serializer — the wire
  // form is exactly JSON.stringify(assembleCampaignReport(id)). Unknown id → the
  // assembler returns null → 404. Same read-only scope + degraded-store guard as the
  // list above.
  if (path.startsWith("/api/campaign/")) {
    const id = path.slice("/api/campaign/".length);
    let report: ReportResult | null;
    try {
      report = runInReadOnlyDbScope(() => assembleCampaignReport(id));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`/api/campaign/${id}: assembling the campaign report failed:`, err);
      // A thrown read is an unavailable/malformed store → 503, not a 200 a status-only
      // consumer treats as a successful report. Unknown id stays 404 (below); the
      // {error} body shape is unchanged for the client's degraded-state rendering.
      res.writeHead(503, { "Content-Type": "application/json" }).end(JSON.stringify({ error: message }));
      return;
    }
    if (!report) {
      res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: `campaign ${id} not found` }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(report));
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

/** Percent-decode a captured launch id, or return a sentinel `isLaunchId` refuses.
 *
 *  `decodeURIComponent` THROWS on a malformed encoding — `/api/launches/%`,
 *  `/api/launches/%E0%A4%A` — and an uncaught throw here became a 500 instead of the
 *  4xx an identity-addressed surface owes a bad identity (BD-10). A bad id is a bad
 *  request whether or not it happens to be decodable, so an undecodable one is refused
 *  through the SAME charset guard as everything else rather than a second code path. */
function decodeLaunchId(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return "";
  }
}

/** The path underneath the read is gone — the one ticket-read failure
 *  /api/backlog is entitled to report as an empty backlog rather than as a
 *  named error. Since FG-608 that path is the host store, not a checkout. */
function isMissingPath(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** WHICH REGISTERED PROJECT OWNS THIS REQUEST — by key for a `projectKey`
 *  request, by observed path for an exact `projectDir` one. The request's
 *  projectKey parameter is never used as a STORE key: the store key is derived
 *  from the resolved record's own repository evidence, because trusting the
 *  parameter would turn a per-project board into a cross-project one. */
function resolveOwnerProject(
  projects: ProjectRecord[],
  projectKey: string | undefined,
  projectDir: string | undefined,
): ProjectRecord | undefined {
  const byKey = !projectDir && projectKey ? projects.find((entry) => entry.key === projectKey) : undefined;
  if (byKey) return byKey;
  if (!projectDir) return undefined;
  return projects.find((entry) =>
    entry.projectDirs.includes(projectDir) ||
    entry.checkouts.some((checkout) => checkout.projectDir === projectDir));
}

function scopeFromUrl(url: URL): ProjectScope {
  return resolveProjectScope(
    url.searchParams.get("projectKey") ?? undefined,
    url.searchParams.get("projectDir") ?? undefined,
  );
}

// ─── FG-745: the operator classify/repair mutation ───────────────────────────────

export const PROJECTS_CLASSIFY_PATH = "/api/projects/classify";

/** The workspace-kind vocabulary the route accepts. Duplicated from the store
 *  DELIBERATELY: DEC-015 keeps this mutation surface off the store (it shells the CLI,
 *  which is the authoritative validator). A value outside this set is refused here so
 *  a bad request never reaches a subprocess; the CLI re-validates regardless. */
const CLASSIFY_PURPOSES = ["operator", "disposable_clone", "worktree", "evidence_fixture", "unclassified"] as const;

const MAX_CLASSIFY_BODY_BYTES = 16 * 1024;
/** A durable owner/run/task id operand — a charset that cannot express a leading
 *  `-`, a path separator, `..`, a shell metacharacter, or whitespace. */
const OWNER_OPERAND = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function classifyHeader(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res
    .writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" })
    .end(JSON.stringify(payload));
}

async function readClassifyBody(req: IncomingMessage): Promise<{ ok: true; text: string } | { ok: false; status: number; error: string }> {
  let total = 0;
  const chunks: Buffer[] = [];
  try {
    for await (const chunk of req) {
      const buf = chunk as Buffer;
      total += buf.length;
      if (total > MAX_CLASSIFY_BODY_BYTES) {
        req.destroy();
        return { ok: false, status: 413, error: `the request body exceeds ${MAX_CLASSIFY_BODY_BYTES} bytes.` };
      }
      chunks.push(buf);
    }
  } catch {
    return { ok: false, status: 400, error: "the request body could not be read." };
  }
  return { ok: true, text: Buffer.concat(chunks).toString("utf8") };
}

/** Handle POST /api/projects/classify. The ORDER is the security property: every
 *  refusal happens before a subprocess is spawned. `dir` is caller-supplied (an
 *  operator names the legacy workspace to classify) and is validated as an absolute,
 *  non-flag operand; the `forge projects classify` claim it delegates to only records
 *  a purpose row — it never deletes a workspace or rewrites a run. */
async function handleProjectsClassify(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const bindRefusal = guardBindAddress();
  if (bindRefusal) {
    sendJson(res, bindRefusal.status, { ok: false, error: bindRefusal.error });
    return;
  }
  const headerRefusal = guardMutationRequest({
    contentType: classifyHeader(req, "content-type"),
    origin: classifyHeader(req, "origin"),
    secFetchSite: classifyHeader(req, "sec-fetch-site"),
    host: classifyHeader(req, "host"),
  });
  if (headerRefusal) {
    sendJson(res, headerRefusal.status, { ok: false, error: headerRefusal.error });
    return;
  }

  const body = await readClassifyBody(req);
  if (!body.ok) {
    sendJson(res, body.status, { ok: false, error: body.error });
    return;
  }
  let parsed: unknown;
  try {
    parsed = body.text.trim() === "" ? {} : JSON.parse(body.text);
  } catch {
    sendJson(res, 400, { ok: false, error: "the request body is not valid JSON." });
    return;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    sendJson(res, 400, { ok: false, error: "the request body must be a JSON object." });
    return;
  }
  const input = parsed as Record<string, unknown>;

  const dir = input["dir"];
  if (typeof dir !== "string" || dir === "" || !dir.startsWith("/") || dir.startsWith("-") || dir.length > 4096 || dir.includes("\0")) {
    sendJson(res, 400, { ok: false, error: "dir is required and must be an absolute path with no leading '-' or NUL." });
    return;
  }
  const purpose = input["purpose"];
  if (typeof purpose !== "string" || !(CLASSIFY_PURPOSES as readonly string[]).includes(purpose)) {
    sendJson(res, 400, { ok: false, error: `purpose must be one of: ${CLASSIFY_PURPOSES.join(", ")}.` });
    return;
  }
  // FG-745 (review RF-2): attribute the audit row to the SURFACE, server-side. The
  // actor is NOT taken from the request body — a value the unauthenticated client could
  // forge would attribute the decision to whomever it named. "dashboard" records the
  // honest, unforgeable fact: this visibility change came through the network-reachable
  // operator surface (distinct from a host shell user, which the CLI records as $USER).
  const argv = ["projects", "classify", dir, "--purpose", purpose, "--actor", "dashboard", "--json"];
  for (const [field, flag] of [["ownerIdentity", "--owner-identity"], ["run", "--run"], ["task", "--task"]] as const) {
    const raw = input[field];
    if (raw === undefined || raw === null || raw === "") continue;
    if (typeof raw !== "string" || !OWNER_OPERAND.test(raw)) {
      sendJson(res, 400, { ok: false, error: `${field} must match ${OWNER_OPERAND}.` });
      return;
    }
    argv.push(flag, raw);
  }

  const binary = resolveForgeBinary();
  if ("ok" in binary && binary.ok === false) {
    sendJson(res, binary.status, { ok: false, error: binary.error });
    return;
  }
  const result = await runForgeVerb((binary as { path: string }).path, argv, dirname(HERE));
  if (result.timedOut) {
    sendJson(res, 504, { ok: false, error: "`forge projects classify` did not finish in time." });
    return;
  }
  if (result.code !== 0) {
    const reason = result.stderr.trim() || result.stdout.trim() || `\`forge projects classify\` exited ${result.code}`;
    // A REFUSE-on-conflict from the atomic claim surfaces here as the CLI's own stderr.
    sendJson(res, 409, { ok: false, error: reason.slice(-4096).trim() });
    return;
  }
  let cliResult: unknown = null;
  try {
    cliResult = JSON.parse(result.stdout);
  } catch {
    cliResult = null;
  }
  sendJson(res, 200, { ok: true, result: cliResult });
}

server.listen(PORT, HOST, () => {
  console.log(`forge-dashboard listening at http://${HOST}:${PORT}`);
  // The surface is READ-ONLY and unauthenticated by design, and one of the things it
  // reads is a bounded tail of RAW host-command output (`/api/launches/:id/log`). On
  // the default loopback bind that is a local operator surface; on any other address
  // it is reachable by a network peer, and the operator is told so rather than left to
  // infer it from the absence of a login screen.
  if (!/^(127\.|::1$|localhost$)/.test(HOST)) {
    console.error(
      `forge-dashboard: bound to ${HOST}, NOT loopback. This surface has no authentication and serves ` +
        `raw, unredacted output of host commands (/api/launches/<id>/log). Any peer that can reach ${HOST}:${PORT} can read it. ` +
        `The queue-planning POST routes (/api/queue/*) FAIL CLOSED off loopback for that reason — set ` +
        `FORGE_DASHBOARD_ALLOW_REMOTE_MUTATIONS=1 only if this dashboard is fronted by your own authentication.`,
    );
  }
});
