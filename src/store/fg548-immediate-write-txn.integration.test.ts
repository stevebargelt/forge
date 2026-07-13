// FG-548: two REAL forge processes finalizing DIFFERENT runs against ONE shared
// on-disk DB must never crash with SQLITE_BUSY.
//
// Why real processes: better-sqlite3 serializes transactions on a single
// connection, so two async drivers in one event loop can never reproduce this —
// the failure is a WAL snapshot upgrade losing to ANOTHER CONNECTION's commit.
// Two `forge next` / `forge gate` invocations are exactly that, and are the
// situation the defect occurs in.
//
// Why a barrier: the failing window is between the deferred txn's first read and
// its first write. A file barrier puts both processes inside that window on every
// iteration, so contention is by construction rather than by luck. Pre-fix (the
// deferred `getDb().transaction(...)` in completeRun) this harness fails within a
// handful of iterations with "SqliteError: database is locked"; post-fix (BEGIN
// IMMEDIATE via writeTransaction) the contention queues on busy_timeout instead.
//
// NO RETRY SHIM: the drivers do not catch and retry. A single SQLITE_BUSY is a
// hard failure of this test — that is the whole point of the ticket.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { getDb } from "./db.js";
import { insertRun, getRun } from "./runs.js";
import { nowIso } from "../util/ids.js";

const STORE_DIR = dirname(fileURLToPath(import.meta.url));

// Raise this to hammer it harder: FG548_ITERS=1000 npm run test:integration.
// The original failure reproduced ~1 in 4 runs, so 100 barrier-synchronized
// rounds is ~zero probability of a false green.
const ITERATIONS = Number(process.env["FG548_ITERS"] ?? 100);

function writeDriver(dir: string): string {
  const path = join(dir, "finalize-driver.mjs");
  writeFileSync(
    path,
    `
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDb } from ${JSON.stringify(join(STORE_DIR, "db.ts"))};
import { finalizeRunIfSettled } from ${JSON.stringify(join(STORE_DIR, "..", "v2", "run-finalize.ts"))};

const [side, other, barrierDir, iters] = process.argv.slice(2);
const n = Number(iters);

getDb();

let completed = 0;
for (let i = 0; i < n; i++) {
  // Rendezvous: neither side starts round i until both are at round i, so both
  // transactions open inside each other's read→write window.
  writeFileSync(join(barrierDir, side + "-" + i), "");
  const deadline = Date.now() + 60_000;
  while (!existsSync(join(barrierDir, other + "-" + i))) {
    if (Date.now() > deadline) throw new Error(side + ": barrier timeout at round " + i);
  }
  // No try/catch. A SQLITE_BUSY here must kill the process — no retry shim.
  if (finalizeRunIfSettled("run-fg548-" + side + "-" + i, "fg548-driver")) completed++;
}
process.stdout.write(JSON.stringify({ side, completed }) + "\\n");
process.exit(0);
`,
  );
  return path;
}

function runDriver(driver: string, side: string, other: string, barrierDir: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", driver, side, other, barrierDir, String(ITERATIONS)],
      { env: process.env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("exit", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    child.on("error", reject);
  });
}

test("FG-548: two real processes concurrently finalizing DIFFERENT runs on one DB never hit SQLITE_BUSY", { timeout: 600_000 }, async () => {
  const workdir = mkdtempSync(join(tmpdir(), "fg548-"));
  const barrierDir = mkdtempSync(join(tmpdir(), "fg548-barrier-"));
  try {
    // One active run per side per round. Different rows, different runs — the two
    // processes are NOT contending over the same row; they contend only over the
    // WAL write lock, which is precisely the bug.
    getDb();
    for (let i = 0; i < ITERATIONS; i++) {
      for (const side of ["a", "b"]) {
        insertRun({
          id: `run-fg548-${side}-${i}`,
          workflow: "feature",
          title: `fg548 ${side} ${i}`,
          status: "active",
          createdAt: nowIso(),
        });
      }
    }

    const driver = writeDriver(workdir);
    const [a, b] = await Promise.all([
      runDriver(driver, "a", "b", barrierDir),
      runDriver(driver, "b", "a", barrierDir),
    ]);

    for (const [side, res] of [["a", a], ["b", b]] as const) {
      assert.doesNotMatch(
        res.stderr,
        /database is locked|SQLITE_BUSY/,
        `driver ${side} hit SQLITE_BUSY — a write transaction on a multi-process path is still deferred:\n${res.stderr}`,
      );
      assert.equal(res.code, 0, `driver ${side} exited ${res.code}:\n${res.stderr}`);
      assert.equal(
        JSON.parse(res.stdout.trim().split("\n").pop() ?? "{}").completed,
        ITERATIONS,
        `driver ${side} did not complete all ${ITERATIONS} of its runs`,
      );
    }

    // Every run really is complete in the shared DB — the writes landed, they
    // weren't just swallowed.
    for (let i = 0; i < ITERATIONS; i++) {
      for (const side of ["a", "b"]) {
        assert.equal(getRun(`run-fg548-${side}-${i}`)?.status, "complete");
      }
    }
  } finally {
    rmSync(workdir, { recursive: true, force: true });
    rmSync(barrierDir, { recursive: true, force: true });
  }
});
