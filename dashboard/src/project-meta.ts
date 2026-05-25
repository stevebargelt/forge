// Resolves a project's display metadata (label + color) for dashboard rendering.
// Color source preference:
//   1. <projectDir>/.vscode/settings.json → workbench.colorCustomizations
//      .titleBar.activeBackground (matches the color the user already uses to
//      identify the project's VS Code window).
//   2. FNV-1a hash of projectDir → HSL hue. Deterministic; always legible
//      against the dashboard's dark background at the chosen S/L values.
//
// Cache lives for the lifetime of the dashboard process — restart `forge
// dashboard start` to pick up .vscode/settings.json changes. Hot-reload via
// fs.watch is out of scope (see #143 spec).

import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

export type ProjectMeta = { label: string; color: string };

const cache = new Map<string, ProjectMeta>();

export function resolveProjectMeta(projectDir: string | null): ProjectMeta | null {
  if (!projectDir) return null;
  const cached = cache.get(projectDir);
  if (cached) return cached;
  const meta: ProjectMeta = {
    label: basename(projectDir),
    color: readVscodeColor(projectDir) ?? hashColor(projectDir),
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
