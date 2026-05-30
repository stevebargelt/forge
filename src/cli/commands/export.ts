import type { Command } from "commander";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { getDb } from "../../store/db.js";
import { ensureForgeDirs } from "../../util/paths.js";
import { exportRunJsonl, exportRunOtlp } from "../../v2/export.js";

// RUN-5: `forge export --run <id> --format jsonl|otel` — emit a run's events as
// JSONL or OTLP/JSON spans. Export path only; read-only.

export function registerExport(program: Command): void {
  program
    .command("export")
    .description("Export a run's events as JSONL or OpenTelemetry (OTLP/JSON) spans")
    .requiredOption("--run <id>", "run id to export")
    .option("--format <fmt>", "jsonl | otel (default: jsonl)", "jsonl")
    .option("--out <file>", "write to a file instead of stdout")
    .action((opts: { run: string; format: string; out?: string }) => {
      ensureForgeDirs();
      getDb({ readOnly: true });

      let body: string;
      if (opts.format === "jsonl") {
        body = exportRunJsonl(opts.run);
      } else if (opts.format === "otel" || opts.format === "otlp") {
        body = JSON.stringify(exportRunOtlp(opts.run), null, 2);
      } else {
        throw new Error(`--format must be jsonl | otel (got: ${opts.format})`);
      }

      if (opts.out) {
        const path = resolve(opts.out);
        writeFileSync(path, body.endsWith("\n") ? body : body + "\n");
        console.error(`forge export: wrote ${opts.format} for ${opts.run} → ${path}`);
      } else {
        console.log(body);
      }
    });
}
