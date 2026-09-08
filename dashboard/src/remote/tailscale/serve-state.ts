// FG-782 (step 8): Forge-owned record of the EXACT Tailscale Serve mapping that
// `forge remote tailscale setup` created, stored as inspectable state under FORGE_HOME.
//
// WHY THIS EXISTS — the AC6 surgical-removal invariant. `disable` must remove ONLY the
// mapping Forge itself created and must NEVER run a blanket `tailscale serve reset` (which
// would tear down unrelated Serve config the operator set up by hand — AC6). The only way to
// be surgical is to REMEMBER, at setup time, the exact handler Forge added and the exact argv
// that removes just that handler. This module is that memory: a small JSON file recording the
// created mapping and its inverse command.
//
// THREAT MODEL / SENSITIVITY. The record holds NO secret — a tailnet MagicDNS hostname, an
// HTTPS port, and a loopback target (always 127.0.0.1:<port>). It is nonetheless written
// owner-only (dir 0700 / file 0600), matching Forge's other FORGE_HOME state, so a
// multi-user host (a documented non-goal, but defense in depth) cannot read or tamper with
// what Forge will later act on.
//
// FAIL CLOSED ON READ. A missing file (never set up) and a corrupt / foreign / version-
// mismatched file both read as `null` — "there is nothing Forge owns to remove." disable then
// makes NO change rather than issuing a wrong or blanket removal. A malformed record must never
// widen into "reset everything."
//
// This module is a pure function of (env, filesystem): it spawns nothing and knows nothing
// about tailscaled. The CLI (src/cli/commands/remote.ts) computes the argv and hands a fully
// built record here to persist; this module only reads/writes/removes it.

import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** The Forge-owned serve-state file, under FORGE_HOME. A `.json` (not `.yml`) because it is
 *  MACHINE-authored by `setup` and machine-read by `disable` — an operator inspects it but does
 *  not hand-edit it, unlike the identity mapping. */
export const SERVE_STATE_FILENAME = "remote-board-serve-state.json";

/** The only serve-state format version this Forge understands. A file declaring a different
 *  version reads as `null` (fail closed) rather than being acted on under semantics it may not
 *  share. */
export const SERVE_STATE_VERSION = 1;

/**
 * The EXACT Serve mapping Forge created — enough to (a) show the operator what is live and
 * (b) remove precisely that mapping later, never more.
 */
export interface ServeStateRecord {
  readonly version: number;
  /** The tailnet MagicDNS host Serve fronts, e.g. `steve-mbp.tail1234.ts.net`. */
  readonly serveHost: string;
  /** The HTTPS port exposed on the TAILNET side (443). Never a public/Funnel port. */
  readonly servePort: number;
  /** The remote board's LOOPBACK port (FORGE_DASHBOARD_REMOTE_PORT). */
  readonly loopbackPort: number;
  /** The exact loopback target Serve proxies to — ALWAYS `http://127.0.0.1:<loopbackPort>`. */
  readonly target: string;
  /** `https://<serveHost>` — the tailnet-private URL an operator opens. */
  readonly url: string;
  /** The EXACT argv Forge passed to `tailscale` to CREATE this mapping. */
  readonly createArgs: readonly string[];
  /** The EXACT argv that surgically REMOVES only this mapping — never `serve reset` (AC6). */
  readonly disableArgs: readonly string[];
  /** ISO timestamp the mapping was created. Audit only; never gates removal. */
  readonly createdAt?: string;
}

/** Resolve the serve-state file's absolute path from an env map. Reads FORGE_HOME at CALL time
 *  (not module load) so tests — and a relocated FORGE_HOME — resolve against the live value,
 *  mirroring mapping.ts's resolveIdentityMappingPath. */
export function resolveServeStatePath(env: NodeJS.ProcessEnv = process.env): string {
  const forgeHome = env["FORGE_HOME"] ?? join(homedir(), ".forge");
  return join(forgeHome, SERVE_STATE_FILENAME);
}

/** Fail-closed validation of a parsed value into a {@link ServeStateRecord}, or `null`. Every
 *  required field must be present and well-typed; a version mismatch, a missing field, or a
 *  non-loopback target all reject the whole record. A rejected record means disable has nothing
 *  it can prove Forge owns — so it does nothing, never a blanket removal. */
export function validateServeStateRecord(value: unknown): ServeStateRecord | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  if (r["version"] !== SERVE_STATE_VERSION) return null;
  const serveHost = r["serveHost"];
  const servePort = r["servePort"];
  const loopbackPort = r["loopbackPort"];
  const target = r["target"];
  const url = r["url"];
  const createArgs = r["createArgs"];
  const disableArgs = r["disableArgs"];
  if (typeof serveHost !== "string" || serveHost.trim() === "") return null;
  if (typeof servePort !== "number" || !Number.isInteger(servePort)) return null;
  if (typeof loopbackPort !== "number" || !Number.isInteger(loopbackPort)) return null;
  if (typeof target !== "string" || target.trim() === "") return null;
  if (typeof url !== "string" || url.trim() === "") return null;
  if (!isStringArray(createArgs) || createArgs.length === 0) return null;
  if (!isStringArray(disableArgs) || disableArgs.length === 0) return null;
  // Defense in depth: the recorded loopback target must actually be loopback. A record whose
  // target is not 127.0.0.1 is not one this code could have written; refuse to act on it.
  if (!/^http:\/\/127\.0\.0\.1:\d+/.test(target)) return null;
  const createdAt = typeof r["createdAt"] === "string" ? (r["createdAt"] as string) : undefined;
  return Object.freeze({
    version: SERVE_STATE_VERSION,
    serveHost,
    servePort,
    loopbackPort,
    target,
    url,
    createArgs: Object.freeze([...createArgs]),
    disableArgs: Object.freeze([...disableArgs]),
    ...(createdAt ? { createdAt } : {}),
  });
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/**
 * Read the Forge-owned serve-state record, or `null`. Fail closed: a missing file (ENOENT — the
 * ordinary "never set up" state), any other read error, invalid JSON, or a record that fails
 * {@link validateServeStateRecord} all yield `null`. Never throws into the caller.
 */
export function readServeState(env: NodeJS.ProcessEnv = process.env): ServeStateRecord | null {
  const path = resolveServeStatePath(env);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return validateServeStateRecord(parsed);
}

/**
 * Persist the serve-state record owner-only (dir 0700, file 0600). Creates FORGE_HOME if
 * absent. The record is validated before write, so a caller cannot persist a malformed record
 * that would later fail to read back.
 */
export function writeServeState(record: ServeStateRecord, env: NodeJS.ProcessEnv = process.env): void {
  const validated = validateServeStateRecord(record);
  if (validated === null) {
    throw new Error("refusing to persist an invalid remote-board serve-state record");
  }
  const path = resolveServeStatePath(env);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600 });
  // Enforce 0600 even if the file pre-existed with looser perms (writeFileSync's mode only
  // applies on CREATE).
  chmodSync(path, 0o600);
}

/** Remove the serve-state record. Idempotent: a missing file is a no-op (disable after a manual
 *  cleanup must not error). Touches ONLY this file — never Forge data or the local dashboard. */
export function clearServeState(env: NodeJS.ProcessEnv = process.env): void {
  rmSync(resolveServeStatePath(env), { force: true });
}
