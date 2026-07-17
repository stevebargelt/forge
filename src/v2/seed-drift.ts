// FG-335: detect when installed ~/.forge seeds have drifted from the seeds that
// ship with the running forge code.
//
// forge runs from npm-linked source, so a `git pull` makes the CODE live
// immediately, but ~/.forge seeds can stay stale — a plain install-seeds.sh run
// uses `cp -n` (no-clobber), so without FORCE a seed updated upstream is not
// re-copied over an existing install (see FG-578 note below for how FORCE now
// refreshes the auto-refreshable categories). A stale RUNTIME yaml silently
// changes agent execution: an old
// pi-apikey.yml that hardcoded `--provider anthropic` defeated the #265 provider
// binding with no signal at all. This module is the missing signal.
//
// Read-only detector, surfaced by `forge doctor`. Runtimes are forge-owned
// execution artifacts (safe to overwrite); agents/constraints/raci are prose that
// may carry local edits, so they are reported as a warning rather than treated as
// a hard readiness fail.
//
// FG-578: that split is no longer only this module's opinion — it is the
// installer's WRITE policy. `FORCE=1 scripts/install-seeds.sh` (and so
// `forge upgrade`) refreshes the auto-refreshable categories and RETAINS the
// authored ones, which changes what this detector may honestly name as a remedy:
// pointing an operator at `forge upgrade` for prose drift would name a remedy
// that converges nothing — run it forever, stay drifted. That is the same defect
// class as a false refresh claim, so renderSeedDrift() now states a remedy only
// for the categories it actually converges, and says plainly that the rest are
// the operator's to merge. `authoredCategories()` below is the shared face of
// this taxonomy; fg578-ownership-agreement.test.ts fails if the installer's
// AUTHORED_EXEMPT ever disagrees with it.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { FORGE_HOME } from "../util/paths.js";
import { assetRoot } from "./asset-root.js";

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

/** FG-578: the categories the OPERATOR authors — forge seeds them, then never
 *  writes over them. Derived from SEED_SPECS rather than restated, so this cannot
 *  drift from the taxonomy the detector itself uses. install-seeds.sh's
 *  AUTHORED_EXEMPT must name exactly this set; the shell/TS boundary makes
 *  literal sharing impractical, so fg578-ownership-agreement.test.ts gates the
 *  agreement instead of a comment asking someone to remember. (FG-579 is live
 *  proof that hand-maintained parallel lists drift: SEED_SPECS already misses the
 *  `workflows` category the installer installs.) */
export function authoredCategories(): string[] {
  return SEED_SPECS.filter((s) => !s.autoRefreshable).map((s) => s.category).sort();
}

/** The complement: forge-owned execution artifacts a refresh may overwrite, and
 *  therefore the only categories `forge upgrade` can honestly claim to converge. */
export function autoRefreshableCategories(): string[] {
  return SEED_SPECS.filter((s) => s.autoRefreshable).map((s) => s.category).sort();
}

/** The seeds/ dir of the running forge package. FG-577: the baseline is itself a
 *  release-owned asset, so it resolves from assetRoot() and NOTHING ambient may
 *  redirect it — a FORGE_REPO_DIR short-circuit here re-pointed the detector's
 *  own evidence, and drift then reported "current" against caller-chosen bytes,
 *  silently. FORGE_REPO_DIR keeps its meaning only for dev-checkout advancement
 *  (asset-root.ts devCheckoutDir); do not restore an override here. */
export function defaultRepoSeedsDir(): string {
  return join(assetRoot(), "seeds");
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
  // FG-578: each half of the report names ONLY the remedy that converges IT, and
  // both are printed when both are stale. The old text was an either/or that, on
  // a mixed report, named the runtime remedy and let it stand for the prose too —
  // and on a prose-only report promised `forge upgrade` would refresh files the
  // installer is now required to retain. A remedy that cannot converge the
  // detector that names it is the defect FG-577 fixed for assets; the same
  // promise made about prose is the same defect wearing prose.
  if (report.stale.some((e) => e.autoRefreshable)) {
    lines.push("  Runtime seeds are stale — agent execution may not match the code. Fix: forge upgrade (or FORCE=1 scripts/install-seeds.sh).");
  }
  if (report.stale.some((e) => !e.autoRefreshable)) {
    lines.push(`  Prose seeds (${authoredCategories().join(", ")}) differ from this release's defaults — these are YOURS.`);
    lines.push("  forge seeds them once and never overwrites them, FORCE=1 included, so forge upgrade will NOT");
    lines.push("  refresh them and this warning will persist while your edits stand. If the drift is unintended,");
    lines.push(`  diff against ${defaultRepoSeedsDir()} and merge by hand.`);
  }
  return lines.join("\n");
}
