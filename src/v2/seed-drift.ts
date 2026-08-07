// FG-335: detect when installed ~/.forge seeds have drifted from the seeds that
// ship with the running forge code.
//
// forge runs from npm-linked source, so a `git pull` makes the CODE live
// immediately, but ~/.forge seeds can stay stale — install-seeds.sh's
// `seed_install_file` installs a seed only when it is absent; for an existing
// file it applies an ownership-aware predicate, not `cp -n`. It deliberately
// avoids `cp -n` (see install-seeds.sh:102: BSD cp exits 1 when it skips an
// existing file, which aborts every re-run under `set -e`) and instead does an
// explicit existence/ownership check: forge-owned categories (runtimes) are
// overwritten only under FORCE and otherwise left as-is, while authored-exempt
// categories (agents, constraints, raci) are create-only and retained whether
// or not FORCE is set (see FG-578 note below for how FORCE now refreshes the
// forge-owned categories). So without FORCE a forge-owned seed updated upstream
// that already exists is not re-copied over the install. A stale RUNTIME yaml
// silently changes agent execution: an old
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

import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { CLAUDE_SKILLS_DIR, FORGE_HOME } from "../util/paths.js";
import { assetRoot } from "./asset-root.js";
import { sha256OfBytes } from "../util/content-digest.js";
import { inspectAgentProtocols, type ProtocolInspectOptions } from "./agent-protocol.js";

export type SeedStatus = "current" | "drifted" | "missing";

/** WHO may edit a seed. FG-579 splits this from COUPLING: they are orthogonal.
 *  `forge-owned`   — the installer overwrites it under FORCE; a stale one is
 *                    forge's to converge (runtimes, workflows, skills).
 *  `operator-authored` — forge seeds it once and never writes over it; a stale
 *                    one is the operator's to merge (agents, constraints, raci). */
export type SeedOwnership = "forge-owned" | "operator-authored";

/** WHAT breaks when a seed is stale. FG-579 splits this from OWNERSHIP.
 *  `executable` — bytes an agent EXECUTES against, so a stale copy silently
 *                 mis-runs (runtimes rebind the provider, workflows mis-dispatch)
 *                 → readiness FAIL.
 *  `prose`      — documentation/routing text; a stale copy is a warning, not a
 *                 mis-run, so readiness stays ok. */
export type SeedCoupling = "executable" | "prose";

export type SeedDriftEntry = {
  category: string;
  /** path relative to the seeds root, e.g. "runtimes/pi-apikey.yml" */
  path: string;
  status: SeedStatus;
  /** who may edit this seed — drives the remedy text (refresh vs merge-by-hand). */
  ownership: SeedOwnership;
  /** what a stale copy breaks — drives readiness (executable drift → ok=false). */
  coupling: SeedCoupling;
};

export type SeedDriftReport = {
  entries: SeedDriftEntry[];
  /** the actionable subset: every entry whose status is not "current". */
  stale: SeedDriftEntry[];
  /** false when a stale seed is EXECUTABLE (runtimes/workflows) — a real
   *  readiness problem, because it silently mis-runs. Prose drift alone keeps this
   *  true (warning only). Readiness is a function of COUPLING, not ownership. */
  ok: boolean;
};

// `root` says which install prefix the seed lands in: most seeds install under
// $FORGE_HOME, but `skills` install into the user-global Claude Code skills dir
// (CLAUDE_SKILLS_DIR) — a DIFFERENT tree, so it needs its own baseline root.
type SeedRoot = "forge-home" | "claude-skills";
type SeedSpec = { category: string; rel: string; root: SeedRoot; ownership: SeedOwnership; coupling: SeedCoupling };

// Order is the report's display order. Executable categories first — the
// dangerous ones. FG-579 adds `workflows`: forge-owned (the installer force-writes
// it) AND executable (a stale workflow silently mis-dispatches), so a drifted one
// is a hard readiness FAIL in the same class as runtimes. FG-579 also adds
// `skills`: forge-owned (the installer force-writes them, bare skips — NOT in
// AUTHORED_EXEMPT) but PROSE — orchestrator behavioral guidance Claude reads, so a
// stale one is a reported warning (forge upgrade converges it) rather than a hard
// readiness fail. They install into CLAUDE_SKILLS_DIR, not $FORGE_HOME.
// FG-576 adds `codex`: seeds/codex/orchestrator-instructions.md is the SCAFFOLDING the
// Forge-owned Codex instruction carrier is rendered from (seed-generation.ts
// renderCodexCarrier). Forge-owned — the installer force-writes it and it is
// deliberately NOT in AUTHORED_EXEMPT — and EXECUTABLE, because Codex's instructions
// file SUBSTITUTES the base instruction surface: a stale scaffolding does not read as
// stale prose, it silently binds an interactive orchestrator to an instruction surface
// no release shipped, which is the runtimes-class failure wearing markdown.
const SEED_SPECS: SeedSpec[] = [
  { category: "runtimes", rel: "runtimes", root: "forge-home", ownership: "forge-owned", coupling: "executable" },
  { category: "workflows", rel: "workflows", root: "forge-home", ownership: "forge-owned", coupling: "executable" },
  { category: "codex", rel: "codex", root: "forge-home", ownership: "forge-owned", coupling: "executable" },
  { category: "skills", rel: "skills", root: "claude-skills", ownership: "forge-owned", coupling: "prose" },
  { category: "agents", rel: "agents", root: "forge-home", ownership: "operator-authored", coupling: "prose" },
  { category: "constraints", rel: "constraints", root: "forge-home", ownership: "operator-authored", coupling: "prose" },
  { category: "raci", rel: "forge-raci.md", root: "forge-home", ownership: "operator-authored", coupling: "prose" },
];

/** FG-578: the categories the OPERATOR authors — forge seeds them, then never
 *  writes over them. Derived from SEED_SPECS rather than restated, so this cannot
 *  drift from the taxonomy the detector itself uses. install-seeds.sh's
 *  AUTHORED_EXEMPT must name exactly this set; the shell/TS boundary makes
 *  literal sharing impractical, so fg578-ownership-agreement.test.ts gates the
 *  agreement instead of a comment asking someone to remember. */
export function authoredCategories(): string[] {
  return SEED_SPECS.filter((s) => s.ownership === "operator-authored").map((s) => s.category).sort();
}

/** The complement: forge-owned artifacts a refresh may overwrite, and therefore
 *  the only categories `forge upgrade` can honestly claim to converge. FG-579:
 *  now includes `workflows`, which the installer force-writes alongside runtimes. */
export function autoRefreshableCategories(): string[] {
  return SEED_SPECS.filter((s) => s.ownership === "forge-owned").map((s) => s.category).sort();
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

/** FG-579: restated as a SHA-256-of-bytes compare (was a utf8-string ===).
 *  Behaviour is identical — same bytes hash equal, different bytes (a trailing
 *  newline, a multibyte codepoint) hash differently — but the vocabulary is now
 *  the one shared byte-identity mechanism the interpreter store and the
 *  workflow-dispatch refusal also use. */
function sameContent(a: string, b: string): boolean {
  try {
    return sha256OfBytes(a) === sha256OfBytes(b);
  } catch {
    return false;
  }
}

/** Compare installed seeds under `forgeHome` against the package's `repoSeedsDir`.
 *  Pure over its filesystem inputs — both roots are parameters for testability. */
export function detectSeedDrift(
  repoSeedsDir: string = defaultRepoSeedsDir(),
  forgeHome: string = FORGE_HOME,
  claudeSkillsDir: string = CLAUDE_SKILLS_DIR,
): SeedDriftReport {
  const entries: SeedDriftEntry[] = [];
  for (const spec of SEED_SPECS) {
    const srcBase = join(repoSeedsDir, spec.rel);
    for (const repoFile of walkFiles(srcBase)) {
      const rel = relative(repoSeedsDir, repoFile);
      // skills install into CLAUDE_SKILLS_DIR with the `skills/` prefix stripped
      // (seeds/skills/<name>/… → <claudeSkillsDir>/<name>/…); every other category
      // installs under $FORGE_HOME at the same relative path.
      const installed =
        spec.root === "claude-skills"
          ? join(claudeSkillsDir, relative(srcBase, repoFile))
          : join(forgeHome, rel);
      const status: SeedStatus = !existsSync(installed)
        ? "missing"
        : sameContent(repoFile, installed)
          ? "current"
          : "drifted";
      entries.push({ category: spec.category, path: rel, status, ownership: spec.ownership, coupling: spec.coupling });
    }
  }
  const stale = entries.filter((e) => e.status !== "current");
  // Readiness is a function of COUPLING, not ownership: any stale EXECUTABLE seed
  // (runtimes or workflows) silently mis-runs → not ok. Prose drift stays a warning.
  const ok = !stale.some((e) => e.coupling === "executable");
  return { entries, stale, ok };
}

// ─── the Forge-owned agent protocol (FG-654) ────────────────────────────────

/** FG-654: the protocol is a SEED GENERATION category, so it has no representation in
 *  the {ownership × coupling} taxonomy above — SeedSpec measures the FLAT $FORGE_HOME
 *  layout, and there is no flat copy of a protocol to measure. It gets its own report,
 *  read out of the published generation.
 *
 *  A covered role with no manifest-consistent protocol in the generation — or an
 *  installed seed still carrying an embedded legacy copy of one — is a readiness FAIL
 *  (doctor exits non-zero), because dispatch of that role refuses. The operator's own
 *  prose in `~/.forge/agents/` stays a warn via SeedSpec, as it always has. */
export type ProtocolDriftReport = {
  entries: Array<{ role: string; ok: boolean; detail: string }>;
  stale: Array<{ role: string; ok: boolean; detail: string }>;
  ok: boolean;
};

export function detectProtocolDrift(opts: ProtocolInspectOptions = {}): ProtocolDriftReport {
  const entries = inspectAgentProtocols(opts);
  const stale = entries.filter((e) => !e.ok);
  return { entries, stale, ok: stale.length === 0 };
}

export function renderProtocolDrift(report: ProtocolDriftReport): string {
  if (report.ok) return "";
  const lines: string[] = ["Forge-owned agent protocol (published seed generation):"];
  for (const e of report.stale) lines.push(`  [FAIL] ${e.role.padEnd(24)} ${e.detail}`);
  lines.push("  Every role above is one the review lifecycle DISPATCHES, and each is refused at dispatch by name");
  lines.push("  until its protocol resolves — a stale reviewer produces plausible output in the wrong shape rather");
  lines.push("  than failing loudly. Your own prose in ~/.forge/agents/ is never rewritten by the repair.");
  lines.push("  Fix: forge upgrade — except where the detail above names another repair (an embedded copy is");
  lines.push("  yours to delete; a release carrying no protocol for the role is reinstalled, not republished).");
  return lines.join("\n");
}

/** Human-readable drift section for `forge doctor`. Empty string when nothing is
 *  stale, so the caller can skip printing a section with nothing to say. */
export function renderSeedDrift(report: SeedDriftReport): string {
  if (report.stale.length === 0) return "";
  const lines: string[] = ["Seed drift (installed ~/.forge vs running code):"];
  for (const e of report.stale) {
    // FG-579: the mark derives from COUPLING — an executable seed's drift is a
    // FAIL (it mis-runs), a prose seed's drift is a warn (the operator's to merge).
    const mark = e.coupling === "executable" ? "FAIL" : "warn";
    lines.push(`  [${mark}] ${e.status.padEnd(7)} ${e.path}`);
  }
  // FG-578: each half of the report names ONLY the remedy that converges IT, and
  // both are printed when both are stale. The old text was an either/or that, on
  // a mixed report, named the runtime remedy and let it stand for the prose too —
  // and on a prose-only report promised `forge upgrade` would refresh files the
  // installer is now required to retain. A remedy that cannot converge the
  // detector that names it is the defect FG-577 fixed for assets; the same
  // promise made about prose is the same defect wearing prose.
  // The remedy branch keys on OWNERSHIP, not coupling: `forge upgrade` converges
  // exactly the forge-owned categories (the installer force-writes them), whatever
  // their coupling — runtimes/workflows (executable) AND skills (prose) alike. The
  // [FAIL]/[warn] mark above still derives from coupling, so a stale skill reads as
  // a warning that upgrade nonetheless fixes.
  const staleForgeOwned = [...new Set(report.stale.filter((e) => e.ownership === "forge-owned").map((e) => e.category))].sort();
  if (staleForgeOwned.length > 0) {
    lines.push(`  Forge-owned seeds (${staleForgeOwned.join(", ")}) are stale — agent execution or orchestration may not match the code. Fix: forge upgrade (or FORCE=1 scripts/install-seeds.sh).`);
  }
  if (report.stale.some((e) => e.ownership === "operator-authored")) {
    lines.push(`  Prose seeds (${authoredCategories().join(", ")}) differ from this release's defaults — these are YOURS.`);
    lines.push("  forge seeds them once and never overwrites them, FORCE=1 included, so forge upgrade will NOT");
    lines.push("  refresh them and this warning will persist while your edits stand. If the drift is unintended,");
    lines.push(`  diff against ${defaultRepoSeedsDir()} and merge by hand.`);
  }
  return lines.join("\n");
}
