// FG-614 regression guard: no test may create a tmux session on the DEFAULT socket.
//
// The tmux server is a host-wide daemon. It outlives every session and holds exactly ONE
// working directory — the first client's. A test that starts a session on the default
// socket from a fixture directory it later deletes therefore leaves the OPERATOR's server
// stuck in a dead directory, and from then on every `forge launch run` on the machine dies
// (ENOENT/uv_cwd) until someone runs `tmux kill-server` — which also kills unrelated live
// work. That is the FG-614 incident, and it was caused by a test, not by an operator.
//
// The mechanism is `TMUX_TMPDIR`, set once per test process in src/test-setup.ts: it
// relocates the socket DIRECTORY, so every tmux client in the process — including the CLI
// subprocesses tests spawn, which inherit the env — reaches a server private to that
// process, killed on exit. This file pins both halves: that the mechanism is armed, and
// that no tmux-touching test hands a subprocess an environment that escapes it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const srcRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("FG-614: the test process runs against its OWN tmux socket, never the default one", () => {
  const dir = process.env["TMUX_TMPDIR"];
  assert.ok(dir, "src/test-setup.ts must set TMUX_TMPDIR — without it every tmux test shares the operator's server");
  assert.match(dir!, /forge-test-tmux-/, `TMUX_TMPDIR must be a per-test-process directory, got ${dir}`);
  assert.ok(existsSync(dir!) && statSync(dir!).isDirectory(), "and it must exist, or tmux falls back to the default socket");
  // FG-680: TMUX_TMPDIR decides nothing while TMUX is set — a client naming no socket reads
  // TMUX first. This line only has teeth when the suite runs inside a pane (which is how
  // `forge launch run` runs it); `fg680-tmux-client-env.integration.test.ts` proves the
  // enforcement on any host by handing a test process a TMUX it must not reach.
  assert.equal(process.env["TMUX"], undefined, "src/test-setup.ts must DELETE TMUX — left set, every tmux client here reaches the operator's server");
});

function testFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) testFiles(full, out);
    else if (entry.name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

/** The literal starting at `open` (the index of its `{`), brace-matched. Good enough for
 *  an object literal in a test file: it has no strings containing unbalanced braces. */
function objectLiteralAt(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(open, i + 1);
  }
  return text.slice(open);
}

/** Every `env:` expression in `text`, resolved one level through a named const so
 *  `const e = { … }; spawnSync(x, y, { env: e })` is checked, not skipped. */
function envExpressions(text: string): string[] {
  const found: string[] = [];
  const re = /\benv:\s*(\{|[A-Za-z_$][\w$]*)/g;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    if (m[1] === "{") {
      found.push(objectLiteralAt(text, m.index + m[0].length - 1));
      continue;
    }
    const name = m[1]!;
    // `env: process.env` (and any `env: <ident>` naming it) inherits by definition.
    if (name === "process") continue;
    const decl = new RegExp(`\\b${name}\\s*(?::[^=\\n]+)?=\\s*\\{`).exec(text);
    // A parameter or an import we cannot resolve is not evidence of a violation — this
    // guard reports what it can PROVE, so an unresolvable name is left alone.
    found.push(decl === null ? "process.env" : objectLiteralAt(text, decl.index + decl[0].length - 1));
  }
  return found;
}

test("FG-614: every tmux-touching test inherits the isolated socket — no hand-built environment escapes TMUX_TMPDIR", () => {
  // The trigger: a file that can put a session on a socket. Either it runs tmux itself,
  // or it drives the real launch path (startLaunch / `campaign start`, which launches
  // drive-items under tmux). Files that only stub a TmuxRunner are included too — the
  // check costs them nothing and the trigger cannot tell a stub from the real thing.
  const touchesTmux = /(?:spawnSync|spawn|execFileSync|execFile)\(\s*"tmux"|\bstartLaunch\(|"campaign",\s*"start"/;
  const violations: string[] = [];

  for (const file of testFiles(srcRoot)) {
    const text = readFileSync(file, "utf8");
    if (!touchesTmux.test(text)) continue;
    for (const expr of envExpressions(text)) {
      const inherits = expr.includes("process.env") || expr.includes("TMUX_TMPDIR");
      const reintroducesTmux = /\bTMUX\s*:/.test(expr);
      if (!inherits || reintroducesTmux) violations.push(`${file.slice(srcRoot.length + 1)}: env ${expr.replace(/\s+/g, " ").slice(0, 90)}`);
    }
  }

  assert.deepEqual(
    violations,
    [],
    "a tmux-touching test built a subprocess environment that neither inherits process.env nor sets TMUX_TMPDIR, or explicitly reintroduced TMUX — " +
      "that subprocess can reach the DEFAULT tmux socket and brick the host's server (FG-614/FG-680). " +
      "Spread ...process.env, set TMUX_TMPDIR to a directory the test owns and kills on teardown, and never set TMUX.",
  );
});
