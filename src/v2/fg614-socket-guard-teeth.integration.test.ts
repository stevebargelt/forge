// FG-614: the socket-isolation guard has TEETH.
//
// `fg614-tmux-socket-isolation.test.ts` is the standing guard: it asserts TMUX_TMPDIR is
// armed for the test process, and scans every `*.test.ts` under src/ for a hand-built
// subprocess environment that would escape it onto the DEFAULT tmux socket — the exact
// mechanism by which a test bricked the operator's host in the FG-614 incident.
//
// A guard that always passes is indistinguishable from no guard. The implementer showed
// by hand, once, that it fails on a violation; this file makes that a STANDING test, on
// both halves:
//
//   * a tmux-touching test that hands a subprocess an environment escaping TMUX_TMPDIR
//     FAILS the guard, and the failure NAMES the offending file (an unnamed failure is
//     not actionable in a 2773-test run);
//   * a compliant tmux-touching test PASSES it (a guard that fires on everything gets
//     deleted);
//   * the TMUX_TMPDIR assertion itself fails when the mechanism is not armed.
//
// It is driven against a COPY of the real guard, in a temp tree of synthetic test files.
// The copy is read from disk, never re-typed here, so it cannot drift from the guard it
// claims to test — and the guard derives its scan root from its own location, so the
// copy scans the temp tree rather than src/. Nothing here touches tmux: the synthetic
// violation is only ever READ by the scanner, never executed.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const guardSource = join(here, "fg614-tmux-socket-isolation.test.ts");
const tsx = resolve(here, "..", "..", "node_modules", ".bin", "tsx");

const scratch = mkdtempSync(join(tmpdir(), "fg614teeth-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

// Assembled rather than written literally: this file is itself scanned by the real
// guard, and a literal `env:` object with no `process.env` in it would make THIS file
// the violation it is describing. The key is spliced in from an uppercase constant so
// the guard's lowercase `env:` pattern never matches our own source.
const KEY = "env";

/** A test file that reaches the DEFAULT tmux socket: it runs tmux, and hands the
 *  subprocess an environment built from scratch. This is the FG-614 incident in one
 *  file. */
const LEAKY = [
  `import { spawnSync } from "node:child_process";`,
  `export function bricksTheHost(): void {`,
  `  spawnSync("tmux", ["new-session", "-d", "-s", "leak", "cat"], { ${KEY}: { PATH: "/usr/bin:/bin" } });`,
  `}`,
].join("\n");

/** The same file done right — the ONLY difference is that the environment inherits. */
const COMPLIANT = [
  `import { spawnSync } from "node:child_process";`,
  `export function isolated(): void {`,
  `  spawnSync("tmux", ["new-session", "-d", "-s", "ok", "cat"], { ${KEY}: { ...process.env, TMUX_TMPDIR: "/tmp/x" } });`,
  `}`,
].join("\n");

/** A copy of the REAL guard in its own scan root, plus whatever synthetic test files
 *  the case needs. The guard walks `<root>` (it resolves `..` from its own directory),
 *  so the copy lives one level down exactly as the original does under src/v2. */
function guardTreeWith(files: Record<string, string>, label: string): string {
  const root = join(scratch, label);
  mkdirSync(join(root, "v2"), { recursive: true });
  copyFileSync(guardSource, join(root, "v2", "fg614-tmux-socket-isolation.test.ts"));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return join(root, "v2", "fg614-tmux-socket-isolation.test.ts");
}

function runGuard(guardCopy: string, environment: NodeJS.ProcessEnv): { status: number | null; output: string } {
  const r = spawnSync(tsx, ["--test", guardCopy], { encoding: "utf8", env: environment });
  return { status: r.status, output: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/** The environment for a guard run: this process's own (so the isolated socket is
 *  inherited and the guard's arming assertion is satisfied — the SCAN result is what is
 *  under test), minus `NODE_TEST_CONTEXT`. node:test refuses to run nested inside
 *  another runner's context and would skip the file with a warning and exit 0, which
 *  reads as "the guard passed". */
function guardEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env, ...overrides };
  delete e["NODE_TEST_CONTEXT"];
  return e;
}

const armed: NodeJS.ProcessEnv = guardEnv();

test("FG-614: the socket-isolation guard FAILS on a tmux-touching test that escapes TMUX_TMPDIR — and NAMES the file", () => {
  const guardCopy = guardTreeWith({ "leaky/bricks-the-host.test.ts": LEAKY }, "violation");
  const run = runGuard(guardCopy, armed);

  assert.notEqual(run.status, 0, `the guard must FAIL on a violation, otherwise it is decoration:\n${run.output}`);
  assert.match(run.output, /bricks-the-host\.test\.ts/, "the failure names the offending FILE — a bare count is not actionable across thousands of tests");
  assert.match(run.output, /leaky\//, "…by its path relative to the scan root, so it can be opened");
  assert.match(run.output, /DEFAULT tmux socket/, "and it explains the consequence, not just that a rule was broken");
  assert.match(run.output, /Spread \.\.\.process\.env/, "…and states the remedy");
  assert.match(run.output, /no hand-built environment escapes TMUX_TMPDIR/, "the failure is the scan test, not an unrelated error");
});

test("FG-614: the guard PASSES a tmux-touching test whose subprocess environment inherits — it fires on the violation, not on tmux", () => {
  const guardCopy = guardTreeWith({ "compliant/isolated.test.ts": COMPLIANT }, "compliant");
  const run = runGuard(guardCopy, armed);

  assert.equal(run.status, 0, `a compliant tmux-touching test must not be flagged — a guard that fires on everything gets deleted:\n${run.output}`);
  assert.match(run.output, /pass 2/, "both halves of the guard actually ran");
});

test("FG-614: the guard's arming assertion has teeth too — with TMUX_TMPDIR absent it fails and names where it should be set", () => {
  // Proves the first assertion is not vacuously true of any environment: without the
  // isolation, the guard says so. (The scan half still passes — the tree is clean —
  // so the failure below is unambiguously the arming half.)
  const unarmed = guardEnv();
  delete unarmed["TMUX_TMPDIR"];

  const guardCopy = guardTreeWith({}, "unarmed");
  const run = runGuard(guardCopy, unarmed);

  assert.notEqual(run.status, 0, `an unarmed test process must be reported, not tolerated:\n${run.output}`);
  assert.match(run.output, /src\/test-setup\.ts must set TMUX_TMPDIR/, "it names the file that must arm the isolation");
  assert.match(run.output, /pass 1/, "…and only the arming half failed");
});

test("FG-614: the guard rejects a TMUX_TMPDIR that is not a per-test-process directory — a shared socket dir is not isolation", () => {
  // The isolation is per-PROCESS. Pointing every run at one shared directory would
  // satisfy a naive "is it set?" check while re-creating the shared-server condition
  // between concurrently running test files.
  const shared = guardEnv({ TMUX_TMPDIR: "/tmp" });
  const guardCopy = guardTreeWith({}, "shared");
  const run = runGuard(guardCopy, shared);

  assert.notEqual(run.status, 0, `a shared socket directory must not satisfy the guard:\n${run.output}`);
  assert.match(run.output, /per-test-process directory/, "the reason is named");
});
