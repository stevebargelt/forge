// FG-784 (step 2): the Cloudflare Access JWKS fetch + cache seam.
//
// WHAT THIS IS. The Cloudflare Access adapter (step 4) authenticates a request by
// cryptographically verifying its Cf-Access-Jwt-Assertion token against the team's public
// signing keys. Those keys live at the team's JWKS endpoint
// (`https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`) and ROTATE. This module is the
// only thing that talks to that endpoint: it owns the outbound fetch, a bounded positive cache,
// and a RATE-BOUNDED refresh-on-unknown-kid so a rotation is picked up without turning inbound
// tokens into an outbound-fetch amplifier.
//
// SECURITY POSTURE — fail CLOSED, never OPEN. This module returns plain JWK data only; it never
// decides whether a token is valid (that is jwt.ts, step 1, which it deliberately does NOT
// import). Its one security duty is: when it cannot prove it holds CURRENT keys, it yields NO
// keys, so the verifier refuses. Concretely:
//   • empty-and-unreachable cache  -> [] (never "accept any").
//   • keys past their TTL that cannot be refreshed (an unreachable rotation) -> [], NOT the
//     stale keys. Serving a stale key set past its freshness would accept a token signed by a
//     key that may already have been rotated out at the edge — that is fail-open, and forbidden.
//   • a fresh key set that simply lacks a kid -> returned as-is; the verifier reports unknown-kid
//     and the adapter asks for ONE rate-bounded refresh.
//
// AMPLIFICATION DEFENSE (architect risk 1). An attacker can spray tokens carrying random `kid`
// values straight at the loopback origin. Each unknown kid tempts a refetch. Two bounds make
// that safe: (a) a global refresh WINDOW — at most one outbound fetch attempt per window no
// matter how many unknown kids arrive; and (b) a NEGATIVE cache of kids proven absent after a
// real refresh, so a persistent bogus kid does not re-attempt every window. In-flight fetches
// are also de-duplicated so a concurrent burst collapses to a single request.
//
// This module is a pure function of (injected fetcher, injected clock): unit tests drive a fake
// fetcher and a fake clock and touch no network. Only the DEFAULT fetcher performs real HTTP,
// and it is exercised against a local fake server in jwks.integration.test.ts.

/** Default lifetime of a positively-cached key set. Within this window the cache is served with
 *  no outbound fetch; past it, the keys are considered stale and are refreshed (or, if the
 *  refresh cannot happen, dropped — fail closed). Cloudflare rotates signing keys on the order
 *  of weeks, so a short TTL is cheap and tightens the window in which a rotated-out key could
 *  still be honoured. */
export const DEFAULT_JWKS_TTL_MS = 10 * 60 * 1000; // 10 minutes

/** The minimum interval between outbound fetch ATTEMPTS. This is the load-bearing amplification
 *  bound: however many unknown-kid tokens arrive, at most one fetch is issued per window. */
export const DEFAULT_JWKS_REFRESH_WINDOW_MS = 30 * 1000; // 30 seconds

/** How long a single JWKS fetch may run before it is aborted. A hung endpoint must never wedge a
 *  request handler; an abort is caught and treated as "no fresh keys" -> fail closed. */
export const DEFAULT_JWKS_FETCH_TIMEOUT_MS = 5000;

/** Upper bound on how many keys we will retain from one response. A legitimate Access JWKS holds
 *  a small handful (current + previous during rotation); a wildly larger set is a malformed or
 *  hostile response and is truncated rather than trusted wholesale. */
export const MAX_JWKS_KEYS = 16;

/**
 * The injected outbound-fetch seam: given the fully-resolved certs URL, return the parsed
 * `JsonWebKey[]`. MUST reject (throw) on any transport/HTTP/parse failure — a throw is read by
 * the cache as "could not refresh" and handled fail-closed. Tests supply a fake; production uses
 * {@link createDefaultJwksFetcher}.
 */
export type JwksFetcher = (certsUrl: string) => Promise<JwksKey[]>;

/** A signing key as we retain it: a JWK plus its (optional) key id used to match a token's `kid`
 *  header. */
export type JwksKey = JsonWebKey & { readonly kid?: string };

export interface JwksCacheOptions {
  /** The Access team domain: a bare team name (`acme`), a full team host
   *  (`acme.cloudflareaccess.com`), or a full base/cert URL. Resolved to the certs endpoint via
   *  {@link buildCertsUrl}. Comes from the Forge-owned access-state at boot (step 3), NOT
   *  config.ts. */
  readonly teamDomain: string;
  /** Outbound-fetch seam. Defaults to {@link createDefaultJwksFetcher} (real HTTPS). */
  readonly fetcher?: JwksFetcher;
  /** Positive-cache TTL. Defaults to {@link DEFAULT_JWKS_TTL_MS}. */
  readonly ttlMs?: number;
  /** Minimum interval between fetch attempts. Defaults to {@link DEFAULT_JWKS_REFRESH_WINDOW_MS}. */
  readonly refreshWindowMs?: number;
  /** Injected clock. Defaults to `Date.now`. */
  readonly now?: () => number;
}

/**
 * The read side the adapter consumes. Neither method ever throws into the caller and neither
 * ever returns keys it cannot prove are current — an empty array is the fail-closed answer.
 */
export interface JwksCache {
  /** The current usable key set, fetching once if the cache is empty/expired and the refresh
   *  window allows. Fresh keys are served with no fetch; stale keys that cannot be refreshed
   *  yield `[]` (never stale, never "any"). */
  getKeys(): Promise<readonly JwksKey[]>;
  /** Called by the adapter when a token's `kid` was absent from {@link getKeys}'s result — a
   *  likely rotation. Triggers at most one rate-bounded refresh, negative-caches a kid still
   *  absent after a real refresh, and returns the (possibly updated) usable key set. */
  refreshForUnknownKid(kid: string): Promise<readonly JwksKey[]>;
  /** The resolved certs URL this cache fetches — for setup/doctor to display and probe. */
  readonly certsUrl: string;
}

/**
 * Resolve an Access team domain to its JWKS certs endpoint. Accepts a bare team name, a team
 * host, or a full URL, and ALWAYS yields an `https:` URL ending in the Access certs path.
 * Throws on an empty domain or a non-`https:` explicit scheme (the endpoint is security-critical
 * and must never be fetched over plaintext).
 */
export function buildCertsUrl(teamDomain: string): string {
  const raw = (teamDomain ?? "").trim();
  if (raw === "") throw new Error("cloudflare access team domain is required to build the JWKS URL");
  const CERTS_PATH = "/cdn-cgi/access/certs";

  if (raw.includes("://")) {
    const url = new URL(raw);
    if (url.protocol !== "https:") {
      throw new Error(`cloudflare access JWKS endpoint must be https, got ${url.protocol}`);
    }
    // Preserve an explicit certs path; otherwise append it to the given base.
    if (url.pathname === "/" || url.pathname === "") url.pathname = CERTS_PATH;
    return url.toString();
  }

  // A bare team name (no dot) expands to the canonical cloudflareaccess.com host; anything with a
  // dot is treated as a full host the operator supplied.
  const host = raw.includes(".") ? raw : `${raw}.cloudflareaccess.com`;
  return new URL(`https://${host}${CERTS_PATH}`).toString();
}

/**
 * PURE: reduce a parsed certs response body to a bounded, well-formed `JwksKey[]`. Cloudflare's
 * certs endpoint returns `{ keys: [...], public_cert, public_certs }`; we take `keys` and keep
 * only entries that are objects carrying a `kty` (a minimal structural gate — the cryptographic
 * decision is jwt.ts's, not ours). Truncated to {@link MAX_JWKS_KEYS}. Never throws; a
 * non-conforming body yields `[]`.
 */
export function extractJwks(body: unknown): JwksKey[] {
  if (typeof body !== "object" || body === null) return [];
  const keys = (body as Record<string, unknown>)["keys"];
  if (!Array.isArray(keys)) return [];
  return sanitizeKeyArray(keys);
}

/** PURE: filter an ALREADY-array-shaped key list to bounded, structurally-valid JWKs. Applied to
 *  whatever an injected fetcher returns (defense in depth — a fake or future fetcher cannot
 *  smuggle a non-JWK or an unbounded list into the cache). Never throws. */
export function sanitizeKeyArray(keys: readonly unknown[]): JwksKey[] {
  const out: JwksKey[] = [];
  for (const entry of keys) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const rec = entry as Record<string, unknown>;
    if (typeof rec["kty"] !== "string" || rec["kty"] === "") continue;
    out.push(entry as JwksKey);
    if (out.length >= MAX_JWKS_KEYS) break;
  }
  return out;
}

/** Does this key set contain a key whose `kid` matches? An empty/missing kid never matches — a
 *  token that omits `kid` cannot be resolved against a keyed set here. */
function keysContainKid(keys: readonly JwksKey[], kid: string): boolean {
  if (kid === "") return false;
  return keys.some((k) => typeof k.kid === "string" && k.kid === kid);
}

/**
 * Build the default outbound fetcher: a single `GET` of the certs URL with a hard timeout and
 * `redirect: "error"` (the endpoint is a fixed cloudflareaccess.com host — never follow a
 * redirect off it). A non-2xx status or an unparseable body throws, which the cache treats as a
 * failed refresh. Returns only the structurally-valid `keys` (see {@link extractJwks}).
 */
export function createDefaultJwksFetcher(
  timeoutMs: number = DEFAULT_JWKS_FETCH_TIMEOUT_MS,
): JwksFetcher {
  return async (certsUrl) => {
    const res = await fetch(certsUrl, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/json" },
    });
    if (!res.ok) throw new Error(`cloudflare access JWKS fetch failed: HTTP ${res.status}`);
    const body: unknown = await res.json();
    return extractJwks(body);
  };
}

/**
 * Create a JWKS cache for one Access team. Holds a positive cache (TTL-bounded), a global fetch
 * window (amplification bound), a negative kid cache, and in-flight de-duplication. All state is
 * internal; the returned {@link JwksCache} is the only surface.
 */
export function createJwksCache(options: JwksCacheOptions): JwksCache {
  const certsUrl = buildCertsUrl(options.teamDomain);
  const fetcher = options.fetcher ?? createDefaultJwksFetcher();
  const ttlMs = options.ttlMs ?? DEFAULT_JWKS_TTL_MS;
  const refreshWindowMs = options.refreshWindowMs ?? DEFAULT_JWKS_REFRESH_WINDOW_MS;
  const now = options.now ?? (() => Date.now());

  let keys: JwksKey[] | null = null;
  let fetchedAt = 0;
  // Initialised so the very first attempt is always allowed (window elapsed).
  let lastAttemptAt = Number.NEGATIVE_INFINITY;
  const negativeKids = new Map<string, number>();
  let inFlight: Promise<void> | null = null;

  const isFresh = (): boolean => keys !== null && now() - fetchedAt < ttlMs;
  const canAttempt = (): boolean => now() - lastAttemptAt >= refreshWindowMs;
  /** Keys we are willing to serve: only a FRESH set, never stale. */
  const servable = (): readonly JwksKey[] => (isFresh() ? (keys as JwksKey[]) : []);
  const negativeFresh = (kid: string): boolean => {
    const at = negativeKids.get(kid);
    return at !== undefined && now() - at < refreshWindowMs;
  };

  /** One rate-bounded, de-duplicated fetch attempt. Records the attempt time up front (so the
   *  window advances even on failure — a down endpoint cannot be hammered), and only REPLACES
   *  the cache on success. A failure leaves the previous (now-stale) cache untouched; the
   *  freshness gate, not this function, decides it is unservable. */
  const attemptFetch = async (): Promise<void> => {
    if (inFlight) {
      await inFlight;
      return;
    }
    lastAttemptAt = now();
    const p = (async () => {
      try {
        const fetched = await fetcher(certsUrl);
        keys = sanitizeKeyArray(fetched); // defense in depth around whatever the fetcher returned
        fetchedAt = now();
        negativeKids.clear(); // a fresh key set invalidates every "known absent" verdict
      } catch {
        // Fail closed: keep whatever we had; servable() will drop it if it is now stale.
      }
    })();
    inFlight = p;
    try {
      await p;
    } finally {
      inFlight = null;
    }
  };

  const getKeys = async (): Promise<readonly JwksKey[]> => {
    if (isFresh()) return keys as JwksKey[];
    // A concurrent caller: join the in-flight fetch rather than fail closed on the just-consumed
    // window, so a cold-start burst collapses to one fetch AND all callers see its result.
    if (inFlight) {
      await inFlight;
      return servable();
    }
    if (canAttempt()) await attemptFetch();
    return servable();
  };

  const refreshForUnknownKid = async (kid: string): Promise<readonly JwksKey[]> => {
    const k = (kid ?? "").trim();
    // Already resolvable against the current fresh set — nothing to do.
    if (k !== "" && isFresh() && keysContainKid(keys as JwksKey[], k)) return keys as JwksKey[];
    // Proven absent recently: do not spend a fetch on it again this window.
    if (k !== "" && negativeFresh(k)) return servable();
    if (inFlight) {
      await inFlight;
      return servable();
    }
    if (canAttempt()) {
      await attemptFetch();
      // Still absent after a real refresh -> record so a persistent bogus kid stops re-fetching.
      if (k !== "" && !keysContainKid(servable(), k)) negativeKids.set(k, now());
    }
    return servable();
  };

  return { getKeys, refreshForUnknownKid, certsUrl };
}
