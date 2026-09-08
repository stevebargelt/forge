// FG-782 (step 7): the boot-time transport REGISTRY.
//
// THREAT MODEL. This module is the single seam that turns the operator's boot-time transport
// selector (FORGE_DASHBOARD_REMOTE_TRANSPORT, resolved to a canonical token in config.ts) into
// a concrete TransportAdapter — or into `null`, which is the FG-781 fail-closed default (no
// adapter ⇒ every request is refused). Two properties it makes structural:
//   (1) FAIL CLOSED BY CONSTRUCTION. Only a recognised token maps to an adapter; every other
//       value — null/undefined (absent selector), an unknown token, a typo, an attacker-shaped
//       string — falls through to `null`. There is no default-adapter branch. Because
//       config.resolveRemoteTransport already collapses anything unrecognised to `null` before
//       we are called, this registry is the second, independent gate on the same invariant.
//   (2) IT NEVER TOUCHES THE BIND. Selecting a transport builds an identity adapter and NOTHING
//       else: it does not read or mutate config.host/config.port. The loopback bind stays the
//       REMOTE_LOOPBACK_HOST constant regardless of which transport is selected (AC2) — a
//       property proven end to end in server.integration.test.ts.
//
// Additive by design: FG-784's Cloudflare Access variant slots in here as a sibling `case`
// alongside "tailscale"; it does not rewrite this contract.

import type { TransportAdapter } from "./identity.js";
import {
  createTailscaleServeAdapter,
  type AdapterProjectView,
  type TailscaleServeAdapterDeps,
} from "./tailscale/adapter.js";
import {
  createCloudflareAccessAdapter,
  type CloudflareAccessAdapterDeps,
} from "./cloudflare/adapter.js";
import { createJwksCache, type JwksCache } from "./cloudflare/jwks.js";
import { readAccessState } from "./cloudflare/access-state.js";

/** The canonical Tailscale Serve transport token — the value config.resolveRemoteTransport
 *  yields for `FORGE_DASHBOARD_REMOTE_TRANSPORT=tailscale`. Kept here as the registry's own
 *  copy of the token so the switch below matches the resolved config value exactly. */
export const TAILSCALE_TRANSPORT = "tailscale";

/** The canonical Cloudflare Access transport token — the value config.resolveRemoteTransport
 *  yields for `FORGE_DASHBOARD_REMOTE_TRANSPORT=cloudflare`. A sibling of TAILSCALE_TRANSPORT,
 *  matched exactly against the resolved config value below. */
export const CLOUDFLARE_TRANSPORT = "cloudflare";

/**
 * The UNION of every transport adapter's boot-injectable seams over one SHARED, REQUIRED
 * `lookupProject`. Each adapter reads only the seams it knows: the Tailscale case reads
 * `confirmPeer`/`runner`/`loadMapping`; the Cloudflare case reads `jwksCache`/`loadAccessState`/
 * `loadMapping`/`now`/`allowedAlgorithms`/`clockToleranceSeconds`. Overlapping fields
 * (`loadMapping`, `env`) are identical across both adapters, so a single value serves whichever
 * transport is selected. Production passes only `lookupProject` (+ `env`) and each adapter falls
 * back to its real backend (tailscaled / the boot-built JWKS cache) and the on-disk mapping;
 * tests inject fakes through this SAME path, so the wiring under test is the real one.
 */
export interface RemoteTransportDeps
  extends Omit<TailscaleServeAdapterDeps, "lookupProject">,
    Omit<CloudflareAccessAdapterDeps, "lookupProject" | "jwksCache"> {
  /** Resolve a granted project key to its OWN member dirs. REQUIRED and shared by every
   *  transport — there is no safe default that could invent a scope. */
  readonly lookupProject: (projectKey: string) => AdapterProjectView | undefined;
  /** Cloudflare only: an already-built JWKS cache (tests inject a fake keyed on a local
   *  keypair). Absent in production, where {@link selectRemoteAdapter} builds one at boot from
   *  the Forge-owned access-state's team domain. */
  readonly jwksCache?: JwksCache;
}

/** A fail-closed JWKS cache: it holds no keys and cannot refresh into any. Used only at boot when
 *  no Access team domain is configured, so the Cloudflare adapter can still be CONSTRUCTED but can
 *  never serve a key for an untrusted/absent team. It is in practice never consulted — the adapter
 *  refuses at its access-state gate (no trusted team/AUD ⇒ refuse) before touching the JWKS — but
 *  keeping it fail-closed preserves the invariant structurally rather than by ordering luck. */
const EMPTY_JWKS_CACHE: JwksCache = {
  getKeys: () => Promise.resolve([]),
  refreshForUnknownKid: () => Promise.resolve([]),
  certsUrl: "",
};

/**
 * Build the JWKS cache the Cloudflare adapter needs at boot. A test that injected `deps.jwksCache`
 * is honoured as-is. Otherwise read the Forge-owned access-state for the Access team domain and
 * build a cache pointed at that team's certs endpoint. Absent an access-state (never set up), or a
 * team domain that yields no valid https certs URL, return the fail-closed {@link EMPTY_JWKS_CACHE}
 * — the adapter will refuse every request at its access-state gate regardless, but construction
 * must not throw. The cache is bound to the team domain observed AT BOOT; a later `setup` that
 * changes the team requires a dashboard restart to repoint it (documented).
 */
function buildBootJwksCache(deps: RemoteTransportDeps): JwksCache {
  if (deps.jwksCache) return deps.jwksCache;
  const loadAccessState = deps.loadAccessState ?? readAccessState;
  const state = loadAccessState(deps.env);
  if (state === null) return EMPTY_JWKS_CACHE;
  try {
    return createJwksCache({ teamDomain: state.accessTeamDomain, now: deps.now });
  } catch {
    // A malformed team domain (buildCertsUrl throws) → fail closed rather than crash boot.
    return EMPTY_JWKS_CACHE;
  }
}

/** Narrow the shared union deps to exactly the Cloudflare adapter's shape, supplying the boot-built
 *  (or injected) JWKS cache. Tailscale-only seams (`confirmPeer`/`runner`) are simply not read. */
function toCloudflareDeps(deps: RemoteTransportDeps): CloudflareAccessAdapterDeps {
  return {
    lookupProject: deps.lookupProject,
    jwksCache: buildBootJwksCache(deps),
    loadAccessState: deps.loadAccessState,
    loadMapping: deps.loadMapping,
    now: deps.now,
    env: deps.env,
    allowedAlgorithms: deps.allowedAlgorithms,
    clockToleranceSeconds: deps.clockToleranceSeconds,
  };
}

/**
 * Select the boot-time transport adapter named by `transportName` (the canonical token from
 * config.transport), or `null` to fail closed.
 *
 * `deps` carries every transport's injectable seams over the shared required `lookupProject`
 * ({@link RemoteTransportDeps}). Each recognised token builds exactly its adapter, reading only
 * the seams that adapter knows; the selection NEVER inspects or changes the bind host/port.
 *
 * FAIL CLOSED: any value other than a recognised token — `null`, `undefined`, an empty string,
 * an unknown token — returns `null` (no adapter ⇒ the FG-781 default refuses every request).
 */
export function selectRemoteAdapter(
  transportName: string | null | undefined,
  deps: RemoteTransportDeps,
): TransportAdapter | null {
  switch (transportName) {
    case TAILSCALE_TRANSPORT:
      return createTailscaleServeAdapter(deps);
    case CLOUDFLARE_TRANSPORT:
      return createCloudflareAccessAdapter(toCloudflareDeps(deps));
    default:
      // Absent / unknown / empty token → no adapter. The single fail-closed default.
      return null;
  }
}
