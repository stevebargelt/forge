// FG-781 (step 3): the Remote Board's DEDICATED loopback endpoint.
//
// WHY A SEPARATE SERVER, NOT A ROUTE PREFIX. This is its own `http.Server` with its own
// handler — NOT a mode-gated branch multiplexed into the local dashboard's 8024 listener
// (../server.ts). That separation is what makes two FG-781 invariants STRUCTURAL rather than
// review-enforced:
//   * AC7 (no remote mutation): this handler has NO non-GET branch and imports NOTHING from
//     queue-mutation / the classify path / any DB-lifecycle writer. There is no line of code
//     that could reach handleQueueMutation or handleProjectsClassify, so "the remote surface
//     exposes no mutation route" is a property of the module graph, not of a guard that
//     could be widened by accident.
//   * AC1 (local dashboard unchanged): the local server has no idea this exists beyond one
//     additive, env-gated boot call. Nothing here touches its route table, headers, or
//     listener.
//
// FAIL CLOSED. FG-781 ships NO transport adapter, so the bound identity resolver refuses
// every request (`no-adapter`). The board endpoint therefore returns the `unauthorized`
// envelope — `board: null`, no project data — on every request, no matter what identity or
// proxy headers it carries (AC2 / AC6). The granted path below is written for the adapters
// FG-782/FG-784 will plug in, but it is unreachable until one exists.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { finishUnhandledRequest } from "../http-error.js";
import { projectsForDashboard } from "../queries.js";
import type { ProjectRecord } from "../queries.js";
import {
  createRemoteIdentityResolver,
  hasCapability,
  type BoundRemoteIdentityResolver,
  type TransportAdapter,
} from "./identity.js";
import {
  assembleRemoteBoard,
  hostUnavailableRemoteBoard,
  redactRemoteFreeText,
  unauthorizedRemoteBoard,
  type RemoteBoardEnvelope,
  type RemoteBoardState,
  type RemoteProjectGrant,
} from "./projection.js";
import {
  REMOTE_BOARD_ENDPOINT,
  REMOTE_CLIENT_URL_PREFIX,
  remoteContentSecurityPolicy,
  remoteCspNonce,
  renderRemoteShell,
} from "./shell.js";
import { isLoopbackHost, resolveRemoteConfig, type RemoteBoardConfig } from "./config.js";
import { selectRemoteAdapter, type RemoteTransportDeps } from "./transport.js";
// FG-783 (step 5): the bounded WRITE surface. The store authority (the ONLY writer of the
// planning tables, holding ledger + precondition + mutation + audit in one atomic
// transaction), the pure body/registry/CSRF guards (step 4), and the Serve-owned CSRF pin.
import {
  applyRemotePlanningCommand,
  remotePlanningAudit,
  type RemotePlanningAuditRow,
  type RemotePlanningCommand,
} from "../../../src/store/remote-planning.js";
import { queueView } from "../../../src/store/queue.js";
import {
  validatePlanningEnvelope,
  isPlanningRefusal,
  MAX_BODY_BYTES,
  type PlanningEnvelope,
  type PlanningRefusal,
} from "./planning/envelope.js";
import { guardRemotePlanningRequest } from "./planning/csrf.js";
import { readServeState, type ServeStateRecord } from "./tailscale/serve-state.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// dashboard/src/remote → dashboard/remote-client. The focused board asset set (FG-781 step
// 5), served by RUNTIME PATH exactly as ../server.ts serves /client/* — never a build-time
// import, so this module carries no dependency on the UI step.
const REMOTE_CLIENT_DIR = resolve(HERE, "..", "..", "remote-client");

// FG-783: the ONE route this surface answers with POST. Everything else — every GET path, and
// every non-GET method — stays exactly as FG-781/782 left it. Exported so the client/shell
// (step 6) names the same string rather than re-spelling it.
export const REMOTE_PLAN_ENDPOINT = "/api/plan";

// RF-1: the same-project, read-gated audit read the ticket contract promises ("audit
// output is remotely readable within the same project"). A GET that returns ONLY the
// authenticated identity's project's planning-ledger rows — actor, transport, request
// id, action, target, precondition, outcome, timestamp; never a secret or a path. The
// store already scopes remotePlanningAudit(projectKey) to one project; the free-text
// summary message is passed through the same redactor the board projection uses.
export const REMOTE_PLAN_AUDIT_ENDPOINT = "/api/plan/audit";

/** An unauthenticated-adjacent write surface must not be a flood target: each planning command
 *  takes the machine-wide write lock briefly through the store authority. Small, deliberate,
 *  and reported by name when it bites — mirroring queue-mutation.ts's MAX_CONCURRENT_MUTATIONS. */
const MAX_CONCURRENT_PLANNING = 4;

/** Injectable seams. Every default is the fail-closed production wiring; tests and the
 *  future transport adapters override only what they need. */
export interface RemoteBoardDeps {
  /** The bound identity resolver. Default: no adapter → every request refuses (FG-781). */
  readonly resolveIdentity?: BoundRemoteIdentityResolver;
  /** Convenience: build the default resolver from an adapter (FG-782/FG-784). Ignored when
   *  `resolveIdentity` is supplied. */
  readonly adapter?: TransportAdapter | null;
  /** Resolve a granted project key to its record. Default: the dashboard registry. */
  readonly lookupProject?: (projectKey: string) => ProjectRecord | undefined;
  /** Injected clock (ms) for deterministic envelope stamps. */
  readonly now?: () => number;
  /** The on-disk directory the remote asset prefix maps to. Overridable for tests. */
  readonly clientDir?: string;
  /** FG-782/FG-784: injectable seams for the boot-SELECTED transport adapter — the union over
   *  every transport (Tailscale's `confirmPeer`/`runner`, Cloudflare's `jwksCache`/
   *  `loadAccessState`/`now`/…) plus the shared `loadMapping`/`env` — passed to
   *  {@link selectRemoteAdapter} alongside the resolved `lookupProject`. Production leaves this
   *  undefined (each adapter defaults to its real backend + on-disk mapping); tests inject a
   *  fake daemon or a fake JWKS/access-state through the SAME selection path. Consulted ONLY by
   *  {@link maybeStartRemoteBoardFromEnv}, and only when neither `resolveIdentity` nor
   *  `adapter` was supplied — an explicit resolver/adapter is respected as-is. */
  readonly transportDeps?: Omit<RemoteTransportDeps, "lookupProject">;
  /** FG-783: the Serve-owned CSRF pin. Defaults to the real Forge-owned serve-state record
   *  under FORGE_HOME; tests inject a record so the CSRF guard has a public hostname to pin to
   *  without a real `tailscale serve setup`. Absent state fails the guard closed (step 4). */
  readonly readServeState?: () => ServeStateRecord | null;
}

/** RF-4: is the adapter's CLAIMED member-dir set consistent with the granted project's OWN
 *  dirs? A claim is authorized only when it is non-empty AND every dir it names is one of the
 *  project's own dirs. The actual projection scope is taken from the project, not the claim —
 *  this predicate is the gate that refuses a cross-project claim before any data is assembled. */
export function claimedDirsWithinProject(
  claimedDirs: readonly string[],
  projectDirs: readonly string[],
): boolean {
  if (claimedDirs.length === 0) return false;
  const own = new Set(projectDirs);
  return claimedDirs.every((dir) => own.has(dir));
}

/** HTTP status for each envelope state. The five-state discriminator lives in the BODY
 *  (the client switches on it); the status is defense-in-depth so an intermediary or cache
 *  never reads a refusal as a cacheable success. */
function statusForState(state: RemoteBoardState): number {
  switch (state) {
    case "live":
    case "stale":
      return 200;
    case "unauthorized":
      return 401;
    case "host-unavailable":
      return 503;
    case "unsupported":
      return 501;
  }
}

/** Write an envelope. `no-store` because a refusal (or a per-read projection) must not sit
 *  in a shared cache; `nosniff` because the body is JSON and must not be content-sniffed. */
function sendEnvelope(res: ServerResponse, envelope: RemoteBoardEnvelope): void {
  res
    .writeHead(statusForState(envelope.state), {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    })
    .end(JSON.stringify(envelope));
}

function serveRemoteShell(res: ServerResponse): void {
  const nonce = remoteCspNonce();
  res
    .writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": remoteContentSecurityPolicy(nonce),
      "X-Content-Type-Options": "nosniff",
    })
    .end(renderRemoteShell(nonce));
}

/** Serve a focused-board asset by runtime path, with the same containment discipline
 *  ../server.ts uses for /client/*: re-resolve under the asset dir and refuse anything that
 *  escapes it (path traversal), 404 anything absent. NEVER serves outside REMOTE_CLIENT_DIR,
 *  so it can never reach the local client bundle. */
function serveRemoteAsset(res: ServerResponse, clientDir: string, path: string): void {
  const rel = path.slice(REMOTE_CLIENT_URL_PREFIX.length);
  const filePath = resolve(clientDir, rel);
  if (filePath !== clientDir && !filePath.startsWith(clientDir + "/")) {
    res.writeHead(403, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "forbidden" }));
    return;
  }
  if (!existsSync(filePath)) {
    res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "not found" }));
    return;
  }
  const ct = filePath.endsWith(".js")
    ? "application/javascript; charset=utf-8"
    : filePath.endsWith(".css")
      ? "text/css; charset=utf-8"
      : filePath.endsWith(".svg")
        ? "image/svg+xml"
        : filePath.endsWith(".png")
          ? "image/png"
          : "application/octet-stream";
  res.writeHead(200, { "Content-Type": ct, "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" }).end(readFileSync(filePath));
}

// ─── FG-783: the bounded planning POST surface ───────────────────────────────

/** One inbound header value, first-only (Node folds repeats into an array). */
function planHeader(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** Read the request body under a hard cap. As soon as the accumulated size crosses
 *  {@link MAX_BODY_BYTES} we STOP accumulating and refuse (413) — an oversized upload is never
 *  buffered past the cap. We deliberately do NOT destroy the socket here: the caller still has to
 *  write the 413 response, and tearing the socket down first would surface a bare connection
 *  reset instead of the refusal. Detaching the listeners returns the stream to paused mode so the
 *  remaining upload is not read; the 413 response carries `Connection: close`, so the connection
 *  ends cleanly once the refusal has flushed. Returns the raw text or a fail-closed refusal. */
function readPlanningBody(req: IncomingMessage): Promise<{ ok: true; text: string } | PlanningRefusal> {
  return new Promise((resolvePromise) => {
    let total = 0;
    let settled = false;
    const chunks: Buffer[] = [];
    const cleanup = (): void => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
    };
    const settle = (value: { ok: true; text: string } | PlanningRefusal): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise(value);
    };
    const onData = (chunk: Buffer): void => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        settle({ ok: false, status: 413, error: `the request body exceeds ${MAX_BODY_BYTES} bytes.` });
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => settle({ ok: true, text: Buffer.concat(chunks).toString("utf8") });
    const onError = (): void => settle({ ok: false, status: 400, error: "the request body could not be read." });
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}

/**
 * Bridge the envelope's RELATIVE change-rank (rank `ticketId` before/after `reference`) onto the
 * store authority's POSITION-based change-rank command.
 *
 * WHY THIS TRANSLATION EXISTS (a step-3/step-4 modelling gap, flagged as a plan defect). Step 4's
 * envelope models a rank change relatively — the FG-591 lesson that "above FG-3" is intent that
 * survives the queue moving, where "position 4" is a coordinate that silently means something
 * else the moment anything moves. Step 3's store command, however, only exposes a POSITION
 * (moveQueuePosition); it never exported a relative rankBefore/rankAfter command. The clean fix
 * is a relative command in the store authority; until then the server bridges here.
 *
 * WHY THE READ IS SAFE. This reads the CURRENT queued order to compute the 1-based position that
 * reproduces before/after semantics — a READ, exactly as the board read path already reads queue
 * state; it writes NOTHING. The WRITE stays entirely inside applyRemotePlanningCommand's atomic
 * transaction, guarded by the queueVersion CAS the client supplied. That CAS is what makes the
 * translation race-free: the store applies the move ONLY if the queue is still at the client's
 * expectedVersion, and a version is the MAX order-affecting event id — so "same version" implies
 * "same order". Therefore, on the ONLY path where the move actually applies, the order the store
 * permutes is byte-for-byte the order this read saw, so the computed position lands exactly
 * before/after the reference. If the queue moved at all, the CAS refuses with zero mutation and
 * the client re-reads. A reference that is no longer queued (so the version already advanced past
 * the client's) is refused here with a re-read summary rather than silently clamped.
 */
function positionForRelativeRank(
  projectKey: string,
  ticketId: string,
  reference: string,
  placement: "before" | "after",
): number | PlanningRefusal {
  const queued = queueView(projectKey).filter((e) => e.queued).map((e) => e.ticketId);
  const without = queued.filter((id) => id !== ticketId);
  const refIndex = without.indexOf(reference);
  if (refIndex < 0) {
    return {
      ok: false,
      status: 409,
      error:
        `${reference} is not in the operator queue right now, so ${ticketId} cannot be ranked ${placement} it. ` +
        `Re-read the board and resubmit.`,
    };
  }
  const target = placement === "before" ? refIndex : refIndex + 1;
  return target + 1; // 1-based: moveQueuePosition inserts at (position - 1) within the without-list.
}

/**
 * Complete a validated, body-derived {@link PlanningEnvelope} into a full {@link RemotePlanningCommand}
 * by attaching the SERVER-AUTHORITATIVE actor / transport / project key (from the resolver and
 * the read-path scope — NEVER the body). This is the ONLY place the two shapes meet; it dispatches
 * exclusively to the closed store-command vocabulary, so no body can name a command outside it.
 */
function buildPlanningCommand(
  env: PlanningEnvelope,
  ctx: { actor: string; transport: string; projectKey: string },
): RemotePlanningCommand | PlanningRefusal {
  const base = { requestId: env.requestId, actor: ctx.actor, transport: ctx.transport, projectKey: ctx.projectKey };
  switch (env.action) {
    case "enqueue":
      // The store authority's enqueue evaluates readiness at the current revision and takes no
      // membership note (a step-3/step-4 gap: the envelope validates an optional note the store
      // does not persist — flagged, non-blocking).
      return { ...base, action: "enqueue", targetId: env.ticketId };
    case "dequeue":
      return { ...base, action: "dequeue", targetId: env.ticketId };
    case "append-annotation":
      return { ...base, action: "append-annotation", targetId: env.ticketId, body: env.body, ticketRevision: env.ticketRevision };
    case "reorder-queue": {
      if (env.reorder.kind === "full") {
        return {
          ...base,
          action: "reorder-queue",
          targetId: env.reorder.order[0]!,
          order: [...env.reorder.order],
          expectedVersion: env.expectVersion,
        };
      }
      // A single-move reorder is a position move — the store models that as change-rank.
      return {
        ...base,
        action: "change-rank",
        targetId: env.reorder.ticketId,
        position: env.reorder.to,
        expectedVersion: env.expectVersion,
      };
    }
    case "change-rank": {
      const position = positionForRelativeRank(ctx.projectKey, env.ticketId, env.reference, env.placement);
      if (isPlanningRefusal(position)) return position;
      return { ...base, action: "change-rank", targetId: env.ticketId, position, expectedVersion: env.expectVersion };
    }
  }
}

/** Write a JSON body on the planning surface. `no-store` (a refusal or per-command outcome must
 *  not sit in a shared cache), `nosniff`, and — deliberately — NO `Access-Control-Allow-*`
 *  header ever, which is what makes a cross-origin preflight fail closed. */
function sendPlanJson(res: ServerResponse, status: number, payload: unknown, extraHeaders: Record<string, string> = {}): void {
  res
    .writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...extraHeaders,
    })
    .end(JSON.stringify(payload));
}

/** Build the remote board request handler. */
export function createRemoteBoardHandler(deps: RemoteBoardDeps = {}): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const resolveIdentity = deps.resolveIdentity ?? createRemoteIdentityResolver(deps.adapter ?? null);
  const lookupProject = deps.lookupProject ?? ((key: string) => projectsForDashboard().find((p) => p.key === key));
  const now = deps.now ?? (() => Date.now());
  const clientDir = deps.clientDir ?? REMOTE_CLIENT_DIR;
  const serveState = deps.readServeState ?? (() => readServeState());
  // Per-handler concurrency counter — each server instance caps its own in-flight planning
  // commands, so tests that spin up several handlers do not share a global gate.
  let planInFlight = 0;

  async function handleBoard(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Identity comes ONLY from the bound resolver, which consults the (absent) transport
    // adapter — NEVER from req.headers. Any X-Forwarded-*/Tailscale/Cloudflare header on
    // this request is scanned only to be recorded as ignored, then discarded. The resolver
    // is uniformly async (FG-782 step 1), so its return is awaited on ONE path; a rejected
    // resolution propagates up to createRemoteBoardServer's fail-closed try/catch.
    //
    // `peer` carries the connection-level socket address/port — a connection FACT, not a
    // header — so an out-of-band adapter (FG-782 Tailscale whois) can anchor its confirmation
    // on the peer the origin actually observed rather than any attacker-settable header value.
    const resolution = await resolveIdentity({
      headers: req.headers,
      peer: { address: req.socket.remoteAddress, port: req.socket.remotePort },
    });
    if (!resolution.ok) {
      sendEnvelope(res, unauthorizedRemoteBoard(now()));
      return;
    }
    // A verified identity must still hold the read capability. Absent it, refuse — never
    // assemble a payload for an identity that was not granted read.
    if (!hasCapability(resolution.identity, "read")) {
      sendEnvelope(res, unauthorizedRemoteBoard(now()));
      return;
    }
    // Scope is the identity's SERVER-AUTHORITATIVE grant — projectKey + strict memberDirs —
    // never a client parameter. Resolve the record; a grant that names no registered
    // project degrades (host-unavailable), it does not widen.
    const project = lookupProject(resolution.identity.projectScope.projectKey);
    if (!project) {
      sendEnvelope(res, hostUnavailableRemoteBoard(now()));
      return;
    }
    // RF-4: the projection scope is SERVER-AUTHORITATIVE — the granted project's OWN member
    // dirs, resolved from the registry, NEVER the dirs the adapter handed us. The adapter's
    // claimed dirs are only trusted as far as they are consistent with the project (non-empty
    // AND a subset of its own dirs); an absent, empty, or out-of-scope claim is a scope-
    // confusion attempt (e.g. project A's key carrying project B's dir) and refuses with no
    // data rather than widening the projection past the granted project.
    if (!claimedDirsWithinProject(resolution.identity.projectScope.memberDirs, project.projectDirs)) {
      sendEnvelope(res, unauthorizedRemoteBoard(now()));
      return;
    }
    try {
      const grant: RemoteProjectGrant = { project, memberDirs: project.projectDirs };
      // RF-2: carry the verified identity's granted capabilities onto the envelope so the
      // client renders planning affordances ONLY for a `plan`-capable identity. A read-only
      // identity is never shown mutation controls the server would refuse.
      sendEnvelope(res, assembleRemoteBoard(grant, { nowMs: now(), capabilities: resolution.identity.capabilities }));
    } catch {
      // A degraded/unreadable host store must never take the surface down, and never leak
      // an internal error string — the closed envelope carries no project data.
      sendEnvelope(res, hostUnavailableRemoteBoard(now()));
    }
  }

  /**
   * RF-1: the same-project planning audit read. GET /api/plan/audit, gated on the `read`
   * capability (the SAME grant the board read requires), scoped to the identity's own
   * project. It reuses the read path's identity + scope checks exactly, so it can never
   * return another project's rows. The free-text summary message is redacted; every other
   * column (actor / transport / request id / action / target / precondition / outcome /
   * timestamp) is a bounded id or vocabulary value that carries no secret by construction.
   */
  async function handlePlanAudit(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const resolution = await resolveIdentity({
      headers: req.headers,
      peer: { address: req.socket.remoteAddress, port: req.socket.remotePort },
    });
    if (!resolution.ok) {
      sendPlanJson(res, 401, { ok: false, error: "unauthorized" });
      return;
    }
    if (!hasCapability(resolution.identity, "read")) {
      sendPlanJson(res, 403, { ok: false, error: "the verified identity does not hold the 'read' capability." });
      return;
    }
    const project = lookupProject(resolution.identity.projectScope.projectKey);
    if (!project) {
      sendPlanJson(res, 404, { ok: false, error: "the granted project is not registered on this host." });
      return;
    }
    if (!claimedDirsWithinProject(resolution.identity.projectScope.memberDirs, project.projectDirs)) {
      sendPlanJson(res, 401, { ok: false, error: "unauthorized" });
      return;
    }
    let rows: RemotePlanningAuditRow[];
    try {
      rows = remotePlanningAudit(resolution.identity.projectScope.projectKey);
    } catch {
      sendPlanJson(res, 503, { ok: false, error: "the planning audit could not be read." });
      return;
    }
    sendPlanJson(res, 200, {
      ok: true,
      projectKey: resolution.identity.projectScope.projectKey,
      rows: rows.map((r) => ({
        requestId: r.requestId,
        actor: r.actor,
        transport: r.transport,
        action: r.action,
        targetId: r.targetId,
        precondition: r.precondition,
        outcome: r.outcome,
        message: r.summary.message ? redactRemoteFreeText(r.summary.message) : "",
        createdAt: r.createdAt,
      })),
    });
  }

  /**
   * The bounded planning POST surface (FG-783). Every guard below runs IN ORDER and BEFORE any
   * write — and the write itself is one atomic transaction owned by the store authority, never a
   * handler-side DB write. The result carried back is the RECORDED outcome (applied, or refused +
   * a safe summary to re-read); it is NEVER a synthesized/optimistic success.
   *
   *   1. Identity — the SAME bound resolver the read path uses. Actor, transport and project
   *      scope are taken from it, never from the body. No identity → 401, no data.
   *   2. Capability — the verified identity must hold `plan`. A read-only identity is refused
   *      (403); the FG-781/782 read path is untouched for identities without `plan`.
   *   3. CSRF / same-origin (step 4) — a non-simple content type, Sec-Fetch-Site, and an
   *      Origin/Host pin to the Serve hostname from serve-state (never the request Host /
   *      X-Forwarded-Host / loopback bind). Absent serve-state fails closed.
   *   4. Concurrency cap — bounded in-flight commands.
   *   5. Body under a hard cap, then strict envelope validation (step 4) — malformed / oversized
   *      / an excluded-action shape / a body-supplied server-authoritative key all fail closed.
   *   6. Server-authoritative project scope — the granted project's OWN dirs, re-checked exactly
   *      as the read path does (claimedDirsWithinProject). A cross-project claim is refused.
   *   7. Delegate to applyRemotePlanningCommand — the single atomic owner of replay + precondition
   *      + mutation + audit.
   */
  async function handlePlan(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const resolution = await resolveIdentity({
      headers: req.headers,
      peer: { address: req.socket.remoteAddress, port: req.socket.remotePort },
    });
    if (!resolution.ok) {
      sendPlanJson(res, 401, { ok: false, error: "unauthorized" });
      return;
    }
    if (!hasCapability(resolution.identity, "plan")) {
      sendPlanJson(res, 403, {
        ok: false,
        error:
          "the verified identity does not hold the 'plan' capability; this surface refuses planning mutations for read-only identities.",
      });
      return;
    }

    const csrf = guardRemotePlanningRequest(
      {
        contentType: planHeader(req, "content-type"),
        origin: planHeader(req, "origin"),
        secFetchSite: planHeader(req, "sec-fetch-site"),
        host: planHeader(req, "host"),
      },
      serveState(),
    );
    if (csrf) {
      sendPlanJson(res, csrf.status, { ok: false, error: csrf.error });
      return;
    }

    if (planInFlight >= MAX_CONCURRENT_PLANNING) {
      sendPlanJson(res, 503, {
        ok: false,
        error: `too many planning commands in flight (${MAX_CONCURRENT_PLANNING}); retry in a moment.`,
      });
      return;
    }
    planInFlight += 1;
    try {
      const body = await readPlanningBody(req);
      if (isPlanningRefusal(body)) {
        // An oversized (413) upload is refused mid-stream with the rest of the body unread, so
        // close the connection once the refusal has flushed rather than leaving a paused socket.
        sendPlanJson(res, body.status, { ok: false, error: body.error }, body.status === 413 ? { Connection: "close" } : {});
        return;
      }
      let parsed: unknown;
      try {
        parsed = body.text.trim() === "" ? {} : JSON.parse(body.text);
      } catch {
        sendPlanJson(res, 400, { ok: false, error: "the request body is not valid JSON." });
        return;
      }

      const envelope = validatePlanningEnvelope(parsed);
      if (isPlanningRefusal(envelope)) {
        sendPlanJson(res, envelope.status, { ok: false, error: envelope.error });
        return;
      }

      // Server-authoritative scope, resolved exactly as the read path does: the granted
      // project's OWN dirs, never a body parameter. A grant that names no registered project, or
      // whose claimed dirs are not a subset of the project's own, is a scope-confusion attempt
      // and refuses with no mutation.
      const project = lookupProject(resolution.identity.projectScope.projectKey);
      if (!project) {
        sendPlanJson(res, 404, { ok: false, error: "the granted project is not registered on this host." });
        return;
      }
      if (!claimedDirsWithinProject(resolution.identity.projectScope.memberDirs, project.projectDirs)) {
        sendPlanJson(res, 401, { ok: false, error: "unauthorized" });
        return;
      }

      const command = buildPlanningCommand(envelope, {
        actor: resolution.identity.subject,
        transport: resolution.identity.provenance.adapter,
        projectKey: resolution.identity.projectScope.projectKey,
      });
      if (isPlanningRefusal(command)) {
        sendPlanJson(res, command.status, { ok: false, error: command.error });
        return;
      }

      let result: ReturnType<typeof applyRemotePlanningCommand>;
      try {
        result = applyRemotePlanningCommand(command);
      } catch {
        // A real fault inside the atomic transaction rolls back everything (mutation + ledger);
        // never leak the internal error string.
        sendPlanJson(res, 500, { ok: false, error: "the planning command could not be applied." });
        return;
      }

      // NON-OPTIMISTIC: report exactly what committed. `applied` → 200; a precondition/readiness
      // refusal → 409 carrying the current safe summary so the client re-reads and resubmits.
      sendPlanJson(res, result.outcome === "applied" ? 200 : 409, {
        ok: result.outcome === "applied",
        outcome: result.outcome,
        replayed: result.replayed,
        requestId: result.requestId,
        action: result.action,
        targetId: result.targetId,
        precondition: result.precondition,
        summary: result.summary,
        createdAt: result.createdAt,
      });
    } finally {
      planInFlight -= 1;
    }
  }

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    // STRUCTURAL AC7 (re-anchored for FG-783): this surface answers GET on its read routes and
    // POST on EXACTLY ONE route — the planning endpoint. There is no other POST branch, and no
    // PUT/PATCH/DELETE branch at all, so the ONLY mutation reachable is a bounded planning
    // command dispatched through the closed store-command vocabulary.
    if (req.method === "GET") {
      if (path === "/") {
        serveRemoteShell(res);
        return;
      }
      if (path === REMOTE_BOARD_ENDPOINT) {
        // Await the async board handler so a rejected identity resolution surfaces to the
        // createRemoteBoardServer try/catch and fails closed — never an unhandled rejection.
        await handleBoard(req, res);
        return;
      }
      if (path === REMOTE_PLAN_AUDIT_ENDPOINT) {
        // RF-1: the same-project, read-gated planning audit read. A GET, so it stays on the
        // read side of the surface; the store scopes it to the identity's own project.
        await handlePlanAudit(req, res);
        return;
      }
      if (path.startsWith(REMOTE_CLIENT_URL_PREFIX)) {
        serveRemoteAsset(res, clientDir, path);
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "not found" }));
      return;
    }
    if (req.method === "POST" && path === REMOTE_PLAN_ENDPOINT) {
      await handlePlan(req, res);
      return;
    }
    // Every other method — a PUT/PATCH/DELETE, a POST to any non-planning path, and a CORS
    // preflight OPTIONS — is a flat 405 with NO Access-Control-Allow-* header, so a cross-origin
    // caller's preflight fails closed before the real request is ever sent.
    res
      .writeHead(405, { "Content-Type": "application/json", "Allow": "GET, POST" })
      .end(JSON.stringify({ error: "Method not allowed" }));
  };
}

/** Create the remote board server WITHOUT listening (tests bind their own port). */
export function createRemoteBoardServer(deps: RemoteBoardDeps = {}): Server {
  const handler = createRemoteBoardHandler(deps);
  return createServer((req, res) => {
    // The handler is async (the identity resolver awaits an out-of-band adapter). Await it
    // via the returned promise so BOTH a synchronous throw and an async rejection land in the
    // same fail-closed finalizer — a rejected identity resolution can never escape as an
    // unhandled rejection or leave the request hanging.
    void Promise.resolve()
      .then(() => handler(req, res))
      .catch(() => finishUnhandledRequest(res));
  });
}

/** Create AND listen. Binds the loopback host/port from `config`. */
export function startRemoteBoardServer(config: RemoteBoardConfig, deps: RemoteBoardDeps = {}): Server {
  const srv = createRemoteBoardServer(deps);
  // RF-2: a bind failure (EADDRINUSE, EACCES, …) is emitted ASYNCHRONOUSLY on `srv` AFTER this
  // function returns, so the caller's synchronous try/catch cannot catch it — an unhandled
  // 'error' event would crash the SHARED local dashboard process. Contain it here: log, tear
  // the half-open remote listener down, and leave the local dashboard untouched (AC1). The
  // remote board simply stays unavailable; it never takes the local surface down with it.
  srv.on("error", (err) => {
    console.error("forge remote board: listener error; remote mode disabled, local dashboard unaffected:", err);
    srv.close();
  });
  srv.listen(config.port, config.host, () => {
    console.log(`forge remote board (read-only) listening at http://${config.host}:${config.port}`);
  });
  return srv;
}

/**
 * The mode-GATED boot hook the local dashboard calls (../server.ts). INERT unless remote
 * mode is enabled via env: returns null, binds nothing, has zero side effects — so with
 * remote mode disabled the local dashboard is byte-for-byte unchanged (AC1).
 *
 * When enabled, it starts the dedicated loopback server. The bind host is the config's
 * loopback constant; the extra `isLoopbackHost` guard is a boot-time assertion that a future
 * edit could not silently open a public listener. A start failure is logged and swallowed —
 * the remote board never takes the local dashboard down with it.
 */
export function maybeStartRemoteBoardFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  deps: RemoteBoardDeps = {},
): Server | null {
  let config: RemoteBoardConfig;
  try {
    config = resolveRemoteConfig(env);
  } catch (err) {
    // RF-1: a refused remote configuration (e.g. remote port == local dashboard port) must
    // NOT take the local dashboard down with it. Log the named refusal and stay off — the
    // local listener binds untouched (AC1).
    console.error("forge remote board: refusing to start:", err instanceof Error ? err.message : err);
    return null;
  }
  if (!config.enabled) return null;
  if (!isLoopbackHost(config.host)) {
    console.error(
      `forge remote board: refusing to bind non-loopback host ${config.host}. The remote board is loopback-only; ` +
        `front it with a trusted local proxy (Tailscale Serve / Cloudflare Tunnel) instead of binding a public address.`,
    );
    return null;
  }
  // FG-782: select the transport adapter named by the boot-time env selector (config.transport,
  // resolved in config.ts). Absent/unknown transport → selectRemoteAdapter returns null → no
  // adapter → the FG-781 fail-closed default (every request refused) is UNCHANGED. This
  // selection builds an identity adapter only; it NEVER touches config.host, so the bind stays
  // the loopback constant regardless of which transport is chosen (AC2). A caller that supplied
  // its own resolver/adapter (tests) is respected as-is and the selection is skipped.
  let bootDeps = deps;
  if (deps.resolveIdentity === undefined && deps.adapter === undefined) {
    const lookupProject =
      deps.lookupProject ?? ((key: string) => projectsForDashboard().find((p) => p.key === key));
    const adapter = selectRemoteAdapter(config.transport, { lookupProject, env, ...deps.transportDeps });
    // Thread the SAME lookupProject into the handler so the adapter's server-authoritative scope
    // (the granted project's own dirs) and the handler's claimedDirsWithinProject re-check
    // resolve against one registry view.
    bootDeps = { ...deps, lookupProject, adapter };
  }
  try {
    return startRemoteBoardServer(config, bootDeps);
  } catch (err) {
    console.error("forge remote board: failed to start; the local dashboard is unaffected:", err);
    return null;
  }
}
