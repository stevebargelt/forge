import type { Command } from "commander";
import { ensureForgeDirs } from "../../util/paths.js";
import { pruneDependencyCache, type PruneDependencyCacheResult } from "../../v2/dependency-provisioning.js";

// `forge dependency-cache prune` — operator-accessible cleanup of the shared
// FG-376 forge-deps-* volumes + dependency-cache/ markers (FG-434).
// Destructive-but-safe: docker itself refuses to remove a volume any
// container still references, and a pruned volume is simply re-provisioned
// (a fresh `npm ci`) the next time a task needs that lockfile hash.

export function renderPruneHuman(result: PruneDependencyCacheResult): string {
  const verb = result.dryRun ? "Would remove" : "Removed";
  const lines: string[] = [
    `${verb} ${result.volumesRemoved.length} dependency-cache volume(s), ` +
      `skipped ${result.volumesSkippedInUse.length} (in use)` +
      (result.volumesError.length ? `, ${result.volumesError.length} error(s)` : "") +
      `, cleared ${result.markersRemoved.length} marker/lock file(s).`,
  ];
  if (result.dryRun) {
    lines.push("Dry run — nothing was removed.");
  } else {
    if (result.volumesRemoved.length) lines.push("Pruned volumes will be re-provisioned the next time they're needed.");
    if (result.volumesSkippedInUse.length) lines.push("Skipped volumes are still referenced by a container — re-run once it finishes.");
    if (result.volumesError.length) lines.push(`Errors removing: ${result.volumesError.join(", ")}`);
  }
  return lines.join("\n");
}

export function registerDependencyCache(program: Command): void {
  const depCache = program
    .command("dependency-cache")
    .description("Manage the shared FG-376 dependency-cache volumes + markers.");

  depCache
    .command("prune")
    .option("--dry-run", "report what would be removed; remove nothing")
    .option("--json", "emit the structured prune result as JSON")
    .description(
      "Remove forge-deps-* docker volumes not currently in use by a container, and their .ready/.lock markers. Pruned volumes are re-provisioned on next use.",
    )
    .action((opts: { dryRun?: boolean; json?: boolean }) => {
      ensureForgeDirs();
      const result = pruneDependencyCache({ dryRun: opts.dryRun ?? false });

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(renderPruneHuman(result));
    });
}
