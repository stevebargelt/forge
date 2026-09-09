// FG-782 (step 4) — unit tier. Proves the operator identity→authorization mapping is
// fail-closed by construction. No filesystem, no spawned process, no real DB: every case is a
// pure call to buildIdentityMapping (parsed value in) or parseIdentityMapping (YAML text in).
// The reload-honors-a-live-edit behavior — which needs a real file — lives in
// mapping.integration.test.ts.
//
// Acceptance coverage (FG-782 AC3/AC4 — the AUTHORIZATION half):
//   * a login maps to ONLY its authorized projectKey + the read capability;
//   * an unknown capability (forged `mutate`/`write`) taints and DROPS that entry;
//   * an unmapped login yields NO grant;
//   * a missing project, blank login, non-object entry, wrong version, or non-object top level
//     all fail closed (drop the entry, or reject the whole file — never a widened grant);
//   * a login declared twice is POISONED (no grant), so conflicting lines cannot merge.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  buildIdentityMapping,
  parseIdentityMapping,
  EMPTY_IDENTITY_MAPPING,
  IDENTITY_MAPPING_VERSION,
  type IdentityMapping,
} from "./mapping.js";
import { REMOTE_CAPABILITIES } from "./identity.js";

/** A well-formed single-identity document (parsed shape). */
function oneIdentity(): unknown {
  return {
    version: IDENTITY_MAPPING_VERSION,
    identities: [{ login: "alice@example.ts.net", project: "repo-alpha", capabilities: ["read"] }],
  };
}

describe("buildIdentityMapping — the happy path grants exactly one project, read-only", () => {
  test("a mapped login resolves to ONLY its authorized projectKey + read", () => {
    const m = buildIdentityMapping(oneIdentity());
    const grant = m.lookup("alice@example.ts.net");
    assert.ok(grant, "alice is granted");
    assert.equal(grant.projectKey, "repo-alpha");
    assert.deepEqual([...grant.capabilities], ["read"]);
    assert.equal(m.size, 1);
  });

  test("the only capabilities a grant can carry are the closed vocabulary (read, plan)", () => {
    assert.deepEqual([...REMOTE_CAPABILITIES], ["read", "plan"], "guard: closed vocabulary");
    const grant = buildIdentityMapping(oneIdentity()).lookup("alice@example.ts.net");
    assert.ok(grant);
    for (const cap of grant.capabilities) assert.ok(REMOTE_CAPABILITIES.includes(cap));
  });

  test("lookup normalizes case/whitespace the same way the file does — no lockout, no widening", () => {
    const m = buildIdentityMapping(oneIdentity());
    assert.ok(m.lookup("  ALICE@EXAMPLE.TS.NET  "), "a stray-case/space lookup still resolves");
    assert.equal(m.lookup("alice@example.ts.net")?.projectKey, "repo-alpha");
  });
});

describe("buildIdentityMapping — the 'plan' capability grants purely through the vocabulary (FG-783)", () => {
  test("an entry granting [plan] validates and is looked up — no new mechanism", () => {
    const m = buildIdentityMapping({
      identities: [{ login: "pat@example.ts.net", project: "repo-alpha", capabilities: ["plan"] }],
    });
    const grant = m.lookup("pat@example.ts.net");
    assert.ok(grant, "a plan-only grant validates");
    assert.equal(grant.projectKey, "repo-alpha");
    assert.deepEqual([...grant.capabilities], ["plan"]);
    // A plan grant does NOT silently carry read — the entry holds only what it named.
    assert.equal(grant.capabilities.includes("read" as never), false);
  });

  test("an entry granting [read, plan] validates and carries both, in order", () => {
    const m = buildIdentityMapping({
      identities: [
        { login: "quinn@example.ts.net", project: "repo-alpha", capabilities: ["read", "plan"] },
      ],
    });
    const grant = m.lookup("quinn@example.ts.net");
    assert.ok(grant);
    assert.deepEqual([...grant.capabilities], ["read", "plan"]);
  });

  test("a read-only entry does NOT gain plan — additive-capability invariant at the mapping layer", () => {
    const grant = buildIdentityMapping(oneIdentity()).lookup("alice@example.ts.net");
    assert.ok(grant);
    assert.deepEqual([...grant.capabilities], ["read"]);
    assert.equal(grant.capabilities.includes("plan" as never), false);
  });

  test("plan alongside a forged capability still taints and drops the WHOLE entry", () => {
    const m = buildIdentityMapping({
      identities: [
        { login: "eve@example.ts.net", project: "repo-alpha", capabilities: ["plan", "mutate"] },
      ],
    });
    assert.equal(m.lookup("eve@example.ts.net"), null, "plan+mutate → dropped, no plan grant survives");
    assert.equal(m.size, 0);
  });

  test("a duplicate login is still poisoned even when granting plan", () => {
    const m = buildIdentityMapping({
      identities: [
        { login: "dup@example.ts.net", project: "repo-alpha", capabilities: ["plan"] },
        { login: "dup@example.ts.net", project: "repo-bravo", capabilities: ["read", "plan"] },
      ],
    });
    assert.equal(m.lookup("dup@example.ts.net"), null, "ambiguous duplicate resolves to nothing");
    assert.equal(m.size, 0);
  });
});

describe("buildIdentityMapping — an UNMAPPED login yields no grant (AC3)", () => {
  test("a login not in the file gets null, never a default project", () => {
    const m = buildIdentityMapping(oneIdentity());
    assert.equal(m.lookup("mallory@evil.example"), null);
  });

  test("the empty document maps nobody", () => {
    assert.equal(buildIdentityMapping({ identities: [] }).size, 0);
    assert.equal(buildIdentityMapping({ identities: [] }).lookup("alice@example.ts.net"), null);
  });
});

describe("buildIdentityMapping — a tainted entry is DROPPED, never widened", () => {
  test("an unknown capability (forged mutate) taints and drops the whole entry", () => {
    const m = buildIdentityMapping({
      identities: [{ login: "eve@example.ts.net", project: "repo-alpha", capabilities: ["read", "mutate"] }],
    });
    assert.equal(m.lookup("eve@example.ts.net"), null, "read+mutate → dropped, no read grant survives");
    assert.equal(m.size, 0);
  });

  test("a write/admin capability alone is refused too", () => {
    const m = buildIdentityMapping({
      identities: [{ login: "eve@example.ts.net", project: "repo-alpha", capabilities: ["write"] }],
    });
    assert.equal(m.lookup("eve@example.ts.net"), null);
  });

  test("an empty capability list grants nothing", () => {
    const m = buildIdentityMapping({
      identities: [{ login: "eve@example.ts.net", project: "repo-alpha", capabilities: [] }],
    });
    assert.equal(m.lookup("eve@example.ts.net"), null);
  });

  test("a missing project drops the entry", () => {
    const m = buildIdentityMapping({
      identities: [{ login: "eve@example.ts.net", capabilities: ["read"] }],
    });
    assert.equal(m.lookup("eve@example.ts.net"), null);
  });

  test("a blank/absent login or a non-object entry is dropped, leaving valid siblings intact", () => {
    const m = buildIdentityMapping({
      identities: [
        { login: "   ", project: "repo-alpha", capabilities: ["read"] },
        "not-an-object",
        null,
        { project: "repo-alpha", capabilities: ["read"] },
        { login: "carol@example.ts.net", project: "repo-carol", capabilities: ["read"] },
      ],
    });
    assert.equal(m.size, 1, "only the one valid entry survives");
    assert.equal(m.lookup("carol@example.ts.net")?.projectKey, "repo-carol");
  });
});

describe("buildIdentityMapping — a duplicate login is POISONED (fail closed)", () => {
  test("two lines for one login → NO grant, even if each alone is valid", () => {
    const m = buildIdentityMapping({
      identities: [
        { login: "dan@example.ts.net", project: "repo-alpha", capabilities: ["read"] },
        { login: "DAN@example.ts.net", project: "repo-bravo", capabilities: ["read"] },
      ],
    });
    assert.equal(m.lookup("dan@example.ts.net"), null, "ambiguous duplicate resolves to nothing");
    assert.equal(m.size, 0);
  });

  test("a poisoned duplicate does not taint an unrelated valid login", () => {
    const m = buildIdentityMapping({
      identities: [
        { login: "dan@example.ts.net", project: "repo-alpha", capabilities: ["read"] },
        { login: "dan@example.ts.net", project: "repo-bravo", capabilities: ["read"] },
        { login: "erin@example.ts.net", project: "repo-erin", capabilities: ["read"] },
      ],
    });
    assert.equal(m.lookup("dan@example.ts.net"), null);
    assert.equal(m.lookup("erin@example.ts.net")?.projectKey, "repo-erin");
  });
});

describe("buildIdentityMapping — a malformed document rejects WHOLE, fail closed", () => {
  test("a non-object / array / null top level → the empty mapping", () => {
    for (const bad of [null, undefined, 42, "string", [], [{ login: "a", project: "p", capabilities: ["read"] }]]) {
      assert.equal(buildIdentityMapping(bad as unknown).size, 0);
    }
  });

  test("identities missing or not an array → the empty mapping", () => {
    assert.equal(buildIdentityMapping({}).size, 0);
    assert.equal(buildIdentityMapping({ identities: "nope" }).size, 0);
    assert.equal(buildIdentityMapping({ identities: { login: "a" } }).size, 0);
  });

  test("a version other than the known one rejects the whole file", () => {
    const m = buildIdentityMapping({
      version: IDENTITY_MAPPING_VERSION + 1,
      identities: [{ login: "alice@example.ts.net", project: "repo-alpha", capabilities: ["read"] }],
    });
    assert.equal(m.size, 0, "a forward-incompatible version is not read under today's semantics");
  });

  test("an absent version is treated as the current version", () => {
    const m = buildIdentityMapping({
      identities: [{ login: "alice@example.ts.net", project: "repo-alpha", capabilities: ["read"] }],
    });
    assert.equal(m.size, 1);
  });
});

describe("parseIdentityMapping — YAML text in, validated mapping out (still no fs)", () => {
  test("parses inspectable YAML into a single read grant", () => {
    const yaml = [
      "version: 1",
      "identities:",
      "  - login: alice@example.ts.net",
      "    project: repo-alpha",
      "    capabilities: [read]",
    ].join("\n");
    const m = parseIdentityMapping(yaml);
    assert.equal(m.lookup("alice@example.ts.net")?.projectKey, "repo-alpha");
  });

  test("JSON is valid YAML too — an operator may author either", () => {
    const json = JSON.stringify({
      identities: [{ login: "alice@example.ts.net", project: "repo-alpha", capabilities: ["read"] }],
    });
    assert.equal(parseIdentityMapping(json).lookup("alice@example.ts.net")?.projectKey, "repo-alpha");
  });

  test("a YAML SYNTAX error fails closed to the empty mapping — never throws into the request path", () => {
    const broken = "identities: [ this: is: not: valid: yaml";
    const m = parseIdentityMapping(broken);
    assert.equal(m.size, 0);
    assert.equal(m.lookup("alice@example.ts.net"), null);
  });

  test("an empty file parses to the empty mapping", () => {
    assert.equal(parseIdentityMapping("").size, 0);
    assert.equal(parseIdentityMapping("\n\n").size, 0);
  });

  test("a forged capability in YAML text is dropped just as in the built form", () => {
    const yaml = [
      "identities:",
      "  - login: eve@example.ts.net",
      "    project: repo-alpha",
      "    capabilities: [read, mutate]",
    ].join("\n");
    assert.equal(parseIdentityMapping(yaml).lookup("eve@example.ts.net"), null);
  });
});

test("EMPTY_IDENTITY_MAPPING grants nobody and is the shared fail-closed value", () => {
  const empty: IdentityMapping = EMPTY_IDENTITY_MAPPING;
  assert.equal(empty.size, 0);
  assert.equal(empty.lookup("anyone@example.ts.net"), null);
});
