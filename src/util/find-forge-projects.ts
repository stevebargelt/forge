// Scans the filesystem for directories that have been initialized by
// `forge init` — detected by the presence of CLAUDE.md containing the
// forge:orchestrator-start marker. Used by `forge projects list` (#152)
// to complement the DB-derived list with projects that have been
// initialized but haven't yet had a run dispatched.
//
// Scan is bounded by max depth + a skip-list of common heavy/irrelevant
// directories (node_modules, .git, dist, build). The skip-list is the
// load-bearing piece — without it, a scan of ~/code on a developer
// machine can take minutes traversing nested node_modules.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ORCHESTRATOR_MARKER = "<!-- forge:orchestrator-start -->";

// Common dirs we never descend into. Match by name; case-sensitive.
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".cache",
  ".next",
  ".turbo",
  "dist",
  "build",
  "out",
  "target",
  "vendor",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".idea",
  ".vscode",      // not the .vscode INSIDE a project we're looking for; that's a leaf, but we shouldn't recurse into it
  "Pods",
  "DerivedData",
]);

export type FoundProject = {
  projectDir: string;
};

export type FindOptions = {
  rootDirs: string[];     // absolute paths to scan
  maxDepth?: number;      // default 3
};

export function findForgeProjects(opts: FindOptions): FoundProject[] {
  const maxDepth = opts.maxDepth ?? 3;
  const found = new Map<string, FoundProject>();
  for (const root of opts.rootDirs) {
    if (!existsSync(root)) continue;
    walk(root, 0, maxDepth, found);
  }
  return Array.from(found.values());
}

function walk(dir: string, depth: number, maxDepth: number, found: Map<string, FoundProject>): void {
  if (depth > maxDepth) return;

  // Check this dir for the orchestrator marker.
  if (hasOrchestratorMarker(dir)) {
    found.set(dir, { projectDir: dir });
    // Don't descend further inside a known forge project — nested forge
    // projects are unusual and not worth the scan cost.
    return;
  }

  // Descend.
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;  // permission denied, broken symlink, etc.
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    if (name.startsWith(".") && depth >= 1) continue;  // hide dotfiles below the root level
    const sub = join(dir, name);
    let st;
    try {
      st = statSync(sub);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walk(sub, depth + 1, maxDepth, found);
    }
  }
}

function hasOrchestratorMarker(dir: string): boolean {
  const claudeMd = join(dir, "CLAUDE.md");
  if (!existsSync(claudeMd)) return false;
  try {
    const content = readFileSync(claudeMd, "utf8");
    return content.includes(ORCHESTRATOR_MARKER);
  } catch {
    return false;
  }
}
