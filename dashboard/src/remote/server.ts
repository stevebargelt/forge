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

const HERE = dirname(fileURLToPath(import.meta.url));
// dashboard/src/remote → dashboard/remote-client. The focused board asset set (FG-781 step
// 5), served by RUNTIME PATH exactly as ../server.ts serves /client/* — never a build-time
// import, so this module carries no dependency on the UI step.
const REMOTE_CLIENT_DIR = resolve(HERE, "..", "..", "remote-client");

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

/** Build the remote board request handler. */
export function createRemoteBoardHandler(deps: RemoteBoardDeps = {}): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const resolveIdentity = deps.resolveIdentity ?? createRemoteIdentityResolver(deps.adapter ?? null);
  const lookupProject = deps.lookupProject ?? ((key: string) => projectsForDashboard().find((p) => p.key === key));
  const now = deps.now ?? (() => Date.now());
  const clientDir = deps.clientDir ?? REMOTE_CLIENT_DIR;

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
      sendEnvelope(res, assembleRemoteBoard(grant, { nowMs: now() }));
    } catch {
      // A degraded/unreadable host store must never take the surface down, and never leak
      // an internal error string — the closed envelope carries no project data.
      sendEnvelope(res, hostUnavailableRemoteBoard(now()));
    }
  }

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // STRUCTURAL AC7: the ONLY method this surface answers is GET. There is no POST/PUT/
    // PATCH/DELETE branch anywhere below, so no request can reach a mutation — a preflight
    // or a mutation attempt gets a flat 405, and no Access-Control-Allow-* header is ever
    // emitted, so a cross-origin caller fails closed before the real request is sent.
    if (req.method !== "GET") {
      res.writeHead(405, { "Content-Type": "application/json", "Allow": "GET" }).end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
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
    if (path.startsWith(REMOTE_CLIENT_URL_PREFIX)) {
      serveRemoteAsset(res, clientDir, path);
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "not found" }));
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
