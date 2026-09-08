// FG-784 (step 3) UNIT tier — no spawned process, no network, only a temp FORGE_HOME on the real
// filesystem. Exercises the Forge-owned Cloudflare access-state store: round-trip with 0600 perms,
// fail-closed reads (missing / corrupt / foreign / version-mismatch / non-loopback-target -> null),
// non-loopback refused on write, and the surgical clear (removes the record AND the owned ingress
// file, and is idempotent) that AC4 disable relies on.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ACCESS_STATE_VERSION,
  resolveAccessStatePath,
  resolveOwnedIngressPath,
  validateAccessStateRecord,
  readAccessState,
  writeAccessState,
  writeOwnedIngressFile,
  clearAccessState,
  type AccessStateRecord,
} from "./access-state.js";

let forgeHome: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  forgeHome = mkdtempSync(join(tmpdir(), "forge-cf-state-"));
  env = { FORGE_HOME: forgeHome };
});

afterEach(() => {
  rmSync(forgeHome, { recursive: true, force: true });
});

/** A well-formed record whose target is loopback and whose owned ingress path is under the temp
 *  FORGE_HOME. Fields overridable so a test can craft a specific negative shape. */
function makeRecord(overrides: Partial<AccessStateRecord> = {}): AccessStateRecord {
  return {
    version: ACCESS_STATE_VERSION,
    publicHostname: "board.example.com",
    accessTeamDomain: "myteam.cloudflareaccess.com",
    accessAud: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    loopbackPort: 8025,
    target: "http://127.0.0.1:8025",
    url: "https://board.example.com",
    cloudflaredConfigPath: join(forgeHome, "remote-board-cloudflared.yml"),
    createdAt: "2026-09-08T00:00:00.000Z",
    ...overrides,
  };
}

// ── round-trip + perms ───────────────────────────────────────────────────────────────────
test("write then read round-trips the record", () => {
  const record = makeRecord();
  writeAccessState(record, env);
  const readBack = readAccessState(env);
  assert.deepEqual(readBack, record);
});

test("the state file is written owner-only (0600) and the dir is 0700", () => {
  writeAccessState(makeRecord(), env);
  const filePerms = statSync(resolveAccessStatePath(env)).mode & 0o777;
  assert.equal(filePerms, 0o600, "state file must be 0600");
  const dirPerms = statSync(forgeHome).mode & 0o777;
  // mkdtemp creates the dir at 0700 already; writeAccessState must not loosen it.
  assert.equal(dirPerms & 0o077, 0, "FORGE_HOME must not be group/other accessible");
});

test("write enforces 0600 even when the file pre-existed with looser perms", () => {
  const path = resolveAccessStatePath(env);
  writeFileSync(path, "stale", { mode: 0o644 });
  writeAccessState(makeRecord(), env);
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("the record carries the non-secret boot config the adapter reads (team + AUD)", () => {
  writeAccessState(makeRecord({ accessTeamDomain: "acme.cloudflareaccess.com", accessAud: "aud-tag-xyz" }), env);
  const readBack = readAccessState(env);
  assert.equal(readBack?.accessTeamDomain, "acme.cloudflareaccess.com");
  assert.equal(readBack?.accessAud, "aud-tag-xyz");
});

test("the persisted state file contains no secret material", () => {
  writeAccessState(makeRecord(), env);
  const text = readFileSync(resolveAccessStatePath(env), "utf8");
  // A blunt guard: the record must never hold a JWT, cookie, or API token.
  assert.ok(!/CF_Authorization|Cf-Access-Jwt|BEGIN [A-Z ]*PRIVATE KEY|api[_-]?token/i.test(text));
});

// ── fail-closed reads ────────────────────────────────────────────────────────────────────
test("a missing state file reads back as null", () => {
  assert.equal(readAccessState(env), null);
});

test("a corrupt (non-JSON) state file reads back as null", () => {
  writeFileSync(resolveAccessStatePath(env), "{not json", { mode: 0o600 });
  assert.equal(readAccessState(env), null);
});

test("a foreign JSON shape reads back as null", () => {
  writeFileSync(resolveAccessStatePath(env), JSON.stringify({ hello: "world" }), { mode: 0o600 });
  assert.equal(readAccessState(env), null);
});

test("a version mismatch reads back as null (fail closed, never acted on)", () => {
  const record = { ...makeRecord(), version: ACCESS_STATE_VERSION + 1 };
  writeFileSync(resolveAccessStatePath(env), JSON.stringify(record), { mode: 0o600 });
  assert.equal(readAccessState(env), null);
});

test("a non-loopback target reads back as null (defense in depth)", () => {
  const record = { ...makeRecord(), target: "http://10.0.0.5:8025", url: "https://board.example.com" };
  writeFileSync(resolveAccessStatePath(env), JSON.stringify(record), { mode: 0o600 });
  assert.equal(readAccessState(env), null);
});

test("a public (0.0.0.0) target reads back as null", () => {
  const record = { ...makeRecord(), target: "http://0.0.0.0:8025" };
  writeFileSync(resolveAccessStatePath(env), JSON.stringify(record), { mode: 0o600 });
  assert.equal(readAccessState(env), null);
});

test("a record missing team/AUD reads back as null (adapter must have no accept-any fallback)", () => {
  for (const field of ["accessTeamDomain", "accessAud", "publicHostname", "cloudflaredConfigPath"] as const) {
    const record: Record<string, unknown> = { ...makeRecord() };
    delete record[field];
    writeFileSync(resolveAccessStatePath(env), JSON.stringify(record), { mode: 0o600 });
    assert.equal(readAccessState(env), null, `missing ${field} must fail closed`);
  }
});

// ── write refuses invalid records ────────────────────────────────────────────────────────
test("write REFUSES a record with a non-loopback target", () => {
  assert.throws(
    () => writeAccessState(makeRecord({ target: "http://198.51.100.7:8025" }), env),
    /refusing to persist an invalid/,
  );
  assert.equal(existsSync(resolveAccessStatePath(env)), false, "nothing must be written on refusal");
});

test("write REFUSES a record missing the team domain", () => {
  const bad = { ...makeRecord(), accessTeamDomain: "" } as AccessStateRecord;
  assert.throws(() => writeAccessState(bad, env), /refusing to persist an invalid/);
});

test("validateAccessStateRecord rejects an empty AUD", () => {
  assert.equal(validateAccessStateRecord({ ...makeRecord(), accessAud: "  " }), null);
});

// ── owned ingress file lifecycle ─────────────────────────────────────────────────────────
test("writeOwnedIngressFile lays down the owned config 0600", () => {
  const path = resolveOwnedIngressPath(env);
  writeOwnedIngressFile(path, "ingress:\n  - service: http://127.0.0.1:8025\n");
  assert.ok(existsSync(path));
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("writeOwnedIngressFile refuses an empty path", () => {
  assert.throws(() => writeOwnedIngressFile("", "x"), /empty path/);
});

// ── surgical clear ───────────────────────────────────────────────────────────────────────
test("clear removes BOTH the record and the owned ingress file it recorded", () => {
  const ingressPath = resolveOwnedIngressPath(env);
  writeOwnedIngressFile(ingressPath, "ingress: []\n");
  writeAccessState(makeRecord({ cloudflaredConfigPath: ingressPath }), env);
  assert.ok(existsSync(resolveAccessStatePath(env)));
  assert.ok(existsSync(ingressPath));

  clearAccessState(env);

  assert.equal(existsSync(resolveAccessStatePath(env)), false, "record must be removed");
  assert.equal(existsSync(ingressPath), false, "owned ingress file must be removed");
});

test("clear is idempotent — a second clear (nothing to remove) is a no-op, not an error", () => {
  const ingressPath = resolveOwnedIngressPath(env);
  writeOwnedIngressFile(ingressPath, "ingress: []\n");
  writeAccessState(makeRecord({ cloudflaredConfigPath: ingressPath }), env);
  clearAccessState(env);
  // Second call: everything already gone.
  assert.doesNotThrow(() => clearAccessState(env));
});

test("clear with no state at all is a no-op (disable before setup)", () => {
  assert.doesNotThrow(() => clearAccessState(env));
});

test("clear does NOT follow the config path of a corrupt (untrusted) record", () => {
  // A bystander file that a corrupt record happens to name must NOT be deleted.
  const bystander = join(forgeHome, "operator-owned.yml");
  writeFileSync(bystander, "do not delete me\n", { mode: 0o600 });
  const corrupt = { ...makeRecord(), version: 999, cloudflaredConfigPath: bystander };
  writeFileSync(resolveAccessStatePath(env), JSON.stringify(corrupt), { mode: 0o600 });

  clearAccessState(env);

  assert.equal(existsSync(bystander), true, "an untrusted record must not steer deletion");
  // The record file itself is still removed (force), leaving nothing Forge acts on.
  assert.equal(existsSync(resolveAccessStatePath(env)), false);
});

test("resolveAccessStatePath reads FORGE_HOME at call time", () => {
  const other = mkdtempSync(join(tmpdir(), "forge-cf-other-"));
  try {
    assert.equal(resolveAccessStatePath({ FORGE_HOME: other }), join(other, "remote-board-cloudflare-state.json"));
  } finally {
    rmSync(other, { recursive: true, force: true });
  }
});

test("resolveOwnedIngressPath defaults under FORGE_HOME", () => {
  assert.equal(resolveOwnedIngressPath(env), join(forgeHome, "remote-board-cloudflared.yml"));
});
