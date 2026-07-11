// FG-530 independent verification (unit tier): is the crash-injection HARNESS
// itself trustworthy?
//
// crash-points.test.ts (the engineer's own guard) proves the hook is inert for
// the probe names it lists. This file attacks the three ways that guard could be
// true and still not mean what it claims:
//
//   (1) INERTNESS, adversarially — a probe whose ARGUMENT is a computed
//       expression is not free when the hook is unset: it runs on every real
//       production call. `crashPoint(expensive())` or `crashPoint(t.id.slice(3))`
//       would still pass a "hook unset ⇒ no-op" test while adding cost (or a
//       throw) to the runner's hot write path. So: every probe argument must be
//       a bare string literal, checked in the SOURCE, not at runtime.
//   (2) NO RESIDUAL STATE — `setCrashHookForTest` must REPLACE, never stack. A
//       hook that survives its scenario would fire inside the next one and turn
//       the matrix's cells (every KILL_POINTS entry × every scenario) into
//       cross-talk.
//   (3) REGISTRY LOCKSTEP — the matrix can only kill at points it knows about.
//       A probe added to production but not to the registry is a write boundary
//       with ZERO crash coverage, and nothing in the matrix would say so: its
//       coverage test only asserts registry ⊆ fired, never production ⊆ registry.
//       That direction is the one that rots, so it is asserted here as a content
//       test over the real source.
//
// Plus tier placement: the matrix is a real-DB suite and must run in
// test:integration, never in the fast unit tier.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { crashPoint, setCrashHookForTest } from "./crash-points.js";

const SRC_ROOT = fileURLToPath(new URL("..", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

const HOOK_MODULE = "v2/crash-points.ts";
const MATRIX = "v2/fg530-crash-matrix.integration.test.ts";
const ENGINEER_GUARD = "v2/crash-points.test.ts";

/** The production files that carry probes. Asserted to be exhaustive below — a
 *  probe planted in a FOURTH production file is itself a finding. */
const PROBE_FILES = ["v2/runNext.ts", "v2/gate.ts", "v2/reconcile.ts"] as const;

function read(rel: string): string {
  return readFileSync(join(SRC_ROOT, rel), "utf8");
}

function gatherProductionFiles(dir: string, root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...gatherProductionFiles(full, root));
    else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push(relative(root, full));
    }
  }
  return out;
}

/** Every `crashPoint(<arg>)` CALL in a source file, with its raw argument text.
 *  Only call sites match: `import { crashPoint } from ...` has no paren, and the
 *  declaration in crash-points.ts is excluded by never scanning that file here. */
function probeCalls(content: string): string[] {
  return [...content.matchAll(/\bcrashPoint\(([^)]*)\)/g)].map((m) => (m[1] ?? "").trim());
}

const STRING_LITERAL = /^"[A-Za-z0-9:_.-]+"$/;

/** The probe names production actually carries (deduped; one name may legitimately
 *  sit at two call sites — finalizePrimary's awaiting_gate window does). */
function productionProbeNames(): Set<string> {
  const names = new Set<string>();
  for (const rel of PROBE_FILES) {
    for (const arg of probeCalls(read(rel))) {
      names.add(arg.slice(1, -1));
    }
  }
  return names;
}

/** Pull the registry the matrix iterates straight out of its source. Read as
 *  TEXT on purpose: importing the matrix would register every one of its cells. */
function registryNames(): Set<string> {
  const src = read(MATRIX);
  const block = src.match(/const KILL_POINTS: KillPoint\[\] = \[([\s\S]*?)\n\];/);
  assert.ok(block, "could not locate the KILL_POINTS registry in the matrix — did it get renamed?");
  return new Set([...(block[1] ?? "").matchAll(/point:\s*"([^"]+)"/g)].map((m) => m[1] as string));
}

/** The name list the engineer's own inertness guard iterates. */
function guardProbeNames(): Set<string> {
  const src = read(ENGINEER_GUARD);
  const block = src.match(/const PROBE_NAMES = \[([\s\S]*?)\n\];/);
  assert.ok(block, "could not locate PROBE_NAMES in crash-points.test.ts — did it get renamed?");
  return new Set([...(block[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1] as string));
}

const sorted = (s: Set<string>): string[] => [...s].sort();

// ── (1) inertness, adversarially ──────────────────────────────────────────────

test("FG-530 inertness: every probe ARGUMENT is a bare string literal — an unset hook must not evaluate a computed expression on the runner's write path", () => {
  const offenders: string[] = [];
  for (const rel of PROBE_FILES) {
    for (const arg of probeCalls(read(rel))) {
      if (!STRING_LITERAL.test(arg)) offenders.push(`${rel}: crashPoint(${arg})`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "A probe argument that is not a literal is COMPUTED on every production call, hook or no hook — cost, and a\n" +
      "throw risk, on the finalize path. crashPoint(<expr>) must become crashPoint(\"literal\"):\n" +
      offenders.join("\n"),
  );
});

test("FG-530 inertness: probes exist ONLY in the three known write-boundary files — a probe elsewhere is an uncovered production edit", () => {
  const strays: string[] = [];
  for (const rel of gatherProductionFiles(SRC_ROOT, SRC_ROOT)) {
    if (rel === HOOK_MODULE) continue; // declares crashPoint; does not call it
    if ((PROBE_FILES as readonly string[]).includes(rel)) continue;
    if (/\bcrashPoint\(/.test(read(rel))) strays.push(rel);
  }
  assert.deepEqual(
    strays,
    [],
    `these production files call crashPoint() but are not in the matrix's surface list, so no cell ever kills there:\n${strays.join("\n")}`,
  );
});

test("FG-530 inertness: production imports the PROBE and nothing else — only a test may reach the hook's setter", () => {
  const offenders: string[] = [];
  for (const rel of gatherProductionFiles(SRC_ROOT, SRC_ROOT)) {
    if (rel === HOOK_MODULE) continue;
    const content = read(rel);
    for (const m of content.matchAll(/import\s*\{([^}]*)\}\s*from\s*"[^"]*crash-points\.js"/g)) {
      const imported = (m[1] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      for (const sym of imported) {
        if (sym !== "crashPoint") offenders.push(`${rel} imports '${sym}' from crash-points`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `production may import ONLY crashPoint; importing the setter is how the injection escapes the test suite:\n${offenders.join("\n")}`,
  );
});

test("FG-530 inertness: the hook module exposes exactly one probe and one setter — a second writer would be a second way to arm production", () => {
  const src = read(HOOK_MODULE);
  const exported = [...src.matchAll(/export function (\w+)/g)].map((m) => m[1] as string).sort();
  assert.deepEqual(
    exported,
    ["crashPoint", "setCrashHookForTest"],
    "crash-points.ts must export exactly crashPoint + setCrashHookForTest — any other export is a new way to install or observe the hook",
  );
  assert.equal(
    [...src.matchAll(/crashHook\s*=/g)].length,
    1,
    "setCrashHookForTest must be the ONLY assignment to crashHook — a second writer breaks the 'tests are the only installers' guarantee",
  );
});

// ── (2) no residual state ─────────────────────────────────────────────────────

test("FG-530 no residual state: installing a hook REPLACES the previous one — hooks must not stack, or a finished scenario would keep firing inside the next", () => {
  const first: string[] = [];
  const second: string[] = [];

  setCrashHookForTest((p) => first.push(p));
  setCrashHookForTest((p) => second.push(p)); // replaces, does not chain
  crashPoint("gate:before-decision-write");
  setCrashHookForTest(undefined);

  assert.deepEqual(second, ["gate:before-decision-write"], "the most recently installed hook observes the probe");
  assert.deepEqual(
    first,
    [],
    "the REPLACED hook must never fire again — if hooks stacked, every matrix cell would inherit every prior cell's kill",
  );
});

test("FG-530 no residual state: a hook that THREW still clears — the crash path must not leave the seam armed for the next scenario", () => {
  const seen: string[] = [];
  setCrashHookForTest((p) => {
    seen.push(p);
    throw new Error("injected");
  });

  assert.throws(() => crashPoint("finalizePrimary:before-status-write"), /injected/);

  // This is exactly what the matrix's crashAt() finally-block does.
  setCrashHookForTest(undefined);

  // The "next scenario": a full sweep of every probe name must be silent.
  for (const name of productionProbeNames()) {
    assert.equal(
      crashPoint(name),
      undefined,
      `after a THROWING hook was cleared, crashPoint(${name}) must be inert — otherwise a kill leaks across cells`,
    );
  }
  assert.deepEqual(seen, ["finalizePrimary:before-status-write"], "the cleared hook observed nothing after its scenario");
});

test("FG-530 no residual state: arming point X then re-arming at point Y leaves X's hook blind — sequential cells are isolated", () => {
  const atX: string[] = [];
  const atY: string[] = [];

  setCrashHookForTest((p) => {
    if (p === "gate:after-decision-write") atX.push(p);
  });
  crashPoint("gate:after-decision-write");
  setCrashHookForTest(undefined);

  setCrashHookForTest((p) => {
    if (p === "dispatchReds:before-verdict-insert") atY.push(p);
  });
  crashPoint("gate:after-decision-write"); // X's point, during Y's window
  crashPoint("dispatchReds:before-verdict-insert");
  setCrashHookForTest(undefined);

  assert.deepEqual(atX, ["gate:after-decision-write"], "X fired exactly once, in its own window");
  assert.deepEqual(atY, ["dispatchReds:before-verdict-insert"], "Y sees only its own point");
  assert.equal(atX.length, 1, "X's hook did not observe anything once Y's scenario began");
});

// ── (3) registry lockstep ─────────────────────────────────────────────────────

test("FG-530 registry completeness: every probe in PRODUCTION is in the matrix's kill-point registry — a probe with no registry entry is a write boundary the matrix never kills at", () => {
  const production = productionProbeNames();
  const registry = registryNames();

  const missing = sorted(production).filter((n) => !registry.has(n));
  assert.deepEqual(
    missing,
    [],
    "These probes exist in runNext/gate/reconcile but NO matrix cell kills at them — the crash window is uncovered\n" +
      "and the matrix's own coverage test cannot see it (it only checks registry ⊆ fired, not production ⊆ registry).\n" +
      "Add them to KILL_POINTS in fg530-crash-matrix.integration.test.ts:\n  " +
      missing.join("\n  "),
  );

  const stale = sorted(registry).filter((n) => !production.has(n));
  assert.deepEqual(
    stale,
    [],
    `the registry names kill points that no longer exist in production — the probe was deleted or renamed:\n  ${stale.join("\n  ")}`,
  );
});

test("FG-530 registry completeness: the engineer's inertness list, the matrix registry, and production are one set — no drift between the three", () => {
  assert.deepEqual(
    sorted(guardProbeNames()),
    sorted(productionProbeNames()),
    "crash-points.test.ts's PROBE_NAMES must equal the probes production carries, or inertness is proven for a stale set of names",
  );
  assert.deepEqual(
    sorted(registryNames()),
    sorted(productionProbeNames()),
    "the matrix registry must equal the probes production carries",
  );
});

// ── (4) tier placement ────────────────────────────────────────────────────────

test("FG-530 tier placement: the crash matrix is an INTEGRATION-tier file and is excluded from the fast unit tier", () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };

  assert.ok(MATRIX.endsWith(".integration.test.ts"), "the matrix drives a real DB + real fs and must carry the .integration suffix");

  const unit = pkg.scripts["test:unit"] ?? "";
  assert.ok(
    unit.includes("-not -name '*.integration.test.ts'"),
    `test:unit must exclude *.integration.test.ts, or the 90-cell matrix would run in the fast tier, got: ${unit}`,
  );

  const integration = pkg.scripts["test:integration"] ?? "";
  assert.ok(
    integration.includes("'*.integration.test.ts'"),
    `test:integration must select *.integration.test.ts, got: ${integration}`,
  );

  const extended = pkg.scripts["test:extended"] ?? "";
  assert.ok(
    extended.includes("test:integration"),
    `test:extended is the CI tier that must actually run the matrix, got: ${extended}`,
  );
});

test("FG-530 tier placement: the hook's guard tests are unit-tier (pure) and the harness's DB-driving tests are not", () => {
  assert.ok(
    !ENGINEER_GUARD.endsWith(".integration.test.ts") && !ENGINEER_GUARD.endsWith(".worktree.test.ts"),
    "crash-points.test.ts touches no DB and belongs in the fast tier",
  );

  const self = relative(SRC_ROOT, fileURLToPath(import.meta.url));
  assert.ok(
    !self.endsWith(".integration.test.ts"),
    "this file is pure content + in-process assertions, so it stays unit-tier",
  );
  // The repo-wide purity guard (src/test-tiers.test.ts) enforces the rest: no
  // unit-tier file may spawn a subprocess or sleep on a real clock.
});
