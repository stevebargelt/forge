// FG-782 (step 6): the Tailscale Serve TransportAdapter.
//
// THREAT MODEL. This adapter is where the two halves of the FG-782 boundary meet — and it is
// deliberately the ONLY place they meet:
//   * IDENTITY comes ONLY from the local tailscaled, out-of-band (step 5 `whois`). The subtlety
//     that RF-1 corrected: Tailscale Serve terminates TLS on the local node and PROXIES to
//     http://127.0.0.1:<port>, so at the backend socket the connection peer is the local Serve
//     proxy (loopback), NOT the originating tailnet caller. whois'ing the socket peer would ask
//     the daemon to identify 127.0.0.1 — it can never name the remote caller, and would either
//     deny every legitimate remote user or (worse) authorize them as the local host identity.
//     So the socket peer is used ONLY as a PRECONDITION (it MUST be loopback — a request that
//     did not arrive through the local Serve proxy is refused), and the tailnet caller is taken
//     from the Serve-set `X-Forwarded-For` as a HINT that is then whois-CONFIRMED. A header VALUE
//     still never establishes identity on its face: the forwarded address is confirmed against
//     the daemon, and the Serve-set `Tailscale-User-Login` must EQUAL the login whois returns
//     for that address. Mismatch, missing, or an unconfirmable address → no identity, no data
//     (AC3). A forged Tailscale-User-Login that whois contradicts is refused.
//   * AUTHORIZATION comes ONLY from the operator mapping file (step 4), re-read per request so
//     an operator's revocation (edit/delete a line, or remove the tailnet node) is honored on
//     the very next request WITHOUT restarting Forge (AC4). A whois-confirmed login that maps
//     to nothing gets no data (AC3).
//   * SCOPE stays server-authoritative: the adapter names a projectKey (from the mapping) and
//     resolves that project's OWN member dirs through an injected lookup — it never invents or
//     widens dirs. The returned candidate flows through the EXISTING `validateAdapterIdentity`
//     path (single-grant + closed-capability checks); the adapter does NOT re-validate.
//
// The identity oracle (whois) and the authorization oracle (mapping) are never merged: the
// daemon says WHO the forwarded peer is; the operator file says WHAT that who may read. Both
// must agree, per request, or the request refuses.
//
// AUDIT TRAIL. The two Serve-set headers this adapter consults (`x-forwarded-for`,
// `tailscale-user-login`) are reported back as `confirmedIdentityHeaders` on the resolution, so
// the record says truthfully that they were CONFIRMED against whois — not silently ignored.
//
// FUNNEL (AC5). Public exposure via Tailscale Funnel is refused STRUCTURALLY here: a Funnel
// request either does not present a loopback socket peer or presents no whois-confirmable
// tailnet (100.x/fd7a:) forwarded address, so `confirmPeer` returns null and the request gets no
// data — the adapter refuses any peer it cannot confirm. The operator-facing detection/refusal
// of a Funnel-enabled Serve config lives in doctor/setup (step 8, via `serveStatus`); this
// adapter's job is to never hand data to an unconfirmable peer.

import {
  type AdapterCandidateIdentity,
  type RemoteRequestContext,
  type TransportAdapter,
} from "../identity.js";
import { loadIdentityMapping, type IdentityMapping } from "../mapping.js";
import {
  createTailscaleRunner,
  isPlausiblePeerAddress,
  whois,
  type TailscaleRunner,
  type TailscaleWhois,
} from "./cli.js";

/** The Serve-set headers this adapter CONSULTS and then confirms out-of-band. Reported as
 *  `confirmedIdentityHeaders` on a successful resolution so the audit trail records that these
 *  values were verified against whois, not trusted on their face. Lower-cased to match Node's
 *  normalized header keys. */
const CONFIRMED_IDENTITY_HEADERS = ["x-forwarded-for", "tailscale-user-login"] as const;

/** Is the backend socket peer a loopback address? Tailscale Serve proxies from the LOCAL node,
 *  so a legitimate Serve-fronted request always arrives on 127.0.0.1 / ::1 (or the IPv4-mapped
 *  form). A non-loopback socket peer means the request did NOT come through the local Serve
 *  proxy — it is refused rather than treated as a trustworthy carrier of the Serve headers. */
function isLoopbackPeer(addr: string | undefined): boolean {
  if (typeof addr !== "string") return false;
  const v = addr.trim().toLowerCase();
  if (v === "::1") return true;
  const bare = v.startsWith("::ffff:") ? v.slice("::ffff:".length) : v;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare);
}

/** Read one string value for a header that Node may deliver as a string or a string[]. */
function headerValue(v: string | string[] | undefined): string | undefined {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v[0];
  return undefined;
}

/** The leftmost address of an `X-Forwarded-For` value — the originating client Serve recorded.
 *  Serve sets this to the tailnet peer; we take the first entry as the address to whois-confirm.
 *  Empty/absent → null. Plausibility (IP-shaped) is enforced by the caller before it reaches the
 *  daemon so junk can never be handed to the CLI. */
function forwardedClientAddress(xff: string | undefined): string | null {
  if (typeof xff !== "string") return null;
  const first = xff.split(",")[0]?.trim();
  return first !== undefined && first !== "" ? first : null;
}

/** Normalize a login the same way the operator mapping does (trim + lower-case), so the
 *  header-vs-whois equality check never rejects on a stray capital or trailing space. */
function normalizeLogin(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  return v === "" ? null : v;
}

/** The provenance token stamped on every identity this adapter produces. Names the out-of-band
 *  channel that proved the principal (the local tailscaled), NEVER a raw header source. */
export const TAILSCALE_SERVE_ADAPTER_KIND = "tailscale-serve";

/**
 * The minimal project projection the adapter needs to name a server-authoritative scope: the
 * granted project's key and its OWN member dirs. Injected (not imported from the dashboard
 * registry) so the adapter stays a pure decision unit and unit tests supply a fake without a DB.
 * Mirrors the shape RemoteBoardDeps.lookupProject already returns.
 */
export interface AdapterProjectView {
  readonly key: string;
  readonly projectDirs: readonly string[];
}

/**
 * Injectable seams for the adapter. Every default is the fail-closed production wiring; unit
 * tests override `confirmPeer` and `loadMapping` with pure functions (no process, no fs), and
 * the integration test injects a runner pointed at a fake binary plus a real temp mapping file.
 */
export interface TailscaleServeAdapterDeps {
  /** Resolve a granted project key to its OWN member dirs, or undefined if it is not a
   *  registered project. REQUIRED — there is no safe default that could invent a scope. */
  readonly lookupProject: (projectKey: string) => AdapterProjectView | undefined;
  /** Confirm a connection peer via the local tailscaled. Default: `whois` over a real runner.
   *  Returns null (fail closed) when the daemon is down, the peer is not on the tailnet, or the
   *  output is unparseable — never a fallback identity. */
  readonly confirmPeer?: (peerAddr: string) => TailscaleWhois | null;
  /** Load the operator identity→authorization mapping. Default: {@link loadIdentityMapping},
   *  which re-reads the file on EVERY call so revocation is live (AC4). */
  readonly loadMapping?: (env?: NodeJS.ProcessEnv) => IdentityMapping;
  /** The command runner backing the default `confirmPeer`. Ignored when `confirmPeer` is
   *  supplied. Default: {@link createTailscaleRunner} (resolves `tailscale` on PATH). */
  readonly runner?: TailscaleRunner;
  /** Env map the default `loadMapping` resolves FORGE_HOME from. Default: `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Build the Tailscale Serve transport adapter. Its `verifyIdentity` is async: confirming the
 * peer against the local daemon is inherently out-of-band, and the resolver awaits it on the
 * single async path (there is no parallel sync branch that could fail open).
 *
 * Decision order (every step fails CLOSED to null — no data — before the next):
 *   1. the backend SOCKET peer is not loopback                            → null (not via Serve)
 *   2. no Serve-set `X-Forwarded-For` client address, or it is not IP-shaped → null (AC3, Funnel)
 *   3. no Serve-set `Tailscale-User-Login` claim                          → null (AC3)
 *   4. the daemon does not confirm that forwarded address as a tailnet user → null (AC3)
 *   5. the whois login does not EQUAL the `Tailscale-User-Login` claim    → null (AC3, forged)
 *   6. the confirmed login is not in the operator mapping (unmapped/revoked) → null (AC3/AC4)
 *   7. the mapped projectKey is not a registered project                 → null
 * Only a request that clears all seven yields a candidate — and even then the resolver's
 * `validateAdapterIdentity` must still accept it (single non-empty grant + closed capability
 * vocabulary). No header value is EVER trusted on its face: the forwarded address is confirmed
 * against the daemon, and the login claim must equal that daemon's answer.
 */
export function createTailscaleServeAdapter(deps: TailscaleServeAdapterDeps): TransportAdapter {
  const runner = deps.runner ?? createTailscaleRunner();
  const confirmPeer = deps.confirmPeer ?? ((peerAddr: string) => whois(peerAddr, runner));
  const loadMapping = deps.loadMapping ?? loadIdentityMapping;
  const env = deps.env;
  const lookupProject = deps.lookupProject;

  return {
    kind: TAILSCALE_SERVE_ADAPTER_KIND,
    // eslint-disable-next-line @typescript-eslint/require-await -- async is the contract seam
    async verifyIdentity(
      request: RemoteRequestContext,
    ): Promise<AdapterCandidateIdentity | null> {
      // (1) PRECONDITION: the backend socket peer MUST be loopback. Tailscale Serve proxies from
      // the LOCAL node, so a legitimate Serve-fronted request always arrives on 127.0.0.1 / ::1.
      // A non-loopback socket peer never came through the local Serve proxy — refuse; it is not a
      // trustworthy carrier of the forwarded identity headers.
      if (!isLoopbackPeer(request.peer?.address)) return null;

      // (2) The tailnet caller's address is the Serve-set X-Forwarded-For — a HINT, not identity.
      // It is IP-shape-validated before it reaches the daemon so nothing junk is handed to the
      // CLI, and it is whois-CONFIRMED below. Missing/garbage → refuse (AC3). A Funnel/public
      // request presents no whois-confirmable tailnet address and is refused here or at (4) (AC5).
      const forwardedAddr = forwardedClientAddress(headerValue(request.headers["x-forwarded-for"]));
      if (forwardedAddr === null || !isPlausiblePeerAddress(forwardedAddr)) return null;

      // (3) The Serve-set login claim. Still not trusted on its face — it must EQUAL the whois
      // answer at (5). Missing → refuse (there is nothing to hold whois against).
      const claimedLogin = normalizeLogin(headerValue(request.headers["tailscale-user-login"]));
      if (claimedLogin === null) return null;

      // (4) Confirm WHO the forwarded address is against the local tailscaled. Only this daemon
      // assertion counts. An unconfirmable address (daemon down, not on the tailnet, unparseable)
      // → null, no data (AC3).
      const confirmed = confirmPeer(forwardedAddr);
      if (!confirmed) return null;

      // (5) The whois login MUST equal the Serve-set Tailscale-User-Login claim. A forged login
      // header that the daemon contradicts is refused with no data (AC3). This is what keeps the
      // header a confirmed input rather than a trusted one.
      if (normalizeLogin(confirmed.login) !== claimedLogin) return null;

      // (6) Look up WHAT that confirmed login may read, re-reading the operator file every call
      // so a revoked/edited/deleted entry denies on the next request without a restart (AC4).
      // An unmapped (or revoked) login → null, no data (AC3/AC4).
      const grant = loadMapping(env).lookup(confirmed.login);
      if (!grant) return null;

      // (7) Resolve the granted project's OWN member dirs, server-authoritatively. A grant that
      // names no registered project yields no scope → refuse rather than widen. The dirs come
      // from the registry, never from the request.
      const project = lookupProject(grant.projectKey);
      if (!project || project.projectDirs.length === 0) return null;

      // Hand a candidate to the EXISTING validation path. subject = the confirmed login;
      // provenance names the daemon channel (no secrets — a login/node label is not a
      // credential). memberDirs are the project's own dirs; the server re-checks they are a
      // subset of the project (claimedDirsWithinProject) before assembling any data.
      // confirmedIdentityHeaders records that the two Serve headers were CONFIRMED against whois,
      // not ignored, so the resolution's audit trail is truthful.
      return {
        subject: confirmed.login,
        capabilities: grant.capabilities,
        projectScope: {
          projectKey: grant.projectKey,
          memberDirs: [...project.projectDirs],
        },
        provenance: {
          adapter: TAILSCALE_SERVE_ADAPTER_KIND,
          detail: confirmed.node ? `node=${confirmed.node}` : undefined,
        },
        confirmedIdentityHeaders: [...CONFIRMED_IDENTITY_HEADERS],
      };
    },
  };
}
