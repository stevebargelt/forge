import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { insertRun } from "../store/runs.js";
import { setQueryDbForTest } from "./queries.js";
import { startDashboard, closeServerForTest } from "./server.js";
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
