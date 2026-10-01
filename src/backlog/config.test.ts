import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { editTopLevelConfigText, readBacklogConfig, writeProjectKey, writeBacklogConfig } from "./config.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "forge-backlog-config-test-"));
}

test("readBacklogConfig: missing .forge/config.yml returns null prefix", () => {
  const dir = tmp();
  const cfg = readBacklogConfig(dir);
  assert.equal(cfg.prefix, null);
});

test("readBacklogConfig: present prefix is returned", () => {
  const dir = tmp();
  mkdirSync(join(dir, ".forge"));
  writeFileSync(join(dir, ".forge", "config.yml"), "backlog:\n  prefix: FG\n");
  const cfg = readBacklogConfig(dir);
  assert.equal(cfg.prefix, "FG");
});

test("readBacklogConfig: absent backlog section returns null prefix", () => {
  const dir = tmp();
  mkdirSync(join(dir, ".forge"));
  writeFileSync(join(dir, ".forge", "config.yml"), "other:\n  key: value\n");
  const cfg = readBacklogConfig(dir);
  assert.equal(cfg.prefix, null);
});

test("readBacklogConfig: backlog section without prefix returns null", () => {
  const dir = tmp();
  mkdirSync(join(dir, ".forge"));
  writeFileSync(join(dir, ".forge", "config.yml"), "backlog:\n  other: something\n");
  const cfg = readBacklogConfig(dir);
  assert.equal(cfg.prefix, null);
});

// ─── FG-606: top-level project_key ────────────────────────────────────────────

test("readBacklogConfig: top-level project_key is read (not stripped by the schema)", () => {
  const dir = tmp();
  mkdirSync(join(dir, ".forge"));
  writeFileSync(join(dir, ".forge", "config.yml"), "project_key: pk-abc123\nbacklog:\n  prefix: FG\n");
  const cfg = readBacklogConfig(dir);
  assert.equal(cfg.projectKey, "pk-abc123");
  assert.equal(cfg.prefix, "FG");
});

test("readBacklogConfig: absent project_key reads back null", () => {
  const dir = tmp();
  mkdirSync(join(dir, ".forge"));
  writeFileSync(join(dir, ".forge", "config.yml"), "backlog:\n  prefix: FG\n");
  const cfg = readBacklogConfig(dir);
  assert.equal(cfg.projectKey, null);
});

// AC (9): a config carrying backlog.prefix AND unrelated top-level YAML round-trips
// untouched with project_key added at the top level.
test("writeProjectKey: preserves backlog.prefix and unrelated top-level YAML, adds project_key at top level", () => {
  const dir = tmp();
  mkdirSync(join(dir, ".forge"));
  writeFileSync(
    join(dir, ".forge", "config.yml"),
    "unrelated:\n  keep: me\ntopLevelScalar: 7\nbacklog:\n  prefix: MG\n  format: structured\n",
  );

  writeProjectKey(dir, "pk-deadbeef");

  const raw = parseYaml(readFileSync(join(dir, ".forge", "config.yml"), "utf8")) as Record<string, unknown>;
  assert.equal(raw["project_key"], "pk-deadbeef");
  assert.deepEqual(raw["unrelated"], { keep: "me" });
  assert.equal(raw["topLevelScalar"], 7);
  assert.deepEqual(raw["backlog"], { prefix: "MG", format: "structured" });

  const cfg = readBacklogConfig(dir);
  assert.equal(cfg.projectKey, "pk-deadbeef");
  assert.equal(cfg.prefix, "MG");
});

// Must-fix #1 (security): the project_key write path must NEVER follow a
// repo-controlled symlink. A symlinked .forge/config.yml must cause a refusal and
// NO write through the link to its target.
test("writeProjectKey: refuses to write THROUGH a symlinked .forge/config.yml (no target clobber)", () => {
  const dir = tmp();
  mkdirSync(join(dir, ".forge"));
  // A file OUTSIDE .forge that a hostile symlink points at.
  const victim = join(dir, "victim.txt");
  writeFileSync(victim, "original secret\n");
  symlinkSync(victim, join(dir, ".forge", "config.yml"));

  assert.throws(
    () => writeProjectKey(dir, "pk-evil"),
    (e: unknown) => e instanceof Error && /symlink/i.test((e as Error).message),
  );

  // The link target was NOT overwritten.
  assert.equal(readFileSync(victim, "utf8"), "original secret\n", "victim file untouched");
});

test("writeBacklogConfig: refuses to write THROUGH a symlinked .forge/config.yml", () => {
  const dir = tmp();
  mkdirSync(join(dir, ".forge"));
  const victim = join(dir, "victim.yml");
  writeFileSync(victim, "keep: me\n");
  symlinkSync(victim, join(dir, ".forge", "config.yml"));

  assert.throws(
    () => writeBacklogConfig(dir, { prefix: "FG" }),
    (e: unknown) => e instanceof Error && /symlink/i.test((e as Error).message),
  );
  assert.equal(readFileSync(victim, "utf8"), "keep: me\n", "victim file untouched");
});

test("writeProjectKey: refuses when .forge itself is a symlink", () => {
  const dir = tmp();
  const outside = mkdtempSync(join(tmpdir(), "forge-outside-"));
  symlinkSync(outside, join(dir, ".forge"));

  assert.throws(
    () => writeProjectKey(dir, "pk-evil"),
    (e: unknown) => e instanceof Error && /symlink/i.test((e as Error).message),
  );
  assert.equal(existsSync(join(outside, "config.yml")), false, "no write into the symlinked dir target");
});

// Must-fix (security): the reported bypass — a symlink pre-planted at the
// PREDICTABLE sibling temp path (`config.yml.tmp-<pid>`) redirected the temp write
// outside the project before rename. The hardened atomic write uses an unpredictable
// temp name opened O_EXCL|O_NOFOLLOW, so a link at the old predictable path is inert:
// nothing is written through it and the real config still round-trips.
test("atomic write: a symlink at the OLD predictable temp path is NOT followed; write round-trips", () => {
  const dir = tmp();
  mkdirSync(join(dir, ".forge"));
  const config = "# preserved by a line edit\nunrelated:\n  keep: me\nbacklog:\n  prefix: FG\n";
  writeFileSync(join(dir, ".forge", "config.yml"), config);
  const victim = join(dir, "victim-temp-target.txt");
  writeFileSync(victim, "outside data\n");
  symlinkSync(victim, join(dir, ".forge", `config.yml.tmp-${process.pid}`));

  writeProjectKey(dir, "pk-safe");

  assert.equal(readFileSync(victim, "utf8"), "outside data\n", "planted temp symlink not followed");
  assert.equal(
    readFileSync(join(dir, ".forge", "config.yml"), "utf8"),
    `${config}project_key: pk-safe\n`,
    "the atomic replacement exposes the complete line-edited file, never a partial write",
  );
  const raw = parseYaml(readFileSync(join(dir, ".forge", "config.yml"), "utf8")) as Record<string, unknown>;
  assert.equal(raw["project_key"], "pk-safe");
  assert.deepEqual(raw["unrelated"], { keep: "me" });
  assert.deepEqual(raw["backlog"], { prefix: "FG" });
});

// A successful atomic replacement must not leave a temp file behind in .forge.
test("atomic write: leaves no leftover temp file in .forge after a successful write", () => {
  const dir = tmp();
  mkdirSync(join(dir, ".forge"));
  writeProjectKey(dir, "pk-clean");
  const entries = readdirSync(join(dir, ".forge"));
  assert.deepEqual(
    entries.filter((e) => e.includes(".tmp-")),
    [],
    "no leftover temp file",
  );
  assert.deepEqual(entries.sort(), ["config.yml"]);
});

test("writeBacklogConfig: setting prefix PRESERVES an already-committed project_key", () => {
  const dir = tmp();
  mkdirSync(join(dir, ".forge"));
  writeFileSync(join(dir, ".forge", "config.yml"), "project_key: pk-keepme\nbacklog:\n  prefix: FG\n");

  // A prefix-only write (e.g. `forge init`) must not clear the durable key.
  writeBacklogConfig(dir, { prefix: "ZZ" });

  const cfg = readBacklogConfig(dir);
  assert.equal(cfg.projectKey, "pk-keepme");
  assert.equal(cfg.prefix, "ZZ");
});

// ── FG-590: the optional retention override reader ──

import { readRetentionConfig } from "./config.js";

test("FG-590 readRetentionConfig: absent file returns undefined (defaults ship in code — the upgrade AC)", () => {
  const dir = tmp();
  assert.equal(readRetentionConfig(dir), undefined);
});

test("FG-590 readRetentionConfig: absent retention block returns undefined and writes no config", () => {
  const dir = tmp();
  mkdirSync(join(dir, ".forge"));
  writeFileSync(join(dir, ".forge", "config.yml"), "backlog:\n  prefix: FG\n");
  assert.equal(readRetentionConfig(dir), undefined);
  // No config file was materialized/rewritten — the block is READ-ONLY.
  assert.equal(readFileSync(join(dir, ".forge", "config.yml"), "utf8"), "backlog:\n  prefix: FG\n");
});

test("FG-590 readRetentionConfig: a present block is honored, field by field", () => {
  const dir = tmp();
  mkdirSync(join(dir, ".forge"));
  writeFileSync(join(dir, ".forge", "config.yml"), "retention:\n  successMs: 1000\n  failureAmbiguousMs: 2000\n");
  assert.deepEqual(readRetentionConfig(dir), { successMs: 1000, failureAmbiguousMs: 2000 });
});

test("FG-590 readRetentionConfig: a partial block contributes only its named field", () => {
  const dir = tmp();
  mkdirSync(join(dir, ".forge"));
  writeFileSync(join(dir, ".forge", "config.yml"), "retention:\n  successMs: 42\n");
  assert.deepEqual(readRetentionConfig(dir), { successMs: 42 });
});

test("FG-590 readRetentionConfig: a malformed/foreign block falls back to defaults, never throws", () => {
  const dir = tmp();
  mkdirSync(join(dir, ".forge"));
  // Foreign shapes: a non-object retention, and non-numeric/negative fields.
  writeFileSync(join(dir, ".forge", "config.yml"), "retention: not-an-object\n");
  assert.equal(readRetentionConfig(dir), undefined);
  writeFileSync(join(dir, ".forge", "config.yml"), "retention:\n  successMs: nope\n  failureAmbiguousMs: -5\n");
  assert.equal(readRetentionConfig(dir), undefined);
});

test("FG-590 readRetentionConfig: malformed YAML reads as no override", () => {
  const dir = tmp();
  mkdirSync(join(dir, ".forge"));
  writeFileSync(join(dir, ".forge", "config.yml"), "retention: : : :\n  bad");
  assert.equal(readRetentionConfig(dir), undefined);
});

test("FG-845 editTopLevelConfigText: CRLF line endings and an indented top level are kept", () => {
  assert.equal(editTopLevelConfigText("c.yml", "a: 1\r\nk: x\r\n", "k", "y"), "a: 1\r\nk: y\r\n");
  assert.equal(editTopLevelConfigText("c.yml", "a: 1\r\n", "k", "y"), "a: 1\r\nk: y\r\n");
  assert.equal(editTopLevelConfigText("c.yml", "  a: 1\n", "k", "y"), "  a: 1\n  k: y\n");
  assert.equal(editTopLevelConfigText("c.yml", "", "k", "y"), "k: y\n");
  assert.equal(editTopLevelConfigText("c.yml", "a: 1\n", "k", null), null);
});

test("FG-845 editTopLevelConfigText: refuses edits that would not resolve as intended", () => {
  assert.throws(() => editTopLevelConfigText("c.yml", "k: x\nk: z\n", "k", "y"), /refusing to rewrite/);
  assert.throws(() => editTopLevelConfigText("c.yml", "{a: 1}\n", "k", "y"), /refusing to rewrite/);
  assert.throws(() => editTopLevelConfigText("c.yml", "- a\n", "k", "y"), /not a mapping/);
  assert.throws(() => editTopLevelConfigText("c.yml", "k: |\n  x\n", "k", "y"), /refusing to rewrite/);
  assert.throws(() => editTopLevelConfigText("c.yml", "a: 1\n", "k", "y", () => false), /would not resolve 'k' to 'y'/);
});

// ── FG-851: writeBacklogConfig / writeProjectKey edit the file line-wise ──

import {
  assertBacklogConfigWritable,
  assertConfigWritable,
  ConfigWriteRefusal,
  editBacklogPrefixText,
  removeTopLevelConfigKey,
  restoreHostConfig,
  restoreProjectConfig,
  writeHostConfigKey,
  writeTopLevelConfigKey,
} from "./config.js";

const FG851_FIXTURE =
  "# operator notes — keep me\n" +
  "\n" +
  "name: 'my project'   # quoted, with a comment\n" +
  "ai_attribution: off\n" +
  "\n" +
  "# the backlog block\n" +
  "backlog:\n" +
  "    # nested comment\n" +
  "    prefix: \"MG\"   # the old prefix\n" +
  "    format: structured\n" +
  "\n" +
  "retention:\n" +
  "  successMs: 1000\n";

function fg851Dir(contents: string | null): { dir: string; path: string } {
  const dir = tmp();
  const path = join(dir, ".forge", "config.yml");
  if (contents !== null) {
    mkdirSync(join(dir, ".forge"));
    writeFileSync(path, contents);
  }
  return { dir, path };
}

test("FG-851 writeProjectKey: create-key path appends exactly one line, every other byte untouched", () => {
  const { dir, path } = fg851Dir(FG851_FIXTURE);
  writeProjectKey(dir, "pk-deadbeef");
  assert.equal(readFileSync(path, "utf8"), `${FG851_FIXTURE}project_key: pk-deadbeef\n`);
});

test("FG-851 writeProjectKey: replace-key path rewrites only the project_key line, keeping its comment", () => {
  const withKey = FG851_FIXTURE.replace("ai_attribution: off\n", "ai_attribution: off\nproject_key: 'pk-old'  # committed\n");
  const { dir, path } = fg851Dir(withKey);
  writeProjectKey(dir, "pk-new");
  assert.equal(
    readFileSync(path, "utf8"),
    FG851_FIXTURE.replace("ai_attribution: off\n", "ai_attribution: off\nproject_key: pk-new  # committed\n"),
  );
});

test("FG-851 writeProjectKey: an absent file is created with the one line", () => {
  const { dir, path } = fg851Dir(null);
  writeProjectKey(dir, "pk-fresh");
  assert.equal(readFileSync(path, "utf8"), "project_key: pk-fresh\n");
});

test("FG-851 writeBacklogConfig: replace-prefix path rewrites only the nested prefix line, at its indent", () => {
  const { dir, path } = fg851Dir(FG851_FIXTURE);
  writeBacklogConfig(dir, { prefix: "ZZ" });
  assert.equal(readFileSync(path, "utf8"), FG851_FIXTURE.replace('    prefix: "MG"   # the old prefix\n', "    prefix: ZZ   # the old prefix\n"));
});

test("FG-851 writeBacklogConfig: create-prefix path inserts one line under an existing backlog block, at its indent", () => {
  const noPrefix = FG851_FIXTURE.replace('    prefix: "MG"   # the old prefix\n', "");
  const { dir, path } = fg851Dir(noPrefix);
  writeBacklogConfig(dir, { prefix: "ZZ" });
  assert.equal(readFileSync(path, "utf8"), noPrefix.replace("backlog:\n", "backlog:\n    prefix: ZZ\n"));
});

test("FG-851 writeBacklogConfig: no backlog block appends a two-line block; an empty backlog: gets one child line", () => {
  const noBlock = "# top\nname: x  # c\n\n";
  const a = fg851Dir(noBlock);
  writeBacklogConfig(a.dir, { prefix: "FG" });
  assert.equal(readFileSync(a.path, "utf8"), `${noBlock}backlog:\n  prefix: FG\n`);

  const empty = "backlog:   # to fill\nname: x\n";
  const b = fg851Dir(empty);
  writeBacklogConfig(b.dir, { prefix: "FG" });
  assert.equal(readFileSync(b.path, "utf8"), "backlog:   # to fill\n  prefix: FG\nname: x\n");
});

test("FG-851 writeBacklogConfig: prefix null writes `prefix: null`; an absent file is created", () => {
  const { dir, path } = fg851Dir(null);
  writeBacklogConfig(dir, { prefix: null });
  assert.equal(readFileSync(path, "utf8"), "backlog:\n  prefix: null\n");
  assert.equal(readBacklogConfig(dir).prefix, null);

  const c = fg851Dir(FG851_FIXTURE);
  writeBacklogConfig(c.dir, { prefix: null });
  assert.equal(readFileSync(c.path, "utf8"), FG851_FIXTURE.replace('prefix: "MG"', "prefix: null"));
});

test("FG-851 writeBacklogConfig: projectKey goes through the top-level edit; an unrelated write never touches it", () => {
  const withKey = `project_key: pk-keep  # committed\n${FG851_FIXTURE}`;
  const a = fg851Dir(withKey);
  writeBacklogConfig(a.dir, { prefix: "ZZ" });
  assert.equal(readFileSync(a.path, "utf8"), withKey.replace('prefix: "MG"', "prefix: ZZ"));

  writeBacklogConfig(a.dir, { prefix: "ZZ", projectKey: "pk-other" });
  assert.equal(
    readFileSync(a.path, "utf8"),
    withKey.replace('prefix: "MG"', "prefix: ZZ").replace("pk-keep", "pk-other"),
  );

  const b = fg851Dir(FG851_FIXTURE);
  writeBacklogConfig(b.dir, { prefix: "MG", projectKey: "pk-new" });
  assert.equal(readFileSync(b.path, "utf8"), `${FG851_FIXTURE.replace('prefix: "MG"', "prefix: MG")}project_key: pk-new\n`);
});

test("FG-851 writeBacklogConfig: projectKey null removes its line and reads null before and after", () => {
  const withNull = `# operator note\nproject_key: null  # no identity yet\n${FG851_FIXTURE.replace('prefix: "MG"', "prefix: MG")}`;
  const { dir, path } = fg851Dir(withNull);
  assert.equal(readBacklogConfig(dir).projectKey, null, "YAML null reads as no project identity before the edit");

  writeBacklogConfig(dir, { prefix: "MG", projectKey: null });

  assert.equal(readFileSync(path, "utf8"), withNull.replace("project_key: null  # no identity yet\n", ""));
  assert.equal(readBacklogConfig(dir).projectKey, null, "an absent line also reads as no project identity");
});

test("FG-851 writers: a value YAML would not read back bare is double-quoted", () => {
  const { dir, path } = fg851Dir("a: 1\n");
  writeBacklogConfig(dir, { prefix: "123" });
  assert.equal(readFileSync(path, "utf8"), 'a: 1\nbacklog:\n  prefix: "123"\n');
  assert.equal(readBacklogConfig(dir).prefix, "123");
});

const FG851_REFUSALS: { name: string; text: string; reason: RegExp }[] = [
  { name: "unparseable", text: "# notes\nbacklog: : : :\n  bad", reason: /not valid YAML/ },
  { name: "duplicate top-level key", text: "# c\nproject_key: a\nbacklog:\n  prefix: FG\nproject_key: b\n", reason: /not valid YAML \(Map keys must be unique/ },
  { name: "flow mapping top level", text: "{project_key: a, backlog: {prefix: FG}}\n", reason: /refusing to rewrite/ },
];

for (const { name, text, reason } of FG851_REFUSALS) {
  test(`FG-851 refusal (${name}): both writers refuse by name and leave the file byte-identical`, () => {
    const { dir, path } = fg851Dir(text);
    for (const write of [
      () => writeProjectKey(dir, "pk-x"),
      () => writeBacklogConfig(dir, { prefix: "ZZ" }),
      () => writeBacklogConfig(dir, { prefix: "ZZ", projectKey: "pk-x" }),
      () => assertConfigWritable(dir),
      () => assertBacklogConfigWritable(dir, { prefix: "ZZ" }),
    ]) {
      assert.throws(write, (e: unknown) => e instanceof ConfigWriteRefusal && reason.test(e.message) && e.message.includes(path));
      assert.equal(readFileSync(path, "utf8"), text);
    }
    assert.deepEqual(readdirSync(join(dir, ".forge")), ["config.yml"]);
  });
}

test("FG-851 refusal: unexpressible shapes (flow/inline backlog, block-scalar values) write nothing", () => {
  const cases: { text: string; write: (dir: string) => void; reason: RegExp }[] = [
    { text: "backlog: {prefix: FG}\n", write: (d) => writeBacklogConfig(d, { prefix: "ZZ" }), reason: /'backlog' value is written inline/ },
    { text: "backlog: FG\n", write: (d) => writeBacklogConfig(d, { prefix: "ZZ" }), reason: /'backlog' value is not a mapping/ },
    { text: "backlog:\n  - FG\n", write: (d) => writeBacklogConfig(d, { prefix: "ZZ" }), reason: /'backlog' value is not a mapping/ },
    { text: "backlog:\n  prefix: |\n    FG\n", write: (d) => writeBacklogConfig(d, { prefix: "ZZ" }), reason: /'prefix' value is a block scalar/ },
    { text: "backlog:\n  prefix: [FG]\n", write: (d) => writeBacklogConfig(d, { prefix: "ZZ" }), reason: /'prefix' value is a flow collection/ },
    { text: "project_key: >\n  pk-a\n", write: (d) => writeProjectKey(d, "pk-b"), reason: /'project_key' value is a block scalar/ },
    { text: "project_key: {a: 1}\n", write: (d) => writeProjectKey(d, "pk-b"), reason: /'project_key' value is a flow collection/ },
  ];
  for (const { text, write, reason } of cases) {
    const { dir, path } = fg851Dir(text);
    assert.throws(() => write(dir), (e: unknown) => e instanceof ConfigWriteRefusal && reason.test(e.message), text);
    assert.equal(readFileSync(path, "utf8"), text);
  }
});

test("FG-851 editBacklogPrefixText: CRLF and nested maps under backlog are respected", () => {
  assert.equal(
    editBacklogPrefixText("c.yml", "backlog:\r\n  opts:\r\n    prefix: deep\r\n  prefix: FG\r\n", "ZZ"),
    "backlog:\r\n  opts:\r\n    prefix: deep\r\n  prefix: ZZ\r\n",
  );
  assert.equal(
    editBacklogPrefixText("c.yml", "backlog:\r\n  opts:\r\n    prefix: deep\r\n", "ZZ"),
    "backlog:\r\n  prefix: ZZ\r\n  opts:\r\n    prefix: deep\r\n",
  );
  assert.equal(editBacklogPrefixText("c.yml", "a: 1", "ZZ"), "a: 1\nbacklog:\n  prefix: ZZ\n");
});

// FG-845 (RF-2): the read-modify-write is a compare-and-swap. A writer whose edit was
// computed from bytes another writer has since replaced refuses with nothing written,
// rather than renaming its stale edit over the other's line.
test("FG-845 writeTopLevelConfigKey: an interleaved write lands first, the second writer refuses rather than clobbering it", () => {
  const { dir, path } = fg851Dir("project_key: pk-a\n");
  const interleaved = "project_key: pk-a\nbacklog:\n  prefix: ZZ\n";
  assert.throws(
    () =>
      writeTopLevelConfigKey(dir, "ai_attribution", "allow", () => {
        writeFileSync(path, interleaved);
        return true;
      }),
    (e: unknown) => e instanceof ConfigWriteRefusal && /changed while this edit was being made.*nothing was written, retry/.test(e.message),
  );
  assert.equal(readFileSync(path, "utf8"), interleaved, "the other writer's line survives");
  assert.deepEqual(readdirSync(join(dir, ".forge")), ["config.yml"], "no temp file left behind");

  writeTopLevelConfigKey(dir, "ai_attribution", "allow");
  assert.equal(readFileSync(path, "utf8"), `${interleaved}ai_attribution: allow\n`, "a retry applies on top");
});

test("FG-845 writeHostConfigKey/removeTopLevelConfigKey: the same compare-and-swap; a file created underneath an absent-file edit is refused too", () => {
  const home = tmp();
  const hostFile = join(home, "config.yml");
  assert.throws(
    () =>
      writeHostConfigKey(hostFile, "ai_attribution", "allow", () => {
        writeFileSync(hostFile, "telemetry: off\n");
        return true;
      }),
    /changed while this edit was being made/,
  );
  assert.equal(readFileSync(hostFile, "utf8"), "telemetry: off\n");

  const { dir, path } = fg851Dir("ai_attribution: allow\n");
  assert.throws(
    () =>
      removeTopLevelConfigKey(dir, "ai_attribution", () => {
        writeFileSync(path, "ai_attribution: allow\nproject_key: pk-b\n");
        return true;
      }),
    /changed while this edit was being made/,
  );
  assert.equal(readFileSync(path, "utf8"), "ai_attribution: allow\nproject_key: pk-b\n");
});

test("FG-845 restoreProjectConfig/restoreHostConfig: put back the previous bytes, remove a created file, and never undo a later writer", () => {
  const { dir, path } = fg851Dir("# notes\nproject_key: pk-a   # keep\n");
  const edit = writeTopLevelConfigKey(dir, "ai_attribution", "allow");
  restoreProjectConfig(dir, edit);
  assert.equal(readFileSync(path, "utf8"), "# notes\nproject_key: pk-a   # keep\n");

  const later = writeTopLevelConfigKey(dir, "ai_attribution", "allow");
  writeFileSync(path, "project_key: pk-other\n");
  assert.throws(() => restoreProjectConfig(dir, later), /changed while this edit was being made/);
  assert.equal(readFileSync(path, "utf8"), "project_key: pk-other\n");

  const hostFile = join(tmp(), "config.yml");
  const created = writeHostConfigKey(hostFile, "ai_attribution", "allow");
  assert.equal(created.previous, null);
  restoreHostConfig(hostFile, created);
  assert.equal(existsSync(hostFile), false);
});
