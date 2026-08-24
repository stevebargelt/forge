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
import { liveOrchestratorSessions } from "./orchestrator-heartbeats.js";
import {
  getWorkspacePurpose,
  classificationForKind,
  DEFAULT_WORKSPACE_KIND,
  type WorkspaceKind,
  type WorkspaceClassification,
} from "../store/workspace-purpose.js";
import type { CleanupReason } from "../v2/run-cleanup-report.js";
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
  liveSessions: number;   // #153/FG-576: live interactive orchestrator sessions, any provider, counted once each
  githubUrl?: string;
  // ── FG-745: durable workspace purpose / ownership, as STRUCTURED data ─────────
  // Every record carries these so both the CLI and the dashboard consume ONE shared
  // seam (AC7). `purpose` is the recorded workspace kind (default 'unclassified' —
  // the VISIBLE fail-safe); `classification` is its three-valued presentation form.
  // Artifact status is a RECORDED FACT joined from the workspace_purposes store by
  // the primary checkout's proven canonical path — never inferred from a path
  // prefix, basename, ticket-shaped name, run count, missing remote, or age.
  //
  // Optional on the TYPE only so hand-built fixtures need not spell them; the real
  // aggregation path (aggregateProjectSignals) ALWAYS populates both, defaulting to
  // 'unclassified' (the visible fail-safe). operatorProjects() treats an absent
  // classification as visible, never as an artifact.
  purpose?: WorkspaceKind;
  classification?: WorkspaceClassification;
  /** The owning project/run declared for a Forge artifact (FG-663 identity). */
  owner?: WorkspaceProjectOwner;
  /** An FG-677 retention outcome carried onto the artifact's purpose row (AC6). */
  retentionReason?: CleanupReason;
};

/** The owner attribution surfaced on an annotated ProjectRecord. */
export type WorkspaceProjectOwner = {
  projectIdentity?: string;
  runId?: string;
  taskId?: string;
};

/** What a purpose resolver returns for one checkout root. Undefined means "no
 *  recorded purpose" — which annotates as `unclassified` (visible fail-safe). */
export type ProjectPurposeInfo = {
  purpose: WorkspaceKind;
  owner?: WorkspaceProjectOwner;
  retentionReason?: CleanupReason;
};

/** Injected the same way as RepositoryIdentityResolver, so aggregateProjectSignals
 *  stays a pure seam the projection-matrix tests can drive with a fake store. The
 *  default (below) reads the real workspace_purposes store by proven canonical path. */
export type WorkspacePurposeResolver = (checkoutRoot: string) => ProjectPurposeInfo | undefined;

/** The default resolver: join a checkout root to its recorded purpose in the store
 *  by its PROVEN canonical path. Never throws (getWorkspacePurpose degrades to
 *  undefined on an unmigrated/read-only/absent store), so a store hiccup renders
 *  `unclassified/visible`, never a hidden project. */
export function storeWorkspacePurposeResolver(checkoutRoot: string): ProjectPurposeInfo | undefined {
  const purpose = getWorkspacePurpose(checkoutRoot);
  if (!purpose) return undefined;
  const owner: WorkspaceProjectOwner = {};
  if (purpose.projectIdentity) owner.projectIdentity = purpose.projectIdentity;
  if (purpose.runId) owner.runId = purpose.runId;
  if (purpose.taskId) owner.taskId = purpose.taskId;
  return {
    purpose: purpose.kind,
    ...(Object.keys(owner).length > 0 ? { owner } : {}),
    ...(purpose.reason ? { retentionReason: purpose.reason } : {}),
  };
}

/** The pure membership filter both the CLI (`forge projects list`) and the dashboard
 *  grid consume (AC7). Drops ONLY records whose purpose is an EXPLICITLY-recorded
 *  artifact kind; KEEPS operator projects AND unclassified ones (the visible,
 *  flagged fail-safe). It consults nothing but the recorded `classification` — no
 *  path, name, age, run-count, or remote-presence signal decides visibility. */
export function operatorProjects(records: ProjectRecord[]): ProjectRecord[] {
  return records.filter((record) => record.classification !== "artifact");
}

// FG-438: re-exported so the dashboard can derive per-project GitHub links without
// listProjects() (a hot path) paying the git-remote cost for every caller.
export { deriveGithubUrl, githubBrowserUrl } from "./github-url.js";

export type ListOptions = {
  scanRoots?: string[];   // defaults to [~/code] if HOME set
  scanMaxDepth?: number;
  heartbeatsDir?: string; // FG-576: override for tests; never the operator's ~/.forge
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

/** FG-745 (RF-1): resolve a record's purpose PER MEMBER, so an artifact checkout that
 *  CONVERGED onto its source's repository identity cannot suppress its operator sibling
 *  (nor lose its own artifact fact silently). The invariant: only an EXPLICITLY-recorded
 *  artifact kind suppresses a top-level entry, so a record is an artifact ONLY when EVERY
 *  member is a recorded artifact — one operator or unclassified sibling keeps the entry
 *  VISIBLE. The displayed purpose/owner come from the governing member: the primary's
 *  artifact row when the whole record is an artifact, otherwise the strongest non-artifact
 *  claim (an explicit operator member, else `unclassified` — the visible fail-safe). */
function resolveRecordPurpose(
  members: MutableCheckout[],
  primary: MutableCheckout,
  resolvePurpose: WorkspacePurposeResolver,
): { purpose: WorkspaceKind; info: ProjectPurposeInfo | undefined } {
  const memberInfos = members.map((member) => resolvePurpose(member.projectDir));
  const allArtifact = memberInfos.every(
    (info) => classificationForKind(info?.purpose ?? DEFAULT_WORKSPACE_KIND) === "artifact",
  );
  if (allArtifact) {
    const primaryInfo = resolvePurpose(primary.projectDir);
    return { purpose: primaryInfo?.purpose ?? DEFAULT_WORKSPACE_KIND, info: primaryInfo };
  }
  const operatorInfo = memberInfos.find((info) => info?.purpose === "operator");
  return { purpose: operatorInfo?.purpose ?? DEFAULT_WORKSPACE_KIND, info: operatorInfo };
}

/** Pure aggregation seam used by listProjects and repository-identity tests. */
export function aggregateProjectSignals(
  signals: ProjectSignal[],
  resolveIdentity: RepositoryIdentityResolver = repositoryCheckoutIdentity,
  resolvePurpose: WorkspacePurposeResolver = () => undefined,
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
    // FG-745 (RF-1): the purpose join, resolved PER MEMBER. A repository record groups
    // checkouts by converging identity; normally a Forge disposable clone / worktree is
    // its OWN repository (one member, its proven canonical path recorded at creation).
    // But a clone/worktree CAN converge onto its source checkout's repository identity,
    // so a record may group an artifact member with its operator sibling. Suppression is
    // therefore per-member, never from the preferred member: see resolveRecordPurpose.
    const { purpose, info: purposeInfo } = resolveRecordPurpose(members, primary, resolvePurpose);
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
      purpose,
      classification: classificationForKind(purpose),
      ...(purposeInfo?.owner ? { owner: purposeInfo.owner } : {}),
      ...(purposeInfo?.retentionReason ? { retentionReason: purposeInfo.retentionReason } : {}),
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
    // FG-576 D12 / FG-689 D11: ONE session may now have TWO files in
    // ~/.forge/orchestrators — the launcher's record and the Claude hook's.
    // liveOrchestratorSessions() merges on the canonical session identity, so
    // this stays one `liveSessions: 1` signal per session rather than per file.
    ...liveOrchestratorSessions(opts.heartbeatsDir ? { heartbeatsDir: opts.heartbeatsDir } : {})
      .filter((session) => session.projectDir)
      .map((session) => ({ projectDir: session.projectDir, liveSessions: 1 })),
  ];
  // The FULL annotated set: run-scoping and `forge projects show` reach every record,
  // including suppressed artifacts. The operatorProjects() membership filter is applied
  // by the CLI list and the dashboard grid — this is the one shared seam (AC7).
  return aggregateProjectSignals(signals, repositoryCheckoutIdentity, storeWorkspacePurposeResolver);
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
      const prose = extractReadmeProse(readFileSync(path, "utf8"));
      if (prose) return prose;
    } catch {
      // ignore
    }
  }
  return undefined;
}

// FG-759 (#3a): the card description must be a real sentence, never markup. Many
// READMEs open with an HTML wrapper (`<p align="center">`), a heading, or a wall of
// CI/coverage badges before the first prose line. Strip that framing per line and
// return the first line that carries actual prose — or nothing.
export function extractReadmeProse(content: string): string | undefined {
  // Strip HTML comments across the whole document first: a comment can span multiple
  // lines (`<!--\n logo\n-->`), which a per-line strip would miss and then leak as prose.
  const withoutComments = content.replace(/<!--[\s\S]*?-->/g, "");
  for (const rawLine of withoutComments.split("\n")) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    if (/^#{1,6}(\s|$)/.test(trimmed)) continue; // a markdown heading is the title, not a description
    // A line that reduces to ONLY link/image/badge markup is framing, not prose — its label
    // must not be promoted (invariant #3: never return a link). Remove links/images ENTIRELY
    // here (not to their labels) and skip if nothing of substance remains; genuine prose with
    // an inline link survives because its surrounding words keep alphanumerics below.
    const linkless = trimmed
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "") // markdown images / shield badges
      .replace(/\[[^\]]*\]\([^)]*\)/g, "") // markdown links removed whole, label and all
      .replace(/<a\b[^>]*>[\s\S]*?<\/a>/gi, "") // HTML anchors removed whole
      .replace(/<[^>]+>/g, "")
      .replace(/[*_`~]/g, "")
      .trim();
    if (!/[A-Za-z0-9]/.test(linkless)) continue; // line is entirely link/image/badge markup
    const line = trimmed
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "") // markdown images / shield badges
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // markdown links → their text
      .replace(/<[^>]+>/g, "") // HTML/markup tags
      .replace(/[*_`~]/g, "") // inline emphasis markers
      .trim();
    if (!line) continue;
    // A residual '<' or '>' means the line carried markup the tag/comment strips could not
    // fully remove — e.g. an unterminated tag (`<p align="left"` with no closing '>') that
    // /<[^>]+>/g never matches, or a stray comment delimiter. Treat it as markup, not prose.
    if (/[<>]/.test(line)) continue;
    if (/^[-=*_]{3,}$/.test(line)) continue; // horizontal rules
    if (!/[A-Za-z0-9]/.test(line)) continue; // punctuation-only separators
    return line.slice(0, 120);
  }
  return undefined;
}
