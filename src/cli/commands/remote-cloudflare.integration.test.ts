// FG-784 (step 6) INTEGRATION tier — drives the FULL `forge remote cloudflare` flow end to end:
// the REAL Forge-owned access-state store (dashboard step-3 module, loaded through remote.ts's
// runtime loader) writes/reads REAL files under a temp FORGE_HOME. A RECORDING runner stands in
// for the `cloudflared` binary and an INJECTED probe stands in for the certs-endpoint fetch, so
// there is no real Cloudflare account and no real network. The pure decision logic is unit-tested
// in remote-cloudflare.test.ts.
//
// This is *.integration because it reads/writes real files (the owned ingress config + the state
// record) and exercises the cross-package dynamic import at runtime. The command stream + the
// on-disk state are the AC evidence:
//   AC1 — `setup --dry-run` issues ZERO mutating cloudflared commands and writes NO files.
//   AC4 — a public hostname with no Access team/AUD, and an unreachable JWKS endpoint, REFUSE and
//         write nothing.
//   AC2 — an applied deployment's owned ingress config services ONLY http://127.0.0.1:<port>.
//   AC4/AC6 — `disable` removes ONLY the owned ingress + state record; a sentinel credentials file
//         and the identity mapping are left untouched. No blanket teardown.
//   Credentials are NEVER persisted in the state record.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  isMutatingCloudflaredCommand,
  resolveCloudflareConfig,
  runCloudflareDisable,
  runCloudflareDoctor,
  runCloudflareSetup,
  type CertsProbe,
  type CliResult,
  type CliRunner,
} from "./remote.js";

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "fg784-remote-cf-"));
  dirs.push(dir);
  return dir;
}

const AUD = "a".repeat(64);
const STATE_FILE = "remote-board-cloudflare-state.json";
const INGRESS_FILE = "remote-board-cloudflared.yml";

/** A recording fake `cloudflared`: records every argv and answers the reads. `absent` makes
 *  `--version` fail (CLI not installed). Any other command just succeeds. */
function recordingRunner(opts: { absent?: boolean } = {}): { runner: CliRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: CliRunner = (args): CliResult => {
    calls.push([...args]);
    const [cmd, sub] = args;
    if (cmd === "--version") return opts.absent ? { ok: false, code: -1, stdout: "" } : { ok: true, code: 0, stdout: "cloudflared version 2024.1.0\n" };
    if (cmd === "tunnel" && sub === "list") return { ok: true, code: 0, stdout: JSON.stringify([{ name: "forge-remote-board" }]) };
    return { ok: true, code: 0, stdout: "" };
  };
  return { runner, calls };
}

function mutations(calls: string[][]): string[][] {
  return calls.filter(isMutatingCloudflaredCommand);
}

const OK_PROBE: CertsProbe = async () => true;
const DEAD_PROBE: CertsProbe = async () => false;
const NOW = () => "2026-09-08T00:00:00Z";

function config(home: string, over: Partial<{ hostname: string; team: string; aud: string; tunnel: string; credentialsFile: string }> = {}) {
  return resolveCloudflareConfig(
    {
      hostname: over.hostname ?? "board.example.com",
      team: over.team ?? "acme",
      aud: over.aud ?? AUD,
      tunnel: over.tunnel ?? "forge-remote-board",
      credentialsFile: over.credentialsFile,
    },
    { FORGE_HOME: home },
  );
}

// --- AC1: dry-run performs no change ----------------------------------------------------------

test("AC1: `setup --dry-run` issues ZERO mutating cloudflared commands and writes no files", async () => {
  const home = tempHome();
  const { runner, calls } = recordingRunner();
  const out: string[] = [];
  const code = await runCloudflareSetup(
    { runner, env: { FORGE_HOME: home }, probeCerts: OK_PROBE, out: (l) => out.push(l), now: NOW },
    { dryRun: true, confirm: true, json: false, config: config(home) },
  );
  assert.equal(code, 0);
  assert.deepEqual(mutations(calls), [], "dry-run must issue no mutating cloudflared command");
  assert.ok(!existsSync(join(home, INGRESS_FILE)), "dry-run must not write the ingress config");
  assert.ok(!existsSync(join(home, STATE_FILE)), "dry-run must not write the state record");
  assert.match(out.join("\n"), /NO changes made/);
});

// --- Happy apply + AC2 loopback-only target + credentials never persisted --------------------

test("`setup --confirm` writes the owned ingress (loopback service) + state record; never a credential", async () => {
  const home = tempHome();
  const { runner, calls } = recordingRunner();
  const out: string[] = [];
  const code = await runCloudflareSetup(
    { runner, env: { FORGE_HOME: home }, probeCerts: OK_PROBE, out: (l) => out.push(l), now: NOW },
    { dryRun: false, confirm: true, json: false, config: config(home, { credentialsFile: "/secret/creds.json" }) },
  );
  assert.equal(code, 0);
  assert.deepEqual(mutations(calls), [], "apply runs no mutating cloudflared command (operator runs the tunnel)");

  const ingressPath = join(home, INGRESS_FILE);
  const statePath = join(home, STATE_FILE);
  assert.ok(existsSync(ingressPath), "owned ingress config written on apply");
  assert.ok(existsSync(statePath), "state record written on apply");

  const ingress = readFileSync(ingressPath, "utf8");
  assert.match(ingress, /service: http:\/\/127\.0\.0\.1:8025/); // AC2: loopback-only target
  assert.ok(!/service: http:\/\/(?!127\.0\.0\.1)/.test(ingress), "never a non-loopback service");
  // Owner-only perms (0600) on the owned files.
  assert.equal(statSync(ingressPath).mode & 0o777, 0o600);
  assert.equal(statSync(statePath).mode & 0o777, 0o600);

  const record = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(record.target, "http://127.0.0.1:8025");
  assert.equal(record.url, "https://board.example.com");
  assert.equal(record.accessAud, AUD);
  // Credential handling: the creds path lives ONLY in the operator-owned ingress body, and NEVER
  // in the state record or the printed output.
  assert.match(ingress, /credentials-file: \/secret\/creds\.json/);
  assert.ok(!JSON.stringify(record).includes("/secret/creds.json"), "credentials path must not be persisted in the state record");
  assert.ok(!out.join("\n").includes("/secret/creds.json"), "credentials path must not be printed");
});

// --- AC4: no Access policy → refuse -----------------------------------------------------------

test("AC4: `setup --confirm` with no Access team REFUSES and writes nothing (bare tunnel = public unauth)", async () => {
  const home = tempHome();
  const { runner, calls } = recordingRunner();
  const out: string[] = [];
  const code = await runCloudflareSetup(
    { runner, env: { FORGE_HOME: home }, probeCerts: OK_PROBE, out: (l) => out.push(l), now: NOW },
    { dryRun: false, confirm: true, json: false, config: resolveCloudflareConfig({ hostname: "board.example.com" }, { FORGE_HOME: home }) },
  );
  assert.equal(code, 1);
  assert.deepEqual(mutations(calls), []);
  assert.ok(!existsSync(join(home, INGRESS_FILE)));
  assert.ok(!existsSync(join(home, STATE_FILE)));
  assert.match(out.join("\n"), /REFUSED/);
  assert.match(out.join("\n"), /no Access policy/i);
});

test("AC4: `setup --confirm` with an UNREACHABLE JWKS endpoint REFUSES and writes nothing", async () => {
  const home = tempHome();
  const { runner, calls } = recordingRunner();
  const out: string[] = [];
  const code = await runCloudflareSetup(
    { runner, env: { FORGE_HOME: home }, probeCerts: DEAD_PROBE, out: (l) => out.push(l), now: NOW },
    { dryRun: false, confirm: true, json: false, config: config(home) },
  );
  assert.equal(code, 1);
  assert.deepEqual(mutations(calls), []);
  assert.ok(!existsSync(join(home, STATE_FILE)));
  assert.match(out.join("\n"), /unreachable/i);
});

// --- AC4/AC6: disable removes ONLY the owned files --------------------------------------------

test("AC4/AC6: `disable` removes only the owned ingress + record; leaves creds + mapping untouched", async () => {
  const home = tempHome();
  // Sentinels disable must NEVER touch: a cloudflared credentials file and the identity mapping.
  const creds = join(home, "cloudflared-creds.json");
  const mapping = join(home, "remote-board-identity.yml");
  writeFileSync(creds, '{"AccountTag":"x","TunnelSecret":"y"}');
  writeFileSync(mapping, "version: 1\nidentities: []\n");

  // Set up first so there is a recorded deployment.
  const setup = recordingRunner();
  await runCloudflareSetup(
    { runner: setup.runner, env: { FORGE_HOME: home }, probeCerts: OK_PROBE, out: () => {}, now: NOW },
    { dryRun: false, confirm: true, json: false, config: config(home) },
  );
  assert.ok(existsSync(join(home, INGRESS_FILE)));
  assert.ok(existsSync(join(home, STATE_FILE)));

  // Now disable.
  const disable = recordingRunner();
  const out: string[] = [];
  const code = await runCloudflareDisable(
    { runner: disable.runner, env: { FORGE_HOME: home }, probeCerts: OK_PROBE, out: (l) => out.push(l) },
    false,
  );
  assert.equal(code, 0);
  assert.deepEqual(mutations(disable.calls), [], "disable runs no mutating cloudflared command");
  assert.ok(!existsSync(join(home, INGRESS_FILE)), "owned ingress removed");
  assert.ok(!existsSync(join(home, STATE_FILE)), "state record removed");
  // Sentinels survive.
  assert.ok(existsSync(creds), "disable must not touch cloudflared credentials");
  assert.ok(existsSync(mapping), "disable must not touch the identity mapping");
  assert.equal(readFileSync(mapping, "utf8"), "version: 1\nidentities: []\n");
});

// --- RF-1: setup never overwrites a config Forge did not create -------------------------------

test("RF-1: `setup --confirm` REFUSES when --config names a foreign existing file (byte-identical, no record)", async () => {
  const home = tempHome();
  const foreign = join(home, "operator-cloudflared.yml");
  const original = "tunnel: theirs\ningress:\n  - service: http://127.0.0.1:1\n";
  writeFileSync(foreign, original);
  const { runner, calls } = recordingRunner();
  const out: string[] = [];
  const code = await runCloudflareSetup(
    { runner, env: { FORGE_HOME: home }, probeCerts: OK_PROBE, out: (l) => out.push(l), now: NOW },
    {
      dryRun: false,
      confirm: true,
      json: false,
      config: resolveCloudflareConfig(
        { hostname: "board.example.com", team: "acme", aud: AUD, config: foreign },
        { FORGE_HOME: home },
      ),
    },
  );
  assert.equal(code, 1);
  assert.deepEqual(mutations(calls), []);
  assert.equal(readFileSync(foreign, "utf8"), original, "operator's file must be byte-identical after refusal");
  assert.ok(!existsSync(join(home, STATE_FILE)), "no state record written on refusal");
  assert.match(out.join("\n"), /REFUSED/);
  assert.match(out.join("\n"), /not created by Forge/i);
});

test("RF-1: `disable` REFUSES to delete a tampered ingress file — leaves the file AND record intact", async () => {
  const home = tempHome();
  const { runner } = recordingRunner();
  await runCloudflareSetup(
    { runner, env: { FORGE_HOME: home }, probeCerts: OK_PROBE, out: () => {}, now: NOW },
    { dryRun: false, confirm: true, json: false, config: config(home) },
  );
  const ingressPath = join(home, INGRESS_FILE);
  // Someone edits the owned config after setup — its bytes no longer match the recorded stamp.
  writeFileSync(ingressPath, `${readFileSync(ingressPath, "utf8")}# tampered\n`);

  const out: string[] = [];
  const code = await runCloudflareDisable(
    { runner, env: { FORGE_HOME: home }, probeCerts: OK_PROBE, out: (l) => out.push(l) },
    false,
  );
  assert.equal(code, 1);
  assert.ok(existsSync(ingressPath), "a tampered file must not be deleted");
  assert.ok(existsSync(join(home, STATE_FILE)), "the state record survives a refusal");
  assert.match(out.join("\n"), /REFUSED/);
});

test("`disable` with no recorded deployment is a no-op", async () => {
  const home = tempHome();
  const { runner, calls } = recordingRunner();
  const out: string[] = [];
  const code = await runCloudflareDisable({ runner, env: { FORGE_HOME: home }, probeCerts: OK_PROBE, out: (l) => out.push(l) }, false);
  assert.equal(code, 0);
  assert.deepEqual(mutations(calls), []);
  assert.match(out.join("\n").toLowerCase(), /nothing to remove/);
});

// --- doctor JSON is a clean structured surface -----------------------------------------------

test("doctor --json emits the structured report (proposed target, boundary, identity, refusals)", async () => {
  const home = tempHome();
  const { runner } = recordingRunner();
  const out: string[] = [];
  const code = await runCloudflareDoctor(
    { runner, env: { FORGE_HOME: home, FORGE_DASHBOARD_REMOTE_TRANSPORT: "cloudflare" }, probeCerts: OK_PROBE, out: (l) => out.push(l) },
    { json: true, config: config(home) },
  );
  assert.equal(code, 0);
  const report = JSON.parse(out.join("\n"));
  assert.equal(report.proposedTarget.loopback, "http://127.0.0.1:8025");
  assert.equal(report.proposedTarget.url, "https://board.example.com");
  assert.equal(report.identity.transportSelected, true);
  assert.equal(report.ok, true);
  assert.ok(Array.isArray(report.boundary) && report.boundary.length >= 3);
});

test("doctor --json with a bare tunnel (no team/AUD) reports NOT ok with AC4 refusals", async () => {
  const home = tempHome();
  const { runner } = recordingRunner();
  const out: string[] = [];
  const code = await runCloudflareDoctor(
    { runner, env: { FORGE_HOME: home }, probeCerts: OK_PROBE, out: (l) => out.push(l) },
    { json: true, config: resolveCloudflareConfig({ hostname: "board.example.com" }, { FORGE_HOME: home }) },
  );
  assert.equal(code, 1);
  const report = JSON.parse(out.join("\n"));
  assert.equal(report.ok, false);
  assert.ok(report.refusals.some((x: string) => /no Access policy/i.test(x)));
});
