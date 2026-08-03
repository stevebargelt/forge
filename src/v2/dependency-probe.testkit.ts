// FG-664: the stub answer for Forge's OWN dependency-probe container.
//
// Since FG-664 both read-only dispatch paths run a probe container before any
// agent container exists, and refuse the dispatch unless it prints a report
// carrying the nonce THIS dispatch minted. Every worktree/integration test with
// an injected docker exec therefore has to answer that container, or its
// reviewer never starts — and the nonce is not a value a fixture can hard-code,
// so the answer has to be read off the container's own argv.
//
// This lives in one place because the protocol (a nonce on the argv, a report
// line on stdout) is the thing under test elsewhere; a copy per file would drift
// away from the shipped script silently.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Whether these docker args build Forge's dependency-probe container. */
export function isDependencyProbeCall(args: string[]): boolean {
  const i = args.indexOf("--name");
  return i >= 0 && (args[i + 1] ?? "").startsWith("forge-depprobe-");
}

/** Write the report a healthy probe container would print for `args`, echoing
 *  that dispatch's own nonce. Returns the exit code to hand back (0). */
export function answerDependencyProbe(
  args: string[],
  stdoutPath: string,
  over: { packages?: Array<{ name: string; version: string; loaded: boolean; error?: string }>; entries?: number } = {},
): number {
  const nonceArg = args.find((a) => a.startsWith("FORGE_PROBE_NONCE=")) ?? "";
  const rootsArg = (args.find((a) => a.startsWith("FORGE_PROBE_ROOTS=")) ?? "").slice("FORGE_PROBE_ROOTS=".length);
  const installRoot = (args.find((a) => a.startsWith("FORGE_PROBE_INSTALL_ROOT=")) ?? "").slice(
    "FORGE_PROBE_INSTALL_ROOT=".length,
  );
  const report = {
    nonce: nonceArg.slice("FORGE_PROBE_NONCE=".length),
    node: process.version,
    abi: process.versions.modules,
    roots: rootsArg
      .split(":")
      .filter(Boolean)
      .map((path) => ({ path, entries: over.entries ?? 412, installRoot: path === installRoot })),
    packages: over.packages ?? [{ name: "better-sqlite3", version: "12.11.1", loaded: true }],
  };
  mkdirSync(dirname(stdoutPath), { recursive: true });
  writeFileSync(stdoutPath, JSON.stringify(report) + "\n");
  return 0;
}
