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

import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

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
  /** SHA-256 (hex) of the EXACT ingress file body Forge wrote — the whole-file ownership STAMP
   *  (RF-1). `setup` refuses to overwrite a file whose bytes this does not match, and `disable`
   *  deletes the recorded path ONLY when the file's current hash still equals this (otherwise the
   *  file was tampered with or is not the one Forge authored, and disable refuses). A record
   *  Forge writes always carries it; a legacy/foreign record without it cannot prove ownership. */
  readonly cloudflaredConfigSha256?: string;
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
  // The ownership stamp is OPTIONAL for backward/forward tolerance, but when present it must be a
  // well-formed sha256 hex digest — a malformed stamp rejects the whole record (fail closed).
  const rawSha = r["cloudflaredConfigSha256"];
  let cloudflaredConfigSha256: string | undefined;
  if (rawSha !== undefined) {
    if (typeof rawSha !== "string" || !/^[0-9a-f]{64}$/i.test(rawSha)) return null;
    cloudflaredConfigSha256 = rawSha.toLowerCase();
  }
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
    ...(cloudflaredConfigSha256 ? { cloudflaredConfigSha256 } : {}),
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

/** SHA-256 (hex) of a UTF-8 string — the whole-file ownership stamp for the owned ingress file. */
export function ingressContentSha256(contents: string): string {
  return createHash("sha256").update(contents, "utf8").digest("hex");
}

/** Read a file's text, or `null` if it does not exist / cannot be read. Never throws. */
function tryReadFileText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** A temp sibling path with a UNIQUE random suffix, so no two writers (and no pre-existing file)
 *  ever collide on a deterministic name. */
function tempSiblingPath(dir: string, path: string): string {
  return join(dir, `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);
}

/** Write `contents` to `path` owner-only (dir 0700, file 0600) via a temp file + atomic rename, so
 *  a crash or a failing write never leaves a half-written file at `path`. The temp sibling is
 *  created EXCLUSIVELY (O_EXCL via the "wx" flag) with a random suffix (FG-790): a deterministic
 *  temp path would let `writeFileSync` clobber a pre-existing foreign file sitting there — bypassing
 *  the RF-1 ownership check, which only inspects the target path. On an EEXIST collision we retry
 *  once with a fresh name and never overwrite; on any failure after creation we unlink the temp. */
function writeFileAtomicOwnerOnly(path: string, contents: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let tmp = tempSiblingPath(dir, path);
  try {
    writeFileSync(tmp, contents, { mode: 0o600, flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    tmp = tempSiblingPath(dir, path);
    writeFileSync(tmp, contents, { mode: 0o600, flag: "wx" });
  }
  try {
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * Persist the access-state record owner-only (dir 0700, file 0600) via a temp file + atomic rename.
 * The record is validated before write, so a caller cannot persist a malformed record — or one
 * with a non-loopback target — that would later fail to read back or, worse, front a public host.
 */
export function writeAccessState(record: AccessStateRecord, env: NodeJS.ProcessEnv = process.env): void {
  const validated = validateAccessStateRecord(record);
  if (validated === null) {
    throw new Error("refusing to persist an invalid remote-board cloudflare access-state record");
  }
  writeFileAtomicOwnerOnly(resolveAccessStatePath(env), `${JSON.stringify(validated, null, 2)}\n`);
}

/**
 * Write the cloudflared ingress config file Forge WHOLLY owns, owner-only (dir 0700, file 0600) via
 * a temp file + atomic rename. Forge authors the ENTIRE file, so a later `disable` removes it
 * wholesale. This holds NO secret — cloudflared's tunnel credentials live in a separate file
 * cloudflared manages, which Forge never writes and never deletes. The CLI computes the YAML body
 * (ingress → http://127.0.0.1:<port>); this function only lays it down with the right ownership.
 */
export function writeOwnedIngressFile(configPath: string, contents: string): void {
  if (typeof configPath !== "string" || configPath.trim() === "") {
    throw new Error("refusing to write an owned cloudflared config with an empty path");
  }
  writeFileAtomicOwnerOnly(configPath, contents);
}

/** Whether a candidate ingress path is safe for `setup` to write. `absent` — no file there yet.
 *  `forge-owned` — a file exists and its bytes match what the CURRENT record says Forge wrote (a
 *  re-run overwriting Forge's own file). `foreign` — a file exists that Forge did NOT author (or
 *  was edited since), which setup must never overwrite. */
export type IngressOwnership = "absent" | "forge-owned" | "foreign";

/**
 * Classify the file (if any) at `configPath` against the CURRENT access-state record. Used by
 * `setup` to refuse overwriting a cloudflared config Forge did not create (RF-1): only `absent` or
 * `forge-owned` are safe to write.
 */
export function classifyIngressPath(configPath: string, env: NodeJS.ProcessEnv = process.env): IngressOwnership {
  const existing = tryReadFileText(configPath);
  if (existing === null) return "absent";
  const record = readAccessState(env);
  if (
    record !== null &&
    record.cloudflaredConfigPath === configPath &&
    record.cloudflaredConfigSha256 !== undefined &&
    record.cloudflaredConfigSha256 === ingressContentSha256(existing)
  ) {
    return "forge-owned";
  }
  return "foreign";
}

/** The outcome of {@link applyCloudflareSetup}. `refused-foreign-config` names the path Forge would
 *  have had to overwrite but does not own — zero mutation happened. */
export type SetupApplyResult =
  | { readonly status: "applied" }
  | { readonly status: "refused-foreign-config"; readonly path: string };

/**
 * Apply a Cloudflare setup atomically and ownership-safely (RF-1 + RF-2).
 *
 *  - RF-1: if a file already sits at the ingress path that Forge does NOT own (no matching record +
 *    hash), REFUSE — return `refused-foreign-config` with zero mutation, so an operator's own
 *    cloudflared config is never overwritten (and thus never later deleted by `disable`).
 *  - RF-2: persist the state record FIRST (so `disable` can always find what setup wrote), THEN the
 *    ingress file — both via atomic temp+rename. If the ingress write fails, ROLL the record back
 *    (restore the prior record, or remove it if there was none) so a failed setup never orphans a
 *    record pointing at a file that was never written, nor leaves an ingress file with no record.
 *
 * `record.cloudflaredConfigSha256` MUST already be the hash of `ingressContents` (the caller
 * computes it when building the record); this is asserted so the on-disk stamp always matches the
 * bytes written.
 */
export function applyCloudflareSetup(
  record: AccessStateRecord,
  ingressContents: string,
  env: NodeJS.ProcessEnv = process.env,
): SetupApplyResult {
  if (record.cloudflaredConfigSha256 !== ingressContentSha256(ingressContents)) {
    throw new Error("refusing to apply setup: the record's ownership hash does not match the ingress body");
  }
  const configPath = record.cloudflaredConfigPath;
  if (classifyIngressPath(configPath, env) === "foreign") {
    return { status: "refused-foreign-config", path: configPath };
  }
  const prior = readAccessState(env);
  // Record FIRST — disable must never be unable to find a config setup wrote.
  writeAccessState(record, env);
  try {
    writeOwnedIngressFile(configPath, ingressContents);
  } catch (err) {
    // Ingress write failed AFTER the record landed — roll the record back so nothing is orphaned.
    if (prior !== null) writeAccessState(prior, env);
    else rmSync(resolveAccessStatePath(env), { force: true });
    throw err;
  }
  return { status: "applied" };
}

/** The outcome of {@link disableCloudflareSetup}. `refused-tampered` names the recorded ingress
 *  path whose on-disk bytes no longer match the ownership stamp — disable leaves it untouched. */
export type DisableResult =
  | { readonly status: "nothing" }
  | { readonly status: "removed"; readonly path: string }
  | { readonly status: "refused-tampered"; readonly path: string };

/**
 * Remove the Forge-owned Cloudflare state — the ingress config file AND the state record — and
 * NOTHING else (RF-1). Ownership-checked and idempotent:
 *   - no valid record            → `nothing` (a corrupt/foreign/absent record is never acted on).
 *   - file present, hash MATCHES → delete exactly that file, remove the record → `removed`.
 *   - file present, hash DIFFERS → REFUSE: the file was tampered with or is not the one Forge
 *                                  authored; leave both file and record untouched → `refused-tampered`.
 *   - file absent                → remove the record (the owned file is already gone) → `removed`.
 * NEVER touches the Access application, cloudflared credentials, or Forge data.
 */
export function disableCloudflareSetup(env: NodeJS.ProcessEnv = process.env): DisableResult {
  const record = readAccessState(env);
  if (record === null) return { status: "nothing" };
  const configPath = record.cloudflaredConfigPath;
  const existing = tryReadFileText(configPath);
  if (existing !== null) {
    if (
      record.cloudflaredConfigSha256 === undefined ||
      record.cloudflaredConfigSha256 !== ingressContentSha256(existing)
    ) {
      // Fail closed: the file at the recorded path is not provably the one Forge wrote.
      return { status: "refused-tampered", path: configPath };
    }
    rmSync(configPath, { force: true });
  }
  rmSync(resolveAccessStatePath(env), { force: true });
  return { status: "removed", path: configPath };
}
