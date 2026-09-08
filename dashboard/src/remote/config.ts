// FG-781 (step 3): remote-board MODE + loopback bind resolution — read from the process
// environment ONCE, at boot, never from a request.
//
// THREAT MODEL. Two boot-time properties this module makes structural:
//   (1) Remote mode is OFF unless an operator explicitly turns it on. The dashboard's
//       default posture is the ordinary local dashboard with no remote surface at all, so a
//       process that was never asked to expose a remote board never does (FG-781 AC1).
//   (2) Enabling remote mode NEVER, by itself, opens a non-loopback listener. The remote
//       board stays loopback-bound; a later trusted local proxy (Tailscale Serve FG-782,
//       Cloudflare Tunnel+Access FG-784) fronts it. To keep that a property of the CODE
//       rather than of operator discipline, the bind host is a CONSTANT here — it is
//       deliberately NOT env-overridable. There is no `FORGE_DASHBOARD_REMOTE_HOST`, so no
//       env value, forwarded header, or CLI flag can widen the bind to 0.0.0.0.
//
// Config is a pure function of the env map: no filesystem, no DB, no process spawn — so the
// resolver is unit-testable and cannot be steered by anything a request carries.

/** Env var (value `"1"`/`"true"`) that OPTS IN to remote mode. Absent/empty/`"0"`/`"false"`
 *  keeps the ordinary local dashboard with no remote surface. Threaded by `forge dashboard
 *  start --remote` (FG-781 step 4), exactly as `--port`/`--host` thread PORT/HOST today. */
export const REMOTE_MODE_ENV = "FORGE_DASHBOARD_REMOTE";

/** Env var naming the remote board's LOOPBACK port. Distinct from the local dashboard's
 *  PORT so the two listeners never collide. */
export const REMOTE_PORT_ENV = "FORGE_DASHBOARD_REMOTE_PORT";

/** The remote board's default loopback port — one above the local dashboard's 8024. */
export const DEFAULT_REMOTE_PORT = 8025;

/** FG-782: env var naming the boot-time transport adapter that fronts the loopback board.
 *  ABSENT/empty/unrecognised = NO adapter = the FG-781 fail-closed default (every request is
 *  refused). Only an explicit, recognised value selects an adapter — this is the single
 *  operator switch that turns identity verification on, and it is read ONCE at boot exactly
 *  like the mode/port env, never from a request. */
export const REMOTE_TRANSPORT_ENV = "FORGE_DASHBOARD_REMOTE_TRANSPORT";

/** The recognised transport tokens. A closed vocabulary: anything not here resolves to null
 *  (no adapter → refuse), so a typo or an attacker-supplied value can never select something
 *  the operator did not intend. FG-784's Cloudflare variant slots in here additively. */
const RECOGNISED_TRANSPORTS = new Set<string>(["tailscale"]);

/** The local dashboard's default port — mirrors `Number(process.env.PORT ?? 8024)` in
 *  ../server.ts. Held here so the remote/local collision guard (RF-1) compares against the
 *  same default the local listener will bind. */
export const DEFAULT_LOCAL_DASHBOARD_PORT = 8024;

/**
 * RF-1: the remote board binds a SEPARATE loopback listener, started BEFORE the local
 * dashboard's `server.listen(PORT, HOST)`. If the two ports are equal the remote listener
 * wins the bind and the local dashboard then fails with EADDRINUSE — silently breaking the
 * protected invariant that enabling remote mode leaves the local dashboard unchanged (AC1).
 * The configuration is refused at resolution time, before either listener starts, and the
 * error names BOTH ports so the operator can see the collision.
 */
export class RemotePortCollisionError extends Error {
  constructor(
    readonly localPort: number,
    readonly remotePort: number,
  ) {
    super(
      `forge remote board: the remote port (${REMOTE_PORT_ENV}=${remotePort}) collides with the local dashboard ` +
        `port (${localPort}). The remote board is a SEPARATE loopback listener and must bind a different port — ` +
        `set ${REMOTE_PORT_ENV} to a value other than ${localPort}.`,
    );
    this.name = "RemotePortCollisionError";
  }
}

/**
 * The remote board's bind host. A CONSTANT, and intentionally not env-derived: it is the
 * single line that guarantees enabling remote mode cannot open a non-loopback listener by
 * itself (see the module header). A later transport adapter fronts this loopback endpoint;
 * it does not change what the backend binds.
 */
export const REMOTE_LOOPBACK_HOST = "127.0.0.1";

export interface RemoteBoardConfig {
  /** Is the remote board turned on? Default false. */
  readonly enabled: boolean;
  /** The bind host — ALWAYS the loopback constant, never widened. */
  readonly host: string;
  /** The loopback port to bind. */
  readonly port: number;
  /** FG-782: the selected transport adapter token, or null when no adapter is selected (the
   *  FG-781 fail-closed default). Optional in the type so hand-built FG-781 config literals
   *  keep compiling; `resolveRemoteConfig` always populates it. */
  readonly transport?: string | null;
}

/** Is `value` an opt-in truthy flag? Only the explicit `1`/`true` (case-insensitive,
 *  trimmed) enable a security-relevant mode — a stray `0`/`false`/`""` must read as OFF, and
 *  fail-closed means an UNRECOGNISED value is OFF too, never accidentally on. */
function isEnabled(value: string | undefined): boolean {
  if (value === undefined) return false;
  const v = value.trim().toLowerCase();
  return v === "1" || v === "true";
}

/** Parse a TCP port from env, or fall back to the default. A non-integer or out-of-range
 *  value falls back rather than binding something unintended; `0` is accepted so a test (or
 *  an operator) can request an OS-assigned ephemeral port. */
function resolvePort(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return DEFAULT_REMOTE_PORT;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 65535) return DEFAULT_REMOTE_PORT;
  return n;
}

/**
 * FG-782: resolve the boot-time transport selector from the env map. Fail-closed by
 * construction — absent, empty, or an unrecognised token all resolve to `null` (no adapter,
 * so every request is refused, preserving FG-781's default). A recognised value resolves to
 * its canonical token (trimmed, lower-cased) so the boot registry can match it exactly. Pure:
 * a function of the env value alone, never of anything a request carries.
 */
export function resolveRemoteTransport(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env[REMOTE_TRANSPORT_ENV];
  if (raw === undefined) return null;
  const token = raw.trim().toLowerCase();
  if (token === "") return null;
  return RECOGNISED_TRANSPORTS.has(token) ? token : null;
}

/**
 * Resolve the remote-board configuration from an env map (defaults to `process.env`). Pure:
 * the same env in always yields the same config out, and the bind host is invariably the
 * loopback constant regardless of what the env contains.
 */
export function resolveRemoteConfig(env: NodeJS.ProcessEnv = process.env): RemoteBoardConfig {
  const enabled = isEnabled(env[REMOTE_MODE_ENV]);
  const port = resolvePort(env[REMOTE_PORT_ENV]);
  // RF-1: refuse a remote port that collides with the local dashboard port BEFORE either
  // listener starts. Only meaningful when remote mode is on (a disabled board binds nothing),
  // and port 0 is the OS-assigned ephemeral request, which never collides with a fixed port.
  if (enabled && port !== 0) {
    const localPort = Number(env["PORT"] ?? DEFAULT_LOCAL_DASHBOARD_PORT);
    if (port === localPort) throw new RemotePortCollisionError(localPort, port);
  }
  return {
    enabled,
    host: REMOTE_LOOPBACK_HOST,
    port,
    transport: resolveRemoteTransport(env),
  };
}

/** Loopback guard used defensively at boot before binding — a belt-and-suspenders check
 *  that the (constant) host really is loopback, so a future edit that made the host
 *  configurable could never silently open a public listener without tripping this. */
export function isLoopbackHost(host: string): boolean {
  return /^(127\.\d+\.\d+\.\d+|::1|localhost)$/.test(host);
}
