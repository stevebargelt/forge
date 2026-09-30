// FG-799 (AC1): the per-project ai_attribution reader/writer.
// FG-845 (AC1): the host default beneath it — project → host → default.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  readAiAttribution,
  writeAiAttribution,
  writeHostAiAttribution,
  unsetAiAttribution,
  formatAiAttribution,
} from "./ai-attribution.js";
import {
  classifyAiAttributionReadError,
  parseAiAttributionConfig,
  resolveAiAttributionLevels,
  scalarValue,
  stripComment,
  type AiAttributionLevelRead,
} from "./ai-attribution-parse.js";

// FG-799 (RF-1): import the shipped hook reader's parse helpers to compare them, value
// by value, against the TS copy. The specifier is a runtime-built URL (not a static
// string) so tsc types it `any` rather than demanding a .d.ts for the plain `.mjs`;
// the reader's CLI block is guarded by an import.meta.url check, so importing it here
// has no side effect.
type ParseHelpers = {
  parseAiAttributionConfig(text: string | null): { mode: "allow" | "suppress"; recognized: boolean; present: boolean; duplicate?: true };
  scalarValue(rest: string): string;
  stripComment(s: string): string;
  resolveAiAttributionLevels: typeof resolveAiAttributionLevels;
  classifyAiAttributionReadError: typeof classifyAiAttributionReadError;
  readMode(projectDir: string, hostFile: string): "allow" | "suppress";
};
const readerUrl = new URL("../../scripts/git-hooks/read-ai-attribution.mjs", import.meta.url).href;
const hookReader = (await import(readerUrl)) as ParseHelpers;

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), "forge-ai-attr-"));
}

function writeConfig(dir: string, yaml: string): void {
  mkdirSync(join(dir, ".forge"), { recursive: true });
  writeFileSync(join(dir, ".forge", "config.yml"), yaml);
}

// FG-799 (follow-up): the shared parser table. readAiAttribution and the standalone
// hook reader are BOTH this one algorithm — the whole point of collapsing the bash grep
// and the `yaml` reader onto a single parse. This tier pins the TypeScript side (the
// parser + readAiAttribution) over the table; the integration tier spawns the .mjs
// reader over the SAME rows and pins it to readAiAttribution end-to-end (a unit test may
// not spawn child processes). RF-5 (root key with leading indentation) and RF-6
// (mismatched quotes) are the two edges the old grep and reader DISAGREED on.
type Row = { label: string; config?: string | "unreadable"; mode: "allow" | "suppress" };

export const AI_ATTRIBUTION_TABLE: Row[] = [
  { label: "absent config", config: undefined, mode: "suppress" },
  { label: "allow", config: "ai_attribution: allow\n", mode: "allow" },
  { label: "suppress", config: "ai_attribution: suppress\n", mode: "suppress" },
  { label: "quoted allow", config: 'ai_attribution: "allow"\n', mode: "allow" },
  { label: "single-quoted allow", config: "ai_attribution: 'allow'\n", mode: "allow" },
  { label: "allow with trailing comment", config: "ai_attribution: allow # ok\n", mode: "allow" },
  { label: "root key with leading indentation (RF-5)", config: "  ai_attribution: allow\n", mode: "allow" },
  { label: "nested key (RF-1)", config: "nested:\n  ai_attribution: allow\n", mode: "suppress" },
  { label: "mismatched quotes (RF-6)", config: 'ai_attribution: "allow\'\n', mode: "suppress" },
  { label: "unknown value", config: "ai_attribution: banana\n", mode: "suppress" },
  { label: "duplicate top-level key (FG-845 RF-1)", config: "ai_attribution: allow\nai_attribution: suppress\n", mode: "suppress" },
  { label: "duplicate top-level key, allow twice", config: "ai_attribution: allow\nai_attribution: allow\n", mode: "suppress" },
  { label: "unreadable file", config: "unreadable", mode: "suppress" },
];

test("FG-799: readAiAttribution resolves every table input to the shared parser's mode (RF-1/3/5/6)", () => {
  for (const row of AI_ATTRIBUTION_TABLE) {
    const dir = tmpProject();
    if (row.config === "unreadable") {
      // config.yml as a DIRECTORY makes readFileSync throw regardless of uid (chmod 000
      // is moot under a root container).
      mkdirSync(join(dir, ".forge", "config.yml"), { recursive: true });
    } else if (row.config !== undefined) {
      writeConfig(dir, row.config);
      // the pure parser and the file-reading wrapper must agree on the text case
      assert.equal(parseAiAttributionConfig(row.config).mode, row.mode, `parser mode for ${row.label}`);
    }
    assert.equal(readAiAttribution(dir).mode, row.mode, `readAiAttribution mode for ${row.label}`);
    rmSync(dir, { recursive: true, force: true });
  }
});

// FG-799 (RF-1): the shipped hook reader duplicates the parse by necessity (bare node,
// no node_modules), so the two copies must agree at the level where bytes matter — the
// EXACT values the parse helpers return, not just the resolved mode. The mode-only table
// above is blind to a divergence that fails closed either way: the malformed-quote
// sentinel once differed (space in the reader, NUL in the TS copy) yet both mapped to
// suppress, so no mode assertion could catch it. This pins the helpers by value.
const SCALAR_EDGE_INPUTS = [
  "allow",
  "suppress",
  " allow ",
  '"allow"',
  "'allow'",
  "allow # trailing",
  '"allow',      // opens a double quote it never closes → the malformed-quote sentinel
  "'allow",      // opens a single quote it never closes → the sentinel
  '"allow\'',    // mismatched quotes → the sentinel
  "",
  "   ",
  "# comment-only",
  'x "y" # z',
];

test("FG-799 (RF-1): the hook reader's parse helpers return byte-identical values to the TS copy", () => {
  for (const input of SCALAR_EDGE_INPUTS) {
    assert.equal(hookReader.scalarValue(input), scalarValue(input), `scalarValue divergence on ${JSON.stringify(input)}`);
    assert.equal(hookReader.stripComment(input), stripComment(input), `stripComment divergence on ${JSON.stringify(input)}`);
  }
  // The malformed-quote sentinel is the exact byte that drifted: pin it explicitly and
  // confirm it still fails closed (matches no recognized mode) on BOTH copies.
  const sentinel = scalarValue('"x');
  assert.equal(hookReader.scalarValue('"x'), sentinel, "the malformed-quote sentinel must be byte-identical across copies");
  assert.notEqual(sentinel, "allow");
  assert.notEqual(sentinel, "suppress");

  // And the top-level parse agrees deeply on every config in the shared table.
  for (const row of AI_ATTRIBUTION_TABLE) {
    if (typeof row.config !== "string") continue;
    assert.deepEqual(
      hookReader.parseAiAttributionConfig(row.config),
      parseAiAttributionConfig(row.config),
      `parseAiAttributionConfig divergence on ${row.label}`,
    );
  }
});

function cfg(dir: string): string {
  return join(dir, ".forge", "config.yml");
}

test("readAiAttribution: absent config → suppress (default)", () => {
  const dir = tmpProject();
  const home = tmpProject();
  assert.deepEqual(readAiAttribution(dir, { forgeHome: home }), { mode: "suppress", source: "default", file: null });
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

test("readAiAttribution: allow is read from project config", () => {
  const dir = tmpProject();
  const home = tmpProject();
  writeConfig(dir, "ai_attribution: allow\n");
  assert.deepEqual(readAiAttribution(dir, { forgeHome: home }), { mode: "allow", source: "project", file: cfg(dir) });
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

test("readAiAttribution: explicit suppress reads as project source", () => {
  const dir = tmpProject();
  const home = tmpProject();
  writeConfig(dir, "ai_attribution: suppress\n");
  assert.deepEqual(readAiAttribution(dir, { forgeHome: home }), { mode: "suppress", source: "project", file: cfg(dir) });
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

test("readAiAttribution: unrecognized value fails closed to the suppress default, naming the file", () => {
  const dir = tmpProject();
  const home = tmpProject();
  writeConfig(dir, "ai_attribution: banana\n");
  const r = readAiAttribution(dir, { forgeHome: home });
  assert.equal(r.mode, "suppress");
  assert.equal(r.source, "default");
  assert.equal(r.file, cfg(dir));
  assert.match(r.reason ?? "", /unrecognized ai_attribution value/);
  writeConfig(dir, ":\n  not: yaml: at all\n"); // malformed, no ai_attribution key → absent
  assert.deepEqual(readAiAttribution(dir, { forgeHome: home }), { mode: "suppress", source: "default", file: null });
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

test("readAiAttribution: a NESTED (non-top-level) ai_attribution key reads as the suppress default (RF-1)", () => {
  // The reader honors ONLY the top-level key. An indented key under some other mapping
  // is not the toggle, so it resolves to suppress — and the commit-msg hook's reader
  // must agree (proven in fg799-commit-hook-toggle.integration.test.ts).
  const dir = tmpProject();
  const home = tmpProject();
  writeConfig(dir, "nested:\n  ai_attribution: allow\n");
  assert.deepEqual(readAiAttribution(dir, { forgeHome: home }), { mode: "suppress", source: "default", file: null });
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

test("readAiAttribution: quoted and trailing-comment allow forms read as allow (RF-3 parity)", () => {
  const home = tmpProject();
  for (const yaml of ['ai_attribution: "allow"\n', "ai_attribution: 'allow'\n", "ai_attribution: allow # approved\n"]) {
    const dir = tmpProject();
    writeConfig(dir, yaml);
    assert.deepEqual(
      readAiAttribution(dir, { forgeHome: home }),
      { mode: "allow", source: "project", file: cfg(dir) },
      `reader must treat ${JSON.stringify(yaml)} as allow`,
    );
    rmSync(dir, { recursive: true, force: true });
  }
  rmSync(home, { recursive: true, force: true });
});

// FG-845 (AC1): project → host → default, every combination. Each level is one of:
// absent (no file), no-key (a file without the toggle), allow, suppress, unknown
// (present, unrecognized value), mismatched quotes, unreadable (config.yml is a dir).
// duplicate: the key appears twice at the top level (FG-845 RF-1) — malformed, fails closed.
type Level = "absent" | "no-key" | "allow" | "suppress" | "unknown" | "mismatched" | "duplicate" | "unreadable";
const LEVELS: Level[] = ["absent", "no-key", "allow", "suppress", "unknown", "mismatched", "duplicate", "unreadable"];

function placeLevel(configPath: string, level: Level): void {
  mkdirSync(join(configPath, ".."), { recursive: true });
  switch (level) {
    case "absent":
      return;
    case "no-key":
      writeFileSync(configPath, "project_key: pk-x\n");
      return;
    case "allow":
    case "suppress":
      writeFileSync(configPath, `other: 1\nai_attribution: ${level}\n`);
      return;
    case "unknown":
      writeFileSync(configPath, "ai_attribution: banana\n");
      return;
    case "mismatched":
      writeFileSync(configPath, 'ai_attribution: "allow\'\n');
      return;
    case "duplicate":
      writeFileSync(configPath, "ai_attribution: allow\nother: 1\nai_attribution: suppress\n");
      return;
    case "unreadable":
      mkdirSync(configPath, { recursive: true });
      return;
  }
}

function expected(project: Level, host: Level): { mode: "allow" | "suppress"; source: "project" | "host" | "default"; failedAt?: "project" | "host" } {
  for (const [name, level] of [["project", project], ["host", host]] as const) {
    if (level === "absent" || level === "no-key") continue;
    if (level === "allow" || level === "suppress") return { mode: level, source: name };
    return { mode: "suppress", source: "default", failedAt: name };
  }
  return { mode: "suppress", source: "default" };
}

test("FG-845 (AC1): readAiAttribution resolves project → host → default across every combination; the hook reader agrees", () => {
  for (const p of LEVELS) {
    for (const h of LEVELS) {
      const dir = tmpProject();
      const home = tmpProject();
      const projectFile = cfg(dir);
      const hostFile = join(home, "config.yml");
      placeLevel(projectFile, p);
      placeLevel(hostFile, h);
      const label = `project=${p} host=${h}`;
      const want = expected(p, h);
      const got = readAiAttribution(dir, { forgeHome: home });
      assert.equal(got.mode, want.mode, `mode for ${label}`);
      assert.equal(got.source, want.source, `source for ${label}`);
      if (want.failedAt) {
        assert.equal(got.file, want.failedAt === "project" ? projectFile : hostFile, `failing file for ${label}`);
        assert.ok(got.reason && got.reason.includes(got.file!), `reason names the file for ${label}`);
      } else {
        assert.equal(got.reason, undefined, `no reason for ${label}`);
        assert.equal(
          got.file,
          want.source === "project" ? projectFile : want.source === "host" ? hostFile : null,
          `file for ${label}`,
        );
      }
      const overrides = want.source === "project" && (h === "allow" || h === "suppress") && h !== want.mode;
      assert.deepEqual(got.overridesHost, overrides ? { mode: h, file: hostFile } : undefined, `overridesHost for ${label}`);
      assert.equal(hookReader.readMode(dir, hostFile), want.mode, `hook reader mode for ${label}`);
      rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  }
});

test("FG-845: a malformed host value never reads as allow and never masks a project value", () => {
  const dir = tmpProject();
  const home = tmpProject();
  writeFileSync(join(home, "config.yml"), "ai_attribution: yes-please\n");
  const r = readAiAttribution(dir, { forgeHome: home });
  assert.equal(r.mode, "suppress");
  assert.equal(r.source, "default");
  assert.match(r.reason ?? "", /config\.yml carries an unrecognized ai_attribution value/);
  writeConfig(dir, "ai_attribution: allow\n");
  assert.deepEqual(readAiAttribution(dir, { forgeHome: home }), { mode: "allow", source: "project", file: cfg(dir) });
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

test("FG-845 (RF-1): a duplicated top-level ai_attribution key fails closed at its level with a named reason, never falling through", () => {
  const dup = "ai_attribution: allow\nai_attribution: suppress\n";
  assert.deepEqual(parseAiAttributionConfig(dup), { mode: "suppress", recognized: false, present: true, duplicate: true });
  assert.deepEqual(hookReader.parseAiAttributionConfig(dup), parseAiAttributionConfig(dup));
  // a nested second key is not a duplicate of the top-level one
  assert.deepEqual(parseAiAttributionConfig("ai_attribution: allow\nx:\n  ai_attribution: suppress\n"), {
    mode: "allow",
    recognized: true,
    present: true,
  });
  const text = (t: string): AiAttributionLevelRead => ({ kind: "text", text: t });
  const allowHost = text("ai_attribution: allow\n");
  assert.deepEqual(resolveAiAttributionLevels(text(dup), allowHost), {
    mode: "suppress",
    source: "default",
    failed: { level: "project", why: "duplicate" },
  });
  assert.deepEqual(hookReader.resolveAiAttributionLevels(text(dup), allowHost), resolveAiAttributionLevels(text(dup), allowHost));

  const dir = tmpProject();
  const home = tmpProject();
  writeConfig(dir, dup);
  writeFileSync(join(home, "config.yml"), "ai_attribution: allow\n");
  const r = readAiAttribution(dir, { forgeHome: home });
  assert.equal(r.mode, "suppress");
  assert.equal(r.source, "default");
  assert.equal(r.file, cfg(dir));
  assert.match(r.reason ?? "", /carries more than one top-level ai_attribution key.*failing closed to suppress/);
  assert.equal(hookReader.readMode(dir, join(home, "config.yml")), "suppress");
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

test("FG-845: the host file defaults to $FORGE_HOME/config.yml, resolved at call time", () => {
  const dir = tmpProject();
  const home = tmpProject();
  const prev = process.env.FORGE_HOME;
  process.env.FORGE_HOME = home;
  try {
    writeFileSync(join(home, "config.yml"), "ai_attribution: allow\n");
    assert.deepEqual(readAiAttribution(dir), { mode: "allow", source: "host", file: join(home, "config.yml") });
  } finally {
    if (prev === undefined) delete process.env.FORGE_HOME;
    else process.env.FORGE_HOME = prev;
  }
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

const LEVEL_READS: AiAttributionLevelRead[] = [
  { kind: "absent" },
  { kind: "unreadable" },
  { kind: "text", text: "x: 1\n" },
  { kind: "text", text: "ai_attribution: allow\n" },
  { kind: "text", text: "ai_attribution: suppress\n" },
  { kind: "text", text: "ai_attribution: banana\n" },
  { kind: "text", text: "ai_attribution: allow\nai_attribution: suppress\n" },
];

test("FG-845: the hook reader's level resolution returns byte-identical values to the TS copy", () => {
  for (const p of LEVEL_READS) {
    for (const h of LEVEL_READS) {
      assert.deepEqual(
        hookReader.resolveAiAttributionLevels(p, h),
        resolveAiAttributionLevels(p, h),
        `resolveAiAttributionLevels divergence on ${JSON.stringify([p, h])}`,
      );
    }
  }
  for (const code of ["ENOENT", "ENOTDIR", "EISDIR", "EACCES", undefined]) {
    const err = Object.assign(new Error("x"), code ? { code } : {});
    assert.deepEqual(hookReader.classifyAiAttributionReadError(err), classifyAiAttributionReadError(err), `classify ${code}`);
  }
});

test("writeAiAttribution: round-trips and PRESERVES other keys", () => {
  const dir = tmpProject();
  writeConfig(dir, "project_key: pk-abc\nbacklog:\n  prefix: FG\n");

  writeAiAttribution(dir, "allow");
  assert.equal(readAiAttribution(dir).mode, "allow");

  const parsed = parseYaml(readFileSync(join(dir, ".forge", "config.yml"), "utf8")) as Record<string, unknown>;
  assert.equal(parsed["project_key"], "pk-abc", "project_key preserved");
  assert.deepEqual(parsed["backlog"], { prefix: "FG" }, "backlog subtree preserved");
  assert.equal(parsed["ai_attribution"], "allow", "snake_case key written to YAML");

  // Flipping back is a clean read-modify-write, still preserving neighbors.
  writeAiAttribution(dir, "suppress");
  const parsed2 = parseYaml(readFileSync(join(dir, ".forge", "config.yml"), "utf8")) as Record<string, unknown>;
  assert.equal(parsed2["ai_attribution"], "suppress");
  assert.equal(parsed2["project_key"], "pk-abc");
  rmSync(dir, { recursive: true, force: true });
});

test("writeAiAttribution: creates .forge/config.yml when absent", () => {
  const dir = tmpProject();
  writeAiAttribution(dir, "allow");
  assert.equal(readAiAttribution(dir).mode, "allow");
  rmSync(dir, { recursive: true, force: true });
});

test("formatAiAttribution: the exact strings config-show / doctor print", () => {
  assert.equal(formatAiAttribution({ mode: "suppress", source: "default" }), "ai attribution: suppress (default)");
  assert.equal(formatAiAttribution({ mode: "allow", source: "project" }), "ai attribution: allow (project)");
  assert.equal(formatAiAttribution({ mode: "allow", source: "host" }), "ai attribution: allow (host)");
});

test("FG-845: writeHostAiAttribution creates the host file, then read-modify-writes preserving neighbours", () => {
  const home = join(tmpProject(), "nested-home");
  const file = writeHostAiAttribution("allow", { forgeHome: home });
  assert.equal(file, join(home, "config.yml"));
  assert.deepEqual(parseYaml(readFileSync(file, "utf8")), { ai_attribution: "allow" });
  writeFileSync(file, "telemetry: off\nai_attribution: allow\nnested:\n  k: v\n");
  writeHostAiAttribution("suppress", { forgeHome: home });
  assert.deepEqual(parseYaml(readFileSync(file, "utf8")), { telemetry: "off", ai_attribution: "suppress", nested: { k: "v" } });
  rmSync(join(home, ".."), { recursive: true, force: true });
});

test("FG-845: writeHostAiAttribution refuses a symlinked host config", () => {
  const home = tmpProject();
  const target = join(tmpProject(), "elsewhere.yml");
  writeFileSync(target, "x: 1\n");
  symlinkSync(target, join(home, "config.yml"));
  assert.throws(() => writeHostAiAttribution("allow", { forgeHome: home }), /is a symlink/);
  assert.equal(readFileSync(target, "utf8"), "x: 1\n");
  rmSync(home, { recursive: true, force: true });
});

test("FG-845: unsetAiAttribution removes only the key; absent key/file is a no-op; unparseable is refused", () => {
  const dir = tmpProject();
  assert.equal(unsetAiAttribution(dir), false, "no file → no-op");
  writeConfig(dir, "project_key: pk-abc\nai_attribution: allow\nbacklog:\n  prefix: FG\n");
  assert.equal(unsetAiAttribution(dir), true);
  assert.deepEqual(parseYaml(readFileSync(cfg(dir), "utf8")), { project_key: "pk-abc", backlog: { prefix: "FG" } });
  const before = readFileSync(cfg(dir), "utf8");
  assert.equal(unsetAiAttribution(dir), false, "absent key → no-op");
  assert.equal(readFileSync(cfg(dir), "utf8"), before, "no-op writes nothing");
  writeConfig(dir, "ai_attribution: allow\n  bad: [\n");
  assert.throws(() => unsetAiAttribution(dir), /not valid YAML/);
  rmSync(dir, { recursive: true, force: true });
});
