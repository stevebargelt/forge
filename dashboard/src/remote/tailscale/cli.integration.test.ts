// FG-782 (step 5) INTEGRATION tier — spawns a REAL fake `tailscale` executable through the
// production runner (createTailscaleRunner) to prove the injected seam actually invokes the
// binary and fails CLOSED when the fake reports the daemon down. Unit-tier parser coverage is
// in cli.test.ts; this file is the only one that touches a process, hence *.integration.
//
// No real tailnet is required: the fake binary is a bash script written under a temp dir. It
// switches on argv and either prints canned whois/serve JSON (healthy) or exits non-zero with
// a "daemon down" message (unreachable), exactly as the real CLI does when tailscaled is off.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTailscaleRunner, whois, serveStatus } from "./cli.js";

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** Write a fake `tailscale` executable into a fresh temp dir and return its path. The script
 *  answers `whois --json` and `serve status --json`; when FAKE_TS_DOWN=1 is in its env it exits
 *  non-zero as the real CLI does when tailscaled is unreachable. */
function fakeTailscale(): string {
  const dir = mkdtempSync(join(tmpdir(), "fg782-fake-ts-"));
  dirs.push(dir);
  const bin = join(dir, "tailscale");
  const whoisJson = JSON.stringify({
    Node: { Name: "steve-mbp.tail1234.ts.net." },
    UserProfile: { LoginName: "steve@example.com" },
  });
  const serveJson = JSON.stringify({
    AllowFunnel: { "steve-mbp.tail1234.ts.net:443": true },
    Web: { "steve-mbp.tail1234.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:8025" } } } },
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
if [ "$1" = "serve" ] && [ "$2" = "status" ]; then
  cat <<'EOF'
${serveJson}
EOF
  exit 0
fi
echo "unexpected args: $*" 1>&2
exit 2
`;
  writeFileSync(bin, script, { mode: 0o755 });
  return bin;
}

test("createTailscaleRunner invokes the real fake binary and whois returns the confirmed identity", () => {
  const runner = createTailscaleRunner(fakeTailscale());
  const who = whois("100.101.102.103", runner);
  assert.ok(who, "a healthy fake daemon yields a confirmed peer");
  assert.equal(who.login, "steve@example.com");
  assert.equal(who.node, "steve-mbp.tail1234.ts.net");
  assert.equal(who.tailnet, "tail1234.ts.net");
});

test("serveStatus over the real fake binary parses the Funnel-enabled flag (AC5)", () => {
  const runner = createTailscaleRunner(fakeTailscale());
  const status = serveStatus(runner);
  assert.ok(status);
  assert.equal(status.funnel, true);
  assert.equal(status.proxies[0]?.target, "http://127.0.0.1:8025");
});

test("whois fails CLOSED (null) when the fake reports the daemon is down — no fallback identity", () => {
  // Point the runner at a fake that exits non-zero, exactly as the CLI does with tailscaled off.
  const bin = fakeTailscale();
  const prev = process.env.FAKE_TS_DOWN;
  process.env.FAKE_TS_DOWN = "1";
  try {
    const runner = createTailscaleRunner(bin);
    assert.equal(whois("100.101.102.103", runner), null);
    assert.equal(serveStatus(runner), null);
  } finally {
    if (prev === undefined) delete process.env.FAKE_TS_DOWN;
    else process.env.FAKE_TS_DOWN = prev;
  }
});

test("whois fails CLOSED when the binary does not exist (spawn error, ENOENT)", () => {
  const runner = createTailscaleRunner(join(tmpdir(), "fg782-nonexistent-tailscale-binary"));
  assert.equal(whois("100.101.102.103", runner), null);
});
