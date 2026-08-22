// #155: `forge usage` — token + cache rollups across role / workflow / project / model.
//
// Backed by the model_calls table populated at task-completion (spawn.ts) +
// historically by `forge usage backfill`. This CLI is deliberately minimal —
// it proves the data is sound; the dashboard is where the UX investment goes.
//
// Headline columns:
//   tokens.in           — fresh input tokens (uncached)
//   tokens.out          — completion tokens
//   cache.read          — read from prompt cache (cheap)
//   cache.create        — written to prompt cache (expensive)
//   cache_hit_rate %    — cache.read / (cache.read + cache.create + tokens.in)
//   reuse_ratio         — cache.read / cache.create (how many times each
//                         created block is read on average; >>1 = good)
//   weighted_tokens     — tokens.in + 1.25*cache.create + 0.1*cache.read + 5*tokens.out
//                         (proxy for relative spend; unitless; no committing to
//                         dollars since OAuth has no per-token cost and prices
//                         drift)

import type { Command } from "commander";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { ensureForgeDirs } from "../../util/paths.js";
import { getDb } from "../../store/db.js";
import { renderedEmptyStore } from "../no-store.js";
import { captureUsageForTask, extractUsageByLogFormat } from "../../store/model-calls.js";
import { projectGroupingSql, resolveUsageProjectLabel, hasRunsProjectIdentity } from "../../store/usage-grouping.js";
import { listProjects } from "../../util/projects.js";
import {
  planLegacyRepair,
  applyLegacyRepair,
  type LegacyRepairPlan,
} from "../../store/usage-legacy-repair.js";
import { userInfo } from "node:os";

// #262: read the runtime log_format recorded in the task's manifest (written
// since #292) so backfill selects the right usage parser instead of defaulting to
// claude — otherwise pi/codex logs silently backfill zero rows. Undefined for
// pre-#292 manifests (or none), which correctly falls back to the claude parser.
function manifestLogFormat(stdoutLogPath: string): string | undefined {
  try {
    const m = JSON.parse(readFileSync(join(dirname(stdoutLogPath), "manifest.json"), "utf8")) as { runtime?: { logFormat?: unknown } };
    return typeof m.runtime?.logFormat === "string" ? m.runtime.logFormat : undefined;
  } catch {
    return undefined;
  }
}

// Cached lookup: task_id → agent_alias. Built once per backfill so we don't
// hammer the DB inside the per-task loop. Tasks not in the table (orphaned
// task dirs, manual SQL deletes) fall through to null alias.
//
// NB: opens DB writable (no {readOnly:true}) on purpose — getDb caches the
// first connection, and the subsequent backfill INSERT path needs a writable
// handle. Opening readonly here cached a readonly connection that silently
// dropped writes.
function buildAliasIndex(): Map<string, string> {
  const rows = getDb().prepare(`SELECT id, agent_alias FROM tasks WHERE agent_alias IS NOT NULL`).all() as Array<{ id: string; agent_alias: string | null }>;
  const idx = new Map<string, string>();
  for (const r of rows) {
    if (r.agent_alias) idx.set(r.id, r.agent_alias);
  }
  return idx;
}

type GroupBy = "role" | "workflow" | "project" | "model" | "alias";

type Row = {
  bucket: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  requests: number;
};

export function registerUsage(program: Command): void {
  const usage = program
    .command("usage")
    .description("Token + cache rollups from model_calls (populated at task-completion + via `usage backfill`)");

  usage
    .command("show", { isDefault: true })
    .description("Show usage rollups grouped by --by; default groups by role")
    .option("--by <dim>", "role | workflow | project | model | alias (default: role)", "role")
    .option("--since <window>", "time window: 1d | 7d | 30d | all (default: all)", "all")
    .option("--project <dir>", "filter to ONE exact checkout/workspace path (a path filter, NOT the `--by project` accounting bucket)")
    .option("--run <id>", "filter to a single run (e.g. the per-provider split within one run)")
    .option("--task <id>", "filter to a single task")
    .option("--json", "emit JSON instead of a table")
    .option("--limit <n>", "max rows (default: 50)", (v) => parseInt(v, 10), 50)
    .action((opts: { by: string; since: string; project?: string; run?: string; task?: string; json?: boolean; limit: number }) => {
      ensureForgeDirs();
      const by = parseGroupBy(opts.by);
      if (renderedEmptyStore(
        opts.json,
        { groupBy: by, since: opts.since, project: opts.project ?? null, run: opts.run ?? null, task: opts.task ?? null, rows: [] },
        "No usage data. Run `forge usage backfill` to populate from existing run logs, or run a fresh forge dispatch.",
      )) return;
      const sinceClause = parseSinceClause(opts.since);
      const rows = aggregate({ by, sinceClause, projectFilter: opts.project, runFilter: opts.run, taskFilter: opts.task, limit: opts.limit });
      if (opts.json) {
        console.log(JSON.stringify({ groupBy: by, since: opts.since, project: opts.project ?? null, run: opts.run ?? null, task: opts.task ?? null, rows }, null, 2));
        return;
      }
      if (rows.length === 0) {
        console.log("No usage data. Run `forge usage backfill` to populate from existing run logs, or run a fresh forge dispatch.");
        return;
      }
      printTable(by, rows);
    });

  usage
    .command("backfill")
    .description("Walk ~/.forge/runs/*/task-*/container.stdout.log and populate model_calls for historical tasks")
    .option("--dry-run", "scan logs and report what would be inserted, without writing")
    .option("--limit <n>", "only process the most-recent N tasks (default: all)", (v) => parseInt(v, 10))
    .action((opts: { dryRun?: boolean; limit?: number }) => {
      ensureForgeDirs();
      const runsDir = join(process.env["FORGE_HOME"] ?? join(homedir(), ".forge"), "runs");
      if (!existsSync(runsDir)) {
        console.log(`No runs dir at ${runsDir}. Nothing to backfill.`);
        return;
      }
      const s = performBackfill(runsDir, opts);
      console.log(`Found ${s.scanned}${opts.limit && s.total > s.scanned ? ` of ${s.total}` : ""} task log(s) to scan.`);
      const verb = opts.dryRun ? "would insert" : "inserted";
      console.log(`Scanned ${s.scanned} task(s); ${s.withData} had usable data; ${verb} ${s.totalRows} model_call row(s); ${s.withAlias} tagged with alias.`);
      if (s.withErrors > 0) console.log(`(${s.withErrors} task(s) had parse errors — likely incomplete logs)`);
    });

  // FG-747: legacy usage-attribution repair. Runs written before FG-663 carry a NULL
  // project_identity and sit in the "Unattributed legacy usage" bucket. This backfills
  // that column from DURABLE, retarget-proof evidence only (a workspace_purposes owner
  // identity, or an explicit operator `--map path=identity`) — never from a path/name
  // heuristic. Default is a DRY-RUN (report, no mutation); `--apply` mutates.
  usage
    .command("repair")
    .description("Attribute NULL-identity legacy usage rows to their durable project (safe, evidence-only)")
    .option("--apply", "apply the repair (default is a dry-run report that mutates nothing)")
    .option(
      "--map <path=identity...>",
      "explicit operator mapping: an exact checkout/workspace path = its durable project identity (repeatable)",
    )
    .option("--json", "emit JSON instead of a table")
    .action((opts: { apply?: boolean; map?: string[]; json?: boolean }) => {
      ensureForgeDirs();
      const mapping = parseRepairMapping(opts.map);
      if (!opts.apply) {
        const plan = planLegacyRepair(mapping);
        if (opts.json) {
          console.log(JSON.stringify({ mode: "dry-run", ...plan }, null, 2));
          return;
        }
        printRepairPlan(plan);
        return;
      }
      // Apply: the OS user is best-effort actor context (never fabricated) recorded on
      // the audit row. Idempotent — a re-run maps nothing new.
      const actor = osUserOrNull();
      const result = applyLegacyRepair(mapping, actor);
      if (opts.json) {
        console.log(JSON.stringify({ mode: "apply", ...result }, null, 2));
        return;
      }
      if (result.applied.length === 0) {
        console.log("No legacy rows attributed (nothing had durable evidence or an operator mapping, or the repair already ran).");
        return;
      }
      for (const a of result.applied) {
        console.log(`  ${a.newIdentity}  ←  ${a.sourcePath}  (${a.runsUpdated} run(s), via ${a.evidence})`);
      }
      console.log(`Attributed ${result.runsUpdated} legacy run(s). Model-call totals are unchanged (only project attribution moved).`);
      console.log("The dashboard reflects this within its next poll / presentation-cache window (~30s); a brief lag is expected, not a failure.");
    });
}

/** Parse repeated `--map path=identity` tokens into a path -> identity map. A token
 *  without `=`, or with an empty side, is refused loudly rather than silently dropped
 *  (a mis-typed mapping must never quietly attribute nothing). */
function parseRepairMapping(tokens: string[] | undefined): Map<string, string> {
  const mapping = new Map<string, string>();
  for (const token of tokens ?? []) {
    const eq = token.indexOf("=");
    if (eq <= 0 || eq === token.length - 1) {
      throw new Error(`--map expects <path>=<identity> (got: ${token})`);
    }
    mapping.set(token.slice(0, eq), token.slice(eq + 1));
  }
  return mapping;
}

function osUserOrNull(): string | null {
  try {
    const name = userInfo().username;
    return name && name.length > 0 ? name : null;
  } catch {
    return null;
  }
}

function printRepairPlan(plan: LegacyRepairPlan): void {
  if (plan.identityColumnAbsent) {
    console.log("This store has no runs.project_identity column (aged/peer store); nothing to repair.");
    return;
  }
  if (plan.mappings.length === 0 && plan.unresolved.length === 0) {
    console.log("No NULL-identity legacy usage rows. Nothing to repair.");
    return;
  }
  if (plan.mappings.length > 0) {
    console.log(`Proposed attributions (${plan.mappings.length}) — dry-run, nothing written:`);
    for (const m of plan.mappings) {
      console.log(
        `  ${m.proposedIdentity}  ←  ${m.sourcePath}` +
          `  [${m.runCount} run(s), ${m.requests} request(s), in=${m.inputTokens} out=${m.outputTokens}` +
          ` cr=${m.cacheReadTokens} cc=${m.cacheCreationTokens}]  via ${m.evidence}`,
      );
    }
  }
  if (plan.unresolved.length > 0) {
    console.log(`\nUnresolved — stay in "Unattributed legacy usage" (${plan.unresolved.length}):`);
    for (const u of plan.unresolved) {
      console.log(`  ${u.sourcePath}  [${u.runCount} run(s), ${u.requests} request(s)]  (no durable evidence, no operator mapping)`);
    }
  }
  console.log(`\nRun \`forge usage repair --apply\` (optionally with --map <path>=<identity>) to attribute the proposed rows.`);
}

function safeListProjects(): ReadonlyArray<{ key: string; label: string }> {
  try {
    return listProjects();
  } catch {
    return [];
  }
}

function parseGroupBy(raw: string): GroupBy {
  const v = raw.toLowerCase();
  if (v === "role" || v === "workflow" || v === "project" || v === "model" || v === "alias") return v;
  throw new Error(`--by must be one of: role | workflow | project | model | alias (got: ${raw})`);
}

function parseSinceClause(raw: string): string {
  if (raw === "all") return "";
  const m = raw.match(/^(\d+)d$/);
  if (!m || !m[1]) throw new Error(`--since must be "all" or "<N>d" (got: ${raw})`);
  const days = parseInt(m[1], 10);
  // SQLite datetime arithmetic on ISO strings — created_at is ISO, so a
  // simple lexicographic compare against (now - Nd) ISO works.
  const cutoff = new Date(Date.now() - days * 86400_000).toISOString();
  return `AND mc.created_at >= '${cutoff}'`;
}

export function aggregate(opts: {
  by: GroupBy;
  sinceClause: string;
  projectFilter: string | undefined;
  runFilter?: string | undefined;
  taskFilter?: string | undefined;
  limit: number;
}): Row[] {
  const { by, sinceClause, projectFilter, runFilter, taskFilter, limit } = opts;
  const db = getDb({ readOnly: true });
  // FG-747: the `project` dimension keys on the durable runs.project_identity through
  // the ONE shared grouping contract (usage-grouping.ts) so the CLI and the dashboard
  // group and label identically (AC4). The other dimensions are unchanged.
  const projectGrouping = projectGroupingSql(db, "r");
  const groupExpr: Record<GroupBy, string> = {
    role:     "COALESCE(t.agent_role, '(unknown role)')",
    workflow: "COALESCE(r.workflow,   '(unknown workflow)')",
    project:  projectGrouping.bucketExpr,
    model:    "COALESCE(mc.model,     '(unknown model)')",
    alias:    "COALESCE(mc.alias,     '(no alias)')",
  };
  // The registry join is spliced in ONLY for the project dimension. It is a LEFT JOIN
  // on project_identity's PRIMARY KEY, so it re-keys a row's bucket without ever
  // dropping or duplicating a model_call (AC8).
  const groupingJoin = by === "project" ? projectGrouping.join : "";
  const sqlLit = (v: string) => `'${v.replace(/'/g, "''")}'`;
  // `--project <dir>` stays an EXACT checkout/workspace filter (a different dimension
  // from `--by project`, which is the durable-identity accounting bucket — AC10).
  const projectClause = projectFilter ? `AND r.project_dir = ${sqlLit(projectFilter)}` : "";
  const runClause = runFilter ? `AND t.run_id = ${sqlLit(runFilter)}` : "";
  const taskClause = taskFilter ? `AND mc.task_id = ${sqlLit(taskFilter)}` : "";
  const sql = `
    SELECT
      ${groupExpr[by]} AS bucket,
      SUM(mc.input_tokens)          AS in_tok,
      SUM(mc.output_tokens)         AS out_tok,
      SUM(mc.cache_read_tokens)     AS read_tok,
      SUM(mc.cache_creation_tokens) AS create_tok,
      COUNT(*) AS req_count
    FROM model_calls mc
    LEFT JOIN tasks t ON t.id = mc.task_id
    LEFT JOIN runs  r ON r.id = t.run_id
    ${groupingJoin}
    WHERE 1 = 1
      ${sinceClause}
      ${projectClause}
      ${runClause}
      ${taskClause}
    GROUP BY bucket
    ORDER BY (SUM(mc.input_tokens) + SUM(mc.cache_creation_tokens) + SUM(mc.cache_read_tokens) + SUM(mc.output_tokens)) DESC
    LIMIT ?
  `;
  const raw = db.prepare(sql).all(limit) as Array<{
    bucket: string;
    in_tok: number;
    out_tok: number;
    read_tok: number;
    create_tok: number;
    req_count: number;
  }>;
  // For the project dimension the SQL bucket is the durable identity KEY; resolve it
  // to the same human label the dashboard renders (all Forge checkouts -> "Forge";
  // the sentinel -> "Unattributed legacy usage"). Skipped when the identity column is
  // absent (degraded legacy path already buckets by project_dir) or on a registry read
  // failure — label then falls back to the raw key, never a thrown rollup.
  const registry = by === "project" && hasRunsProjectIdentity(db) ? safeListProjects() : [];
  return raw.map((r) => ({
    bucket: by === "project" ? resolveUsageProjectLabel(r.bucket, registry) : r.bucket,
    inputTokens: r.in_tok ?? 0,
    outputTokens: r.out_tok ?? 0,
    cacheReadTokens: r.read_tok ?? 0,
    cacheCreationTokens: r.create_tok ?? 0,
    requests: r.req_count ?? 0,
  }));
}

function printTable(by: GroupBy, rows: Row[]): void {
  const bucketHeader = by.toUpperCase();
  const bucketW = Math.min(40, Math.max(bucketHeader.length, ...rows.map((r) => r.bucket.length)));
  const cols = [
    pad(bucketHeader, bucketW),
    pad("REQS",        7,  "right"),
    pad("IN",         10, "right"),
    pad("OUT",        10, "right"),
    pad("CR.READ",    12, "right"),
    pad("CR.CREATE",  12, "right"),
    pad("HIT%",        6, "right"),
    pad("REUSE",       7, "right"),
    pad("WEIGHTED",   12, "right"),
  ].join("  ");
  console.log(cols);
  console.log("─".repeat(Math.min(140, cols.length)));
  let tIn = 0, tOut = 0, tRead = 0, tCreate = 0, tReq = 0, tWeighted = 0;
  for (const r of rows) {
    const denom = r.cacheReadTokens + r.cacheCreationTokens + r.inputTokens;
    const hit = denom > 0 ? (r.cacheReadTokens / denom * 100) : 0;
    const reuse = r.cacheCreationTokens > 0 ? (r.cacheReadTokens / r.cacheCreationTokens) : 0;
    const weighted = r.inputTokens + r.cacheCreationTokens * 1.25 + r.cacheReadTokens * 0.1 + r.outputTokens * 5;
    tIn += r.inputTokens; tOut += r.outputTokens; tRead += r.cacheReadTokens; tCreate += r.cacheCreationTokens; tReq += r.requests; tWeighted += weighted;
    console.log([
      pad(truncate(r.bucket, bucketW), bucketW),
      pad(String(r.requests),       7,  "right"),
      pad(fmtTokens(r.inputTokens), 10, "right"),
      pad(fmtTokens(r.outputTokens),10, "right"),
      pad(fmtTokens(r.cacheReadTokens),     12, "right"),
      pad(fmtTokens(r.cacheCreationTokens), 12, "right"),
      pad(hit.toFixed(1),                  6,  "right"),
      pad(reuse.toFixed(1) + "x",          7,  "right"),
      pad(fmtTokens(Math.round(weighted)), 12, "right"),
    ].join("  "));
  }
  if (rows.length > 1) {
    console.log("─".repeat(Math.min(140, cols.length)));
    const denom = tRead + tCreate + tIn;
    const hit = denom > 0 ? (tRead / denom * 100) : 0;
    const reuse = tCreate > 0 ? (tRead / tCreate) : 0;
    console.log([
      pad("TOTAL", bucketW),
      pad(String(tReq),  7,  "right"),
      pad(fmtTokens(tIn),  10, "right"),
      pad(fmtTokens(tOut), 10, "right"),
      pad(fmtTokens(tRead),   12, "right"),
      pad(fmtTokens(tCreate), 12, "right"),
      pad(hit.toFixed(1),    6,  "right"),
      pad(reuse.toFixed(1) + "x", 7, "right"),
      pad(fmtTokens(Math.round(tWeighted)), 12, "right"),
    ].join("  "));
  }
}

function pad(s: string, w: number, align: "left" | "right" = "left"): string {
  if (s.length >= w) return s;
  return align === "right" ? s.padStart(w) : s.padEnd(w);
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, Math.max(1, max - 1)) + "…";
}

function fmtTokens(n: number): string {
  // Human-readable: 1.2K, 3.4M, etc. Token counts get big fast; raw integers
  // are noisy at 7+ digits.
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (n / 1000).toFixed(1) + "K";
  return (n / 1_000_000).toFixed(2) + "M";
}

export type BackfillStats = {
  total: number;     // task logs found on disk
  scanned: number;   // processed (after --limit)
  withData: number;  // logs that yielded ≥1 usage row
  withErrors: number;
  totalRows: number;
  withAlias: number;
};

// The backfill core, separated from the CLI action so the command path is
// testable (#262): walk the runs dir, and for each historical task log select the
// usage parser from the manifest's runtime.logFormat — NOT a hardcoded claude
// parser, which would record zero rows for pi/codex logs. dry-run parses without
// writing; otherwise inserts via captureUsageForTask.
export function performBackfill(runsDir: string, opts: { dryRun?: boolean; limit?: number }): BackfillStats {
  const tasks = collectTaskLogs(runsDir);
  const ordered = tasks.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const slice = opts.limit ? ordered.slice(0, opts.limit) : ordered;
  // task_id → agent_alias so backfilled rows carry the alias they ran under.
  const aliasIdx = buildAliasIndex();
  const s: BackfillStats = { total: tasks.length, scanned: 0, withData: 0, withErrors: 0, totalRows: 0, withAlias: 0 };
  for (const t of slice) {
    s.scanned += 1;
    const alias = aliasIdx.get(t.taskId);
    if (alias) s.withAlias += 1;
    // #262: parser from the manifest's runtime log_format (pi/codex/claude), so
    // historical pi/codex logs don't silently backfill zero via the claude default.
    const logFormat = manifestLogFormat(t.logPath);
    const captureOpts = { taskId: t.taskId, ...(alias ? { alias } : {}), ...(logFormat ? { logFormat } : {}) };
    if (opts.dryRun) {
      try {
        const rows = extractUsageByLogFormat(t.logPath, captureOpts); // same selection as the write path
        if (rows.length > 0) { s.withData += 1; s.totalRows += rows.length; }
      } catch { s.withErrors += 1; }
      continue;
    }
    const result = captureUsageForTask(t.logPath, captureOpts);
    if (result.error) { s.withErrors += 1; continue; }
    if (result.rowCount > 0) { s.withData += 1; s.totalRows += result.rowCount; }
  }
  return s;
}

// Walk runs dir to find every task log on disk. Returns task_id + log path +
// mtime so the caller can order by recency and slice with --limit.
function collectTaskLogs(runsDir: string): Array<{ taskId: string; logPath: string; mtimeMs: number }> {
  const found: Array<{ taskId: string; logPath: string; mtimeMs: number }> = [];
  let runDirs: string[];
  try { runDirs = readdirSync(runsDir); }
  catch { return found; }
  for (const run of runDirs) {
    const runPath = join(runsDir, run);
    let taskDirs: string[];
    try { taskDirs = readdirSync(runPath); }
    catch { continue; }
    for (const task of taskDirs) {
      if (!task.startsWith("task-")) continue;
      const logPath = join(runPath, task, "container.stdout.log");
      if (!existsSync(logPath)) continue;
      try {
        const st = statSync(logPath);
        if (st.size === 0) continue;
        found.push({ taskId: task, logPath, mtimeMs: st.mtimeMs });
      } catch { /* skip unreadable */ }
    }
  }
  return found;
}
