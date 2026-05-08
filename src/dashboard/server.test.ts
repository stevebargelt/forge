import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { insertRun } from "../store/runs.js";
import { setQueryDbForTest } from "./queries.js";
import { startDashboard, closeServerForTest, _setRunForgeOverrideForTest } from "./server.js";
import type { Run } from "../types/index.js";

let db: DatabaseInstance;
let serverPort: number;

const RUN: Run = {
  id: "run-srv",
  workflow: "investigation",
  title: "server test run",
  status: "active",
  createdAt: "2026-05-06T00:00:00Z",
};

function get(path: string): Promise<{ status: number; body: string; contentType: string }> {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${serverPort}${path}`, (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      res.on("end", () => {
        resolve({
          status: res.statusCode ?? 0,
          body,
          contentType: res.headers["content-type"] ?? "",
        });
      });
    }).on("error", reject);
  });
}

function post(
  path: string,
  body: Record<string, unknown>,
  opts: { withHeader?: boolean } = { withHeader: true }
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(data)),
    };
    if (opts.withHeader !== false) headers["X-Forge-Request"] = "1";
    const req = http.request(
      { host: "127.0.0.1", port: serverPort, path, method: "POST", headers },
      (res) => {
        let chunks = "";
        res.on("data", (c: Buffer) => { chunks += c.toString(); });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: chunks }));
      }
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

before(async () => {
  db = makeInMemoryDb();
  setDbForTest(db);
  setQueryDbForTest(db);
  insertRun(RUN);

  // Port 0 → OS assigns an ephemeral port. We start the server, then inspect the address.
  // startDashboard binds to 127.0.0.1 with the given port. To get an ephemeral port we
  // temporarily patch the listen call by passing 0 and reading back the assigned port.
  // Instead, we start on a known free port by letting the OS pick via port 0 workaround:
  // start the server normally and capture the port from a net.createServer trick.
  const net = await import("node:net");
  await new Promise<void>((resolve) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const addr = probe.address() as { port: number };
      serverPort = addr.port;
      probe.close(() => resolve());
    });
  });

  await startDashboard(serverPort);
});

after(async () => {
  await closeServerForTest();
  db.close();
});

test("GET / returns 200 text/html", async () => {
  const res = await get("/");
  assert.equal(res.status, 200);
  assert.ok(res.contentType.includes("text/html"));
  assert.ok(res.body.includes("<!DOCTYPE html>"));
});

test("GET /api/runs returns 200 application/json with a runs array", async () => {
  const res = await get("/api/runs");
  assert.equal(res.status, 200);
  assert.ok(res.contentType.includes("application/json"));
  const data = JSON.parse(res.body) as { runs: unknown[] };
  assert.ok(Array.isArray(data.runs));
  assert.equal(data.runs.length, 1);
});

test("GET /api/runs/nonexistent returns 404", async () => {
  const res = await get("/api/runs/nonexistent");
  assert.equal(res.status, 404);
});

test("GET /api/tasks/nonexistent returns 404", async () => {
  const res = await get("/api/tasks/nonexistent");
  assert.equal(res.status, 404);
});

test("GET /unrecognised returns 404", async () => {
  const res = await get("/unrecognised");
  assert.equal(res.status, 404);
});

test("GET /api/meta reports interactive=false by default", async () => {
  delete process.env.FORGE_DASHBOARD_INTERACTIVE;
  const res = await get("/api/meta");
  assert.equal(res.status, 200);
  const data = JSON.parse(res.body) as { interactive: boolean };
  assert.equal(data.interactive, false);
});

test("GET /api/meta reports interactive=true when FORGE_DASHBOARD_INTERACTIVE=1", async () => {
  process.env.FORGE_DASHBOARD_INTERACTIVE = "1";
  try {
    const res = await get("/api/meta");
    assert.equal(res.status, 200);
    const data = JSON.parse(res.body) as { interactive: boolean };
    assert.equal(data.interactive, true);
  } finally {
    delete process.env.FORGE_DASHBOARD_INTERACTIVE;
  }
});

test("POST without X-Forge-Request header returns 403", async () => {
  process.env.FORGE_DASHBOARD_INTERACTIVE = "1";
  try {
    const res = await post("/api/gate/some-task", { decision: "advance" }, { withHeader: false });
    assert.equal(res.status, 403);
    assert.match(res.body, /X-Forge-Request/);
  } finally {
    delete process.env.FORGE_DASHBOARD_INTERACTIVE;
  }
});

test("POST when interactive is OFF returns 503", async () => {
  delete process.env.FORGE_DASHBOARD_INTERACTIVE;
  const res = await post("/api/gate/some-task", { decision: "advance" });
  assert.equal(res.status, 503);
  assert.match(res.body, /FORGE_DASHBOARD_INTERACTIVE/);
});

test("POST /api/gate/:taskId shells out to forge gate with the right argv", async () => {
  process.env.FORGE_DASHBOARD_INTERACTIVE = "1";
  let capturedArgs: string[] = [];
  _setRunForgeOverrideForTest(async (args) => {
    capturedArgs = args;
    return { exitCode: 0, stdout: "task-x complete", stderr: "" };
  });
  try {
    const res = await post("/api/gate/task-x", {
      decision: "advance",
      rationale: "looks good",
    });
    assert.equal(res.status, 200);
    assert.deepEqual(capturedArgs, ["gate", "task-x", "advance", "--rationale", "looks good"]);
    const data = JSON.parse(res.body) as { taskId: string; decision: string };
    assert.equal(data.taskId, "task-x");
    assert.equal(data.decision, "advance");
  } finally {
    _setRunForgeOverrideForTest(undefined);
    delete process.env.FORGE_DASHBOARD_INTERACTIVE;
  }
});

test("POST /api/gate validates decision", async () => {
  process.env.FORGE_DASHBOARD_INTERACTIVE = "1";
  try {
    const res = await post("/api/gate/task-x", { decision: "shrug" });
    assert.equal(res.status, 400);
  } finally {
    delete process.env.FORGE_DASHBOARD_INTERACTIVE;
  }
});

test("POST /api/gate adds --force flag when force=true", async () => {
  process.env.FORGE_DASHBOARD_INTERACTIVE = "1";
  let capturedArgs: string[] = [];
  _setRunForgeOverrideForTest(async (args) => {
    capturedArgs = args;
    return { exitCode: 0, stdout: "ok", stderr: "" };
  });
  try {
    await post("/api/gate/task-y", {
      decision: "advance",
      rationale: "approved override",
      force: true,
    });
    assert.deepEqual(capturedArgs, ["gate", "task-y", "advance", "--rationale", "approved override", "--force"]);
  } finally {
    _setRunForgeOverrideForTest(undefined);
    delete process.env.FORGE_DASHBOARD_INTERACTIVE;
  }
});

test("POST /api/gate surfaces non-zero exit as 500 with stderr", async () => {
  process.env.FORGE_DASHBOARD_INTERACTIVE = "1";
  _setRunForgeOverrideForTest(async () => ({ exitCode: 2, stdout: "", stderr: "task not found" }));
  try {
    const res = await post("/api/gate/task-x", { decision: "advance" });
    assert.equal(res.status, 500);
    assert.match(res.body, /task not found/);
  } finally {
    _setRunForgeOverrideForTest(undefined);
    delete process.env.FORGE_DASHBOARD_INTERACTIVE;
  }
});

test("POST /api/next/:runId shells out to forge next with --project", async () => {
  process.env.FORGE_DASHBOARD_INTERACTIVE = "1";
  let capturedArgs: string[] = [];
  _setRunForgeOverrideForTest(async (args) => {
    capturedArgs = args;
    return { exitCode: 0, stdout: "dispatched 3 tasks", stderr: "" };
  });
  try {
    const res = await post("/api/next/run-srv", { project: "/tmp/proj" });
    assert.equal(res.status, 200);
    assert.deepEqual(capturedArgs, ["next", "run-srv", "--project", "/tmp/proj"]);
  } finally {
    _setRunForgeOverrideForTest(undefined);
    delete process.env.FORGE_DASHBOARD_INTERACTIVE;
  }
});

test("POST /api/next/:runId works with no project", async () => {
  process.env.FORGE_DASHBOARD_INTERACTIVE = "1";
  let capturedArgs: string[] = [];
  _setRunForgeOverrideForTest(async (args) => {
    capturedArgs = args;
    return { exitCode: 0, stdout: "ok", stderr: "" };
  });
  try {
    await post("/api/next/run-srv", {});
    assert.deepEqual(capturedArgs, ["next", "run-srv"]);
  } finally {
    _setRunForgeOverrideForTest(undefined);
    delete process.env.FORGE_DASHBOARD_INTERACTIVE;
  }
});

test("POST /api/runs returns 501 (not implemented yet)", async () => {
  process.env.FORGE_DASHBOARD_INTERACTIVE = "1";
  try {
    const res = await post("/api/runs", { workflow: "investigation" });
    assert.equal(res.status, 501);
  } finally {
    delete process.env.FORGE_DASHBOARD_INTERACTIVE;
  }
});
