// FG-784 CLI process integration: the built `forge` entry talks only to a fake `cloudflared` on
// PATH and a LOCAL fake certs endpoint (a real node:http server on 127.0.0.1) — no real Cloudflare
// account, no outbound network. This proves the whole surface through the real dynamic-import +
// access-state store: doctor refuses a bare tunnel (AC4), dry-run writes nothing (AC1), a confirmed
// apply lays down exactly the Forge-owned ingress + state record, and disable removes only those
// (AC4/AC6). The reachability PROBE is pointed at the local server via the documented
// FORGE_REMOTE_CLOUDFLARE_CERTS_URL override so no real cloudflareaccess.com is contacted.

import "../../test-setup.js";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = mkdtempSync(join(tmpdir(), "fg784-cf-process-"));
const home = join(root, "forge-home");
const bin = join(root, "bin");
const log = join(root, "cloudflared.log");
execFileSync("mkdir", ["-p", home, bin]);

// A fake `cloudflared`: logs every invocation, answers the two reads, succeeds on anything else.
writeFileSync(
  join(bin, "cloudflared"),
  `#!/bin/sh
printf '%s\\n' "$*" >> "$CF_FAKE_LOG"
if [ "$1" = "--version" ]; then echo "cloudflared version 2024.1.0"; exit 0; fi
if [ "$1" = "tunnel" ] && [ "$2" = "list" ]; then echo '[{"name":"forge-remote-board"}]'; exit 0; fi
exit 0
`,
);
chmodSync(join(bin, "cloudflared"), 0o755);

const AUD = "a".repeat(64);
const STATE_FILE = "remote-board-cloudflare-state.json";
const INGRESS_FILE = "remote-board-cloudflared.yml";

// The reachability PROBE runs INSIDE the forge child process, which we launch with a BLOCKING
// execFileSync — so the fake certs endpoint must live in its OWN process (an in-test http server
// could never accept the connection while execFileSync blocks the test's event loop). This tiny
// node server listens on a free port, answers the certs path 200, and prints `PORT=<n>`.
const CERTS_SERVER_SRC = `
const http = require("node:http");
const s = http.createServer((q, r) => {
  if (q.url && q.url.includes("/cdn-cgi/access/certs")) { r.writeHead(200, { "content-type": "application/json" }); r.end(JSON.stringify({ keys: [] })); }
  else { r.writeHead(404); r.end(); }
});
s.listen(0, "127.0.0.1", () => { process.stdout.write("PORT=" + s.address().port + "\\n"); });
`;

let certsServer: ChildProcess;
let certsUrl = "";
after(() => {
  certsServer?.kill();
  rmSync(root, { recursive: true, force: true });
});

async function startCertsServer(): Promise<void> {
  certsServer = spawn(process.execPath, ["-e", CERTS_SERVER_SRC], { stdio: ["ignore", "pipe", "ignore"] });
  const port = await new Promise<number>((resolvePort, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error("certs server did not start")), 10000);
    certsServer.stdout?.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      const m = buf.match(/PORT=(\d+)/);
      if (m) {
        clearTimeout(timer);
        resolvePort(Number(m[1]));
      }
    });
    certsServer.on("error", reject);
  });
  certsUrl = `http://127.0.0.1:${port}/cdn-cgi/access/certs`;
}

function invoke(args: string[], extra: Record<string, string> = {}): { stdout: string; status: number } {
  try {
    return {
      stdout: execFileSync(resolve(process.cwd(), "bin/forge"), args, {
        encoding: "utf8",
        env: { ...process.env, ...extra, FORGE_HOME: home, PATH: `${bin}:${process.env.PATH}`, CF_FAKE_LOG: log, FORGE_REMOTE_CLOUDFLARE_CERTS_URL: certsUrl },
      }),
      status: 0,
    };
  } catch (err) {
    const e = err as { stdout?: string; status?: number | null };
    return { stdout: e.stdout ?? "", status: e.status ?? 1 };
  }
}
function commands(): string[] {
  return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : [];
}
function clearLog(): void {
  writeFileSync(log, "");
}
/** cloudflared reads the fake answers; a MUTATION would be `tunnel run|create|delete` etc. */
function mutatingCommands(): string[] {
  return commands().filter((line) => /^(tunnel (run|create|delete)|access )/.test(line));
}

test("FG-784 AC1/AC4/AC6: built forge CLI refuses a bare tunnel, dry-runs, applies one owned ingress, and surgically disables it", async () => {
  // Start the out-of-process fake certs endpoint so the reachability probe stays on 127.0.0.1.
  await startCertsServer();

  // doctor accepts identity flags; setup additionally accepts --tunnel.
  const doctorFlags = ["--hostname", "board.example.com", "--team", "acme.cloudflareaccess.com", "--aud", AUD];
  const setupFlags = [...doctorFlags, "--tunnel", "forge-remote-board"];

  // AC4: a bare tunnel (no team/AUD) is refused, non-zero, nothing written.
  clearLog();
  const bare = invoke(["remote", "cloudflare", "doctor", "--hostname", "board.example.com", "--json"]);
  assert.equal(bare.status, 1);
  const bareReport = JSON.parse(bare.stdout);
  assert.equal(bareReport.ok, false);
  assert.ok(bareReport.refusals.some((x: string) => /no Access policy/i.test(x)));

  // doctor with full config → ready.
  clearLog();
  const doctor = invoke(["remote", "cloudflare", "doctor", ...doctorFlags, "--json"], { FORGE_DASHBOARD_REMOTE_TRANSPORT: "cloudflare" });
  assert.equal(doctor.status, 0);
  const report = JSON.parse(doctor.stdout);
  assert.equal(report.proposedTarget.loopback, "http://127.0.0.1:8025");
  assert.equal(report.ok, true);

  // AC1: dry-run writes nothing and issues no mutating cloudflared command.
  clearLog();
  const dry = invoke(["remote", "cloudflare", "setup", ...setupFlags, "--dry-run", "--confirm"]);
  assert.equal(dry.status, 0);
  assert.deepEqual(mutatingCommands(), [], "dry-run sends no mutation to cloudflared");
  assert.ok(!existsSync(join(home, INGRESS_FILE)));
  assert.ok(!existsSync(join(home, STATE_FILE)));

  // Apply.
  clearLog();
  const setup = invoke(["remote", "cloudflare", "setup", ...setupFlags, "--confirm"]);
  assert.equal(setup.status, 0);
  assert.deepEqual(mutatingCommands(), [], "apply runs no mutating cloudflared command");
  assert.ok(existsSync(join(home, INGRESS_FILE)));
  assert.ok(existsSync(join(home, STATE_FILE)));
  const ingress = readFileSync(join(home, INGRESS_FILE), "utf8");
  assert.match(ingress, /service: http:\/\/127\.0\.0\.1:8025/); // AC2 loopback-only

  // Disable removes only the owned files.
  clearLog();
  const disable = invoke(["remote", "cloudflare", "disable"]);
  assert.equal(disable.status, 0);
  assert.deepEqual(mutatingCommands(), []);
  assert.ok(!existsSync(join(home, INGRESS_FILE)));
  assert.ok(!existsSync(join(home, STATE_FILE)));
});
