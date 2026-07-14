import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// FG-567 — bin/forge must report the child's fate faithfully.
//
// The harness below is bin/forge's REAL source with ONLY the spawn TARGET swapped (so the
// child is a script this test controls instead of the tsx CLI). The exit handler under test
// is bin/forge's own, verbatim — so the mutations this file exists to catch are mutations of
// bin/forge itself:
//
//   - `child.on("exit", (code) => process.exit(code ?? 0))`  → the SIGKILL/SIGTERM cases fail
//     (a killed child reports code=null, so the wrapper would exit 0: a killed control plane
//     claiming success).
//   - `if (signal) process.exit(128)`                        → the SIGKILL/SIGTERM cases fail
//     (128 is a number, not OS-signal evidence; a direct observer must still see `signal`).
//
// Every assertion reads the DIRECT observer's `(code, signal)` — this test process is the
// wrapper's parent. It deliberately does NOT read a shell's `$?`: a shell encodes a signalled
// exit as 128+signum, which is not itself signal evidence (a program can deliberately exit 143
// — the "numeric 143" case below pins exactly that distinction).

const BIN_FORGE = resolve(import.meta.dirname, "..", "..", "bin", "forge");
const REAL_SPAWN = `spawn(tsx, [entry, ...process.argv.slice(2)], { stdio: "inherit" })`;
const TEST_SPAWN = `spawn(process.execPath, process.argv.slice(2), { stdio: "inherit" })`;

let harness: string;
let dir: string;

before(() => {
  const source = readFileSync(BIN_FORGE, "utf8");
  assert.ok(
    source.includes(REAL_SPAWN),
    `bin/forge's spawn call changed shape — this test can no longer graft its exit handler onto a controllable child. Expected to find:\n  ${REAL_SPAWN}`,
  );
  dir = mkdtempSync(join(tmpdir(), "fg567-"));
  harness = join(dir, "wrapper.mjs");
  writeFileSync(harness, source.replace(REAL_SPAWN, TEST_SPAWN));
});

after(() => rmSync(dir, { recursive: true, force: true }));

/** Spawns the wrapper as a DIRECT child of this test process and reports what we observe of it. */
function observeWrapper(childScript: string): Promise<{ code: number | null; signal: string | null }> {
  return new Promise((res, rej) => {
    const wrapper = spawn(process.execPath, [harness, "-e", childScript], { stdio: "ignore" });
    wrapper.on("exit", (code, signal) => res({ code, signal }));
    wrapper.on("error", rej);
  });
}

// A wrapper that never exits (e.g. a future bin/forge that swallows the re-raised signal while
// holding the event loop open) would otherwise stall `node --test` indefinitely — it has no
// default per-test timeout. Cap each case so a regression fails loudly instead of hanging CI.
const CASE = { timeout: 10_000 };

test("bin/forge: child exits 0 → observer sees code=0, signal=null", CASE, async () => {
  assert.deepEqual(await observeWrapper("process.exit(0)"), { code: 0, signal: null });
});

test("bin/forge: child NUMERICALLY exits 143 → observer sees code=143, signal=null (stays numeric)", CASE, async () => {
  // A deliberate exit(143) is NOT a signalled death. The wrapper must pass the number through
  // rather than translating it into SIGTERM — otherwise "exited 143" and "killed by SIGTERM"
  // become indistinguishable to anything reading forge's exit.
  assert.deepEqual(await observeWrapper("process.exit(143)"), { code: 143, signal: null });
});

test("bin/forge: child killed by SIGTERM → observer sees code=null, signal=SIGTERM", CASE, async () => {
  assert.deepEqual(await observeWrapper("process.kill(process.pid, 'SIGTERM')"), { code: null, signal: "SIGTERM" });
});

test("bin/forge: child killed by SIGKILL → observer sees code=null, signal=SIGKILL (never exit 0)", CASE, async () => {
  // The reported bug: SIGKILL gives code=null, and `code ?? 0` turned that into a success exit.
  assert.deepEqual(await observeWrapper("process.kill(process.pid, 'SIGKILL')"), { code: null, signal: "SIGKILL" });
});
