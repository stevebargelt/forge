// FG-820: the RUNNABLE node entrypoint `forge attention list` shells into.
//
// WHY IT LIVES HERE. The inbox derivation is core (src/v2/attention-inbox.ts), but the
// store readers it is handed are bound to the dashboard's project-scope resolution
// (resolveProjectScope + the FG-693 identity-scoped verification read), which is
// dashboard-workspace-internal. The core CLI hands off here exactly as `forge kanban sync`
// does (dashboard/src/kanban/cli-entry.ts) rather than inverting the package layering, and
// calls attentionInboxFor — the SAME call GET /api/attention-inbox makes — so the printed
// envelope is the one the dashboard serves. Read-only: the dashboard handle opens the
// store read-only and this entry writes nothing.

import { pathToFileURL } from "node:url";
import { attentionInboxFor } from "../queries.js";

export function main(argv: readonly string[] = process.argv.slice(2)): number {
  const request: { projectDir?: string; runId?: string } = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (value === undefined || (flag !== "--project-dir" && flag !== "--run")) {
      process.stderr.write(`attention cli-entry: unexpected arguments ${JSON.stringify(argv.slice(i))}\n`);
      return 2;
    }
    if (flag === "--project-dir") request.projectDir = value;
    else request.runId = value;
  }
  let payload: string;
  try {
    payload = JSON.stringify(attentionInboxFor(request));
  } catch (err) {
    // The route's {error} body, verbatim: a total read failure is never an empty inbox.
    payload = JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
  }
  process.stdout.write(`${payload}\n`);
  return 0;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = main();
}
