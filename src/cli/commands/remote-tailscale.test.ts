// FG-782 (step 8) UNIT tier — the PURE report/decision logic of `forge remote tailscale`.
// No process, no listener, no real filesystem: every function under test is a pure function of
// its inputs. The end-to-end drive of the real fake `tailscale` binary + real temp FORGE_HOME
// lives in remote-tailscale.integration.test.ts.
//
// SECURITY FOCUS. These tests are dominated by NEGATIVE paths — the wrong/adversary case must
// be REFUSED: Funnel enabled → refusal + zero mutations (AC5); --dry-run → zero mutations
// (AC1); an unconfirmed preview → zero mutations; disable → exactly one surgical `off`, never a
// blanket `serve reset` (AC6); a daemon-down / logged-out host → refusal. "It works for the
// ready host" is necessary but never sufficient here.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildDoctorReport,
  isMutatingTailscaleCommand,
  parseSelfNode,
  planDisable,
  planSetup,
  requiredAclGrants,
  serveArgs,
  type DoctorReportInput,
  type ServeStateRecord,
  type ServeStatusView,
  type SelfNodeView,
} from "./remote.js";

const HEALTHY_SELF: SelfNodeView = {
  backendState: "Running",
  dnsName: "steve-mbp.tail1234.ts.net",
  tailnet: "tail1234.ts.net",
};

const NO_FUNNEL: ServeStatusView = { funnel: false, proxies: [] };
const FUNNEL_ON: ServeStatusView = {
  funnel: true,
  proxies: [{ host: "steve-mbp.tail1234.ts.net:443", target: "http://127.0.0.1:8025" }],
};

function healthyInput(overrides: Partial<DoctorReportInput> = {}): DoctorReportInput {
  return {
    cliPresent: true,
    daemonReachable: true,
    selfNode: HEALTHY_SELF,
    serveStatus: NO_FUNNEL,
    loopbackPort: 8025,
    transport: "tailscale",
    mappingPath: "/tmp/forge/remote-board-identity.yml",
    serveState: null,
    ...overrides,
  };
}

// ---- command classification -----------------------------------------------------------------

test("isMutatingTailscaleCommand: reads are read, everything else mutates", () => {
  // Read allowlist.
  assert.equal(isMutatingTailscaleCommand(["version"]), false);
  assert.equal(isMutatingTailscaleCommand(["status", "--json"]), false);
  assert.equal(isMutatingTailscaleCommand(["serve", "status", "--json"]), false);
  assert.equal(isMutatingTailscaleCommand(["whois", "--json", "100.101.102.103"]), false);
  // Everything else is mutating — fail-safe by construction.
  assert.equal(isMutatingTailscaleCommand(["serve", "--bg", "--https=443", "http://127.0.0.1:8025"]), true);
  assert.equal(isMutatingTailscaleCommand(["serve", "--https=443", "off"]), true);
  assert.equal(isMutatingTailscaleCommand(["serve", "reset"]), true);
  assert.equal(isMutatingTailscaleCommand(["funnel", "443", "on"]), true);
  assert.equal(isMutatingTailscaleCommand(["up"]), true);
});

test("serveArgs: create is a scoped HTTPS handler; disable is the surgical inverse, never reset", () => {
  const { target, createArgs, disableArgs } = serveArgs(8025);
  assert.equal(target, "http://127.0.0.1:8025");
  assert.deepEqual(createArgs, ["serve", "--bg", "--https=443", "http://127.0.0.1:8025"]);
  assert.deepEqual(disableArgs, ["serve", "--https=443", "off"]);
  // AC6: the disable command must never be a blanket reset.
  assert.ok(!disableArgs.includes("reset"));
  // The proposed target is provably loopback (AC2 — setup never proposes a non-loopback bind).
  assert.ok(target.startsWith("http://127.0.0.1:"));
});

// ---- self-node parsing ----------------------------------------------------------------------

test("parseSelfNode: extracts BackendState + trimmed MagicDNS name + tailnet", () => {
  const raw = JSON.stringify({
    BackendState: "Running",
    Self: { DNSName: "steve-mbp.tail1234.ts.net." },
  });
  const self = parseSelfNode(raw);
  assert.ok(self);
  assert.equal(self.backendState, "Running");
  assert.equal(self.dnsName, "steve-mbp.tail1234.ts.net");
  assert.equal(self.tailnet, "tail1234.ts.net");
});

test("parseSelfNode: fails closed (null) on empty/malformed output", () => {
  assert.equal(parseSelfNode(""), null);
  assert.equal(parseSelfNode("{not json"), null);
  assert.equal(parseSelfNode("[]"), null);
});

// ---- doctor report --------------------------------------------------------------------------

test("buildDoctorReport: a ready host has no refusals, a loopback target, and grant guidance", () => {
  const r = buildDoctorReport(healthyInput());
  assert.equal(r.ok, true);
  assert.deepEqual(r.refusals, []);
  assert.equal(r.proposedTarget.url, "https://steve-mbp.tail1234.ts.net");
  assert.equal(r.proposedTarget.loopback, "http://127.0.0.1:8025");
  assert.equal(r.identity.transportSelected, true);
  // required grants report shape (AC5/AC7 include the Funnel-unsupported statement).
  assert.ok(r.requiredGrants.length >= 3);
  assert.ok(r.requiredGrants.some((g) => /Funnel NOT enabled/i.test(g)));
  assert.ok(r.requiredGrants.some((g) => g.includes(r.identity.mappingPath)));
});

test("buildDoctorReport: Funnel enabled → REFUSED and not ok (AC5)", () => {
  const r = buildDoctorReport(healthyInput({ serveStatus: FUNNEL_ON }));
  assert.equal(r.funnel.detected, true);
  assert.equal(r.funnel.determinable, true);
  assert.equal(r.ok, false);
  assert.ok(r.refusals.some((x) => /Funnel/i.test(x) && /REFUSED/i.test(x)));
});

test("buildDoctorReport: serve status unreadable → must NOT assume Funnel off (refuse)", () => {
  const r = buildDoctorReport(healthyInput({ serveStatus: null }));
  assert.equal(r.funnel.determinable, false);
  assert.equal(r.ok, false);
  assert.ok(r.refusals.some((x) => /assuming Funnel is off/i.test(x)));
});

test("buildDoctorReport: daemon down and logged-out are named refusals", () => {
  const down = buildDoctorReport(healthyInput({ daemonReachable: false, selfNode: null, serveStatus: null }));
  assert.equal(down.ok, false);
  assert.ok(down.refusals.some((x) => /tailscaled is not reachable/i.test(x)));

  const out = buildDoctorReport(
    healthyInput({ selfNode: { backendState: "NeedsLogin", dnsName: null, tailnet: null } }),
  );
  assert.equal(out.prerequisites.loggedIn, false);
  assert.ok(out.refusals.some((x) => /not logged in/i.test(x)));
});

test("requiredAclGrants: states Funnel is unsupported and names the mapping file", () => {
  const grants = requiredAclGrants("/x/remote-board-identity.yml");
  assert.ok(grants.some((g) => /Funnel NOT enabled/i.test(g)));
  assert.ok(grants.some((g) => g.includes("/x/remote-board-identity.yml")));
});

// ---- setup plan -----------------------------------------------------------------------------

test("planSetup: --dry-run plans ZERO mutations but still proposes the target (AC1)", () => {
  const report = buildDoctorReport(healthyInput());
  const plan = planSetup({ report, selfNode: HEALTHY_SELF, loopbackPort: 8025, dryRun: true, confirmed: true });
  assert.deepEqual(plan.mutations, []); // executed set is empty (AC1)
  assert.equal(plan.willApply, false);
  assert.equal(plan.proposedMutations.length, 1); // the proposal is still shown
  assert.equal(plan.record?.target, "http://127.0.0.1:8025");
});

test("planSetup: unconfirmed preview plans ZERO mutations", () => {
  const report = buildDoctorReport(healthyInput());
  const plan = planSetup({ report, selfNode: HEALTHY_SELF, loopbackPort: 8025, dryRun: false, confirmed: false });
  assert.deepEqual(plan.mutations, []);
  assert.equal(plan.willApply, false);
});

test("planSetup: confirmed + ready plans exactly the create command and a loopback record", () => {
  const report = buildDoctorReport(healthyInput());
  const plan = planSetup({
    report,
    selfNode: HEALTHY_SELF,
    loopbackPort: 8025,
    dryRun: false,
    confirmed: true,
    now: "2026-09-08T00:00:00Z",
  });
  assert.equal(plan.willApply, true);
  assert.deepEqual(plan.mutations, [["serve", "--bg", "--https=443", "http://127.0.0.1:8025"]]);
  assert.equal(plan.record?.serveHost, "steve-mbp.tail1234.ts.net");
  assert.equal(plan.record?.url, "https://steve-mbp.tail1234.ts.net");
  assert.equal(plan.record?.target, "http://127.0.0.1:8025");
  assert.deepEqual(plan.record?.disableArgs, ["serve", "--https=443", "off"]);
  assert.equal(plan.record?.createdAt, "2026-09-08T00:00:00Z");
});

test("planSetup: Funnel refusal plans ZERO mutations even when confirmed (AC5)", () => {
  const report = buildDoctorReport(healthyInput({ serveStatus: FUNNEL_ON }));
  const plan = planSetup({ report, selfNode: HEALTHY_SELF, loopbackPort: 8025, dryRun: false, confirmed: true });
  assert.deepEqual(plan.mutations, []);
  assert.equal(plan.willApply, false);
  assert.ok(plan.refusals.some((x) => /Funnel/i.test(x)));
});

test("planSetup: no self identity → refuse, no record built", () => {
  const report = buildDoctorReport(healthyInput({ selfNode: null, daemonReachable: false, serveStatus: null }));
  const plan = planSetup({ report, selfNode: null, loopbackPort: 8025, dryRun: false, confirmed: true });
  assert.deepEqual(plan.mutations, []);
  assert.equal(plan.record, null);
  assert.equal(plan.willApply, false);
});

// ---- disable plan ---------------------------------------------------------------------------

const RECORD: ServeStateRecord = {
  version: 1,
  serveHost: "steve-mbp.tail1234.ts.net",
  servePort: 443,
  loopbackPort: 8025,
  target: "http://127.0.0.1:8025",
  url: "https://steve-mbp.tail1234.ts.net",
  createArgs: ["serve", "--bg", "--https=443", "http://127.0.0.1:8025"],
  disableArgs: ["serve", "--https=443", "off"],
};

test("planDisable: with a recorded mapping, plans EXACTLY the recorded surgical off — never reset (AC6)", () => {
  const plan = planDisable(RECORD);
  assert.equal(plan.hadRecord, true);
  assert.equal(plan.mutations.length, 1);
  assert.deepEqual(plan.mutations[0], ["serve", "--https=443", "off"]);
  assert.ok(!plan.mutations[0]?.includes("reset"));
});

test("planDisable: no recorded mapping → ZERO mutations (nothing Forge owns to remove)", () => {
  const plan = planDisable(null);
  assert.equal(plan.hadRecord, false);
  assert.deepEqual(plan.mutations, []);
});
