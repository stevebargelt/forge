// FG-782 (step 8) INTEGRATION tier — drives the FULL `forge remote tailscale` flow end to end:
// the real dashboard serve-status parser (step 5) and the real Forge-owned serve-state store
// (this step, a real JSON file under a temp FORGE_HOME) are loaded through remote.ts's runtime
// loaders; a RECORDING runner stands in for the `tailscale` binary and captures every command
// the flow issues. No real tailnet, no real tailscaled.
//
// This is *.integration because it reads/writes a real file (the serve-state record) and
// exercises the cross-package dynamic imports at runtime. The pure decision logic is unit-tested
// in remote-tailscale.test.ts.
//
// The command stream the fake records is the AC evidence:
//   AC1 — `setup --dry-run` issues ZERO mutating commands and writes no state.
//   AC5 — a fake reporting Funnel enabled makes doctor and setup REFUSE.
//   AC6 — `disable` issues EXACTLY the recorded surgical `serve --https=443 off` (never reset),
//         removes only the serve-state file, and leaves other FORGE_HOME data untouched.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  isMutatingTailscaleCommand,
  runDisable,
  runDoctor,
  runSetup,
  type CliResult,
  type CliRunner,
} from "./remote.js";

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "fg782-remote-cli-"));
  dirs.push(dir);
  return dir;
}

const SELF_JSON = JSON.stringify({
  BackendState: "Running",
  Self: { DNSName: "steve-mbp.tail1234.ts.net." },
});

function serveJson(funnel: boolean): string {
  return JSON.stringify({
    AllowFunnel: funnel ? { "steve-mbp.tail1234.ts.net:443": true } : {},
    Web: {},
  });
}

/** A recording fake `tailscale`: records every argv it receives and answers reads with canned
 *  JSON. `down` makes status/serve-status fail (daemon unreachable). Mutating commands just
 *  succeed. */
function recordingRunner(opts: { funnel?: boolean; down?: boolean } = {}): {
  runner: CliRunner;
  calls: string[][];
} {
  const calls: string[][] = [];
  const runner: CliRunner = (args): CliResult => {
    calls.push([...args]);
    const [cmd, sub] = args;
    if (cmd === "version") return { ok: true, code: 0, stdout: "1.80.0\n" };
    if (opts.down && (cmd === "status" || (cmd === "serve" && sub === "status"))) {
      return { ok: false, code: 1, stdout: "" };
    }
    if (cmd === "status") return { ok: true, code: 0, stdout: SELF_JSON };
    if (cmd === "serve" && sub === "status") return { ok: true, code: 0, stdout: serveJson(opts.funnel ?? false) };
    // Any mutating serve command — succeed.
    return { ok: true, code: 0, stdout: "" };
  };
  return { runner, calls };
}

function mutations(calls: string[][]): string[][] {
  return calls.filter(isMutatingTailscaleCommand);
}

const NOW = () => "2026-09-08T00:00:00Z";

// --- AC1: dry-run performs no host/tailnet change --------------------------------------------

test("AC1: `setup --dry-run` issues ZERO mutating commands and writes no serve-state", async () => {
  const home = tempHome();
  const { runner, calls } = recordingRunner({ funnel: false });
  const out: string[] = [];
  const code = await runSetup(
    { runner, env: { FORGE_HOME: home }, out: (l) => out.push(l), now: NOW },
    { dryRun: true, confirm: true, json: false },
  );
  assert.equal(code, 0);
  assert.deepEqual(mutations(calls), [], "dry-run must issue no mutating tailscale command");
  assert.ok(!existsSync(join(home, "remote-board-serve-state.json")), "dry-run must not write serve-state");
  assert.ok(out.join("\n").includes("NO changes made"));
});

// --- Happy apply + AC2 loopback-only target --------------------------------------------------

test("`setup --confirm` (no Funnel) issues exactly the create command and records a loopback mapping", async () => {
  const home = tempHome();
  const { runner, calls } = recordingRunner({ funnel: false });
  const out: string[] = [];
  const code = await runSetup(
    { runner, env: { FORGE_HOME: home }, out: (l) => out.push(l), now: NOW },
    { dryRun: false, confirm: true, json: false },
  );
  assert.equal(code, 0);
  const muts = mutations(calls);
  assert.equal(muts.length, 1, "exactly one mutating command");
  assert.deepEqual(muts[0], ["serve", "--bg", "--https=443", "http://127.0.0.1:8025"]);
  // Never a Funnel flag.
  assert.ok(!calls.some((c) => c.includes("funnel")), "setup must never touch funnel");

  const statePath = join(home, "remote-board-serve-state.json");
  assert.ok(existsSync(statePath), "serve-state recorded on apply");
  const record = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(record.url, "https://steve-mbp.tail1234.ts.net");
  assert.equal(record.target, "http://127.0.0.1:8025"); // AC2: loopback-only target
  assert.ok(record.target.startsWith("http://127.0.0.1:"));
  assert.deepEqual(record.disableArgs, ["serve", "--https=443", "off"]);
});

// --- AC6: disable removes ONLY the recorded mapping ------------------------------------------

test("AC6: `disable` issues exactly the recorded surgical off (never reset) and touches only serve-state", async () => {
  const home = tempHome();
  // A sentinel piece of "Forge data" that disable must NOT touch.
  const sentinel = join(home, "remote-board-identity.yml");
  writeFileSync(sentinel, "version: 1\nidentities: []\n");

  // First set up so there is a recorded mapping.
  const setup = recordingRunner({ funnel: false });
  await runSetup(
    { runner: setup.runner, env: { FORGE_HOME: home }, out: () => {}, now: NOW },
    { dryRun: false, confirm: true, json: false },
  );
  assert.ok(existsSync(join(home, "remote-board-serve-state.json")));

  // Now disable.
  const disable = recordingRunner({ funnel: false });
  const out: string[] = [];
  const code = await runDisable({ runner: disable.runner, env: { FORGE_HOME: home }, out: (l) => out.push(l) }, false);
  assert.equal(code, 0);

  const muts = mutations(disable.calls);
  assert.equal(muts.length, 1, "exactly one mutating command");
  assert.deepEqual(muts[0], ["serve", "--https=443", "off"]);
  assert.ok(!disable.calls.some((c) => c.includes("reset")), "AC6: never a blanket serve reset");

  assert.ok(!existsSync(join(home, "remote-board-serve-state.json")), "serve-state removed");
  assert.ok(existsSync(sentinel), "disable must not touch other Forge data");
  assert.equal(readFileSync(sentinel, "utf8"), "version: 1\nidentities: []\n");
});

test("`disable` with no recorded mapping is a no-op (zero mutations)", async () => {
  const home = tempHome();
  const { runner, calls } = recordingRunner();
  const out: string[] = [];
  const code = await runDisable({ runner, env: { FORGE_HOME: home }, out: (l) => out.push(l) }, false);
  assert.equal(code, 0);
  assert.deepEqual(mutations(calls), []);
  assert.ok(out.join("\n").toLowerCase().includes("nothing to remove"));
});

// --- AC5: Funnel enabled → refused -----------------------------------------------------------

test("AC5: a fake reporting Funnel enabled makes doctor refuse (exit 1, called out)", async () => {
  const home = tempHome();
  const { runner } = recordingRunner({ funnel: true });
  const out: string[] = [];
  const code = await runDoctor({ runner, env: { FORGE_HOME: home }, out: (l) => out.push(l) }, false);
  assert.equal(code, 1);
  assert.match(out.join("\n"), /Funnel/i);
  assert.match(out.join("\n"), /REFUSED/i);
});

test("AC5: `setup --confirm` with Funnel enabled REFUSES and issues zero mutations", async () => {
  const home = tempHome();
  const { runner, calls } = recordingRunner({ funnel: true });
  const out: string[] = [];
  const code = await runSetup(
    { runner, env: { FORGE_HOME: home }, out: (l) => out.push(l), now: NOW },
    { dryRun: false, confirm: true, json: false },
  );
  assert.equal(code, 1);
  assert.deepEqual(mutations(calls), [], "a Funnel-enabled host must get zero mutations");
  assert.ok(!existsSync(join(home, "remote-board-serve-state.json")), "no serve-state written on refusal");
  assert.match(out.join("\n"), /REFUSED/i);
});

// --- daemon down → refuse (fail closed) ------------------------------------------------------

test("daemon unreachable → doctor not ready and setup refuses (fail closed)", async () => {
  const home = tempHome();
  const doctor = recordingRunner({ down: true });
  const dout: string[] = [];
  assert.equal(await runDoctor({ runner: doctor.runner, env: { FORGE_HOME: home }, out: (l) => dout.push(l) }, false), 1);
  assert.match(dout.join("\n"), /not reachable/i);

  const setup = recordingRunner({ down: true });
  const sout: string[] = [];
  const code = await runSetup(
    { runner: setup.runner, env: { FORGE_HOME: home }, out: (l) => sout.push(l), now: NOW },
    { dryRun: false, confirm: true, json: false },
  );
  assert.equal(code, 1);
  assert.deepEqual(mutations(setup.calls), []);
});

// --- doctor JSON is a clean structured surface -----------------------------------------------

test("doctor --json emits the structured report (proposed target, identity, funnel, grants)", async () => {
  const home = tempHome();
  const { runner } = recordingRunner({ funnel: false });
  const out: string[] = [];
  await runDoctor({ runner, env: { FORGE_HOME: home, FORGE_DASHBOARD_REMOTE_TRANSPORT: "tailscale" }, out: (l) => out.push(l) }, true);
  const report = JSON.parse(out.join("\n"));
  assert.equal(report.proposedTarget.loopback, "http://127.0.0.1:8025");
  assert.equal(report.proposedTarget.url, "https://steve-mbp.tail1234.ts.net");
  assert.equal(report.identity.transportSelected, true);
  assert.equal(report.funnel.detected, false);
  assert.ok(Array.isArray(report.requiredGrants));
});
