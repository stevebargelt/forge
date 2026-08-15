// FG-560 (step 5): the model-policy.yml MIGRATION ENGINE.
//
// `forge upgrade` is the SOLE authority that rewrites an operator's
// model-policy.yml (loader.ts's dispatch read path is strictly read-only and
// REFUSES a legacy file — see assertCurrentModelPolicyVersion). This module is the
// other half of that contract: a PERMISSIVE reader + comment/ordering-preserving
// writer that repairs a v1 file into schema_version 2.
//
// ── TWO DISTINCT READ PATHS (deliberate) ────────────────────────────────────────
//
// The dispatch loader refuses a v1 file; the migrator must still READ that same v1
// file to repair it. So this module NEVER routes through loadModelPolicy — it parses
// the raw bytes itself with the `yaml` dependency's parseDocument (the CST-backed
// Document), which round-trips comments, key order, and unknown keys. A
// parse->object->stringify would destroy exactly those, so the edit is TARGETED:
// only the added alias keys are touched; everything else is left byte-for-byte.
//
// ── THE ONE VERDICT ─────────────────────────────────────────────────────────────
//
// classifyModelPolicyContent computes a per-file verdict ONCE. `forge upgrade`'s
// dry-run forecast and its real run both key off the SAME verdict, so the forecast
// can never disagree with what the run does (the FG-546 DocsSurfaces discipline).
//
//   current               already v2 and re-migrating is a byte-stable no-op.
//   migratable            a v1 file (no/older schema_version) that migrates cleanly.
//   changed-if-applied    already v2, but alias entries would still be ADDED.
//   needs-human-decision  a mapping needs an alias whose source is absent — refuse
//                         to guess (NEVER copy `default` and call it verified intent);
//                         the WHOLE file is left unchanged for a human.
//   newer-unsupported     schema_version > current — this forge is too old to touch it.
//
// ── THE ALIAS MIGRATION ─────────────────────────────────────────────────────────
//
// FG-560 introduces two orchestrator-facing capability names — `spec-writer` and
// `fast-orchestrator` — copied from their established equivalents `reasoning` and
// `fast`. For defaults.activity and each profile map: if the destination is absent
// and the source exists, copy the source verbatim; if the destination already
// exists, preserve it byte-for-byte (NEVER overwrite an operator's choice); if both
// are absent, the pair needs a human. A default-ONLY map (e.g. pi-groq's `{ default }`
// catch-all, by design) is OUT OF SCOPE and classifies `current`, never human.

import { readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { parseDocument, parse as parseYaml, isMap, isScalar, type Node } from "yaml";
import { ModelPolicySchema, CURRENT_MODEL_POLICY_SCHEMA_VERSION } from "./schema.js";

export type MigrationVerdict =
  | "current"
  | "migratable"
  | "changed-if-applied"
  | "needs-human-decision"
  | "newer-unsupported";

/** The alias pairs FG-560 adds: a NEW orchestrator-facing name copied from an
 *  established capability. Ordered so additions land deterministically. */
export const ALIAS_PAIRS: ReadonlyArray<{ source: string; dest: string }> = [
  { source: "reasoning", dest: "spec-writer" },
  { source: "fast", dest: "fast-orchestrator" },
];

/** One planned copy of a source alias into a new destination alias, with the exact
 *  document path of the map it lands in (so the writer touches only that node). */
export interface AliasAddition {
  /** Human label for reporting, e.g. `model_profiles.claude-subscription.map`. */
  target: string;
  path: (string | number)[];
  source: string;
  dest: string;
}

/** A destination alias that CANNOT be derived because its source is absent — and the
 *  map is neither empty nor a deliberate default-only catch-all. A human must decide. */
export interface HumanDecision {
  target: string;
  path: (string | number)[];
  dest: string;
  source: string;
  reason: string;
}

export interface ModelPolicyMigration {
  verdict: MigrationVerdict;
  /** schema_version found in the file, or null when absent (a v1/legacy file). */
  schemaVersionFound: number | null;
  /** Alias copies that would be / were applied (migratable | changed-if-applied). */
  additions: AliasAddition[];
  /** Unresolvable pairs (needs-human-decision). Non-empty ⇒ the file is left as-is. */
  humanDecisions: HumanDecision[];
  /** The migrated bytes for migratable | changed-if-applied; null when no write
   *  happens (current | needs-human-decision | newer-unsupported). The dry-run
   *  forecast and the real run share this exact value, so they cannot disagree. */
  migratedContent: string | null;
}

const CURRENT = CURRENT_MODEL_POLICY_SCHEMA_VERSION;

function scalarKey(k: unknown): string {
  return isScalar(k) ? String(k.value) : String(k);
}

/** The migration targets in a policy document: defaults.activity, then each
 *  model_profiles.<name>.map. Only nodes that resolve to a YAML map are returned. */
function collectTargets(doc: ReturnType<typeof parseDocument>): { target: string; path: (string | number)[] }[] {
  const out: { target: string; path: (string | number)[] }[] = [];
  const activity = doc.getIn(["defaults", "activity"], true);
  if (isMap(activity)) out.push({ target: "defaults.activity", path: ["defaults", "activity"] });

  const profiles = doc.getIn(["model_profiles"], true);
  if (isMap(profiles)) {
    for (const item of profiles.items) {
      const name = scalarKey(item.key);
      const map = doc.getIn(["model_profiles", name, "map"], true);
      if (isMap(map)) out.push({ target: `model_profiles.${name}.map`, path: ["model_profiles", name, "map"] });
    }
  }
  return out;
}

/** Analyze one map target: fill `additions` for derivable aliases and
 *  `humanDecisions` for undecidable ones. An empty map or a default-only catch-all
 *  contributes NOTHING — the latter is the intentional pi-groq shape and must never
 *  read as needs-human-decision. */
function analyzeTarget(
  doc: ReturnType<typeof parseDocument>,
  target: string,
  path: (string | number)[],
  additions: AliasAddition[],
  humanDecisions: HumanDecision[],
): void {
  const map = doc.getIn(path, true);
  if (!isMap(map)) return;
  const keys = map.items.map((it) => scalarKey(it.key));
  if (keys.length === 0) return; // nothing mapped here — nothing to migrate
  if (keys.length === 1 && keys[0] === "default") return; // default-only catch-all — out of scope

  for (const { source, dest } of ALIAS_PAIRS) {
    if (map.has(dest)) continue; // preserve an existing alias byte-for-byte
    if (map.has(source)) {
      additions.push({ target, path, source, dest });
    } else {
      humanDecisions.push({
        target,
        path,
        dest,
        source,
        reason: `'${dest}' is absent and its source '${source}' is absent — refusing to copy 'default' and call it verified intent`,
      });
    }
  }
}

/** Compute the migration verdict + planned edits ONCE from raw bytes. Permissive:
 *  reads a v1 file the dispatch loader would refuse. Throws only on genuinely
 *  unusable input (unparseable YAML, a malformed schema_version) — never guesses. */
export function classifyModelPolicyContent(raw: string): ModelPolicyMigration {
  const doc = parseDocument(raw);
  if (doc.errors.length > 0) {
    throw new Error(`model-policy migration: cannot parse YAML — ${doc.errors[0]!.message}`);
  }

  const svRaw = doc.get("schema_version");
  let schemaVersionFound: number | null;
  if (svRaw === undefined || svRaw === null) {
    schemaVersionFound = null;
  } else if (typeof svRaw === "number" && Number.isInteger(svRaw) && svRaw >= 1) {
    schemaVersionFound = svRaw;
  } else {
    throw new Error(
      `model-policy migration: schema_version must be a positive integer, got ${JSON.stringify(svRaw)} — refusing to guess the version`,
    );
  }

  if (schemaVersionFound !== null && schemaVersionFound > CURRENT) {
    return { verdict: "newer-unsupported", schemaVersionFound, additions: [], humanDecisions: [], migratedContent: null };
  }

  const additions: AliasAddition[] = [];
  const humanDecisions: HumanDecision[] = [];
  for (const t of collectTargets(doc)) analyzeTarget(doc, t.target, t.path, additions, humanDecisions);

  // A single unresolvable pair holds the WHOLE file: never half-migrate a file that
  // needs a human, and never stamp its version (it stays refused at dispatch until
  // the operator resolves it and re-runs upgrade).
  if (humanDecisions.length > 0) {
    return { verdict: "needs-human-decision", schemaVersionFound, additions, humanDecisions, migratedContent: null };
  }

  const needsVersionStamp = schemaVersionFound !== CURRENT; // absent or older
  if (!needsVersionStamp && additions.length === 0) {
    return { verdict: "current", schemaVersionFound, additions, humanDecisions, migratedContent: null };
  }

  const migratedContent = applyMigration(raw, additions);
  const verdict: MigrationVerdict = needsVersionStamp ? "migratable" : "changed-if-applied";
  return { verdict, schemaVersionFound, additions, humanDecisions, migratedContent };
}

/** Produce the migrated bytes: a fresh parseDocument, each addition applied as a
 *  clone of the source value node (so formatting matches the source verbatim), then
 *  schema_version stamped. `lineWidth: 0` disables reflow so UNTOUCHED flow maps
 *  (e.g. pi-groq's one-line default) stay byte-identical. */
function applyMigration(raw: string, additions: AliasAddition[]): string {
  const doc = parseDocument(raw);
  for (const add of additions) {
    const map = doc.getIn(add.path, true);
    if (!isMap(map)) continue; // unreachable — path came from the same parse
    const srcVal = map.get(add.source, true) as Node | undefined;
    if (srcVal === undefined) continue;
    map.set(add.dest, srcVal.clone());
  }

  const sv = doc.get("schema_version");
  if (sv === CURRENT) {
    // already current (changed-if-applied) — no version edit
  } else if (sv === undefined || sv === null) {
    // A v1 file has no schema_version key. doc.set appends it; move it to the FIRST
    // position, carrying any header comment that was attached to the old first key
    // so the file still opens with its banner.
    doc.set("schema_version", CURRENT);
    moveKeyToFrontCarryingComment(doc, "schema_version");
  } else {
    // An older-but-present version — update in place, preserving its position.
    doc.set("schema_version", CURRENT);
  }

  return doc.toString({ lineWidth: 0 });
}

/** Move a just-appended top-level key to the front of the document map. Transfers a
 *  header comment off the (previous) first key onto the moved key so a migrated file
 *  still opens with its banner. Operates within contents.items so the moved element
 *  keeps its parsed-node type. */
function moveKeyToFrontCarryingComment(doc: ReturnType<typeof parseDocument>, key: string): void {
  const contents = doc.contents;
  if (!isMap(contents)) return;
  const items = contents.items;
  const idx = items.findIndex((it) => scalarKey(it.key) === key);
  if (idx <= 0) return; // absent, or already first
  const [moved] = items.splice(idx, 1);
  if (!moved) return;
  // Carry a header comment off the (previous) first key onto the moved key so the
  // file still opens with its banner — but ONLY when both keys are Scalar NODES that
  // can hold a comment. A freshly-set key may be a bare string; then the header
  // simply stays attached to its original key (now the second item), still preserved.
  const first = items[0];
  const firstKey = first?.key;
  const movedKey = moved.key;
  if (
    isScalar(firstKey) &&
    isScalar(movedKey) &&
    firstKey.commentBefore != null &&
    movedKey.commentBefore == null
  ) {
    movedKey.commentBefore = firstKey.commentBefore;
    firstKey.commentBefore = null;
  }
  items.unshift(moved);
}

/** Injectable filesystem seam — real fs by default; tests substitute it to drive the
 *  atomic-write recovery path. */
export interface MigrateIO {
  readFileSync: (path: string, enc: "utf8") => string;
  writeFileSync: (path: string, data: string, enc: "utf8") => void;
  renameSync: (from: string, to: string) => void;
  unlinkSync: (path: string) => void;
}

const REAL_IO: MigrateIO = {
  readFileSync: (p, e) => readFileSync(p, e),
  writeFileSync: (p, d, e) => writeFileSync(p, d, e),
  renameSync: (f, t) => renameSync(f, t),
  unlinkSync: (p) => unlinkSync(p),
};

export interface MigrateFileResult {
  path: string;
  migration: ModelPolicyMigration;
  /** True only when new bytes were renamed into place (real run, migratable |
   *  changed-if-applied). Dry-run and no-op verdicts are always false. */
  written: boolean;
}

/** Migrate ONE policy file. Idempotent: re-running over a v2 file yields
 *  verdict=current and writes nothing (byte-stable no-op). The write is
 *  temp-file + validate + atomic rename, mirroring the routing-policy fail-closed
 *  reasoning in upgrade.ts: the ORIGINAL stays authoritative and recoverable
 *  whenever the new bytes cannot be PROVEN a valid current-version policy, and the
 *  temp is cleaned up even in the double-failure path where the rename throws. */
export function migrateModelPolicyFile(
  path: string,
  opts: { dryRun?: boolean; io?: MigrateIO } = {},
): MigrateFileResult {
  const io = opts.io ?? REAL_IO;
  const raw = io.readFileSync(path, "utf8");
  const migration = classifyModelPolicyContent(raw);
  if (opts.dryRun || migration.migratedContent === null) {
    return { path, migration, written: false };
  }
  writeMigratedAtomically(path, migration.migratedContent, io);
  return { path, migration, written: true };
}

function writeMigratedAtomically(path: string, content: string, io: MigrateIO): void {
  const tmp = `${path}.migrate-${process.pid}-${randomBytes(8).toString("hex")}.tmp`;
  try {
    io.writeFileSync(tmp, content, "utf8");
    // Prove the new bytes are a valid CURRENT-version policy BEFORE they can replace
    // the original — read the temp back (so a corrupt write is caught, not just the
    // in-memory string) and validate. A temp that fails validation is NEVER renamed:
    // the original is left byte-identical and loadable (fail-closed).
    assertValidCurrentPolicy(io.readFileSync(tmp, "utf8"), path);
    io.renameSync(tmp, path);
  } catch (e) {
    // Best-effort cleanup of the temp. The original was never touched, so it stays
    // authoritative and recoverable even if this unlink ALSO fails.
    try {
      io.unlinkSync(tmp);
    } catch {
      /* ignore — a stray temp is harmless; the original is intact */
    }
    throw e;
  }
}

function assertValidCurrentPolicy(content: string, origPath: string): void {
  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch (e) {
    throw new Error(
      `model-policy migration: the migrated bytes failed to parse — ${(e as Error).message}; original ${origPath} left intact`,
    );
  }
  const sv = (parsed as { schema_version?: unknown } | null)?.schema_version;
  if (sv !== CURRENT) {
    throw new Error(
      `model-policy migration: the migrated bytes have schema_version ${JSON.stringify(sv)}, expected ${CURRENT}; original ${origPath} left intact`,
    );
  }
  const res = ModelPolicySchema.safeParse(parsed);
  if (!res.success) {
    const detail = res.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(
      `model-policy migration: the migrated bytes failed schema validation — ${detail}; original ${origPath} left intact`,
    );
  }
}
