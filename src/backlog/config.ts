import {
  closeSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { describeIdentity, identify } from "../util/path-identity.js";
import { stripComment } from "../v2/ai-attribution-parse.js";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import type { RetentionOverrides } from "../v2/retention-policy.js";

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
  //
  // FG-693: both sides come from the ONE identity contract, and an UNPROVEN side
  // is a refusal rather than a raw ENOENT escaping a security guard. Note what is
  // deliberately NOT done here: `realExpected` is a LEXICAL join onto the proven
  // project dir, never itself resolved, and the two are compared as proven bytes
  // rather than through compareIdentity(). Resolving the expected path would
  // follow the very symlink this check exists to catch — a `.forge` pointing
  // outside the project would resolve identically on both sides and the guard
  // would pass. The comparison is containment, not identity.
  if (existsSync(forgeDir)) {
    const forgeIdentity = identify(forgeDir);
    const projectIdentity = identify(projectDir);
    if (forgeIdentity.kind !== "resolved" || projectIdentity.kind !== "resolved") {
      throw new Error(
        `forge: refusing to write ${configPath} — ` +
          `${forgeIdentity.kind !== "resolved" ? describeIdentity(forgeIdentity) : describeIdentity(projectIdentity)} ` +
          `does not resolve, so containment inside the project cannot be established.`,
      );
    }
    const realForge = forgeIdentity.physical;
    const realExpected = join(projectIdentity.physical, ".forge");
    if (realForge !== realExpected) {
      throw new Error(
        `forge: refusing to write ${configPath} — resolved .forge dir '${realForge}' is ` +
          `outside the project '${realExpected}'.`,
      );
    }
  }
  return configPath;
}

// FG-606: the import runs the guarded config heal INSIDE its SQLite write
// transaction, BEFORE the commit — a symlink/containment refusal there rolls the
// whole transaction back (zero DB changes). Pre-flight that same guard BEFORE the
// transaction opens so an import that WILL heal config fails closed before it
// claims a registry identity. Kept redundantly at write time (below) for TOCTOU.
export function assertConfigWritable(projectDir: string): void {
  safeConfigPath(projectDir);
}

// A single short atomic replacement: write an UNPREDICTABLE temp file inside the
// resolved .forge dir, then rename onto the target (atomic on the same
// filesystem). A crash mid-write leaves either the old file or the temp — never a
// torn config.
//
// FG-606 security: the temp path is opened with O_CREAT|O_EXCL|O_WRONLY|O_NOFOLLOW
// — a pre-planted file OR symlink at the temp path is a HARD failure, never a
// follow-through write that would escape the project (the class the old predictable
// `${configPath}.tmp-${pid}` + writeFileSync was vulnerable to). The final config is
// safe by construction: rename(2) never follows a symlink at the destination — it
// replaces the name itself — and safeConfigPath already refused a symlinked
// config.yml. We re-run safeConfigPath and realpath the .forge dir HERE, immediately
// before the open, so no unresolved path is re-derived between the guard and the
// write (TOCTOU); the guarded open then happens on the resolved dir.
function atomicWriteConfig(projectDir: string, contents: string): void {
  safeConfigPath(projectDir);
  // FG-693: the same one contract. An unresolvable .forge here is a named
  // refusal, not a raw filesystem throw out of a TOCTOU-critical window — and
  // never a lexical guess we then open a file descriptor against.
  const forgeIdentity = identify(join(projectDir, ".forge"));
  if (forgeIdentity.kind !== "resolved") {
    throw new Error(
      `forge: refusing to write ${join(projectDir, ".forge", "config.yml")} — ` +
        `${describeIdentity(forgeIdentity)}; the .forge dir must resolve immediately before the write.`,
    );
  }
  atomicReplaceInDir(forgeIdentity.physical, "config.yml", contents);
}

function atomicReplaceInDir(realDir: string, basename: string, contents: string): void {
  const target = join(realDir, basename);
  const tmp = join(realDir, `.${basename}.tmp-${randomBytes(12).toString("hex")}`);
  const fd = openSync(
    tmp,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeSync(fd, contents);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, target);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // best-effort cleanup of the temp on a failed rename
    }
    throw err;
  }
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
  atomicWriteConfig(projectDir, stringifyYaml(existing));
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
  atomicWriteConfig(projectDir, stringifyYaml(existing));
}

// FG-590: read the OPTIONAL `retention` override block from .forge/config.yml.
//
// Returns undefined when the file, or the `retention` block, is ABSENT — that is the
// upgrade AC in one line: retention defaults live in code (retention-policy.ts), so a
// project that never edits config gets the safe defaults and this returns nothing to
// override them with. A present block contributes only the fields it names; a field that
// is not a finite, non-negative number is dropped (so resolveRetention falls through to
// env/default for it) rather than throwing. A malformed file, a foreign/non-object
// `retention` value, or a read error all read as "no override", never as an exception —
// this is a diagnostics-lifecycle read, and it must never be the thing that breaks a
// command. NOTHING is ever written here: reading the config never materializes defaults
// into it. Durations are MILLISECONDS, matching RetentionOverrides.
// FG-845: the ONE edit behind every top-level scalar config write (project set, host
// set, project unset). The config file is operator-owned prose as much as data, so
// the edit is LINE-oriented: replace the existing top-level `key:` line in place
// (keeping its indentation and any trailing comment), append one line when absent,
// or delete exactly that line — every other byte is left untouched. YAML is parsed
// only to VALIDATE: the file before and after must parse as a mapping, the result
// must carry exactly the intended value, and the caller's `verify` must accept it.
// Anything else is a refusal that writes nothing. Returns null when an unset finds
// no key (nothing to write).
export type TopLevelEditVerify = (text: string) => boolean;

export function editTopLevelConfigText(
  configPath: string,
  text: string,
  key: string,
  value: string | null,
  verify?: TopLevelEditVerify,
): string | null {
  parseMappingOrRefuse(configPath, text);

  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split("\n");
  const keyLines: { i: number; indent: string; key: string; rest: string }[] = [];
  lines.forEach((raw, i) => {
    const m = raw.replace(/\r$/, "").match(/^(\s*)([A-Za-z_][A-Za-z0-9_-]*)\s*:(.*)$/);
    if (m) keyLines.push({ i, indent: m[1] ?? "", key: m[2] ?? "", rest: m[3] ?? "" });
  });
  const minIndent = keyLines.length === 0 ? 0 : Math.min(...keyLines.map((k) => k.indent.length));
  const hits = keyLines.filter((k) => k.indent.length === minIndent && k.key === key);
  if (hits.length > 1) {
    throw new Error(`forge: refusing to rewrite ${configPath} — it carries more than one top-level '${key}' line`);
  }
  const hit = hits[0];

  if (value === null) {
    if (!hit) return null;
    lines.splice(hit.i, 1);
  } else if (hit) {
    const cr = lines[hit.i]!.endsWith("\r") ? "\r" : "";
    const body = stripComment(hit.rest);
    const comment = hit.rest.slice(body.length);
    const spacer = comment ? (body.match(/\s*$/)?.[0] || " ") : "";
    lines[hit.i] = `${hit.indent}${key}: ${value}${spacer}${comment}${cr}`;
  } else {
    const indent = keyLines.find((k) => k.indent.length === minIndent)?.indent ?? "";
    const sep = text.length === 0 || text.endsWith("\n") ? "" : eol;
    return checked(configPath, `${text}${sep}${indent}${key}: ${value}${eol}`, key, value, verify);
  }
  return checked(configPath, lines.join("\n"), key, value, verify);
}

function checked(configPath: string, next: string, key: string, value: string | null, verify?: TopLevelEditVerify): string {
  const map = parseMappingOrRefuse(configPath, next, "the edited file");
  const has = Object.prototype.hasOwnProperty.call(map, key);
  const ok = value === null ? !has : map[key] === value;
  if (!ok || (verify && !verify(next))) {
    throw new Error(
      `forge: refusing to rewrite ${configPath} — editing the top-level '${key}' line would not ` +
        (value === null ? `remove '${key}'` : `resolve '${key}' to '${value}'`) +
        `; edit the file by hand`,
    );
  }
  return next;
}

function parseMappingOrRefuse(configPath: string, text: string, what = "it"): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (err) {
    throw new Error(`forge: refusing to rewrite ${configPath} — ${what} is not valid YAML (${(err as Error).message})`);
  }
  if (parsed == null) return {};
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`forge: refusing to rewrite ${configPath} — ${what === "it" ? "its" : `${what}'s`} top level is not a mapping`);
  }
  return parsed as Record<string, unknown>;
}

function readIfPresent(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

// FG-799: set a single TOP-LEVEL scalar key in .forge/config.yml through the
// line-oriented edit above and the same symlink-guarded atomic write as
// writeProjectKey. Creates the file/dir if absent.
export function writeTopLevelConfigKey(projectDir: string, key: string, value: string, verify?: TopLevelEditVerify): void {
  const configPath = safeConfigPath(projectDir);
  const next = editTopLevelConfigText(configPath, readIfPresent(configPath) ?? "", key, value, verify);
  mkdirSync(join(projectDir, ".forge"), { recursive: true });
  atomicWriteConfig(projectDir, next!);
}

// FG-845: remove a single TOP-LEVEL key line from .forge/config.yml. Returns false —
// writing nothing — when the file or the key is absent.
export function removeTopLevelConfigKey(projectDir: string, key: string, verify?: TopLevelEditVerify): boolean {
  const configPath = safeConfigPath(projectDir);
  const text = readIfPresent(configPath);
  if (text === null) return false;
  const next = editTopLevelConfigText(configPath, text, key, null, verify);
  if (next === null) return false;
  atomicWriteConfig(projectDir, next);
  return true;
}

// FG-845: set a TOP-LEVEL scalar key in the HOST config ($FORGE_HOME/config.yml)
// through the same line-oriented edit, with an atomic temp+rename in the resolved
// $FORGE_HOME. Created when absent. A symlinked config.yml is refused rather than
// replaced, matching the project path.
export function writeHostConfigKey(configPath: string, key: string, value: string, verify?: TopLevelEditVerify): void {
  const dir = dirname(configPath);
  let isLink = false;
  try {
    isLink = lstatSync(configPath).isSymbolicLink();
  } catch {
    // absent — nothing to follow
  }
  if (isLink) throw new Error(`forge: refusing to write ${configPath} — it is a symlink.`);
  const next = editTopLevelConfigText(configPath, readIfPresent(configPath) ?? "", key, value, verify);
  mkdirSync(dir, { recursive: true });
  const dirIdentity = identify(dir);
  if (dirIdentity.kind !== "resolved") {
    throw new Error(`forge: refusing to write ${configPath} — ${describeIdentity(dirIdentity)}.`);
  }
  atomicReplaceInDir(dirIdentity.physical, basename(configPath), next!);
}

export function readRetentionConfig(projectDir: string): RetentionOverrides | undefined {
  const configPath = join(projectDir, ".forge", "config.yml");
  if (!existsSync(configPath)) return undefined;
  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(configPath, "utf8"));
  } catch {
    return undefined; // malformed YAML or read error — defaults ship in code
  }
  const top = (parsed as Record<string, unknown> | null) ?? {};
  const block = top["retention"];
  if (block === null || typeof block !== "object" || Array.isArray(block)) return undefined;
  const b = block as Record<string, unknown>;
  const overrides: RetentionOverrides = {};
  const successMs = numericField(b["successMs"]);
  const failureMs = numericField(b["failureAmbiguousMs"]);
  if (successMs !== undefined) overrides.successMs = successMs;
  if (failureMs !== undefined) overrides.failureAmbiguousMs = failureMs;
  // An empty/foreign block (no recognized numeric field) contributes no override.
  return overrides.successMs === undefined && overrides.failureAmbiguousMs === undefined ? undefined : overrides;
}

/** A config value accepted as a retention duration IFF it is a finite, non-negative
 *  number; anything else (string, negative, NaN, object) is dropped so the layer below
 *  (env, then the code default) supplies it. */
function numericField(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
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
