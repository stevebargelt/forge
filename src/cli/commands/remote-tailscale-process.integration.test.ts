// FG-782 CLI process integration: the built forge entry talks only to a fake tailscale on PATH.
import "../../test-setup.js";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = mkdtempSync(join(tmpdir(), "fg782-cli-process-"));
const home = join(root, "forge-home");
const bin = join(root, "bin");
const log = join(root, "tailscale.log");
execFileSync("mkdir", ["-p", home, bin]);
writeFileSync(join(bin, "tailscale"), `#!/bin/sh
printf '%s\\n' "$*" >> "$TS_FAKE_LOG"
if [ "$1" = version ]; then echo 1.80.0; exit 0; fi
if [ "$1" = status ]; then echo '{"BackendState":"Running","Self":{"DNSName":"test.tailnet.ts.net."}}'; exit 0; fi
if [ "$1" = serve ] && [ "$2" = status ]; then
  if [ "\${TS_FAKE_FUNNEL:-0}" = 1 ]; then echo '{"AllowFunnel":{"test.tailnet.ts.net:443":true},"Web":{}}'; else echo '{"AllowFunnel":{},"Web":{}}'; fi
  exit 0
fi
exit 0
`);
chmodSync(join(bin, "tailscale"), 0o755);

function invoke(args: string[], extra: Record<string, string> = {}): { stdout: string; status: number } {
  try {
    return { stdout: execFileSync(resolve(process.cwd(), "bin/forge"), args, { encoding: "utf8", env: { ...process.env, ...extra, FORGE_HOME: home, PATH: `${bin}:${process.env.PATH}`, TS_FAKE_LOG: log } }), status: 0 };
  } catch (err) {
    const e = err as { stdout?: string; status?: number | null };
    return { stdout: e.stdout ?? "", status: e.status ?? 1 };
  }
}
function commands(): string[] { return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : []; }
function clearLog(): void { writeFileSync(log, ""); }

test("FG-782 AC1/AC5/AC6: built forge CLI dry-runs, applies one Serve mapping, surgically disables it, and refuses Funnel", () => {
  clearLog();
  const doctor = invoke(["remote", "tailscale", "doctor", "--json"], { FORGE_DASHBOARD_REMOTE_TRANSPORT: "tailscale" });
  assert.equal(doctor.status, 0);
  const report = JSON.parse(doctor.stdout);
  assert.equal(report.proposedTarget.loopback, "http://127.0.0.1:8025");
  assert.equal(report.funnel.detected, false);

  clearLog();
  const dry = invoke(["remote", "tailscale", "setup", "--dry-run", "--confirm"]);
  assert.equal(dry.status, 0);
  assert.deepEqual(commands().filter((line) => /^serve (?!status)/.test(line)), [], "dry-run sends no mutation to tailscaled");
  assert.ok(!existsSync(join(home, "remote-board-serve-state.json")));

  clearLog();
  const setup = invoke(["remote", "tailscale", "setup", "--confirm"]);
  assert.equal(setup.status, 0);
  assert.deepEqual(commands().filter((line) => /^serve (?!status)/.test(line)), ["serve --bg --https=443 http://127.0.0.1:8025"]);
  assert.ok(existsSync(join(home, "remote-board-serve-state.json")));

  clearLog();
  const disable = invoke(["remote", "tailscale", "disable"]);
  assert.equal(disable.status, 0);
  assert.deepEqual(commands().filter((line) => /^serve /.test(line)), ["serve --https=443 off"]);
  assert.ok(!commands().some((line) => line.includes("reset")));
  assert.ok(!existsSync(join(home, "remote-board-serve-state.json")));

  clearLog();
  const funnel = invoke(["remote", "tailscale", "doctor", "--json"], { TS_FAKE_FUNNEL: "1" });
  assert.equal(funnel.status, 1);
  const refused = JSON.parse(funnel.stdout);
  assert.equal(refused.funnel.detected, true);
  assert.equal(refused.ok, false);
});

after(() => rmSync(root, { recursive: true, force: true }));
