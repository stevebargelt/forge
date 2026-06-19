// FG-335: detect when installed ~/.forge seeds have drifted from the seeds that
// ship with the running forge code.
//
// forge runs from npm-linked source, so a `git pull` makes the CODE live
// immediately, but ~/.forge seeds stay stale — install-seeds.sh uses `cp -n`
// (no-clobber), so a seed updated upstream is never re-copied over an existing
// install. A stale RUNTIME yaml silently changes agent execution: an old
// pi-apikey.yml that hardcoded `--provider anthropic` defeated the #265 provider
// binding with no signal at all. This module is the missing signal.
//
// Read-only detector, surfaced by `forge doctor`. The fix is `forge upgrade`
// (FORCE refresh of all seeds) or `FORCE=1 scripts/install-seeds.sh` for a
// seed-only refresh. Runtimes are forge-owned execution artifacts (safe to
// overwrite); agents/constraints/raci are prose that may carry local edits, so
// they are reported as a warning rather than treated as a hard readiness fail.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { FORGE_HOME } from "../util/paths.js";

export type SeedStatus = "current" | "drifted" | "missing";

export type SeedDriftEntry = {
  category: string;
  /** path relative to the seeds root, e.g. "runtimes/pi-apikey.yml" */
  path: string;
  status: SeedStatus;
  /** true = forge-owned execution artifact, safe to overwrite (runtimes).
   *  false = prose that may carry local edits → warn, never auto-overwrite. */
  autoRefreshable: boolean;
};

export type SeedDriftReport = {
  entries: SeedDriftEntry[];
  /** the actionable subset: every entry whose status is not "current". */
  stale: SeedDriftEntry[];
  /** false when a forge-owned (auto-refreshable) seed is stale — a real
   *  readiness problem. Prose drift alone keeps this true (warning only). */
  ok: boolean;
};

type SeedSpec = { category: string; rel: string; autoRefreshable: boolean };

// Order is the report's display order. Runtimes first — the dangerous category.
const SEED_SPECS: SeedSpec[] = [
  { category: "runtimes", rel: "runtimes", autoRefreshable: true },
  { category: "agents", rel: "agents", autoRefreshable: false },
  { category: "constraints", rel: "constraints", autoRefreshable: false },
  { category: "raci", rel: "forge-raci.md", autoRefreshable: false },
];

/** The seeds/ dir of the running forge package, resolved module-relative so it
 *  tracks the live code even when npm-linked. FORGE_REPO_DIR overrides it. */
export function defaultRepoSeedsDir(): string {
  if (process.env.FORGE_REPO_DIR) return join(process.env.FORGE_REPO_DIR, "seeds");
  // this module: <pkg>/src/v2/seed-drift.ts → <pkg>/seeds
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "seeds");
}

/** Absolute paths of every file under `base` (recursive). [] if base is absent.
 *  A file path returns itself, so single-file seeds (forge-raci.md) work too. */
function walkFiles(base: string): string[] {
  if (!existsSync(base)) return [];
  if (statSync(base).isFile()) return [base];
  const out: string[] = [];
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    const p = join(base, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(p));
    else if (entry.isFile()) out.push(p);
  }
  return out;
}

function sameContent(a: string, b: string): boolean {
  try {
    return readFileSync(a, "utf8") === readFileSync(b, "utf8");
  } catch {
    return false;
  }
}

/** Compare installed seeds under `forgeHome` against the package's `repoSeedsDir`.
 *  Pure over its filesystem inputs — both roots are parameters for testability. */
export function detectSeedDrift(
  repoSeedsDir: string = defaultRepoSeedsDir(),
  forgeHome: string = FORGE_HOME,
): SeedDriftReport {
  const entries: SeedDriftEntry[] = [];
  for (const spec of SEED_SPECS) {
    for (const repoFile of walkFiles(join(repoSeedsDir, spec.rel))) {
      const rel = relative(repoSeedsDir, repoFile);
      const installed = join(forgeHome, rel);
      const status: SeedStatus = !existsSync(installed)
        ? "missing"
        : sameContent(repoFile, installed)
          ? "current"
          : "drifted";
      entries.push({ category: spec.category, path: rel, status, autoRefreshable: spec.autoRefreshable });
    }
  }
  const stale = entries.filter((e) => e.status !== "current");
  const ok = !stale.some((e) => e.autoRefreshable);
  return { entries, stale, ok };
}

/** Human-readable drift section for `forge doctor`. Empty string when nothing is
 *  stale, so the caller can skip printing a section with nothing to say. */
export function renderSeedDrift(report: SeedDriftReport): string {
  if (report.stale.length === 0) return "";
  const lines: string[] = ["Seed drift (installed ~/.forge vs running code):"];
  for (const e of report.stale) {
    const mark = e.autoRefreshable ? "FAIL" : "warn";
    lines.push(`  [${mark}] ${e.status.padEnd(7)} ${e.path}`);
  }
  const hardFails = report.stale.some((e) => e.autoRefreshable);
  lines.push(
    hardFails
      ? "  Runtime seeds are stale — agent execution may not match the code. Fix: forge upgrade (or FORCE=1 scripts/install-seeds.sh)."
      : "  Prose seeds differ from defaults (may be local edits). Refresh with forge upgrade if unintended.",
  );
  return lines.join("\n");
}
