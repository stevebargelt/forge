// FG-782 (step 6): the Tailscale Serve TransportAdapter.
//
// THREAT MODEL. This adapter is where the two halves of the FG-782 boundary meet — and it is
// deliberately the ONLY place they meet:
//   * IDENTITY comes ONLY from the local tailscaled, out-of-band (step 5 `whois`), anchored on
//     the CONNECTION peer (`request.peer.address`, a socket fact) — NEVER from an inbound
//     header VALUE. A local curl and a Serve proxy both arrive on 127.0.0.1 carrying
//     attacker-settable Tailscale-*/X-Forwarded-* headers; this adapter reads NONE of them.
//     The connection peer is confirmed against the daemon; a request whose peer cannot be
//     whois-confirmed gets no identity, hence no data (AC3). This closes the forged-header
//     attacker: forged Tailscale-User-Login + no whois-confirmed 100.x peer → null.
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
// daemon says WHO the peer is; the operator file says WHAT that who may read. Both must agree,
// per request, or the request refuses.
//
// FUNNEL (AC5). Public exposure via Tailscale Funnel is refused STRUCTURALLY here: a Funnel
// request does not present a whois-confirmable tailnet (100.x) peer, so `confirmPeer` returns
// null and the request gets no data — the adapter refuses any peer it cannot confirm. The
// operator-facing detection/refusal of a Funnel-enabled Serve config lives in doctor/setup
// (step 8, via `serveStatus`); this adapter's job is to never hand data to an unconfirmable peer.

import {
  type AdapterCandidateIdentity,
  type RemoteRequestContext,
  type TransportAdapter,
} from "../identity.js";
import { loadIdentityMapping, type IdentityMapping } from "../mapping.js";
import { createTailscaleRunner, whois, type TailscaleRunner, type TailscaleWhois } from "./cli.js";

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
 *   1. no whois-confirmable connection peer (`request.peer.address`)     → null (AC3, Funnel)
 *   2. the daemon does not confirm that peer as a tailnet user            → null (AC3)
 *   3. the confirmed login is not in the operator mapping (unmapped/revoked) → null (AC3/AC4)
 *   4. the mapped projectKey is not a registered project                 → null
 * Only a request that clears all four yields a candidate — and even then the resolver's
 * `validateAdapterIdentity` must still accept it (single non-empty grant + closed capability
 * vocabulary). The adapter reads NO inbound header value at any step.
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
      // (1) Anchor on the CONNECTION peer only — a socket fact, not a header. No peer means
      // nothing to confirm out-of-band; refuse. A Funnel/public request presents no
      // whois-confirmable tailnet peer and is refused here or at step (2) (AC5).
      const peerAddr = request.peer?.address;
      if (typeof peerAddr !== "string" || peerAddr.trim() === "") return null;

      // (2) Confirm WHO the peer is against the local tailscaled. Header VALUES (including any
      // Tailscale-User-Login the caller set) are never read; only this daemon assertion counts.
      // Forged headers + an unconfirmable peer → null, no data (AC3).
      const confirmed = confirmPeer(peerAddr);
      if (!confirmed) return null;

      // (3) Look up WHAT that confirmed login may read, re-reading the operator file every call
      // so a revoked/edited/deleted entry denies on the next request without a restart (AC4).
      // An unmapped (or revoked) login → null, no data (AC3/AC4).
      const grant = loadMapping(env).lookup(confirmed.login);
      if (!grant) return null;

      // (4) Resolve the granted project's OWN member dirs, server-authoritatively. A grant that
      // names no registered project yields no scope → refuse rather than widen. The dirs come
      // from the registry, never from the request.
      const project = lookupProject(grant.projectKey);
      if (!project || project.projectDirs.length === 0) return null;

      // Hand a candidate to the EXISTING validation path. subject = the confirmed login;
      // provenance names the daemon channel (no secrets — a login/node label is not a
      // credential). memberDirs are the project's own dirs; the server re-checks they are a
      // subset of the project (claimedDirsWithinProject) before assembling any data.
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
      };
    },
  };
}
