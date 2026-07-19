// FG-552 (F33): the CLI entry is a thin DISPATCHER. `forge launch wait` is the
// minimal observer — it must resolve with only `node:fs` + the `tmux` binary, so
// it is routed to a native-free path BEFORE node-preflight and the eager command
// registry (which pull in better-sqlite3) ever run. That is what lets the observer
// still observe + report when the native binding cannot load under this
// interpreter. Every OTHER command keeps the original ordering: node-preflight
// FIRST (fail clean on an ABI-incompatible Node before better-sqlite3 loads),
// then the full registry.

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv[0] === "launch" && argv[1] === "wait") {
    const { runLaunchWaitCli } = await import("./commands/launch-wait.js");
    process.exitCode = await runLaunchWaitCli(argv.slice(2));
    return;
  }

  await import("./node-preflight.js"); // FG-336/FG-570: before better-sqlite3 loads
  const { runForge } = await import("./program.js");
  await runForge(process.argv);
}

main().catch((err) => {
  console.error(`forge: ${(err as Error).message}`);
  process.exit(1);
});
