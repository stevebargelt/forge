#!/usr/bin/env node
// FG-576 — the FAKE `claude` executable the launcher's behavioral tests spawn.
//
// AC13 is binding: no test may start a billed interactive session, mutate real auth,
// or overwrite the operator's installed Claude settings. So every test that proves
// something about argv, cwd, the child environment, the receipt lifecycle or the
// liveness record runs against THIS, placed on PATH as `claude` ahead of any real
// one. It talks to no network and reads no credential.
//
// Controlled entirely by environment, so one fixture serves every scenario:
//
//   FAKE_CLAUDE_RECORD    file to write the observed launch to (JSON). Written on
//                         every non-`--help` invocation, before anything else, so a
//                         test can assert on argv even when the run then blocks.
//   FAKE_CLAUDE_HELP      what `--help` prints. Defaults to a help text advertising
//                         --append-system-prompt-file. Set to "" for a build that
//                         advertises no instruction flag at all.
//   FAKE_CLAUDE_MODE      exit0 (default) | exit:<n> | hold | crash
//                           hold  — run until signalled, for liveness/SIGKILL tests.
//                           crash — exit(1) immediately without recording.
//   FAKE_CLAUDE_READY     file to touch once the launch has been recorded, so a test
//                         can wait on a real event instead of sleeping.

import { writeFileSync } from "node:fs";

const argv = process.argv.slice(2);

const DEFAULT_HELP = [
  "Usage: claude [options] [prompt]",
  "",
  "Options:",
  "  -n, --name <name>                       session display name",
  "  --model <model>                         model for the session",
  "  --session-id <uuid>                     use a specific session id",
  "  -r, --resume <id>                       resume a session by id",
  "  -c, --continue                          continue the most recent conversation",
  "  --append-system-prompt <prompt>         append to the system prompt",
  "  --append-system-prompt-file <path>      append the file's contents to the system prompt",
  "  --add-dir <dirs...>                     additional directories to allow access to",
  "  --permission-mode <mode>                permission mode for the session",
  "  -h, --help                              display help",
].join("\n");

if (argv.includes("--help") || argv.includes("-h")) {
  const help = process.env.FAKE_CLAUDE_HELP ?? DEFAULT_HELP;
  process.stdout.write(`${help}\n`);
  process.exit(0);
}

const mode = process.env.FAKE_CLAUDE_MODE ?? "exit0";

if (mode === "crash") process.exit(1);

const record = process.env.FAKE_CLAUDE_RECORD;
if (record) {
  writeFileSync(
    record,
    `${JSON.stringify(
      {
        argv,
        cwd: process.cwd(),
        pid: process.pid,
        ppid: process.ppid,
        // The WHOLE child environment: an isolation test has to be able to assert
        // that a variable is ABSENT, which a curated subset could never prove.
        env: process.env,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

if (process.env.FAKE_CLAUDE_READY) {
  writeFileSync(process.env.FAKE_CLAUDE_READY, "ready\n", "utf8");
}

if (mode === "hold") {
  // Stay alive until the test signals or kills us — but never outlive the launcher.
  // A test that SIGKILLs the launcher to prove the `orphaned` classification would
  // otherwise leave this process behind on the host.
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
