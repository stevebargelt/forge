import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { FORGE_HOME } from "./paths.js";
import { writeSecretFile } from "./secret-file.js";

// #176 auth profiles. A profile is a captured, Playwright-storageState-shaped
// browser session bound to a name. It lets browser agents test *authenticated*
// apps without ever holding credentials: forge captures the session out-of-band
// and injects it into the agent's CDP browser (Slice 3) / project Playwright
// suite (#177). Both consumers read this same file shape.
//
// The state file is a LIVE bearer credential. It lives host-global at
// ~/.forge/auth/<name>.storage.json, mode 600 — NEVER in the project tree, which
// is readable by any agent via the (read-only-still-readable) project mount.
// See learnings/decisions/2026-05-28_auth-profile-cdp-localstorage-injection.md.

export const AUTH_DIR = join(FORGE_HOME, "auth");

export interface StorageStateCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  // unix seconds; -1 (or omitted) means a session cookie
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

export interface StorageStateOriginEntry {
  name: string;
  value: string;
}

export interface StorageStateOrigin {
  origin: string;
  localStorage: StorageStateOriginEntry[];
}

export interface StorageState {
  cookies: StorageStateCookie[];
  origins: StorageStateOrigin[];
}

// Profile names become filenames; keep them to a safe slug so a name can never
// escape AUTH_DIR via traversal or absolute paths.
export function sanitizeProfileName(name: string): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  if (!slug) throw new Error(`Invalid profile name: ${JSON.stringify(name)}`);
  return slug;
}

export function profilePath(name: string): string {
  return join(AUTH_DIR, `${sanitizeProfileName(name)}.storage.json`);
}

export function ensureAuthDir(): void {
  mkdirSync(AUTH_DIR, { recursive: true });
}

export function writeProfile(name: string, state: StorageState): string {
  ensureAuthDir();
  const path = profilePath(name);
  // bearer credential — write 0600 atomically (no world-readable TOCTOU window).
  writeSecretFile(path, JSON.stringify(state, null, 2));
  return path;
}

export function readProfile(name: string): StorageState | null {
  const path = profilePath(name);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as StorageState;
}

export function removeProfile(name: string): boolean {
  const path = profilePath(name);
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}

export function listProfileNames(): string[] {
  if (!existsSync(AUTH_DIR)) return [];
  return readdirSync(AUTH_DIR)
    .filter((f) => f.endsWith(".storage.json"))
    .map((f) => f.slice(0, -".storage.json".length))
    .sort();
}

// Decode a JWT's `exp` claim (unix seconds) without verifying the signature —
// we only need expiry, and the token came from the user's own browser.
function jwtExp(token: string): number | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as { exp?: unknown };
    return typeof payload.exp === "number" ? payload.exp : null;
  } catch {
    return null;
  }
}

// Derive the earliest expiry (unix seconds) across everything in the state:
// Supabase-style JSON localStorage values carry a top-level `expires_at`; their
// access_token is a JWT whose `exp` is a fallback; cookies carry `expires`.
// Returns null when nothing dated is found (expiry unknown — cannot fail-fast).
//
// NOTE (#176 finding #2): an unauthenticated app does NOT necessarily redirect
// to a login page, so expiry MUST be derived from the token, never from a
// runtime login-URL bounce.
export function profileExpiry(state: StorageState): number | null {
  const candidates: number[] = [];
  for (const origin of state.origins) {
    for (const entry of origin.localStorage) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(entry.value);
      } catch {
        continue;
      }
      if (parsed && typeof parsed === "object") {
        const obj = parsed as { expires_at?: unknown; access_token?: unknown };
        if (typeof obj.expires_at === "number") candidates.push(obj.expires_at);
        else if (typeof obj.access_token === "string") {
          const exp = jwtExp(obj.access_token);
          if (exp !== null) candidates.push(exp);
        }
      }
    }
  }
  for (const cookie of state.cookies) {
    if (typeof cookie.expires === "number" && cookie.expires > 0) candidates.push(cookie.expires);
  }
  if (candidates.length === 0) return null;
  return Math.min(...candidates);
}

// Origins + cookie domains the profile carries — the implicit allowlist for v1.
export function profileDomains(state: StorageState): string[] {
  const set = new Set<string>();
  for (const o of state.origins) set.add(o.origin);
  for (const c of state.cookies) set.add(c.domain);
  return [...set].sort();
}

// #183: a captured profile records the origin the human logged in at (often
// http://localhost:3000). An agent CONTAINER can't reach the host's localhost —
// it reaches the host via host.docker.internal (Docker Desktop) — so the state's
// origin must be rewritten to what the agent will actually browse, or the
// injector's location.origin guard never fires and auth silently no-ops.
// Override the target host with FORGE_CONTAINER_HOST (e.g. for non-Docker-Desktop
// setups); host-served apps on real DNS need no rewrite.
const LOCALHOST_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1"]);

function containerHost(): string {
  return process.env.FORGE_CONTAINER_HOST || "host.docker.internal";
}

// Rewrite a localhost-family origin to the container-reachable host, preserving
// scheme and port. Non-localhost origins (real DNS) pass through unchanged.
export function reconcileOriginForContainer(origin: string): string {
  try {
    const u = new URL(origin);
    if (LOCALHOST_HOSTS.has(u.hostname)) {
      u.hostname = containerHost();
      return u.origin;
    }
    return origin;
  } catch {
    return origin;
  }
}

// Produce a container-reachable copy of a storage state: localhost-family origins
// and cookie domains rewritten to the container host. `changed` is false when
// nothing localhost was present (the original can be used as-is).
export function reconcileStateForContainer(state: StorageState): { state: StorageState; changed: boolean } {
  let changed = false;
  const host = containerHost();
  const origins = state.origins.map((o) => {
    const newOrigin = reconcileOriginForContainer(o.origin);
    if (newOrigin !== o.origin) changed = true;
    return { ...o, origin: newOrigin };
  });
  const cookies = state.cookies.map((c) => {
    if (LOCALHOST_HOSTS.has(c.domain)) {
      changed = true;
      return { ...c, domain: host };
    }
    return c;
  });
  return { state: { cookies, origins }, changed };
}

export interface ProfileStatus {
  name: string;
  exists: boolean;
  path: string;
  domains: string[];
  // unix seconds, or null when no dated material was found
  expiresAt: number | null;
  expired: boolean;
  // present only when expiresAt is known
  expiresInSeconds?: number;
}

export function profileStatus(name: string, now: number = Date.now()): ProfileStatus {
  const path = profilePath(name);
  const state = readProfile(name);
  if (!state) {
    return { name: sanitizeProfileName(name), exists: false, path, domains: [], expiresAt: null, expired: false };
  }
  const expiresAt = profileExpiry(state);
  const nowSec = Math.floor(now / 1000);
  return {
    name: sanitizeProfileName(name),
    exists: true,
    path,
    domains: profileDomains(state),
    expiresAt,
    expired: expiresAt !== null && expiresAt <= nowSec,
    ...(expiresAt !== null ? { expiresInSeconds: expiresAt - nowSec } : {}),
  };
}
