import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectEnvFabrication } from "./anti-shim.js";
import { renderHuman } from "../cli/commands/check-agent-diff.js";

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), "forge-anti-shim-"));
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

// ── forge_shim ────────────────────────────────────────────────────────────────

test("forge_shim: flags @forge/* under node_modules", () => {
  const tmp = makeTmp();
  try {
    mkdirSync(join(tmp, "node_modules", "@forge", "fake"), { recursive: true });
    const result = detectEnvFabrication(tmp, { gitStatusLines: [] });
    assert.equal(result.clean, false);
    assert.equal(result.flags.length, 1);
    const f = result.flags[0]!;
    assert.equal(f.kind, "forge_shim");
    assert.match(f.path, /@forge[/\\]fake/);
    assert.match(f.detail, /path aliases/);
  } finally {
    cleanup(tmp);
  }
});

test("forge_shim: flags multiple @forge/* entries", () => {
  const tmp = makeTmp();
  try {
    mkdirSync(join(tmp, "node_modules", "@forge", "a"), { recursive: true });
    mkdirSync(join(tmp, "node_modules", "@forge", "b"), { recursive: true });
    const result = detectEnvFabrication(tmp, { gitStatusLines: [] });
    const shimFlags = result.flags.filter((f) => f.kind === "forge_shim");
    assert.equal(shimFlags.length, 2);
  } finally {
    cleanup(tmp);
  }
});

test("forge_shim: no flags when node_modules/@forge is absent", () => {
  const tmp = makeTmp();
  try {
    const result = detectEnvFabrication(tmp, { gitStatusLines: [] });
    assert.equal(result.clean, true);
    assert.deepEqual(result.flags, []);
  } finally {
    cleanup(tmp);
  }
});

test("forge_shim: flags @forge/* under workspace node_modules", () => {
  const tmp = makeTmp();
  try {
    writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "root", workspaces: ["dashboard"] }));
    mkdirSync(join(tmp, "dashboard", "node_modules", "@forge", "fake"), { recursive: true });
    const result = detectEnvFabrication(tmp, { gitStatusLines: [] });
    const shimFlags = result.flags.filter((f) => f.kind === "forge_shim");
    assert.equal(shimFlags.length, 1);
    assert.match(shimFlags[0]!.path, /dashboard/);
  } finally {
    cleanup(tmp);
  }
});

test("forge_shim: clean when @forge only appears in root, not workspace (no root @forge)", () => {
  const tmp = makeTmp();
  try {
    writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "root", workspaces: ["sub"] }));
    mkdirSync(join(tmp, "sub", "node_modules"), { recursive: true });
    const result = detectEnvFabrication(tmp, { gitStatusLines: [] });
    assert.equal(result.clean, true);
  } finally {
    cleanup(tmp);
  }
});

// ── dependency_surgery ────────────────────────────────────────────────────────

test("dependency_surgery: flags a modified package.json", () => {
  const tmp = makeTmp();
  try {
    const result = detectEnvFabrication(tmp, { gitStatusLines: [" M package.json"] });
    assert.equal(result.clean, false);
    const f = result.flags.find((f) => f.kind === "dependency_surgery");
    assert.ok(f, "should flag dependency_surgery");
    assert.equal(f!.path, "package.json");
  } finally {
    cleanup(tmp);
  }
});

test("dependency_surgery: flags modified tsconfig.json", () => {
  const tmp = makeTmp();
  try {
    const result = detectEnvFabrication(tmp, { gitStatusLines: ["M  tsconfig.json"] });
    const flags = result.flags.filter((f) => f.kind === "dependency_surgery");
    assert.equal(flags.length, 1);
    assert.equal(flags[0]!.path, "tsconfig.json");
  } finally {
    cleanup(tmp);
  }
});

test("dependency_surgery: flags package-lock.json", () => {
  const tmp = makeTmp();
  try {
    const result = detectEnvFabrication(tmp, { gitStatusLines: ["MM package-lock.json"] });
    const flags = result.flags.filter((f) => f.kind === "dependency_surgery");
    assert.equal(flags.length, 1);
    assert.equal(flags[0]!.path, "package-lock.json");
  } finally {
    cleanup(tmp);
  }
});

test("dependency_surgery: flags package.json in a subdirectory", () => {
  const tmp = makeTmp();
  try {
    const result = detectEnvFabrication(tmp, { gitStatusLines: [" M subdir/package.json"] });
    const flags = result.flags.filter((f) => f.kind === "dependency_surgery");
    assert.equal(flags.length, 1);
    assert.equal(flags[0]!.path, "subdir/package.json");
  } finally {
    cleanup(tmp);
  }
});

test("dependency_surgery: does NOT flag untracked package.json", () => {
  const tmp = makeTmp();
  try {
    const result = detectEnvFabrication(tmp, { gitStatusLines: ["?? package.json"] });
    assert.equal(result.flags.filter((f) => f.kind === "dependency_surgery").length, 0);
  } finally {
    cleanup(tmp);
  }
});

test("dependency_surgery: ignores unrelated modified files", () => {
  const tmp = makeTmp();
  try {
    const result = detectEnvFabrication(tmp, { gitStatusLines: [" M src/foo.ts", " M README.md"] });
    assert.equal(result.clean, true);
  } finally {
    cleanup(tmp);
  }
});

// ── stub_module ───────────────────────────────────────────────────────────────

test("stub_module: flags untracked src/*.ts that references @forge/", () => {
  const tmp = makeTmp();
  try {
    mkdirSync(join(tmp, "src"), { recursive: true });
    writeFileSync(join(tmp, "src", "shim.ts"), 'export * from "@forge/cli/index.js";\n');
    const result = detectEnvFabrication(tmp, { gitStatusLines: ["?? src/shim.ts"] });
    const flags = result.flags.filter((f) => f.kind === "stub_module");
    assert.equal(flags.length, 1);
    assert.equal(flags[0]!.path, "src/shim.ts");
  } finally {
    cleanup(tmp);
  }
});

test("stub_module: does NOT flag untracked src/*.ts without @forge/ reference", () => {
  const tmp = makeTmp();
  try {
    mkdirSync(join(tmp, "src"), { recursive: true });
    writeFileSync(join(tmp, "src", "normal.ts"), "export const x = 1;\n");
    const result = detectEnvFabrication(tmp, { gitStatusLines: ["?? src/normal.ts"] });
    assert.equal(result.flags.filter((f) => f.kind === "stub_module").length, 0);
  } finally {
    cleanup(tmp);
  }
});

test("stub_module: does NOT flag untracked non-src .ts files", () => {
  const tmp = makeTmp();
  try {
    mkdirSync(join(tmp, "scripts"), { recursive: true });
    writeFileSync(join(tmp, "scripts", "shim.ts"), 'export * from "@forge/x";\n');
    const result = detectEnvFabrication(tmp, { gitStatusLines: ["?? scripts/shim.ts"] });
    assert.equal(result.flags.filter((f) => f.kind === "stub_module").length, 0);
  } finally {
    cleanup(tmp);
  }
});

// ── clean fixture ─────────────────────────────────────────────────────────────

test("clean fixture: returns clean:true with empty flags array", () => {
  const tmp = makeTmp();
  try {
    const result = detectEnvFabrication(tmp, { gitStatusLines: [] });
    assert.equal(result.clean, true);
    assert.deepEqual(result.flags, []);
  } finally {
    cleanup(tmp);
  }
});

// ── all three flags in one scan ───────────────────────────────────────────────

test("all three flag kinds can coexist in a single scan", () => {
  const tmp = makeTmp();
  try {
    mkdirSync(join(tmp, "node_modules", "@forge", "fake"), { recursive: true });
    mkdirSync(join(tmp, "src"), { recursive: true });
    writeFileSync(join(tmp, "src", "stub.ts"), 'export * from "@forge/something";\n');
    const result = detectEnvFabrication(tmp, {
      gitStatusLines: [" M package.json", "?? src/stub.ts"],
    });
    assert.ok(!result.clean);
    assert.ok(result.flags.some((f) => f.kind === "forge_shim"), "should have forge_shim");
    assert.ok(result.flags.some((f) => f.kind === "dependency_surgery"), "should have dependency_surgery");
    assert.ok(result.flags.some((f) => f.kind === "stub_module"), "should have stub_module");
  } finally {
    cleanup(tmp);
  }
});

// ── CLI rendering ─────────────────────────────────────────────────────────────

test("renderHuman: clean result", () => {
  assert.equal(renderHuman({ clean: true, flags: [] }), "clean — no environment fabrication signatures detected.");
});

test("renderHuman: shows kind and path for each flag", () => {
  const out = renderHuman({
    clean: false,
    flags: [
      { kind: "forge_shim", path: "node_modules/@forge/fake", detail: "test detail" },
      { kind: "dependency_surgery", path: "package.json", detail: "modified" },
    ],
  });
  assert.match(out, /2 environment fabrication flag/);
  assert.match(out, /forge_shim/);
  assert.match(out, /node_modules\/@forge\/fake/);
  assert.match(out, /dependency_surgery/);
  assert.match(out, /package\.json/);
});
