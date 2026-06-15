import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";

const BacklogConfigSchema = z.object({
  prefix: z.string().nullable().default(null),
});

const ForgeConfigSchema = z.object({
  backlog: BacklogConfigSchema.optional(),
});

export type BacklogConfig = z.infer<typeof BacklogConfigSchema>;

export function writeBacklogConfig(projectDir: string, config: BacklogConfig): void {
  const configPath = join(projectDir, ".forge", "config.yml");
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
  writeFileSync(configPath, stringifyYaml(existing));
}

export function readBacklogConfig(projectDir: string): BacklogConfig {
  const configPath = join(projectDir, ".forge", "config.yml");
  if (!existsSync(configPath)) {
    return { prefix: null };
  }
  try {
    const raw = readFileSync(configPath, "utf8");
    const parsed = parseYaml(raw);
    const result = ForgeConfigSchema.safeParse(parsed);
    if (!result.success) {
      return { prefix: null };
    }
    return result.data.backlog ?? { prefix: null };
  } catch {
    // Malformed YAML or read error — tolerate with null fallback
    return { prefix: null };
  }
}
