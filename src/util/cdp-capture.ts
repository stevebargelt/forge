import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { get as httpGet } from "node:http";
import WebSocket from "ws";
import type { StorageState, StorageStateCookie } from "./auth-profiles.js";

// #176 Slice 1 capture: launch a real, visible Chrome with a throwaway profile,
// let the human log in (incl. MFA), then snapshot the session via raw CDP into a
// Playwright-storageState-shaped object. Zero browser-automation deps — forge is
// the orchestrator, not a browser harness.

// Common macOS / Linux Chrome locations; override with FORGE_CHROME_BIN.
const CHROME_CANDIDATES = [
  process.env.FORGE_CHROME_BIN,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter((p): p is string => !!p);

function findChrome(): string {
  for (const c of CHROME_CANDIDATES) if (existsSync(c)) return c;
  throw new Error(
    "Could not find a Chrome/Chromium binary. Set FORGE_CHROME_BIN to its path.",
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Chrome writes <user-data-dir>/DevToolsActivePort once the debugger is up:
// line 1 is the chosen port (we pass 0 so it picks a free one).
async function waitForDebugPort(userDataDir: string, timeoutMs = 15000): Promise<number> {
  const file = join(userDataDir, "DevToolsActivePort");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(file)) {
      const port = Number(readFileSync(file, "utf8").split("\n")[0]?.trim());
      if (Number.isInteger(port) && port > 0) return port;
    }
    await sleep(100);
  }
  throw new Error("Chrome did not expose a debugging port in time.");
}

function fetchJson(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    httpGet(url, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(e as Error);
        }
      });
    }).on("error", reject);
  });
}

interface CdpTarget {
  type: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

function promptEnter(message: string): Promise<void> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(message, () => {
      rl.close();
      resolve();
    });
  });
}

// Minimal request/response CDP client over a single page target's WebSocket.
class CdpSession {
  private ws: WebSocket;
  private id = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (data: Buffer | string) => {
      const msg = JSON.parse(data.toString()) as {
        id?: number;
        result?: unknown;
        error?: { message: string };
      };
      if (typeof msg.id === "number" && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      }
    });
  }

  static connect(wsUrl: string): Promise<CdpSession> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      ws.once("open", () => resolve(new CdpSession(ws)));
      ws.once("error", () => reject(new Error(`CDP websocket failed: ${wsUrl}`)));
    });
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close(): void {
    this.ws.close();
  }
}

interface CdpCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

export interface CaptureResult {
  state: StorageState;
  capturedOrigin: string;
}

// Launch Chrome at `url`, wait for the human to finish logging in, then capture
// localStorage (for the active page's origin) + cookies into a StorageState.
export async function captureViaBrowser(url: string): Promise<CaptureResult> {
  const chrome = findChrome();
  const userDataDir = mkdtempSync(join(tmpdir(), "forge-auth-capture-"));
  let proc: ChildProcess | undefined;
  try {
    proc = spawn(
      chrome,
      [
        "--remote-debugging-port=0",
        `--user-data-dir=${userDataDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--new-window",
        url,
      ],
      { stdio: "ignore", detached: false },
    );

    const port = await waitForDebugPort(userDataDir);
    console.log(`\nChrome is open. Log in to the app (including any MFA).`);
    console.log(`When you're fully logged in and looking at the app, come back here.`);
    await promptEnter(`Press Enter to capture the session… `);

    const targets = (await fetchJson(`http://127.0.0.1:${port}/json/list`)) as CdpTarget[];
    const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
    if (!page?.webSocketDebuggerUrl) throw new Error("No page target found to capture from.");

    const cdp = await CdpSession.connect(page.webSocketDebuggerUrl);
    try {
      await cdp.send("Network.enable");
      const evalRes = (await cdp.send("Runtime.evaluate", {
        expression:
          "JSON.stringify({origin: location.origin, ls: Object.fromEntries(Object.entries(localStorage))})",
        returnByValue: true,
      })) as { result?: { value?: string } };
      const payload = JSON.parse(evalRes.result?.value ?? "{}") as {
        origin?: string;
        ls?: Record<string, string>;
      };
      const origin = payload.origin ?? new URL(url).origin;
      const ls = payload.ls ?? {};

      const cookieRes = (await cdp.send("Network.getCookies")) as { cookies?: CdpCookie[] };
      const cookies: StorageStateCookie[] = (cookieRes.cookies ?? []).map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        expires: typeof c.expires === "number" ? c.expires : -1,
        httpOnly: !!c.httpOnly,
        secure: !!c.secure,
        ...(c.sameSite ? { sameSite: c.sameSite } : {}),
      }));

      const state: StorageState = {
        cookies,
        origins: [
          {
            origin,
            localStorage: Object.entries(ls).map(([name, value]) => ({ name, value })),
          },
        ],
      };
      return { state, capturedOrigin: origin };
    } finally {
      cdp.close();
    }
  } finally {
    if (proc && proc.pid) {
      try {
        proc.kill();
      } catch {
        /* best-effort */
      }
    }
    try {
      rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}
