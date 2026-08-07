#!/usr/bin/env node
// FG-576 step 7 — the FAKE `codex` executable the Codex adapter's behavioral tests spawn.
//
// AC13 is binding: no test may start a billed interactive session, mutate real auth, or
// write into the operator's real Codex config root. So every test that proves something
// about argv, cwd, the child environment, the AC8 capability gate, the receipt or the
// post-spawn session correlation runs against THIS, placed on PATH as `codex` ahead of
// any real one. It talks to no network and reads no credential.
//
// Controlled entirely by environment, so one fixture serves every scenario:
//
//   FAKE_CODEX_RECORD     file to write the observed launch to (JSON). Written on every
//                         non-`--version` invocation, before anything else, so a test
//                         can assert on argv even when the run then blocks.
//   FAKE_CODEX_VERSION    what `--version` prints. Defaults to a build that carries the
//                         instructions-file capability; set it to an older version for
//                         the AC8 regression, or to "" for a build that answers nothing.
//   FAKE_CODEX_MODE       exit0 (default) | exit:<n> | hold | crash
//                           hold  — run until signalled, for correlation/liveness tests.
//                           crash — exit(1) immediately without recording.
//   FAKE_CODEX_READY      file to touch once the launch has been recorded, so a test can
//                         wait on a real event instead of sleeping.
//   FAKE_CODEX_SESSIONS   a DISPOSABLE Codex state root. When set, the fake writes a
//                         rollout session file the way codex does — sessions/YYYY/MM/DD/
//                         rollout-<ts>-<uuid>.jsonl with a session_meta first line — so
//                         the post-spawn correlation has something real to read. Never
//                         the operator's ~/.codex: the tests point it at a mkdtemp dir,
//                         and CODEX_HOME is never set by anything in this path.
//   FAKE_CODEX_EXTRA_SESSIONS
//                         how many ADDITIONAL sessions to write for the same project,
//                         standing in for a second Codex session the operator started in
//                         the same project inside the correlation window (AC9).

import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

const argv = process.argv.slice(2);

if (argv.includes("--version") || argv.includes("-V")) {
  const version = process.env.FAKE_CODEX_VERSION ?? "codex-cli 0.144.1";
  process.stdout.write(`${version}\n`);
  process.exit(0);
}

const mode = process.env.FAKE_CODEX_MODE ?? "exit0";

if (mode === "crash") process.exit(1);

const record = process.env.FAKE_CODEX_RECORD;
if (record) {
  writeFileSync(
    record,
    `${JSON.stringify(
      {
        argv,
        cwd: process.cwd(),
        pid: process.pid,
        ppid: process.ppid,
        // The WHOLE child environment: an isolation test has to be able to assert that
        // a variable is ABSENT, which a curated subset could never prove.
        env: process.env,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

// The session state codex itself would write. `--cd` is what Forge passes as the
// project root, so the session declares the same cwd a real one would.
function writeSessions() {
  const sessionsRoot = process.env.FAKE_CODEX_SESSIONS;
  if (!sessionsRoot) return;
  const cdIndex = argv.indexOf("--cd");
  const cwd = cdIndex >= 0 && argv[cdIndex + 1] ? argv[cdIndex + 1] : process.cwd();
  const dir = join(sessionsRoot, "sessions", "2026", "08", "07");
  mkdirSync(dir, { recursive: true });
  const extra = Number(process.env.FAKE_CODEX_EXTRA_SESSIONS ?? "0") || 0;
  for (let i = 0; i <= extra; i += 1) {
    const id = randomUUID();
    const meta = { type: "session_meta", payload: { id, timestamp: "2026-08-07T12:00:0" + i + "Z", cwd, originator: "fake_codex" } };
    writeFileSync(join(dir, `rollout-2026-08-07T12-00-0${i}-${id}.jsonl`), `${JSON.stringify(meta)}\n`, "utf8");
  }
}

if (process.env.FAKE_CODEX_READY) {
  writeFileSync(process.env.FAKE_CODEX_READY, "ready\n", "utf8");
}

if (mode === "hold") {
  // A real codex writes its rollout file once the session is up, which is AFTER the
  // launcher has taken its correlation baseline. Reproducing that ordering is the
  // point: a session file that already existed at spawn is by definition not one this
  // launch created, and the correlation must not be handed an easier problem than the
  // real one.
  setTimeout(writeSessions, Number(process.env.FAKE_CODEX_SESSION_DELAY_MS ?? "150") || 0);
} else {
  writeSessions();
}

if (mode === "hold") {
  // Stay alive until the test signals or kills us — but never outlive the launcher.
  const parent = process.ppid;
  setInterval(() => {
    if (process.ppid !== parent) process.exit(0);
  }, 100);
  process.on("SIGTERM", () => process.exit(143));
  process.on("SIGINT", () => process.exit(130));
} else if (mode.startsWith("exit:")) {
  process.exit(Number(mode.slice("exit:".length)) || 0);
} else {
  process.exit(0);
}
