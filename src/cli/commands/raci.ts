import type { Command } from "commander";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { RACI_PATH } from "../../util/paths.js";
import { validateRaci, type RaciValidation } from "../../raci/validate.js";

// `forge raci validate [path] [--json]` — authoring-view lint of a RACI source
// document (#277). Host-INDEPENDENT: no agent/workflow/command resolution, no
// policy drift, no project override merging (that is route validate, #278).
// Defaults to the installed host RACI (~/.forge/forge-raci.md). A missing file
// is a structured validation failure, not a crash.

/** Read + lint a RACI file. A missing/unreadable file becomes a finding rather
 *  than an exception (especially for the default host path). */
export function validateRaciFile(path: string): RaciValidation {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (e) {
    const missing = (e as NodeJS.ErrnoException).code === "ENOENT";
    return {
      ok: false,
      findings: [
        {
          code: missing ? "file_not_found" : "read_error",
          message: missing
            ? `RACI file not found: ${path}`
            : `cannot read ${path}: ${(e as Error).message}`,
        },
      ],
    };
  }
  return validateRaci(content);
}

export function renderHuman(path: string, v: RaciValidation): string {
  if (v.ok) return `RACI ${path}: OK — no findings.`;
  const lines = [`RACI ${path}: ${v.findings.length} finding(s):`, ""];
  for (const f of v.findings) {
    const where = f.route ? ` [route: ${f.route}]` : "";
    lines.push(`  [${f.code}]${where} ${f.message}`);
  }
  return lines.join("\n");
}

export function registerRaci(program: Command): void {
  const raci = program.command("raci").description("Work with the RACI routing source (authoring view).");

  raci
    .command("validate")
    .argument("[path]", "RACI file to validate (default: the installed ~/.forge/forge-raci.md)")
    .option("--json", "emit structured { ok, path, findings } as JSON")
    .description(
      "Lint a RACI source document. Host-independent: no agent/workflow/command resolution or drift checks (those are route validate, #278).",
    )
    .action((pathArg: string | undefined, opts: { json?: boolean }) => {
      const path = pathArg ? resolve(pathArg) : RACI_PATH;
      const v = validateRaciFile(path);

      if (opts.json) {
        console.log(JSON.stringify({ ok: v.ok, path, findings: v.findings }, null, 2));
      } else {
        console.log(renderHuman(path, v));
      }
      if (!v.ok) process.exit(1);
    });
}
