import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";

const BacklogConfigSchema = z.object({
  prefix: z.string().nullable().default(null),
});

const ForgeConfigSchema = z.object({
  backlog: BacklogConfigSchema.optional(),
});

// FG-606: project_key is a durable, COMMITTED top-level field in .forge/config.yml
// — shared across every clone and linked worktree of a project, so the DB backlog
// (keyed by (project_key, ticket_id)) never splits across worktrees. It is read
// from and written to the TOP LEVEL, deliberately NOT via ForgeConfigSchema (which
// strips unknown top-level keys), so a committed key is never parsed away.
export type BacklogConfig = {
  prefix: string | null;
  projectKey: string | null;
};

// FG-606 security: the project_key / backlog config write path must never follow a
// repo-controlled SYMLINK. A hostile `.forge/config.yml` (or a symlinked `.forge`
// dir) could redirect the write at an arbitrary file outside the project and
// clobber it. lstat both the dir and the file (lstat does NOT dereference); if
// either is a symlink — or the real `.forge` escapes the real project dir — fail
// closed and write NOTHING. Returns the safe config path for the caller to write.
function safeConfigPath(projectDir: string): string {
  const forgeDir = join(projectDir, ".forge");
  const configPath = join(forgeDir, "config.yml");
  for (const target of [forgeDir, configPath]) {
    let st;
    try {
      st = lstatSync(target);
    } catch {
      continue; // absent — nothing to follow
    }
    if (st.isSymbolicLink()) {
      throw new Error(
        `forge: refusing to write ${configPath} — ${target} is a symlink. A symlinked ` +
          `.forge config can redirect the write outside the project; replace it with a real ` +
          `file and retry.`,
      );
    }
  }
  // Defense in depth: the resolved .forge dir must live inside the resolved project dir.
  if (existsSync(forgeDir)) {
    const realForge = realpathSync(forgeDir);
    const realExpected = join(realpathSync(projectDir), ".forge");
    if (realForge !== realExpected) {
      throw new Error(
        `forge: refusing to write ${configPath} — resolved .forge dir '${realForge}' is ` +
          `outside the project '${realExpected}'.`,
      );
    }
  }
  return configPath;
}

export function writeBacklogConfig(
  projectDir: string,
  config: { prefix: string | null; projectKey?: string | null },
): void {
  const configPath = safeConfigPath(projectDir);
  mkdirSync(join(projectDir, ".forge"), { recursive: true });

  let existing: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      existing = (parseYaml(readFileSync(configPath, "utf8")) as Record<string, unknown>) ?? {};
    } catch {
      // malformed — overwrite cleanly
    }
  }
  existing["backlog"] = { ...(existing["backlog"] as Record<string, unknown> ?? {}), prefix: config.prefix };
  // Only touch the top-level project_key when the caller explicitly supplies one;
  // an unrelated write (e.g. `forge init` setting the prefix) must PRESERVE any
  // committed key, never clear it.
  if (config.projectKey !== undefined) {
    existing["project_key"] = config.projectKey;
  }
  writeFileSync(configPath, stringifyYaml(existing));
}

// FG-606: persist the durable project_key at the TOP LEVEL, preserving every
// unrelated top-level YAML key and the entire backlog subtree (including
// backlog.prefix) untouched — mirroring writeBacklogConfig's spread-existing
// precedent. This is the single write path the import orchestrator uses to heal
// a config that has no key yet (ladder rungs 2 and 4).
export function writeProjectKey(projectDir: string, projectKey: string): void {
  const configPath = safeConfigPath(projectDir);
  mkdirSync(join(projectDir, ".forge"), { recursive: true });

  let existing: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      existing = (parseYaml(readFileSync(configPath, "utf8")) as Record<string, unknown>) ?? {};
    } catch {
      // malformed — overwrite cleanly
    }
  }
  existing["project_key"] = projectKey;
  writeFileSync(configPath, stringifyYaml(existing));
}

export function readBacklogConfig(projectDir: string): BacklogConfig {
  const configPath = join(projectDir, ".forge", "config.yml");
  if (!existsSync(configPath)) {
    return { prefix: null, projectKey: null };
  }
  try {
    const raw = readFileSync(configPath, "utf8");
    const parsed = parseYaml(raw);
    // project_key is read from the RAW top level — ForgeConfigSchema would strip
    // it as an unknown key. Guard against non-string values.
    const rawTop = (parsed as Record<string, unknown> | null) ?? {};
    const rawKey = rawTop["project_key"];
    const projectKey = typeof rawKey === "string" && rawKey.length > 0 ? rawKey : null;

    const result = ForgeConfigSchema.safeParse(parsed);
    if (!result.success) {
      return { prefix: null, projectKey };
    }
    return { prefix: result.data.backlog?.prefix ?? null, projectKey };
  } catch {
    // Malformed YAML or read error — tolerate with null fallback
    return { prefix: null, projectKey: null };
  }
}
