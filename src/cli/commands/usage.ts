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
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { ensureForgeDirs } from "../../util/paths.js";
import { getDb } from "../../store/db.js";
import { captureUsageForTask, extractUsageFromStdoutLog } from "../../store/model-calls.js";

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
    .option("--project <dir>", "filter to one project's runs")
    .option("--json", "emit JSON instead of a table")
    .option("--limit <n>", "max rows (default: 50)", (v) => parseInt(v, 10), 50)
    .action((opts: { by: string; since: string; project?: string; json?: boolean; limit: number }) => {
      ensureForgeDirs();
      const by = parseGroupBy(opts.by);
      const sinceClause = parseSinceClause(opts.since);
      const rows = aggregate(by, sinceClause, opts.project, opts.limit);
      if (opts.json) {
        console.log(JSON.stringify({ groupBy: by, since: opts.since, project: opts.project ?? null, rows }, null, 2));
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
      const tasks = collectTaskLogs(runsDir);
      const ordered = tasks.sort((a, b) => b.mtimeMs - a.mtimeMs);
      const slice = opts.limit ? ordered.slice(0, opts.limit) : ordered;
      console.log(`Found ${slice.length}${opts.limit && tasks.length > opts.limit ? ` of ${tasks.length}` : ""} task log(s) to scan.`);
      // Build the task_id → agent_alias index once so backfilled rows carry
      // the alias they ran under (otherwise rollup `--by alias` shows "(no
      // alias)" for everything historical).
      const aliasIdx = buildAliasIndex();
      let totalRows = 0;
      let scanned = 0;
      let withData = 0;
      let withErrors = 0;
      let withAlias = 0;
      for (const t of slice) {
        scanned += 1;
        const alias = aliasIdx.get(t.taskId);
        if (alias) withAlias += 1;
        const captureOpts = { taskId: t.taskId, ...(alias ? { alias } : {}) };
        if (opts.dryRun) {
          // Parse-only; no writes. captureUsageForTask wraps parse+insert and
          // doesn't expose a parse-only mode, so we use extractUsageFromStdoutLog
          // directly here.
          try {
            const rows = extractUsageFromStdoutLog(t.logPath, captureOpts);
            if (rows.length > 0) { withData += 1; totalRows += rows.length; }
          } catch { withErrors += 1; }
          continue;
        }
        const result = captureUsageForTask(t.logPath, captureOpts);
        if (result.error) { withErrors += 1; continue; }
        if (result.rowCount > 0) { withData += 1; totalRows += result.rowCount; }
      }
      const verb = opts.dryRun ? "would insert" : "inserted";
      console.log(`Scanned ${scanned} task(s); ${withData} had usable data; ${verb} ${totalRows} model_call row(s); ${withAlias} tagged with alias.`);
      if (withErrors > 0) console.log(`(${withErrors} task(s) had parse errors — likely incomplete logs)`);
    });
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

function aggregate(by: GroupBy, sinceClause: string, projectFilter: string | undefined, limit: number): Row[] {
  // Build the GROUP BY expression based on dimension.
  const groupExpr: Record<GroupBy, string> = {
    role:     "COALESCE(t.agent_role, '(unknown role)')",
    workflow: "COALESCE(r.workflow,   '(unknown workflow)')",
    project:  "COALESCE(r.project_dir,'(unknown project)')",
    model:    "COALESCE(mc.model,     '(unknown model)')",
    alias:    "COALESCE(mc.alias,     '(no alias)')",
  };
  const projectClause = projectFilter ? `AND r.project_dir = '${projectFilter.replace(/'/g, "''")}'` : "";
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
    WHERE 1 = 1
      ${sinceClause}
      ${projectClause}
    GROUP BY bucket
    ORDER BY (SUM(mc.input_tokens) + SUM(mc.cache_creation_tokens) + SUM(mc.cache_read_tokens) + SUM(mc.output_tokens)) DESC
    LIMIT ?
  `;
  const raw = getDb({ readOnly: true }).prepare(sql).all(limit) as Array<{
    bucket: string;
    in_tok: number;
    out_tok: number;
    read_tok: number;
    create_tok: number;
    req_count: number;
  }>;
  return raw.map((r) => ({
    bucket: r.bucket,
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
