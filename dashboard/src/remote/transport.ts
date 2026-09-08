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
  type TailscaleServeAdapterDeps,
} from "./tailscale/adapter.js";

/** The canonical Tailscale Serve transport token — the value config.resolveRemoteTransport
 *  yields for `FORGE_DASHBOARD_REMOTE_TRANSPORT=tailscale`. Kept here as the registry's own
 *  copy of the token so the switch below matches the resolved config value exactly. */
export const TAILSCALE_TRANSPORT = "tailscale";

/**
 * Select the boot-time transport adapter named by `transportName` (the canonical token from
 * config.transport), or `null` to fail closed.
 *
 * `deps` carries the adapter's injectable seams — the required `lookupProject` plus the
 * optional daemon (`confirmPeer`/`runner`) and mapping (`loadMapping`) overrides. Production
 * passes only `lookupProject` (+ `env`) so the Tailscale adapter defaults to the real local
 * tailscaled and the on-disk operator mapping; tests inject a fake daemon and mapping through
 * the SAME path, so the wiring under test is the real one.
 *
 * FAIL CLOSED: any value other than a recognised token — `null`, `undefined`, an empty string,
 * an unknown token — returns `null` (no adapter ⇒ the FG-781 default refuses every request).
 * This selection NEVER inspects or changes the bind host/port.
 */
export function selectRemoteAdapter(
  transportName: string | null | undefined,
  deps: TailscaleServeAdapterDeps,
): TransportAdapter | null {
  switch (transportName) {
    case TAILSCALE_TRANSPORT:
      return createTailscaleServeAdapter(deps);
    default:
      // Absent / unknown / empty token → no adapter. The single fail-closed default.
      return null;
  }
}
