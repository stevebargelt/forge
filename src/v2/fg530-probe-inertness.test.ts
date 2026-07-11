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
//   (4) WRITE-SURFACE COMPLETENESS — (3) only proves the probes that EXIST are
//       registered. It says nothing about a write sequence that has no probe at
//       all, and that is the class two review rounds each found a fresh instance
//       of (gate.ts's dedup writes; reconcile.ts's fanout-parent recovery). The
//       guard at the bottom of this file closes it by construction: every
//       state-write call in the three covered files must sit next to a probe or
//       carry an ALLOWLIST entry with a written reason.
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
    `test:unit must exclude *.integration.test.ts, or the whole crash matrix would run in the fast tier, got: ${unit}`,
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

// ── (5) write-surface completeness: close the class, not the instance ─────────
//
// FG-516's lesson, applied: two review rounds each found a NEW unprobed write
// sequence inside the covered surfaces. Fixing each instance leaves the CLASS
// open. This is the boundary the suite owns instead — a content guard over the
// three covered files that FAILS LOUDLY, naming file:line, whenever a state-write
// call has neither an adjacent crashPoint probe nor an allowlist entry.
//
// The write surface is DERIVED, not hand-listed: a store function is a mutator if
// its body issues INSERT/UPDATE/DELETE, and it counts for a covered file if that
// file imports it. Add a new mutator to src/store, import it into runNext/gate/
// reconcile, and the guard starts demanding a probe for it on the next run.

const STORE_DIR = "store";
/** The connection/migration module, not a lifecycle-state accessor: its migrations
 *  carry `UPDATE runs SET ...` and every accessor in the store calls getDb(), so
 *  leaving it in would make the transitive derivation below classify the ENTIRE
 *  store — getTask, tasksForRun, getRun — as mutators. */
const STORE_CONNECTION_MODULE = "store/db.ts";
/** v2 helpers that are write calls in every meaningful sense — they wrap a store
 *  mutator. Asserted below to actually do so, so this list cannot rot into a lie. */
const LOCAL_WRITE_WRAPPERS: Record<string, string> = {
  failTask: "v2/failure-kind.ts",
  finalizeRunIfSettled: "v2/run-finalize.ts",
};

/** How far from a write call a probe may sit and still be its probe — wide enough to
 *  span a multi-line call's arguments, a `getDb().transaction(...)` wrapper, and the
 *  odd guard clause between a probe and the write it names. */
const PROBE_WINDOW = 8;

/** A probe may not vouch for a write on the far side of one of these. Distance alone
 *  is not enough: the two arms of reconcile's fanout-parent if/else sit 10 lines
 *  apart and only ONE of them is probed, so a window generous enough for gate.ts's
 *  dedup sequence (probe → guard clause → event, 7 lines) would otherwise let the
 *  probed arm vouch for its unprobed twin. These two markers are what actually ENDS
 *  a write sequence in this codebase: a closing transaction and a branch boundary. */
const SEQUENCE_BREAK = /^\s*(\}\)\(\);|\} else\b)/;

function crossesSequenceBreak(lines: string[], a: number, b: number): boolean {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  return lines.slice(lo, hi - 1).some((l) => SEQUENCE_BREAK.test(l));
}
/** How far from a write call an allowlist entry's `near` marker may sit. Small:
 *  the marker exists to name WHICH write group the entry exempts (the failure_kind
 *  or reason string in the adjacent event payload), and reconcile's branches sit
 *  only a few lines apart. */
const NEAR_WINDOW = 3;

function storeFiles(): string[] {
  return readdirSync(join(SRC_ROOT, STORE_DIR))
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => `${STORE_DIR}/${f}`)
    .filter((rel) => rel !== STORE_CONNECTION_MODULE);
}

/** Every function src/store EXPORTS that writes — TRANSITIVELY. A function that
 *  issues no SQL itself but delegates to one that does (captureUsageForTask →
 *  insertUsageRows) is still a write, and a guard that missed it would be blind
 *  to exactly the indirection a future accessor is most likely to use. Iterated to
 *  a fixpoint over the whole store. */
function storeMutators(): Set<string> {
  const bodies = new Map<string, string>();
  for (const rel of storeFiles()) {
    for (const chunk of read(rel).split(/\nexport /).slice(1)) {
      const name = chunk.match(/^(?:async )?function (\w+)/)?.[1];
      if (name) bodies.set(name, chunk);
    }
  }

  const mutators = new Set<string>();
  for (const [name, body] of bodies) {
    if (/\b(INSERT INTO|UPDATE \w+ SET|DELETE FROM)\b/i.test(body)) mutators.add(name);
  }
  for (let grew = true; grew; ) {
    grew = false;
    for (const [name, body] of bodies) {
      if (mutators.has(name)) continue;
      const delegates = [...mutators].some((m) => new RegExp(`(?<![\\w.])${m}\\(`).test(body));
      if (delegates) {
        mutators.add(name);
        grew = true;
      }
    }
  }
  return mutators;
}

/** The names a covered file imports from src/store that are mutators, plus any
 *  local write wrapper it imports. This is that file's write surface. */
function writeCallsFor(rel: string, mutators: Set<string>): Set<string> {
  const src = read(rel);
  const names = new Set<string>();
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*"\.\.\/store\/[^"]*"/g)) {
    for (const sym of (m[1] ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
      if (mutators.has(sym)) names.add(sym);
    }
  }
  for (const [wrapper] of Object.entries(LOCAL_WRITE_WRAPPERS)) {
    if (new RegExp(`import\\s*\\{[^}]*\\b${wrapper}\\b[^}]*\\}`).test(src)) names.add(wrapper);
  }
  return names;
}

/** Top-level function ranges, so a finding can name the function it lives in and
 *  the allowlist can key on it — a line number would rot on the next edit. */
function functionRanges(src: string): { name: string; start: number; end: number }[] {
  const lines = src.split("\n");
  const starts: { name: string; start: number }[] = [];
  lines.forEach((line, i) => {
    const m = line.match(/^(?:export )?(?:async )?function (\w+)/);
    if (m) starts.push({ name: m[1] as string, start: i + 1 });
  });
  return starts.map((s, i) => ({
    ...s,
    end: i + 1 < starts.length ? (starts[i + 1] as { start: number }).start - 1 : lines.length,
  }));
}

function enclosingFn(ranges: { name: string; start: number; end: number }[], line: number): string {
  return ranges.find((r) => line >= r.start && line <= r.end)?.name ?? "<top-level>";
}

type WriteSite = { file: string; line: number; fn: string; call: string; probed: boolean; context: string };

/** Every write call in a covered file, with whether a probe sits within
 *  PROBE_WINDOW lines of it. Import lines and comment lines are skipped — an
 *  import is not a call, and a mutator NAMED in a comment is not one either.
 *  `context` is the ±NEAR_WINDOW-line neighbourhood an allowlist entry's `near`
 *  marker is matched against. */
function writeSites(rel: string, calls: Set<string>): WriteSite[] {
  return writeSitesIn(rel, read(rel), calls);
}

function writeSitesIn(rel: string, src: string, calls: Set<string>): WriteSite[] {
  const lines = src.split("\n");
  const ranges = functionRanges(src);
  const probeLines = lines.flatMap((l, i) => (/\bcrashPoint\(/.test(l) ? [i + 1] : []));
  const sites: WriteSite[] = [];

  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;
    if (/^import\b/.test(trimmed) || /\bfrom\s*"/.test(trimmed)) return;
    for (const call of calls) {
      if (!new RegExp(`(?<![\\w.])${call}\\(`).test(line)) continue;
      const lineNo = i + 1;
      sites.push({
        file: rel,
        line: lineNo,
        fn: enclosingFn(ranges, lineNo),
        call,
        probed: probeLines.some(
          (p) => Math.abs(p - lineNo) <= PROBE_WINDOW && !crossesSequenceBreak(lines, p, lineNo),
        ),
        context: lines.slice(Math.max(0, i - NEAR_WINDOW), i + NEAR_WINDOW + 1).join("\n"),
      });
    }
  });
  return sites;
}

// ── the allowlist ─────────────────────────────────────────────────────────────
//
// An entry exempts calls of `call` inside `fn` of `file` — narrowed by `near`, a
// marker that must appear within NEAR_WINDOW lines (reconcile's branches issue the
// SAME markTaskFailed(t.id, error) line in five places, so the failure_kind /
// reason string in the adjacent event payload is what names the branch an entry
// speaks for). Keyed on the FUNCTION rather than a line number so it survives an
// edit above it.
//
// `reason` is mandatory prose and a reviewer WILL read it. Two kinds:
//   - plain entry: this write is NOT a crash window (with the argument).
//   - gap: true : it IS a genuine crash window, deliberately not probed this round,
//                 with the reason it was deferred. Ratcheted below so deferring one
//                 is a visible, reviewable act rather than a quiet allowlist line.

type Allow = { file: string; fn: string; call: string; near?: string; reason: string; gap?: true };

const ALLOWLIST: Allow[] = [
  // ── runNext.ts: the PRE-container dispatch path ─────────────────────────────
  // FG-530's covered surface is runNext's POST-container finalize path — the
  // sequence that turns an agent's result into lifecycle state. Everything below
  // runs BEFORE any agent work exists to lose.
  {
    file: "v2/runNext.ts",
    fn: "dispatchSingleStep",
    call: "insertTask",
    reason:
      "pre-container: mints the phase's primary row as `pending`. A crash on either side leaves either no row (the ready " +
      "queue re-admits the phase) or a pending row the next dispatch REUSES (the `existing` pending-primary lookup at the " +
      "top of this function). No agent has run, so there is no result, no verdict and no worktree to strand.",
  },
  {
    file: "v2/runNext.ts",
    fn: "dispatchSingleStep",
    call: "logEvent",
    reason:
      "the task.created audit append next to the insertTask above — append-only evidence, no lifecycle state. A crash " +
      "between the two leaves a pending row with no creation event; nothing reads that event to decide a transition.",
  },
  {
    file: "v2/runNext.ts",
    fn: "dispatchSingleStep",
    call: "setTaskWorktreePath",
    reason:
      "pre-container, and deliberately so: FG-351 writes the worktree path BEFORE the container starts precisely so a " +
      "crash leaves the path findable. A crash on either side is the exact state that rule exists to keep recoverable.",
  },
  {
    file: "v2/runNext.ts",
    fn: "dispatchSingleStep",
    call: "failTask",
    reason:
      "terminal failure writes (preflight, worktree setup, persistence check, worktree merge, integration gate). A crash " +
      "BEFORE any of them leaves the task `running` with a dead container and its result on disk — which is precisely the " +
      "state reconcile's container-gone sweep re-derives, and that landing IS probed " +
      "(reconcile:{before,inside}-fail-pipeline-unfinalized). failTask's own internal window (markTaskFailed then " +
      "task.failed, un-transacted) lives in failure-kind.ts, outside the three covered files.",
  },
  {
    file: "v2/runNext.ts",
    fn: "holdIfValidationContractFails",
    call: "logEvent",
    near: "validation_waiver",
    reason:
      "the WAIVER branch: an audit-only task.decision append on the path that does NOT hold the task. No status write " +
      "accompanies it — the task's status is written downstream in finalizePrimary, which is probed. (The HELD branch's " +
      "status+event pair carries its own probe: holdIfValidationContractFails:between-hold-status-and-event.)",
  },
  {
    file: "v2/runNext.ts",
    fn: "dispatchReds",
    call: "insertTask",
    reason:
      "pre-container mint of a reviewer child row. No verdict row exists yet, so no evidence chain can be corrupted; the " +
      "verdict write sequence itself is probed (dispatchReds:{before,inside,after}-verdict-insert).",
  },
  {
    file: "v2/runNext.ts",
    fn: "dispatchReds",
    call: "logEvent",
    reason:
      "audit-only appends: the reviewer child's task.created/task.failed, and verdict.findings_dropped (a note that " +
      "gradeFindings discarded findings, written BEFORE the verdict row exists). None carries lifecycle state.",
  },
  {
    file: "v2/runNext.ts",
    fn: "dispatchReds",
    call: "markTaskFailed",
    reason:
      "fails the reviewer CHILD when its context packet cannot be assembled — before the child ever runs. A red child is " +
      "not a phase primary: no gate reads its status, and the primary's own evidence chain is its verdict row, which does " +
      "not exist yet. A crash here leaves a pending/failed child the primary's aggregate already treats as no-verdict.",
  },
  {
    file: "v2/runNext.ts",
    fn: "runOneRed",
    call: "insertTask",
    reason:
      "pre-container mint of the red child's row — see dispatchReds/insertTask. The evidence the invariants check is the " +
      "VERDICT row, whose insert is probed.",
  },
  {
    file: "v2/runNext.ts",
    fn: "runOneRed",
    call: "logEvent",
    reason: "the red child's task.created / task.completed audit appends — append-only evidence, no lifecycle state.",
  },
  {
    file: "v2/runNext.ts",
    fn: "runOneRed",
    call: "markTaskComplete",
    reason:
      "completes the red CHILD row after its container returned. A red child is not a phase primary — no gate, ready-queue " +
      "entry or invariant reads its status; the primary's evidence chain is the verdict row (probed insert). A crash " +
      "before this leaves the child `running` with a dead container, which reconcile's container-gone sweep resolves.",
  },
  {
    file: "v2/runNext.ts",
    fn: "runContainer",
    call: "logEvent",
    reason:
      "runContainer's whole event stream (task.started, model.profile_*, auth.profile_*, container.provision_*, " +
      "container.started/exited/idle_timeout) is append-only evidence around the container lifecycle. The task row's status " +
      "is written by markTaskRunning/failTask, never by these.",
  },
  {
    file: "v2/runNext.ts",
    fn: "runContainer",
    call: "failTask",
    reason:
      "terminal failure writes for every way a container can fail to start or die (auth, model policy, provisioning, " +
      "malformed result, idle timeout, non-zero exit). Same argument as dispatchSingleStep/failTask: a crash before one of " +
      "them leaves the task `running` with a dead container — reconcile's probed container-gone sweep — and failTask's own " +
      "two-write window belongs to failure-kind.ts.",
  },
  {
    file: "v2/runNext.ts",
    fn: "runContainer",
    call: "captureUsageForTask",
    reason:
      "writes model_calls (token/cost accounting) — telemetry, not lifecycle state. No lifecycle invariant, gate, ready " +
      "queue or reconcile branch reads it; a crash on either side costs accounting, not correctness.",
  },
  {
    file: "v2/runNext.ts",
    fn: "reapContainerAndReportFailure",
    call: "logEvent",
    reason:
      "the container.reap_failed audit append after a best-effort `docker rm` — no task or run state. FG-503 made `forge " +
      "ops reap-containers` disk-truth-driven, so a lost event costs nothing: the leaked container is still found by the sweep.",
  },
  {
    file: "v2/runNext.ts",
    fn: "dispatchManualStep",
    call: "insertTask",
    reason:
      "mints a manual (host-side, never containerized) task row as pending. Nothing has run; the operator drives it by hand.",
  },
  {
    file: "v2/runNext.ts",
    fn: "dispatchManualStep",
    call: "logEvent",
    reason: "the manual task's task.created audit append — append-only evidence, no lifecycle state.",
  },
  {
    file: "v2/runNext.ts",
    fn: "failFanoutParent",
    call: "insertTask",
    reason:
      "the error path taken when the upstream array a fanout reads is missing or malformed — mints the parent row solely so " +
      "the failure has somewhere to land. It runs BEFORE any child dispatches, so there is no wave, no child and no work.",
  },
  {
    file: "v2/runNext.ts",
    fn: "failFanoutParent",
    call: "logEvent",
    reason: "the fanout parent's task.created audit append on the same no-wave error path — no work exists to lose.",
  },
  {
    file: "v2/runNext.ts",
    fn: "failFanoutParent",
    call: "failTask",
    reason:
      "fails the just-minted parent on the no-upstream-array error path. Nothing ran; a crash before it leaves a pending or " +
      "running parent with zero children, which reconcile's fanout pass skips (no children) and the ready queue re-derives.",
  },
  {
    file: "v2/runNext.ts",
    fn: "runFanoutChild",
    call: "insertTask",
    reason: "pre-container mint of a fanout child row as pending — no agent work exists yet. See dispatchSingleStep/insertTask.",
  },
  {
    file: "v2/runNext.ts",
    fn: "runFanoutChild",
    call: "logEvent",
    reason: "the child's task.created / task.completed audit appends — append-only evidence, no lifecycle state.",
  },
  {
    file: "v2/runNext.ts",
    fn: "runFanoutChild",
    call: "setTaskWorktreePath",
    reason:
      "pre-container, FG-351's DB-write-before-container-start rule — the same reason as dispatchSingleStep's copy: the " +
      "write exists so a crash leaves the child's worktree findable.",
  },
  {
    file: "v2/runNext.ts",
    fn: "runFanoutChild",
    call: "failTask",
    reason:
      "fails a child on preflight/worktree-setup failure, before its container runs. A crash before it leaves the child " +
      "`running` (reconcile's container-gone sweep) or `pending` (re-dispatched); either way the PARENT stays `running` " +
      "with its children, which reconcile's fanout-parent recovery re-derives — probed by reconcile:*-fanout-parent-*.",
  },
  {
    file: "v2/runNext.ts",
    fn: "runFanoutChild",
    call: "markTaskComplete",
    reason:
      "completes a fanout CHILD after its container returned. A child is not a phase primary — no gate or ready-queue entry " +
      "reads its status, and its result is aggregated into the parent's. A crash on either side leaves the parent `running` " +
      "with a mix of terminal and running children, which reconcile resolves (child ⇒ container-gone sweep; parent ⇒ the " +
      "fanout-parent recovery, probed by reconcile:*-fanout-parent-*).",
  },

  // ── runNext.ts: dispatchFanoutStep, the fanout PARENT's own sequence ────────
  // The parent holds `running` from markTaskRunning until it leaves for
  // awaiting_red / complete / failed. Every crash inside that span lands on
  // parent-running-with-terminal-children — the state reconcile's fanout-parent
  // recovery re-derives, which this ticket adds probes for.
  {
    file: "v2/runNext.ts",
    fn: "dispatchFanoutStep",
    call: "insertTask",
    reason: "pre-wave mint of the fanout parent row — no child has dispatched, so there is no work to strand.",
  },
  {
    file: "v2/runNext.ts",
    fn: "dispatchFanoutStep",
    call: "markTaskRunning",
    reason:
      "opens the parent's `running` span (fresh wave, and the FG-353 gateForced re-entry). A crash on either side leaves the " +
      "parent `running` with its children — exactly the state reconcile's fanout-parent recovery is FOR, now probed " +
      "(reconcile:{before,inside}-fail-fanout-parent-unfinalized / -fanout-wave-orphaned).",
  },
  {
    file: "v2/runNext.ts",
    fn: "dispatchFanoutStep",
    call: "failTask",
    reason:
      "the parent's terminal failure writes (a failed child under fail-phase, an integration-branch merge conflict, a failed " +
      "post-merge gate). A crash before any of them leaves the parent `running` with terminal children — reconcile's " +
      "fanout-parent recovery, probed. failTask's internal two-write window belongs to failure-kind.ts.",
  },
  {
    file: "v2/runNext.ts",
    fn: "dispatchFanoutStep",
    call: "logEvent",
    reason:
      "integration.worktree_created / integration.child_merged / integration.merged_to_head are audit appends about git " +
      "state, and task.created / task.awaiting_red / task.completed / task.blocked_by_red sit against the status writes " +
      "below, which carry their own reasons. None of these events is read to decide a transition.",
  },
  {
    file: "v2/runNext.ts",
    fn: "dispatchFanoutStep",
    call: "setTaskStatus",
    near: "awaiting_red",
    reason:
      "moves the parent to awaiting_red before its reds dispatch. A crash in that window strands the parent at awaiting_red " +
      "with dead reds — the SAME wedge already pinned as known failure FG-530-A on the dispatchSingleStep path " +
      "(dispatchSingleStep:{before,between,after}-awaiting-red), with a live repro in the matrix. Probing the fanout copy " +
      "would register a second name for a bug that is already filed and reproduced, not cover a new one.",
  },
  {
    file: "v2/runNext.ts",
    fn: "dispatchFanoutStep",
    call: "markTaskBlockedByRed",
    reason:
      "the parent's blocked_by_red write — the same FG-482 CAS'd getDb().transaction as dispatchSingleStep's, whose two " +
      "boundaries are probed (dispatchSingleStep:{before,inside,after}-blocked-by-red). Same statement, same rollback " +
      "semantics, same recovery: a crash rolls the group back and the parent stays awaiting_red.",
  },
  {
    file: "v2/runNext.ts",
    fn: "dispatchFanoutStep",
    call: "markTaskComplete",
    reason:
      "completes the parent on the FG-353 gateForced re-entry, after the integration branch merged to HEAD. A crash before " +
      "it leaves the parent `running` with terminal children and gateForced set — reconcile's fanout-parent recovery lands " +
      "it fail-safe (probed), and `forge recover --re-drive` is the named verb. A crash after the CAS but before the " +
      "task.completed append loses only the audit event.",
  },
  {
    file: "v2/runNext.ts",
    fn: "runNext",
    call: "finalizeRunIfSettled",
    reason:
      "run-level completion. The status write and its run.completed event commit atomically INSIDE run-finalize.ts " +
      "(FG-463/FG-484), so the window is in that file, not a covered one. A crash on either side leaves the run `active` " +
      "with every task terminal — the next reconcile pass re-derives and completes it (idempotent, and the reconcile cells " +
      "drive exactly that).",
  },

  // ── gate.ts ────────────────────────────────────────────────────────────────
  {
    file: "v2/gate.ts",
    fn: "gate",
    call: "logEvent",
    near: "container.reap_failed",
    reason:
      "the container.reap_failed audit append after a best-effort `docker rm` on the advance-to-complete path — no task or " +
      "run state, and FG-503's disk-truth sweep finds the leaked container without it. The gate's own decision writes " +
      "around it are probed (gate:{before,inside,after}-decision-write).",
  },
  {
    file: "v2/gate.ts",
    fn: "finalizeRunIfDone",
    call: "finalizeRunIfSettled",
    reason:
      "run-level completion after a gate decision — same as runNext's: atomic inside run-finalize.ts, and idempotently " +
      "re-derived by the next reconcile pass if a crash lands on either side.",
  },

  // ── reconcile.ts ───────────────────────────────────────────────────────────
  {
    file: "v2/reconcile.ts",
    fn: "reconcileRun",
    call: "logEvent",
    near: "container.reap_failed",
    reason:
      "the container.reap_failed audit append after a best-effort `docker rm` — no task or run state, deliberately " +
      "outside every transaction, and FG-503's disk-truth sweep finds the leaked container without it.",
  },
  {
    file: "v2/reconcile.ts",
    fn: "reconcileRun",
    call: "finalizeRunIfSettled",
    near: "no_live_work",
    reason:
      "run-level completion of a settled invoke run. finalizeRunIfSettled re-reads the run and commits the status write with " +
      "BOTH its run.completed and run.reconciled events in one transaction inside run-finalize.ts (FG-463/FG-484) — the " +
      "window is in that file. A crash on either side leaves the run `active` with all tasks terminal; the next pass " +
      "completes it.",
  },
  {
    file: "v2/reconcile.ts",
    fn: "reconcileRun",
    call: "logEvent",
    near: "no_live_work",
    reason: "the run.reconciled event passed as finalizeRunIfSettled's onCompleted — it fires INSIDE that helper's transaction, so it is not a separable write.",
  },
  {
    file: "v2/reconcile.ts",
    fn: "finalizeOrphanedPrimaries",
    call: "markTaskFailed",
    near: "orphaned_duplicate_primary",
    reason:
      "fails a PENDING duplicate primary in a phase another primary already completed. The row never ran: no container, no " +
      "result, no verdict, no worktree — there is no work a crash could lose. The write is a single FG-463 transaction, so a " +
      "crash rolls it back whole and the next pass re-derives the identical decision from the same phase state.",
  },
  {
    file: "v2/reconcile.ts",
    fn: "finalizeOrphanedPrimaries",
    call: "logEvent",
    near: "orphaned_duplicate_primary",
    reason: "the task.failed / task.reconciled pair inside that same single transaction — see markTaskFailed above; the group commits or rolls back whole.",
  },

  // ── no deferred gaps ────────────────────────────────────────────────────────
  // The three that used to live here are all probed now, each with a fixture that
  // actually reaches it: the FG-437 mid-provisioning landing's two boundaries
  // (reconcile:{before,inside}-fail-provisioning-phase-crash, driven by the
  // `provisioning-crash` scenario), and runContainer's pre-container window
  // (runContainer:after-mark-running-before-container-launch), which is FG-533 and
  // is pinned in the matrix as a known-failure cell rather than fixed here. The
  // ratchet below is at ZERO and stays there.
];

// ── the guard ─────────────────────────────────────────────────────────────────

test("FG-530 write-surface: the store's mutator list is DERIVED from src/store, not hand-maintained — the guard must not go blind when a new mutator lands", () => {
  const mutators = storeMutators();
  for (const expected of ["markTaskComplete", "markTaskFailed", "insertTask", "insertVerdict", "logEvent", "insertGate"]) {
    assert.ok(mutators.has(expected), `${expected} writes to the DB but the derivation did not classify it as a mutator`);
  }
  for (const readOnly of ["getTask", "tasksForRun", "getRun", "verdictsForTask", "eventsForTask"]) {
    assert.ok(!mutators.has(readOnly), `${readOnly} is a read accessor and must not be demanded a crash probe`);
  }
  for (const [wrapper, file] of Object.entries(LOCAL_WRITE_WRAPPERS)) {
    const body = read(file);
    assert.ok(
      [...mutators].some((m) => new RegExp(`(?<![\\w.])${m}\\(`).test(body)),
      `${wrapper} is listed as a local write wrapper but ${file} calls no store mutator — the list has rotted`,
    );
  }
});

test("FG-530 write-surface: the covered files issue NO raw SQL — a hand-written UPDATE/INSERT would bypass the mutator surface the guard derives", () => {
  const offenders: string[] = [];
  for (const rel of PROBE_FILES) {
    read(rel)
      .split("\n")
      .forEach((line, i) => {
        if (/\.prepare\(/.test(line) && /\b(INSERT|UPDATE|DELETE)\b/i.test(line)) {
          offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
        }
      });
  }
  assert.deepEqual(
    offenders,
    [],
    "a raw db.prepare(INSERT/UPDATE/DELETE) in a covered file is a write the guard's derived mutator list cannot see —\n" +
      "route it through a src/store mutator (or teach the guard about it deliberately):\n" +
      offenders.join("\n"),
  );
});

function matches(a: Allow, s: WriteSite): boolean {
  if (a.file !== s.file || a.fn !== s.fn || a.call !== s.call) return false;
  return a.near === undefined || s.context.includes(a.near);
}

function allWriteSites(): WriteSite[] {
  const mutators = storeMutators();
  return PROBE_FILES.flatMap((rel) => writeSites(rel, writeCallsFor(rel, mutators)));
}

test("FG-530 write-surface: EVERY state-write in runNext/gate/reconcile has an adjacent crashPoint probe or an allowlist entry with a reason — an unprobed write is a crash window with no matrix cell", () => {
  const unprobed = allWriteSites().filter((s) => !s.probed && !ALLOWLIST.some((a) => matches(a, s)));

  assert.deepEqual(
    unprobed.map((s) => `${s.file}:${s.line} ${s.call}() in ${s.fn}()`),
    [],
    "THE RULE: a state-write in a covered file is a crash boundary. It must either\n" +
      `  (a) sit within ${PROBE_WINDOW} lines of a crashPoint("<surface>:<where>") probe — then register that probe in\n` +
      "      KILL_POINTS (fg530-crash-matrix) + PROBE_NAMES (crash-points.test.ts); the lockstep test above forces both,\n" +
      "      and the matrix's coverage test forces a scenario to actually reach it; OR\n" +
      "  (b) carry an ALLOWLIST entry in this file with a WRITTEN REASON saying why a crash there cannot strand,\n" +
      "      lose, or ship-without-evidence any state — the reviewer reads the reason.\n" +
      "Two review rounds each found a fresh instance of exactly this; the guard exists so the third is caught here.\n" +
      "These writes have neither:\n" +
      unprobed.map((s) => `  ${s.file}:${s.line} — ${s.call}() in ${s.fn}()`).join("\n"),
  );
});

test("FG-530 write-surface: every ALLOWLIST entry still names a real, still-unprobed write and carries a real reason — a stale exemption is a hole nobody is watching", () => {
  const sites = allWriteSites();

  const stale = ALLOWLIST.filter((a) => !sites.some((s) => !s.probed && matches(a, s))).map(
    (a) => `${a.file} ${a.call}()${a.near ? ` near "${a.near}"` : ""} in ${a.fn}()`,
  );
  assert.deepEqual(
    stale,
    [],
    "these allowlist entries match no unprobed write — the call was probed, moved, renamed, or deleted. Delete the entry:\n  " +
      stale.join("\n  "),
  );

  for (const a of ALLOWLIST) {
    assert.ok(
      a.reason.trim().length >= 40,
      `the allowlist entry for ${a.call}() in ${a.file} ${a.fn}() has no real reason — "${a.reason}"`,
    );
  }
});

// ── the guard's own detection power ───────────────────────────────────────────
//
// A green write-surface test proves nothing unless the classifier can be shown to
// FAIL on the shape it exists to catch. This is the same standard the matrix's
// META-AC holds its checkers to. The fixture is the exact shape both review rounds
// found: one probed write sequence, and an unprobed sibling arm ten lines away.

const GUARD_FIXTURE = `
function recover(): void {
  if (allComplete) {
    crashPoint("reconcile:before-fail-fanout-parent-unfinalized");
    getDb().transaction(() => {
      markTaskFailed(parent.id, error, parentResult);
      crashPoint("reconcile:inside-fail-fanout-parent-unfinalized-txn");
      logEvent("task.failed", { runId, taskId: parent.id });
    })();
  } else {
    getDb().transaction(() => {
      markTaskFailed(parent.id, error, parentResult);
      logEvent("task.reconciled", { runId, taskId: parent.id });
    })();
  }
}
`;

test("FG-530 write-surface [detection power]: the classifier FLAGS an unprobed write and stays quiet on a probed one — and the sequence break stops a probed if/else arm from vouching for its unprobed twin", () => {
  const sites = writeSitesIn("fixture.ts", GUARD_FIXTURE, new Set(["markTaskFailed", "logEvent"]));

  const probed = sites.filter((s) => s.probed).map((s) => s.line);
  const unprobed = sites.filter((s) => !s.probed).map((s) => s.line);

  assert.deepEqual(probed, [6, 8], "the writes inside the PROBED arm's transaction are covered by the two probes around them");
  assert.deepEqual(
    unprobed,
    [12, 13],
    "the ELSE arm's writes are 5 and 6 lines from the probed arm's inner probe — inside the line window, but across a `})();`\n" +
      "and a `} else`. If they read as probed, the guard would have PASSED the exact defect FG-530's round-2 review filed.",
  );
  assert.equal(sites[0]!.fn, "recover", "a finding must name the function it lives in, not just a line");
});

/** Deferred crash windows, ratcheted. Deferring a write is legitimate — probing it
 *  means building the fixture that reaches it, and that can be its own ticket — but
 *  it must be a VISIBLE act. This number only goes down, and it is now at ZERO:
 *  every write boundary in the three covered files is either probed and exercised by
 *  a matrix cell, or exempt with a written reason. */
const DEFERRED_GAPS = 0;

test("FG-530 write-surface: the deliberately-deferred crash windows are exactly the ones already accounted for — deferring a NEW one must be a reviewed decision, not an allowlist line nobody reads", () => {
  const gaps = ALLOWLIST.filter((a) => a.gap);

  for (const g of gaps) {
    assert.ok(
      g.reason.startsWith("GAP — "),
      `a gap entry's reason must open with "GAP — " so it is greppable and cannot read as a benign exemption: ${g.call}() in ${g.fn}()`,
    );
  }

  assert.ok(
    gaps.length <= DEFERRED_GAPS,
    `${gaps.length} deferred crash windows, but the ratchet allows ${DEFERRED_GAPS}. A NEW gap means a genuine crash window\n` +
      "is shipping unprobed: either build the fixture that reaches it (probe + KILL_POINTS + PROBE_NAMES + a scenario), or\n" +
      "raise this number deliberately and say why in the ticket. It exists to go DOWN:\n  " +
      gaps.map((g) => `${g.file} ${g.call}() in ${g.fn}()`).join("\n  "),
  );
});
