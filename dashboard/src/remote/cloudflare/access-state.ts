// FG-784 (step 3): Forge-owned record of the EXACT Cloudflare Access + Tunnel deployment that
// `forge remote cloudflare setup` created, stored as inspectable state under FORGE_HOME.
//
// WHY THIS EXISTS — two jobs, one file.
//   (1) The AC4 surgical-removal invariant. `disable` must remove ONLY what Forge created and
//       must NEVER tear down the operator's Access application, cloudflared credentials, or any
//       tunnel config Forge did not author. Unlike Tailscale Serve (an in-daemon mapping removed
//       by an inverse argv), a cloudflared tunnel is fronted by an INGRESS CONFIG FILE. Forge
//       owns that file WHOLLY — it authors the whole file, so removal is a whole-file delete, not
//       a within-file diff (architect risk 6). This record remembers the file's path so disable
//       deletes exactly that file and nothing else.
//   (2) The adapter's boot config. The verified-identity boundary needs the Access team domain
//       (to derive the expected JWT issuer + the JWKS certs endpoint) and the Access application
//       AUD tag (the expected audience). These are NON-SECRET, but they are DEPLOYMENT facts, not
//       code constants, so they live here — read once at boot — rather than in config.ts (keeps
//       config.ts a one-line additive edit; architect openQuestion default). Absent this record,
//       the adapter has no team/AUD and REFUSES every request (never "accept any audience").
//
// THREAT MODEL / SENSITIVITY. The record holds NO secret — a public hostname, the Access team
// domain, the Access application AUD tag (a public identifier, not a credential), a loopback
// target (always 127.0.0.1:<port>), and the path of the owned ingress file. It NEVER holds a
// Cloudflare API token, the tunnel credentials cloudflared manages, or any JWT/CF_Authorization
// cookie. It is nonetheless written owner-only (dir 0700 / file 0600), matching Forge's other
// FORGE_HOME state, so a multi-user host (a documented non-goal, but defense in depth) cannot
// read or tamper with what Forge will later act on — or with the team/AUD the adapter trusts.
//
// FAIL CLOSED ON READ. A missing file (never set up), a corrupt / foreign / version-mismatched
// file, and a record whose target is not loopback all read as `null`. For disable that means
// "there is nothing Forge owns to remove" — it makes no change rather than a wrong or blanket
// removal. For the adapter's boot read that means "no trusted team/AUD" — it refuses every
// request rather than degrading to accept-any-issuer/audience.
//
// This module is a pure function of (env, filesystem): it spawns nothing and knows nothing about
// cloudflared or JWTs. The CLI (src/cli/commands/remote.ts) computes the hostname/AUD/ingress
// contents and hands a fully built record + ingress body here to persist; this module only
// reads/writes/removes them. No cross-boundary import.

import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** The Forge-owned access-state file, under FORGE_HOME. A `.json` (not `.yml`) because it is
 *  MACHINE-authored by `setup` and machine-read by `disable`/boot — an operator inspects it but
 *  does not hand-edit it, unlike the identity mapping. */
export const ACCESS_STATE_FILENAME = "remote-board-cloudflare-state.json";

/** The default filename for the cloudflared ingress config file Forge WHOLLY owns, under
 *  FORGE_HOME. The CLI is free to record a different absolute path in the record; disable acts on
 *  whatever `cloudflaredConfigPath` the record carries, not on this default. */
export const OWNED_INGRESS_FILENAME = "remote-board-cloudflared.yml";

/** The only access-state format version this Forge understands. A file declaring a different
 *  version reads as `null` (fail closed) rather than being acted on under semantics it may not
 *  share, and the adapter then has no trusted team/AUD and refuses. */
export const ACCESS_STATE_VERSION = 1;

/**
 * The EXACT Cloudflare deployment Forge created — enough to (a) show the operator what is live,
 * (b) remove precisely the ingress file Forge authored later (never more), and (c) give the
 * adapter its non-secret boot config (team domain + AUD).
 */
export interface AccessStateRecord {
  readonly version: number;
  /** The PUBLIC hostname the tunnel fronts, e.g. `board.example.com`. Public by design — it is
   *  useless without a valid Access JWT, which only the Access edge can mint. */
  readonly publicHostname: string;
  /** The Cloudflare Access TEAM DOMAIN, e.g. `myteam.cloudflareaccess.com`. The adapter derives
   *  the expected JWT issuer (`https://<teamDomain>`) and the JWKS certs endpoint from it. */
  readonly accessTeamDomain: string;
  /** The Access application AUD tag — the expected `aud` claim. A public identifier, NOT a
   *  credential; the adapter refuses any token whose audience is not exactly this. */
  readonly accessAud: string;
  /** The remote board's LOOPBACK port (FORGE_DASHBOARD_REMOTE_PORT). */
  readonly loopbackPort: number;
  /** The exact loopback target the tunnel proxies to — ALWAYS `http://127.0.0.1:<loopbackPort>`.
   *  Defense in depth: a record whose target is not loopback is refused on write AND on read. */
  readonly target: string;
  /** `https://<publicHostname>` — the URL an operator opens in a browser. */
  readonly url: string;
  /** Absolute path of the dedicated cloudflared ingress config file Forge WHOLLY owns. `disable`
   *  deletes exactly this file — whole-file ownership, never a within-file diff. */
  readonly cloudflaredConfigPath: string;
  /** ISO timestamp the deployment was created. Audit only; never gates removal. */
  readonly createdAt?: string;
}

/** Resolve the access-state file's absolute path from an env map. Reads FORGE_HOME at CALL time
 *  (not module load) so tests — and a relocated FORGE_HOME — resolve against the live value,
 *  mirroring mapping.ts's resolveIdentityMappingPath and serve-state's resolveServeStatePath. */
export function resolveAccessStatePath(env: NodeJS.ProcessEnv = process.env): string {
  const forgeHome = env["FORGE_HOME"] ?? join(homedir(), ".forge");
  return join(forgeHome, ACCESS_STATE_FILENAME);
}

/** Resolve the DEFAULT owned cloudflared ingress path under FORGE_HOME. The CLI may pass this to
 *  {@link writeOwnedIngressFile} and record it, or choose another absolute path. */
export function resolveOwnedIngressPath(env: NodeJS.ProcessEnv = process.env): string {
  const forgeHome = env["FORGE_HOME"] ?? join(homedir(), ".forge");
  return join(forgeHome, OWNED_INGRESS_FILENAME);
}

/** Fail-closed validation of a parsed value into an {@link AccessStateRecord}, or `null`. Every
 *  required field must be present and well-typed; a version mismatch, a missing field, or a
 *  non-loopback target all reject the whole record. A rejected record means disable has nothing
 *  it can prove Forge owns (so it does nothing) and the adapter has no trusted team/AUD (so it
 *  refuses) — a malformed record must never widen into "remove everything" or "accept anyone". */
export function validateAccessStateRecord(value: unknown): AccessStateRecord | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  if (r["version"] !== ACCESS_STATE_VERSION) return null;
  const publicHostname = r["publicHostname"];
  const accessTeamDomain = r["accessTeamDomain"];
  const accessAud = r["accessAud"];
  const loopbackPort = r["loopbackPort"];
  const target = r["target"];
  const url = r["url"];
  const cloudflaredConfigPath = r["cloudflaredConfigPath"];
  if (typeof publicHostname !== "string" || publicHostname.trim() === "") return null;
  if (typeof accessTeamDomain !== "string" || accessTeamDomain.trim() === "") return null;
  if (typeof accessAud !== "string" || accessAud.trim() === "") return null;
  if (typeof loopbackPort !== "number" || !Number.isInteger(loopbackPort)) return null;
  if (typeof target !== "string" || target.trim() === "") return null;
  if (typeof url !== "string" || url.trim() === "") return null;
  if (typeof cloudflaredConfigPath !== "string" || cloudflaredConfigPath.trim() === "") return null;
  // Defense in depth: the recorded loopback target must actually be loopback. A record whose
  // target is not 127.0.0.1 is not one this code could have written; refuse to act on it. This is
  // the structural guarantee that the tunnel can only ever front the loopback board.
  if (!/^http:\/\/127\.0\.0\.1:\d+/.test(target)) return null;
  const createdAt = typeof r["createdAt"] === "string" ? (r["createdAt"] as string) : undefined;
  return Object.freeze({
    version: ACCESS_STATE_VERSION,
    publicHostname,
    accessTeamDomain,
    accessAud,
    loopbackPort,
    target,
    url,
    cloudflaredConfigPath,
    ...(createdAt ? { createdAt } : {}),
  });
}

/**
 * Read the Forge-owned access-state record, or `null`. Fail closed: a missing file (ENOENT — the
 * ordinary "never set up" state), any other read error, invalid JSON, or a record that fails
 * {@link validateAccessStateRecord} all yield `null`. Never throws into the caller. This is BOTH
 * the disable-time "what do I own to remove" read AND the boot-time "what team/AUD do I trust"
 * read — both must fail closed identically.
 */
export function readAccessState(env: NodeJS.ProcessEnv = process.env): AccessStateRecord | null {
  const path = resolveAccessStatePath(env);
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
  return validateAccessStateRecord(parsed);
}

/**
 * Persist the access-state record owner-only (dir 0700, file 0600). Creates FORGE_HOME if absent.
 * The record is validated before write, so a caller cannot persist a malformed record — or one
 * with a non-loopback target — that would later fail to read back or, worse, front a public host.
 */
export function writeAccessState(record: AccessStateRecord, env: NodeJS.ProcessEnv = process.env): void {
  const validated = validateAccessStateRecord(record);
  if (validated === null) {
    throw new Error("refusing to persist an invalid remote-board cloudflare access-state record");
  }
  const path = resolveAccessStatePath(env);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600 });
  // Enforce 0600 even if the file pre-existed with looser perms (writeFileSync's mode only
  // applies on CREATE).
  chmodSync(path, 0o600);
}

/**
 * Write the cloudflared ingress config file Forge WHOLLY owns, owner-only (dir 0700, file 0600).
 * Forge authors the ENTIRE file, so a later `disable` removes it wholesale. This holds NO secret —
 * cloudflared's tunnel credentials live in a separate file cloudflared manages, which Forge never
 * writes and never deletes. The CLI computes the YAML body (ingress → http://127.0.0.1:<port>);
 * this function only lays it down with the right ownership.
 */
export function writeOwnedIngressFile(configPath: string, contents: string): void {
  if (typeof configPath !== "string" || configPath.trim() === "") {
    throw new Error("refusing to write an owned cloudflared config with an empty path");
  }
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
  writeFileSync(configPath, contents, { mode: 0o600 });
  chmodSync(configPath, 0o600);
}

/**
 * Remove the Forge-owned Cloudflare state — the ingress config file AND the state record — and
 * NOTHING else. Idempotent: a missing record or a missing ingress file is a no-op (disable after a
 * manual cleanup must not error). Reads the VALIDATED record to learn the exact ingress path Forge
 * authored, deletes exactly that file, then removes the record. A corrupt/foreign record reads as
 * `null`, so its (untrusted) config path is NOT followed — only the record file itself is removed,
 * never an unknown path. NEVER touches the Access application, cloudflared credentials, or Forge
 * data.
 */
export function clearAccessState(env: NodeJS.ProcessEnv = process.env): void {
  const record = readAccessState(env);
  if (record !== null) {
    // Whole-file ownership: delete exactly the ingress file Forge authored, force so a
    // hand-removed file is not an error.
    rmSync(record.cloudflaredConfigPath, { force: true });
  }
  rmSync(resolveAccessStatePath(env), { force: true });
}
