// Merges DB-derived + filesystem-derived project signals into a unified
// per-project record for `forge projects list/show` (#152).
//
// Source-of-truth split:
// - DB (runs table): every projectDir forge has ever dispatched against.
//   Provides activity timestamps + run counts.
// - Filesystem scan: every directory that's been initialized with `forge init`
//   (detected by the CLAUDE.md orchestrator marker). Catches projects that
//   haven't yet had a run.
//
// Union by projectDir; metadata from resolveProjectMeta (#143/#151) overlays
// friendly name, description, and chip color.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { uniqueProjectDirs, type ProjectAggregate } from "../store/runs.js";
import { findForgeProjects } from "./find-forge-projects.js";
import { resolveProjectMeta } from "./project-meta.js";
import { findGitRoot } from "./git-root.js";
import { loadHeartbeats } from "./orchestrator-heartbeats.js";

export type ProjectRecord = {
  projectDir: string;
  label: string;
  color: string;
  description?: string;
  lastRunAt?: string;     // ISO; undefined if no runs yet
  runCount: number;       // 0 for filesystem-only projects
  inFlightCount: number;
  hasBacklogMd: boolean;  // <project>/BACKLOG.md exists
  readmeFirstLine?: string;
  liveSessions: number;   // #153: count of live Claude Code orchestrator sessions
};

export type ListOptions = {
  scanRoots?: string[];   // defaults to [~/code] if HOME set
  scanMaxDepth?: number;
};

export function listProjects(opts: ListOptions = {}): ProjectRecord[] {
  const dbAggs = uniqueProjectDirs();
  const fsProjects = findForgeProjects({
    rootDirs: opts.scanRoots ?? defaultScanRoots(),
    maxDepth: opts.scanMaxDepth ?? 3,
  });

  // Union + aggregate by GIT REPO ROOT: runs dispatched against a monorepo
  // subdir (e.g. .../wnba-led-scoreboard/web-admin) roll up under one project
  // keyed by the repo root, so the list shows one entry per repo, not one per
  // subdir. Non-git dirs are their own root (findGitRoot returns them as-is).
  const byRoot = new Map<string, ProjectAggregate>();
  const fold = (dir: string, runCount: number, inFlightCount: number, lastRunAt: string): void => {
    const root = findGitRoot(dir);
    const cur = byRoot.get(root);
    if (!cur) {
      byRoot.set(root, { projectDir: root, lastRunAt, runCount, inFlightCount });
    } else {
      cur.runCount += runCount;
      cur.inFlightCount += inFlightCount;
      if (lastRunAt > cur.lastRunAt) cur.lastRunAt = lastRunAt;
    }
  };
  for (const a of dbAggs) fold(a.projectDir, a.runCount, a.inFlightCount, a.lastRunAt);
  // forge-init'd projects with no runs yet: ensure their root exists (0 counts).
  for (const fp of fsProjects) fold(fp.projectDir, 0, 0, "");

  // #153: per-project live session count, also folded to the repo root.
  const liveByRoot = new Map<string, number>();
  for (const hb of loadHeartbeats()) {
    if (!hb.isLive) continue;
    const root = findGitRoot(hb.projectDir);
    liveByRoot.set(root, (liveByRoot.get(root) ?? 0) + 1);
  }
  for (const root of liveByRoot.keys()) {
    if (!byRoot.has(root)) byRoot.set(root, { projectDir: root, lastRunAt: "", runCount: 0, inFlightCount: 0 });
  }

  const out: ProjectRecord[] = [];
  for (const agg of byRoot.values()) {
    const meta = resolveProjectMeta(agg.projectDir);
    if (!meta) continue;  // null projectDir shouldn't happen here
    const record: ProjectRecord = {
      projectDir: agg.projectDir,
      label: meta.label,
      color: meta.color,
      runCount: agg.runCount,
      inFlightCount: agg.inFlightCount,
      hasBacklogMd: existsSync(join(agg.projectDir, "BACKLOG.md")),
      liveSessions: liveByRoot.get(agg.projectDir) ?? 0,
      ...(meta.description ? { description: meta.description } : {}),
      ...(agg.lastRunAt ? { lastRunAt: agg.lastRunAt } : {}),
    };
    const readme = readReadmeFirstLine(agg.projectDir);
    if (readme) record.readmeFirstLine = readme;
    out.push(record);
  }
  return out;
}

export function findProject(query: string, projects: ProjectRecord[]): ProjectRecord | undefined {
  // Match in priority order: exact projectDir, exact label, basename, substring of label.
  const lower = query.toLowerCase();
  return (
    projects.find((p) => p.projectDir === query) ??
    projects.find((p) => p.label === query) ??
    projects.find((p) => p.projectDir.split("/").pop() === query) ??
    projects.find((p) => p.label.toLowerCase().includes(lower)) ??
    projects.find((p) => p.projectDir.toLowerCase().includes(lower))
  );
}

export function sortProjects(
  projects: ProjectRecord[],
  order: "activity" | "name",
): ProjectRecord[] {
  const out = [...projects];
  if (order === "name") {
    out.sort((a, b) => a.label.localeCompare(b.label));
  } else {
    out.sort((a, b) => {
      // Live orchestrator sessions float to the top.
      if (a.liveSessions !== b.liveSessions) return b.liveSessions - a.liveSessions;
      // Then by last run (recent first), with never-run projects after run-once projects.
      if (a.lastRunAt && !b.lastRunAt) return -1;
      if (b.lastRunAt && !a.lastRunAt) return 1;
      if (!a.lastRunAt && !b.lastRunAt) return a.label.localeCompare(b.label);
      return (b.lastRunAt ?? "").localeCompare(a.lastRunAt ?? "");
    });
  }
  return out;
}

function defaultScanRoots(): string[] {
  const env = process.env["FORGE_PROJECT_SCAN_ROOTS"];
  if (env) return env.split(",").map((s) => s.trim()).filter(Boolean);
  const home = process.env["HOME"];
  return home ? [join(home, "code")] : [];
}

function readReadmeFirstLine(projectDir: string): string | undefined {
  for (const name of ["README.md", "README", "Readme.md", "readme.md"]) {
    const path = join(projectDir, name);
    if (!existsSync(path)) continue;
    try {
      const content = readFileSync(path, "utf8");
      // First non-empty, non-heading-marker line.
      for (const rawLine of content.split("\n")) {
        const line = rawLine.replace(/^#+\s*/, "").trim();
        if (line.length > 0) return line.slice(0, 120);
      }
    } catch {
      // ignore
    }
  }
  return undefined;
}
