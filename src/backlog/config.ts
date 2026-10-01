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
import { isDeepStrictEqual } from "node:util";
import { parse as parseYaml } from "yaml";
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

// FG-851: every refusal to write .forge/config.yml (or the host config) — named,
// carrying the path and the reason, with nothing written.
export class ConfigWriteRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigWriteRefusal";
  }
}

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
      throw new ConfigWriteRefusal(
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
      throw new ConfigWriteRefusal(
        `forge: refusing to write ${configPath} — ` +
          `${forgeIdentity.kind !== "resolved" ? describeIdentity(forgeIdentity) : describeIdentity(projectIdentity)} ` +
          `does not resolve, so containment inside the project cannot be established.`,
      );
    }
    const realForge = forgeIdentity.physical;
    const realExpected = join(projectIdentity.physical, ".forge");
    if (realForge !== realExpected) {
      throw new ConfigWriteRefusal(
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
// FG-851: the pre-flight also runs the project_key line edit (with a placeholder
// key, nothing written), so an unparseable or unexpressible file is refused here
// rather than inside the transaction.
export function assertConfigWritable(projectDir: string): void {
  const configPath = safeConfigPath(projectDir);
  editTopLevelConfigText(configPath, readIfPresent(configPath) ?? "", "project_key", "pk-preflight");
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
//
// FG-845: and a compare-and-swap — `expected` is the text the edit was computed from
// (null: the file was absent). Two writers that read the same prior bytes would
// otherwise each rename their own edit into place and the second would silently drop
// the first's line; the target is re-read immediately before the rename and a
// mismatch is refused with nothing written, so the caller can re-read and retry.
function atomicWriteConfig(projectDir: string, contents: string, expected: string | null): void {
  atomicReplaceInDir(resolvedForgeDir(projectDir), "config.yml", contents, expected);
}

function resolvedForgeDir(projectDir: string): string {
  safeConfigPath(projectDir);
  // FG-693: the same one contract. An unresolvable .forge here is a named
  // refusal, not a raw filesystem throw out of a TOCTOU-critical window — and
  // never a lexical guess we then open a file descriptor against.
  const forgeIdentity = identify(join(projectDir, ".forge"));
  if (forgeIdentity.kind !== "resolved") {
    throw new ConfigWriteRefusal(
      `forge: refusing to write ${join(projectDir, ".forge", "config.yml")} — ` +
        `${describeIdentity(forgeIdentity)}; the .forge dir must resolve immediately before the write.`,
    );
  }
  return forgeIdentity.physical;
}

function atomicReplaceInDir(realDir: string, basename: string, contents: string, expected: string | null): void {
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
    refuseIfMoved(target, expected);
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

function refuseIfMoved(target: string, expected: string | null): void {
  if (readIfPresent(target) !== expected) {
    throw new ConfigWriteRefusal(
      `forge: refusing to write ${target} — it changed while this edit was being made (another writer got there first); nothing was written, retry`,
    );
  }
}

/** FG-845: what a config write replaced — `previous` is null when the file was absent. */
export type ConfigEdit = { previous: string | null; next: string };

// FG-845: put back the bytes an edit replaced (the CLI's undo when the audit of an
// applied change cannot be recorded). Compare-and-swap like every write: refused when
// the file no longer holds the edit's own bytes, so a later writer is never clobbered.
function restoreInDir(realDir: string, name: string, edit: ConfigEdit): void {
  if (edit.previous !== null) {
    atomicReplaceInDir(realDir, name, edit.previous, edit.next);
    return;
  }
  const target = join(realDir, name);
  refuseIfMoved(target, edit.next);
  unlinkSync(target);
}

export function restoreProjectConfig(projectDir: string, edit: ConfigEdit): void {
  restoreInDir(resolvedForgeDir(projectDir), "config.yml", edit);
}

export function restoreHostConfig(configPath: string, edit: ConfigEdit): void {
  restoreInDir(resolvedHostDir(configPath), basename(configPath), edit);
}

// FG-851: backlog.prefix (and, when the caller supplies one, the top-level
// project_key) are edited LINE-wise like every other config write — the operator's
// comments, blank lines, key order and quoting survive, and a file forge cannot edit
// safely is refused with nothing written, never "healed" by overwrite. An unrelated
// write never clears a committed project_key; projectKey: null removes the line.
export function writeBacklogConfig(
  projectDir: string,
  config: { prefix: string | null; projectKey?: string | null },
): void {
  const configPath = safeConfigPath(projectDir);
  const previous = readIfPresent(configPath);
  const next = backlogConfigText(configPath, previous ?? "", config);
  mkdirSync(join(projectDir, ".forge"), { recursive: true });
  atomicWriteConfig(projectDir, next, previous);
}

// FG-851: the same guard and edit as writeBacklogConfig with nothing written, so a
// caller can refuse BEFORE it has changed anything else.
export function assertBacklogConfigWritable(
  projectDir: string,
  config: { prefix: string | null; projectKey?: string | null },
): void {
  const configPath = safeConfigPath(projectDir);
  backlogConfigText(configPath, readIfPresent(configPath) ?? "", config);
}

function backlogConfigText(
  configPath: string,
  text: string,
  config: { prefix: string | null; projectKey?: string | null },
): string {
  const next = editBacklogPrefixText(configPath, text, config.prefix);
  if (config.projectKey === undefined) return next;
  return editTopLevelConfigText(configPath, next, "project_key", config.projectKey) ?? next;
}

// FG-606: persist the durable project_key at the TOP LEVEL. This is the single write
// path the heal ladder uses for a config that has no key yet. FG-851: through the
// shared line-oriented top-level edit — every other byte of the file is untouched.
export function writeProjectKey(projectDir: string, projectKey: string): void {
  writeTopLevelConfigKey(projectDir, "project_key", projectKey);
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
  const keyLines = scanKeyLines(lines);
  const minIndent = keyLines.length === 0 ? 0 : Math.min(...keyLines.map((k) => k.indent.length));
  const hits = keyLines.filter((k) => k.indent.length === minIndent && k.key === key);
  if (hits.length > 1) {
    throw new ConfigWriteRefusal(`forge: refusing to rewrite ${configPath} — it carries more than one top-level '${key}' line`);
  }
  const hit = hits[0];

  if (value === null) {
    if (!hit) return null;
    lines.splice(hit.i, 1);
  } else if (hit) {
    lines[hit.i] = replacedValueLine(configPath, lines[hit.i]!, hit, key, renderScalar(value));
  } else {
    const indent = keyLines.find((k) => k.indent.length === minIndent)?.indent ?? "";
    const sep = text.length === 0 || text.endsWith("\n") ? "" : eol;
    return checked(configPath, `${text}${sep}${indent}${key}: ${renderScalar(value)}${eol}`, key, value, verify);
  }
  return checked(configPath, lines.join("\n"), key, value, verify);
}

type KeyLine = { i: number; indent: string; key: string; rest: string };

function scanKeyLines(lines: string[]): KeyLine[] {
  const keyLines: KeyLine[] = [];
  lines.forEach((raw, i) => {
    const m = raw.replace(/\r$/, "").match(/^(\s*)([A-Za-z_][A-Za-z0-9_-]*)\s*:(.*)$/);
    if (m) keyLines.push({ i, indent: m[1] ?? "", key: m[2] ?? "", rest: m[3] ?? "" });
  });
  return keyLines;
}

// Replace the value on one `key: value` line, keeping its indentation, trailing
// comment and line ending. A value that spans lines (block scalar) or is a flow
// collection cannot be replaced by rewriting one line, so it is refused by name.
function replacedValueLine(configPath: string, raw: string, hit: KeyLine, key: string, rendered: string): string {
  const cr = raw.endsWith("\r") ? "\r" : "";
  const body = stripComment(hit.rest);
  const current = body.trim();
  if (/^[|>]/.test(current) || /^[[{]/.test(current)) {
    const shape = /^[|>]/.test(current) ? "a block scalar" : "a flow collection";
    throw new ConfigWriteRefusal(
      `forge: refusing to rewrite ${configPath} — its '${key}' value is ${shape}, which a line edit cannot ` +
        `replace safely; edit the file by hand`,
    );
  }
  const comment = hit.rest.slice(body.length);
  const spacer = comment ? (body.match(/\s*$/)?.[0] || " ") : "";
  return `${hit.indent}${key}: ${rendered}${spacer}${comment}${cr}`;
}

// A value is written bare when YAML reads it back as exactly that string, and
// double-quoted (JSON is valid YAML) otherwise.
function renderScalar(value: string): string {
  try {
    const parsed = parseYaml(`k: ${value}`) as Record<string, unknown> | null;
    if (parsed?.["k"] === value) return value;
  } catch {
    // not expressible bare
  }
  return JSON.stringify(value);
}

// FG-851: set `prefix` inside the top-level `backlog:` block mapping — replace its
// line in place, or insert one line directly under `backlog:` at the block's own
// indent — or append a two-line block when there is none. Every other byte is
// untouched, and the edited file must parse to exactly the original mapping with
// only backlog.prefix changed; anything else is a refusal that writes nothing.
export function editBacklogPrefixText(configPath: string, text: string, prefix: string | null): string {
  const before = parseMappingOrRefuse(configPath, text);
  const block = before["backlog"];
  if (block != null && (typeof block !== "object" || Array.isArray(block))) {
    throw new ConfigWriteRefusal(`forge: refusing to rewrite ${configPath} — its 'backlog' value is not a mapping; edit the file by hand`);
  }
  const rendered = prefix === null ? "null" : renderScalar(prefix);

  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const cr = eol === "\r\n" ? "\r" : "";
  const lines = text.split("\n");
  const keyLines = scanKeyLines(lines);
  const minIndent = keyLines.length === 0 ? 0 : Math.min(...keyLines.map((k) => k.indent.length));
  const heads = keyLines.filter((k) => k.indent.length === minIndent && k.key === "backlog");
  if (heads.length > 1) {
    throw new ConfigWriteRefusal(`forge: refusing to rewrite ${configPath} — it carries more than one top-level 'backlog' line`);
  }
  const head = heads[0];

  let next: string;
  if (!head) {
    const indent = keyLines.find((k) => k.indent.length === minIndent)?.indent ?? "";
    const sep = text.length === 0 || text.endsWith("\n") ? "" : eol;
    next = `${text}${sep}${indent}backlog:${eol}${indent}  prefix: ${rendered}${eol}`;
  } else {
    const inline = stripComment(head.rest).trim();
    if (inline !== "") {
      throw new ConfigWriteRefusal(
        `forge: refusing to rewrite ${configPath} — its 'backlog' value is written inline (${inline}), ` +
          `not as a block mapping a line edit can extend; edit the file by hand`,
      );
    }
    let end = head.i + 1;
    let childIndent: string | undefined;
    for (let j = head.i + 1; j < lines.length; j++) {
      const line = lines[j]!.replace(/\r$/, "");
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("#")) continue;
      const indent = line.match(/^\s*/)?.[0] ?? "";
      if (indent.length <= head.indent.length) break;
      childIndent ??= indent;
      end = j + 1;
    }
    const hits = keyLines.filter((k) => k.i > head.i && k.i < end && k.indent === childIndent && k.key === "prefix");
    if (hits.length > 1) {
      throw new ConfigWriteRefusal(`forge: refusing to rewrite ${configPath} — its 'backlog' block carries more than one 'prefix' line`);
    }
    const hit = hits[0];
    if (hit) {
      lines[hit.i] = replacedValueLine(configPath, lines[hit.i]!, hit, "prefix", rendered);
    } else {
      lines.splice(head.i + 1, 0, `${childIndent ?? `${head.indent}  `}prefix: ${rendered}${cr}`);
    }
    next = lines.join("\n");
  }

  const after = parseMappingOrRefuse(configPath, next, "the edited file");
  const expected = { ...before, backlog: { ...((block as Record<string, unknown> | null) ?? {}), prefix } };
  if (!isDeepStrictEqual(after, expected)) {
    throw new ConfigWriteRefusal(
      `forge: refusing to rewrite ${configPath} — editing the 'backlog.prefix' line would not resolve it to ` +
        `${prefix === null ? "null" : `'${prefix}'`} with everything else unchanged; edit the file by hand`,
    );
  }
  return next;
}

function checked(configPath: string, next: string, key: string, value: string | null, verify?: TopLevelEditVerify): string {
  const map = parseMappingOrRefuse(configPath, next, "the edited file");
  const has = Object.prototype.hasOwnProperty.call(map, key);
  const ok = value === null ? !has : map[key] === value;
  if (!ok || (verify && !verify(next))) {
    throw new ConfigWriteRefusal(
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
    throw new ConfigWriteRefusal(`forge: refusing to rewrite ${configPath} — ${what} is not valid YAML (${(err as Error).message})`);
  }
  if (parsed == null) return {};
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConfigWriteRefusal(`forge: refusing to rewrite ${configPath} — ${what === "it" ? "its" : `${what}'s`} top level is not a mapping`);
  }
  return parsed as Record<string, unknown>;
}

function readIfPresent(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

// FG-799: set a single TOP-LEVEL scalar key in .forge/config.yml through the
// line-oriented edit above and the same symlink-guarded atomic write as
// writeProjectKey. Creates the file/dir if absent.
export function writeTopLevelConfigKey(projectDir: string, key: string, value: string, verify?: TopLevelEditVerify): ConfigEdit {
  const configPath = safeConfigPath(projectDir);
  const previous = readIfPresent(configPath);
  const next = editTopLevelConfigText(configPath, previous ?? "", key, value, verify)!;
  mkdirSync(join(projectDir, ".forge"), { recursive: true });
  atomicWriteConfig(projectDir, next, previous);
  return { previous, next };
}

// FG-845: remove a single TOP-LEVEL key line from .forge/config.yml. Returns null —
// writing nothing — when the file or the key is absent.
export function removeTopLevelConfigKey(projectDir: string, key: string, verify?: TopLevelEditVerify): ConfigEdit | null {
  const configPath = safeConfigPath(projectDir);
  const previous = readIfPresent(configPath);
  if (previous === null) return null;
  const next = editTopLevelConfigText(configPath, previous, key, null, verify);
  if (next === null) return null;
  atomicWriteConfig(projectDir, next, previous);
  return { previous, next };
}

// FG-845: set a TOP-LEVEL scalar key in the HOST config ($FORGE_HOME/config.yml)
// through the same line-oriented edit, with an atomic temp+rename in the resolved
// $FORGE_HOME. Created when absent. A symlinked config.yml is refused rather than
// replaced, matching the project path.
export function writeHostConfigKey(configPath: string, key: string, value: string, verify?: TopLevelEditVerify): ConfigEdit {
  const previous = refuseHostSymlink(configPath);
  const next = editTopLevelConfigText(configPath, previous ?? "", key, value, verify)!;
  mkdirSync(dirname(configPath), { recursive: true });
  atomicReplaceInDir(resolvedHostDir(configPath), basename(configPath), next, previous);
  return { previous, next };
}

function refuseHostSymlink(configPath: string): string | null {
  let isLink = false;
  try {
    isLink = lstatSync(configPath).isSymbolicLink();
  } catch {
    // absent — nothing to follow
  }
  if (isLink) throw new ConfigWriteRefusal(`forge: refusing to write ${configPath} — it is a symlink.`);
  return readIfPresent(configPath);
}

function resolvedHostDir(configPath: string): string {
  const dirIdentity = identify(dirname(configPath));
  if (dirIdentity.kind !== "resolved") {
    throw new ConfigWriteRefusal(`forge: refusing to write ${configPath} — ${describeIdentity(dirIdentity)}.`);
  }
  return dirIdentity.physical;
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
