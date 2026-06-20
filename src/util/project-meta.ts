// Resolves a project's display metadata (label + color + optional description)
// for dashboard rendering.
//
// Label source preference (#151):
//   1. <projectDir>/.forge/project.json → `name` field. Override for projects
//      whose dir basename isn't friendly ("pocket-v1" → "Pocket — typing tutor").
//   2. basename(projectDir).
//
// Color source preference (#143):
//   1. <projectDir>/.vscode/settings.json → workbench.colorCustomizations
//      .titleBar.activeBackground (matches the color the user already uses to
//      identify the project's VS Code window).
//   2. FNV-1a hash of projectDir → HSL hue. Deterministic; always legible
//      against the dashboard's dark background at the chosen S/L values.
//
// Cache lives for the lifetime of the dashboard process — restart `forge
// dashboard start` to pick up .vscode/settings.json or .forge/project.json
// changes. Hot-reload via fs.watch is out of scope (see #143 spec).

import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { findGitRoot } from "./git-root.js";

export type ProjectMeta = {
  label: string;
  color: string;
  // Optional one-line "what this project is" string from .forge/project.json.
  // Read by the resolver but not surfaced through ActivityEntry/InFlightEntry —
  // the future Projects view (#154) consumes it; per-task cards don't.
  description?: string;
};

// Auth configuration from .forge/project.json (FG-158).
// auth: bedrock → arms CLAUDE_CODE_USE_BEDROCK=1 + AWS_PROFILE for the child.
// auth: oauth   → no-op default; claude uses OAuth credentials as normal.
// auth: apikey  → verifies ANTHROPIC_API_KEY is set before launch.
// awsProfile    → overrides AWS_PROFILE resolution when auth=bedrock.
export type ProjectAuthConfig = {
  auth?: "bedrock" | "oauth" | "apikey";
  awsProfile?: string;
};

const cache = new Map<string, ProjectMeta>();

export function resolveProjectMeta(projectDir: string | null): ProjectMeta | null {
  if (!projectDir) return null;
  const cached = cache.get(projectDir);
  if (cached) return cached;
  // Project identity is the git repo root: a monorepo subdir takes the repo's
  // name, and the .forge/project.json name override + color live at the root.
  const root = findGitRoot(projectDir);
  const overrides = readProjectJson(root);
  const meta: ProjectMeta = {
    label: overrides?.name ?? basename(root),
    color: readVscodeColor(root) ?? hashColor(root),
    ...(overrides?.description ? { description: overrides.description } : {}),
  };
  cache.set(projectDir, meta);
  return meta;
}

// Exported for tests — lets a test clear stale cache state between cases that
// reuse the same projectDir but mutate .vscode/settings.json. Not used in
// production code paths.
export function _clearCacheForTesting(): void {
  cache.clear();
}

function readProjectJson(projectDir: string): { name?: string; description?: string } | null {
  const path = join(projectDir, ".forge", "project.json");
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const result: { name?: string; description?: string } = {};
    if (typeof parsed["name"] === "string" && parsed["name"].length > 0) {
      result.name = parsed["name"];
    }
    if (typeof parsed["description"] === "string" && parsed["description"].length > 0) {
      result.description = parsed["description"];
    }
    return result;
  } catch {
    return null;
  }
}

// Read auth configuration from <projectDir>/.forge/project.json (via git root).
// Returns null when the file is absent, unreadable, or contains no auth fields.
export function readProjectAuth(projectDir: string): ProjectAuthConfig | null {
  const root = findGitRoot(projectDir);
  const path = join(root, ".forge", "project.json");
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const result: ProjectAuthConfig = {};
    const auth = parsed["auth"];
    if (auth === "bedrock" || auth === "oauth" || auth === "apikey") {
      result.auth = auth;
    }
    const awsProfile = parsed["awsProfile"];
    if (typeof awsProfile === "string" && awsProfile.length > 0) {
      result.awsProfile = awsProfile;
    }
    return Object.keys(result).length > 0 ? result : null;
  } catch {
    return null;
  }
}

function readVscodeColor(projectDir: string): string | null {
  const path = join(projectDir, ".vscode", "settings.json");
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const cc = parsed["workbench.colorCustomizations"];
    if (!cc || typeof cc !== "object") return null;
    const bg = (cc as Record<string, unknown>)["titleBar.activeBackground"];
    return typeof bg === "string" && bg.length > 0 ? bg : null;
  } catch {
    return null;
  }
}

// FNV-1a 32-bit hash → HSL. S/L fixed for legibility against the dashboard's
// dark background; only the hue varies per project.
function hashColor(s: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 65%, 50%)`;
}
