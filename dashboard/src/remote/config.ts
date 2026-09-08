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
 * Resolve the remote-board configuration from an env map (defaults to `process.env`). Pure:
 * the same env in always yields the same config out, and the bind host is invariably the
 * loopback constant regardless of what the env contains.
 */
export function resolveRemoteConfig(env: NodeJS.ProcessEnv = process.env): RemoteBoardConfig {
  return {
    enabled: isEnabled(env[REMOTE_MODE_ENV]),
    host: REMOTE_LOOPBACK_HOST,
    port: resolvePort(env[REMOTE_PORT_ENV]),
  };
}

/** Loopback guard used defensively at boot before binding — a belt-and-suspenders check
 *  that the (constant) host really is loopback, so a future edit that made the host
 *  configurable could never silently open a public listener without tripping this. */
export function isLoopbackHost(host: string): boolean {
  return /^(127\.\d+\.\d+\.\d+|::1|localhost)$/.test(host);
}
