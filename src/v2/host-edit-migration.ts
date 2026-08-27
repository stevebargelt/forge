// FG-776 (FG-767 T3): the ONE-TIME host-edit migration — the load-bearing safety
// step that backs up operator-edited host seeds BEFORE FG-777's always-upgrade
// flip can overwrite them, and writes a completion latch FG-777 gates on.
//
// Today install-seeds.sh RETAINS the operator-authored categories (agents,
// constraints, forge-raci.md) — it seeds them once and never writes over them
// (FG-578). FG-777 will flip those categories to always-FORCE so a release's seed
// changes actually land. That flip is destructive to operator edits, so this
// ticket runs FIRST: every host file that DIFFERS from its shipped seed (plus
// every pre-rename ORPHAN agent dir) is copied to a TIMESTAMPED backup dir under
// $FORGE_HOME/pre-upgrade-backup/ before any overwrite is possible, a loud report
// tells the operator exactly how to reinstate each file as a project override, and
// a latch is written. FG-777 MUST refuse to FORCE the authored categories until
// that latch exists (see hostEditMigrationComplete).
//
// SCOPE: this module ONLY backs up + reports + latches. It NEVER overwrites a host
// file, and it is non-blocking — a failure is surfaced but never aborts upgrade.

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { FORGE_HOME } from "../util/paths.js";
import { assetRoot } from "./asset-root.js";
import { sha256OfBytes } from "../util/content-digest.js";

/** The EXECUTING release's seeds/ — the baseline every host file is measured
 *  against. A parameter everywhere below so detection is pure over its filesystem
 *  inputs (never an ambient read a test has to defeat). */
export function releaseSeedsDir(): string {
  return join(assetRoot(), "seeds");
}

/** The operator-authored categories forge seeds once and (today) never overwrites.
 *  MUST stay in lockstep with seed-drift's operator-authored SEED_SPECS and
 *  install-seeds.sh's AUTHORED_EXEMPT: these are exactly the categories FG-777 will
 *  flip to always-FORCE, so they are exactly the ones that must be backed up first.
 *  `rel` is relative to BOTH $FORGE_HOME and the release seeds dir. */
const AUTHORED_SPECS: readonly { category: "agents" | "constraints" | "raci"; rel: string }[] = [
  { category: "agents", rel: "agents" },
  { category: "constraints", rel: "constraints" },
  { category: "raci", rel: "forge-raci.md" },
];

/** The pre-rename agent dirs — mirrors install-seeds.sh's orphan list (the v2
 *  rename: architect → architecture-advisor, etc.). These dirs are unreferenced by
 *  anything on a current host, but they may hold operator edits, so they are
 *  INCLUDED in the backup and are NEVER overwrite targets (they have no seed to
 *  refresh from). */
export const ORPHAN_AGENT_DIRS: readonly string[] = [
  "architect",
  "planner",
  "implementer",
  "verifier",
  "frontend-implementer",
  "backend-implementer",
  "infosec-implementer",
  "investigator",
  "framer",
  "recommender",
  "assessor",
  "reporter",
];

/** How a divergent host file relates to the shipped seed.
 *  `edited`  — the operator changed a file this release still ships; reinstate only
 *              the DELTA (an agent addendum / an added constraint), never the whole
 *              file, or the base is re-forked.
 *  `added`   — a file the operator created that no seed carries; reinstate AS-IS
 *              into <project>/.forge — the union/addendum picks it up.
 *  `orphan`  — a file under a pre-rename orphan agent dir; backed up for safety,
 *              never an overwrite target. */
export type HostEditKind = "edited" | "added" | "orphan";

export type HostEditFile = {
  category: "agents" | "constraints" | "raci";
  /** path relative to $FORGE_HOME, e.g. "agents/engineer/CLAUDE.md" (POSIX-shaped
   *  on the host it was read from) — the backup preserves this structure. */
  rel: string;
  kind: HostEditKind;
  /** absolute path of the host file. */
  hostPath: string;
  /** absolute path of the shipped seed it diverges from; null for added/orphan. */
  seedPath: string | null;
};

export type HostEditDetection = {
  /** every host file that DIFFERS from its seed, plus every orphan-dir file. */
  files: HostEditFile[];
  /** the orphan agent dirs actually present on this host (subset of ORPHAN_AGENT_DIRS). */
  orphanDirs: string[];
};

export type HostEditMigrationOutcome =
  | "backed-up"
  | "nothing-to-back-up"
  | "would-back-up"
  | "would-note"
  | "failed"
  | "not-run";

export type HostEditMigrationResult = {
  outcome: HostEditMigrationOutcome;
  /** the timestamped dir this run wrote (null when nothing diverged or on dry-run/not-run). */
  backupDir: string | null;
  /** the rel paths copied into backupDir, in detection order. */
  backedUp: string[];
  detection: HostEditDetection;
  /** the loud, operator-facing reinstate guidance (two-case: added vs edited).
   *  On a real run the `<backup>` placeholder is substituted with backupDir. */
  report: string[];
  latchPath: string;
  latchWritten: boolean;
  /** the failure reason on `failed`, else null. */
  error: string | null;
};

/** The migration's namespace under $FORGE_HOME — holds the timestamped backup dirs
 *  and the completion latch. */
export function hostEditMigrationRootDir(forgeHome: string = FORGE_HOME): string {
  return join(forgeHome, "pre-upgrade-backup");
}

/** The completion latch — a dotfile sibling of the timestamp dirs (so a readdir
 *  over the backup root's timestamp dirs never trips on it). Its mere EXISTENCE is
 *  the gate; its contents are informational. */
export function hostEditMigrationLatchPath(forgeHome: string = FORGE_HOME): string {
  return join(hostEditMigrationRootDir(forgeHome), ".host-edit-migration-complete");
}

/** THE GATE FG-777 CONSUMES (AC4). FG-777's always-upgrade of the authored
 *  categories (agents / constraints / raci) MUST refuse to FORCE them until this
 *  returns true — i.e. until this migration has run at least once and had the
 *  chance to back up every divergent host file. */
export function hostEditMigrationComplete(forgeHome: string = FORGE_HOME): boolean {
  return existsSync(hostEditMigrationLatchPath(forgeHome));
}

/** Absolute paths of every file under `base` (recursive). [] if base is absent. A
 *  file path returns itself, so the single-file raci seed works too. */
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

/** Byte-identity compare — the same mechanism seed-drift uses. An unreadable host
 *  file reads as "differs" so it is backed up rather than silently skipped. */
function sameBytes(a: string, b: string): boolean {
  try {
    return sha256OfBytes(a) === sha256OfBytes(b);
  } catch {
    return false;
  }
}

/** Walk the HOST authored categories (not the seed side, so operator-ADDED files
 *  are caught too) and classify each file against its shipped seed. Pure over its
 *  filesystem inputs — both roots are parameters for testability. */
export function detectHostEdits(
  seedsDir: string = releaseSeedsDir(),
  forgeHome: string = FORGE_HOME,
): HostEditDetection {
  const files: HostEditFile[] = [];
  const orphanSet = new Set(ORPHAN_AGENT_DIRS);
  const orphanDirs = new Set<string>();

  for (const spec of AUTHORED_SPECS) {
    for (const hostFile of walkFiles(join(forgeHome, spec.rel))) {
      const rel = relative(forgeHome, hostFile);
      if (spec.category === "agents") {
        const role = rel.split(/[/\\]/)[1];
        if (role && orphanSet.has(role)) {
          orphanDirs.add(role);
          files.push({ category: "agents", rel, kind: "orphan", hostPath: hostFile, seedPath: null });
          continue;
        }
      }
      const seedPath = join(seedsDir, rel);
      if (!existsSync(seedPath)) {
        files.push({ category: spec.category, rel, kind: "added", hostPath: hostFile, seedPath: null });
      } else if (!sameBytes(hostFile, seedPath)) {
        files.push({ category: spec.category, rel, kind: "edited", hostPath: hostFile, seedPath });
      }
      // identical → not divergent, nothing to back up
    }
  }
  return { files, orphanDirs: [...orphanDirs].sort() };
}

/** The loud, two-case reinstate report. `<backup>` is a placeholder the caller
 *  substitutes with the real timestamped dir once it exists. Empty when nothing
 *  diverged, so the caller prints nothing when there is nothing to say. */
export function renderReinstateReport(
  detection: HostEditDetection,
  forgeHome: string = FORGE_HOME,
): string[] {
  if (detection.files.length === 0) return [];
  const added = detection.files.filter((f) => f.kind === "added");
  const edited = detection.files.filter((f) => f.kind === "edited");
  const orphan = detection.files.filter((f) => f.kind === "orphan");

  const lines: string[] = [];
  lines.push(
    "⚠ Pre-upgrade host-edit backup — these operator-authored host files diverge from this",
  );
  lines.push(
    "  release's seeds and were BACKED UP before any future forced seed refresh (FG-777) can",
  );
  lines.push("  overwrite them. Reinstate each as a PROJECT override — two cases, handled differently:");

  if (added.length > 0) {
    lines.push("");
    lines.push("  ADDED (new files you created — reinstate AS-IS; the union/addendum picks them up):");
    for (const f of added) {
      lines.push(`    ${f.rel}`);
      lines.push(`      → cp "<backup>/${f.rel}" "<project>/.forge/${f.rel}"`);
    }
  }

  if (edited.length > 0) {
    lines.push("");
    lines.push("  EDITED (you changed a shipped seed — reinstate only the DELTA, never the whole file):");
    for (const f of edited) {
      if (f.category === "agents") {
        lines.push(`    ${f.rel}  (edited agent base)`);
        lines.push(
          `      → write a SMALL <project>/.forge/${f.rel} ADDENDUM with only your changes — do NOT`,
        );
        lines.push(`        paste the whole backup file back, that re-forks the base.`);
      } else if (f.category === "constraints") {
        lines.push(`    ${f.rel}  (edited constraint)`);
        lines.push(
          `      → add your delta as a project constraint: <project>/.forge/${f.rel} — it is ADDED via the`,
        );
        lines.push(`        constraints union, on top of the host set.`);
      } else {
        lines.push(`    ${f.rel}  (edited ${f.category})`);
        lines.push(
          `      → re-express only your delta as a <project>/.forge routing override; do not copy the whole`,
        );
        lines.push(`        backup file back.`);
      }
    }
  }

  if (orphan.length > 0) {
    lines.push("");
    lines.push(
      `  ORPHAN pre-rename agent dirs (${detection.orphanDirs.join(", ")}) — unreferenced since the v2`,
    );
    lines.push(
      "  agent rename, backed up in case they hold edits; NOT overwrite targets. Reconcile any edits into",
    );
    lines.push("  the renamed role's project addendum, then remove the orphan dir.");
    for (const f of orphan) lines.push(`    ${f.rel}`);
  }

  lines.push("");
  lines.push(`  Backup root (timestamped, one dir per run): ${hostEditMigrationRootDir(forgeHome)}/`);
  return lines;
}

/** A filesystem-safe UTC timestamp for a backup dir name — ISO-8601 with `:`/`.`
 *  replaced (the same shape `forge backup` uses). */
function utcStamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

/** A never-collide backup dir: a fresh timestamped dir that does not already
 *  exist. Guarantees AC2 — a run NEVER overwrites a prior timestamped backup, even
 *  if two runs land in the same millisecond. */
function uniqueBackupDir(rootDir: string, stamp: string): string {
  let dir = join(rootDir, stamp);
  let n = 1;
  while (existsSync(dir)) dir = join(rootDir, `${stamp}-${n++}`);
  return dir;
}

/** Write / update the completion latch. First run records `firstRanAt`; every run
 *  appends its own record so the migration's history is auditable. The latch's mere
 *  existence is what FG-777 checks. */
function writeLatch(latchPath: string, now: Date, backupDir: string | null, files: number): void {
  let prior: { firstRanAt?: string; runs?: unknown[] } = {};
  if (existsSync(latchPath)) {
    try {
      prior = JSON.parse(readFileSync(latchPath, "utf8"));
    } catch {
      /* a corrupt latch is replaced — its only job is to exist */
    }
  }
  const nowIso = now.toISOString();
  const runs = [...(Array.isArray(prior.runs) ? prior.runs : []), { at: nowIso, backupDir, files }];
  const latch = {
    version: 1,
    migration: "FG-776 host-edit-backup",
    firstRanAt: prior.firstRanAt ?? nowIso,
    lastRanAt: nowIso,
    runs,
  };
  mkdirSync(dirname(latchPath), { recursive: true });
  writeFileSync(latchPath, JSON.stringify(latch, null, 2) + "\n");
}

export type RunHostEditMigrationOptions = {
  seedsDir?: string;
  forgeHome?: string;
  dryRun?: boolean;
  /** injectable clock for deterministic tests; defaults to now. */
  now?: Date;
};

/** DETECT → BACK UP → REPORT → LATCH. The whole ticket, in order. Never throws:
 *  every failure is caught and reported as `failed` so the caller (forge upgrade)
 *  is never hard-blocked (AC5). */
export function runHostEditMigration(opts: RunHostEditMigrationOptions = {}): HostEditMigrationResult {
  const seedsDir = opts.seedsDir ?? releaseSeedsDir();
  const forgeHome = opts.forgeHome ?? FORGE_HOME;
  const dryRun = opts.dryRun ?? false;
  const now = opts.now ?? new Date();
  const latchPath = hostEditMigrationLatchPath(forgeHome);

  // No seeds to compare against → nothing to protect against overwrite (install-seeds
  // cannot run either), and every host file would look "added". Do not fabricate a
  // migration: report not-run, write no latch. The asset-install not-found outcome
  // already makes the upgrade unresolved.
  if (!existsSync(seedsDir)) {
    return {
      outcome: "not-run",
      backupDir: null,
      backedUp: [],
      detection: { files: [], orphanDirs: [] },
      report: [],
      latchPath,
      latchWritten: false,
      error: null,
    };
  }

  const detection = detectHostEdits(seedsDir, forgeHome);
  const baseReport = renderReinstateReport(detection, forgeHome);

  if (dryRun) {
    return {
      outcome: detection.files.length > 0 ? "would-back-up" : "would-note",
      backupDir: null,
      backedUp: [],
      detection,
      report: baseReport,
      latchPath,
      latchWritten: false,
      error: null,
    };
  }

  try {
    let backupDir: string | null = null;
    const backedUp: string[] = [];
    if (detection.files.length > 0) {
      // BACK UP FIRST — before the latch, before anything downstream can overwrite.
      backupDir = uniqueBackupDir(hostEditMigrationRootDir(forgeHome), utcStamp(now));
      mkdirSync(backupDir, { recursive: true });
      for (const f of detection.files) {
        const dest = join(backupDir, f.rel);
        mkdirSync(dirname(dest), { recursive: true });
        cpSync(f.hostPath, dest);
        backedUp.push(f.rel);
      }
    } else {
      mkdirSync(hostEditMigrationRootDir(forgeHome), { recursive: true });
    }
    writeLatch(latchPath, now, backupDir, backedUp.length);
    const report = backupDir ? baseReport.map((l) => l.replaceAll("<backup>", backupDir!)) : baseReport;
    return {
      outcome: detection.files.length > 0 ? "backed-up" : "nothing-to-back-up",
      backupDir,
      backedUp,
      detection,
      report,
      latchPath,
      latchWritten: true,
      error: null,
    };
  } catch (e) {
    return {
      outcome: "failed",
      backupDir: null,
      backedUp: [],
      detection,
      report: baseReport,
      latchPath,
      latchWritten: false,
      error: (e as Error).message,
    };
  }
}

/** The one-line step summary forge upgrade prints under [3/4]. */
export function hostEditMigrationStatusLine(r: HostEditMigrationResult): string {
  switch (r.outcome) {
    case "backed-up":
      return `${r.backedUp.length} operator-edited host file(s) backed up → ${r.backupDir} (latch written)`;
    case "nothing-to-back-up":
      return "no operator edits diverge from this release's seeds (latch written)";
    case "would-back-up":
      return `would back up ${r.detection.files.length} operator-edited host file(s) + write the completion latch`;
    case "would-note":
      return "no operator edits diverge from this release's seeds; would write the completion latch";
    case "failed":
      return `FAILED — ${r.error}`;
    case "not-run":
      return "not run — no release seeds to compare against";
  }
}
