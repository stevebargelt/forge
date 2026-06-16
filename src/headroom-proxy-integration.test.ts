// Integration tests for the Rust headroom-proxy integration (FG-328)
//
// Tests cover:
//  1. install-headroom.sh install-rust-proxy command routing + binary install logic
//  2. run-headroom-proxy.sh: Rust binary preference over Python fallback, error paths
//  3. Proxy health check at /healthz with mock binary
//  4. Auth mode connectivity (bedrock, oauth, apikey) — mock proxy, no real creds needed

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, spawn, type ChildProcess } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  statSync,
  chmodSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// tsx resolves import.meta.url to the source file location (/project/src/...)
// so one level up ("../") gives the project root (/project/)
const PROJECT_ROOT = new URL("../", import.meta.url).pathname;
const INSTALL_SCRIPT = join(PROJECT_ROOT, "scripts", "install-headroom.sh");
const RUN_SCRIPT = join(PROJECT_ROOT, "scripts", "run-headroom-proxy.sh");

// Port well outside default 8787 range to avoid conflicts with a real running proxy
const PROXY_PORT = 18787;

// Python mock binary: parses --listen host:port, serves /healthz and /stats,
// counts POST requests. Stands in for the real Rust binary in exec tests.
const MOCK_PROXY_PYTHON = `#!/usr/bin/env python3
import sys, json
from http.server import HTTPServer, BaseHTTPRequestHandler

port = ${PROXY_PORT}
for i, a in enumerate(sys.argv):
    if a == '--listen' and i + 1 < len(sys.argv):
        try: port = int(sys.argv[i + 1].split(':')[-1])
        except: pass

req_count = [0]

class H(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/healthz':
            body = json.dumps({'status': 'healthy', 'config': {'bedrock_native': True}}).encode()
        elif self.path == '/stats':
            body = json.dumps({
                'requests': {'total': req_count[0], 'by_provider': {'bedrock': req_count[0]}}
            }).encode()
        else:
            self.send_response(404); self.end_headers(); return
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def do_POST(self):
        n = int(self.headers.get('Content-Length', 0))
        self.rfile.read(n)
        req_count[0] += 1
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(b'{}')
    def log_message(self, *a): pass

HTTPServer(('127.0.0.1', port), H).serve_forever()
`;

// Helpers

function runScript(
  script: string,
  args: string[],
  env: Record<string, string> = {},
): { stdout: string; stderr: string; code: number } {
  const result = spawnSync("bash", [script, ...args], {
    env: {
      HOME: process.env["HOME"] ?? "/tmp",
      PATH: process.env["PATH"] ?? "/usr/bin:/bin",
      TMPDIR: tmpdir(),
      ...env,
    },
    encoding: "utf8",
    timeout: 15_000,
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    code: result.status ?? 1,
  };
}

async function waitForHealthz(port: number, maxMs = 8_000): Promise<boolean> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise<void>((r) => setTimeout(r, 200));
  }
  return false;
}

// ── 1. install-headroom.sh command routing ────────────────────────────────

test("install-headroom.sh: no args exits 1 and shows usage including install-rust-proxy", () => {
  const r = runScript(INSTALL_SCRIPT, []);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /Usage:/);
  assert.match(r.stdout, /install-rust-proxy/);
});

test("install-headroom.sh: unknown command exits 1 with Unknown command in stderr", () => {
  const r = runScript(INSTALL_SCRIPT, ["not-a-real-command"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Unknown command/);
});

test("install-rust-proxy: exits non-zero when repo is missing and git clone fails", () => {
  const binDir = mkdtempSync(join(tmpdir(), "hproxy-bin-"));
  const stubDir = mkdtempSync(join(tmpdir(), "mock-stubs-"));
  try {
    // Stub cargo and brew (brew list exits 0 = already installed, skips brew install)
    writeFileSync(join(stubDir, "cargo"), "#!/bin/sh\nexit 0\n");
    writeFileSync(join(stubDir, "brew"), "#!/bin/sh\nexit 0\n");
    // Stub git to fail (simulates no network / repo unavailable)
    writeFileSync(join(stubDir, "git"), "#!/bin/sh\necho 'git: network unavailable' >&2; exit 1\n");
    for (const f of ["cargo", "brew", "git"]) chmodSync(join(stubDir, f), 0o755);

    const r = runScript(INSTALL_SCRIPT, ["install-rust-proxy"], {
      HEADROOM_RUST_REPO: "/no/such/repo/path/xyz-does-not-exist",
      HEADROOM_BIN_DIR: binDir,
      PATH: `${stubDir}:${process.env["PATH"] ?? "/usr/bin:/bin"}`,
    });
    assert.notEqual(r.code, 0, "should exit non-zero when repo is unavailable");
  } finally {
    rmSync(binDir, { recursive: true, force: true });
    rmSync(stubDir, { recursive: true, force: true });
  }
});

test("install-rust-proxy: copies pre-built binary to HEADROOM_BIN_DIR when cargo succeeds", () => {
  const repoDir = mkdtempSync(join(tmpdir(), "hproxy-repo-"));
  const binDir = mkdtempSync(join(tmpdir(), "hproxy-bin-"));
  const stubDir = mkdtempSync(join(tmpdir(), "mock-stubs-"));

  try {
    // Pre-populate target/release to simulate a successful cargo build output
    const releaseDir = join(repoDir, "target", "release");
    mkdirSync(releaseDir, { recursive: true });
    writeFileSync(join(releaseDir, "headroom-proxy"), "#!/bin/sh\necho mock-headroom-proxy\n");
    chmodSync(join(releaseDir, "headroom-proxy"), 0o755);

    // Stub cargo as a no-op and brew so `brew list onnxruntime` exits 0 (already installed)
    writeFileSync(join(stubDir, "cargo"), "#!/bin/sh\nexit 0\n");
    writeFileSync(join(stubDir, "brew"), "#!/bin/sh\nexit 0\n");
    for (const f of ["cargo", "brew"]) chmodSync(join(stubDir, f), 0o755);

    const r = runScript(INSTALL_SCRIPT, ["install-rust-proxy"], {
      HEADROOM_RUST_REPO: repoDir,
      HEADROOM_BIN_DIR: binDir,
      PATH: `${stubDir}:${process.env["PATH"] ?? "/usr/bin:/bin"}`,
    });

    assert.equal(r.code, 0, `Expected exit 0; stderr: ${r.stderr}`);
    assert.match(r.stdout, /headroom-proxy installed/);
    assert.match(r.stdout, new RegExp(binDir.replace(/[/\\]/g, ".")));

    // Binary should exist at the target path and be executable
    const installed = join(binDir, "headroom-proxy");
    const st = statSync(installed);
    assert.ok(st.isFile(), "installed binary should be a file");
    assert.ok((st.mode & 0o111) !== 0, "installed binary should be executable");
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
    rmSync(stubDir, { recursive: true, force: true });
  }
});

// ── 2. run-headroom-proxy.sh binary selection ─────────────────────────────

test("run-headroom-proxy.sh: exits with error when no binary and no Python venv", () => {
  const logDir = mkdtempSync(join(tmpdir(), "hproxy-log-"));
  try {
    const r = runScript(RUN_SCRIPT, [], {
      HEADROOM_BIN_DIR: "/nonexistent-xyz/bin",
      HEADROOM_VENV: "/nonexistent-xyz/venv",
      HEADROOM_LOG_FILE: join(logDir, "proxy.log"),
      TMPDIR: logDir,
    });
    assert.equal(r.code, 1, `Expected exit 1; got ${r.code}. stderr: ${r.stderr}`);
    assert.match(r.stderr, /venv not found|ERROR/);
  } finally {
    rmSync(logDir, { recursive: true, force: true });
  }
});

test("run-headroom-proxy.sh: selects Rust binary when executable binary is present", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "hproxy-sel-"));
  try {
    // Mock binary that exits immediately (just validates the script takes the Rust path)
    const mockBin = join(tmpDir, "headroom-proxy");
    writeFileSync(mockBin, "#!/bin/sh\nexit 0\n");
    chmodSync(mockBin, 0o755);

    const r = runScript(RUN_SCRIPT, [], {
      HEADROOM_BIN_DIR: tmpDir,
      HEADROOM_PORT: "18799",
      HEADROOM_LOG_FILE: join(tmpDir, "proxy.log"),
      TMPDIR: tmpDir,
    });

    // Script echoes "Starting Rust proxy" to its own stdout before exec-ing the binary
    assert.match(r.stdout, /Starting Rust proxy/i);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── 3 & 4. Live mock proxy: health check + auth mode connectivity ──────────
//
// Starts run-headroom-proxy.sh with a Python mock binary that serves /healthz
// and /stats, then verifies health and request counting for all three auth modes.
// No AWS credentials or Anthropic API keys required.

describe("headroom proxy: live mock instance", () => {
  let proxyDir = "";
  let proxyProc: ChildProcess | null = null;

  before(async () => {
    proxyDir = mkdtempSync(join(tmpdir(), "hproxy-live-"));

    // Write mock binary (Python HTTP server that acts as headroom-proxy)
    const mockBin = join(proxyDir, "headroom-proxy");
    writeFileSync(mockBin, MOCK_PROXY_PYTHON);
    chmodSync(mockBin, 0o755);

    // Start proxy via the real run-headroom-proxy.sh script.
    // stdio: 'ignore' prevents pipe buffer issues; proxy output goes to log file anyway.
    proxyProc = spawn("bash", [RUN_SCRIPT], {
      env: {
        HOME: process.env["HOME"] ?? "/tmp",
        PATH: process.env["PATH"] ?? "/usr/bin:/bin",
        HEADROOM_BIN_DIR: proxyDir,
        HEADROOM_PORT: String(PROXY_PORT),
        HEADROOM_LOG_FILE: join(proxyDir, "proxy.log"),
        TMPDIR: proxyDir,
        BEDROCK_REGION: "us-east-1",
      },
      stdio: "ignore",
    });

    const started = await waitForHealthz(PROXY_PORT, 10_000);
    if (!started) {
      throw new Error(`Mock headroom proxy failed to start on port ${PROXY_PORT} within 10s`);
    }
  });

  after(() => {
    proxyProc?.kill("SIGKILL");
    if (proxyDir) rmSync(proxyDir, { recursive: true, force: true });
  });

  // -- Health check --

  test("proxy: /healthz returns 200 with status=healthy", async () => {
    const res = await fetch(`http://127.0.0.1:${PROXY_PORT}/healthz`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body["status"], "healthy");
  });

  test("proxy: /healthz reports bedrock_native=true (Rust binary feature flag)", async () => {
    const res = await fetch(`http://127.0.0.1:${PROXY_PORT}/healthz`);
    const body = (await res.json()) as { config?: { bedrock_native?: unknown } };
    assert.equal(body.config?.bedrock_native, true);
  });

  test("proxy: /stats returns a numeric request count", async () => {
    const res = await fetch(`http://127.0.0.1:${PROXY_PORT}/stats`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { requests: { total: number } };
    assert.ok(
      typeof body.requests.total === "number",
      `/stats.requests.total should be a number, got ${typeof body.requests.total}`,
    );
  });

  // -- Auth mode connectivity --

  test("bedrock mode: proxy accepts Bedrock InvokeModel POST and increments request count", async () => {
    const before = (await fetch(`http://127.0.0.1:${PROXY_PORT}/stats`).then(
      (r) => r.json(),
    )) as { requests: { total: number } };

    // Simulate a Bedrock InvokeModel call (CLAUDE_CODE_USE_BEDROCK=1 path)
    await fetch(
      `http://127.0.0.1:${PROXY_PORT}/model/anthropic.claude-3-sonnet-20240229-v1:0/invoke`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ anthropic_version: "bedrock-2023-05-31", messages: [] }),
      },
    );

    const after = (await fetch(`http://127.0.0.1:${PROXY_PORT}/stats`).then(
      (r) => r.json(),
    )) as { requests: { total: number } };

    assert.equal(
      after.requests.total,
      before.requests.total + 1,
      "Bedrock-mode POST should increment proxy request count",
    );
  });

  test("oauth mode: Anthropic messages API request through proxy is accepted and counted", async () => {
    const before = (await fetch(`http://127.0.0.1:${PROXY_PORT}/stats`).then(
      (r) => r.json(),
    )) as { requests: { total: number } };

    // Simulate oauth-mode request (no api key header, uses OAuth token in Authorization)
    await fetch(`http://127.0.0.1:${PROXY_PORT}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
        Authorization: "Bearer stub-oauth-token-not-real",
      },
      body: JSON.stringify({ model: "claude-opus-4-5", messages: [] }),
    });

    const after = (await fetch(`http://127.0.0.1:${PROXY_PORT}/stats`).then(
      (r) => r.json(),
    )) as { requests: { total: number } };

    assert.equal(
      after.requests.total,
      before.requests.total + 1,
      "OAuth-mode POST should be accepted by proxy and increment count",
    );
  });

  test("apikey mode: API-key authenticated request through proxy is accepted and counted", async () => {
    const before = (await fetch(`http://127.0.0.1:${PROXY_PORT}/stats`).then(
      (r) => r.json(),
    )) as { requests: { total: number } };

    // Simulate apikey-mode request (ANTHROPIC_API_KEY set, x-api-key header)
    await fetch(`http://127.0.0.1:${PROXY_PORT}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-api-key": "stub-api-key-not-real",
      },
      body: JSON.stringify({ model: "claude-opus-4-5", messages: [] }),
    });

    const after = (await fetch(`http://127.0.0.1:${PROXY_PORT}/stats`).then(
      (r) => r.json(),
    )) as { requests: { total: number } };

    assert.equal(
      after.requests.total,
      before.requests.total + 1,
      "API-key-mode POST should be accepted by proxy and increment count",
    );
  });
});
