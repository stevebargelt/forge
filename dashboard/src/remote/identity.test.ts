// FG-781 (step 1) — unit tier. Proves the transport-neutral identity resolver is fail-closed
// by construction. No spawned process, no real DB: everything here is a pure function call
// with in-test fake adapters.
//
// Acceptance coverage (FG-781):
//   (a) AC2 basis — with no adapter wired, resolveRemoteIdentity() yields NO identity.
//   (b) AC6 basis — spoofed X-Forwarded-* / Tailscale / Cf-Access headers still yield no
//       identity, and are ASSERTED as actively discarded (ignoredIdentityHeaders), not
//       merely unused; and a verified identity never derives from a header value.
//   (c) the capability set is read-only — it contains exactly one read capability, cannot
//       express a mutation capability (type level), and a forged "mutate" is refused at
//       runtime.
//   (d) an identity whose project-scope grant is absent or ambiguous is refused.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  resolveRemoteIdentity,
  createRemoteIdentityResolver,
  validateAdapterIdentity,
  isRemoteCapability,
  hasCapability,
  REMOTE_CAPABILITIES,
  IGNORED_IDENTITY_HEADERS,
  type TransportAdapter,
  type AdapterCandidateIdentity,
  type RemoteCapability,
  type RemoteProjectScopeGrant,
} from "./identity.js";

const goodGrant: RemoteProjectScopeGrant = {
  projectKey: "proj-a",
  memberDirs: ["/home/op/proj-a"],
};

const goodProvenance = { adapter: "test-adapter", detail: "verified principal" };

/** A fake adapter that returns whatever candidate it is constructed with. Pure — legal in
 *  the unit tier. Real adapters (FG-782/FG-784) verify out-of-band; here we only need to
 *  drive the resolver's validation and header-handling. */
function fakeAdapter(
  candidate: AdapterCandidateIdentity | null,
  kind = "fake",
): TransportAdapter {
  return { kind, verifyIdentity: () => candidate };
}

/** A fake adapter whose verifyIdentity returns a Promise — the FG-782 shape (an adapter that
 *  confirms the peer out-of-band before naming a principal). Used to prove a sync-returning
 *  and an async-returning adapter flow through the SAME single async resolution path. */
function asyncFakeAdapter(
  candidate: AdapterCandidateIdentity | null,
  kind = "fake-async",
): TransportAdapter {
  return { kind, verifyIdentity: async () => candidate };
}

const spoofedHeaders = {
  "X-Forwarded-For": "10.0.0.9",
  "X-Forwarded-User": "attacker@example.com",
  "Tailscale-User-Login": "attacker@ts.net",
  "Cf-Access-Authenticated-User-Email": "attacker@cf.example",
};

describe("FG-781 identity resolver — fail closed with no adapter (AC2)", () => {
  test("(a) resolveRemoteIdentity() with no adapter yields no identity", async () => {
    const result = await resolveRemoteIdentity({ headers: {} });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, "no-adapter");
    // A refusal exposes no identity field to narrow into — structurally no project data.
    assert.equal("identity" in result, false);
  });

  test("(a) the boot-bound resolver constructed with no adapter also refuses", async () => {
    const resolve = createRemoteIdentityResolver(); // FG-781: no adapter at boot
    const result = await resolve({ headers: {} });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, "no-adapter");
  });

  test("(a) an explicitly null adapter is treated as no adapter, not as trust", async () => {
    const result = await resolveRemoteIdentity({ headers: {} }, null);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, "no-adapter");
  });
});

describe("FG-781 identity resolver — raw headers never establish identity (AC6)", () => {
  test("(b) spoofed proxy/identity headers still yield no identity", async () => {
    const result = await resolveRemoteIdentity({ headers: spoofedHeaders });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, "no-adapter");
  });

  test("(b) the spoofed headers are ACTIVELY discarded, not merely unused", async () => {
    const result = await resolveRemoteIdentity({ headers: spoofedHeaders });
    // Each spoofed header is recorded (lower-cased) as ignored — an asserted action.
    assert.deepEqual(
      [...result.ignoredIdentityHeaders].sort(),
      [
        "cf-access-authenticated-user-email",
        "tailscale-user-login",
        "x-forwarded-for",
        "x-forwarded-user",
      ].sort(),
    );
  });

  test("(b) the exported ignore-list covers the FG-782/FG-784 header families", () => {
    for (const h of [
      "x-forwarded-for",
      "x-forwarded-user",
      "tailscale-user-login",
      "cf-access-authenticated-user-email",
      "cf-access-jwt-assertion",
    ]) {
      assert.ok(
        IGNORED_IDENTITY_HEADERS.includes(h as (typeof IGNORED_IDENTITY_HEADERS)[number]),
        `${h} must be in the actively-ignored identity-header set`,
      );
    }
  });

  test("(b) even a wired adapter's identity does not come from a header value", async () => {
    // The adapter returns a fixed principal REGARDLESS of the spoofed headers present.
    const adapter = fakeAdapter({
      subject: "verified-op", // NOT any spoofed header value
      capabilities: ["read"],
      projectScope: goodGrant,
      provenance: goodProvenance,
    });
    const result = await resolveRemoteIdentity({ headers: spoofedHeaders }, adapter);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.identity.subject, "verified-op");
      // Header values never leak into the identity.
      const asJson = JSON.stringify(result.identity);
      assert.equal(asJson.includes("attacker"), false);
      // The discarded headers are still recorded on the success path.
      assert.ok(result.ignoredIdentityHeaders.includes("tailscale-user-login"));
    }
  });
});

describe("FG-781 capability vocabulary — read only, no mutation (AC7 basis)", () => {
  test("(c) the capability set contains exactly one read capability", () => {
    assert.deepEqual([...REMOTE_CAPABILITIES], ["read"]);
    assert.equal(REMOTE_CAPABILITIES.includes("read"), true);
  });

  test("(c) no mutation capability can be expressed at the type level", () => {
    const read: RemoteCapability = "read";
    assert.equal(read, "read");
    // @ts-expect-error "mutate" is not a member of RemoteCapability — proven at typecheck.
    const mutate: RemoteCapability = "mutate";
    // Reference `mutate` so it is not an unused-var error masking the @ts-expect-error.
    assert.equal(typeof mutate, "string");
  });

  test("(c) a forged 'mutate' capability is refused at runtime", () => {
    assert.equal(isRemoteCapability("read"), true);
    assert.equal(isRemoteCapability("mutate"), false);
    const candidate: AdapterCandidateIdentity = {
      subject: "verified-op",
      // A malicious/buggy adapter tries to smuggle a mutate capability past the type gate.
      capabilities: ["read", "mutate"] as unknown as RemoteCapability[],
      projectScope: goodGrant,
      provenance: goodProvenance,
    };
    const result = validateAdapterIdentity(candidate);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, "capability-invalid");
  });

  test("(c) an empty capability set is refused (grants nothing)", () => {
    const result = validateAdapterIdentity({
      subject: "verified-op",
      capabilities: [],
      projectScope: goodGrant,
      provenance: goodProvenance,
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, "capability-invalid");
  });

  test("(c) a valid read identity holds only the read capability", () => {
    const result = validateAdapterIdentity({
      subject: "verified-op",
      capabilities: ["read"],
      projectScope: goodGrant,
      provenance: goodProvenance,
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual([...result.identity.capabilities], ["read"]);
      assert.equal(hasCapability(result.identity, "read"), true);
    }
  });
});

describe("FG-781 project-scope grant — absent or ambiguous fails closed (AC3 basis)", () => {
  const base = {
    subject: "verified-op",
    capabilities: ["read"] as const,
    provenance: goodProvenance,
  };

  test("(d) a null grant is refused (scope-absent)", () => {
    const result = validateAdapterIdentity({ ...base, projectScope: null });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, "scope-absent");
  });

  test("(d) an undefined grant is refused (scope-absent)", () => {
    const result = validateAdapterIdentity({ ...base, projectScope: undefined });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, "scope-absent");
  });

  test("(d) an empty-array grant is refused (scope-absent)", () => {
    const result = validateAdapterIdentity({ ...base, projectScope: [] });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, "scope-absent");
  });

  test("(d) a grant with no member dirs is refused (scope-absent)", () => {
    const result = validateAdapterIdentity({
      ...base,
      projectScope: { projectKey: "proj-a", memberDirs: [] },
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, "scope-absent");
  });

  test("(d) a grant with a blank project key is refused (scope-absent)", () => {
    const result = validateAdapterIdentity({
      ...base,
      projectScope: { projectKey: "   ", memberDirs: ["/home/op/proj-a"] },
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, "scope-absent");
  });

  test("(d) more than one grant is refused as ambiguous — never widened to both", () => {
    const result = validateAdapterIdentity({
      ...base,
      projectScope: [
        { projectKey: "proj-a", memberDirs: ["/home/op/proj-a"] },
        { projectKey: "proj-b", memberDirs: ["/home/op/proj-b"] },
      ],
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, "scope-ambiguous");
  });

  test("(d) exactly one well-formed grant resolves to that project alone", () => {
    const result = validateAdapterIdentity({
      ...base,
      projectScope: goodGrant,
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.identity.projectScope.projectKey, "proj-a");
      assert.deepEqual([...result.identity.projectScope.memberDirs], ["/home/op/proj-a"]);
    }
  });

  test("(d) an adapter that declines verification fails closed (no-identity)", async () => {
    const result = await resolveRemoteIdentity({ headers: {} }, fakeAdapter(null));
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, "no-identity");
  });
});

describe("FG-782 resolver seam — one async path, sync & async adapters converge", () => {
  const candidate: AdapterCandidateIdentity = {
    subject: "verified-op",
    capabilities: ["read"],
    projectScope: goodGrant,
    provenance: goodProvenance,
  };

  test("a sync-returning and a Promise-returning adapter reach the SAME validated result", async () => {
    const fromSync = await resolveRemoteIdentity({ headers: {} }, fakeAdapter(candidate));
    const fromAsync = await resolveRemoteIdentity(
      { headers: {} },
      asyncFakeAdapter(candidate),
    );
    assert.equal(fromSync.ok, true);
    assert.equal(fromAsync.ok, true);
    // Byte-for-byte identical resolution regardless of the adapter's sync/async shape:
    // there is no parallel sync branch that could bypass validation.
    assert.deepEqual(fromSync, fromAsync);
  });

  test("an async adapter that declines still fails closed (no-identity)", async () => {
    const result = await resolveRemoteIdentity({ headers: {} }, asyncFakeAdapter(null));
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, "no-identity");
  });

  test("no-adapter refusal is reached through the async path regardless of headers", async () => {
    // The absent-adapter default is still awaited on the one path — it cannot be sidestepped.
    const result = await resolveRemoteIdentity({ headers: spoofedHeaders });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, "no-adapter");
  });

  test("the boot-bound async resolver validates an async adapter's candidate", async () => {
    const resolve = createRemoteIdentityResolver(asyncFakeAdapter(candidate));
    const result = await resolve({ headers: {} });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.identity.projectScope.projectKey, "proj-a");
  });
});

describe("FG-782 request context — connection peer is optional and absent-safe", () => {
  const candidate: AdapterCandidateIdentity = {
    subject: "verified-op",
    capabilities: ["read"],
    projectScope: goodGrant,
    provenance: goodProvenance,
  };

  test("a request with no peer resolves exactly as before (absent-safe)", async () => {
    // FG-781 callers pass only { headers } — the resolver must not require a peer.
    const result = await resolveRemoteIdentity({ headers: {} }, fakeAdapter(candidate));
    assert.equal(result.ok, true);
  });

  test("no-adapter default still refuses even when a peer is present", async () => {
    // A connection fact alone never establishes identity: with no adapter, still refused.
    const result = await resolveRemoteIdentity({
      headers: spoofedHeaders,
      peer: { address: "100.64.0.7", port: 41234 },
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, "no-adapter");
  });

  test("an adapter may read the peer off the request context", async () => {
    // Prove the peer is threaded to the adapter (FG-782 anchors whois on it) without any
    // header value participating in identity. The adapter echoes the peer address it saw.
    let seenPeer: string | undefined;
    const peerAwareAdapter: TransportAdapter = {
      kind: "peer-aware",
      verifyIdentity: (request) => {
        seenPeer = request.peer?.address;
        return candidate;
      },
    };
    const result = await resolveRemoteIdentity(
      { headers: {}, peer: { address: "100.64.0.7", port: 41234 } },
      peerAwareAdapter,
    );
    assert.equal(result.ok, true);
    assert.equal(seenPeer, "100.64.0.7");
  });
});
