// FG-781 (step 1): transport-neutral verified-identity + capability interface for
// the Remote Board, with a default fail-closed resolver.
//
// THREAT MODEL. The Remote Board turns a trusted loopback-only surface into one that
// is reachable — via a later trusted local proxy (Tailscale Serve, FG-782; Cloudflare
// Tunnel+Access, FG-784) — from off the host. The dominant identity risks are:
//   (1) fail-OPEN: a missing/unwired transport adapter being mistaken for "everyone is
//       allowed" instead of "nobody is";
//   (2) header spoofing: attacker-supplied X-Forwarded-* / Tailscale-User-Login /
//       Cf-Access-* headers arriving directly at the loopback endpoint and being
//       mistaken for a proxy's verified assertion;
//   (3) scope confusion: an identity with an absent or ambiguous project grant being
//       resolved to more than the one project it was actually granted.
//
// This module answers all three STRUCTURALLY, before any adapter exists:
//   * Identity is produced ONLY by a TransportAdapter that verifies out-of-band. FG-781
//     ships NO adapter, so `resolveRemoteIdentity` called without one refuses every
//     request — default-deny (risk 1).
//   * The resolver reads inbound header NAMES only to record which identity-bearing ones
//     it DISCARDED (`ignoredIdentityHeaders`); it never reads a header VALUE to establish
//     identity, and adapters are contractually forbidden from doing so either (risk 2).
//   * A candidate identity is refused unless it carries EXACTLY ONE server-authoritative
//     project grant with a non-empty member-dir set (risk 3).
//
// Designed for additive evolution: FG-782/FG-784 supply a TransportAdapter; FG-783 adds a
// "mutate" member to the capability vocabulary. Neither is a rewrite of this contract.

/**
 * The closed capability vocabulary for the remote surface. FG-781 grants exactly one
 * capability — read — and there is deliberately NO mutation member: the remote surface is
 * read-only, and that is enforced at the type level (nothing can name a mutate capability)
 * as well as at runtime (see {@link isRemoteCapability}). FG-783 will ADD a member here.
 */
export const REMOTE_CAPABILITIES = ["read"] as const;

/** A capability the remote surface understands. Today: only `"read"`. */
export type RemoteCapability = (typeof REMOTE_CAPABILITIES)[number];

const REMOTE_CAPABILITY_SET: ReadonlySet<string> = new Set(REMOTE_CAPABILITIES);

/** Runtime guard: is `value` a member of the closed capability vocabulary? Guards the
 *  seam where an adapter (untyped at the boundary) could hand back an unknown capability
 *  string — e.g. a forged "mutate" — which must be refused rather than silently carried. */
export function isRemoteCapability(value: unknown): value is RemoteCapability {
  return typeof value === "string" && REMOTE_CAPABILITY_SET.has(value);
}

/**
 * The identity-bearing / proxy headers that MUST NEVER establish identity by themselves.
 * The resolver scans inbound requests for these NAMES so it can record that it saw and
 * DISCARDED them (making "ignored" an asserted action, not a silent omission). Values are
 * never read. Lower-cased to match Node's normalized header keys.
 */
export const IGNORED_IDENTITY_HEADERS = [
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-user",
  "x-forwarded-email",
  "tailscale-user-login",
  "tailscale-user-name",
  "cf-access-authenticated-user-email",
  "cf-access-authenticated-user-id",
  "cf-access-jwt-assertion",
  "cf-connecting-ip",
] as const;

const IGNORED_IDENTITY_HEADER_SET: ReadonlySet<string> = new Set(IGNORED_IDENTITY_HEADERS);

/**
 * How an identity was verified. Supplied by the adapter, for the audit trail. `adapter`
 * names the out-of-band channel that proved the principal (e.g. "tailscale-serve"); it is
 * NEVER a raw header source. `detail` is adapter-supplied context and must not carry
 * secrets.
 */
export interface TrustProvenance {
  readonly adapter: string;
  readonly detail?: string;
}

/**
 * The server-authoritative grant of what one identity may read: exactly ONE project, and
 * the resolved absolute member directories that constitute that project's OWN scope.
 *
 * `memberDirs` is set server-side from the project registry — NEVER from a client
 * projectKey/projectDir parameter — and is strictly the granted project's own dirs. It is
 * a deliberate, documented divergence from resolveProjectScope()'s FG-745
 * owner-convergence widening: the remote surface pins to the granted project alone.
 */
export interface RemoteProjectScopeGrant {
  readonly projectKey: string;
  readonly memberDirs: readonly string[];
}

/** A verified remote identity: the output of a successful resolution. */
export interface VerifiedIdentity {
  readonly subject: string;
  readonly capabilities: readonly RemoteCapability[];
  readonly projectScope: RemoteProjectScopeGrant;
  readonly provenance: TrustProvenance;
}

/** The connection-level facts about an inbound request: the peer socket's address/port as
 *  observed by the origin, NOT a header. An adapter (FG-782 Tailscale) may anchor an
 *  out-of-band whois confirmation on this connection fact; unlike a header VALUE it is not
 *  attacker-settable from the request body. Optional and absent-safe: FG-781 callers and any
 *  resolver path tolerate its absence, and its presence never by itself establishes identity. */
export interface RemoteRequestPeer {
  readonly address?: string;
  readonly port?: number;
}

/** The inbound request as seen by the resolver. Header values are attacker-controlled and
 *  are NEVER read to establish identity — only header names are scanned, to record what was
 *  ignored. Kept intentionally minimal so no accidental identity source leaks in. The
 *  optional `peer` is a connection fact (socket address/port), not a header, added additively
 *  for FG-782 so an adapter can anchor its out-of-band verification on the connection. */
export interface RemoteRequestContext {
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly peer?: RemoteRequestPeer;
}

/**
 * A candidate identity as returned by a TransportAdapter, BEFORE validation. The
 * capability list is `readonly string[]` (not `RemoteCapability[]`) precisely because the
 * adapter is an untyped trust boundary: the resolver validates every member against the
 * closed vocabulary and refuses the whole identity if any is unknown. `projectScope` is
 * loose (single / array / null) so absent and ambiguous grants can be DETECTED and refused
 * rather than being unrepresentable.
 */
export interface AdapterCandidateIdentity {
  readonly subject: string;
  readonly capabilities: readonly string[];
  readonly projectScope:
    | RemoteProjectScopeGrant
    | readonly RemoteProjectScopeGrant[]
    | null
    | undefined;
  readonly provenance: TrustProvenance;
  /**
   * Header NAMES (lower-cased) the adapter READ and CONFIRMED against its own out-of-band
   * channel — e.g. the Serve-set `X-Forwarded-For` it whois-confirmed and the
   * `Tailscale-User-Login` it required to equal that whois result. The resolver moves these
   * OUT of `ignoredIdentityHeaders` and records them as `confirmedIdentityHeaders`, so the
   * audit trail says truthfully that they were verified inputs — not silently discarded.
   *
   * This does NOT relax the contract: a confirmed header is one whose VALUE was cross-checked
   * against a trusted out-of-band assertion (whois), never one trusted on its face. An adapter
   * that reads no header value (FG-781's absent adapter, a header-blind adapter) leaves this
   * empty and every present identity header stays recorded as ignored, exactly as before.
   */
  readonly confirmedIdentityHeaders?: readonly string[];
}

/**
 * A transport adapter verifies a request through its OWN trusted out-of-band channel and
 * returns a candidate identity, or `null` to fail closed. FG-781 ships no implementation;
 * FG-782 (Tailscale) and FG-784 (Cloudflare Access) add them.
 *
 * CONTRACT: implementations MUST NOT derive identity from the raw inbound headers in
 * {@link RemoteRequestContext}. Those are attacker-controlled at a loopback endpoint. A
 * proxy adapter reads the proxy's verified assertion from its own authenticated channel,
 * not from a header a direct caller can also set.
 *
 * `verifyIdentity` MAY be asynchronous: a real adapter (FG-782 Tailscale) confirms the
 * connection peer out-of-band against a local daemon (`tailscale whois`) before it can name
 * a principal, which is inherently async. The resolver awaits the return uniformly, so a
 * synchronous adapter (returning a plain value) and an async one (returning a Promise) flow
 * through the SAME single resolution path — there is no parallel sync branch that could
 * bypass validation and fail open.
 */
export interface TransportAdapter {
  readonly kind: string;
  verifyIdentity(
    request: RemoteRequestContext,
  ): AdapterCandidateIdentity | null | Promise<AdapterCandidateIdentity | null>;
}

/** Why a resolution refused. Every value denies all project data (fail closed). */
export type RemoteIdentityRefusalReason =
  | "no-adapter" // no transport adapter wired (FG-781 default) — nobody is authorized
  | "no-identity" // adapter declined to verify this request
  | "scope-absent" // candidate carried no usable project grant
  | "scope-ambiguous" // candidate named more than one project grant
  | "capability-invalid"; // candidate carried an empty or unknown capability set

export interface RemoteIdentityRefusal {
  readonly ok: false;
  readonly reason: RemoteIdentityRefusalReason;
  /** Identity-bearing headers that were present on the request and DISCARDED. */
  readonly ignoredIdentityHeaders: readonly string[];
}

export interface RemoteIdentityGrant {
  readonly ok: true;
  readonly identity: VerifiedIdentity;
  /** Identity-bearing headers that were present on the request and DISCARDED — recorded
   *  even on success to prove the verified identity did not come from them. */
  readonly ignoredIdentityHeaders: readonly string[];
  /** Identity-bearing headers the adapter READ and CONFIRMED against its out-of-band channel
   *  (e.g. an `X-Forwarded-For` whois-confirmed and a `Tailscale-User-Login` matched against
   *  that whois). Recorded separately from `ignoredIdentityHeaders` so the audit trail is
   *  truthful: these values WERE consulted, and only after they survived out-of-band
   *  confirmation. Empty for a header-blind adapter (nothing was confirmed). */
  readonly confirmedIdentityHeaders: readonly string[];
}

/** The result of resolving a remote request to an identity. Fail-closed by construction:
 *  a caller must narrow on `ok` before it can reach any identity or project scope. */
export type RemoteIdentityResolution = RemoteIdentityRefusal | RemoteIdentityGrant;

/** Header NAMES (lower-cased) present on the request that the resolver actively discards.
 *  Reads names only — never a value. */
function presentIgnoredHeaders(
  headers: Readonly<Record<string, unknown>> | undefined,
): string[] {
  if (!headers) return [];
  const present: string[] = [];
  for (const key of Object.keys(headers)) {
    const lower = key.toLowerCase();
    if (IGNORED_IDENTITY_HEADER_SET.has(lower)) present.push(lower);
  }
  return present;
}

/** Collapse a candidate's loose project-scope field to exactly one grant, or a refusal
 *  reason. Absent (null/empty) and ambiguous (>1) both fail closed. */
function normalizeGrant(
  scope: AdapterCandidateIdentity["projectScope"],
): { grant: RemoteProjectScopeGrant } | { reason: RemoteIdentityRefusalReason } {
  if (scope == null) return { reason: "scope-absent" };
  const grants: readonly RemoteProjectScopeGrant[] = Array.isArray(scope)
    ? scope
    : [scope as RemoteProjectScopeGrant];
  if (grants.length === 0) return { reason: "scope-absent" };
  if (grants.length > 1) return { reason: "scope-ambiguous" };
  const grant = grants[0]!;
  if (typeof grant.projectKey !== "string" || grant.projectKey.trim() === "") {
    return { reason: "scope-absent" };
  }
  if (!Array.isArray(grant.memberDirs) || grant.memberDirs.length === 0) {
    return { reason: "scope-absent" };
  }
  return { grant };
}

/** Validate an adapter's candidate into a verified identity, or refuse. Every check is
 *  fail-closed: a candidate passes only if it carries a valid capability set AND exactly
 *  one non-empty project grant. Exported so adapters (FG-782/FG-784) and their tests can
 *  reuse the one validation path rather than re-implementing it. */
export function validateAdapterIdentity(
  candidate: AdapterCandidateIdentity,
  ignoredIdentityHeaders: readonly string[] = [],
): RemoteIdentityResolution {
  const caps = candidate.capabilities ?? [];
  // Empty grants nothing; any unknown member (e.g. a forged "mutate") taints the whole
  // identity. Read is the only capability that can survive this in FG-781.
  if (caps.length === 0 || !caps.every(isRemoteCapability)) {
    return { ok: false, reason: "capability-invalid", ignoredIdentityHeaders };
  }
  const normalized = normalizeGrant(candidate.projectScope);
  if ("reason" in normalized) {
    return { ok: false, reason: normalized.reason, ignoredIdentityHeaders };
  }
  const identity: VerifiedIdentity = {
    subject: candidate.subject,
    // caps is proven all-valid above; freeze the narrowed vocabulary onto the identity.
    capabilities: caps.filter(isRemoteCapability),
    projectScope: normalized.grant,
    provenance: candidate.provenance,
  };
  // A header the adapter CONFIRMED out-of-band is no longer "ignored": move it from the ignored
  // set into the confirmed set so the audit trail records how identity was actually established.
  const confirmedIdentityHeaders = candidate.confirmedIdentityHeaders ?? [];
  const ignored = ignoredIdentityHeaders.filter((h) => !confirmedIdentityHeaders.includes(h));
  return { ok: true, identity, ignoredIdentityHeaders: ignored, confirmedIdentityHeaders };
}

/**
 * Resolve a remote request to a verified identity, or refuse (fail closed).
 *
 * FG-781 ships no transport adapter, so the common call — `resolveRemoteIdentity(request)`
 * with no adapter — ALWAYS refuses with `"no-adapter"`, regardless of any headers the
 * request carries. The `adapter` parameter is the seam FG-782/FG-784 wire at boot; it is
 * never taken from the request.
 *
 * Whatever the outcome, the resolver records which identity-bearing headers it saw and
 * discarded, so callers and tests can prove no identity was ever derived from them.
 *
 * The resolution is uniformly async: the (possibly synchronous) adapter return is awaited on
 * ONE path, so there is never a parallel sync branch that could skip validation. The
 * `no-adapter` refusal is still reached through this same awaited path.
 */
export async function resolveRemoteIdentity(
  request: RemoteRequestContext,
  adapter?: TransportAdapter | null,
): Promise<RemoteIdentityResolution> {
  const ignoredIdentityHeaders = presentIgnoredHeaders(request.headers);
  if (!adapter) {
    return { ok: false, reason: "no-adapter", ignoredIdentityHeaders };
  }
  // `await` accepts both a plain value and a Promise, collapsing sync and async adapters
  // onto one resolution path — the fail-closed default cannot be sidestepped.
  const candidate = await adapter.verifyIdentity(request);
  if (!candidate) {
    return { ok: false, reason: "no-identity", ignoredIdentityHeaders };
  }
  return validateAdapterIdentity(candidate, ignoredIdentityHeaders);
}

/** A boot-bound resolver: capture the (possibly absent) adapter once, at server start, and
 *  hand the rest of the server a resolution function. FG-781 constructs this with no adapter;
 *  FG-782/FG-784 pass theirs. Keeping the binding here means the wiring lands as one argument,
 *  not a rewrite. Async, mirroring {@link resolveRemoteIdentity}: the server awaits it, so a
 *  rejected/refused resolution lands in the server's fail-closed path, never an open one. */
export type BoundRemoteIdentityResolver = (
  request: RemoteRequestContext,
) => Promise<RemoteIdentityResolution>;

export function createRemoteIdentityResolver(
  adapter?: TransportAdapter | null,
): BoundRemoteIdentityResolver {
  return (request) => resolveRemoteIdentity(request, adapter);
}

/** Does a verified identity hold `capability`? The single read-check callers use so the
 *  capability test lives in one place as the vocabulary grows (FG-783). */
export function hasCapability(
  identity: VerifiedIdentity,
  capability: RemoteCapability,
): boolean {
  return identity.capabilities.includes(capability);
}
