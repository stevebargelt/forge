// FG-782 (step 4): the operator-authored identity → authorization mapping for the Remote
// Board. This module answers ONE question — "which single project, at which capabilities,
// may a whois-CONFIRMED tailnet login read?" — and answers it fail-closed.
//
// THREAT MODEL. This file is the AUTHORIZATION half of the FG-782 boundary; the tailscaled
// whois channel (steps 5/6) is the IDENTITY half, and the two are deliberately never merged.
// The adversaries this module answers:
//   (1) stale authorization — an operator revokes an identity (deletes/edits its line) and
//       expects the revocation honored WITHOUT restarting Forge. So there is NO long-lived
//       identity cache: `loadIdentityMapping()` re-reads the file on EVERY call, and the
//       adapter (step 6) calls it per request. A deleted entry denies on the next request.
//   (2) grant widening through a malformed file — a typo, an unknown capability, a missing
//       project, a duplicate/conflicting line must NEVER silently widen access. Every failure
//       mode drops to LESS access: an unparseable file yields the empty mapping (no grant for
//       anyone); a tainted entry is dropped (no grant for that login); a login declared twice
//       is poisoned (no grant, because the operator's intent is ambiguous). The only capability
//       a surviving entry can carry is the closed {@link REMOTE_CAPABILITIES} vocabulary — a
//       forged `mutate`/`write` taints and drops the whole entry, exactly as the identity
//       resolver taints a candidate that names an unknown capability.
//   (3) the missing/unmapped case — a missing file and an unmapped login are indistinguishable
//       to a caller: both yield null (no grant). There is no default-allow.
//
// This module never establishes IDENTITY (it does not read whois, headers, or the socket) and
// never establishes SCOPE dirs (the server resolves the granted project's OWN member dirs from
// the registry — see identity.ts). It maps a confirmed login to a projectKey + capabilities and
// nothing more; the existing server-authoritative scope + capability validation still runs on
// top of whatever this returns.
//
// Additive by design (per the architect): today an entry is selected by `login`. Future
// selectors — a tailnet, a node tag, an ACL grant — are ADDED as sibling keys on an entry with
// a documented precedence; they are not a rewrite of this contract, and `login` stays the
// FG-782 selector.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { REMOTE_CAPABILITIES, isRemoteCapability, type RemoteCapability } from "./identity.js";

/** The operator-authored mapping file, under FORGE_HOME. A `.yml` so it is inspectable and
 *  comment-friendly, matching Forge's other operator config (routing-policy.yml, raci). */
export const IDENTITY_MAPPING_FILENAME = "remote-board-identity.yml";

/** The only mapping-file format version this Forge understands. A file that declares a
 *  DIFFERENT version is rejected whole (empty mapping) rather than read under semantics it may
 *  not share — fail closed on a forward-incompatible format. Absent version reads as 1. */
export const IDENTITY_MAPPING_VERSION = 1;

/**
 * One resolved grant: a whois-confirmed tailnet login is authorized on exactly ONE project at
 * the given capabilities. `capabilities` is always a non-empty subset of the closed
 * {@link REMOTE_CAPABILITIES} vocabulary (`read`, `plan` — FG-783). An entry grants each
 * capability only by naming it: `[read]` is read-only, `[plan]` is plan-only, `[read, plan]`
 * grants both. There is no implicit widening — a forged `mutate`/`write` still taints and drops.
 */
export interface IdentityGrant {
  /** The normalized (trimmed, lower-cased) tailnet login this grant is keyed on. */
  readonly login: string;
  /** The Forge project key (`pk-…` / `repo-…`) this login may read. Scope dirs are resolved
   *  server-side from this key — never carried here. */
  readonly projectKey: string;
  readonly capabilities: readonly RemoteCapability[];
}

/**
 * An immutable, already-validated mapping from tailnet login to grant. Produced only by
 * {@link buildIdentityMapping} / {@link parseIdentityMapping} / {@link loadIdentityMapping};
 * there is no way to construct one that carries an unvalidated grant.
 */
export interface IdentityMapping {
  /** Look up a whois-CONFIRMED tailnet login. Returns its single grant, or `null` (NO grant)
   *  for an unmapped login, a login whose entry was dropped, or a login declared more than
   *  once (poisoned). The lookup normalizes the login the same way the file did. */
  lookup(login: string): IdentityGrant | null;
  /** The number of live grants. Diagnostics / tests only — never an authorization input. */
  readonly size: number;
}

/** The always-empty mapping: nobody is granted anything. The value returned for a missing
 *  file, an unparseable file, or a version mismatch — every fail-closed path lands here. */
export const EMPTY_IDENTITY_MAPPING: IdentityMapping = Object.freeze({
  lookup: () => null,
  size: 0,
});

/** Normalize a login for keying/lookup: trim, lower-case. Tailnet logins from tailscaled
 *  whois are canonical (lower-case emails/OIDC subjects); normalizing both the file side and
 *  the lookup side the same way avoids an operator-visible lockout from a stray capital, and
 *  can only ever map MORE lookups onto ONE entry — never widen a single entry's grant. A
 *  non-string, or one that is empty after trimming, is not a usable key. */
function normalizeLogin(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  return v === "" ? null : v;
}

/** Validate a capability list from the file into the closed vocabulary, or refuse. Mirrors
 *  validateAdapterIdentity: an empty list grants nothing, and ANY unknown member (a forged
 *  `mutate`/`write`) taints the WHOLE list — the entry is dropped, never partially granted. */
function coerceCapabilities(value: unknown): readonly RemoteCapability[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  if (!value.every(isRemoteCapability)) return null;
  // Proven all-valid above; narrow and freeze onto the grant.
  return Object.freeze(value.filter(isRemoteCapability));
}

/** Coerce one raw file entry into a grant, or `null` to drop it. Fail-closed: a non-object, a
 *  missing/blank login, a missing/blank project, or an invalid capability set all drop the
 *  entry. The login is validated here but keyed by the caller (which also poisons duplicates). */
function coerceEntry(raw: unknown): IdentityGrant | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const entry = raw as Record<string, unknown>;
  const login = normalizeLogin(entry["login"]);
  if (login === null) return null;
  const projectRaw = entry["project"];
  if (typeof projectRaw !== "string" || projectRaw.trim() === "") return null;
  const capabilities = coerceCapabilities(entry["capabilities"]);
  if (capabilities === null) return null;
  return Object.freeze({ login, projectKey: projectRaw.trim(), capabilities });
}

/**
 * Build a validated {@link IdentityMapping} from an ALREADY-PARSED value (the object a YAML/JSON
 * parser produced). Pure — no filesystem, no environment. Every fail-closed rule lives here:
 *
 *   * a non-object top level, or a version that is present and not {@link IDENTITY_MAPPING_VERSION},
 *     rejects the WHOLE file → empty mapping;
 *   * `identities` absent or not an array → empty mapping;
 *   * a login declared more than once (after normalization) is POISONED — it gets no grant at
 *     all, because two lines for one identity is ambiguous intent and must not be silently
 *     merged or last-wins'd into a widened grant;
 *   * any individual entry that fails {@link coerceEntry} is dropped, leaving the rest intact.
 */
export function buildIdentityMapping(value: unknown): IdentityMapping {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return EMPTY_IDENTITY_MAPPING;
  }
  const doc = value as Record<string, unknown>;
  if (doc["version"] !== undefined && doc["version"] !== IDENTITY_MAPPING_VERSION) {
    return EMPTY_IDENTITY_MAPPING;
  }
  const identities = doc["identities"];
  if (!Array.isArray(identities)) return EMPTY_IDENTITY_MAPPING;

  // First pass: count every login the file NAMES (even in an otherwise-invalid entry) so a
  // duplicate declaration poisons the login regardless of which copy would have validated.
  const loginCounts = new Map<string, number>();
  for (const raw of identities) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
    const login = normalizeLogin((raw as Record<string, unknown>)["login"]);
    if (login === null) continue;
    loginCounts.set(login, (loginCounts.get(login) ?? 0) + 1);
  }

  // Second pass: keep the single valid grant for each non-poisoned login.
  const grants = new Map<string, IdentityGrant>();
  for (const raw of identities) {
    const grant = coerceEntry(raw);
    if (grant === null) continue;
    if ((loginCounts.get(grant.login) ?? 0) > 1) continue; // poisoned duplicate
    grants.set(grant.login, grant);
  }

  return Object.freeze({
    lookup(login: string): IdentityGrant | null {
      const key = normalizeLogin(login);
      if (key === null) return null;
      return grants.get(key) ?? null;
    },
    size: grants.size,
  });
}

/**
 * Parse mapping-file TEXT (YAML — a superset of JSON) into a validated mapping. Pure: no
 * filesystem, no environment, so this is the unit-testable seam. A YAML syntax error, or any
 * throw from the parser, fails closed to the empty mapping rather than propagating — a broken
 * file must deny access, never crash the request path or (worse) be skipped.
 */
export function parseIdentityMapping(text: string): IdentityMapping {
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch {
    return EMPTY_IDENTITY_MAPPING;
  }
  return buildIdentityMapping(parsed);
}

/** Resolve the mapping file's absolute path from an env map. Reads FORGE_HOME at CALL time
 *  (not module load) so tests — and a relocated FORGE_HOME — resolve against the live value,
 *  mirroring src/util/creds.ts and sso-watchdog.ts. */
export function resolveIdentityMappingPath(env: NodeJS.ProcessEnv = process.env): string {
  const forgeHome = env["FORGE_HOME"] ?? join(homedir(), ".forge");
  return join(forgeHome, IDENTITY_MAPPING_FILENAME);
}

/**
 * Load and validate the operator mapping from disk, re-reading the file on EVERY call.
 *
 * There is intentionally NO cache: the adapter calls this per request, so an operator who
 * deletes or edits a line revokes access on the very next request WITHOUT restarting Forge
 * (FG-782 AC4). A missing file (ENOENT) is the ordinary "remote board configured, nobody
 * mapped yet" state and fails closed to the empty mapping; any OTHER read error also fails
 * closed rather than throwing into the request path.
 */
export function loadIdentityMapping(env: NodeJS.ProcessEnv = process.env): IdentityMapping {
  const path = resolveIdentityMappingPath(env);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    // ENOENT (no file) or any read failure → no grant for anyone. Fail closed.
    return EMPTY_IDENTITY_MAPPING;
  }
  return parseIdentityMapping(text);
}

/** Re-export for callers/tests that assert against the closed capability vocabulary this
 *  mapping validates capabilities into. */
export { REMOTE_CAPABILITIES };
