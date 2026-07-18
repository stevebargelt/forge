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
// Union by canonical repository identity; each repository record retains its
// member checkout roots and exact observed projectDirs for operational scope.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { uniqueProjectDirs } from "../store/runs.js";
import { findForgeProjects } from "./find-forge-projects.js";
import { resolveProjectMeta } from "./project-meta.js";
import { loadHeartbeats } from "./orchestrator-heartbeats.js";
import {
  repositoryCheckoutIdentity,
  type RepositoryCheckoutIdentity,
} from "./repository-identity.js";

export type ProjectCheckout = {
  projectDir: string;
  /** Exact observed run/session paths resolved to this checkout root. */
  projectDirs: string[];
  branch?: string;
  exists: boolean;
  runCount: number;
  inFlightCount: number;
  liveSessions: number;
  lastRunAt?: string;
};

export type ProjectRecord = {
  key: string;
  /** Backward-compatible alias for primaryCheckout. */
  projectDir: string;
  primaryCheckout: string;
  /** Exact run/session paths belonging to this repository, including subdirs. */
  projectDirs: string[];
  checkouts: ProjectCheckout[];
  label: string;
  color: string;
  description?: string;
  lastRunAt?: string;     // ISO; undefined if no runs yet
  runCount: number;       // 0 for filesystem-only projects
  inFlightCount: number;
  readmeFirstLine?: string;
  liveSessions: number;   // #153: count of live Claude Code orchestrator sessions
  githubUrl?: string;
};

// FG-438: re-exported so the dashboard can derive per-project GitHub links without
// listProjects() (a hot path) paying the git-remote cost for every caller.
export { deriveGithubUrl, githubBrowserUrl } from "./github-url.js";

export type ListOptions = {
  scanRoots?: string[];   // defaults to [~/code] if HOME set
  scanMaxDepth?: number;
};

export type ProjectSignal = {
  projectDir: string;
  lastRunAt?: string;
  runCount?: number;
  inFlightCount?: number;
  liveSessions?: number;
};

export type RepositoryIdentityResolver = (projectDir: string) => RepositoryCheckoutIdentity;

type ResolvedSignal = { signal: ProjectSignal; identity: RepositoryCheckoutIdentity };

type MutableCheckout = Omit<ProjectCheckout, "projectDirs"> & {
  key: string;
  remoteName?: string;
  githubUrl?: string;
  projectDirs: Set<string>;
};

function maxIso(a?: string, b?: string): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

function repositoryLabel(remoteName?: string): string | undefined {
  return remoteName ? remoteName.charAt(0).toUpperCase() + remoteName.slice(1) : undefined;
}

function claudeScratchpadSourceSegment(projectDir: string): string | undefined {
  return projectDir.match(/\/claude-\d+\/([^/]+)\/[^/]+\/scratchpad\//)?.[1];
}

/** A deleted Claude scratchpad retains the source checkout as an exact encoded
 * path segment (for example `-Users-name-code-forge`). Match that segment
 * against observed, existing checkouts. This is stronger evidence than a
 * basename and only applies when it resolves to one canonical repository. */
function recoverScratchpadRepository(item: ResolvedSignal, all: ResolvedSignal[]): RepositoryCheckoutIdentity {
  if (item.identity.exists) return item.identity;
  const sourceSegment = claudeScratchpadSourceSegment(item.signal.projectDir);
  if (!sourceSegment) return item.identity;

  const candidates = new Map<string, RepositoryCheckoutIdentity>();
  for (const candidate of all) {
    if (!candidate.identity.exists) continue;
    const paths = [candidate.signal.projectDir, candidate.identity.checkoutRoot];
    if (!paths.some((path) => path.replaceAll("/", "-") === sourceSegment)) continue;
    candidates.set(candidate.identity.key, candidate.identity);
  }
  if (candidates.size !== 1) return item.identity;
  const source = [...candidates.values()][0]!;
  return {
    ...item.identity,
    key: source.key,
    ...(source.remoteName ? { remoteName: source.remoteName } : {}),
    ...(source.githubUrl ? { githubUrl: source.githubUrl } : {}),
  };
}

function preferredCheckout(checkouts: MutableCheckout[]): MutableCheckout {
  return [...checkouts].sort((a, b) => {
    if (a.exists !== b.exists) return a.exists ? -1 : 1;
    const aRemoteMatch = a.remoteName === a.projectDir.split("/").pop();
    const bRemoteMatch = b.remoteName === b.projectDir.split("/").pop();
    if (aRemoteMatch !== bRemoteMatch) return aRemoteMatch ? -1 : 1;
    const aPrimaryBranch = a.branch === "main" || a.branch === "master";
    const bPrimaryBranch = b.branch === "main" || b.branch === "master";
    if (aPrimaryBranch !== bPrimaryBranch) return aPrimaryBranch ? -1 : 1;
    if (a.liveSessions !== b.liveSessions) return b.liveSessions - a.liveSessions;
    if (a.lastRunAt !== b.lastRunAt) return (b.lastRunAt ?? "").localeCompare(a.lastRunAt ?? "");
    return a.projectDir.localeCompare(b.projectDir);
  })[0]!;
}

/** Pure aggregation seam used by listProjects and repository-identity tests. */
export function aggregateProjectSignals(
  signals: ProjectSignal[],
  resolveIdentity: RepositoryIdentityResolver = repositoryCheckoutIdentity,
): ProjectRecord[] {
  const resolved = signals.map((signal) => ({ signal, identity: resolveIdentity(signal.projectDir) }));
  const byCheckout = new Map<string, MutableCheckout>();
  for (const item of resolved) {
    const { signal } = item;
    const identity = recoverScratchpadRepository(item, resolved);
    let checkout = byCheckout.get(identity.checkoutRoot);
    if (!checkout) {
      checkout = {
        key: identity.key,
        projectDir: identity.checkoutRoot,
        exists: identity.exists,
        runCount: 0,
        inFlightCount: 0,
        liveSessions: 0,
        projectDirs: new Set<string>(),
        ...(identity.branch ? { branch: identity.branch } : {}),
        ...(identity.remoteName ? { remoteName: identity.remoteName } : {}),
        ...(identity.githubUrl ? { githubUrl: identity.githubUrl } : {}),
      };
      byCheckout.set(identity.checkoutRoot, checkout);
    }
    checkout.projectDirs.add(signal.projectDir);
    checkout.runCount += signal.runCount ?? 0;
    checkout.inFlightCount += signal.inFlightCount ?? 0;
    checkout.liveSessions += signal.liveSessions ?? 0;
    checkout.lastRunAt = maxIso(checkout.lastRunAt, signal.lastRunAt);
  }

  const byRepository = new Map<string, MutableCheckout[]>();
  for (const checkout of byCheckout.values()) {
    const list = byRepository.get(checkout.key) ?? [];
    list.push(checkout);
    byRepository.set(checkout.key, list);
  }

  const out: ProjectRecord[] = [];
  for (const [key, members] of byRepository) {
    const primary = preferredCheckout(members);
    const remoteName = members.find((member) => member.remoteName)?.remoteName;
    const meta = resolveProjectMeta(primary.projectDir, {
      fallbackLabel: primary.exists ? repositoryLabel(remoteName) : "Unknown repository",
      colorKey: key,
    });
    if (!meta) continue;
    const sortedMembers = [primary, ...members.filter((member) => member !== primary).sort((a, b) => a.projectDir.localeCompare(b.projectDir))];
    const checkouts: ProjectCheckout[] = sortedMembers.map((member) => ({
      projectDir: member.projectDir,
      projectDirs: [...member.projectDirs].sort(),
      exists: member.exists,
      runCount: member.runCount,
      inFlightCount: member.inFlightCount,
      liveSessions: member.liveSessions,
      ...(member.branch ? { branch: member.branch } : {}),
      ...(member.lastRunAt ? { lastRunAt: member.lastRunAt } : {}),
    }));
    const projectDirs = [...new Set(sortedMembers.flatMap((member) => [...member.projectDirs]))].sort();
    const lastRunAt = members.reduce<string | undefined>((latest, member) => maxIso(latest, member.lastRunAt), undefined);
    const githubUrl = members.find((member) => member.githubUrl)?.githubUrl;
    const record: ProjectRecord = {
      key,
      projectDir: primary.projectDir,
      primaryCheckout: primary.projectDir,
      projectDirs,
      checkouts,
      label: meta.label,
      color: meta.color,
      runCount: members.reduce((sum, member) => sum + member.runCount, 0),
      inFlightCount: members.reduce((sum, member) => sum + member.inFlightCount, 0),
      liveSessions: members.reduce((sum, member) => sum + member.liveSessions, 0),
      ...(meta.description ? { description: meta.description } : {}),
      ...(lastRunAt ? { lastRunAt } : {}),
      ...(githubUrl ? { githubUrl } : {}),
    };
    const readme = readReadmeFirstLine(primary.projectDir);
    if (readme) record.readmeFirstLine = readme;
    out.push(record);
  }
  return out;
}

export function listProjects(opts: ListOptions = {}): ProjectRecord[] {
  const dbAggs = uniqueProjectDirs();
  const fsProjects = findForgeProjects({
    rootDirs: opts.scanRoots ?? defaultScanRoots(),
    maxDepth: opts.scanMaxDepth ?? 3,
  });

  const signals: ProjectSignal[] = [
    ...dbAggs,
    ...fsProjects.map((project) => ({ projectDir: project.projectDir })),
    ...loadHeartbeats().filter((heartbeat) => heartbeat.isLive).map((heartbeat) => ({
      projectDir: heartbeat.projectDir,
      liveSessions: 1,
    })),
  ];
  return aggregateProjectSignals(signals);
}

export function findProject(query: string, projects: ProjectRecord[]): ProjectRecord | undefined {
  // Match in priority order: exact projectDir, exact label, basename, substring of label.
  const lower = query.toLowerCase();
  return (
    projects.find((p) => p.key === query) ??
    projects.find((p) => p.projectDir === query || p.projectDirs.includes(query)) ??
    projects.find((p) => p.label === query) ??
    projects.find((p) => p.checkouts.some((checkout) => checkout.projectDir.split("/").pop() === query)) ??
    projects.find((p) => p.label.toLowerCase().includes(lower)) ??
    projects.find((p) => p.projectDirs.some((projectDir) => projectDir.toLowerCase().includes(lower)))
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
