// FG-614: the launch must not depend on the tmux server's working directory.
//
// The incident (2026-07-24): a campaign-CLI integration test created a session on the
// DEFAULT tmux socket from a fixture directory, then deleted the fixture. The tmux
// server outlives every session and holds ONE working directory, so from that moment
// every `forge launch run` on the host died instantly — node reads its cwd during
// bootstrap (uv_cwd), so the `node -e` recorder was dead before executing a line, and
// the failure surfaced as an ENOENT stack trace that read as if the LAUNCHED COMMAND
// were at fault. `tmux new-session -c <valid dir>` was verified by hand NOT to rescue
// it. Recovery required `tmux kill-server`, which also killed an unrelated live
// dashboard.
//
// Three things are pinned here:
//   1. the launch enters the cwd FORGE RECORDED, by forge's own doing — proven against a
//      process whose cwd has genuinely been deleted under it (the exact condition a pane
//      forked from a bricked server inherits), and end-to-end against a real tmux server
//      whose own cwd has been deleted;
//   2. the condition is DIAGNOSED BY NAME — cause, remedy, and what the remedy costs —
//      rather than surfacing as a uv_cwd trace blamed on the child;
//   3. a launch that genuinely cannot establish its recorded cwd is a NAMED forge
//      refusal that `forge launch show` explains, never an owner that just vanished.
//
// Every tmux server started here lives on its OWN socket (TMUX_TMPDIR) and is killed on
// teardown — the discipline FG-614 exists to enforce.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LAUNCHES_DIR,
  LAUNCH_CWD_UNAVAILABLE_EXIT,
  buildWrapperCommand,
  parseExitRecord,
  probeTmuxServerCwd,
  readLaunch,
  shellQuote,
  startLaunch,
  tmuxServerCwdDiagnosis,
  type TmuxRunner,
} from "./launch.js";

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, "..", "cli", "index.ts");
const tsx = resolve(here, "..", "..", "node_modules", ".bin", "tsx");

const hasTmux = spawnSync("tmux", ["-V"], { encoding: "utf8" }).status === 0;

const scratch = mkdtempSync(join(tmpdir(), "fg614-"));
/** Socket dirs kept short: a unix socket path has a ~104-char limit and macOS's
 *  per-user tmpdir eats most of it. */
const sockets: string[] = [];

after(() => {
  for (const dir of sockets) {
    spawnSync("tmux", ["kill-server"], { stdio: "ignore", env: { ...process.env, TMUX_TMPDIR: dir } });
    rmSync(dir, { recursive: true, force: true });
  }
  rmSync(scratch, { recursive: true, force: true });
});

/** A tmux server on a socket of this test's own, started FROM `cwd` so the server
 *  inherits it — then `cwd` is deleted, which is the bricked condition. Returns a
 *  TmuxRunner bound to that socket. */
function brickedServer(cwd: string): TmuxRunner {
  const sock = mkdtempSync("/tmp/fg614-sock-");
  sockets.push(sock);
  const env = { ...process.env, TMUX_TMPDIR: sock };
  const start = spawnSync("tmux", ["new-session", "-d", "-s", "fg614-brick", "cat"], { cwd, env, encoding: "utf8" });
  assert.equal(start.status, 0, `the isolated tmux server should start: ${start.stderr}`);
  rmSync(cwd, { recursive: true, force: true });
  return (args) => execFileSync("tmux", args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", env });
}

/** Poll a real, out-of-process condition — a tmux-owned command is nobody's child. */
async function waitFor(what: string, cond: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail(`timed out after ${timeoutMs}ms waiting for: ${what}`);
}

/** A tmux stub that captures the pane command instead of running it, so the PRODUCTION
 *  wrapper string can be executed by hand under a condition tmux cannot be made to
 *  produce on demand. */
function capturingTmux(): { tmux: TmuxRunner; paneCommand: () => string } {
  let captured = "";
  const tmux: TmuxRunner = (args) => {
    if (args[0] === "respawn-pane") captured = args[args.length - 1]!;
    if (args[0] === "display-message") return "4242\n";
    return "";
  };
  return { tmux, paneCommand: () => captured };
}

// ── 1. the cwd the launch runs in is forge's, not the one it inherited ───────────

test("FG-614: the launch wrapper enters the RECORDED cwd even when the process that started it has a DELETED cwd", () => {
  // The reproduction, isolated from tmux: a process whose working directory was removed
  // from under it — exactly what a pane forked from a bricked server inherits. node dies
  // at bootstrap in this state (uv_cwd), so the recorder cannot rescue itself; the chdir
  // has to happen before node starts. THIS is the test that fails against pre-FG-614
  // source, where the pane command was the bare `node -e <recorder>`.
  const recorded = mkdtempSync(join(scratch, "recorded-"));
  const dead = mkdtempSync(join(scratch, "dead-"));
  const logPath = join(recorded, "out.log");
  const exitPath = join(recorded, "exit");

  const wrapper = buildWrapperCommand(
    [process.execPath, "-e", "process.stdout.write(process.cwd())"],
    logPath,
    exitPath,
    join(recorded, "runtime.json"),
    process.execPath,
    null,
    null,
    recorded,
  );

  // spawnSync cannot chdir INTO a deleted directory, so the condition is created from
  // inside the shell: enter it, delete it, then run the wrapper with it as cwd.
  const script = `cd ${shellQuote(dead)} && rm -rf ${shellQuote(dead)} && ${wrapper}`;
  const r = spawnSync("/bin/sh", ["-c", script], { encoding: "utf8" });

  assert.equal(r.status, 0, `the wrapper must survive a deleted inherited cwd: ${r.stdout}${r.stderr}`);
  assert.deepEqual(
    parseExitRecord(readFileSync(exitPath, "utf8")),
    { code: 0, signal: null },
    "the command ran to completion and the recorder wrote its terminal record",
  );
  const log = readFileSync(logPath, "utf8");
  assert.equal(
    log.trim(),
    realpathSync(recorded),
    "the command ran in the cwd FORGE RECORDED — not the dead one it inherited, and not a fallback",
  );
  // Pre-FG-614 this is precisely what the log held: the child inherited the dead cwd and
  // died reading it, so the launcher's condition surfaced as the CHILD's stack trace.
  assert.doesNotMatch(log, /uv_cwd|process\.cwd failed/, "no uv_cwd trace is ever attributed to the launched command");
});

test("FG-614 (acceptance): with a tmux server whose OWN working directory has been deleted, a launch still starts and runs in the recorded cwd", { skip: hasTmux ? false : "tmux not available" }, async () => {
  const fixture = mkdtempSync(join(scratch, "serverfix-"));
  const recorded = mkdtempSync(join(scratch, "e2e-"));
  const tmux = brickedServer(fixture);

  // Confirm the premise before asserting the fix: the server really does hold a deleted
  // directory. (Whether a PANE then inherits it is tmux-version dependent — macOS tmux
  // 3.5 did, and that is what bricked the host; the guard removes the dependency either
  // way, which is what this asserts.)
  const probe = probeTmuxServerCwd({ tmux });
  assert.ok(
    probe.state === "missing" || probe.state === "unprobed",
    `the server's cwd was deleted, so the probe must say missing (or say it could not read it): ${JSON.stringify(probe)}`,
  );

  const meta = startLaunch([process.execPath, "-e", "process.stdout.write(process.cwd())"], { name: "fg614e2e", cwd: recorded, tmux });
  await waitFor("the launch's exit record", () => existsSync(join(LAUNCHES_DIR, meta.id, "exit")));

  const v = readLaunch(meta.id, tmux)!;
  assert.deepEqual(v.status, { state: "exited_ok", code: 0 }, "the launch succeeded on a server whose cwd is gone");
  assert.equal(readFileSync(v.logPath, "utf8").trim(), realpathSync(recorded), "the command ran in the recorded cwd");
});

// ── 2. the condition is named, with the remedy and its cost ──────────────────────

test("FG-614: probeTmuxServerCwd NAMES a server whose working directory is gone — and never guesses when it cannot read one", { skip: hasTmux ? false : "tmux not available" }, () => {
  const fixture = mkdtempSync(join(scratch, "probefix-"));
  const resolved = realpathSync(fixture);
  const tmux = brickedServer(fixture);

  const probe = probeTmuxServerCwd({ tmux });
  if (probe.state === "unprobed") {
    // Honest on a platform whose process cwd forge cannot read: it says so, and says of
    // WHICH pid — it never reports `ok` (which would hide the condition) or `missing`
    // (which would accuse an operator's tmux server on no evidence).
    assert.match(probe.reason, /could not read the working directory of tmux server pid \d+/);
    return;
  }
  assert.equal(probe.state, "missing", `the deleted server cwd must be named missing: ${JSON.stringify(probe)}`);
  assert.equal(probe.state === "missing" ? probe.path : "", resolved, "the probe names the actual directory the server is stuck in");
  assert.ok(probe.state === "missing" && (probe.sessions ?? 0) >= 1, "it counted the sessions `tmux kill-server` would take with it");
});

test("FG-614: a live server with a live working directory probes `ok` — the diagnosis is not emitted for a healthy launcher", { skip: hasTmux ? false : "tmux not available" }, () => {
  const sock = mkdtempSync("/tmp/fg614-sock-");
  sockets.push(sock);
  const env = { ...process.env, TMUX_TMPDIR: sock };
  const healthy = mkdtempSync(join(scratch, "healthy-"));
  assert.equal(spawnSync("tmux", ["new-session", "-d", "-s", "fg614-ok", "cat"], { cwd: healthy, env, encoding: "utf8" }).status, 0);
  const tmux: TmuxRunner = (args) => execFileSync("tmux", args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", env });

  const probe = probeTmuxServerCwd({ tmux });
  assert.ok(probe.state === "ok" || probe.state === "unprobed", `a healthy server is never reported missing: ${JSON.stringify(probe)}`);
});

test("FG-614: the diagnosis names the CAUSE, the REMEDY, and what the remedy COSTS — an operator should not need lsof at 2am", () => {
  const withCost = tmuxServerCwdDiagnosis({ path: "/private/var/folders/T/forge-campaign-cli-proj-DTghEp", sessions: 4, livePanes: 2 });

  assert.match(withCost, /tmux server's own working directory no longer exists/, "the cause is the LAUNCHER's, and it is stated as such");
  assert.match(withCost, /forge-campaign-cli-proj-DTghEp/, "the offending directory is named");
  assert.match(withCost, /uv_cwd/, "it connects the condition to the error an operator actually sees");
  assert.match(withCost, /tmux kill-server/, "the remedy is stated exactly");
  assert.match(withCost, /4 tmux session\(s\), 2 of which still hold a live process/, "the COST is stated — killing the server kills live work");
  assert.match(withCost, /operator's call/, "and the remedy is the operator's decision, not forge's");
  assert.doesNotMatch(withCost, /forge (will|has) (kill|restart)ed/, "forge never claims to have restarted the server");

  // Uncounted is stated as uncounted rather than filled in with a plausible number.
  const noCost = tmuxServerCwdDiagnosis({ path: "/gone" });
  assert.match(noCost, /EVERY tmux session on this host/);
  assert.match(noCost, /could not count them/);
});

// ── 3. a launch that cannot establish its cwd is a named refusal ─────────────────

test("FG-614: startLaunch REFUSES by name when the recorded working directory does not exist — nothing is written, no session is created", () => {
  const gone = join(scratch, "never-existed");
  const { tmux } = capturingTmux();

  assert.throws(
    () => startLaunch(["true"], { name: "fg614gone", cwd: gone, tmux }),
    (e: Error) => {
      assert.match(e.message, /refusing to launch/);
      assert.match(e.message, new RegExp(gone.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "the refusal names the directory");
      assert.match(e.message, /does not exist/);
      return true;
    },
  );
  assert.equal(existsSync(join(LAUNCHES_DIR, "launch-fg614gone")), false, "no record was published for a launch that was refused");
});

test("FG-614: a submitting forge whose OWN working directory was deleted refuses by name — not with a raw uv_cwd message", () => {
  // The other half of the reported symptom: `process.cwd()` THROWS in this state, so the
  // launcher must name the condition instead of letting libuv's message stand alone. Driven
  // in a child process because the condition is the process's own cwd — this test process
  // cannot delete its own and keep running.
  const dead = mkdtempSync(join(scratch, "selfdead-"));
  const probe = join(scratch, "self-cwd-probe.ts");
  const launchModule = join(here, "launch.ts");
  const script = [
    `import { rmSync } from "node:fs";`,
    // Imported BEFORE the cwd is destroyed: a later dynamic import would itself need a cwd.
    `import { startLaunch } from ${JSON.stringify(launchModule)};`,
    `process.chdir(${JSON.stringify(dead)});`,
    `rmSync(${JSON.stringify(dead)}, { recursive: true, force: true });`,
    `try { startLaunch(["true"], { tmux: () => "" }); console.log("NO THROW"); }`,
    `catch (e) { console.log("THREW:" + (e as Error).message.split("\\n")[0]); }`,
  ].join("\n");
  writeFileSync(probe, script);

  const r = spawnSync(tsx, [probe], { encoding: "utf8", env: process.env });
  assert.match(r.stdout, /THREW:forge launch: refusing to launch/, `expected a named refusal, got: ${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /own working directory no longer exists/);
});

test("FG-614: when the recorded cwd disappears AFTER submission, the guard writes a NAMED diagnosis and a terminal record — `forge launch show` names the cause instead of echoing a uv_cwd trace", async () => {
  // The narrow race the guard still has to answer: the directory existed at submission
  // (startLaunch verified it) and was gone by the time the pane started. The launch must
  // NOT read as "owner gone without an exit record", and the reason must be FORGE's, in
  // words, not a node stack trace attributed to the child.
  const doomed = mkdtempSync(join(scratch, "doomed-"));
  const { tmux, paneCommand } = capturingTmux();
  const meta = startLaunch([process.execPath, "-e", "process.stdout.write('THE COMMAND RAN')"], { name: "fg614doomed", cwd: doomed, tmux });

  rmSync(doomed, { recursive: true, force: true });
  const r = spawnSync("/bin/sh", ["-c", paneCommand()], { encoding: "utf8" });
  assert.equal(r.status, LAUNCH_CWD_UNAVAILABLE_EXIT, `the guard exits with its own named code: ${r.stdout}${r.stderr}`);

  await waitFor("the guard's terminal exit record", () => existsSync(join(LAUNCHES_DIR, meta.id, "exit")));
  const v = readLaunch(meta.id, tmux)!;
  assert.deepEqual(v.status, { state: "exited_error", code: LAUNCH_CWD_UNAVAILABLE_EXIT }, "a terminal record, not owner_gone");

  assert.ok(v.diagnosis, "forge wrote its own explanation");
  assert.match(v.diagnosis!, /the command was NOT started/);
  assert.match(v.diagnosis!, /recorded cwd: /);
  assert.match(v.diagnosis!, /not a fault of the launched command/);
  assert.match(v.diagnosis!, /tmux kill-server/, "and it points at the host-wide condition that looks identical from the outside");
  assert.doesNotMatch(readFileSync(v.logPath, "utf8"), /THE COMMAND RAN/, "the command genuinely never ran");

  const show = spawnSync(tsx, [entry, "launch", "show", meta.id], { encoding: "utf8", env: process.env });
  assert.equal(show.status, 0, `forge launch show failed: ${show.stderr}`);
  assert.match(show.stdout, /diagnosis \(forge, not the launched command\)/, "`show` labels the cause as forge's, not the child's");
  assert.match(show.stdout, /could not enter the working directory it recorded/);
});
