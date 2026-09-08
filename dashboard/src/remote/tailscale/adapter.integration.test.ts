// FG-782 (step 6) INTEGRATION tier — drives the Tailscale Serve adapter end-to-end against a
// REAL fake `tailscale` executable (through the production runner + `whois`) AND a REAL operator
// mapping file under an injected FORGE_HOME (through the production `loadIdentityMapping`). No
// real tailnet, no real DB: the fake binary is a bash script and the mapping is a temp .yml, so
// the whole trust path — daemon whois → operator authorization → server-authoritative scope —
// is exercised with only the project lookup stubbed.
//
// Acceptance coverage:
//   * AC3 positive: a whois-confirmed, mapped identity flows through validateAdapterIdentity to a
//     SINGLE read grant for ONLY its project, and nothing else;
//   * AC3 negative: when the fake daemon is down, no peer can be confirmed → null (no data);
//   * AC4: DELETING the identity's line from the live mapping file is honored on the next verify
//     — no restart, no cache — the adapter re-reads per call.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTailscaleServeAdapter, type AdapterProjectView } from "./adapter.js";
import { createTailscaleRunner, whois } from "./cli.js";
import { loadIdentityMapping, IDENTITY_MAPPING_FILENAME } from "../mapping.js";
import { validateAdapterIdentity } from "../identity.js";

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** Write a fake `tailscale` executable that confirms one tailnet peer via `whois --json`, or
 *  exits non-zero (daemon down) when FAKE_TS_DOWN=1. Mirrors cli.integration.test.ts. */
function fakeTailscale(): string {
  const dir = mkdtempSync(join(tmpdir(), "fg782-adapter-ts-"));
  dirs.push(dir);
  const bin = join(dir, "tailscale");
  const whoisJson = JSON.stringify({
    Node: { Name: "steve-mbp.tail1234.ts.net." },
    UserProfile: { LoginName: "steve@example.com" },
  });
  const script = `#!/usr/bin/env bash
if [ "\${FAKE_TS_DOWN:-0}" = "1" ]; then
  echo "failed to connect to local tailscaled; is the tailscale daemon running?" 1>&2
  exit 1
fi
if [ "$1" = "whois" ]; then
  cat <<'EOF'
${whoisJson}
EOF
  exit 0
fi
echo "unexpected args: $*" 1>&2
exit 2
`;
  writeFileSync(bin, script, { mode: 0o755 });
  return bin;
}

/** A temp FORGE_HOME with the operator mapping file written to `body`. */
function tempMapping(body: string): { env: NodeJS.ProcessEnv; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "fg782-adapter-map-"));
  dirs.push(dir);
  const path = join(dir, IDENTITY_MAPPING_FILENAME);
  writeFileSync(path, body, "utf8");
  return { env: { FORGE_HOME: dir } as NodeJS.ProcessEnv, path };
}

function lookupProject(key: string): AdapterProjectView | undefined {
  if (key === "repo-alpha") return { key: "repo-alpha", projectDirs: ["/work/alpha"] };
  return undefined;
}

const MAPPING_BODY = `version: 1
identities:
  - login: steve@example.com
    project: repo-alpha
    capabilities: [read]
`;

const REQUEST = {
  headers: { "tailscale-user-login": "attacker@evil.example" }, // forged; must be ignored
  peer: { address: "100.101.102.103", port: 40000 },
};

test("end-to-end: fake-daemon whois-confirmed + mapped identity → a single read grant for ONLY its project (AC3)", async () => {
  const runner = createTailscaleRunner(fakeTailscale());
  const { env } = tempMapping(MAPPING_BODY);
  const adapter = createTailscaleServeAdapter({
    lookupProject,
    runner,
    loadMapping: () => loadIdentityMapping(env),
  });

  const candidate = await adapter.verifyIdentity(REQUEST);
  assert.ok(candidate, "the confirmed + mapped peer yields a candidate");
  // Identity is the whois login, NOT the forged header value.
  assert.equal(candidate.subject, "steve@example.com");

  // And it passes the existing validation path to a single read grant, nothing else.
  const resolution = validateAdapterIdentity(candidate);
  assert.equal(resolution.ok, true);
  if (resolution.ok) {
    assert.equal(resolution.identity.projectScope.projectKey, "repo-alpha");
    assert.deepEqual([...resolution.identity.projectScope.memberDirs], ["/work/alpha"]);
    assert.deepEqual([...resolution.identity.capabilities], ["read"]);
  }
});

test("end-to-end: when the fake daemon is DOWN no peer can be confirmed → null, no data (AC3)", async () => {
  const bin = fakeTailscale();
  const { env } = tempMapping(MAPPING_BODY);
  const prev = process.env.FAKE_TS_DOWN;
  process.env.FAKE_TS_DOWN = "1";
  try {
    const adapter = createTailscaleServeAdapter({
      lookupProject,
      runner: createTailscaleRunner(bin),
      loadMapping: () => loadIdentityMapping(env),
    });
    assert.equal(await adapter.verifyIdentity(REQUEST), null);
    // Sanity: the same runner confirms nothing directly either.
    assert.equal(whois("100.101.102.103", createTailscaleRunner(bin)), null);
  } finally {
    if (prev === undefined) delete process.env.FAKE_TS_DOWN;
    else process.env.FAKE_TS_DOWN = prev;
  }
});

test("live revocation: DELETING the identity's line from the mapping file denies on the next verify — no restart (AC4)", async () => {
  const runner = createTailscaleRunner(fakeTailscale());
  const { env, path } = tempMapping(MAPPING_BODY);
  const adapter = createTailscaleServeAdapter({
    lookupProject,
    runner,
    loadMapping: () => loadIdentityMapping(env),
  });

  // Before revocation: authorized.
  assert.ok(await adapter.verifyIdentity(REQUEST), "authorized before revocation");

  // Operator revokes by emptying the identities list (a real edit to the live file).
  writeFileSync(path, "version: 1\nidentities: []\n", "utf8");

  // The very next verify re-reads the file and denies — no process restart.
  assert.equal(await adapter.verifyIdentity(REQUEST), null, "revoked on the next request");
});
