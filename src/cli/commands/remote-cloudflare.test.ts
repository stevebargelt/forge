// FG-784 (step 6) UNIT tier — the PURE report/decision logic of `forge remote cloudflare`.
// No process, no listener, no real filesystem, NO network: every function under test is a pure
// function of its inputs (the certs probe is injected). The end-to-end drive of the real
// access-state store + a real temp FORGE_HOME lives in remote-cloudflare.integration.test.ts.
//
// SECURITY FOCUS. These tests are dominated by NEGATIVE paths — the misconfiguration that would
// expose a public, UNAUTHENTICATED service must be REFUSED (AC4): a public hostname with no
// Access team/AUD, a malformed AUD, an unreachable/undetermined JWKS endpoint, all refuse with a
// NAMED reason and zero state writes. --dry-run and an unconfirmed preview write NOTHING (AC1).
// disable removes ONLY the recorded owned config + record, never a blanket teardown (AC4/AC6).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildCloudflareDoctorReport,
  buildCertsUrl,
  buildIngressConfig,
  cloudflareBoundaryNotes,
  isMutatingCloudflaredCommand,
  isPlausibleHostname,
  isWellFormedAud,
  parseTunnelList,
  planCloudflareDisable,
  planCloudflareSetup,
  requiredCloudflareGrants,
  resolveCertsUrl,
  resolveCloudflareConfig,
  type AccessStateRecord,
  type CloudflareConfigInput,
  type CloudflareDoctorInput,
} from "./remote.js";

const AUD = "a".repeat(64); // a well-formed (64-hex) Access AUD tag
const GOOD_CONFIG: CloudflareConfigInput = {
  publicHostname: "board.example.com",
  accessTeamDomain: "acme.cloudflareaccess.com",
  accessAud: AUD,
  tunnelName: "forge-remote-board",
  credentialsFile: null,
  configPath: "/tmp/forge/remote-board-cloudflared.yml",
};

function healthyInput(overrides: Partial<CloudflareDoctorInput> = {}): CloudflareDoctorInput {
  return {
    cliPresent: true,
    config: GOOD_CONFIG,
    loopbackPort: 8025,
    transport: "cloudflare",
    mappingPath: "/tmp/forge/remote-board-identity.yml",
    jwksReachable: true,
    certsUrl: "https://acme.cloudflareaccess.com/cdn-cgi/access/certs",
    accessState: null,
    existingTunnels: [],
    ...overrides,
  };
}

// ---- validators -----------------------------------------------------------------------------

test("isPlausibleHostname: accepts real hostnames, rejects schemes/ports/paths/garbage", () => {
  assert.equal(isPlausibleHostname("board.example.com"), true);
  assert.equal(isPlausibleHostname("acme.cloudflareaccess.com"), true);
  assert.equal(isPlausibleHostname("a.b.c.d.example.io"), true);
  // Not bare hostnames — must be rejected before they reach a public tunnel.
  assert.equal(isPlausibleHostname("https://board.example.com"), false);
  assert.equal(isPlausibleHostname("board.example.com:443"), false);
  assert.equal(isPlausibleHostname("board.example.com/path"), false);
  assert.equal(isPlausibleHostname("localhost"), false); // single label
  assert.equal(isPlausibleHostname("has space.com"), false);
  assert.equal(isPlausibleHostname(""), false);
});

test("isWellFormedAud: only a 64-hex tag is well-formed", () => {
  assert.equal(isWellFormedAud(AUD), true);
  assert.equal(isWellFormedAud("A".repeat(64)), true); // case-insensitive hex
  assert.equal(isWellFormedAud("a".repeat(63)), false); // too short
  assert.equal(isWellFormedAud("a".repeat(65)), false); // too long
  assert.equal(isWellFormedAud("z".repeat(64)), false); // non-hex
  assert.equal(isWellFormedAud(""), false);
});

test("buildCertsUrl: derives the certs endpoint from a full or bare team domain", () => {
  assert.equal(buildCertsUrl("acme.cloudflareaccess.com"), "https://acme.cloudflareaccess.com/cdn-cgi/access/certs");
  assert.equal(buildCertsUrl("acme"), "https://acme.cloudflareaccess.com/cdn-cgi/access/certs");
  assert.equal(buildCertsUrl("acme.cloudflareaccess.com/"), "https://acme.cloudflareaccess.com/cdn-cgi/access/certs");
});

test("resolveCertsUrl: env override wins; else derived from a plausible team; else null", () => {
  assert.equal(
    resolveCertsUrl(GOOD_CONFIG, { FORGE_REMOTE_CLOUDFLARE_CERTS_URL: "http://127.0.0.1:9/certs" }),
    "http://127.0.0.1:9/certs",
  );
  assert.equal(resolveCertsUrl(GOOD_CONFIG, {}), "https://acme.cloudflareaccess.com/cdn-cgi/access/certs");
  assert.equal(resolveCertsUrl({ ...GOOD_CONFIG, accessTeamDomain: null }, {}), null);
  assert.equal(resolveCertsUrl({ ...GOOD_CONFIG, accessTeamDomain: "not a host" }, {}), null);
});

// ---- config resolution ----------------------------------------------------------------------

test("resolveCloudflareConfig: flags win over env; blanks fall through; owned path defaults under FORGE_HOME", () => {
  const cfg = resolveCloudflareConfig(
    { hostname: "board.example.com", aud: AUD },
    { FORGE_HOME: "/x/.forge", FORGE_REMOTE_CLOUDFLARE_TEAM: "acme.cloudflareaccess.com", FORGE_REMOTE_CLOUDFLARE_AUD: "ignored" },
  );
  assert.equal(cfg.publicHostname, "board.example.com");
  assert.equal(cfg.accessTeamDomain, "acme.cloudflareaccess.com"); // from env
  assert.equal(cfg.accessAud, AUD); // flag beats env
  assert.equal(cfg.configPath, "/x/.forge/remote-board-cloudflared.yml");
  // Blank/whitespace flags are treated as absent.
  const empty = resolveCloudflareConfig({ hostname: "   " }, {});
  assert.equal(empty.publicHostname, null);
});

// ---- command classification -----------------------------------------------------------------

test("isMutatingCloudflaredCommand: reads are read, everything else mutates (fail-safe)", () => {
  assert.equal(isMutatingCloudflaredCommand(["--version"]), false);
  assert.equal(isMutatingCloudflaredCommand(["tunnel", "list", "--output", "json"]), false);
  assert.equal(isMutatingCloudflaredCommand(["tunnel", "ingress", "validate", "/x/cfg.yml"]), false);
  // Everything else mutates.
  assert.equal(isMutatingCloudflaredCommand(["tunnel", "run", "forge-remote-board"]), true);
  assert.equal(isMutatingCloudflaredCommand(["tunnel", "create", "forge-remote-board"]), true);
  assert.equal(isMutatingCloudflaredCommand(["tunnel", "delete", "forge-remote-board"]), true);
  assert.equal(isMutatingCloudflaredCommand(["access", "login", "https://board.example.com"]), true);
});

test("parseTunnelList: extracts names; fails closed (null) on empty/malformed", () => {
  assert.deepEqual(parseTunnelList(JSON.stringify([{ name: "a" }, { name: "b" }, {}])), ["a", "b"]);
  assert.equal(parseTunnelList(""), null);
  assert.equal(parseTunnelList("{not json"), null);
  assert.equal(parseTunnelList("{}"), null); // not an array
});

// ---- ingress builder ------------------------------------------------------------------------

test("buildIngressConfig: the service is ALWAYS the loopback board; creds path written not echoed by caller", () => {
  const yaml = buildIngressConfig({
    publicHostname: "board.example.com",
    loopbackPort: 8025,
    tunnelName: "forge-remote-board",
    credentialsFile: "/secret/creds.json",
  });
  assert.match(yaml, /service: http:\/\/127\.0\.0\.1:8025/);
  assert.match(yaml, /hostname: board\.example\.com/);
  assert.match(yaml, /tunnel: forge-remote-board/);
  assert.match(yaml, /credentials-file: \/secret\/creds\.json/);
  assert.match(yaml, /http_status:404/); // catch-all
  // AC2/C4: never a non-loopback service.
  assert.ok(!/service: http:\/\/(?!127\.0\.0\.1)/.test(yaml));
});

// ---- doctor report --------------------------------------------------------------------------

test("buildCloudflareDoctorReport: a ready deployment has no refusals, a loopback target, and boundary notes", () => {
  const r = buildCloudflareDoctorReport(healthyInput());
  assert.equal(r.ok, true);
  assert.deepEqual(r.refusals, []);
  assert.equal(r.proposedTarget.url, "https://board.example.com");
  assert.equal(r.proposedTarget.loopback, "http://127.0.0.1:8025");
  assert.equal(r.identity.transportSelected, true);
  assert.ok(r.boundary.length >= 3);
  assert.ok(r.boundary.some((b) => /Access is the gate/i.test(b) || /never trusted/i.test(b)));
  assert.ok(r.requiredGrants.some((g) => /Access application/i.test(g)));
});

test("buildCloudflareDoctorReport: no Access team → REFUSED (AC4 — a bare tunnel with no Access policy)", () => {
  const r = buildCloudflareDoctorReport(healthyInput({ config: { ...GOOD_CONFIG, accessTeamDomain: null }, certsUrl: null, jwksReachable: null }));
  assert.equal(r.ok, false);
  assert.ok(r.refusals.some((x) => /no Access policy/i.test(x) && /REFUSED/i.test(x)));
});

test("buildCloudflareDoctorReport: no AUD → REFUSED (AC4)", () => {
  const r = buildCloudflareDoctorReport(healthyInput({ config: { ...GOOD_CONFIG, accessAud: null } }));
  assert.equal(r.ok, false);
  assert.ok(r.refusals.some((x) => /No Access application AUD/i.test(x)));
});

test("buildCloudflareDoctorReport: malformed AUD → REFUSED", () => {
  const r = buildCloudflareDoctorReport(healthyInput({ config: { ...GOOD_CONFIG, accessAud: "nope" } }));
  assert.equal(r.ok, false);
  assert.ok(r.refusals.some((x) => /AUD is malformed/i.test(x)));
});

test("buildCloudflareDoctorReport: malformed public hostname → REFUSED", () => {
  const r = buildCloudflareDoctorReport(healthyInput({ config: { ...GOOD_CONFIG, publicHostname: "https://x" } }));
  assert.equal(r.ok, false);
  assert.ok(r.refusals.some((x) => /hostname .* is malformed/i.test(x)));
});

test("buildCloudflareDoctorReport: JWKS unreachable → REFUSED (cannot confirm the Access team)", () => {
  const r = buildCloudflareDoctorReport(healthyInput({ jwksReachable: false }));
  assert.equal(r.ok, false);
  assert.ok(r.refusals.some((x) => /JWKS certs endpoint .* is unreachable/i.test(x)));
});

test("buildCloudflareDoctorReport: JWKS undetermined (null) with a valid team → REFUSED (fail closed)", () => {
  const r = buildCloudflareDoctorReport(healthyInput({ jwksReachable: null }));
  assert.equal(r.ok, false);
  assert.ok(r.refusals.some((x) => /Could not determine JWKS reachability/i.test(x)));
});

test("buildCloudflareDoctorReport: cloudflared missing → REFUSED", () => {
  const r = buildCloudflareDoctorReport(healthyInput({ cliPresent: false }));
  assert.equal(r.ok, false);
  assert.ok(r.refusals.some((x) => /cloudflared` CLI is not on PATH/i.test(x)));
});

test("cloudflareBoundaryNotes + requiredCloudflareGrants: state the authenticated-vs-unauthenticated distinction (AC7)", () => {
  assert.ok(cloudflareBoundaryNotes().some((b) => /bare cloudflared tunnel with NO Access policy is refused/i.test(b)));
  const grants = requiredCloudflareGrants("/x/remote-board-identity.yml");
  assert.ok(grants.some((g) => /public, unauthenticated service/i.test(g)));
  assert.ok(grants.some((g) => g.includes("/x/remote-board-identity.yml")));
});

// ---- setup plan -----------------------------------------------------------------------------

test("planCloudflareSetup: --dry-run plans ZERO state writes but still proposes the record (AC1)", () => {
  const report = buildCloudflareDoctorReport(healthyInput());
  const plan = planCloudflareSetup({ report, config: GOOD_CONFIG, loopbackPort: 8025, dryRun: true, confirmed: true });
  assert.deepEqual(plan.stateWrites, []); // executed set is empty (AC1)
  assert.equal(plan.willApply, false);
  assert.equal(plan.proposedWrites.length, 2); // proposal still shown
  assert.equal(plan.record?.target, "http://127.0.0.1:8025");
  assert.equal(plan.record?.url, "https://board.example.com");
});

test("planCloudflareSetup: unconfirmed preview plans ZERO state writes", () => {
  const report = buildCloudflareDoctorReport(healthyInput());
  const plan = planCloudflareSetup({ report, config: GOOD_CONFIG, loopbackPort: 8025, dryRun: false, confirmed: false });
  assert.deepEqual(plan.stateWrites, []);
  assert.equal(plan.willApply, false);
});

test("planCloudflareSetup: confirmed + ready plans the two writes and a loopback record", () => {
  const report = buildCloudflareDoctorReport(healthyInput());
  const plan = planCloudflareSetup({
    report,
    config: GOOD_CONFIG,
    loopbackPort: 8025,
    dryRun: false,
    confirmed: true,
    now: "2026-09-08T00:00:00Z",
  });
  assert.equal(plan.willApply, true);
  assert.equal(plan.stateWrites.length, 2);
  assert.equal(plan.record?.publicHostname, "board.example.com");
  assert.equal(plan.record?.accessTeamDomain, "acme.cloudflareaccess.com");
  assert.equal(plan.record?.accessAud, AUD);
  assert.equal(plan.record?.target, "http://127.0.0.1:8025");
  assert.equal(plan.record?.cloudflaredConfigPath, "/tmp/forge/remote-board-cloudflared.yml");
  assert.equal(plan.record?.createdAt, "2026-09-08T00:00:00Z");
  assert.match(plan.ingressContents ?? "", /service: http:\/\/127\.0\.0\.1:8025/);
});

test("planCloudflareSetup: any refusal plans ZERO writes even when confirmed (AC4)", () => {
  const report = buildCloudflareDoctorReport(healthyInput({ config: { ...GOOD_CONFIG, accessTeamDomain: null }, certsUrl: null, jwksReachable: null }));
  const plan = planCloudflareSetup({ report, config: { ...GOOD_CONFIG, accessTeamDomain: null }, loopbackPort: 8025, dryRun: false, confirmed: true });
  assert.deepEqual(plan.stateWrites, []);
  assert.equal(plan.willApply, false);
  assert.equal(plan.record, null);
  assert.ok(plan.refusals.some((x) => /no Access policy/i.test(x)));
});

// ---- disable plan ---------------------------------------------------------------------------

const RECORD: AccessStateRecord = {
  version: 1,
  publicHostname: "board.example.com",
  accessTeamDomain: "acme.cloudflareaccess.com",
  accessAud: AUD,
  loopbackPort: 8025,
  target: "http://127.0.0.1:8025",
  url: "https://board.example.com",
  cloudflaredConfigPath: "/tmp/forge/remote-board-cloudflared.yml",
};

test("planCloudflareDisable: with a record, removes ONLY the owned config + state record (AC4/AC6)", () => {
  const plan = planCloudflareDisable(RECORD);
  assert.equal(plan.hadRecord, true);
  assert.deepEqual(plan.removes, ["/tmp/forge/remote-board-cloudflared.yml", "access-state record"]);
  // Exactly two owned items — never a blanket teardown of the Access app or the tunnel itself.
  assert.equal(plan.removes.length, 2);
  assert.ok(!plan.removes.some((x) => /tunnel delete|access (login|app)|serve reset/i.test(x)));
});

test("planCloudflareDisable: no record → ZERO removals (nothing Forge owns to remove)", () => {
  const plan = planCloudflareDisable(null);
  assert.equal(plan.hadRecord, false);
  assert.deepEqual(plan.removes, []);
});
