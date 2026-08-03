// FG-664: the stub answers for Forge's OWN dependency-gate containers.
//
// Since FG-664 both read-only dispatch paths run Forge's own containers before
// any agent container exists, and refuse the dispatch unless the environment is
// attested: a PROBE container, which reports what the reviewer's mount shape
// holds and must echo the nonce THIS dispatch minted, and one LOAD container per
// native artifact, whose EXIT STATUS is the verdict on that artifact. Every
// worktree/integration test with an injected docker exec therefore has to answer
// both, or its reviewer never starts — and the nonce is not a value a fixture can
// hard-code, so the answer has to be read off the container's own argv.
//
// This lives in one place because the protocol (a nonce on the argv, a report
// line on stdout, an exit status per artifact) is the thing under test elsewhere;
// a copy per file would drift away from the shipped script silently.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** How a fixture describes one native package to both answers below. */
export type StubPackage = { name: string; version: string; loaded: boolean; error?: string };

const DEFAULT_PACKAGES: StubPackage[] = [{ name: "better-sqlite3", version: "12.11.1", loaded: true }];

/** Whether these docker args build Forge's dependency-probe container. */
export function isDependencyProbeCall(args: string[]): boolean {
  return containerName(args).startsWith("forge-depprobe-");
}

/** Whether these docker args build one of Forge's dependency-LOAD containers. */
export function isDependencyLoadCall(args: string[]): boolean {
  return containerName(args).startsWith("forge-depload-");
}

function containerName(args: string[]): string {
  const i = args.indexOf("--name");
  return i >= 0 ? (args[i + 1] ?? "") : "";
}

function envValue(args: string[], key: string): string {
  return (args.find((a) => a.startsWith(`${key}=`)) ?? "").slice(key.length + 1);
}

/** The artifact path the stub report claims for a package — the same path the
 *  load container is then handed on its argv, which is how answerDependencyLoad
 *  knows which package it is being asked about. */
function stubArtifact(root: string, name: string): string {
  return `${root}/${name}/build/Release/forge-stub.node`;
}

/** Write the report a healthy probe container would print for `args`, echoing
 *  that dispatch's own nonce. Returns the exit code to hand back (0). */
export function answerDependencyProbe(
  args: string[],
  stdoutPath: string,
  over: { packages?: StubPackage[]; entries?: number; missing?: string[] } = {},
): number {
  const rootsArg = envValue(args, "FORGE_PROBE_ROOTS");
  const installRoot = envValue(args, "FORGE_PROBE_INSTALL_ROOT");
  const roots = rootsArg.split(":").filter(Boolean);
  const report = {
    nonce: envValue(args, "FORGE_PROBE_NONCE"),
    node: process.version,
    abi: process.versions.modules,
    roots: roots.map((path) => ({ path, entries: over.entries ?? 412, installRoot: path === installRoot })),
    packages: (over.packages ?? DEFAULT_PACKAGES).map((p) => ({
      name: p.name,
      version: p.version,
      artifact: stubArtifact(roots[0] ?? "/project/node_modules", p.name),
    })),
    missing: over.missing ?? [],
  };
  mkdirSync(dirname(stdoutPath), { recursive: true });
  writeFileSync(stdoutPath, JSON.stringify(report) + "\n");
  return 0;
}

/** Answer ONE load container: exit 0 when the fixture says that package loads,
 *  non-zero (with the fixture's loader error on stderr) when it does not. Pass
 *  the SAME `over` the probe answer got — the two describe one environment. */
export function answerDependencyLoad(
  args: string[],
  over: { packages?: StubPackage[] } = {},
  stderrPath?: string,
): number {
  const artifact = args[args.length - 1] ?? "";
  const pkg = (over.packages ?? DEFAULT_PACKAGES).find((p) => artifact.includes(`/${p.name}/`));
  if (pkg === undefined || pkg.loaded) return 0;
  if (stderrPath !== undefined) {
    mkdirSync(dirname(stderrPath), { recursive: true });
    writeFileSync(stderrPath, `${pkg.error ?? "the stub fixture reports this artifact as unloadable"}\n`);
  }
  return 1;
}
