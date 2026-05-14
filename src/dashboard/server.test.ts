import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { insertRun, updateRunStatus } from "../store/runs.js";
import { insertTask } from "../store/tasks.js";
import type { Task } from "../types/index.js";
import { setQueryDbForTest } from "./queries.js";
import { startDashboard, closeServerForTest, _setRunForgeOverrideForTest } from "./server.js";
import type { Run } from "../types/index.js";

let db: DatabaseInstance;
let serverPort: number;

const RUN: Run = {
  id: "run-srv",
  workflow: "feature",
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

test("GET /api/meta reports interactive=true (always; #89 dropped the flag)", async () => {
  const res = await get("/api/meta");
  assert.equal(res.status, 200);
  const data = JSON.parse(res.body) as { interactive: boolean };
  assert.equal(data.interactive, true);
});

test("POST without X-Forge-Request header returns 403", async () => {
  const res = await post("/api/gate/some-task", { decision: "advance" }, { withHeader: false });
  assert.equal(res.status, 403);
  assert.match(res.body, /X-Forge-Request/);
});

test("POST /api/gate/:taskId shells out to forge gate with the right argv", async () => {
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
  }
});

test("POST /api/gate validates decision", async () => {
  const res = await post("/api/gate/task-x", { decision: "shrug" });
  assert.equal(res.status, 400);
});

test("POST /api/gate adds --force flag when force=true", async () => {
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
  }
});

test("POST /api/gate surfaces non-zero exit as 500 with stderr", async () => {
  _setRunForgeOverrideForTest(async () => ({ exitCode: 2, stdout: "", stderr: "task not found" }));
  try {
    const res = await post("/api/gate/task-x", { decision: "advance" });
    assert.equal(res.status, 500);
    assert.match(res.body, /task not found/);
  } finally {
    _setRunForgeOverrideForTest(undefined);
  }
});

// ----- #108: gate-advance auto-dispatches the next phase -----

function seedGateTask(id: string, runId: string): void {
  const task: Task = {
    id,
    runId,
    phase: "frame",
    agentRole: "framer",
    status: "awaiting_gate",
    taskPackage: {
      taskId: id,
      runId,
      phase: "frame",
      role: "framer",
      inputs: {},
      composedSystemPrompt: "",
    },
    createdAt: "2026-05-12T00:00:00Z",
  };
  insertTask(task);
}

test("POST /api/gate advance chains into forge next when the run is active", async () => {
  seedGateTask("task-chain-1", "run-srv");
  const captured: string[][] = [];
  _setRunForgeOverrideForTest(async (args) => {
    captured.push(args);
    return { exitCode: 0, stdout: "ok", stderr: "" };
  });
  try {
    const res = await post("/api/gate/task-chain-1", { decision: "advance" });
    assert.equal(res.status, 200);
    const data = JSON.parse(res.body) as { dispatched?: boolean };
    assert.equal(data.dispatched, true);
    // Two invocations: gate first, then next chained automatically.
    assert.equal(captured.length, 2);
    assert.deepEqual(captured[0], ["gate", "task-chain-1", "advance"]);
    assert.deepEqual(captured[1], ["next", "run-srv"]);
  } finally {
    _setRunForgeOverrideForTest(undefined);
  }
});

test("POST /api/gate does NOT chain into next on reject", async () => {
  seedGateTask("task-chain-2", "run-srv");
  const captured: string[][] = [];
  _setRunForgeOverrideForTest(async (args) => {
    captured.push(args);
    return { exitCode: 0, stdout: "ok", stderr: "" };
  });
  try {
    const res = await post("/api/gate/task-chain-2", { decision: "reject", rationale: "no" });
    assert.equal(res.status, 200);
    const data = JSON.parse(res.body) as { dispatched?: boolean };
    assert.equal(data.dispatched, undefined);
    // Only the gate call; no forge next.
    assert.equal(captured.length, 1);
    assert.equal(captured[0]?.[0], "gate");
  } finally {
    _setRunForgeOverrideForTest(undefined);
  }
});

test("POST /api/gate does NOT chain into next when the run is already complete", async () => {
  seedGateTask("task-chain-3", "run-srv");
  // Simulate gate.ts having finalized the run during advance (terminal phase).
  updateRunStatus("run-srv", "complete");
  const captured: string[][] = [];
  _setRunForgeOverrideForTest(async (args) => {
    captured.push(args);
    return { exitCode: 0, stdout: "ok", stderr: "" };
  });
  try {
    const res = await post("/api/gate/task-chain-3", { decision: "advance" });
    assert.equal(res.status, 200);
    const data = JSON.parse(res.body) as { dispatched?: boolean };
    assert.equal(data.dispatched, undefined);
    assert.equal(captured.length, 1);
  } finally {
    _setRunForgeOverrideForTest(undefined);
    // Restore for any later tests; in-memory DB is a singleton across this suite.
    updateRunStatus("run-srv", "active");
  }
});

test("POST /api/gate surfaces a 500 when the chained dispatch fails", async () => {
  seedGateTask("task-chain-4", "run-srv");
  let call = 0;
  _setRunForgeOverrideForTest(async () => {
    call++;
    if (call === 1) return { exitCode: 0, stdout: "ok", stderr: "" }; // gate ok
    return { exitCode: 1, stdout: "", stderr: "container crashed" };  // next fails
  });
  try {
    const res = await post("/api/gate/task-chain-4", { decision: "advance" });
    assert.equal(res.status, 500);
    assert.match(res.body, /Advanced .* but dispatch failed/);
    assert.match(res.body, /container crashed/);
  } finally {
    _setRunForgeOverrideForTest(undefined);
  }
});

test("POST /api/gate surfaces a 400 when the chained dispatch hits an auth error", async () => {
  seedGateTask("task-chain-5", "run-srv");
  let call = 0;
  _setRunForgeOverrideForTest(async () => {
    call++;
    if (call === 1) return { exitCode: 0, stdout: "ok", stderr: "" };
    return { exitCode: 1, stdout: "", stderr: "Auth error: Bedrock token expired" };
  });
  try {
    const res = await post("/api/gate/task-chain-5", { decision: "advance" });
    assert.equal(res.status, 400);
    assert.match(res.body, /Auth error/);
  } finally {
    _setRunForgeOverrideForTest(undefined);
  }
});

test("POST /api/next/:runId shells out to forge next with --project", async () => {
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
  }
});

test("POST /api/next/:runId works with no project", async () => {
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
  }
});

// ---------- /api/retry ----------

test("POST /api/retry/:taskId without X-Forge-Request → 403", async () => {
  const res = await post("/api/retry/task-x", {}, { withHeader: false });
  assert.equal(res.status, 403);
});

test("POST /api/retry/:taskId shells out to `forge retry <id>`", async () => {
  let capturedArgs: string[] = [];
  _setRunForgeOverrideForTest(async (args) => {
    capturedArgs = args;
    return { exitCode: 0, stdout: "Reset: task-x\n  status: pending\n", stderr: "" };
  });
  try {
    const res = await post("/api/retry/task-x", {});
    assert.equal(res.status, 200);
    assert.deepEqual(capturedArgs, ["retry", "task-x"]);
  } finally {
    _setRunForgeOverrideForTest(undefined);
  }
});

test("POST /api/retry surfaces non-zero exit as 500 with stderr", async () => {
  _setRunForgeOverrideForTest(async () => ({
    exitCode: 1,
    stdout: "",
    stderr: "Task task-x is in status 'complete', not failed.",
  }));
  try {
    const res = await post("/api/retry/task-x", {});
    assert.equal(res.status, 500);
    assert.match(res.body, /not failed/);
  } finally {
    _setRunForgeOverrideForTest(undefined);
  }
});

// ---------- /api/workflows + /api/runs (#66) ----------

test("GET /api/workflows returns the schema with order, groups, universal, workflows", async () => {
  const res = await get("/api/workflows");
  assert.equal(res.status, 200);
  const data = JSON.parse(res.body) as {
    order: string[];
    groups: { label: string; workflows: string[] }[];
    universal: unknown[];
    workflows: Record<string, unknown>;
  };
  assert.ok(Array.isArray(data.order));
  assert.ok(data.order.includes("feature"));
  assert.ok(Array.isArray(data.groups));
  assert.ok(data.groups.some((g) => g.label === "Build features"));
  assert.ok(Array.isArray(data.universal));
  assert.ok(data.workflows["feature"]);
});

test("POST /api/runs validates and returns 400 with field errors when fields missing", async () => {
  const res = await post("/api/runs", { workflow: "feature-ui-design-needed", title: "x", project: "/x" });
  assert.equal(res.status, 400);
  const data = JSON.parse(res.body) as { errors: { field: string; message: string }[] };
  assert.ok(Array.isArray(data.errors));
  assert.ok(data.errors.find((e) => e.field === "brief"));
  assert.ok(data.errors.find((e) => e.field === "designDir"));
});

test("POST /api/runs rejects unknown workflow with field=workflow", async () => {
  const res = await post("/api/runs", { workflow: "bogus", title: "x", project: "/x" });
  assert.equal(res.status, 400);
  const data = JSON.parse(res.body) as { errors: { field: string; message: string }[] };
  assert.ok(data.errors.find((e) => e.field === "workflow"));
});

test("POST /api/runs missing workflow → 400 with field=workflow", async () => {
  const res = await post("/api/runs", { title: "x", project: "/x" });
  assert.equal(res.status, 400);
  const data = JSON.parse(res.body) as { errors: { field: string; message: string }[] };
  assert.equal(data.errors[0]!.field, "workflow");
});

test("POST /api/runs shells out to `forge new` with the right argv (feature)", async () => {
  let capturedArgs: string[] = [];
  _setRunForgeOverrideForTest(async (args) => {
    capturedArgs = args;
    return { exitCode: 0, stdout: "Created run run-feat-abc123\nWorkflow: feature\n", stderr: "" };
  });
  try {
    const res = await post("/api/runs", {
      workflow: "feature",
      title: "feat",
      project: "/code/x",
      brief: "build a thing",
    });
    assert.equal(res.status, 200);
    assert.deepEqual(capturedArgs, ["new", "feature", "feat", "--project", "/code/x", "--brief", "build a thing"]);
    const data = JSON.parse(res.body) as { runId: string };
    assert.equal(data.runId, "run-feat-abc123");
  } finally {
    _setRunForgeOverrideForTest(undefined);
  }
});

test("POST /api/runs argv shape for feature-ui-design-needed includes brief + design-dir", async () => {
  let capturedArgs: string[] = [];
  _setRunForgeOverrideForTest(async (args) => {
    capturedArgs = args;
    return { exitCode: 0, stdout: "Created run run-w-xyz\n", stderr: "" };
  });
  try {
    await post("/api/runs", {
      workflow: "feature-ui-design-needed",
      title: "widget",
      project: "/code/forge",
      brief: "a stats widget",
      designDir: "/code/widget-design",
    });
    assert.deepEqual(capturedArgs, [
      "new",
      "feature-ui-design-needed",
      "widget",
      "--project", "/code/forge",
      "--brief", "a stats widget",
      "--design-dir", "/code/widget-design",
    ]);
  } finally {
    _setRunForgeOverrideForTest(undefined);
  }
});

test("POST /api/runs surfaces forge new failure as 500 with stderr", async () => {
  _setRunForgeOverrideForTest(async () => ({
    exitCode: 1,
    stdout: "",
    stderr: "forge: workflow already exists",
  }));
  try {
    const res = await post("/api/runs", {
      workflow: "feature",
      title: "x",
      project: "/x",
      brief: "x",
    });
    assert.equal(res.status, 500);
    assert.match(res.body, /workflow already exists/);
  } finally {
    _setRunForgeOverrideForTest(undefined);
  }
});

test("POST /api/runs without X-Forge-Request → 403", async () => {
  const res = await post("/api/runs", { workflow: "feature" }, { withHeader: false });
  assert.equal(res.status, 403);
});
