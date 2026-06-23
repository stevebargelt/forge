import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, globSync } from "node:fs";
import { join } from "node:path";

export type FlagKind = "forge_shim" | "dependency_surgery" | "stub_module";

export type AntiShimFlag = {
  kind: FlagKind;
  path: string;
  detail: string;
};

export type EnvFabricationResult = {
  clean: boolean;
  flags: AntiShimFlag[];
};

export type DetectOptions = {
  /** Skip the real git call; provide porcelain-format lines instead (for tests). */
  gitStatusLines?: string[];
};

const DEPENDENCY_SURGERY_TARGETS = new Set(["package.json", "package-lock.json", "tsconfig.json"]);

function getWorkspacePatterns(projectDir: string): string[] {
  const pkgPath = join(projectDir, "package.json");
  if (!existsSync(pkgPath)) return [];
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as any;
    const ws: unknown = pkg.workspaces;
    if (Array.isArray(ws)) return ws as string[];
    if (ws != null && typeof ws === "object" && Array.isArray((ws as Record<string, unknown>)["packages"])) {
      return (ws as Record<string, unknown[]>)["packages"] as string[];
    }
  } catch {
    // ignore malformed package.json
  }
  return [];
}

function flagForgeShimsInDir(dir: string, relPrefix: string, flags: AntiShimFlag[]): void {
  const forgeDir = join(dir, "node_modules", "@forge");
  if (!existsSync(forgeDir)) return;
  for (const entry of readdirSync(forgeDir)) {
    flags.push({
      kind: "forge_shim",
      path: join(relPrefix, "node_modules", "@forge", entry),
      detail: `@forge/${entry} found in ${relPrefix}node_modules — @forge/* are tsconfig path aliases, never real installed packages`,
    });
  }
}

function checkForgeShims(projectDir: string, flags: AntiShimFlag[]): void {
  flagForgeShimsInDir(projectDir, "", flags);

  const patterns = getWorkspacePatterns(projectDir);
  for (const pattern of patterns) {
    let members: string[];
    try {
      members = globSync(pattern, { cwd: projectDir });
    } catch {
      continue;
    }
    for (const member of members) {
      flagForgeShimsInDir(join(projectDir, member), `${member}/`, flags);
    }
  }
}

function getGitStatusLines(projectDir: string, opts: DetectOptions): string[] {
  if (opts.gitStatusLines !== undefined) return opts.gitStatusLines;
  try {
    const out = execSync("git status --porcelain", { cwd: projectDir, encoding: "utf8" });
    return out.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

function checkDependencySurgery(lines: string[], flags: AntiShimFlag[]): void {
  for (const line of lines) {
    if (line.length < 3) continue;
    const xy = line.slice(0, 2);
    // Skip untracked and ignored entries
    if (xy === "??" || xy === "!!") continue;
    const filePath = line.slice(3).trim();
    const basename = filePath.split("/").at(-1) ?? "";
    if (DEPENDENCY_SURGERY_TARGETS.has(basename)) {
      flags.push({
        kind: "dependency_surgery",
        path: filePath,
        detail: `${basename} has git-tracked modifications (status: ${xy.trim() || "modified"}) — may indicate dependency surgery`,
      });
    }
  }
}

function checkStubModules(projectDir: string, lines: string[], flags: AntiShimFlag[]): void {
  for (const line of lines) {
    if (!line.startsWith("??")) continue;
    const filePath = line.slice(3).trim();
    if (!filePath.startsWith("src/") || !filePath.endsWith(".ts")) continue;
    const fullPath = join(projectDir, filePath);
    if (!existsSync(fullPath)) continue;
    let content: string;
    try {
      content = readFileSync(fullPath, "utf8");
    } catch {
      continue;
    }
    if (/^\s*(?:export|import)(?:\s+type\s+)?.+["']@forge\//m.test(content)) {
      flags.push({
        kind: "stub_module",
        path: filePath,
        detail: `untracked src/*.ts references @forge/* — possible path-alias stub (best-effort heuristic)`,
      });
    }
  }
}

/** Inspect projectDir for environment fabrication signatures.
 *  Returns `clean: true` only when there are zero flags. Never throws on flags. */
export function detectEnvFabrication(projectDir: string, opts: DetectOptions = {}): EnvFabricationResult {
  const flags: AntiShimFlag[] = [];

  checkForgeShims(projectDir, flags);

  const lines = getGitStatusLines(projectDir, opts);
  checkDependencySurgery(lines, flags);
  checkStubModules(projectDir, lines, flags);

  return { clean: flags.length === 0, flags };
}
